import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema, type AgentConfig } from "../src/config.js";
import {
  AnytypeCloudCommandExecutor,
  CloudCommandStore,
  CloudWorkflowExtension,
  type CloudCommandClient,
  type CloudCommandExecutionPort,
} from "../src/cloud-workflow.js";
import {
  cloudConfigSchema,
  initializeCloudConfig,
  resolveCloudPaths,
} from "../src/cloud-config.js";
import { CloudClient, CloudRequestError } from "../src/cloud-client.js";
import {
  commandEnvelopeSchema,
  commandResultSchema,
  type CloudCommandEnvelope,
  type CloudCommandResult,
} from "../src/cloud-contract.js";
import { Store } from "../src/store.js";
import { FakeAnytype } from "./fakes.js";

const actorDigest = "a".repeat(64);
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "knot-cloud-submission-"));
  temporaryDirectories.push(path);
  return path;
}

function command(
  overrides: Partial<CloudCommandEnvelope> & {
    operation?: CloudCommandEnvelope["payload"]["operation"];
  } = {},
): CloudCommandEnvelope {
  const { operation, ...envelopeOverrides } = overrides;
  return commandEnvelopeSchema.parse({
    protocolVersion: "1.0",
    commandId: "03b1731d-10a3-48ab-b8e4-5b164e536d20",
    connectorId: "68bc8f83-fd2e-4f0e-a5de-ad539bcaf0d0",
    requiredScope: "anytype.chats.send",
    createdBy: "human-session",
    actor: {
      principalDigest: actorDigest,
      digestVersion: 1,
      provenance: "authenticated-cloud-session",
    },
    createdAt: 900,
    notBefore: 900,
    expiresAt: 2_000,
    attempt: 1,
    leaseToken: "lease_token_1234567890abcdefghijklmnop",
    leaseExpiresAt: 1_100,
    payload: {
      domain: "anytype",
      operation: operation ?? {
        type: "chat.send",
        spaceId: "space-1",
        chatId: "chat-1",
        message: "hello",
        channelOrigin: {
          spaceId: "space-1",
          chatId: "chat-1",
          messageId: "origin-message-1",
        },
      },
    },
    ...envelopeOverrides,
  });
}

function settings(
  overrides: Partial<AgentConfig["cloudCommands"]> = {},
): AgentConfig["cloudCommands"] {
  return configSchema.parse({
    version: 1,
    agent: { name: "Knot", participantId: "agent-1" },
    anytype: { apiKeyFile: "/tmp/key" },
    spaces: [{ id: "space-1" }],
    runtime: { kind: "codex" },
    automation: {
      enabled: true,
      observation: true,
      execution: true,
      allowedAuthorIds: ["operator"],
      allowedSpaceIds: ["space-1"],
    },
    cloudCommands: {
      enabled: true,
      approval: "none",
      allowedCreatorKinds: ["human-session"],
      allowedSpaceIds: ["space-1"],
      allowedOriginParticipantIds: ["operator"],
      allowedActorDigests: [actorDigest],
      allowedScopes: ["anytype.chats.send"],
      ...overrides,
    },
  }).cloudCommands;
}

function clientFor(commands: CloudCommandEnvelope[]) {
  const submitResult = vi.fn(
    async (_command: CloudCommandEnvelope, _result: CloudCommandResult) => ({
      protocolVersion: "1.0" as const,
      commandId: commands[0]?.commandId ?? "03b1731d-10a3-48ab-b8e4-5b164e536d20",
      attempt: 1,
      status: "accepted" as const,
      state: "succeeded" as const,
    }),
  );
  const extendLease = vi.fn(async (item: CloudCommandEnvelope) => ({
    protocolVersion: "1.0" as const,
    commandId: item.commandId,
    attempt: item.attempt,
    leaseExpiresAt: 1_200,
  }));
  const claimCommands = vi.fn(async () => ({
    protocolVersion: "1.0" as const,
    commands: commands.splice(0, 1),
    pollAfterSeconds: 5,
  }));
  const controlPublication = vi.fn(async () => {
    throw new Error("not used");
  });
  const serverAdjustedNow = vi.fn(() => 1_000_000);
  return {
    client: {
      serverAdjustedNow,
      claimCommands,
      extendLease,
      submitResult,
      controlPublication,
    } as CloudCommandClient,
    claimCommands,
    extendLease,
    submitResult,
  };
}

const succeeded: CloudCommandResult = commandResultSchema.parse({
  outcome: "succeeded",
  result: {
    type: "chat.send",
    spaceId: "space-1",
    chatId: "chat-1",
    messageId: "message-1",
    sentAt: 1_000,
  },
});

async function workflowClientConfig(baseUrl = "https://knot.example") {
  const config = await initializeCloudConfig({
    paths: resolveCloudPaths({ home: temporaryDirectory() }),
    baseUrl,
    connectorName: "Test",
    requestedScopes: ["anytype.chats.send"],
  });
  return {
    ...config,
    paired: {
      connectorId: command().connectorId,
      tenantId: "00000000-0000-4000-8000-000000000012",
      scopes: ["anytype.chats.send" as const],
      siteIds: [],
      slugGrants: [],
      approvedAt: 1,
    },
  };
}

describe("cloud workflow bridge", () => {
  it("renews a live 15-second lease through 30-second result backoff against Cloud HTTP fencing", async () => {
    let now = 1_000_000;
    const item = command({ leaseExpiresAt: 1_015 });
    let leaseExpiresAt = item.leaseExpiresAt;
    let claimed = false;
    let completed = false;
    let results = 0;
    let renewals = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        commandId: string;
        attempt: number;
        leaseToken: string;
        extendBySeconds: number;
      };
      const reply = (value: unknown, status = 200) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.url?.endsWith("/claim")) {
        reply({ protocolVersion: "1.0", commands: claimed ? [] : [item], pollAfterSeconds: 5 });
        claimed = true;
        return;
      }
      const liveFence =
        !completed &&
        body.commandId === item.commandId &&
        body.attempt === item.attempt &&
        body.leaseToken === item.leaseToken &&
        leaseExpiresAt > now / 1_000 &&
        item.expiresAt > now / 1_000;
      if (!liveFence) {
        reply(
          {
            type: "https://knot.example/problems/lease-lost",
            title: "Lease lost",
            status: 409,
            code: "lease-lost",
            requestId: "test-lease-lost",
            retryable: false,
          },
          409,
        );
        return;
      }
      if (request.url?.endsWith("/extend")) {
        renewals += 1;
        leaseExpiresAt = Math.max(
          leaseExpiresAt,
          Math.min(item.expiresAt, now / 1_000 + body.extendBySeconds),
        );
        reply({
          protocolVersion: "1.0",
          commandId: item.commandId,
          attempt: item.attempt,
          leaseExpiresAt,
        });
        return;
      }
      results += 1;
      if (results === 1) {
        reply(
          {
            type: "https://knot.example/problems/result-conflict",
            title: "Result conflict",
            status: 409,
            code: "result-conflict",
            requestId: "test-result-conflict",
            retryable: false,
          },
          409,
        );
        return;
      }
      completed = true;
      reply({
        protocolVersion: "1.0",
        commandId: item.commandId,
        attempt: item.attempt,
        status: "accepted",
        state: "succeeded",
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const store = new Store(":memory:");
    let extension: CloudWorkflowExtension | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server address");
      const client = new CloudClient(
        await workflowClientConfig(`http://127.0.0.1:${address.port}`),
        { now: () => now, maximumAttempts: 1 },
      );
      const execute = vi.fn(async () => succeeded);
      extension = new CloudWorkflowExtension(
        store,
        client,
        { execute },
        settings({ leaseSeconds: 15 }),
        new FakeAnytype(),
        () => undefined,
        () => now,
      );
      const inbox = new CloudCommandStore(store);
      await extension.beforeTick();
      expect(execute).toHaveBeenCalledOnce();
      await extension.beforeTick();
      expect(inbox.command(item.commandId)).toMatchObject({
        state: "terminal_pending",
        submissionAttempts: 1,
      });
      expect(inbox.submissionDiagnostics(now).nextAttemptAt).toBe(1_030_000);
      const effectReceipt = store.db.prepare("SELECT * FROM cloud_effect_receipts").get();
      for (const seconds of [5, 10, 20, 30]) {
        now = 1_000_000 + seconds * 1_000;
        await extension.beforeTick();
      }
      expect(renewals).toBe(3);
      expect(results).toBe(2);
      expect(completed).toBe(true);
      expect(inbox.command(item.commandId)).toMatchObject({
        state: "succeeded",
        completedAt: now,
        result: succeeded,
      });
      expect(store.db.prepare("SELECT * FROM cloud_effect_receipts").get()).toEqual(effectReceipt);
      await extension.beforeTick();
      expect(results).toBe(2);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      await extension?.stop();
      store.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("retains rejected-fence renewal suppression across reopen until a fresh claim", async () => {
    const path = join(temporaryDirectory(), "state.sqlite");
    let store = new Store(path);
    let inbox = new CloudCommandStore(store);
    let now = 1_000_000;
    const item = command({ leaseExpiresAt: 1_015 });
    inbox.persistClaim(item, now);
    inbox.prepare(item.commandId, false, now);
    const { fencingToken } = inbox.startEffect(item.commandId, now);
    inbox.completeEffect(item.commandId, fencingToken, succeeded, now);
    const receipt = store.db.prepare("SELECT * FROM cloud_effect_receipts").get();
    const envelope = inbox.envelope(item.commandId);
    const { client, extendLease, submitResult } = clientFor([]);
    extendLease.mockRejectedValue(
      new CloudRequestError("Lost fence", { status: 409, retryable: false }),
    );
    submitResult.mockRejectedValue(
      new CloudRequestError("Temporary outage", { status: 503, retryable: true }),
    );
    const execute = vi.fn(async () => succeeded);
    const createExtension = () =>
      new CloudWorkflowExtension(
        store,
        client,
        { execute },
        settings(),
        new FakeAnytype(),
        () => undefined,
        () => now,
      );
    let extension = createExtension();
    await extension.beforeTick();
    expect(extendLease).toHaveBeenCalledOnce();
    expect(inbox.command(item.commandId)).toMatchObject({
      leaseExpiresAt: now,
      submissionAttempts: 0,
    });
    expect(inbox.envelope(item.commandId)).toEqual(envelope);
    await extension.stop();
    store.close();
    store = new Store(path);
    inbox = new CloudCommandStore(store);
    now += 5_000;
    extension = createExtension();
    await extension.beforeTick();
    expect(extendLease).toHaveBeenCalledOnce();
    const fresh = command({
      attempt: 2,
      leaseToken: "fresh_lease_token_1234567890abcdefghijk",
      leaseExpiresAt: 1_025,
    });
    inbox.persistClaim(fresh, now);
    // A late rejection for the former fence must not invalidate the replacement.
    inbox.invalidateLease(item, now);
    expect(inbox.command(item.commandId)?.leaseExpiresAt).toBe(1_025_000);
    extendLease.mockImplementation(async (current) => ({
      protocolVersion: "1.0",
      commandId: current.commandId,
      attempt: current.attempt,
      leaseExpiresAt: 1_100,
    }));
    now += 5_000;
    await extension.beforeTick();
    expect(extendLease).toHaveBeenCalledTimes(2);
    expect(inbox.command(item.commandId)).toMatchObject({
      leaseExpiresAt: 1_100_000,
      state: "terminal_pending",
      result: succeeded,
      submissionAttempts: 0,
    });
    expect(inbox.command(item.commandId)?.completedAt).toBeUndefined();
    expect(store.db.prepare("SELECT * FROM cloud_effect_receipts").get()).toEqual(receipt);
    expect(execute).not.toHaveBeenCalled();
    await extension.stop();
    store.close();
  });

  it.each([
    { failure: "invalid-json", status: 200 },
    { failure: "invalid-schema", status: 200 },
    ...[200, 400, 409].map((status) => ({ failure: "response-too-large", status })),
  ])(
    "quarantines persistent $status/$failure submissions from the real CloudClient",
    async ({ failure, status }) => {
      let now = 1_000_000;
      const store = new Store(":memory:");
      const inbox = new CloudCommandStore(store);
      const item = command();
      inbox.persistClaim(item, now);
      inbox.prepare(item.commandId, false, now);
      inbox.startEffect(item.commandId, now);
      inbox.recoverInterruptedEffects(now);
      const retained = inbox.command(item.commandId)!.result;
      const receipt = store.db.prepare("SELECT * FROM cloud_effect_receipts").get();
      let resultRequests = 0;
      const readOversizedBody = vi.fn();
      const cancelOversizedBody = vi.fn();
      const client = new CloudClient(await workflowClientConfig(), {
        now: () => now,
        maximumAttempts: 1,
        fetch: async (url) => {
          if (String(url).endsWith("/result")) {
            resultRequests += 1;
            if (failure === "invalid-json") return new Response("{");
            if (failure === "response-too-large")
              return new Response(
                new ReadableStream<Uint8Array>(
                  { pull: readOversizedBody, cancel: cancelOversizedBody },
                  { highWaterMark: 0 },
                ),
                { status, headers: { "Content-Length": "99999999" } },
              );
            return Response.json({ protocolVersion: "1.0", invalidReceipt: true });
          }
          return Response.json({ protocolVersion: "1.0", commands: [], pollAfterSeconds: 5 });
        },
      });
      const extension = new CloudWorkflowExtension(
        store,
        client,
        { execute: vi.fn(async () => succeeded) },
        settings(),
        new FakeAnytype(),
        () => undefined,
        () => now,
      );
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await extension.beforeTick();
        expect(inbox.command(item.commandId)?.submissionAttempts).toBe(attempt);
        now += 30_000 * 2 ** (attempt - 1);
      }
      expect(inbox.command(item.commandId)?.submissionQuarantinedAt).toBeDefined();
      expect(inbox.command(item.commandId)?.submissionLastErrorCode).toBe(
        status >= 400 ? `submission-http-${status}` : "submission-fence-or-response-invalid",
      );
      now += 3_600_000;
      await extension.beforeTick();
      expect(resultRequests).toBe(5);
      expect(inbox.command(item.commandId)?.result).toEqual(retained);
      expect(inbox.command(item.commandId)?.completedAt).toBeUndefined();
      expect(store.db.prepare("SELECT * FROM cloud_effect_receipts").get()).toEqual(receipt);
      if (failure === "response-too-large") {
        expect(readOversizedBody).not.toHaveBeenCalled();
        expect(cancelOversizedBody).toHaveBeenCalledTimes(5);
      }
      await extension.stop();
      store.close();
    },
  );

  it.each([
    ...[401, 403, 503].flatMap((status) =>
      ["malformed", "oversized"].map((body) => ({ status, body })),
    ),
    { status: 0, body: "network" },
    { status: 0, body: "unknown" },
    { status: 0, body: "untyped-protocol" },
  ])(
    "defers the batch without spending result budget on $status/$body",
    async ({ status, body }) => {
      const now = 1_000_000;
      const store = new Store(":memory:");
      const inbox = new CloudCommandStore(store);
      for (let index = 1; index <= 25; index += 1) {
        const item = command({
          commandId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        });
        inbox.persistClaim(item, now);
        inbox.reject(item.commandId, "test-denial", now);
      }
      const fetchMock = vi.fn(async () => {
        if (body === "network") throw new TypeError("fetch failed");
        if (body === "unknown") throw new Error("unknown response failure");
        if (body === "untyped-protocol")
          throw new CloudRequestError("invalid JSON", { retryable: false });
        return new Response("{", {
          status,
          ...(body === "oversized" ? { headers: { "Content-Length": "99999999" } } : {}),
        });
      });
      const client = new CloudClient(await workflowClientConfig(), {
        fetch: fetchMock,
        now: () => now,
        maximumAttempts: 1,
      });
      const extension = new CloudWorkflowExtension(
        store,
        client,
        { execute: vi.fn(async () => succeeded) },
        settings(),
        new FakeAnytype(),
        () => undefined,
        () => now,
      );
      await extension.beforeTick();
      await extension.beforeTick();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(
        store.db
          .prepare("SELECT SUM(submission_attempts) AS failures FROM cloud_command_inbox")
          .get(),
      ).toEqual({ failures: 0 });
      expect(inbox.submissionDiagnostics(now)).toMatchObject({ pending: 25, quarantined: 0 });
      await extension.stop();
      store.close();
    },
  );

  it.each(["rejected", "wrong-fence"])(
    "backs off and quarantines %s results across reopen without losing effect barriers",
    async (failure) => {
      const path = join(temporaryDirectory(), "state.sqlite");
      let store = new Store(path);
      let inbox = new CloudCommandStore(store);
      const item = command();
      let now = 1_000_000;
      inbox.persistClaim(item, now);
      inbox.prepare(item.commandId, false, now);
      inbox.startEffect(item.commandId, now);
      inbox.recoverInterruptedEffects(now);
      const result = inbox.command(item.commandId)!.result!;
      const receipt = store.db.prepare("SELECT * FROM cloud_effect_receipts").get();
      const retained = () =>
        store.db
          .prepare(
            `SELECT envelope_json,attempt,lease_token_digest,
      local_attempts,effect_key,result_json,last_error_code,last_error,completed_at FROM cloud_command_inbox`,
          )
          .get();
      const original = retained();
      const { client } = clientFor([]);
      let requests = 0;
      client.submitResult = async (submitted) => {
        requests += 1;
        if (failure === "rejected")
          throw new CloudRequestError("Stale fence", { status: 409, retryable: false });
        return {
          protocolVersion: "1.0",
          commandId: submitted.commandId,
          attempt: submitted.attempt + 1,
          status: "accepted",
          state: "failed",
        };
      };
      const execute = vi.fn(async () => succeeded);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const extension = new CloudWorkflowExtension(
          store,
          client,
          { execute },
          settings(),
          new FakeAnytype(),
          () => undefined,
          () => now,
        );
        await extension.beforeTick();
        expect(requests).toBe(attempt);
        expect(inbox.command(item.commandId)?.submissionAttempts).toBe(attempt);
        const afterFailure = now;
        for (let tick = 0; tick < 10; tick += 1) {
          now += 1_000;
          await extension.beforeTick();
        }
        expect(requests).toBe(attempt);
        expect(retained()).toEqual(original);
        expect(store.db.prepare("SELECT * FROM cloud_effect_receipts").get()).toEqual(receipt);
        await extension.stop();
        store.close();
        store = new Store(path);
        inbox = new CloudCommandStore(store);
        const reopened = new CloudWorkflowExtension(
          store,
          client,
          { execute },
          settings(),
          new FakeAnytype(),
          () => undefined,
          () => now,
        );
        await reopened.beforeTick();
        expect(requests).toBe(attempt);
        await reopened.stop();
        if (attempt < 5) {
          expect(inbox.submissionDiagnostics(now)).toMatchObject({
            pending: 1,
            backingOff: 1,
            quarantined: 0,
          });
          now = afterFailure + 30_000 * 2 ** (attempt - 1);
        }
      }
      expect(inbox.submissionDiagnostics(now)).toMatchObject({
        pending: 1,
        backingOff: 0,
        quarantined: 1,
      });
      expect(inbox.command(item.commandId)?.completedAt).toBeUndefined();
      expect(inbox.command(item.commandId)?.result).toEqual(result);
      now += 24 * 60 * 60_000;
      const extension = new CloudWorkflowExtension(
        store,
        client,
        { execute },
        settings(),
        new FakeAnytype(),
        () => undefined,
        () => now,
      );
      await extension.beforeTick();
      expect(requests).toBe(5);
      expect(() => inbox.retry(item.commandId, now)).toThrow("cannot be retried safely");
      expect(() => inbox.retrySubmission(item.commandId, { operatorApproved: false }, now)).toThrow(
        "explicit operator approval",
      );
      expect(retained()).toEqual(original);
      expect(inbox.command(item.commandId)?.submissionQuarantinedAt).toBeDefined();
      expect(inbox.retrySubmission(item.commandId, { operatorApproved: true }, now)).toBe(true);
      expect(retained()).toEqual(original);
      expect(store.db.prepare("SELECT * FROM cloud_effect_receipts").get()).toEqual(receipt);
      client.submitResult = async (submitted) => {
        requests += 1;
        return {
          protocolVersion: "1.0",
          commandId: submitted.commandId,
          attempt: submitted.attempt,
          status: "accepted",
          state: "failed",
        };
      };
      await extension.beforeTick();
      expect(requests).toBe(6);
      expect(inbox.command(item.commandId)?.completedAt).toBe(now);
      expect(inbox.command(item.commandId)?.result).toEqual(result);
      expect(execute).not.toHaveBeenCalled();
      expect(inbox.retrySubmission(item.commandId, { operatorApproved: true }, now)).toBe(false);
      now += 60_000;
      await extension.beforeTick();
      expect(requests).toBe(6);
      await extension.stop();
      store.close();
    },
  );

  it("keeps healthy results visible behind more than twenty quarantined rows and accepts a late matching receipt", async () => {
    const store = new Store(":memory:");
    const inbox = new CloudCommandStore(store);
    const now = 1_000_000;
    const items = Array.from({ length: 22 }, (_, index) =>
      command({
        commandId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      }),
    );
    for (const item of items) {
      inbox.persistClaim(item, now);
      inbox.reject(item.commandId, "test-denial", now);
    }
    for (const item of items.slice(0, 21))
      for (let attempt = 0; attempt < 5; attempt += 1)
        inbox.failSubmission(
          item,
          inbox.command(item.commandId)!.result!,
          "submission-http-409",
          now,
        );
    expect(inbox.terminalPending("", now).map((item) => item.commandId)).toEqual([
      items[21]!.commandId,
    ]);
    expect(inbox.leaseCandidates("", now).map((item) => item.commandId)).toEqual([
      items[21]!.commandId,
    ]);
    expect(inbox.submissionDiagnostics(now)).toMatchObject({ pending: 22, quarantined: 21 });
    const first = items[0]!;
    const result = inbox.command(first.commandId)!.result!;
    expect(inbox.markSubmitted(first.commandId, result, now, { ...first, attempt: 2 })).toBe(false);
    expect(inbox.command(first.commandId)?.submissionQuarantinedAt).toBe(now);
    expect(inbox.markSubmitted(first.commandId, result, now, first)).toBe(true);
    expect(inbox.command(first.commandId)?.submissionQuarantinedAt).toBeUndefined();
    expect(inbox.command(first.commandId)?.completedAt).toBe(now);
    expect(inbox.submissionDiagnostics(now)).toMatchObject({ pending: 21, quarantined: 20 });
    const queued = command();
    inbox.persistClaim(queued, now);
    inbox.prepare(queued.commandId, false, now);
    expect(inbox.retrySubmission(queued.commandId, { operatorApproved: true }, now)).toBe(false);
    expect(inbox.command(queued.commandId)?.state).toBe("queued");
    store.close();
  });

  it("upgrades schema18 with a restorable backup and unchanged results, receipts and active capabilities", () => {
    const path = join(temporaryDirectory(), "state.sqlite");
    const previous = new Store(path);
    const inbox = new CloudCommandStore(previous);
    const item = command();
    inbox.persistClaim(item, 1_000_000);
    inbox.prepare(item.commandId, false, 1_000_000);
    inbox.startEffect(item.commandId, 1_000_000);
    inbox.recoverInterruptedEffects(1_000_000);
    const result = inbox.command(item.commandId)!.result;
    const receipt = previous.db.prepare("SELECT * FROM cloud_effect_receipts").get();
    const token = previous.issueManagementCapability("chat:space:chat", "owner", "publish");
    previous.db.exec(`DROP INDEX cloud_command_submissions_due;
      ALTER TABLE cloud_command_inbox DROP COLUMN submission_attempts;
      ALTER TABLE cloud_command_inbox DROP COLUMN submission_last_error_code;
      ALTER TABLE cloud_command_inbox DROP COLUMN submission_last_error;
      ALTER TABLE cloud_command_inbox DROP COLUMN submission_quarantined_at;
      PRAGMA user_version=18;`);
    previous.close();
    const upgraded = new Store(path, () => undefined);
    expect(upgraded.schemaVersion()).toBe(19);
    expect(upgraded.consumeManagementCapability(token, "chat:space:chat", "publish")).toBe("owner");
    expect(new CloudCommandStore(upgraded).command(item.commandId)).toMatchObject({
      result,
      submissionAttempts: 0,
      state: "dead_letter",
    });
    expect(upgraded.db.prepare("SELECT * FROM cloud_effect_receipts").get()).toEqual(receipt);
    const backup = new DatabaseSync(upgraded.migrationBackupPath!);
    expect(backup.prepare("PRAGMA user_version").get()).toEqual({ user_version: 18 });
    expect(backup.prepare("SELECT result_json FROM cloud_command_inbox").get()).toEqual({
      result_json: JSON.stringify(result),
    });
    expect(backup.prepare("SELECT * FROM cloud_effect_receipts").get()).toEqual(receipt);
    backup.close();
    expect(() => upgraded.db.prepare("DELETE FROM cloud_command_inbox").run()).toThrow(
      "cloud command inbox is durable",
    );
    upgraded.close();
  });

  it.each([401, 403, "clock-skew"] as const)(
    "defers the whole batch on global %s errors from the real CloudClient",
    async (failure) => {
      let now = 1_000_000;
      const store = new Store(":memory:");
      const inbox = new CloudCommandStore(store);
      for (let index = 0; index < 120; index += 1) {
        const item = command({
          commandId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          leaseExpiresAt: 1_015,
        });
        inbox.persistClaim(item, now);
        if (index < 100) inbox.prepare(item.commandId, true, now);
        else inbox.reject(item.commandId, "test-denial", now);
      }
      const config = await initializeCloudConfig({
        paths: resolveCloudPaths({ home: temporaryDirectory() }),
        baseUrl: "https://knot.example",
        connectorName: "Test",
        requestedScopes: ["anytype.chats.send"],
      });
      const status = failure === "clock-skew" ? 401 : failure;
      const fetchMock = vi.fn(async () =>
        Response.json(
          {
            type: "https://knot.example/problems/auth",
            title: "Authentication failed",
            status,
            code: failure === "clock-skew" ? "clock-skew" : "connector-denied",
            requestId: "test-request-id",
            retryable: false,
            ...(failure === "clock-skew" ? { serverUnixSeconds: 1_000 } : {}),
          },
          { status },
        ),
      );
      const client = new CloudClient(
        {
          ...config,
          paired: {
            connectorId: command().connectorId,
            tenantId: "00000000-0000-4000-8000-000000000012",
            scopes: ["anytype.chats.send"],
            siteIds: [],
            slugGrants: [],
            approvedAt: 1,
          },
        },
        { fetch: fetchMock, now: () => now, maximumAttempts: 2 },
      );
      const log = vi.fn();
      const extension = new CloudWorkflowExtension(
        store,
        client,
        { execute: vi.fn(async () => succeeded) },
        settings({ approval: "all" }),
        new FakeAnytype(),
        log,
        () => now,
      );
      await extension.beforeTick();
      await extension.beforeTick();
      expect(fetchMock).toHaveBeenCalledTimes(failure === "clock-skew" ? 2 : 1);
      expect(
        log.mock.calls.filter(([event]) => event === "cloud_command_network_deferred"),
      ).toHaveLength(1);
      expect(
        store.db
          .prepare("SELECT SUM(submission_attempts) AS failures FROM cloud_command_inbox")
          .get(),
      ).toEqual({ failures: 0 });
      expect(inbox.submissionDiagnostics(now)).toMatchObject({ pending: 20, quarantined: 0 });
      expect(inbox.command("00000000-0000-4000-8000-000000000001")?.leaseExpiresAt).toBe(1_015_000);
      now += 60_000;
      await extension.beforeTick();
      expect(fetchMock).toHaveBeenCalledTimes(failure === "clock-skew" ? 4 : 2);
      expect(
        store.db
          .prepare("SELECT SUM(submission_attempts) AS failures FROM cloud_command_inbox")
          .get(),
      ).toEqual({ failures: 0 });
      await extension.stop();
      store.close();
    },
  );

  it("is feature-gated and requires the durable runner", () => {
    const parsed = configSchema.parse({
      version: 1,
      agent: { name: "Knot", participantId: "agent-1" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ id: "space-1" }],
      runtime: { kind: "codex" },
    });
    expect(parsed.cloudCommands.enabled).toBe(false);
    expect(() =>
      configSchema.parse({
        ...parsed,
        cloudCommands: {
          enabled: true,
          allowedScopes: ["anytype.chats.send"],
          allowedActorDigests: [actorDigest],
        },
      }),
    ).toThrow("durable automation runner");
  });

  it("requires a native Anytype origin allowlist before chat.send can be enabled", () => {
    expect(() => settings({ allowedOriginParticipantIds: [] })).toThrow(
      "allowedOriginParticipantIds",
    );
    expect(() => settings({ allowedOriginParticipantIds: ["*"] })).toThrow("wildcard");
  });

  it("persists before execution, deduplicates replay, and fences terminal completion", async () => {
    const store = new Store(":memory:");
    const { client, submitResult } = clientFor([command()]);
    const execute = vi.fn(async () => succeeded);
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute } as CloudCommandExecutionPort,
      settings(),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_000,
    );
    await extension.beforeTick();
    const inbox = new CloudCommandStore(store);
    expect(inbox.command(command().commandId)).toMatchObject({ state: "terminal_pending" });
    expect(execute).toHaveBeenCalledOnce();
    await extension.beforeTick();
    expect(submitResult).toHaveBeenCalledOnce();
    expect(inbox.command(command().commandId)).toMatchObject({ state: "succeeded" });
    await extension.beforeTick();
    expect(execute).toHaveBeenCalledOnce();
    store.close();
  });

  it("quarantines an interrupted effect, reports failure, and never repeats it", async () => {
    const store = new Store(":memory:");
    const inbox = new CloudCommandStore(store);
    const item = command();
    inbox.persistClaim(item, 1_000_000);
    inbox.prepare(item.commandId, false, 1_000_000);
    inbox.startEffect(item.commandId, 1_000_000);
    expect(inbox.recoverInterruptedEffects(1_000_001)).toBe(1);
    expect(inbox.command(item.commandId)).toMatchObject({
      state: "dead_letter",
      lastErrorCode: "effect-outcome-unknown",
    });
    expect(() => inbox.retry(item.commandId)).toThrow("cannot be retried safely");
    const { client, submitResult } = clientFor([]);
    const execute = vi.fn(async () => succeeded);
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute },
      settings(),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_002,
    );
    await extension.beforeTick();
    expect(submitResult).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(inbox.command(item.commandId)).toMatchObject({
      state: "dead_letter",
      completedAt: 1_000_002,
    });
    store.close();
  });

  it("rejects a stale local effect fence", () => {
    const store = new Store(":memory:");
    const inbox = new CloudCommandStore(store);
    const item = command();
    inbox.persistClaim(item, 1_000_000);
    inbox.prepare(item.commandId, false, 1_000_000);
    const claim = inbox.startEffect(item.commandId, 1_000_000);
    expect(inbox.completeEffect(item.commandId, "stale-fence", succeeded, 1_000_001)).toBe(false);
    expect(inbox.command(item.commandId)?.state).toBe("running");
    expect(inbox.completeEffect(item.commandId, claim.fencingToken, succeeded, 1_000_002)).toBe(
      true,
    );
    expect(inbox.command(item.commandId)?.state).toBe("terminal_pending");
    store.close();
  });

  it("rejects an immutable command ID replay with different content", () => {
    const store = new Store(":memory:");
    const inbox = new CloudCommandStore(store);
    inbox.persistClaim(command(), 1_000_000);
    expect(() =>
      inbox.persistClaim(
        command({
          operation: {
            type: "chat.send",
            spaceId: "space-1",
            chatId: "chat-1",
            message: "different",
            channelOrigin: {
              spaceId: "space-1",
              chatId: "chat-1",
              messageId: "origin-message-1",
            },
          },
        }),
      ),
    ).toThrow("different immutable content");
    store.close();
  });

  it("accepts a new fenced cloud lease for the same immutable command", () => {
    const store = new Store(":memory:");
    const inbox = new CloudCommandStore(store);
    const original = command();
    inbox.persistClaim(original, 1_000_000);
    const renewed = command({
      attempt: 2,
      leaseToken: "renewed_lease_token_1234567890abcdef",
      leaseExpiresAt: 1_200,
    });
    expect(() => inbox.persistClaim(renewed, 1_010_000)).not.toThrow();
    expect(inbox.command(original.commandId)).toMatchObject({
      attempt: 2,
      leaseExpiresAt: 1_200_000,
    });
    expect(inbox.envelope(original.commandId)).toMatchObject({
      attempt: 2,
      leaseToken: "renewed_lease_token_1234567890abcdef",
      leaseExpiresAt: 1_200,
    });
    store.close();
  });

  it("denies revoked local scope and reports the rejection without executing", async () => {
    const store = new Store(":memory:");
    const { client, submitResult } = clientFor([command()]);
    const execute = vi.fn(async () => succeeded);
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute },
      settings({ allowedScopes: ["anytype.objects.read"] }),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_000,
    );
    await extension.beforeTick();
    expect(execute).not.toHaveBeenCalled();
    await extension.beforeTick();
    expect(submitResult.mock.calls[0]?.[1]).toEqual({
      outcome: "rejected-by-local-policy",
      reasonCode: "scope-denied",
    });
    store.close();
  });

  it("revalidates local policy after persistence and before an effect", async () => {
    const store = new Store(":memory:");
    const inbox = new CloudCommandStore(store);
    const item = command();
    inbox.persistClaim(item, 1_000_000);
    inbox.prepare(item.commandId, false, 1_000_000);
    const execute = vi.fn(async () => succeeded);
    const { client } = clientFor([]);
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute },
      settings({ allowedScopes: ["anytype.objects.read"] }),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_001,
    );

    await extension.beforeTick();

    expect(execute).not.toHaveBeenCalled();
    expect(inbox.command(item.commandId)).toMatchObject({
      state: "terminal_pending",
      result: { outcome: "rejected-by-local-policy", reasonCode: "scope-denied" },
    });
    store.close();
  });

  it("does not start an effect under an expired cloud lease", async () => {
    const store = new Store(":memory:");
    const stale = command({ leaseExpiresAt: 999 });
    const fixture = clientFor([stale]);
    fixture.client.extendLease = vi.fn(async () => {
      throw new Error("stale lease");
    });
    const execute = vi.fn(async () => succeeded);
    const extension = new CloudWorkflowExtension(
      store,
      fixture.client,
      { execute },
      settings(),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_000,
    );

    await extension.beforeTick();
    await extension.beforeTick();

    expect(execute).not.toHaveBeenCalled();
    expect(new CloudCommandStore(store).command(stale.commandId)?.state).toBe("queued");
    store.close();
  });

  it("denies a mismatched authenticated cloud principal digest", async () => {
    const store = new Store(":memory:");
    const { client } = clientFor([command()]);
    const execute = vi.fn(async () => succeeded);
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute },
      settings({ allowedActorDigests: ["c".repeat(64)] }),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_000,
    );
    await extension.beforeTick();
    expect(execute).not.toHaveBeenCalled();
    expect(new CloudCommandStore(store).command(command().commandId)?.result).toMatchObject({
      outcome: "rejected-by-local-policy",
      reasonCode: "actor-principal-denied",
    });
    store.close();
  });

  it("keeps writes awaiting explicit approval and supports operator rejection", async () => {
    const store = new Store(":memory:");
    const item = command();
    const { client } = clientFor([item]);
    const execute = vi.fn(async () => succeeded);
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute },
      settings({ approval: "writes" }),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_000,
    );
    await extension.beforeTick();
    const inbox = new CloudCommandStore(store);
    expect(inbox.command(item.commandId)?.state).toBe("awaiting_approval");
    expect(inbox.reject(item.commandId, "operator-rejected")).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    store.close();
  });

  it("aborts a stalled lease pass within its budget and defers all further Cloud work", async () => {
    const store = new Store(":memory:");
    const item = command({ leaseExpiresAt: 1_001 });
    const inbox = new CloudCommandStore(store);
    inbox.persistClaim(item, 1_000_000);
    inbox.prepare(item.commandId, true, 1_000_000);
    const { client, claimCommands } = clientFor([]);
    let cancelled = false;
    client.extendLease = vi.fn<CloudCommandClient["extendLease"]>(
      async (_command, _seconds, signal) =>
        new Promise<Awaited<ReturnType<CloudCommandClient["extendLease"]>>>((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(signal!.reason);
            },
            { once: true },
          );
        }),
    );
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute: vi.fn(async () => succeeded) },
      settings({ approval: "all" }),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_000,
      { tickBudgetMilliseconds: 30 },
    );
    const started = Date.now();
    await extension.beforeTick();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(cancelled).toBe(true);
    expect(inbox.command(item.commandId)?.leaseExpiresAt).toBe(1_001_000);
    await extension.beforeTick();
    expect(client.extendLease).toHaveBeenCalledOnce();
    expect(claimCommands).not.toHaveBeenCalled();
    await extension.stop();
    store.close();
  });

  it("submits quarantined results without extending their terminal leases", async () => {
    const store = new Store(":memory:");
    const inbox = new CloudCommandStore(store);
    const item = command({ leaseExpiresAt: 999 });
    inbox.persistClaim(item, 1_000_000);
    inbox.prepare(item.commandId, false, 1_000_000);
    inbox.startEffect(item.commandId, 1_000_000);
    inbox.recoverInterruptedEffects(1_000_000);
    expect(inbox.command(item.commandId)).toMatchObject({ state: "dead_letter" });
    expect(inbox.command(item.commandId)?.completedAt).toBeUndefined();
    const { client, extendLease, submitResult, claimCommands } = clientFor([]);
    extendLease.mockRejectedValue(
      new CloudRequestError("Lease expired", {
        status: 409,
        code: "lease-expired",
        retryable: false,
      }),
    );
    let now = 1_000_000;
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute: vi.fn(async () => succeeded) },
      settings({ approval: "all" }),
      new FakeAnytype(),
      () => undefined,
      () => now,
    );
    for (let tick = 0; tick < 6; tick += 1) {
      await extension.beforeTick();
      now += 5_000;
    }
    expect(extendLease).not.toHaveBeenCalled();
    expect(submitResult).toHaveBeenCalledOnce();
    expect(claimCommands).toHaveBeenCalledTimes(6);
    expect(inbox.command(item.commandId)).toMatchObject({
      state: "dead_letter",
      completedAt: 1_000_000,
      lastErrorCode: "effect-outcome-unknown",
    });
    await extension.stop();
    store.close();
  });

  it.each(["rejected", "retryable-rejection", "wrong-fence"])(
    "keeps healthy leases, results and polling progressing after persistent %s lease responses",
    async (failure) => {
      const store = new Store(":memory:");
      const inbox = new CloudCommandStore(store);
      const poisoned = command({ leaseExpiresAt: 1_015 });
      const healthy = command({
        commandId: "13b1731d-10a3-48ab-b8e4-5b164e536d20",
        leaseExpiresAt: 1_015,
      });
      const terminal = command({ commandId: "23b1731d-10a3-48ab-b8e4-5b164e536d20" });
      const fresh = command({ commandId: "33b1731d-10a3-48ab-b8e4-5b164e536d20" });
      for (const item of [poisoned, healthy, terminal]) {
        inbox.persistClaim(item, 1_000_000);
        inbox.prepare(item.commandId, true, 1_000_000);
      }
      inbox.reject(terminal.commandId, "test-denial", 1_000_000);
      const { client, extendLease, claimCommands } = clientFor([fresh]);
      extendLease.mockImplementation(async (item) => {
        if (item.commandId === poisoned.commandId && failure !== "wrong-fence")
          throw new CloudRequestError("Lease expired", {
            status: 409,
            retryable: failure === "retryable-rejection",
          });
        return {
          protocolVersion: "1.0",
          commandId: item.commandId === poisoned.commandId ? fresh.commandId : item.commandId,
          attempt: item.attempt,
          leaseExpiresAt: 1_200,
        };
      });
      const submitted: string[] = [];
      client.submitResult = async (item) => {
        submitted.push(item.commandId);
        return {
          protocolVersion: "1.0",
          commandId: item.commandId,
          attempt: item.attempt,
          status: "accepted",
          state: "rejected-by-local-policy",
        };
      };
      let now = 1_000_000;
      const log = vi.fn();
      const extension = new CloudWorkflowExtension(
        store,
        client,
        { execute: vi.fn(async () => succeeded) },
        settings({ approval: "all" }),
        new FakeAnytype(),
        log,
        () => now,
      );
      for (let tick = 0; tick < 3; tick += 1) {
        await extension.beforeTick();
        now += 5_000;
      }
      expect(
        extendLease.mock.calls.filter(([item]) => item.commandId === poisoned.commandId),
      ).toHaveLength(1);
      expect(inbox.command(poisoned.commandId)?.leaseExpiresAt).toBe(1_000_000);
      expect(inbox.command(healthy.commandId)?.leaseExpiresAt).toBe(1_200_000);
      expect(submitted).toEqual([terminal.commandId]);
      expect(inbox.command(terminal.commandId)?.completedAt).toBe(1_000_000);
      expect(inbox.command(fresh.commandId)?.state).toBe("awaiting_approval");
      expect(claimCommands).toHaveBeenCalledTimes(3);
      expect(log.mock.calls.some(([event]) => event === "cloud_command_network_deferred")).toBe(
        false,
      );
      await extension.stop();
      store.close();
    },
  );

  it.each(["rejected", "retryable-rejection", "wrong-fence"])(
    "rotates past a full batch of persistently %s results without blocking new commands",
    async (failure) => {
      const store = new Store(":memory:");
      const inbox = new CloudCommandStore(store);
      const items = Array.from({ length: 21 }, (_, index) =>
        command({
          commandId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        }),
      );
      for (const item of items) {
        inbox.persistClaim(item, 1_000_000);
        inbox.reject(item.commandId, "test-denial", 1_000_000);
      }
      const healthy = items[20]!;
      const fresh = command();
      const { client, claimCommands } = clientFor([fresh]);
      const submitted: string[] = [];
      client.submitResult = async (item) => {
        submitted.push(item.commandId);
        if (item.commandId !== healthy.commandId && failure !== "wrong-fence")
          throw new CloudRequestError("Stale result fence", {
            status: 409,
            retryable: failure === "retryable-rejection",
          });
        return {
          protocolVersion: "1.0",
          commandId: item.commandId === healthy.commandId ? item.commandId : fresh.commandId,
          attempt: item.attempt,
          status: "accepted",
          state: "rejected-by-local-policy",
        };
      };
      let now = 1_000_000;
      const extension = new CloudWorkflowExtension(
        store,
        client,
        { execute: vi.fn(async () => succeeded) },
        settings({ approval: "all" }),
        new FakeAnytype(),
        () => undefined,
        () => now,
      );
      await extension.beforeTick();
      expect(submitted).toHaveLength(20);
      expect(inbox.command(healthy.commandId)?.completedAt).toBeUndefined();
      expect(inbox.command(fresh.commandId)?.state).toBe("awaiting_approval");
      now += 5_000;
      await extension.beforeTick();
      expect(inbox.command(healthy.commandId)?.completedAt).toBe(now);
      expect(claimCommands).toHaveBeenCalledTimes(2);
      expect(inbox.command(items[0]!.commandId)?.completedAt).toBeUndefined();
      expect(inbox.command(items[0]!.commandId)?.result).toBeDefined();
      await extension.stop();
      store.close();
    },
  );

  it("gives results and polling a turn after slow rejected leases exhaust the budget", async () => {
    const store = new Store(":memory:");
    const inbox = new CloudCommandStore(store);
    for (let index = 0; index < 101; index += 1) {
      const item = command({
        commandId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        leaseExpiresAt: 1_015,
      });
      inbox.persistClaim(item, 1_000_000);
      inbox.prepare(item.commandId, true, 1_000_000);
    }
    const terminal = command();
    inbox.persistClaim(terminal, 1_000_000);
    inbox.reject(terminal.commandId, "test-denial", 1_000_000);
    const fresh = command({
      commandId: "13b1731d-10a3-48ab-b8e4-5b164e536d20",
      leaseExpiresAt: 1_200,
    });
    const { client, claimCommands } = clientFor([fresh]);
    client.extendLease = async (_item, _seconds, signal) => {
      await delay(10, undefined, { signal });
      throw new CloudRequestError("Expired lease", { status: 409, retryable: false });
    };
    client.submitResult = async (item) => ({
      protocolVersion: "1.0",
      commandId: item.commandId,
      attempt: item.attempt,
      status: "accepted",
      state: "rejected-by-local-policy",
    });
    const execute = vi.fn(async () => succeeded);
    let now = 1_000_000;
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute },
      settings(),
      new FakeAnytype(),
      () => undefined,
      () => now,
      { tickBudgetMilliseconds: 30 },
    );
    await extension.beforeTick();
    expect(inbox.command(terminal.commandId)?.completedAt).toBeUndefined();
    expect(claimCommands).not.toHaveBeenCalled();
    now += 10_000;
    await extension.beforeTick();
    expect(inbox.command(terminal.commandId)?.completedAt).toBe(now);
    expect(claimCommands).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(inbox.command(fresh.commandId)?.state).toBe("terminal_pending");
    await extension.stop();
    store.close();
  });

  it("retires a result whose matching receipt arrives with cancellation", async () => {
    const store = new Store(":memory:");
    const inbox = new CloudCommandStore(store);
    const item = command();
    inbox.persistClaim(item, 1_000_000);
    inbox.reject(item.commandId, "test-denial", 1_000_000);
    const { client, submitResult } = clientFor([]);
    const controller = new AbortController();
    submitResult.mockImplementation(async (submitted) => {
      controller.abort(new Error("stopped after receipt"));
      return {
        protocolVersion: "1.0",
        commandId: submitted.commandId,
        attempt: 1,
        status: "accepted",
        state: "succeeded",
      };
    });
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute: vi.fn(async () => succeeded) },
      settings({ approval: "all" }),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_000,
    );
    await extension.beforeTick(controller.signal);
    expect(inbox.command(item.commandId)?.completedAt).toBe(1_000_000);
    await extension.beforeTick();
    expect(submitResult).toHaveBeenCalledOnce();
    await extension.stop();
    store.close();
  });

  it("still defers a batch after a retryable Cloud transport failure", async () => {
    const store = new Store(":memory:");
    const inbox = new CloudCommandStore(store);
    const item = command({ leaseExpiresAt: 1_015 });
    inbox.persistClaim(item, 1_000_000);
    inbox.prepare(item.commandId, true, 1_000_000);
    const { client, extendLease, submitResult, claimCommands } = clientFor([]);
    extendLease.mockRejectedValue(
      new CloudRequestError("Cloud unavailable", {
        status: 503,
        retryable: true,
      }),
    );
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute: vi.fn(async () => succeeded) },
      settings({ approval: "all" }),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_000,
    );
    await extension.beforeTick();
    await extension.beforeTick();
    expect(extendLease).toHaveBeenCalledOnce();
    expect(submitResult).not.toHaveBeenCalled();
    expect(claimCommands).not.toHaveBeenCalled();
    await extension.stop();
    store.close();
  });

  it("rejects a late lease response after cancellation before changing durable state", async () => {
    const store = new Store(":memory:");
    const item = command({ leaseExpiresAt: 1_001 });
    const inbox = new CloudCommandStore(store);
    inbox.persistClaim(item, 1_000_000);
    inbox.prepare(item.commandId, true, 1_000_000);
    const { client } = clientFor([]);
    client.extendLease = vi.fn<CloudCommandClient["extendLease"]>(
      async (_command, _seconds, signal) =>
        new Promise<Awaited<ReturnType<CloudCommandClient["extendLease"]>>>((resolve) => {
          signal!.addEventListener(
            "abort",
            () =>
              resolve({
                protocolVersion: "1.0",
                commandId: item.commandId,
                attempt: 1,
                leaseExpiresAt: 1_200,
              }),
            { once: true },
          );
        }),
    );
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute: vi.fn(async () => succeeded) },
      settings({ approval: "all" }),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_000,
      { tickBudgetMilliseconds: 30 },
    );
    await extension.beforeTick();
    expect(inbox.command(item.commandId)?.leaseExpiresAt).toBe(1_001_000);
    await extension.stop();
    store.close();
  });

  it("stops an in-flight effect and retains the unknown-outcome replay barrier", async () => {
    const store = new Store(":memory:");
    const item = command();
    const { client } = clientFor([item]);
    let cancelled = false;
    const executor: CloudCommandExecutionPort = {
      execute: vi.fn<CloudCommandExecutionPort["execute"]>(
        async (_command, _key, signal) =>
          new Promise<CloudCommandResult>((_resolve, reject) => {
            signal!.addEventListener(
              "abort",
              () => {
                cancelled = true;
                reject(signal!.reason);
              },
              { once: true },
            );
          }),
      ),
    };
    const extension = new CloudWorkflowExtension(
      store,
      client,
      executor,
      settings(),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_000,
    );
    await extension.beforeTick();
    expect(executor.execute).toHaveBeenCalledOnce();
    await extension.stop();
    expect(cancelled).toBe(true);
    expect(new CloudCommandStore(store).command(item.commandId)).toMatchObject({
      state: "dead_letter",
      lastErrorCode: "effect-outcome-unknown",
    });
    await extension.beforeTick();
    expect(executor.execute).toHaveBeenCalledOnce();
    store.close();
  });

  it("stops a pending Cloud poll without accepting its late reply", async () => {
    const store = new Store(":memory:");
    const { client } = clientFor([]);
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    client.claimCommands = vi.fn<CloudCommandClient["claimCommands"]>(
      async (input) =>
        new Promise<Awaited<ReturnType<CloudCommandClient["claimCommands"]>>>((resolve) => {
          input!.signal!.addEventListener(
            "abort",
            () =>
              resolve({
                protocolVersion: "1.0",
                commands: [command()],
                pollAfterSeconds: 5,
              }),
            { once: true },
          );
          entered();
        }),
    );
    const execute = vi.fn(async () => succeeded);
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute },
      settings(),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_000,
    );
    const tick = extension.beforeTick();
    await pending;
    await extension.stop();
    await tick;
    expect(new CloudCommandStore(store).list()).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    store.close();
  });

  it("does not send after the native origin lookup is cancelled", async () => {
    const anytype = new FakeAnytype();
    const controller = new AbortController();
    anytype.getMessage = vi.fn(async () => {
      controller.abort(new Error("stopped"));
      return { id: "origin-message-1", creator: "operator", content: { text: "hello" } };
    });
    const send = vi.spyOn(anytype, "sendMessage");
    const { client } = clientFor([]);
    const executor = new AnytypeCloudCommandExecutor(
      anytype,
      client,
      cloudConfigSchema.parse({
        version: 1,
        baseUrl: "https://knot.example/",
        connectorName: "test",
        protocolVersion: "1.0",
        publicKey: "a".repeat(43),
        privateKeyFile: "/tmp/key",
        requestedScopes: ["anytype.chats.send"],
        requestedSlugGrants: [],
      }),
      "agent-1",
      ["operator"],
    );
    await expect(executor.execute(command(), "e".repeat(64), controller.signal)).rejects.toThrow(
      "stopped",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("extends a near-expiry lease and survives an offline poll", async () => {
    const store = new Store(":memory:");
    const item = command({ leaseExpiresAt: 1_001 });
    const inbox = new CloudCommandStore(store);
    inbox.persistClaim(item, 1_000_000);
    inbox.prepare(item.commandId, true, 1_000_000);
    const { client, extendLease } = clientFor([]);
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute: vi.fn(async () => succeeded) },
      settings({ approval: "all" }),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_000,
    );
    await extension.beforeTick();
    expect(extendLease).toHaveBeenCalledOnce();
    expect(inbox.command(item.commandId)?.leaseExpiresAt).toBe(1_200_000);

    const offline = {
      ...client,
      claimCommands: vi.fn(async () => {
        throw new Error("offline");
      }),
    } as CloudCommandClient;
    const second = new CloudWorkflowExtension(
      store,
      offline,
      { execute: vi.fn(async () => succeeded) },
      settings({ approval: "all" }),
      new FakeAnytype(),
      () => undefined,
      () => 1_010_000,
    );
    await expect(second.beforeTick()).resolves.toBeUndefined();
    store.close();
  });

  it("delivers one audit projection from the durable outbox", async () => {
    const store = new Store(":memory:");
    const item = command();
    const { client } = clientFor([item]);
    const anytype = new FakeAnytype();
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute: vi.fn(async () => succeeded) },
      settings({
        approval: "all",
        projection: { enabled: true, spaceId: "audit-space", chatId: "audit-chat" },
      }),
      anytype,
      () => undefined,
      () => 1_000_000,
    );
    await extension.beforeTick();
    await extension.afterTick();
    await extension.afterTick();
    expect(anytype.messages).toHaveLength(1);
    expect(anytype.messages[0]?.content?.text).toContain(item.commandId);
    const delivered = store.db
      .prepare("SELECT COUNT(*) AS count FROM cloud_projection_outbox WHERE state='delivered'")
      .get() as { count: number };
    expect(delivered.count).toBe(1);
    store.close();
  });

  it("does not claim an audit projection after cancellation", async () => {
    const store = new Store(":memory:");
    const { client } = clientFor([command()]);
    const anytype = new FakeAnytype();
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute: vi.fn(async () => succeeded) },
      settings({
        approval: "all",
        projection: { enabled: true, spaceId: "audit-space", chatId: "audit-chat" },
      }),
      anytype,
      () => undefined,
      () => 1_000_000,
    );
    await extension.beforeTick();
    await extension.afterTick(AbortSignal.abort(new Error("cancelled before projection")));
    expect(anytype.messages).toHaveLength(0);
    expect(store.db.prepare("SELECT state,attempt FROM cloud_projection_outbox").get()).toEqual({
      state: "pending",
      attempt: 0,
    });
    await extension.afterTick();
    expect(anytype.messages).toHaveLength(1);
    await extension.stop();
    store.close();
  });

  it("records a confirmed audit send after cancellation without sending it again", async () => {
    const store = new Store(":memory:");
    const { client } = clientFor([command()]);
    const anytype = new FakeAnytype();
    const controller = new AbortController();
    const originalSend = anytype.sendMessage.bind(anytype);
    const send = vi.spyOn(anytype, "sendMessage").mockImplementation(async (...args) => {
      const messageId = await originalSend(...args);
      controller.abort(new Error("cancelled after successful send"));
      return messageId;
    });
    let now = 1_000_000;
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute: vi.fn(async () => succeeded) },
      settings({
        approval: "all",
        projection: { enabled: true, spaceId: "audit-space", chatId: "audit-chat" },
      }),
      anytype,
      () => undefined,
      () => now,
    );
    await extension.beforeTick();
    await extension.afterTick(controller.signal);
    expect(
      store.db.prepare("SELECT state,attempt,target_message_id FROM cloud_projection_outbox").get(),
    ).toEqual({ state: "delivered", attempt: 1, target_message_id: anytype.messages[0]?.id });
    now += 60_000;
    await extension.afterTick();
    expect(send).toHaveBeenCalledOnce();
    expect(anytype.messages).toHaveLength(1);
    await extension.stop();
    store.close();
  });

  it("does not mark an interrupted audit send delivered without a message ID", async () => {
    const store = new Store(":memory:");
    const { client } = clientFor([command()]);
    const anytype = new FakeAnytype();
    const controller = new AbortController();
    vi.spyOn(anytype, "sendMessage").mockImplementation(async () => {
      controller.abort(new Error("send interrupted"));
      throw controller.signal.reason;
    });
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute: vi.fn(async () => succeeded) },
      settings({
        approval: "all",
        projection: { enabled: true, spaceId: "audit-space", chatId: "audit-chat" },
      }),
      anytype,
      () => undefined,
      () => 1_000_000,
    );
    await extension.beforeTick();
    await extension.afterTick(controller.signal);
    expect(
      store.db.prepare("SELECT state,attempt,target_message_id FROM cloud_projection_outbox").get(),
    ).toEqual({ state: "retrying", attempt: 1, target_message_id: null });
    await extension.stop();
    store.close();
  });

  it("bounds retryable failures and does not repeat after the local attempt budget", async () => {
    const store = new Store(":memory:");
    const item = command({
      requiredScope: "anytype.objects.read",
      operation: { type: "object.read", spaceId: "space-1", objectId: "object-1" },
    });
    const { client, submitResult } = clientFor([item]);
    const execute = vi.fn(async () => {
      throw new Error("offline Anytype API");
    });
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute },
      settings({
        allowedScopes: ["anytype.objects.read"],
        maximumLocalAttempts: 1,
      }),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_000,
    );
    await extension.beforeTick();
    await extension.beforeTick();
    await extension.beforeTick();
    expect(execute).toHaveBeenCalledOnce();
    expect(submitResult).toHaveBeenCalledOnce();
    expect(new CloudCommandStore(store).command(item.commandId)).toMatchObject({
      state: "dead_letter",
      localAttempts: 1,
      lastErrorCode: "external-effect-failed",
    });
    store.close();
  });

  it("rejects an expired command", async () => {
    const store = new Store(":memory:");
    const expired = command({ createdAt: 1, notBefore: 1, leaseExpiresAt: 2, expiresAt: 3 });
    const { client } = clientFor([expired]);
    const extension = new CloudWorkflowExtension(
      store,
      client,
      { execute: vi.fn(async () => succeeded) },
      settings(),
      new FakeAnytype(),
      () => undefined,
      () => 1_000_000,
    );
    await extension.beforeTick();
    expect(new CloudCommandStore(store).command(expired.commandId)?.result).toEqual({
      outcome: "rejected-by-local-policy",
      reasonCode: "command-expired",
    });
    store.close();
  });

  it("defers not-before commands using the same server-adjusted clock as request signing", async () => {
    const store = new Store(":memory:");
    const item = command({ notBefore: 1_100, leaseExpiresAt: 1_150 });
    const fixture = clientFor([item]);
    let adjustedNow = 1_000_000;
    fixture.client.serverAdjustedNow = () => adjustedNow;
    const execute = vi.fn(async () => succeeded);
    const extension = new CloudWorkflowExtension(
      store,
      fixture.client,
      { execute },
      settings(),
      new FakeAnytype(),
      () => undefined,
    );

    await extension.beforeTick();

    expect(execute).not.toHaveBeenCalled();
    expect(
      store.db
        .prepare("SELECT state,available_at FROM cloud_command_inbox WHERE command_id=?")
        .get(item.commandId),
    ).toEqual({ state: "queued", available_at: 1_100_000 });

    adjustedNow = 1_100_000;
    await extension.beforeTick();

    expect(execute).toHaveBeenCalledOnce();
    expect(new CloudCommandStore(store).command(item.commandId)?.state).toBe("terminal_pending");
    store.close();
  });

  it("uses locally observed Anytype participant provenance and ignores claimed digests", async () => {
    const anytype = new FakeAnytype();
    anytype.messages.push({
      id: "message-1",
      creator: "native-participant-1",
      created_at: 1_000_000,
      content: { text: "hello" },
      senderDigest: "b".repeat(64),
    } as never);
    const config = cloudConfigSchema.parse({
      version: 1,
      baseUrl: "https://knot.example/",
      connectorName: "test",
      protocolVersion: "1.0",
      publicKey: "a".repeat(43),
      privateKeyFile: "/tmp/key",
      requestedScopes: ["anytype.chats.read"],
      requestedSlugGrants: [],
      paired: {
        connectorId: "68bc8f83-fd2e-4f0e-a5de-ad539bcaf0d0",
        tenantId: "tenant-1",
        scopes: ["anytype.chats.read"],
        siteIds: [],
        slugGrants: [],
        approvedAt: 1,
      },
    });
    const cloud = clientFor([]).client;
    const executor = new AnytypeCloudCommandExecutor(anytype, cloud, config, "agent-1");
    const item = command({
      requiredScope: "anytype.chats.read",
      operation: { type: "chat.read", spaceId: "space-1", chatId: "chat-1", limit: 10 },
    });
    const result = await executor.execute(item, "e".repeat(64));
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded" || result.result.type !== "chat.read") return;
    const expected = createHash("sha256")
      .update("knot.anytype.participant.v1\0native-participant-1")
      .digest("hex");
    expect(result.result.messages[0]?.senderDigest).toBe(expected);
    expect(result.result.messages[0]?.senderDigest).not.toBe("b".repeat(64));
  });

  it("refetches the native channel origin and authorizes its immutable participant before chat.send", async () => {
    const anytype = new FakeAnytype();
    anytype.messages.push({
      id: "origin-message-1",
      creator: "native-operator",
      content: { text: "send the update" },
    });
    const config = cloudConfigSchema.parse({
      version: 1,
      baseUrl: "https://knot.example/",
      connectorName: "test",
      protocolVersion: "1.0",
      publicKey: "a".repeat(43),
      privateKeyFile: "/tmp/key",
      requestedScopes: ["anytype.chats.send"],
      requestedSlugGrants: [],
      paired: {
        connectorId: "68bc8f83-fd2e-4f0e-a5de-ad539bcaf0d0",
        tenantId: "tenant-1",
        scopes: ["anytype.chats.send"],
        siteIds: [],
        slugGrants: [],
        approvedAt: 1,
      },
    });
    const executor = new AnytypeCloudCommandExecutor(
      anytype,
      clientFor([]).client,
      config,
      "agent-1",
      ["native-operator"],
    );
    const result = await executor.execute(command(), "e".repeat(64));
    expect(result).toMatchObject({
      outcome: "succeeded",
      result: { type: "chat.send", messageId: "reply-1" },
    });
    expect(anytype.messages.at(-1)?.content?.text).toBe("hello");
  });

  it("fails chat.send closed for Cloud-asserted identity and an unverified native sender", async () => {
    const anytype = new FakeAnytype();
    anytype.messages.push({ id: "origin-message-1", content: { text: "forged" } });
    const config = cloudConfigSchema.parse({
      version: 1,
      baseUrl: "https://knot.example/",
      connectorName: "test",
      protocolVersion: "1.0",
      publicKey: "a".repeat(43),
      privateKeyFile: "/tmp/key",
      requestedScopes: ["anytype.chats.send"],
      requestedSlugGrants: [],
    });
    const executor = new AnytypeCloudCommandExecutor(
      anytype,
      clientFor([]).client,
      config,
      "agent-1",
      ["native-operator"],
    );
    await expect(executor.execute(command(), "e".repeat(64))).resolves.toEqual({
      outcome: "rejected-by-local-policy",
      reasonCode: "channel-origin-sender-unverified",
    });
    expect(anytype.messages).toHaveLength(1);
  });
});

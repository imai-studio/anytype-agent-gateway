import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloudCommandAction } from "../src/cloud-command-cli.js";
import { CloudCommandStore } from "../src/cloud-workflow.js";
import { commandEnvelopeSchema } from "../src/cloud-contract.js";
import { Store } from "../src/store.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "knot-result-retry-cli-"));
  const configFile = join(directory, "agent.json");
  const statePath = join(directory, "state.sqlite");
  await writeFile(
    configFile,
    JSON.stringify({
      version: 1,
      agent: { name: "Fixture", participantId: "bot" },
      anytype: { apiKeyFile: join(directory, "missing-key") },
      spaces: [{ id: "space" }],
      runtime: { kind: "codex" },
      state: { path: statePath },
    }),
  );
  const store = new Store(statePath);
  const inbox = new CloudCommandStore(store);
  const command = commandEnvelopeSchema.parse({
    protocolVersion: "1.0",
    commandId: "03b1731d-10a3-48ab-b8e4-5b164e536d20",
    connectorId: "68bc8f83-fd2e-4f0e-a5de-ad539bcaf0d0",
    requiredScope: "anytype.chats.send",
    createdBy: "human-session",
    actor: {
      principalDigest: "a".repeat(64),
      digestVersion: 1,
      provenance: "authenticated-cloud-session",
    },
    createdAt: 900,
    notBefore: 900,
    expiresAt: 2000,
    attempt: 1,
    leaseToken: "fixture_lease_token_1234567890abcdefghijklmnop",
    leaseExpiresAt: 1100,
    payload: {
      domain: "anytype",
      operation: {
        type: "chat.send",
        spaceId: "space",
        chatId: "chat",
        message: "fixture",
        channelOrigin: { spaceId: "space", chatId: "chat", messageId: "origin" },
      },
    },
  });
  inbox.persistClaim(command, 1_000_000);
  return { configFile, store, inbox, command };
}

describe("Cloud result submission CLI recovery", () => {
  it("retries reporting without renewing authority, changing a fence or replaying an unknown effect", async () => {
    const { configFile, store, inbox, command } = await fixture();
    try {
      inbox.prepare(command.commandId, false, 1_000_000);
      inbox.startEffect(command.commandId, 1_000_000);
      inbox.recoverInterruptedEffects(1_000_001);
      const result = inbox.command(command.commandId)!.result!;
      for (let attempt = 0; attempt < 5; attempt += 1)
        inbox.failSubmission(command, result, "submission-http-409", 1_000_002 + attempt);
      const receipt = store.db.prepare("SELECT * FROM cloud_effect_receipts").all();
      const row = () =>
        store.db.prepare("SELECT * FROM cloud_command_inbox").get() as Record<string, unknown>;
      const stableFields = (record: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(record).filter(
            ([key]) =>
              ![
                "updated_at",
                "available_at",
                "submission_attempts",
                "submission_last_error_code",
                "submission_last_error",
                "submission_quarantined_at",
              ].includes(key),
          ),
        );
      const before = row();
      await expect(
        cloudCommandAction({
          agentConfigFile: configFile,
          commandId: command.commandId,
          action: "retry",
        }),
      ).rejects.toThrow("cannot be retried safely");
      expect(row()).toEqual(before);
      const lines: string[] = [];
      await cloudCommandAction({
        agentConfigFile: configFile,
        commandId: command.commandId,
        action: "result-retry",
        output: (line) => lines.push(line),
      });
      expect(stableFields(row())).toEqual(stableFields(before));
      expect(store.db.prepare("SELECT * FROM cloud_effect_receipts").all()).toEqual(receipt);
      expect(inbox.submissionDiagnostics().quarantined).toBe(0);
      expect(inbox.command(command.commandId)).toMatchObject({
        state: "dead_letter",
        submissionAttempts: 0,
        lastErrorCode: "effect-outcome-unknown",
      });
      expect(lines).toEqual([
        "Result submission retry scheduled; local effects will not run again.",
      ]);
      expect(() => inbox.startEffect(command.commandId)).toThrow();
    } finally {
      store.close();
    }
  });

  it("refuses result retry for a command with no terminal result without changing state", async () => {
    const { configFile, store, command } = await fixture();
    try {
      const before = store.db.prepare("SELECT * FROM cloud_command_inbox").all();
      const lines: string[] = [];
      await expect(
        cloudCommandAction({
          agentConfigFile: configFile,
          commandId: command.commandId,
          action: "result-retry",
          output: (line) => lines.push(line),
        }),
      ).rejects.toThrow("cannot transition through result-retry");
      expect(store.db.prepare("SELECT * FROM cloud_command_inbox").all()).toEqual(before);
      expect(lines).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("exposes quarantined reporting in doctor before network checks", async () => {
    const { configFile, store, inbox, command } = await fixture();
    try {
      inbox.reject(command.commandId, "fixture-rejected", 1_000_001);
      const result = inbox.command(command.commandId)!.result!;
      for (let attempt = 0; attempt < 5; attempt += 1)
        inbox.failSubmission(command, result, "submission-http-409", 1_000_002 + attempt);
      const output = await new Promise<string>((resolve) =>
        execFile(
          process.execPath,
          ["--import", "tsx", join(process.cwd(), "src/cli.ts"), "doctor", "--config", configFile],
          { timeout: 10_000 },
          (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`),
        ),
      );
      const line = output.split("\n").find((value) => value.includes("cloud result submissions"));
      expect(line).toContain("warning:");
      expect(line).toContain("quarantined=1");
      expect(line).not.toContain(command.commandId);
      expect(line).not.toContain(command.leaseToken);
      expect(line).not.toContain(configFile);
    } finally {
      store.close();
    }
  });
});

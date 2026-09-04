import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CloudClient, backoffMilliseconds } from "../src/cloud-client.js";
import { initializeCloudConfig, resolveCloudPaths, type CloudConfig } from "../src/cloud-config.js";

const connectorId = "00000000-0000-4000-8000-000000000011";
const commandId = "00000000-0000-4000-8000-000000000021";

describe("CloudClient", () => {
  it("aborts the native HTTP request when a Cloud deadline expires", async () => {
    let entered!: () => void;
    let closed!: () => void;
    const requestEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const requestClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const server = createServer((_request, response) => {
      response.on("close", closed);
      entered();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server address");
      const config = { ...(await pairedConfig()), baseUrl: `http://127.0.0.1:${address.port}` };
      const client = new CloudClient(config);
      const controller = new AbortController();
      const pending = client.claimCommands({ signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow("cloud tick elapsed");
      await requestEntered;
      controller.abort(new Error("cloud tick elapsed"));
      await rejected;
      await requestClosed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("cancels oversized chunked replies before consuming the whole body", async () => {
    const config = await pairedConfig();
    let chunksRead = 0;
    const cancel = vi.fn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              chunksRead += 1;
              controller.enqueue(new Uint8Array(256 * 1024));
              if (chunksRead === 100) controller.close();
            },
            cancel,
          }),
        ),
    );
    const client = new CloudClient(config, { fetch: fetchMock, maximumAttempts: 4 });
    await expect(client.protocolStatus()).rejects.toThrow("oversized response");
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunksRead).toBeLessThan(10);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels a stalled response body at the request deadline", async () => {
    const config = await pairedConfig();
    const cancel = vi.fn();
    const client = new CloudClient(config, {
      fetch: vi.fn(async () => new Response(new ReadableStream({ cancel }))),
      requestTimeoutMilliseconds: 30,
      maximumAttempts: 1,
    });
    await expect(client.protocolStatus()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts requests without retrying after their caller cancels", async () => {
    const config = await pairedConfig();
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        controller.abort(new Error("tick budget elapsed"));
      });
    });
    const client = new CloudClient(config, { fetch: fetchMock, maximumAttempts: 4 });
    await expect(client.claimCommands({ signal: controller.signal })).rejects.toThrow(
      "tick budget elapsed",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels Retry-After sleep without another request", async () => {
    const config = await pairedConfig();
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      setTimeout(() => controller.abort(new Error("stopped")), 20);
      return Response.json(
        {
          type: "https://knot.example/problems/unavailable",
          title: "Unavailable",
          status: 503,
          code: "unavailable",
          retryable: true,
          retryAfterSeconds: 3600,
        },
        { status: 503 },
      );
    });
    const client = new CloudClient(config, { fetch: fetchMock });
    await expect(client.claimCommands({ signal: controller.signal })).rejects.toThrow("stopped");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("permits loopback uploads only for a locally configured Cloud", async () => {
    const config = await pairedConfig({ scopes: ["publications.write"] });
    const upload = {
      protocolVersion: "1.0" as const,
      assetId: "00000000-0000-4000-8000-000000000071",
      uploadId: "00000000-0000-4000-8000-000000000072",
      method: "PUT" as const,
      uploadUrl: "http://127.0.0.1:8080/object",
      requiredHeaders: {},
      expiresAt: 1_788_220_900,
    };
    const fetchMock = vi.fn(async () => new Response(null));
    const remote = new CloudClient(config, { fetch: fetchMock });
    await expect(remote.uploadAsset(upload, Buffer.from("asset"))).rejects.toThrow(
      "cannot upload to a loopback service",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const local = new CloudClient(
      { ...config, baseUrl: "http://localhost:8081" },
      { fetch: fetchMock },
    );
    await expect(local.uploadAsset(upload, Buffer.from("asset"))).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses only the frozen signed publication routes and validates their replies", async () => {
    const config = await pairedConfig({
      scopes: ["publications.read", "publications.write", "publications.unpublish"],
      siteIds: ["00000000-0000-4000-8000-000000000031"],
      slugGrants: ["notes/*"],
    });
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      expect(new Headers(init?.headers).get("Knot-Signature")).toBeTruthy();
      if (url.pathname.endsWith("/status"))
        return Response.json({
          protocolVersion: "1.0",
          publicationId: "00000000-0000-4000-8000-000000000032",
          siteId: "00000000-0000-4000-8000-000000000031",
          slug: "notes/hello",
          state: "ready",
          currentVersionId: "00000000-0000-4000-8000-000000000033",
          updatedAt: 1,
        });
      if (url.pathname.endsWith("/control"))
        return Response.json({
          type: "publication.disable",
          publicationId: "00000000-0000-4000-8000-000000000032",
          disabledAt: 1,
        });
      return Response.json(
        {
          protocolVersion: "1.0",
          publicationId: "00000000-0000-4000-8000-000000000032",
          versionId: "00000000-0000-4000-8000-000000000033",
          state: "ready",
        },
        { status: 201 },
      );
    });
    const client = new CloudClient(config, {
      fetch: fetchMock as unknown as typeof fetch,
      maximumAttempts: 1,
    });
    await client.publish({
      connectorId,
      siteId: "00000000-0000-4000-8000-000000000031",
      publicationId: "00000000-0000-4000-8000-000000000032",
      slug: "notes/hello",
      operation: "create",
      document: { schemaVersion: "1.0", title: "Hello", blocks: [] },
      contentSha256: "a".repeat(64),
      assetDigests: [],
      idempotencyKey: "knot-idempotency-0001",
    });
    await client.publicationStatus("00000000-0000-4000-8000-000000000032");
    await client.controlPublication({
      protocolVersion: "1.0",
      connectorId,
      idempotencyKey: "knot-idempotency-0002",
      operation: {
        type: "publication.disable",
        publicationId: "00000000-0000-4000-8000-000000000032",
      },
    });
    expect(paths).toEqual([
      `/api/v1/connectors/${connectorId}/publications`,
      `/api/v1/connectors/${connectorId}/publications/00000000-0000-4000-8000-000000000032/status`,
      `/api/v1/connectors/${connectorId}/publications/00000000-0000-4000-8000-000000000032/control`,
    ]);
  });

  it("uses the presigned asset request, upload, and commit contract without forwarding credentials", async () => {
    const config = await pairedConfig({ scopes: ["publications.write"] });
    const calls: string[] = [];
    let uploadedHeaders: Record<string, string> | undefined;
    const requiredHeaders = {
      "cache-control": "private, no-store, max-age=0",
      "content-length": "5",
      "content-type": "image/png",
      "if-none-match": "*",
      "x-amz-meta-byte-size": "5",
      "x-amz-meta-kind": "asset",
      "x-amz-meta-sha256": "a".repeat(64),
      "x-amz-meta-tenant-id": "00000000-0000-4000-8000-000000000073",
    };
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method}:${url.toString()}`);
      if (url.hostname === "uploads.example") {
        const headers = new Headers(init?.headers);
        uploadedHeaders = Object.fromEntries(headers.entries());
        expect(Buffer.from(init?.body as Uint8Array).toString()).toBe("asset");
        return new Response(null, { status: 200 });
      }
      if (url.pathname.endsWith("/assets/request"))
        return Response.json(
          {
            protocolVersion: "1.0",
            assetId: "00000000-0000-4000-8000-000000000071",
            uploadId: "00000000-0000-4000-8000-000000000072",
            method: "PUT",
            uploadUrl: "https://uploads.example/object",
            requiredHeaders,
            expiresAt: 1_788_220_900,
          },
          { status: 201 },
        );
      return Response.json({
        status: "verified",
        assetId: "00000000-0000-4000-8000-000000000071",
        sha256: "a".repeat(64),
        byteSize: 5,
        verifiedAt: 1_788_220_810,
      });
    });
    const client = new CloudClient(config, {
      fetch: fetchMock as unknown as typeof fetch,
      maximumAttempts: 1,
    });
    const upload = await client.requestAssetUpload({
      protocolVersion: "1.0",
      connectorId,
      siteId: "00000000-0000-4000-8000-000000000031",
      sha256: "a".repeat(64),
      byteSize: 5,
      contentType: "image/png",
      fileName: "asset.png",
      idempotencyKey: "knot-asset-request-0001",
    });
    await client.uploadAsset(upload, Buffer.from("asset"));
    await client.commitAssetUpload({
      assetId: upload.assetId,
      uploadId: upload.uploadId,
      expectedSha256: "a".repeat(64),
      expectedByteSize: 5,
      idempotencyKey: "knot-asset-commit-0001",
    });
    expect(uploadedHeaders).toEqual(requiredHeaders);
    expect(uploadedHeaders).not.toHaveProperty("authorization");
    expect(calls).toEqual([
      `POST:https://knot.example/api/v1/connectors/${connectorId}/assets/request`,
      "PUT:https://uploads.example/object",
      `POST:https://knot.example/api/v1/connectors/${connectorId}/assets/commit`,
    ]);
  });
  it("signs each command claim with the local Ed25519 identity", async () => {
    const config = await pairedConfig();
    const now = 1_788_220_800;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = Buffer.from(init?.body as Uint8Array);
      const headers = new Headers(init?.headers);
      expect(headers.get("Knot-Connector-Id")).toBe(connectorId);
      expect(headers.get("Knot-Protocol-Version")).toBe("1.0");
      const timestamp = headers.get("Knot-Timestamp")!;
      const nonce = headers.get("Knot-Nonce")!;
      const canonical = [
        "knot-cloud-ed25519-v1",
        "1.0",
        connectorId,
        "knot.example",
        "POST",
        url.pathname,
        url.search,
        timestamp,
        nonce,
        createHash("sha256").update(body).digest("hex"),
      ].join("\n");
      const publicKey = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: config.publicKey },
        format: "jwk",
      });
      expect(
        verify(
          null,
          Buffer.from(canonical),
          publicKey,
          Buffer.from(headers.get("Knot-Signature")!, "base64url"),
        ),
      ).toBe(true);
      return Response.json({
        protocolVersion: "1.0",
        commands: [
          {
            protocolVersion: "1.0",
            commandId,
            connectorId,
            requiredScope: "anytype.objects.read",
            createdBy: "consumer-api-key",
            actor: {
              principalDigest: "a".repeat(64),
              digestVersion: 1,
              provenance: "consumer-api-key",
            },
            createdAt: now - 10,
            notBefore: now - 5,
            expiresAt: now + 300,
            attempt: 1,
            leaseToken: "l".repeat(32),
            leaseExpiresAt: now + 60,
            payload: {
              domain: "anytype",
              operation: { type: "object.read", spaceId: "space", objectId: "object" },
            },
          },
        ],
        pollAfterSeconds: 1,
      });
    });
    const client = new CloudClient(config, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now * 1_000,
      maximumAttempts: 1,
    });
    const response = await client.claimCommands({ leaseSeconds: 45 });
    expect(response.commands[0]?.commandId).toBe(commandId);
  });

  it("uses fresh signed requests and bounded backoff after a retryable failure", async () => {
    const config = await pairedConfig();
    const nonces: string[] = [];
    const sleeps: number[] = [];
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      nonces.push(new Headers(init?.headers).get("Knot-Nonce")!);
      if (nonces.length === 1)
        return Response.json(
          {
            type: "https://knot.example/problems/dependency-unavailable",
            title: "Try again",
            status: 503,
            code: "dependency-unavailable",
            requestId: "request-identifier-0001",
            retryable: true,
            retryAfterSeconds: 2,
          },
          { status: 503 },
        );
      return Response.json({ protocolVersion: "1.0", commands: [], pollAfterSeconds: 5 });
    });
    const client = new CloudClient(config, {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async (milliseconds) => void sleeps.push(milliseconds),
      maximumAttempts: 2,
    });
    await client.claimCommands();
    expect(sleeps).toEqual([2_000]);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it("re-signs once with the server time after a clock-skew response", async () => {
    const config = await pairedConfig();
    const timestamps: string[] = [];
    const now = 1_788_220_800;
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      timestamps.push(new Headers(init?.headers).get("Knot-Timestamp")!);
      if (timestamps.length === 1)
        return Response.json(
          {
            type: "https://knot.example/problems/clock-skew",
            title: "Clock skew",
            status: 401,
            code: "clock-skew",
            requestId: "request-identifier-0002",
            retryable: false,
            serverUnixSeconds: now + 90,
          },
          { status: 401 },
        );
      return Response.json({ protocolVersion: "1.0", commands: [], pollAfterSeconds: 5 });
    });
    const client = new CloudClient(config, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now * 1_000,
      maximumAttempts: 2,
    });
    await client.claimCommands();
    expect(timestamps).toEqual([String(now), String(now + 90)]);
    expect(client.serverAdjustedNow()).toBe((now + 90) * 1_000);
  });

  it("retries an unparseable transient server response", async () => {
    const config = await pairedConfig();
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return new Response("temporary proxy failure", { status: 503 });
      return Response.json({ protocolVersion: "1.0", commands: [], pollAfterSeconds: 5 });
    });
    const client = new CloudClient(config, {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => undefined,
      maximumAttempts: 2,
    });
    await client.claimCommands();
    expect(attempts).toBe(2);
  });

  it("submits an explicit local-policy rejection through the fenced result route", async () => {
    const config = await pairedConfig();
    let submitted: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      submitted = JSON.parse(Buffer.from(init?.body as Uint8Array).toString()) as Record<
        string,
        unknown
      >;
      return Response.json({
        protocolVersion: "1.0",
        commandId,
        attempt: 1,
        status: "accepted",
        state: "rejected-by-local-policy",
      });
    });
    const client = new CloudClient(config, {
      fetch: fetchMock as unknown as typeof fetch,
      maximumAttempts: 1,
    });
    await client.rejectByLocalPolicy(
      {
        protocolVersion: "1.0",
        commandId,
        connectorId,
        requiredScope: "anytype.objects.read",
        createdBy: "consumer-api-key",
        actor: {
          principalDigest: "a".repeat(64),
          digestVersion: 1,
          provenance: "consumer-api-key",
        },
        createdAt: 1,
        notBefore: 1,
        expiresAt: 100,
        attempt: 1,
        leaseToken: "l".repeat(32),
        leaseExpiresAt: 50,
        payload: {
          domain: "anytype",
          operation: { type: "object.read", spaceId: "space", objectId: "object" },
        },
      },
      "sender-not-authorized",
    );
    expect(submitted?.result).toEqual({
      outcome: "rejected-by-local-policy",
      reasonCode: "sender-not-authorized",
    });
  });

  it("rejects a claimed command outside the locally recorded connector grant", async () => {
    const config = await pairedConfig();
    const now = 1_788_220_800;
    const fetchMock = vi.fn(async () =>
      Response.json({
        protocolVersion: "1.0",
        commands: [
          {
            protocolVersion: "1.0",
            commandId,
            connectorId: "another-connector",
            requiredScope: "anytype.objects.read",
            createdBy: "consumer-api-key",
            actor: {
              principalDigest: "a".repeat(64),
              digestVersion: 1,
              provenance: "consumer-api-key",
            },
            createdAt: now - 10,
            notBefore: now - 5,
            expiresAt: now + 300,
            attempt: 1,
            leaseToken: "l".repeat(32),
            leaseExpiresAt: now + 60,
            payload: {
              domain: "anytype",
              operation: { type: "object.read", spaceId: "space", objectId: "object" },
            },
          },
        ],
        pollAfterSeconds: 1,
      }),
    );
    const client = new CloudClient(config, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now * 1_000,
      maximumAttempts: 1,
    });
    await expect(client.claimCommands()).rejects.toThrow("different connector");
  });

  it("keeps exponential backoff bounded", () => {
    expect(backoffMilliseconds(0, () => 0)).toBe(375);
    expect(backoffMilliseconds(20, () => 1)).toBe(37_500);
  });
});

async function pairedConfig(
  pairedOverrides: Partial<NonNullable<CloudConfig["paired"]>> = {},
): Promise<CloudConfig> {
  const home = await mkdtemp(join(tmpdir(), "knot-cloud-client-"));
  const paths = resolveCloudPaths({ home });
  const config = await initializeCloudConfig({
    paths,
    baseUrl: "https://knot.example",
    connectorName: "Test Mac",
    requestedScopes: ["anytype.objects.read"],
  });
  return {
    ...config,
    paired: {
      connectorId,
      tenantId: "00000000-0000-4000-8000-000000000012",
      scopes: ["anytype.objects.read"],
      siteIds: [],
      slugGrants: [],
      approvedAt: 1,
      ...pairedOverrides,
    },
  };
}

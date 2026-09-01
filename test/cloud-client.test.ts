import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CloudClient, backoffMilliseconds } from "../src/cloud-client.js";
import { initializeCloudConfig, resolveCloudPaths, type CloudConfig } from "../src/cloud-config.js";

const connectorId = "00000000-0000-4000-8000-000000000011";
const commandId = "00000000-0000-4000-8000-000000000021";

describe("CloudClient", () => {
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

async function pairedConfig(): Promise<CloudConfig> {
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
    },
  };
}

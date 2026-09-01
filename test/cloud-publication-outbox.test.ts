import { existsSync } from "node:fs";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CloudPublicationOutbox } from "../src/cloud-publication-outbox.js";

const connectorId = "00000000-0000-4000-8000-000000000011";
const publicationId = "00000000-0000-4000-8000-000000000022";

describe("CloudPublicationOutbox", () => {
  it("deduplicates a durable request by idempotency key without exposing its body in status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "knot-publish-outbox-"));
    const path = join(directory, "outbox.sqlite");
    const request = {
      kind: "control" as const,
      request: {
        protocolVersion: "1.0" as const,
        connectorId,
        idempotencyKey: "knot-idempotency-0001",
        operation: { type: "publication.disable" as const, publicationId },
      },
    };
    const outbox = new CloudPublicationOutbox(path);
    const first = outbox.enqueue({
      request,
      idempotencyKey: request.request.idempotencyKey,
      requestSha256: "a".repeat(64),
      now: 10,
    });
    const duplicate = outbox.enqueue({
      request,
      idempotencyKey: request.request.idempotencyKey,
      requestSha256: "a".repeat(64),
      now: 20,
    });
    expect(duplicate.operationId).toBe(first.operationId);
    expect(duplicate).not.toHaveProperty("request");
    outbox.close();
  });

  it("keeps its directory private and does not create world-readable WAL sidecars", async () => {
    const directory = await mkdtemp(join(tmpdir(), "knot-publish-outbox-mode-"));
    await chmod(directory, 0o755);
    const path = join(directory, "outbox.sqlite");
    const outbox = new CloudPublicationOutbox(path);
    outbox.saveAssetManifest(
      [
        {
          digest: "f".repeat(64),
          path: "/private/media.png",
          fileName: "media.png",
          contentType: "image/png",
          byteSize: 10,
        },
      ],
      1,
    );
    expect((await stat(directory)).mode & 0o077).toBe(0);
    expect((await stat(path)).mode & 0o077).toBe(0);
    expect(existsSync(`${path}-wal`)).toBe(false);
    outbox.close();
  });

  it("prunes expired manifests and lets callers delete consumed manifests", () => {
    const outbox = new CloudPublicationOutbox(":memory:");
    const asset = {
      digest: "f".repeat(64),
      path: "/private/media.png",
      fileName: "media.png",
      contentType: "image/png",
      byteSize: 10,
    };
    const expired = outbox.saveAssetManifest([asset], 1);
    const fresh = outbox.saveAssetManifest([asset], 8 * 24 * 60 * 60 * 1_000 + 2);
    expect(outbox.assetManifest(expired)).toBeUndefined();
    expect(outbox.assetManifest(fresh)).toHaveLength(1);
    outbox.deleteAssetManifest(fresh);
    expect(outbox.assetManifest(fresh)).toBeUndefined();
    outbox.close();
  });

  it("refreshes a queued asset path without changing logical idempotency", () => {
    const outbox = new CloudPublicationOutbox(":memory:");
    const digest = "c".repeat(64);
    const mutation = {
      connectorId,
      siteId: "00000000-0000-4000-8000-000000000031",
      publicationId,
      slug: "notes/media",
      operation: "create" as const,
      document: {
        schemaVersion: "1.0" as const,
        title: "Media",
        blocks: [{ type: "image" as const, assetDigest: digest }],
      },
      contentSha256: "d".repeat(64),
      assetDigests: [digest],
      idempotencyKey: "knot-idempotency-relocated-asset",
    };
    const asset = {
      digest,
      path: "/private/old/media.png",
      fileName: "media.png",
      contentType: "image/png",
      byteSize: 10,
    };
    const first = outbox.enqueue({
      request: { kind: "push", mutation, assets: [asset] },
      idempotencyKey: mutation.idempotencyKey,
      requestSha256: "e".repeat(64),
      now: 1,
    });
    const second = outbox.enqueue({
      request: {
        kind: "push",
        mutation,
        assets: [{ ...asset, path: "/private/new/media.png" }],
      },
      idempotencyKey: mutation.idempotencyKey,
      requestSha256: "e".repeat(64),
      now: 2,
    });
    expect(second.operationId).toBe(first.operationId);
    expect(outbox.request(first.operationId)).toMatchObject({
      assets: [{ path: "/private/new/media.png" }],
    });
    outbox.close();
  });

  it("checkpoints retry and completion behind a lease", () => {
    const outbox = new CloudPublicationOutbox(":memory:");
    const operation = outbox.enqueue({
      request: {
        kind: "control",
        request: {
          protocolVersion: "1.0",
          connectorId,
          idempotencyKey: "knot-idempotency-0002",
          operation: { type: "publication.disable", publicationId },
        },
      },
      idempotencyKey: "knot-idempotency-0002",
      requestSha256: "b".repeat(64),
      now: 100,
    });
    expect(outbox.claim(operation.operationId, "worker-1", 100, 50)).toBe(true);
    expect(outbox.claim(operation.operationId, "worker-2", 100, 50)).toBe(false);
    outbox.fail(
      operation.operationId,
      "worker-1",
      { retryable: true, code: "offline", message: "offline", retryAfterMs: 10 },
      100,
    );
    expect(outbox.operation(operation.operationId)).toMatchObject({
      state: "retrying",
      attempt: 1,
      availableAt: 110,
    });
    expect(outbox.claim(operation.operationId, "worker-2", 109)).toBe(false);
    expect(outbox.claim(operation.operationId, "worker-2", 110)).toBe(true);
    outbox.succeed(operation.operationId, "worker-2", { state: "ready" }, 111);
    expect(outbox.operation(operation.operationId)).toMatchObject({
      state: "succeeded",
      attempt: 2,
      result: { state: "ready" },
    });
    outbox.close();
  });

  it("recovers a crashed in-flight publication and preserves its idempotency receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "knot-publish-crash-"));
    const path = join(directory, "outbox.sqlite");
    const request = {
      kind: "control" as const,
      request: {
        protocolVersion: "1.0" as const,
        connectorId,
        idempotencyKey: "knot-idempotency-crash-0001",
        operation: { type: "publication.disable" as const, publicationId },
      },
    };
    const first = new CloudPublicationOutbox(path);
    const queued = first.enqueue({
      request,
      idempotencyKey: request.request.idempotencyKey,
      requestSha256: "f".repeat(64),
      now: 1,
    });
    expect(first.claim(queued.operationId, "crashed-worker", 1, 1)).toBe(true);
    first.close();

    const recovered = new CloudPublicationOutbox(path);
    expect(recovered.operation(queued.operationId)).toMatchObject({ state: "retrying" });
    const replay = recovered.enqueue({
      request,
      idempotencyKey: request.request.idempotencyKey,
      requestSha256: "f".repeat(64),
      now: Date.now(),
    });
    expect(replay.operationId).toBe(queued.operationId);
    expect(recovered.claim(queued.operationId, "recovery-worker", Date.now())).toBe(true);
    recovered.close();
  });

  it("persists each asset boundary independently of publication delivery", () => {
    const outbox = new CloudPublicationOutbox(":memory:");
    const digest = "c".repeat(64);
    const operation = outbox.enqueue({
      request: {
        kind: "push",
        mutation: {
          connectorId,
          siteId: "00000000-0000-4000-8000-000000000031",
          publicationId,
          slug: "notes/media",
          operation: "create",
          document: {
            schemaVersion: "1.0",
            title: "Media",
            blocks: [{ type: "image", assetDigest: digest }],
          },
          contentSha256: "d".repeat(64),
          assetDigests: [digest],
          idempotencyKey: "knot-idempotency-asset-0001",
        },
        assets: [
          {
            digest,
            path: "/private/media.png",
            fileName: "media.png",
            contentType: "image/png",
            byteSize: 10,
          },
        ],
      },
      idempotencyKey: "knot-idempotency-asset-0001",
      requestSha256: "e".repeat(64),
      now: 1,
    });
    expect(outbox.assetCheckpoint(operation.operationId, digest).state).toBe("pending");
    const ids = {
      assetId: "00000000-0000-4000-8000-000000000041",
      uploadId: "00000000-0000-4000-8000-000000000042",
    };
    outbox.checkpointAsset(operation.operationId, digest, "requested", ids, 2);
    outbox.checkpointAsset(operation.operationId, digest, "uploaded", ids, 3);
    outbox.resetAssetCheckpoint(operation.operationId, digest, 4);
    expect(outbox.assetCheckpoint(operation.operationId, digest)).toEqual({
      state: "pending",
    });
    outbox.checkpointAsset(operation.operationId, digest, "requested", ids, 5);
    outbox.checkpointAsset(operation.operationId, digest, "uploaded", ids, 6);
    outbox.checkpointAsset(operation.operationId, digest, "committed", ids, 4);
    expect(outbox.assetCheckpoint(operation.operationId, digest)).toEqual({
      state: "committed",
      ...ids,
    });
    outbox.close();
  });

  it("forces only a failed operation and resets every asset checkpoint atomically", () => {
    const outbox = new CloudPublicationOutbox(":memory:");
    const digest = "f".repeat(64);
    const operation = outbox.enqueue({
      request: {
        kind: "push",
        mutation: {
          connectorId,
          siteId: "00000000-0000-4000-8000-000000000031",
          publicationId,
          slug: "notes/retry",
          operation: "create",
          document: {
            schemaVersion: "1.0",
            title: "Retry",
            blocks: [{ type: "image", assetDigest: digest }],
          },
          contentSha256: "d".repeat(64),
          assetDigests: [digest],
          idempotencyKey: "knot-idempotency-force-0001",
        },
        assets: [
          {
            digest,
            path: "/private/media.png",
            fileName: "media.png",
            contentType: "image/png",
            byteSize: 10,
          },
        ],
      },
      idempotencyKey: "knot-idempotency-force-0001",
      requestSha256: "e".repeat(64),
      now: 1,
    });
    expect(outbox.claim(operation.operationId, "worker", 2)).toBe(true);
    outbox.checkpointAsset(
      operation.operationId,
      digest,
      "uploaded",
      {
        assetId: "00000000-0000-4000-8000-000000000041",
        uploadId: "00000000-0000-4000-8000-000000000042",
      },
      3,
    );
    outbox.fail(
      operation.operationId,
      "worker",
      { retryable: false, code: "terminal", message: "failed" },
      4,
    );

    outbox.forceRetry(operation.operationId, 5);
    expect(outbox.operation(operation.operationId)).toMatchObject({
      state: "queued",
      availableAt: 5,
    });
    expect(outbox.assetCheckpoint(operation.operationId, digest)).toEqual({
      state: "pending",
    });
    expect(() => outbox.forceRetry(operation.operationId, 6)).toThrow(/failed/u);
    outbox.close();
  });
});

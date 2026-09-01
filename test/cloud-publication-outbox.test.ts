import { mkdtemp } from "node:fs/promises";
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
    outbox.checkpointAsset(operation.operationId, digest, "committed", ids, 4);
    expect(outbox.assetCheckpoint(operation.operationId, digest)).toEqual({
      state: "committed",
      ...ids,
    });
    outbox.close();
  });
});

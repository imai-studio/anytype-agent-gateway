import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CloudClient, CloudRequestError } from "../src/cloud-client.js";
import {
  initializeCloudConfig,
  resolveCloudPaths,
  saveCloudConfig,
  type CloudConfig,
} from "../src/cloud-config.js";
import {
  publicationAction,
  publicationOperationStatus,
  preparePublicationAssetManifest,
  retryPublicationOperation,
  type PublicationPolicy,
} from "../src/cloud-publication.js";
import { CloudPublicationOutbox } from "../src/cloud-publication-outbox.js";

const connectorId = "00000000-0000-4000-8000-000000000011";
const siteId = "00000000-0000-4000-8000-000000000022";
const publicationId = "00000000-0000-4000-8000-000000000033";
const versionId = "00000000-0000-4000-8000-000000000044";
const document = {
  schemaVersion: "1.0" as const,
  title: "Bounded page",
  blocks: [{ type: "paragraph" as const, content: [{ text: "Hello", marks: [] }] }],
};
const fullPolicy: PublicationPolicy = {
  allowedSiteIds: [siteId],
  allowedSlugPrefixes: ["notes/"],
  allowUpdate: true,
  allowRollback: true,
  allowDisable: true,
  allowUnpublish: true,
};

describe("local Cloud publication actions", () => {
  it("commits a typed push once and reports the durable local operation", async () => {
    const { config, configFile } = await pairedConfig();
    const client = {
      publish: vi.fn(async () => ({
        protocolVersion: "1.0",
        publicationId,
        versionId,
        state: "ready",
      })),
    } as unknown as CloudClient;
    const result = await publicationAction(
      {
        action: "push",
        configFile,
        siteId,
        publicationId,
        slug: "notes/hello",
        operation: "create",
        document,
      },
      { client: () => client, workerId: "worker" },
    );
    expect(result).toMatchObject({ state: "succeeded", publicationId, attempt: 1 });
    expect(client.publish).toHaveBeenCalledOnce();
    if (!("operationId" in result) || typeof result.operationId !== "string")
      throw new Error("Expected a local publication operation");
    const status = await publicationOperationStatus({
      configFile,
      operationId: result.operationId,
    });
    expect(status.result).toMatchObject({ versionId, state: "ready" });
    expect(config.paired?.connectorId).toBe(connectorId);
  });

  it("keeps a retryable transport failure in the durable outbox", async () => {
    const { configFile } = await pairedConfig();
    const client = {
      publish: vi.fn(async () => {
        throw new CloudRequestError("offline", {
          retryable: true,
          code: "dependency-unavailable",
          retryAfterSeconds: 5,
        });
      }),
    } as unknown as CloudClient;
    const result = await publicationAction(
      {
        action: "push",
        configFile,
        siteId,
        publicationId,
        slug: "notes/hello",
        operation: "create",
        document,
      },
      { client: () => client, workerId: "worker", now: () => 1_000 },
    );
    expect(result).toMatchObject({
      state: "retrying",
      lastErrorCode: "dependency-unavailable",
      availableAt: 6_000,
    });
  });

  it.each([401, 403])(
    "preserves retryable HTTP %i publication failures in the durable outbox",
    async (status) => {
      const { config, configFile } = await pairedConfig();
      const client = new CloudClient(config, {
        maximumAttempts: 1,
        fetch: async () =>
          Response.json(
            {
              type: "https://knot.example/problems/auth-unavailable",
              title: "Authentication temporarily unavailable",
              status,
              code: "auth-unavailable",
              requestId: "synthetic-auth-request",
              retryable: true,
              retryAfterSeconds: 5,
            },
            { status },
          ),
      });
      const result = await publicationAction(
        {
          action: "push",
          configFile,
          siteId,
          publicationId,
          slug: "notes/auth-retry",
          operation: "create",
          document,
        },
        { client: () => client, workerId: "worker", now: () => 1_000 },
      );
      expect(result).toMatchObject({
        state: "retrying",
        lastErrorCode: "auth-unavailable",
        availableAt: 6_000,
      });
      if (!("operationId" in result) || typeof result.operationId !== "string")
        throw new Error("Expected a durable publication operation");
      expect(
        await publicationOperationStatus({ configFile, operationId: result.operationId }),
      ).toMatchObject({ state: "retrying", lastErrorCode: "auth-unavailable" });
    },
  );

  it("treats a trailing slash as a local slug prefix", async () => {
    const { configFile } = await pairedConfig();
    const client = {
      publish: vi.fn(async () => ({
        protocolVersion: "1.0",
        publicationId,
        versionId,
        state: "ready",
      })),
    } as unknown as CloudClient;
    await expect(
      publicationAction(
        {
          action: "push",
          configFile,
          siteId,
          publicationId,
          slug: "notes/release",
          operation: "create",
          document,
          policy: fullPolicy,
        },
        { client: () => client, workerId: "prefix-worker" },
      ),
    ).resolves.toMatchObject({ state: "succeeded" });
    expect(client.publish).toHaveBeenCalledOnce();
  });

  it("checks status results against the local site and slug policy", async () => {
    const { configFile } = await pairedConfig();
    const publicationStatus = vi.fn(async () => ({
      protocolVersion: "1.0" as const,
      publicationId,
      siteId: "00000000-0000-4000-8000-000000000099",
      slug: "private/secret",
      state: "ready" as const,
      currentVersionId: versionId,
      updatedAt: 1,
    }));
    const client = { publicationStatus } as unknown as CloudClient;
    await expect(
      publicationAction(
        { action: "status", configFile, publicationId, policy: fullPolicy },
        { client: () => client },
      ),
    ).rejects.toThrow("outside local publication policy");
    expect(publicationStatus).toHaveBeenCalledOnce();
  });

  it("requires exact destructive confirmation and local MCP lifecycle policy", async () => {
    const { configFile } = await pairedConfig();
    const policy: PublicationPolicy = {
      allowedSiteIds: [siteId],
      allowedSlugPrefixes: ["notes/"],
      allowUpdate: false,
      allowRollback: false,
      allowDisable: false,
      allowUnpublish: true,
    };
    await expect(
      publicationAction({
        action: "unpublish",
        configFile,
        publicationId,
        confirmation: "wrong",
        policy,
      }),
    ).rejects.toThrow("confirmation equal to the publication ID");
    await expect(
      publicationAction({
        action: "rollback",
        configFile,
        publicationId,
        versionId,
        policy,
      }),
    ).rejects.toThrow("rollback is disabled");
  });

  it("issues a fresh durable intent for every repeated lifecycle command", async () => {
    const { configFile } = await pairedConfig();
    const controlPublication = vi.fn(async () => ({
      protocolVersion: "1.0" as const,
      type: "publication.disable" as const,
      publicationId,
      disabledAt: 1,
    }));
    const client = { controlPublication } as unknown as CloudClient;

    const first = await publicationAction(
      { action: "disable", configFile, publicationId },
      { client: () => client, workerId: "control-1" },
    );
    const second = await publicationAction(
      { action: "disable", configFile, publicationId },
      { client: () => client, workerId: "control-2" },
    );

    expect(first).toMatchObject({ state: "succeeded" });
    expect(second).toMatchObject({ state: "succeeded" });
    expect(controlPublication).toHaveBeenCalledTimes(2);
    expect("operationId" in first && "operationId" in second).toBe(true);
    if ("operationId" in first && "operationId" in second)
      expect(first.operationId).not.toBe(second.operationId);
  });

  it("requires an explicit force before retrying a terminal operation", async () => {
    const { configFile } = await pairedConfig();
    const publish = vi
      .fn()
      .mockRejectedValueOnce(
        new CloudRequestError("rejected", {
          retryable: false,
          code: "invalid-cloud-response",
        }),
      )
      .mockResolvedValueOnce({
        protocolVersion: "1.0",
        publicationId,
        versionId,
        state: "ready",
      });
    const client = { publish } as unknown as CloudClient;
    const failed = await publicationAction(
      {
        action: "push",
        configFile,
        siteId,
        publicationId,
        slug: "notes/forced-retry",
        operation: "create",
        document,
      },
      { client: () => client, workerId: "failure" },
    );
    if (!("operationId" in failed) || typeof failed.operationId !== "string")
      throw new Error("Expected a failed durable operation");
    expect(failed).toMatchObject({ state: "failed" });

    await expect(
      retryPublicationOperation(
        { configFile, operationId: failed.operationId },
        { client: () => client, workerId: "not-forced" },
      ),
    ).rejects.toThrow(/--force/u);
    await expect(
      retryPublicationOperation(
        { configFile, operationId: failed.operationId, force: true },
        { client: () => client, workerId: "forced" },
      ),
    ).resolves.toMatchObject({
      operationId: failed.operationId,
      state: "succeeded",
      attempt: 2,
    });
  });

  it("uploads a pre-approved bounded asset with resumable checkpoints before publishing", async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), "knot-publish-assets-"));
    const assetPath = join(assetRoot, "flower.png");
    await writeFile(assetPath, "bounded-image");
    const manifestPath = join(assetRoot, "manifest.json");
    await writeFile(manifestPath, JSON.stringify([{ path: assetPath, contentType: "image/png" }]));
    const { configFile } = await pairedConfig(assetRoot);
    const prepared = await preparePublicationAssetManifest({ configFile, manifestPath });
    const client = {
      requestAssetUpload: vi.fn(async () => ({
        protocolVersion: "1.0",
        assetId: "00000000-0000-4000-8000-000000000061",
        uploadId: "00000000-0000-4000-8000-000000000062",
        method: "PUT",
        uploadUrl: "https://uploads.example/object",
        requiredHeaders: { "content-type": "image/png" },
        expiresAt: 100,
      })),
      uploadAsset: vi.fn(async (_upload, bytes: Uint8Array) => {
        expect(Buffer.from(bytes).toString()).toBe("bounded-image");
      }),
      commitAssetUpload: vi.fn(async () => ({
        status: "verified",
        assetId: "00000000-0000-4000-8000-000000000061",
        sha256: prepared.digests[0],
        byteSize: 13,
        verifiedAt: 1,
      })),
      publish: vi.fn(async () => ({
        protocolVersion: "1.0",
        publicationId,
        versionId,
        state: "ready",
      })),
    } as unknown as CloudClient;
    const result = await publicationAction(
      {
        action: "push",
        configFile,
        siteId,
        publicationId,
        slug: "notes/media",
        operation: "create",
        assetManifestId: prepared.manifestId,
        document: {
          schemaVersion: "1.0",
          title: "Media",
          blocks: [
            { type: "image", assetDigest: prepared.digests[0]! },
            { type: "image", assetDigest: prepared.digests[0]! },
          ],
        },
      },
      { client: () => client, workerId: "asset-worker" },
    );
    expect(result).toMatchObject({ state: "succeeded" });
    expect(client.requestAssetUpload).toHaveBeenCalledOnce();
    expect(client.uploadAsset).toHaveBeenCalledOnce();
    expect(client.commitAssetUpload).toHaveBeenCalledOnce();
    expect(client.publish).toHaveBeenCalledOnce();
    const paths = resolveCloudPaths({ configFile });
    const outbox = new CloudPublicationOutbox(paths.publicationOutboxFile);
    expect(outbox.assetManifest(prepared.manifestId)).toBeUndefined();
    outbox.close();
  });

  it("re-requests an asset after an expired upload is reported missing", async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), "knot-publish-assets-expired-"));
    const assetPath = join(assetRoot, "flower.png");
    await writeFile(assetPath, "bounded-image");
    const manifestPath = join(assetRoot, "manifest.json");
    await writeFile(manifestPath, JSON.stringify([{ path: assetPath, contentType: "image/png" }]));
    const { configFile } = await pairedConfig(assetRoot);
    const prepared = await preparePublicationAssetManifest({ configFile, manifestPath });
    let request = 0;
    const client = {
      requestAssetUpload: vi.fn(async () => {
        request += 1;
        return {
          protocolVersion: "1.0",
          assetId: `00000000-0000-4000-8000-${String(60 + request).padStart(12, "0")}`,
          uploadId: `00000000-0000-4000-8000-${String(70 + request).padStart(12, "0")}`,
          method: "PUT",
          uploadUrl: "https://uploads.example/object",
          requiredHeaders: { "content-type": "image/png" },
          expiresAt: 100 + request,
        };
      }),
      uploadAsset: vi.fn(),
      commitAssetUpload: vi
        .fn()
        .mockResolvedValueOnce({
          status: "rejected",
          assetId: "00000000-0000-4000-8000-000000000061",
          reason: "upload-missing",
        })
        .mockResolvedValueOnce({
          status: "verified",
          assetId: "00000000-0000-4000-8000-000000000062",
          sha256: prepared.digests[0],
          byteSize: 13,
          verifiedAt: 1,
        }),
      publish: vi.fn(async () => ({
        protocolVersion: "1.0",
        publicationId,
        versionId,
        state: "ready",
      })),
    } as unknown as CloudClient;
    const first = await publicationAction(
      {
        action: "push",
        configFile,
        siteId,
        publicationId,
        slug: "notes/expired-media",
        operation: "create",
        assetManifestId: prepared.manifestId,
        document: {
          schemaVersion: "1.0",
          title: "Media",
          blocks: [{ type: "image", assetDigest: prepared.digests[0]! }],
        },
      },
      { client: () => client, workerId: "asset-1", now: () => 1_000 },
    );
    if (!("operationId" in first) || typeof first.operationId !== "string")
      throw new Error("Expected a retryable durable operation");
    expect(first).toMatchObject({ state: "retrying", lastErrorCode: "upload-missing" });

    await expect(
      retryPublicationOperation(
        { configFile, operationId: first.operationId },
        { client: () => client, workerId: "asset-2", now: () => 2_000 },
      ),
    ).resolves.toMatchObject({ state: "succeeded", attempt: 2 });
    expect(client.requestAssetUpload).toHaveBeenCalledTimes(2);
    expect(client.uploadAsset).toHaveBeenCalledTimes(2);
    expect(client.commitAssetUpload).toHaveBeenCalledTimes(2);
    expect(client.publish).toHaveBeenCalledOnce();
  });

  it("rejects media blocks without a matching pre-approved manifest", async () => {
    const { configFile } = await pairedConfig();
    await expect(
      publicationAction({
        action: "push",
        configFile,
        siteId,
        publicationId,
        slug: "notes/media",
        operation: "create",
        document: {
          schemaVersion: "1.0",
          title: "Media",
          blocks: [{ type: "image", assetDigest: "a".repeat(64) }],
        },
      }),
    ).rejects.toThrow("exactly match the pre-approved asset manifest");
  });

  it("rechecks configured asset roots before upload", async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), "knot-publish-assets-revoked-"));
    const assetPath = join(assetRoot, "flower.png");
    await writeFile(assetPath, "bounded-image");
    const manifestPath = join(assetRoot, "manifest.json");
    await writeFile(manifestPath, JSON.stringify([{ path: assetPath, contentType: "image/png" }]));
    const { config, configFile } = await pairedConfig(assetRoot);
    const prepared = await preparePublicationAssetManifest({ configFile, manifestPath });
    await saveCloudConfig(resolveCloudPaths({ configFile }), {
      ...config,
      publication: { ...config.publication, allowedAssetRoots: [] },
    });
    const client = { requestAssetUpload: vi.fn() } as unknown as CloudClient;
    const result = await publicationAction(
      {
        action: "push",
        configFile,
        siteId,
        publicationId,
        slug: "notes/media-revoked",
        operation: "create",
        assetManifestId: prepared.manifestId,
        document: {
          schemaVersion: "1.0",
          title: "Media",
          blocks: [{ type: "image", assetDigest: prepared.digests[0]! }],
        },
      },
      { client: () => client, workerId: "asset-worker" },
    );
    expect(result).toMatchObject({ state: "failed", lastErrorCode: "asset-changed" });
    expect(client.requestAssetUpload).not.toHaveBeenCalled();
  });
});

async function pairedConfig(
  assetRoot?: string,
): Promise<{ config: CloudConfig; configFile: string }> {
  const directory = await mkdtemp(join(tmpdir(), "knot-publish-action-"));
  const paths = resolveCloudPaths({ configFile: join(directory, "cloud.json") });
  const base = await initializeCloudConfig({
    paths,
    baseUrl: "https://knot.example",
    connectorName: "Test Mac",
    requestedScopes: ["publications.read", "publications.write", "publications.unpublish"],
    requestedSlugGrants: ["notes/*"],
    ...(assetRoot ? { allowedAssetRoots: [assetRoot] } : {}),
  });
  const config: CloudConfig = {
    ...base,
    paired: {
      connectorId,
      tenantId: "00000000-0000-4000-8000-000000000055",
      scopes: ["publications.read", "publications.write", "publications.unpublish"],
      siteIds: [siteId],
      slugGrants: ["notes/*"],
      approvedAt: 1,
    },
  };
  await saveCloudConfig(paths, config);
  return { config, configFile: paths.configFile };
}

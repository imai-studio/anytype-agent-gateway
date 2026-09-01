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
  type PublicationPolicy,
} from "../src/cloud-publication.js";

const connectorId = "00000000-0000-4000-8000-000000000011";
const siteId = "00000000-0000-4000-8000-000000000022";
const publicationId = "00000000-0000-4000-8000-000000000033";
const versionId = "00000000-0000-4000-8000-000000000044";
const document = {
  schemaVersion: "1.0" as const,
  title: "Bounded page",
  blocks: [{ type: "paragraph" as const, content: [{ text: "Hello", marks: [] }] }],
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
          blocks: [{ type: "image", assetDigest: prepared.digests[0]! }],
        },
      },
      { client: () => client, workerId: "asset-worker" },
    );
    expect(result).toMatchObject({ state: "succeeded" });
    expect(client.requestAssetUpload).toHaveBeenCalledOnce();
    expect(client.uploadAsset).toHaveBeenCalledOnce();
    expect(client.commitAssetUpload).toHaveBeenCalledOnce();
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

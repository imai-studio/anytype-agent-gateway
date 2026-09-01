import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { CloudClient, CloudRequestError } from "./cloud-client.js";
import { loadCloudConfig, resolveCloudPaths, type CloudConfig } from "./cloud-config.js";
import {
  CLOUD_PROTOCOL_VERSION,
  canonicalJson,
  publicationDocumentSchema,
  publicationMutationSchema,
  type PublicationDocument,
} from "./cloud-contract.js";
import {
  CloudPublicationOutbox,
  publicationAssetSchema,
  type PublicationAsset,
  type PublicationOperation,
  type PublicationOutboxRequest,
} from "./cloud-publication-outbox.js";

const maximumPublicationRequestBytes = 1024 * 1024;
const uuidSchema = z.uuid();
const slugSchema = publicationMutationSchema.shape.slug;

export type PublicationPolicy = {
  allowedSiteIds: string[];
  allowedSlugPrefixes: string[];
  allowUpdate: boolean;
  allowRollback: boolean;
  allowDisable: boolean;
  allowUnpublish: boolean;
};

export type PublishAction =
  | {
      action: "push";
      siteId: string;
      publicationId: string;
      slug: string;
      operation: "create" | "update";
      document: PublicationDocument;
      assetManifestId?: string;
    }
  | { action: "status"; publicationId: string }
  | { action: "rollback"; publicationId: string; versionId: string }
  | { action: "disable"; publicationId: string }
  | { action: "unpublish"; publicationId: string; confirmation: string };

export interface PublicationContext {
  client?: (config: CloudConfig) => CloudClient;
  workerId?: string;
  now?: () => number;
}

export async function readPublicationDocument(path: string): Promise<PublicationDocument> {
  const raw = path === "-" ? await readStandardInput() : await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Publication input must be valid JSON");
  }
  return publicationDocumentSchema.parse(value);
}

export async function publicationAction(
  input: PublishAction & { configFile?: string; policy?: PublicationPolicy },
  context: PublicationContext = {},
): Promise<PublicationOperation | Record<string, unknown>> {
  const paths = resolveCloudPaths({
    ...(input.configFile ? { configFile: input.configFile } : {}),
    environment: process.env,
  });
  const config = await requiredPairedConfig(paths);
  if (input.policy) assertPublicationPolicy(input, input.policy);
  if (input.action === "unpublish" && input.confirmation !== input.publicationId)
    throw new Error("Destructive unpublish requires confirmation equal to the publication ID");
  if (input.action === "status" || (input.action !== "push" && input.policy)) {
    assertServerGrant(config, "publications.read");
    const status = await (context.client?.(config) ?? new CloudClient(config)).publicationStatus(
      uuidSchema.parse(input.publicationId),
    );
    if (input.policy) assertPublicationIdentityPolicy(status, input.policy);
    if (input.action === "status") return status;
  }

  const outbox = new CloudPublicationOutbox(paths.publicationOutboxFile);
  try {
    const assets =
      input.action === "push" && input.assetManifestId
        ? outbox.assetManifest(uuidSchema.parse(input.assetManifestId))
        : [];
    if (input.action === "push" && input.assetManifestId && !assets)
      throw new Error("No pre-approved publication asset manifest has that ID");
    const request = buildOutboxRequest(config, input, assets ?? []);
    assertRequestWithinLimit(request);
    const serialized = canonicalJson(logicalPublicationRequest(request) as never);
    const requestSha256 = sha256(serialized);
    const idempotencyKey =
      request.kind === "push" ? request.mutation.idempotencyKey : request.request.idempotencyKey;
    const queued = outbox.enqueue({
      request,
      idempotencyKey,
      requestSha256,
      ...(context.now ? { now: context.now() } : {}),
    });
    if (input.action === "push" && input.assetManifestId)
      outbox.deleteAssetManifest(input.assetManifestId);
    if (queued.state === "succeeded" || queued.state === "failed") return queued;
    return await deliverPublicationOperation(outbox, queued.operationId, config, context);
  } finally {
    outbox.close();
  }
}

export async function preparePublicationAssetManifest(input: {
  configFile?: string;
  manifestPath: string;
}): Promise<{ manifestId: string; assets: number; totalBytes: number; digests: string[] }> {
  const paths = resolveCloudPaths({
    ...(input.configFile ? { configFile: input.configFile } : {}),
    environment: process.env,
  });
  const config = await requiredPairedConfig(paths);
  if (config.publication.allowedAssetRoots.length === 0)
    throw new Error(
      "Configure at least one Cloud publication asset root during `knot cloud login`",
    );
  const raw = await readFile(input.manifestPath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Asset manifest must be valid JSON");
  }
  const entries = z
    .array(
      z
        .object({
          path: z.string().min(1),
          digest: z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .optional(),
          fileName: z.string().trim().min(1).max(500).optional(),
          contentType: z.string().trim().min(3).max(200).optional(),
        })
        .strict(),
    )
    .min(1)
    .max(config.publication.maximumAssets)
    .parse(value);
  const roots = await Promise.all(
    config.publication.allowedAssetRoots.map((root) => realpath(resolve(root))),
  );
  const assets: PublicationAsset[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (!isAbsolute(entry.path)) throw new Error("Asset manifest paths must be absolute");
    const info = await lstat(entry.path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Asset manifest paths must be regular files, not symbolic links");
    const path = await realpath(entry.path);
    if (!roots.some((root) => pathWithin(root, path)))
      throw new Error("Asset manifest path is outside the configured Cloud publication roots");
    const fileInfo = await stat(path);
    if (fileInfo.size < 1 || fileInfo.size > config.publication.maximumAssetBytes)
      throw new Error("Asset exceeds the configured per-file publication limit");
    totalBytes += fileInfo.size;
    if (totalBytes > config.publication.maximumTotalAssetBytes)
      throw new Error("Asset manifest exceeds the configured total publication limit");
    const bytes = await readFile(path);
    const digest = sha256Bytes(bytes);
    if (entry.digest && entry.digest !== digest)
      throw new Error("Asset digest does not match the selected file");
    const contentType = entry.contentType ?? contentTypeFor(path);
    assertAllowedContentType(contentType);
    assets.push(
      publicationAssetSchema.parse({
        path,
        digest,
        byteSize: fileInfo.size,
        fileName: entry.fileName ?? basename(path),
        contentType,
      }),
    );
  }
  if (new Set(assets.map((asset) => asset.digest)).size !== assets.length)
    throw new Error("Asset manifest cannot contain duplicate file digests");
  const outbox = new CloudPublicationOutbox(paths.publicationOutboxFile);
  try {
    const manifestId = outbox.saveAssetManifest(assets);
    return {
      manifestId,
      assets: assets.length,
      totalBytes,
      digests: assets.map((asset) => asset.digest),
    };
  } finally {
    outbox.close();
  }
}

export async function publicationOperationStatus(input: {
  configFile?: string;
  operationId: string;
}): Promise<PublicationOperation> {
  const paths = resolveCloudPaths({
    ...(input.configFile ? { configFile: input.configFile } : {}),
    environment: process.env,
  });
  await requiredPairedConfig(paths);
  const outbox = new CloudPublicationOutbox(paths.publicationOutboxFile);
  try {
    const operation = outbox.operation(uuidSchema.parse(input.operationId));
    if (!operation) throw new Error("No local publication operation has that ID");
    return operation;
  } finally {
    outbox.close();
  }
}

export async function retryPublicationOperation(
  input: { configFile?: string; operationId: string },
  context: PublicationContext = {},
): Promise<PublicationOperation> {
  const paths = resolveCloudPaths({
    ...(input.configFile ? { configFile: input.configFile } : {}),
    environment: process.env,
  });
  const config = await requiredPairedConfig(paths);
  const outbox = new CloudPublicationOutbox(paths.publicationOutboxFile);
  try {
    const operation = outbox.operation(uuidSchema.parse(input.operationId));
    if (!operation) throw new Error("No local publication operation has that ID");
    if (operation.state === "succeeded" || operation.state === "failed") return operation;
    outbox.retryNow(operation.operationId, context.now?.() ?? Date.now());
    return await deliverPublicationOperation(outbox, operation.operationId, config, context);
  } finally {
    outbox.close();
  }
}

async function deliverPublicationOperation(
  outbox: CloudPublicationOutbox,
  operationId: string,
  config: CloudConfig,
  context: PublicationContext,
): Promise<PublicationOperation> {
  const workerId = context.workerId ?? `publish:${process.pid}:${randomUUID()}`;
  const now = context.now?.() ?? Date.now();
  if (!outbox.claim(operationId, workerId, now, 30 * 60_000))
    return requiredOperation(outbox, operationId);
  const request = outbox.request(operationId);
  if (!request) throw new Error("Publication operation request is missing");
  const client = context.client?.(config) ?? new CloudClient(config);
  try {
    if (request.kind === "push")
      for (const asset of request.assets)
        await deliverAsset(
          outbox,
          operationId,
          asset,
          request.mutation,
          config.publication.allowedAssetRoots,
          client,
          context,
        );
    const result =
      request.kind === "push"
        ? await client.publish(request.mutation)
        : await client.controlPublication(request.request);
    outbox.succeed(operationId, workerId, result, context.now?.() ?? Date.now());
  } catch (error) {
    const failure = classifyFailure(error);
    const operation = requiredOperation(outbox, operationId);
    const delay = failure.retryAfterMs ?? retryDelay(operation.attempt);
    outbox.fail(
      operationId,
      workerId,
      { ...failure, ...(failure.retryable ? { retryAfterMs: delay } : {}) },
      context.now?.() ?? Date.now(),
    );
  }
  return requiredOperation(outbox, operationId);
}

function buildOutboxRequest(
  config: CloudConfig,
  input: Exclude<PublishAction, { action: "status" }>,
  assets: PublicationAsset[],
): PublicationOutboxRequest {
  const connectorId = config.paired!.connectorId;
  if (input.action === "push") {
    assertServerGrant(config, "publications.write");
    assertSiteGrant(config, input.siteId);
    assertSlugGrant(config, input.slug);
    const document = publicationDocumentSchema.parse(input.document);
    const referencedDigests = new Set(
      document.blocks.flatMap((block) =>
        block.type === "file" || block.type === "image" ? [block.assetDigest] : [],
      ),
    );
    const manifestDigests = new Set(assets.map((asset) => asset.digest));
    if (
      referencedDigests.size !== manifestDigests.size ||
      [...referencedDigests].some((digest) => !manifestDigests.has(digest))
    )
      throw new Error("Document asset blocks must exactly match the pre-approved asset manifest");
    const payload = {
      connectorId,
      siteId: uuidSchema.parse(input.siteId),
      publicationId: uuidSchema.parse(input.publicationId),
      slug: slugSchema.parse(input.slug),
      operation: input.operation,
      document,
      contentSha256: sha256(canonicalJson(document as never)),
      assetDigests: [...manifestDigests],
    };
    const idempotencyKey = idempotencyKeyFor({ kind: "push", payload });
    return {
      kind: "push",
      mutation: publicationMutationSchema.parse({ ...payload, idempotencyKey }),
      assets,
    };
  }
  const publicationId = uuidSchema.parse(input.publicationId);
  const operation =
    input.action === "rollback"
      ? {
          type: "publication.rollback" as const,
          publicationId,
          versionId: uuidSchema.parse(input.versionId),
        }
      : input.action === "disable"
        ? { type: "publication.disable" as const, publicationId }
        : { type: "publication.unpublish" as const, publicationId };
  if (input.action === "unpublish" && input.confirmation !== publicationId)
    throw new Error("Destructive unpublish requires confirmation equal to the publication ID");
  assertServerGrant(
    config,
    input.action === "unpublish" ? "publications.unpublish" : "publications.write",
  );
  const payload = { connectorId, operation };
  return {
    kind: "control",
    request: {
      protocolVersion: CLOUD_PROTOCOL_VERSION,
      ...payload,
      idempotencyKey: idempotencyKeyFor({ kind: "control", payload }),
    },
  };
}

async function deliverAsset(
  outbox: CloudPublicationOutbox,
  operationId: string,
  asset: PublicationAsset,
  mutation: Extract<PublicationOutboxRequest, { kind: "push" }>["mutation"],
  allowedAssetRoots: string[],
  client: CloudClient,
  context: PublicationContext,
): Promise<void> {
  let checkpoint = outbox.assetCheckpoint(operationId, asset.digest);
  if (checkpoint.state === "committed") return;
  let ids =
    checkpoint.assetId && checkpoint.uploadId
      ? { assetId: checkpoint.assetId, uploadId: checkpoint.uploadId }
      : undefined;
  if (checkpoint.state === "pending" || checkpoint.state === "requested") {
    const file = await safeAssetBytes(asset, allowedAssetRoots);
    const upload = await client.requestAssetUpload({
      protocolVersion: CLOUD_PROTOCOL_VERSION,
      connectorId: mutation.connectorId,
      siteId: mutation.siteId,
      sha256: asset.digest,
      byteSize: asset.byteSize,
      contentType: asset.contentType,
      fileName: asset.fileName,
      idempotencyKey: idempotencyKeyFor({
        kind: "asset-request",
        siteId: mutation.siteId,
        digest: asset.digest,
      }),
    });
    ids = { assetId: upload.assetId, uploadId: upload.uploadId };
    outbox.checkpointAsset(
      operationId,
      asset.digest,
      "requested",
      ids,
      context.now?.() ?? Date.now(),
    );
    await client.uploadAsset(upload, file);
    outbox.checkpointAsset(
      operationId,
      asset.digest,
      "uploaded",
      ids,
      context.now?.() ?? Date.now(),
    );
    checkpoint = outbox.assetCheckpoint(operationId, asset.digest);
  }
  if (checkpoint.state === "uploaded" || checkpoint.state === "requested") {
    if (!ids) throw new Error("Publication asset upload checkpoint is incomplete");
    const result = await client.commitAssetUpload({
      ...ids,
      expectedSha256: asset.digest,
      expectedByteSize: asset.byteSize,
      idempotencyKey: idempotencyKeyFor({
        kind: "asset-commit",
        uploadId: ids.uploadId,
        digest: asset.digest,
      }),
    });
    if (result.status !== "verified")
      throw new CloudRequestError(`Asset upload was rejected: ${result.reason}`, {
        retryable: false,
        code: result.reason,
      });
    outbox.checkpointAsset(
      operationId,
      asset.digest,
      "committed",
      ids,
      context.now?.() ?? Date.now(),
    );
  }
}

async function safeAssetBytes(
  asset: PublicationAsset,
  allowedAssetRoots: string[],
): Promise<Uint8Array> {
  try {
    const roots = await Promise.all(allowedAssetRoots.map((root) => realpath(resolve(root))));
    const approvedPath = await realpath(asset.path);
    const info = await lstat(asset.path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== asset.byteSize ||
      !roots.some((root) => pathWithin(root, approvedPath))
    )
      throw new Error("asset no longer satisfies its local approval");
    const bytes = await readFile(asset.path);
    if (sha256Bytes(bytes) !== asset.digest)
      throw new Error("asset digest changed after local approval");
    return bytes;
  } catch {
    throw new CloudRequestError("Publication asset changed after manifest approval", {
      retryable: false,
      code: "asset-changed",
    });
  }
}

export function assertPublicationPolicy(input: PublishAction, policy: PublicationPolicy): void {
  if (input.action === "push") {
    if (!policy.allowedSiteIds.includes(input.siteId))
      throw new Error("The selected site is not allowed by local publication policy");
    if (!policy.allowedSlugPrefixes.some((prefix) => slugMatches(prefix, input.slug)))
      throw new Error("The publication slug is not allowed by local publication policy");
    if (input.operation === "update" && !policy.allowUpdate)
      throw new Error("Publication updates are disabled by local policy");
  } else if (input.action === "rollback" && !policy.allowRollback)
    throw new Error("Publication rollback is disabled by local policy");
  else if (input.action === "disable" && !policy.allowDisable)
    throw new Error("Publication disable is disabled by local policy");
  else if (input.action === "unpublish" && !policy.allowUnpublish)
    throw new Error("Publication unpublish is disabled by local policy");
}

function assertSiteGrant(config: CloudConfig, siteId: string): void {
  if (!config.paired?.siteIds.includes(siteId))
    throw new Error("The selected site is absent from the local pairing grant");
}

function assertSlugGrant(config: CloudConfig, slug: string): void {
  if (!config.paired?.slugGrants.some((grant) => slugMatches(grant, slug)))
    throw new Error("The publication slug is absent from the local pairing grant");
}

function slugMatches(grant: string, slug: string): boolean {
  if (grant.endsWith("*")) return slug.startsWith(grant.slice(0, -1));
  if (grant.endsWith("/")) return slug.startsWith(grant);
  return slug === grant;
}

function assertPublicationIdentityPolicy(
  status: { siteId: string; slug: string },
  policy: PublicationPolicy,
): void {
  if (!policy.allowedSiteIds.includes(status.siteId))
    throw new Error("The publication belongs to a site outside local publication policy");
  if (!policy.allowedSlugPrefixes.some((prefix) => slugMatches(prefix, status.slug)))
    throw new Error("The publication slug is outside local publication policy");
}

function logicalPublicationRequest(request: PublicationOutboxRequest): unknown {
  if (request.kind === "control") return request;
  return {
    kind: request.kind,
    mutation: request.mutation,
    assets: request.assets.map(({ path: _path, ...asset }) => asset),
  };
}

function assertServerGrant(
  config: CloudConfig,
  scope: CloudConfig["requestedScopes"][number],
): void {
  if (!config.paired?.scopes.includes(scope))
    throw new Error(`The local pairing grant does not include ${scope}`);
}

function assertRequestWithinLimit(request: PublicationOutboxRequest): void {
  const bytes = Buffer.byteLength(JSON.stringify(request));
  if (bytes > maximumPublicationRequestBytes)
    throw new Error("Publication request exceeds the 1 MiB connector request limit");
}

function idempotencyKeyFor(value: unknown): string {
  return `knot-${sha256(canonicalJson(value as never))}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function contentTypeFor(path: string): string {
  const contentType = new Map([
    [".gif", "image/gif"],
    [".jpeg", "image/jpeg"],
    [".jpg", "image/jpeg"],
    [".pdf", "application/pdf"],
    [".png", "image/png"],
    [".txt", "text/plain"],
    [".webp", "image/webp"],
  ]).get(extname(path).toLowerCase());
  if (!contentType) throw new Error("Asset type is not in the bounded publication allowlist");
  return contentType;
}

function assertAllowedContentType(value: string): void {
  if (
    ![
      "application/pdf",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
      "text/plain",
    ].includes(value.toLowerCase())
  )
    throw new Error("Asset content type is not in the bounded publication allowlist");
}

function classifyFailure(error: unknown): {
  retryable: boolean;
  code: string;
  message: string;
  retryAfterMs?: number;
} {
  if (error instanceof z.ZodError)
    return {
      retryable: false,
      code: "invalid-cloud-response",
      message: "Cloud response did not match the protocol",
    };
  if (error instanceof CloudRequestError)
    return {
      retryable: error.options.retryable,
      code: error.options.code ?? "cloud-request-failed",
      message: error.message,
      ...(error.options.retryAfterSeconds
        ? { retryAfterMs: error.options.retryAfterSeconds * 1_000 }
        : {}),
    };
  return {
    retryable: true,
    code: "transport-failed",
    message: error instanceof Error ? error.message : "Knot Cloud transport failed",
  };
}

function retryDelay(attempt: number): number {
  return Math.min(5 * 60_000, 1_000 * 2 ** Math.min(8, Math.max(0, attempt - 1)));
}

function requiredOperation(
  outbox: CloudPublicationOutbox,
  operationId: string,
): PublicationOperation {
  const operation = outbox.operation(operationId);
  if (!operation) throw new Error("Publication operation disappeared from the local outbox");
  return operation;
}

async function requiredPairedConfig(
  paths: ReturnType<typeof resolveCloudPaths>,
): Promise<CloudConfig> {
  const config = await loadCloudConfig(paths);
  if (!config?.paired) throw new Error("Pair this machine with Knot Cloud first");
  return config;
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

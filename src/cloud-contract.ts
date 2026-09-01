import { z } from "zod";

export const CLOUD_PROTOCOL_VERSION = "1.0" as const;

export const cloudScopeSchema = z.enum([
  "anytype.objects.read",
  "anytype.objects.write",
  "anytype.collections.read",
  "anytype.collections.write",
  "anytype.files.read",
  "anytype.files.write",
  "anytype.chats.read",
  "anytype.chats.send",
  "publications.read",
  "publications.write",
  "publications.unpublish",
]);

export type CloudScope = z.infer<typeof cloudScopeSchema>;

const opaqueIdSchema = z.string().trim().min(1).max(200);
const unixSecondsSchema = z.number().int().nonnegative().max(32_503_680_000);

export const protocolMetaSchema = z
  .object({
    product: z.literal("knot-cloud"),
    minimumProtocolVersion: z.string().min(1),
    maximumProtocolVersion: z.string().min(1),
    serverUnixSeconds: unixSecondsSchema,
  })
  .strict();

export const pairingCredentialsSchema = z
  .object({
    protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
    pairingId: opaqueIdSchema,
    pollToken: z.string().regex(/^[A-Za-z0-9_-]{43,200}$/u),
    authorizationUrl: z.url(),
  })
  .strict();

const pairingGrantSchema = z
  .object({
    siteIds: z.array(opaqueIdSchema).max(100),
    scopes: z.array(cloudScopeSchema).min(1),
    slugGrants: z.array(z.string().min(1).max(200)).max(100),
  })
  .strict();

export const pairingStatusSchema = z.discriminatedUnion("status", [
  z
    .object({
      protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
      status: z.literal("pending"),
      pairingId: opaqueIdSchema,
      expiresAt: unixSecondsSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
      status: z.literal("approved"),
      pairingId: opaqueIdSchema,
      connectorId: opaqueIdSchema,
      tenantId: opaqueIdSchema,
      grant: pairingGrantSchema,
      approvedAt: unixSecondsSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
      status: z.enum(["denied", "expired", "consumed"]),
      pairingId: opaqueIdSchema,
    })
    .strict(),
]);

export const problemDetailsSchema = z
  .object({
    type: z.url(),
    title: z.string().min(1).max(200),
    status: z.number().int().min(400).max(599),
    code: z.string().min(1).max(100),
    detail: z.string().max(2_000).optional(),
    requestId: z.string().min(1).max(200),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().min(1).max(86_400).optional(),
    serverUnixSeconds: unixSecondsSchema.optional(),
  })
  .strict();

const commandStateSchema = z.enum([
  "pending",
  "leased",
  "succeeded",
  "rejected-by-local-policy",
  "failed",
  "expired",
  "cancelled",
  "dead-lettered",
]);

const propertyValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string().max(100_000),
  z.array(z.string().max(2_000)).max(1_000),
  z.null(),
]);
const objectPropertiesSchema = z
  .record(z.string().max(200), propertyValueSchema)
  .refine((value) => Object.keys(value).length <= 1_000)
  .refine((value) =>
    Object.keys(value).every((key) => !["__proto__", "constructor", "prototype"].includes(key)),
  );
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const anytypeOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("object.read"), spaceId: opaqueIdSchema, objectId: opaqueIdSchema }),
  z.object({
    type: z.literal("object.query"),
    spaceId: opaqueIdSchema,
    typeKey: z.string().trim().min(1).max(200).optional(),
    text: z.string().trim().max(2_000).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    type: z.literal("object.create"),
    spaceId: opaqueIdSchema,
    typeKey: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(500),
    properties: objectPropertiesSchema.default({}),
  }),
  z.object({
    type: z.literal("object.update"),
    spaceId: opaqueIdSchema,
    objectId: opaqueIdSchema,
    properties: objectPropertiesSchema,
  }),
  z.object({
    type: z.literal("object.archive"),
    spaceId: opaqueIdSchema,
    objectId: opaqueIdSchema,
  }),
  z.object({
    type: z.literal("collection.read"),
    spaceId: opaqueIdSchema,
    collectionId: opaqueIdSchema,
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,512}$/u)
      .optional(),
  }),
  z.object({
    type: z.enum(["collection.members.add", "collection.members.remove"]),
    spaceId: opaqueIdSchema,
    collectionId: opaqueIdSchema,
    objectIds: z.array(opaqueIdSchema).min(1).max(100),
  }),
  z.object({
    type: z.literal("file.upload"),
    spaceId: opaqueIdSchema,
    assetDigest: sha256Schema,
    name: z.string().trim().min(1).max(500),
  }),
  z.object({ type: z.literal("file.download"), spaceId: opaqueIdSchema, fileId: opaqueIdSchema }),
  z.object({
    type: z.literal("file.attach"),
    spaceId: opaqueIdSchema,
    objectId: opaqueIdSchema,
    assetDigest: sha256Schema,
    name: z.string().trim().min(1).max(500),
  }),
  z.object({
    type: z.literal("chat.read"),
    spaceId: opaqueIdSchema,
    chatId: opaqueIdSchema,
    limit: z.number().int().min(1).max(100).default(50),
  }),
  z.object({
    type: z.literal("chat.send"),
    spaceId: opaqueIdSchema,
    chatId: opaqueIdSchema,
    message: z.string().min(1).max(100_000),
  }),
]);
const publicationControlOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("publication.disable"), publicationId: opaqueIdSchema }),
  z.object({
    type: z.literal("publication.rollback"),
    publicationId: opaqueIdSchema,
    versionId: opaqueIdSchema,
  }),
  z.object({ type: z.literal("publication.unpublish"), publicationId: opaqueIdSchema }),
]);
const commandPayloadSchema = z.discriminatedUnion("domain", [
  z.object({ domain: z.literal("anytype"), operation: anytypeOperationSchema }),
  z.object({ domain: z.literal("publication"), operation: publicationControlOperationSchema }),
]);

export const commandEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
    commandId: opaqueIdSchema,
    connectorId: opaqueIdSchema,
    requiredScope: cloudScopeSchema,
    createdBy: z.enum([
      "human-session",
      "connector-key",
      "consumer-api-key",
      "first-party-service",
    ]),
    createdAt: unixSecondsSchema,
    notBefore: unixSecondsSchema,
    expiresAt: unixSecondsSchema,
    attempt: z.number().int().positive(),
    leaseToken: z.string().min(32).max(200),
    leaseExpiresAt: unixSecondsSchema,
    payload: commandPayloadSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.createdAt > value.notBefore ||
      value.notBefore > value.leaseExpiresAt ||
      value.leaseExpiresAt > value.expiresAt ||
      value.expiresAt - value.createdAt > 7 * 24 * 60 * 60
    ) {
      context.addIssue({ code: "custom", message: "Command timestamps are invalid" });
    }
    const expected = requiredScope(value.payload.domain, value.payload.operation.type);
    if (value.requiredScope !== expected)
      context.addIssue({ code: "custom", message: `Command requires ${expected}` });
  });

export const commandClaimResponseSchema = z
  .object({
    protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
    commands: z.array(commandEnvelopeSchema).max(1),
    pollAfterSeconds: z.number().int().min(1).max(300),
  })
  .strict();

const provenanceSchema = z
  .object({
    kind: z.literal("connector-attested-anytype"),
    connectorId: opaqueIdSchema,
    senderDigest: sha256Schema,
    spaceId: opaqueIdSchema,
    objectId: opaqueIdSchema.optional(),
    messageId: opaqueIdSchema.optional(),
  })
  .strict();
const objectSnapshotSchema = z
  .object({
    spaceId: opaqueIdSchema,
    objectId: opaqueIdSchema,
    typeKey: z.string().trim().min(1).max(200),
    name: z.string().max(500),
    properties: objectPropertiesSchema,
    provenance: provenanceSchema,
  })
  .strict();
const objectResult = (type: "object.read" | "object.create" | "object.update") =>
  z.object({ type: z.literal(type), object: objectSnapshotSchema }).strict();
const anytypeOperationResultSchema = z.discriminatedUnion("type", [
  objectResult("object.read"),
  z
    .object({
      type: z.literal("object.query"),
      objects: z.array(objectSnapshotSchema).max(100),
      nextCursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]{16,512}$/u)
        .optional(),
    })
    .strict(),
  objectResult("object.create"),
  objectResult("object.update"),
  z
    .object({
      type: z.literal("object.archive"),
      spaceId: opaqueIdSchema,
      objectId: opaqueIdSchema,
      archived: z.literal(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("collection.read"),
      spaceId: opaqueIdSchema,
      collectionId: opaqueIdSchema,
      objectIds: z.array(opaqueIdSchema).max(100),
      nextCursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]{16,512}$/u)
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.enum(["collection.members.add", "collection.members.remove"]),
      spaceId: opaqueIdSchema,
      collectionId: opaqueIdSchema,
      objectIds: z.array(opaqueIdSchema).min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("file.upload"),
      spaceId: opaqueIdSchema,
      fileId: opaqueIdSchema,
      assetDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      type: z.literal("file.download"),
      spaceId: opaqueIdSchema,
      fileId: opaqueIdSchema,
      assetDigest: sha256Schema,
      name: z.string().trim().min(1).max(500),
      contentType: z.string().trim().min(3).max(200),
      byteSize: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("file.attach"),
      spaceId: opaqueIdSchema,
      objectId: opaqueIdSchema,
      fileId: opaqueIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("chat.read"),
      spaceId: opaqueIdSchema,
      chatId: opaqueIdSchema,
      messages: z
        .array(
          z
            .object({
              messageId: opaqueIdSchema,
              text: z.string().max(100_000),
              sentAt: unixSecondsSchema,
              senderDigest: sha256Schema,
              provenance: provenanceSchema,
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("chat.send"),
      spaceId: opaqueIdSchema,
      chatId: opaqueIdSchema,
      messageId: opaqueIdSchema,
      sentAt: unixSecondsSchema,
    })
    .strict(),
]);
const publicationControlResultSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("publication.disable"),
      publicationId: opaqueIdSchema,
      disabledAt: unixSecondsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("publication.rollback"),
      publicationId: opaqueIdSchema,
      currentVersionId: opaqueIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("publication.unpublish"),
      publicationId: opaqueIdSchema,
      unpublishedAt: unixSecondsSchema,
    })
    .strict(),
]);

export const commandResultSchema = z
  .discriminatedUnion("outcome", [
    z
      .object({
        outcome: z.literal("succeeded"),
        result: z.union([anytypeOperationResultSchema, publicationControlResultSchema]),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("rejected-by-local-policy"),
        reasonCode: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("failed"),
        retryable: z.boolean(),
        errorCode: z.string().min(1).max(200),
        retryAfterSeconds: z.number().int().min(1).max(86_400).optional(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.outcome === "failed" && value.retryAfterSeconds !== undefined && !value.retryable)
      context.addIssue({
        code: "custom",
        message: "retryAfterSeconds requires retryable to be true",
      });
  });

export const commandLeaseExtendedSchema = z
  .object({
    protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
    commandId: opaqueIdSchema,
    attempt: z.number().int().positive(),
    leaseExpiresAt: unixSecondsSchema,
  })
  .strict();

export const commandResultReceiptSchema = z
  .object({
    protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
    commandId: opaqueIdSchema,
    attempt: z.number().int().positive(),
    status: z.enum(["accepted", "duplicate"]),
    state: commandStateSchema,
  })
  .strict();

export type PairingCredentials = z.infer<typeof pairingCredentialsSchema>;
export type PairingStatus = z.infer<typeof pairingStatusSchema>;
export type CloudCommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type CloudCommandResult = z.infer<typeof commandResultSchema>;

function requiredScope(domain: "anytype" | "publication", type: string): CloudScope {
  if (domain === "publication")
    return type === "publication.unpublish" ? "publications.unpublish" : "publications.write";
  if (["object.read", "object.query"].includes(type)) return "anytype.objects.read";
  if (["object.create", "object.update", "object.archive"].includes(type))
    return "anytype.objects.write";
  if (type === "collection.read") return "anytype.collections.read";
  if (["collection.members.add", "collection.members.remove"].includes(type))
    return "anytype.collections.write";
  if (type === "file.download") return "anytype.files.read";
  if (["file.upload", "file.attach"].includes(type)) return "anytype.files.write";
  if (type === "chat.read") return "anytype.chats.read";
  return "anytype.chats.send";
}

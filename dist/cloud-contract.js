import { z } from "zod";
export const CLOUD_PROTOCOL_VERSION = "1.0";
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
    .refine((value) => Object.keys(value).every((key) => !["__proto__", "constructor", "prototype"].includes(key)));
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const uuidSchema = z.uuid();
const idempotencyKeySchema = z.string().trim().min(16).max(200);
export const maximumAssetBytes = 100 * 1024 * 1024;
const mediaTypeSchema = z
    .string()
    .trim()
    .min(3)
    .max(200)
    .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[\x20-\x7E]+)?$/u);
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
const publicationSlugSchema = z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9/_-]{0,198}[a-z0-9])?$/u)
    .refine((value) => !value.includes("//"), "Slug cannot contain consecutive slashes")
    .refine((value) => !["api", "_next", "www", "admin", "health", "assets"].includes(value.split("/")[0]), "Slug uses a reserved prefix");
export const publicationSourceProvenanceSchema = z
    .object({
    sourceType: z.enum(["anytype-object", "anytype-collection", "anytype-chat", "other"]),
    sourceDigest: sha256Schema,
    sourcePointer: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]{1,512}$/u)
        .optional(),
})
    .strict();
const publicationTextMarkSchema = z.enum(["bold", "code", "italic", "strikethrough", "underline"]);
const publicationTextSpanSchema = z
    .object({
    text: z.string().max(10_000),
    marks: z.array(publicationTextMarkSchema).max(5).default([]),
    href: z
        .url()
        .refine((value) => ["http:", "https:", "mailto:"].includes(new URL(value).protocol), {
        message: "Links must use http, https, or mailto",
    })
        .optional(),
})
    .strict();
const publicationTextContentSchema = z.array(publicationTextSpanSchema).max(1_000);
export const publicationBlockSchema = z.discriminatedUnion("type", [
    z
        .object({
        type: z.literal("heading"),
        level: z.number().int().min(1).max(6),
        content: publicationTextContentSchema,
    })
        .strict(),
    z.object({ type: z.literal("paragraph"), content: publicationTextContentSchema }).strict(),
    z.object({ type: z.literal("quote"), content: publicationTextContentSchema }).strict(),
    z
        .object({
        type: z.literal("code"),
        language: z
            .string()
            .trim()
            .regex(/^[a-z0-9+#.-]{1,30}$/u)
            .optional(),
        code: z.string().max(250_000),
    })
        .strict(),
    z
        .object({
        type: z.literal("list"),
        ordered: z.boolean(),
        items: z.array(publicationTextContentSchema).max(1_000),
    })
        .strict(),
    z
        .object({
        type: z.enum(["file", "image"]),
        assetDigest: sha256Schema,
        alt: z.string().max(2_000).optional(),
        caption: publicationTextContentSchema.optional(),
    })
        .strict(),
    z
        .object({
        type: z.literal("table"),
        rows: z.array(z.array(publicationTextContentSchema).max(100)).max(1_000),
    })
        .strict(),
]);
export const publicationDocumentSchema = z
    .object({
    schemaVersion: z.literal("1.0"),
    title: z.string().trim().min(1).max(500),
    description: z.string().max(5_000).optional(),
    blocks: z.array(publicationBlockSchema).max(10_000),
})
    .strict();
export const publicationMutationSchema = z
    .object({
    connectorId: uuidSchema,
    siteId: uuidSchema,
    publicationId: uuidSchema,
    slug: publicationSlugSchema,
    operation: z.enum(["create", "update"]),
    document: publicationDocumentSchema,
    contentSha256: sha256Schema,
    assetDigests: z.array(sha256Schema).max(1_000),
    sourceProvenance: publicationSourceProvenanceSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
})
    .strict()
    .superRefine((value, context) => {
    const declared = new Set(value.assetDigests);
    if (declared.size !== value.assetDigests.length)
        context.addIssue({
            code: "custom",
            path: ["assetDigests"],
            message: "Asset digests must be unique",
        });
    for (const [index, block] of value.document.blocks.entries())
        if ((block.type === "file" || block.type === "image") && !declared.has(block.assetDigest))
            context.addIssue({
                code: "custom",
                path: ["document", "blocks", index, "assetDigest"],
                message: "Every document asset must be declared in assetDigests",
            });
});
export const publicationCreatedSchema = z
    .object({
    protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
    publicationId: uuidSchema,
    versionId: uuidSchema,
    state: z.literal("ready"),
})
    .strict();
export const connectorPublicationStatusSchema = z
    .object({
    protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
    publicationId: uuidSchema,
    siteId: uuidSchema,
    slug: publicationSlugSchema,
    state: z.enum(["draft", "ready", "disabled", "unpublished"]),
    currentVersionId: uuidSchema.optional(),
    updatedAt: unixSecondsSchema,
})
    .strict();
export const connectorPublicationControlRequestSchema = z
    .object({
    protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
    connectorId: uuidSchema,
    idempotencyKey: idempotencyKeySchema,
    operation: z.discriminatedUnion("type", [
        z.object({ type: z.literal("publication.disable"), publicationId: uuidSchema }).strict(),
        z
            .object({
            type: z.literal("publication.rollback"),
            publicationId: uuidSchema,
            versionId: uuidSchema,
        })
            .strict(),
        z.object({ type: z.literal("publication.unpublish"), publicationId: uuidSchema }).strict(),
    ]),
})
    .strict();
export const assetUploadRequestSchema = z
    .object({
    protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
    connectorId: uuidSchema,
    siteId: uuidSchema,
    sha256: sha256Schema,
    byteSize: z.number().int().min(1).max(maximumAssetBytes),
    contentType: mediaTypeSchema,
    fileName: z.string().trim().min(1).max(500),
    idempotencyKey: idempotencyKeySchema,
})
    .strict();
export const assetUploadCreatedSchema = z
    .object({
    protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
    assetId: uuidSchema,
    uploadId: uuidSchema,
    method: z.literal("PUT"),
    uploadUrl: z.url().refine((value) => {
        const parsed = new URL(value);
        return (parsed.protocol === "https:" ||
            (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)));
    }, "Upload URL must use HTTPS or loopback HTTP"),
    requiredHeaders: z
        .record(z
        .string()
        .toLowerCase()
        .regex(/^[a-z0-9-]{1,100}$/u)
        .refine((name) => !["authorization", "cookie", "host", "proxy-authorization"].includes(name), "Upload headers cannot carry ambient credentials"), z.string().max(2_000))
        .refine((headers) => Object.keys(headers).length <= 20),
    expiresAt: unixSecondsSchema,
})
    .strict();
export const assetUploadCommitSchema = z
    .object({
    protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
    assetId: uuidSchema,
    uploadId: uuidSchema,
    expectedSha256: sha256Schema,
    expectedByteSize: z.number().int().min(1).max(maximumAssetBytes),
    idempotencyKey: idempotencyKeySchema,
})
    .strict();
export const assetUploadResultSchema = z.discriminatedUnion("status", [
    z
        .object({
        status: z.literal("verified"),
        assetId: uuidSchema,
        sha256: sha256Schema,
        byteSize: z.number().int().min(1).max(maximumAssetBytes),
        verifiedAt: unixSecondsSchema,
    })
        .strict(),
    z
        .object({
        status: z.literal("rejected"),
        assetId: uuidSchema,
        reason: z.enum(["digest-mismatch", "size-mismatch", "upload-missing"]),
    })
        .strict(),
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
    actor: z
        .object({
        principalDigest: sha256Schema,
        digestVersion: z.number().int().positive(),
        provenance: z.enum([
            "authenticated-cloud-session",
            "connector-key",
            "consumer-api-key",
            "first-party-service",
        ]),
    })
        .strict(),
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
    if (value.createdAt > value.notBefore ||
        value.notBefore > value.leaseExpiresAt ||
        value.leaseExpiresAt > value.expiresAt ||
        value.expiresAt - value.createdAt > 7 * 24 * 60 * 60) {
        context.addIssue({ code: "custom", message: "Command timestamps are invalid" });
    }
    const expected = requiredScope(value.payload.domain, value.payload.operation.type);
    if (value.requiredScope !== expected)
        context.addIssue({ code: "custom", message: `Command requires ${expected}` });
    const expectedProvenance = value.createdBy === "human-session" ? "authenticated-cloud-session" : value.createdBy;
    if (value.actor.provenance !== expectedProvenance)
        context.addIssue({ code: "custom", message: "Command actor provenance is inconsistent" });
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
const objectResult = (type) => z.object({ type: z.literal(type), object: objectSnapshotSchema }).strict();
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
            .array(z
            .object({
            messageId: opaqueIdSchema,
            text: z.string().max(100_000),
            sentAt: unixSecondsSchema,
            senderDigest: sha256Schema,
            provenance: provenanceSchema,
        })
            .strict())
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
export const publicationControlResultSchema = z.discriminatedUnion("type", [
    z
        .object({
        type: z.literal("publication.disable"),
        publicationId: uuidSchema,
        disabledAt: unixSecondsSchema,
    })
        .strict(),
    z
        .object({
        type: z.literal("publication.rollback"),
        publicationId: uuidSchema,
        currentVersionId: uuidSchema,
    })
        .strict(),
    z
        .object({
        type: z.literal("publication.unpublish"),
        publicationId: uuidSchema,
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
export function canonicalJson(value) {
    return encodeCanonicalJson(value, 0);
}
function encodeCanonicalJson(value, depth) {
    if (depth > 100)
        throw new TypeError("Canonical JSON exceeds the maximum depth");
    if (value === null || typeof value === "boolean" || typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value))
            throw new TypeError("Canonical JSON supports only safe integers");
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (Array.isArray(value))
        return `[${value.map((entry) => encodeCanonicalJson(entry, depth + 1)).join(",")}]`;
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries
        .map(([key, entry]) => `${JSON.stringify(key)}:${encodeCanonicalJson(entry, depth + 1)}`)
        .join(",")}}`;
}
function requiredScope(domain, type) {
    if (domain === "publication")
        return type === "publication.unpublish" ? "publications.unpublish" : "publications.write";
    if (["object.read", "object.query"].includes(type))
        return "anytype.objects.read";
    if (["object.create", "object.update", "object.archive"].includes(type))
        return "anytype.objects.write";
    if (type === "collection.read")
        return "anytype.collections.read";
    if (["collection.members.add", "collection.members.remove"].includes(type))
        return "anytype.collections.write";
    if (type === "file.download")
        return "anytype.files.read";
    if (["file.upload", "file.attach"].includes(type))
        return "anytype.files.write";
    if (type === "chat.read")
        return "anytype.chats.read";
    return "anytype.chats.send";
}

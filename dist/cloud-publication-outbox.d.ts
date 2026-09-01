import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { type PublicationControlRequest, type PublicationMutation } from "./cloud-contract.js";
declare const operationStateSchema: z.ZodEnum<{
    failed: "failed";
    succeeded: "succeeded";
    queued: "queued";
    "in-flight": "in-flight";
    retrying: "retrying";
}>;
export declare const publicationAssetSchema: z.ZodObject<{
    digest: z.ZodString;
    path: z.ZodString;
    fileName: z.ZodString;
    contentType: z.ZodString;
    byteSize: z.ZodNumber;
}, z.core.$strict>;
export type PublicationAsset = z.infer<typeof publicationAssetSchema>;
declare const storedRequestSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"push">;
    mutation: z.ZodObject<{
        connectorId: z.ZodUUID;
        siteId: z.ZodUUID;
        publicationId: z.ZodUUID;
        slug: z.ZodString;
        operation: z.ZodEnum<{
            create: "create";
            update: "update";
        }>;
        document: z.ZodObject<{
            schemaVersion: z.ZodLiteral<"1.0">;
            title: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            blocks: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"heading">;
                level: z.ZodNumber;
                content: z.ZodArray<z.ZodObject<{
                    text: z.ZodString;
                    marks: z.ZodDefault<z.ZodArray<z.ZodEnum<{
                        code: "code";
                        bold: "bold";
                        strikethrough: "strikethrough";
                        italic: "italic";
                        underline: "underline";
                    }>>>;
                    href: z.ZodOptional<z.ZodURL>;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                type: z.ZodLiteral<"paragraph">;
                content: z.ZodArray<z.ZodObject<{
                    text: z.ZodString;
                    marks: z.ZodDefault<z.ZodArray<z.ZodEnum<{
                        code: "code";
                        bold: "bold";
                        strikethrough: "strikethrough";
                        italic: "italic";
                        underline: "underline";
                    }>>>;
                    href: z.ZodOptional<z.ZodURL>;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                type: z.ZodLiteral<"quote">;
                content: z.ZodArray<z.ZodObject<{
                    text: z.ZodString;
                    marks: z.ZodDefault<z.ZodArray<z.ZodEnum<{
                        code: "code";
                        bold: "bold";
                        strikethrough: "strikethrough";
                        italic: "italic";
                        underline: "underline";
                    }>>>;
                    href: z.ZodOptional<z.ZodURL>;
                }, z.core.$strict>>;
            }, z.core.$strict>, z.ZodObject<{
                type: z.ZodLiteral<"code">;
                language: z.ZodOptional<z.ZodString>;
                code: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                type: z.ZodLiteral<"list">;
                ordered: z.ZodBoolean;
                items: z.ZodArray<z.ZodArray<z.ZodObject<{
                    text: z.ZodString;
                    marks: z.ZodDefault<z.ZodArray<z.ZodEnum<{
                        code: "code";
                        bold: "bold";
                        strikethrough: "strikethrough";
                        italic: "italic";
                        underline: "underline";
                    }>>>;
                    href: z.ZodOptional<z.ZodURL>;
                }, z.core.$strict>>>;
            }, z.core.$strict>, z.ZodObject<{
                type: z.ZodEnum<{
                    file: "file";
                    image: "image";
                }>;
                assetDigest: z.ZodString;
                alt: z.ZodOptional<z.ZodString>;
                caption: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    text: z.ZodString;
                    marks: z.ZodDefault<z.ZodArray<z.ZodEnum<{
                        code: "code";
                        bold: "bold";
                        strikethrough: "strikethrough";
                        italic: "italic";
                        underline: "underline";
                    }>>>;
                    href: z.ZodOptional<z.ZodURL>;
                }, z.core.$strict>>>;
            }, z.core.$strict>, z.ZodObject<{
                type: z.ZodLiteral<"table">;
                rows: z.ZodArray<z.ZodArray<z.ZodArray<z.ZodObject<{
                    text: z.ZodString;
                    marks: z.ZodDefault<z.ZodArray<z.ZodEnum<{
                        code: "code";
                        bold: "bold";
                        strikethrough: "strikethrough";
                        italic: "italic";
                        underline: "underline";
                    }>>>;
                    href: z.ZodOptional<z.ZodURL>;
                }, z.core.$strict>>>>;
            }, z.core.$strict>], "type">>;
        }, z.core.$strict>;
        contentSha256: z.ZodString;
        assetDigests: z.ZodArray<z.ZodString>;
        sourceProvenance: z.ZodOptional<z.ZodObject<{
            sourceType: z.ZodEnum<{
                "anytype-object": "anytype-object";
                "anytype-collection": "anytype-collection";
                "anytype-chat": "anytype-chat";
                other: "other";
            }>;
            sourceDigest: z.ZodString;
            sourcePointer: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        idempotencyKey: z.ZodString;
    }, z.core.$strict>;
    assets: z.ZodDefault<z.ZodArray<z.ZodObject<{
        digest: z.ZodString;
        path: z.ZodString;
        fileName: z.ZodString;
        contentType: z.ZodString;
        byteSize: z.ZodNumber;
    }, z.core.$strict>>>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"control">;
    request: z.ZodObject<{
        protocolVersion: z.ZodLiteral<"1.0">;
        connectorId: z.ZodUUID;
        idempotencyKey: z.ZodString;
        operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"publication.disable">;
            publicationId: z.ZodUUID;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"publication.rollback">;
            publicationId: z.ZodUUID;
            versionId: z.ZodUUID;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"publication.unpublish">;
            publicationId: z.ZodUUID;
        }, z.core.$strict>], "type">;
    }, z.core.$strict>;
}, z.core.$strict>], "kind">;
export type PublicationOutboxRequest = z.infer<typeof storedRequestSchema>;
export type PublicationOperationState = z.infer<typeof operationStateSchema>;
export type PublicationOperation = {
    operationId: string;
    idempotencyKey: string;
    publicationId: string;
    kind: "push" | "control";
    state: PublicationOperationState;
    attempt: number;
    availableAt: number;
    lastErrorCode?: string;
    lastError?: string;
    result?: unknown;
    createdAt: number;
    updatedAt: number;
};
export declare class CloudPublicationOutbox {
    readonly db: DatabaseSync;
    constructor(path: string);
    enqueue(input: {
        request: PublicationOutboxRequest;
        idempotencyKey: string;
        requestSha256: string;
        now?: number;
    }): PublicationOperation;
    saveAssetManifest(assets: PublicationAsset[], now?: number): string;
    assetManifest(manifestId: string): PublicationAsset[] | undefined;
    deleteAssetManifest(manifestId: string): void;
    pruneAssetManifests(createdBefore: number): number;
    assetCheckpoint(operationId: string, digest: string): {
        state: "pending" | "requested" | "uploaded" | "committed";
        assetId?: string;
        uploadId?: string;
    };
    checkpointAsset(operationId: string, digest: string, state: "requested" | "uploaded" | "committed", ids: {
        assetId: string;
        uploadId: string;
    }, now?: number): void;
    operation(operationId: string): PublicationOperation | undefined;
    request(operationId: string): PublicationOutboxRequest | undefined;
    claim(operationId: string, workerId: string, now?: number, leaseMs?: number): boolean;
    retryNow(operationId: string, now?: number): void;
    succeed(operationId: string, workerId: string, result: unknown, now?: number): void;
    fail(operationId: string, workerId: string, input: {
        retryable: boolean;
        code: string;
        message: string;
        retryAfterMs?: number;
    }, now?: number): void;
    close(): void;
    private rowByIdempotencyKey;
}
export declare function publicationRequest(request: PublicationOutboxRequest): PublicationMutation | PublicationControlRequest;
export {};

import { z } from "zod";
export declare const CLOUD_PROTOCOL_VERSION: "1.0";
export declare const cloudScopeSchema: z.ZodEnum<{
    "anytype.objects.read": "anytype.objects.read";
    "anytype.objects.write": "anytype.objects.write";
    "anytype.collections.read": "anytype.collections.read";
    "anytype.collections.write": "anytype.collections.write";
    "anytype.files.read": "anytype.files.read";
    "anytype.files.write": "anytype.files.write";
    "anytype.chats.read": "anytype.chats.read";
    "anytype.chats.send": "anytype.chats.send";
    "publications.read": "publications.read";
    "publications.write": "publications.write";
    "publications.unpublish": "publications.unpublish";
}>;
export type CloudScope = z.infer<typeof cloudScopeSchema>;
export declare const protocolMetaSchema: z.ZodObject<{
    product: z.ZodLiteral<"knot-cloud">;
    minimumProtocolVersion: z.ZodString;
    maximumProtocolVersion: z.ZodString;
    serverUnixSeconds: z.ZodNumber;
}, z.core.$strict>;
export declare const pairingCredentialsSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<"1.0">;
    pairingId: z.ZodString;
    pollToken: z.ZodString;
    authorizationUrl: z.ZodURL;
}, z.core.$strict>;
export declare const pairingStatusSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    protocolVersion: z.ZodLiteral<"1.0">;
    status: z.ZodLiteral<"pending">;
    pairingId: z.ZodString;
    expiresAt: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    protocolVersion: z.ZodLiteral<"1.0">;
    status: z.ZodLiteral<"approved">;
    pairingId: z.ZodString;
    connectorId: z.ZodString;
    tenantId: z.ZodString;
    grant: z.ZodObject<{
        siteIds: z.ZodArray<z.ZodString>;
        scopes: z.ZodArray<z.ZodEnum<{
            "anytype.objects.read": "anytype.objects.read";
            "anytype.objects.write": "anytype.objects.write";
            "anytype.collections.read": "anytype.collections.read";
            "anytype.collections.write": "anytype.collections.write";
            "anytype.files.read": "anytype.files.read";
            "anytype.files.write": "anytype.files.write";
            "anytype.chats.read": "anytype.chats.read";
            "anytype.chats.send": "anytype.chats.send";
            "publications.read": "publications.read";
            "publications.write": "publications.write";
            "publications.unpublish": "publications.unpublish";
        }>>;
        slugGrants: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    approvedAt: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    protocolVersion: z.ZodLiteral<"1.0">;
    status: z.ZodEnum<{
        denied: "denied";
        expired: "expired";
        consumed: "consumed";
    }>;
    pairingId: z.ZodString;
}, z.core.$strict>], "status">;
export declare const problemDetailsSchema: z.ZodObject<{
    type: z.ZodURL;
    title: z.ZodString;
    status: z.ZodNumber;
    code: z.ZodString;
    detail: z.ZodOptional<z.ZodString>;
    requestId: z.ZodString;
    retryable: z.ZodBoolean;
    retryAfterSeconds: z.ZodOptional<z.ZodNumber>;
    serverUnixSeconds: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const maximumAssetBytes: number;
export declare const publicationSourceProvenanceSchema: z.ZodObject<{
    sourceType: z.ZodEnum<{
        "anytype-object": "anytype-object";
        "anytype-collection": "anytype-collection";
        "anytype-chat": "anytype-chat";
        other: "other";
    }>;
    sourceDigest: z.ZodString;
    sourcePointer: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const publicationBlockSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"heading">;
    level: z.ZodNumber;
    content: z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        marks: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            code: "code";
            bold: "bold";
            italic: "italic";
            strikethrough: "strikethrough";
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
            italic: "italic";
            strikethrough: "strikethrough";
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
            italic: "italic";
            strikethrough: "strikethrough";
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
            italic: "italic";
            strikethrough: "strikethrough";
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
            italic: "italic";
            strikethrough: "strikethrough";
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
            italic: "italic";
            strikethrough: "strikethrough";
            underline: "underline";
        }>>>;
        href: z.ZodOptional<z.ZodURL>;
    }, z.core.$strict>>>>;
}, z.core.$strict>], "type">;
export declare const publicationDocumentSchema: z.ZodObject<{
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
                italic: "italic";
                strikethrough: "strikethrough";
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
                italic: "italic";
                strikethrough: "strikethrough";
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
                italic: "italic";
                strikethrough: "strikethrough";
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
                italic: "italic";
                strikethrough: "strikethrough";
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
                italic: "italic";
                strikethrough: "strikethrough";
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
                italic: "italic";
                strikethrough: "strikethrough";
                underline: "underline";
            }>>>;
            href: z.ZodOptional<z.ZodURL>;
        }, z.core.$strict>>>>;
    }, z.core.$strict>], "type">>;
}, z.core.$strict>;
export declare const publicationMutationSchema: z.ZodObject<{
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
                    italic: "italic";
                    strikethrough: "strikethrough";
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
                    italic: "italic";
                    strikethrough: "strikethrough";
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
                    italic: "italic";
                    strikethrough: "strikethrough";
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
                    italic: "italic";
                    strikethrough: "strikethrough";
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
                    italic: "italic";
                    strikethrough: "strikethrough";
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
                    italic: "italic";
                    strikethrough: "strikethrough";
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
export declare const publicationCreatedSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<"1.0">;
    publicationId: z.ZodUUID;
    versionId: z.ZodUUID;
    state: z.ZodLiteral<"ready">;
}, z.core.$strict>;
export declare const connectorPublicationStatusSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<"1.0">;
    publicationId: z.ZodUUID;
    siteId: z.ZodUUID;
    slug: z.ZodString;
    state: z.ZodEnum<{
        ready: "ready";
        draft: "draft";
        disabled: "disabled";
        unpublished: "unpublished";
    }>;
    currentVersionId: z.ZodOptional<z.ZodUUID>;
    updatedAt: z.ZodNumber;
}, z.core.$strict>;
export declare const connectorPublicationControlRequestSchema: z.ZodObject<{
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
export declare const assetUploadRequestSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<"1.0">;
    connectorId: z.ZodUUID;
    siteId: z.ZodUUID;
    sha256: z.ZodString;
    byteSize: z.ZodNumber;
    contentType: z.ZodString;
    fileName: z.ZodString;
    idempotencyKey: z.ZodString;
}, z.core.$strict>;
export declare const assetUploadCreatedSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<"1.0">;
    assetId: z.ZodUUID;
    uploadId: z.ZodUUID;
    method: z.ZodLiteral<"PUT">;
    uploadUrl: z.ZodURL;
    requiredHeaders: z.ZodRecord<z.ZodString, z.ZodString>;
    expiresAt: z.ZodNumber;
}, z.core.$strict>;
export declare const assetUploadCommitSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<"1.0">;
    assetId: z.ZodUUID;
    uploadId: z.ZodUUID;
    expectedSha256: z.ZodString;
    expectedByteSize: z.ZodNumber;
    idempotencyKey: z.ZodString;
}, z.core.$strict>;
export declare const assetUploadResultSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    status: z.ZodLiteral<"verified">;
    assetId: z.ZodUUID;
    sha256: z.ZodString;
    byteSize: z.ZodNumber;
    verifiedAt: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"rejected">;
    assetId: z.ZodUUID;
    reason: z.ZodEnum<{
        "digest-mismatch": "digest-mismatch";
        "size-mismatch": "size-mismatch";
        "upload-missing": "upload-missing";
    }>;
}, z.core.$strict>], "status">;
export declare const commandEnvelopeSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<"1.0">;
    commandId: z.ZodString;
    connectorId: z.ZodString;
    requiredScope: z.ZodEnum<{
        "anytype.objects.read": "anytype.objects.read";
        "anytype.objects.write": "anytype.objects.write";
        "anytype.collections.read": "anytype.collections.read";
        "anytype.collections.write": "anytype.collections.write";
        "anytype.files.read": "anytype.files.read";
        "anytype.files.write": "anytype.files.write";
        "anytype.chats.read": "anytype.chats.read";
        "anytype.chats.send": "anytype.chats.send";
        "publications.read": "publications.read";
        "publications.write": "publications.write";
        "publications.unpublish": "publications.unpublish";
    }>;
    createdBy: z.ZodEnum<{
        "human-session": "human-session";
        "connector-key": "connector-key";
        "consumer-api-key": "consumer-api-key";
        "first-party-service": "first-party-service";
    }>;
    actor: z.ZodObject<{
        principalDigest: z.ZodString;
        digestVersion: z.ZodNumber;
        provenance: z.ZodEnum<{
            "connector-key": "connector-key";
            "consumer-api-key": "consumer-api-key";
            "first-party-service": "first-party-service";
            "authenticated-cloud-session": "authenticated-cloud-session";
        }>;
    }, z.core.$strict>;
    createdAt: z.ZodNumber;
    notBefore: z.ZodNumber;
    expiresAt: z.ZodNumber;
    attempt: z.ZodNumber;
    leaseToken: z.ZodString;
    leaseExpiresAt: z.ZodNumber;
    payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
        domain: z.ZodLiteral<"anytype">;
        operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"object.read">;
            spaceId: z.ZodString;
            objectId: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"object.query">;
            spaceId: z.ZodString;
            typeKey: z.ZodOptional<z.ZodString>;
            text: z.ZodOptional<z.ZodString>;
            limit: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"object.create">;
            spaceId: z.ZodString;
            typeKey: z.ZodString;
            name: z.ZodString;
            properties: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodBoolean, z.ZodNumber, z.ZodString, z.ZodArray<z.ZodString>, z.ZodNull]>>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"object.update">;
            spaceId: z.ZodString;
            objectId: z.ZodString;
            properties: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodBoolean, z.ZodNumber, z.ZodString, z.ZodArray<z.ZodString>, z.ZodNull]>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"object.archive">;
            spaceId: z.ZodString;
            objectId: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"collection.read">;
            spaceId: z.ZodString;
            collectionId: z.ZodString;
            limit: z.ZodDefault<z.ZodNumber>;
            cursor: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodEnum<{
                "collection.members.add": "collection.members.add";
                "collection.members.remove": "collection.members.remove";
            }>;
            spaceId: z.ZodString;
            collectionId: z.ZodString;
            objectIds: z.ZodArray<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"file.upload">;
            spaceId: z.ZodString;
            assetDigest: z.ZodString;
            name: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"file.download">;
            spaceId: z.ZodString;
            fileId: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"file.attach">;
            spaceId: z.ZodString;
            objectId: z.ZodString;
            assetDigest: z.ZodString;
            name: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"chat.read">;
            spaceId: z.ZodString;
            chatId: z.ZodString;
            limit: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"chat.send">;
            spaceId: z.ZodString;
            chatId: z.ZodString;
            message: z.ZodString;
            channelOrigin: z.ZodObject<{
                spaceId: z.ZodString;
                chatId: z.ZodString;
                messageId: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strip>], "type">;
    }, z.core.$strip>, z.ZodObject<{
        domain: z.ZodLiteral<"publication">;
        operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"publication.disable">;
            publicationId: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"publication.rollback">;
            publicationId: z.ZodString;
            versionId: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"publication.unpublish">;
            publicationId: z.ZodString;
        }, z.core.$strip>], "type">;
    }, z.core.$strip>], "domain">;
}, z.core.$strict>;
export declare const commandClaimResponseSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<"1.0">;
    commands: z.ZodArray<z.ZodObject<{
        protocolVersion: z.ZodLiteral<"1.0">;
        commandId: z.ZodString;
        connectorId: z.ZodString;
        requiredScope: z.ZodEnum<{
            "anytype.objects.read": "anytype.objects.read";
            "anytype.objects.write": "anytype.objects.write";
            "anytype.collections.read": "anytype.collections.read";
            "anytype.collections.write": "anytype.collections.write";
            "anytype.files.read": "anytype.files.read";
            "anytype.files.write": "anytype.files.write";
            "anytype.chats.read": "anytype.chats.read";
            "anytype.chats.send": "anytype.chats.send";
            "publications.read": "publications.read";
            "publications.write": "publications.write";
            "publications.unpublish": "publications.unpublish";
        }>;
        createdBy: z.ZodEnum<{
            "human-session": "human-session";
            "connector-key": "connector-key";
            "consumer-api-key": "consumer-api-key";
            "first-party-service": "first-party-service";
        }>;
        actor: z.ZodObject<{
            principalDigest: z.ZodString;
            digestVersion: z.ZodNumber;
            provenance: z.ZodEnum<{
                "connector-key": "connector-key";
                "consumer-api-key": "consumer-api-key";
                "first-party-service": "first-party-service";
                "authenticated-cloud-session": "authenticated-cloud-session";
            }>;
        }, z.core.$strict>;
        createdAt: z.ZodNumber;
        notBefore: z.ZodNumber;
        expiresAt: z.ZodNumber;
        attempt: z.ZodNumber;
        leaseToken: z.ZodString;
        leaseExpiresAt: z.ZodNumber;
        payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
            domain: z.ZodLiteral<"anytype">;
            operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"object.read">;
                spaceId: z.ZodString;
                objectId: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"object.query">;
                spaceId: z.ZodString;
                typeKey: z.ZodOptional<z.ZodString>;
                text: z.ZodOptional<z.ZodString>;
                limit: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"object.create">;
                spaceId: z.ZodString;
                typeKey: z.ZodString;
                name: z.ZodString;
                properties: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodBoolean, z.ZodNumber, z.ZodString, z.ZodArray<z.ZodString>, z.ZodNull]>>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"object.update">;
                spaceId: z.ZodString;
                objectId: z.ZodString;
                properties: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodBoolean, z.ZodNumber, z.ZodString, z.ZodArray<z.ZodString>, z.ZodNull]>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"object.archive">;
                spaceId: z.ZodString;
                objectId: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"collection.read">;
                spaceId: z.ZodString;
                collectionId: z.ZodString;
                limit: z.ZodDefault<z.ZodNumber>;
                cursor: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodEnum<{
                    "collection.members.add": "collection.members.add";
                    "collection.members.remove": "collection.members.remove";
                }>;
                spaceId: z.ZodString;
                collectionId: z.ZodString;
                objectIds: z.ZodArray<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"file.upload">;
                spaceId: z.ZodString;
                assetDigest: z.ZodString;
                name: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"file.download">;
                spaceId: z.ZodString;
                fileId: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"file.attach">;
                spaceId: z.ZodString;
                objectId: z.ZodString;
                assetDigest: z.ZodString;
                name: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"chat.read">;
                spaceId: z.ZodString;
                chatId: z.ZodString;
                limit: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"chat.send">;
                spaceId: z.ZodString;
                chatId: z.ZodString;
                message: z.ZodString;
                channelOrigin: z.ZodObject<{
                    spaceId: z.ZodString;
                    chatId: z.ZodString;
                    messageId: z.ZodString;
                }, z.core.$strict>;
            }, z.core.$strip>], "type">;
        }, z.core.$strip>, z.ZodObject<{
            domain: z.ZodLiteral<"publication">;
            operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"publication.disable">;
                publicationId: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"publication.rollback">;
                publicationId: z.ZodString;
                versionId: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"publication.unpublish">;
                publicationId: z.ZodString;
            }, z.core.$strip>], "type">;
        }, z.core.$strip>], "domain">;
    }, z.core.$strict>>;
    pollAfterSeconds: z.ZodNumber;
}, z.core.$strict>;
export declare const publicationControlResultSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"publication.disable">;
    publicationId: z.ZodUUID;
    disabledAt: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"publication.rollback">;
    publicationId: z.ZodUUID;
    currentVersionId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"publication.unpublish">;
    publicationId: z.ZodUUID;
    unpublishedAt: z.ZodNumber;
}, z.core.$strict>], "type">;
export declare const commandResultSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    outcome: z.ZodLiteral<"succeeded">;
    result: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"object.read" | "object.create" | "object.update">;
        object: z.ZodObject<{
            spaceId: z.ZodString;
            objectId: z.ZodString;
            typeKey: z.ZodString;
            name: z.ZodString;
            properties: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodBoolean, z.ZodNumber, z.ZodString, z.ZodArray<z.ZodString>, z.ZodNull]>>;
            provenance: z.ZodObject<{
                kind: z.ZodLiteral<"connector-attested-anytype">;
                connectorId: z.ZodString;
                senderDigest: z.ZodString;
                spaceId: z.ZodString;
                objectId: z.ZodOptional<z.ZodString>;
                messageId: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"object.query">;
        objects: z.ZodArray<z.ZodObject<{
            spaceId: z.ZodString;
            objectId: z.ZodString;
            typeKey: z.ZodString;
            name: z.ZodString;
            properties: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodBoolean, z.ZodNumber, z.ZodString, z.ZodArray<z.ZodString>, z.ZodNull]>>;
            provenance: z.ZodObject<{
                kind: z.ZodLiteral<"connector-attested-anytype">;
                connectorId: z.ZodString;
                senderDigest: z.ZodString;
                spaceId: z.ZodString;
                objectId: z.ZodOptional<z.ZodString>;
                messageId: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
        }, z.core.$strict>>;
        nextCursor: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"object.read" | "object.create" | "object.update">;
        object: z.ZodObject<{
            spaceId: z.ZodString;
            objectId: z.ZodString;
            typeKey: z.ZodString;
            name: z.ZodString;
            properties: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodBoolean, z.ZodNumber, z.ZodString, z.ZodArray<z.ZodString>, z.ZodNull]>>;
            provenance: z.ZodObject<{
                kind: z.ZodLiteral<"connector-attested-anytype">;
                connectorId: z.ZodString;
                senderDigest: z.ZodString;
                spaceId: z.ZodString;
                objectId: z.ZodOptional<z.ZodString>;
                messageId: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"object.read" | "object.create" | "object.update">;
        object: z.ZodObject<{
            spaceId: z.ZodString;
            objectId: z.ZodString;
            typeKey: z.ZodString;
            name: z.ZodString;
            properties: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodBoolean, z.ZodNumber, z.ZodString, z.ZodArray<z.ZodString>, z.ZodNull]>>;
            provenance: z.ZodObject<{
                kind: z.ZodLiteral<"connector-attested-anytype">;
                connectorId: z.ZodString;
                senderDigest: z.ZodString;
                spaceId: z.ZodString;
                objectId: z.ZodOptional<z.ZodString>;
                messageId: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"object.archive">;
        spaceId: z.ZodString;
        objectId: z.ZodString;
        archived: z.ZodLiteral<true>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"collection.read">;
        spaceId: z.ZodString;
        collectionId: z.ZodString;
        objectIds: z.ZodArray<z.ZodString>;
        nextCursor: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodEnum<{
            "collection.members.add": "collection.members.add";
            "collection.members.remove": "collection.members.remove";
        }>;
        spaceId: z.ZodString;
        collectionId: z.ZodString;
        objectIds: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"file.upload">;
        spaceId: z.ZodString;
        fileId: z.ZodString;
        assetDigest: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"file.download">;
        spaceId: z.ZodString;
        fileId: z.ZodString;
        assetDigest: z.ZodString;
        name: z.ZodString;
        contentType: z.ZodString;
        byteSize: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"file.attach">;
        spaceId: z.ZodString;
        objectId: z.ZodString;
        fileId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"chat.read">;
        spaceId: z.ZodString;
        chatId: z.ZodString;
        messages: z.ZodArray<z.ZodObject<{
            messageId: z.ZodString;
            text: z.ZodString;
            sentAt: z.ZodNumber;
            senderDigest: z.ZodString;
            provenance: z.ZodObject<{
                kind: z.ZodLiteral<"connector-attested-anytype">;
                connectorId: z.ZodString;
                senderDigest: z.ZodString;
                spaceId: z.ZodString;
                objectId: z.ZodOptional<z.ZodString>;
                messageId: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"chat.send">;
        spaceId: z.ZodString;
        chatId: z.ZodString;
        messageId: z.ZodString;
        sentAt: z.ZodNumber;
    }, z.core.$strict>], "type">, z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"publication.disable">;
        publicationId: z.ZodUUID;
        disabledAt: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"publication.rollback">;
        publicationId: z.ZodUUID;
        currentVersionId: z.ZodUUID;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"publication.unpublish">;
        publicationId: z.ZodUUID;
        unpublishedAt: z.ZodNumber;
    }, z.core.$strict>], "type">]>;
}, z.core.$strict>, z.ZodObject<{
    outcome: z.ZodLiteral<"rejected-by-local-policy">;
    reasonCode: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    outcome: z.ZodLiteral<"failed">;
    retryable: z.ZodBoolean;
    errorCode: z.ZodString;
    retryAfterSeconds: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>], "outcome">;
export declare const commandLeaseExtendedSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<"1.0">;
    commandId: z.ZodString;
    attempt: z.ZodNumber;
    leaseExpiresAt: z.ZodNumber;
}, z.core.$strict>;
export declare const commandResultReceiptSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<"1.0">;
    commandId: z.ZodString;
    attempt: z.ZodNumber;
    status: z.ZodEnum<{
        accepted: "accepted";
        duplicate: "duplicate";
    }>;
    state: z.ZodEnum<{
        pending: "pending";
        expired: "expired";
        leased: "leased";
        succeeded: "succeeded";
        "rejected-by-local-policy": "rejected-by-local-policy";
        failed: "failed";
        cancelled: "cancelled";
        "dead-lettered": "dead-lettered";
    }>;
}, z.core.$strict>;
export type PairingCredentials = z.infer<typeof pairingCredentialsSchema>;
export type PairingStatus = z.infer<typeof pairingStatusSchema>;
export type CloudCommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type CloudCommandResult = z.infer<typeof commandResultSchema>;
export type PublicationDocument = z.infer<typeof publicationDocumentSchema>;
export type PublicationMutation = z.infer<typeof publicationMutationSchema>;
export type PublicationControlRequest = z.infer<typeof connectorPublicationControlRequestSchema>;
export type PublicationControlResult = z.infer<typeof publicationControlResultSchema>;
export type AssetUploadRequest = z.infer<typeof assetUploadRequestSchema>;
export type AssetUploadCreated = z.infer<typeof assetUploadCreatedSchema>;
type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | {
    [key: string]: JsonValue;
};
export declare function canonicalJson(value: JsonValue): string;
export {};

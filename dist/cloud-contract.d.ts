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
        expired: "expired";
        denied: "denied";
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
        publicationId: z.ZodString;
        disabledAt: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"publication.rollback">;
        publicationId: z.ZodString;
        currentVersionId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"publication.unpublish">;
        publicationId: z.ZodString;
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
        failed: "failed";
        pending: "pending";
        cancelled: "cancelled";
        succeeded: "succeeded";
        leased: "leased";
        expired: "expired";
        "rejected-by-local-policy": "rejected-by-local-policy";
        "dead-lettered": "dead-lettered";
    }>;
}, z.core.$strict>;
export type PairingCredentials = z.infer<typeof pairingCredentialsSchema>;
export type PairingStatus = z.infer<typeof pairingStatusSchema>;
export type CloudCommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type CloudCommandResult = z.infer<typeof commandResultSchema>;

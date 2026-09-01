import { type CloudConfig } from "./cloud-config.js";
import { type CloudCommandEnvelope, type CloudCommandResult, type PairingCredentials, type AssetUploadCreated, type AssetUploadRequest, type PublicationControlRequest, type PublicationMutation } from "./cloud-contract.js";
export declare class CloudRequestError extends Error {
    readonly options: {
        status?: number;
        code?: string;
        retryable: boolean;
        retryAfterSeconds?: number;
        serverUnixSeconds?: number;
    };
    constructor(message: string, options: {
        status?: number;
        code?: string;
        retryable: boolean;
        retryAfterSeconds?: number;
        serverUnixSeconds?: number;
    });
}
export interface CloudClientOptions {
    fetch?: typeof fetch;
    now?: () => number;
    random?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    requestTimeoutMilliseconds?: number;
    maximumAttempts?: number;
    assetUploadTimeoutMilliseconds?: number;
}
export declare class CloudClient {
    private readonly config;
    private readonly fetchImplementation;
    private readonly now;
    private readonly random;
    private readonly sleep;
    private readonly requestTimeoutMilliseconds;
    private readonly maximumAttempts;
    private readonly assetUploadTimeoutMilliseconds;
    private clockOffsetSeconds;
    constructor(config: CloudConfig, options?: CloudClientOptions);
    protocolStatus(): Promise<{
        product: "knot-cloud";
        minimumProtocolVersion: string;
        maximumProtocolVersion: string;
        serverUnixSeconds: number;
    }>;
    serverAdjustedNow(): number;
    pollPairing(credentials: PairingCredentials): Promise<{
        protocolVersion: "1.0";
        status: "pending";
        pairingId: string;
        expiresAt: number;
    } | {
        protocolVersion: "1.0";
        status: "approved";
        pairingId: string;
        connectorId: string;
        tenantId: string;
        grant: {
            siteIds: string[];
            scopes: ("anytype.objects.read" | "anytype.objects.write" | "anytype.collections.read" | "anytype.collections.write" | "anytype.files.read" | "anytype.files.write" | "anytype.chats.read" | "anytype.chats.send" | "publications.read" | "publications.write" | "publications.unpublish")[];
            slugGrants: string[];
        };
        approvedAt: number;
    } | {
        protocolVersion: "1.0";
        status: "denied" | "expired" | "consumed";
        pairingId: string;
    }>;
    claimCommands(input?: {
        leaseSeconds?: number;
    }): Promise<{
        protocolVersion: "1.0";
        commands: {
            protocolVersion: "1.0";
            commandId: string;
            connectorId: string;
            requiredScope: "anytype.objects.read" | "anytype.objects.write" | "anytype.collections.read" | "anytype.collections.write" | "anytype.files.read" | "anytype.files.write" | "anytype.chats.read" | "anytype.chats.send" | "publications.read" | "publications.write" | "publications.unpublish";
            createdBy: "human-session" | "connector-key" | "consumer-api-key" | "first-party-service";
            actor: {
                principalDigest: string;
                digestVersion: number;
                provenance: "connector-key" | "consumer-api-key" | "first-party-service" | "authenticated-cloud-session";
            };
            createdAt: number;
            notBefore: number;
            expiresAt: number;
            attempt: number;
            leaseToken: string;
            leaseExpiresAt: number;
            payload: {
                domain: "anytype";
                operation: {
                    type: "object.read";
                    spaceId: string;
                    objectId: string;
                } | {
                    type: "object.query";
                    spaceId: string;
                    limit: number;
                    typeKey?: string | undefined;
                    text?: string | undefined;
                } | {
                    type: "object.create";
                    spaceId: string;
                    typeKey: string;
                    name: string;
                    properties: Record<string, string | number | boolean | string[] | null>;
                } | {
                    type: "object.update";
                    spaceId: string;
                    objectId: string;
                    properties: Record<string, string | number | boolean | string[] | null>;
                } | {
                    type: "object.archive";
                    spaceId: string;
                    objectId: string;
                } | {
                    type: "collection.read";
                    spaceId: string;
                    collectionId: string;
                    limit: number;
                    cursor?: string | undefined;
                } | {
                    type: "collection.members.add" | "collection.members.remove";
                    spaceId: string;
                    collectionId: string;
                    objectIds: string[];
                } | {
                    type: "file.upload";
                    spaceId: string;
                    assetDigest: string;
                    name: string;
                } | {
                    type: "file.download";
                    spaceId: string;
                    fileId: string;
                } | {
                    type: "file.attach";
                    spaceId: string;
                    objectId: string;
                    assetDigest: string;
                    name: string;
                } | {
                    type: "chat.read";
                    spaceId: string;
                    chatId: string;
                    limit: number;
                } | {
                    type: "chat.send";
                    spaceId: string;
                    chatId: string;
                    message: string;
                };
            } | {
                domain: "publication";
                operation: {
                    type: "publication.disable";
                    publicationId: string;
                } | {
                    type: "publication.rollback";
                    publicationId: string;
                    versionId: string;
                } | {
                    type: "publication.unpublish";
                    publicationId: string;
                };
            };
        }[];
        pollAfterSeconds: number;
    }>;
    extendLease(command: CloudCommandEnvelope, extendBySeconds?: number): Promise<{
        protocolVersion: "1.0";
        commandId: string;
        attempt: number;
        leaseExpiresAt: number;
    }>;
    submitResult(command: CloudCommandEnvelope, result: CloudCommandResult): Promise<{
        protocolVersion: "1.0";
        commandId: string;
        attempt: number;
        status: "accepted" | "duplicate";
        state: "pending" | "expired" | "leased" | "succeeded" | "rejected-by-local-policy" | "failed" | "cancelled" | "dead-lettered";
    }>;
    rejectByLocalPolicy(command: CloudCommandEnvelope, reasonCode: string): Promise<{
        protocolVersion: "1.0";
        commandId: string;
        attempt: number;
        status: "accepted" | "duplicate";
        state: "pending" | "expired" | "leased" | "succeeded" | "rejected-by-local-policy" | "failed" | "cancelled" | "dead-lettered";
    }>;
    publish(mutation: PublicationMutation): Promise<{
        protocolVersion: "1.0";
        publicationId: string;
        versionId: string;
        state: "ready";
    }>;
    requestAssetUpload(input: AssetUploadRequest): Promise<{
        protocolVersion: "1.0";
        assetId: string;
        uploadId: string;
        method: "PUT";
        uploadUrl: string;
        requiredHeaders: Record<string, string>;
        expiresAt: number;
    }>;
    uploadAsset(upload: AssetUploadCreated, bytes: Uint8Array): Promise<void>;
    commitAssetUpload(input: {
        assetId: string;
        uploadId: string;
        expectedSha256: string;
        expectedByteSize: number;
        idempotencyKey: string;
    }): Promise<{
        status: "verified";
        assetId: string;
        sha256: string;
        byteSize: number;
        verifiedAt: number;
    } | {
        status: "rejected";
        assetId: string;
        reason: "digest-mismatch" | "size-mismatch" | "upload-missing";
    }>;
    publicationStatus(publicationId: string): Promise<{
        protocolVersion: "1.0";
        publicationId: string;
        siteId: string;
        slug: string;
        state: "ready" | "draft" | "disabled" | "unpublished";
        updatedAt: number;
        currentVersionId?: string | undefined;
    }>;
    controlPublication(input: PublicationControlRequest): Promise<{
        type: "publication.disable";
        publicationId: string;
        disabledAt: number;
    } | {
        type: "publication.rollback";
        publicationId: string;
        currentVersionId: string;
    } | {
        type: "publication.unpublish";
        publicationId: string;
        unpublishedAt: number;
    }>;
    private pairedConnectorId;
    private assertCommandConnector;
    private assertGranted;
    private request;
    private signedHeaders;
}
export declare function normalizeAuthority(value: string): string;
export declare function backoffMilliseconds(attempt: number, random?: () => number, retryAfterSeconds?: number): number;

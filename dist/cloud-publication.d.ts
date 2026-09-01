import { CloudClient } from "./cloud-client.js";
import { type CloudConfig } from "./cloud-config.js";
import { type PublicationDocument } from "./cloud-contract.js";
import { type PublicationOperation } from "./cloud-publication-outbox.js";
export type PublicationPolicy = {
    allowedSiteIds: string[];
    allowedSlugPrefixes: string[];
    allowUpdate: boolean;
    allowRollback: boolean;
    allowDisable: boolean;
    allowUnpublish: boolean;
};
export type PublishAction = {
    action: "push";
    siteId: string;
    publicationId: string;
    slug: string;
    operation: "create" | "update";
    document: PublicationDocument;
    assetManifestId?: string;
} | {
    action: "status";
    publicationId: string;
} | {
    action: "rollback";
    publicationId: string;
    versionId: string;
} | {
    action: "disable";
    publicationId: string;
} | {
    action: "unpublish";
    publicationId: string;
    confirmation: string;
};
export interface PublicationContext {
    client?: (config: CloudConfig) => CloudClient;
    workerId?: string;
    now?: () => number;
}
export declare function readPublicationDocument(path: string): Promise<PublicationDocument>;
export declare function publicationAction(input: PublishAction & {
    configFile?: string;
    policy?: PublicationPolicy;
}, context?: PublicationContext): Promise<PublicationOperation | Record<string, unknown>>;
export declare function preparePublicationAssetManifest(input: {
    configFile?: string;
    manifestPath: string;
}): Promise<{
    manifestId: string;
    assets: number;
    totalBytes: number;
    digests: string[];
}>;
export declare function publicationOperationStatus(input: {
    configFile?: string;
    operationId: string;
}): Promise<PublicationOperation>;
export declare function retryPublicationOperation(input: {
    configFile?: string;
    operationId: string;
    force?: boolean;
}, context?: PublicationContext): Promise<PublicationOperation>;
export declare function assertPublicationPolicy(input: PublishAction, policy: PublicationPolicy): void;

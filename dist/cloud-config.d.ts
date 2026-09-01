import { z } from "zod";
import { type PairingCredentials } from "./cloud-contract.js";
export declare const cloudConfigSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    baseUrl: z.ZodURL;
    connectorName: z.ZodString;
    protocolVersion: z.ZodLiteral<"1.0">;
    publicKey: z.ZodString;
    privateKeyFile: z.ZodString;
    requestedScopes: z.ZodArray<z.ZodEnum<{
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
    requestedSlugGrants: z.ZodArray<z.ZodString>;
    publication: z.ZodDefault<z.ZodObject<{
        allowedAssetRoots: z.ZodDefault<z.ZodArray<z.ZodString>>;
        maximumAssets: z.ZodDefault<z.ZodNumber>;
        maximumAssetBytes: z.ZodDefault<z.ZodNumber>;
        maximumTotalAssetBytes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    paired: z.ZodOptional<z.ZodObject<{
        connectorId: z.ZodString;
        tenantId: z.ZodString;
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
        siteIds: z.ZodArray<z.ZodString>;
        slugGrants: z.ZodArray<z.ZodString>;
        approvedAt: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type CloudConfig = z.infer<typeof cloudConfigSchema>;
export interface CloudPaths {
    configFile: string;
    privateKeyFile: string;
    pairingFile: string;
    publicationOutboxFile: string;
}
export declare function resolveCloudPaths(options?: {
    configFile?: string;
    environment?: NodeJS.ProcessEnv;
    home?: string;
}): CloudPaths;
export declare function normalizeCloudBaseUrl(value: string): string;
export declare function initializeCloudConfig(input: {
    paths: CloudPaths;
    baseUrl: string;
    connectorName: string;
    requestedScopes: CloudConfig["requestedScopes"];
    requestedSlugGrants?: string[];
    allowedAssetRoots?: string[];
}): Promise<CloudConfig>;
export declare function loadCloudConfig(paths: CloudPaths, required?: boolean): Promise<CloudConfig | undefined>;
export declare function saveCloudConfig(paths: CloudPaths, config: CloudConfig): Promise<void>;
export declare function savePairingCredentials(paths: CloudPaths, credentials: PairingCredentials): Promise<void>;
export declare function loadPairingCredentials(paths: CloudPaths): Promise<PairingCredentials>;
export declare function removePairingCredentials(paths: CloudPaths): Promise<void>;
export declare function forgetCloudIdentity(paths: CloudPaths): Promise<void>;
export declare function validateCloudKey(config: CloudConfig): Promise<void>;
export declare function cloudFileMode(path: string): Promise<number>;

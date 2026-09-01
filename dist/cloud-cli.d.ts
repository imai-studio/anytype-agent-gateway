import { CloudClient } from "./cloud-client.js";
import { type CloudConfig } from "./cloud-config.js";
import { type CloudScope } from "./cloud-contract.js";
export declare const DEFAULT_CLOUD_URL = "https://knot.imai.tech";
export declare const DEFAULT_CLOUD_SCOPES: CloudScope[];
interface CloudCommandContext {
    output?: (line: string) => void;
    sleep?: (milliseconds: number) => Promise<void>;
    client?: (config: CloudConfig) => CloudClient;
}
export declare function cloudLogin(input: {
    configFile?: string;
    baseUrl?: string;
    connectorName?: string;
    scopes?: string[];
    slugGrants?: string[];
}, context?: CloudCommandContext): Promise<CloudConfig>;
export declare function cloudPair(input: {
    configFile?: string;
    credentialsFile?: string;
    once?: boolean;
    timeoutSeconds?: number;
}, context?: CloudCommandContext): Promise<"approved" | "pending">;
export declare function cloudStatus(input: {
    configFile?: string;
    json?: boolean;
}, context?: CloudCommandContext): Promise<Record<string, unknown>>;
export declare function cloudDoctor(input: {
    configFile?: string;
}, context?: CloudCommandContext): Promise<void>;
export declare function cloudRevoke(input: {
    configFile?: string;
    forgetLocal?: boolean;
}, context?: CloudCommandContext): Promise<void>;
export {};

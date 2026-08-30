export declare const PRODUCT: {
    readonly current: {
        readonly name: "Anytype Agent Gateway";
        readonly shortName: "AAG";
        readonly executable: "aag";
        readonly packageName: "@imai/aag";
    };
    readonly next: {
        readonly name: "Knot";
        readonly shortName: "Knot";
        readonly executable: "knot";
        readonly packageName: "@imai/knot";
    };
    readonly executables: readonly ["aag", "knot"];
    readonly heartBinaries: readonly ["aag-heart-adapter", "knot-heart-adapter"];
    readonly services: {
        readonly linux: readonly ["anytype-agent-gateway.service", "knot.service"];
        readonly darwin: readonly ["com.anytype.anytype-agent-gateway", "com.imai.knot"];
    };
    readonly logs: {
        readonly current: "AnytypeAgentGateway";
        readonly next: "Knot";
    };
};
type Environment = Record<string, string | undefined>;
type Normalizer = (value: string) => string;
export declare function resetCompatibilityWarningsForTests(): void;
export declare function resolveProductEnvironment(suffix: string, options?: {
    environment?: Environment;
    normalize?: Normalizer;
    warn?: (message: string) => void;
}): string | undefined;
export declare function resolveEnvironmentPair(preferredName: string, legacyName: string, options?: {
    environment?: Environment;
    normalize?: Normalizer;
    warn?: (message: string) => void;
}): string | undefined;
export declare function resolveConfigPath(options?: {
    explicit?: string;
    environment?: Environment;
    home?: string;
    warn?: (message: string) => void;
}): string;
export declare function resolveStatePath(options?: {
    explicit?: string;
    environment?: Environment;
    home?: string;
    warn?: (message: string) => void;
}): string;
export declare function resolveHeartBinary(configured?: string, exists?: (command: string) => Promise<boolean>): Promise<string>;
export type ServiceInstallation = {
    generation: "aag" | "knot";
    identity: string;
    installed: boolean;
};
export declare function detectServices(platform: "linux" | "darwin", exists: (identity: string) => Promise<boolean>): Promise<ServiceInstallation[]>;
export declare function logNamespace(generation?: "aag" | "knot"): string;
export {};

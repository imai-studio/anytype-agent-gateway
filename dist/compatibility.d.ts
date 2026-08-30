export declare const PRODUCT: {
    readonly current: {
        readonly name: "Knot";
        readonly shortName: "Knot";
        readonly executable: "knot";
        readonly packageName: "@imai/knot";
    };
    readonly legacy: {
        readonly name: "Anytype Agent Gateway";
        readonly shortName: "AAG";
        readonly executable: "aag";
        readonly packageName: "@imai/aag";
    };
    readonly executables: readonly ["knot", "aag"];
    readonly heartBinaries: readonly ["knot-heart-adapter", "aag-heart-adapter"];
    readonly services: {
        readonly linux: {
            readonly legacy: "anytype-agent-gateway.service";
            readonly current: "knot.service";
        };
        readonly darwin: {
            readonly legacy: "com.anytype.anytype-agent-gateway";
            readonly current: "com.imai.knot";
        };
    };
    readonly logs: {
        readonly current: "Knot";
        readonly legacy: "AnytypeAgentGateway";
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

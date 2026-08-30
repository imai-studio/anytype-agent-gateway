export type MigrationItem = {
    kind: "config" | "state" | "support" | "logs";
    source: string;
    destination: string;
    status: "missing" | "copy" | "verified";
};
export type MigrationResult = {
    version: 1;
    dryRun: boolean;
    state: "planned" | "complete";
    items: MigrationItem[];
    manifest?: string;
    rollback: string[];
};
export declare function migrationPaths(home?: string, legacyStatePath?: string, legacyConfigPath?: string): MigrationItem[];
export declare function migrateInstallation(options?: {
    home?: string;
    legacyConfigPath?: string;
    dryRun?: boolean;
    now?: Date;
    interruptAfterCopies?: number;
}): Promise<MigrationResult>;
export declare function latestMigrationManifest(home?: string, expectedConfigSource?: string): Promise<MigrationResult | undefined>;
export declare function resolveLegacyConfigSource(home?: string, requested?: string): Promise<string>;

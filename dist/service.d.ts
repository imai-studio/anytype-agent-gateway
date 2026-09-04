import { type MigrationResult } from "./migration.js";
export declare const systemdServiceName: "knot.service";
export declare const launchdServiceLabel: "com.imai.knot";
interface LaunchdPlistOptions {
    nodePath: string;
    cliPath: string;
    configPath: string;
    stdoutPath: string;
    stderrPath: string;
    pathEnvironment: string;
    codexAppToolsPipePath?: string;
    codexMcpNodePath?: string;
    dependencyLabel?: string;
}
export declare function installService(configPath: string): Promise<void>;
export declare function serviceCommand(command: "status" | "restart" | "stop" | "logs"): Promise<void>;
export type ManagedServiceState = {
    defined: boolean;
    enabled: boolean;
    running: boolean;
};
export interface ServiceMigrationManager {
    inspect(generation: "aag" | "knot"): Promise<ManagedServiceState>;
    stopAndDisableLegacy(): Promise<void>;
    backupLegacy(stamp: string): Promise<string>;
    installCurrent(configPath: string): Promise<void>;
    stopAndDisableCurrent(): Promise<void>;
    restoreLegacy(backup: string): Promise<void>;
    findLegacyBackup?(): Promise<string | undefined>;
}
export type ServiceMigrationResult = {
    migration: MigrationResult;
    phases: string[];
    legacyBackup?: string;
    rollback: string[];
};
export declare function migrateService(options?: {
    home?: string;
    legacyConfigPath?: string;
    dryRun?: boolean;
    manager?: ServiceMigrationManager;
    now?: Date;
}): Promise<ServiceMigrationResult>;
export declare function serviceRollbackCommands(platform?: NodeJS.Platform): string[];
export declare function resolveInstalledService(platform: "linux" | "darwin", home: string): Promise<{
    generation: "aag" | "knot";
    identity: string;
} | undefined>;
export declare function buildLaunchdPlist(options: LaunchdPlistOptions): string;
export declare function buildSystemdUnit(input: {
    nodePath: string;
    cliPath: string;
    configPath: string;
    pathEnvironment: string;
    localAnytype: boolean;
}): string;
export {};

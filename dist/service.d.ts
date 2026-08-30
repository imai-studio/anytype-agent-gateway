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
export declare function resolveInstalledService(platform: "linux" | "darwin", home: string): Promise<{
    generation: "aag" | "knot";
    identity: string;
} | undefined>;
export declare function buildLaunchdPlist(options: LaunchdPlistOptions): string;
export {};

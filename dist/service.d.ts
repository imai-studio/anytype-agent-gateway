interface LaunchdPlistOptions {
    nodePath: string;
    cliPath: string;
    configPath: string;
    stdoutPath: string;
    stderrPath: string;
    pathEnvironment: string;
    dependencyLabel?: string;
}
export declare function installService(configPath: string): Promise<void>;
export declare function serviceCommand(command: "status" | "restart" | "stop" | "logs"): Promise<void>;
export declare function buildLaunchdPlist(options: LaunchdPlistOptions): string;
export {};

import { type SpawnOptions } from "node:child_process";
export declare class ProcessTimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(timeoutMs: number);
}
export declare function runProcess(command: string, args: string[], options?: SpawnOptions & {
    stdin?: string;
    timeoutMs?: number;
}): Promise<{
    stdout: string;
    stderr: string;
}>;
export declare function commandExists(command: string): Promise<boolean>;

export declare function compatibleProcessLockPaths(statePath: string): string[];
export declare function acquireCompatibleProcessLocks(statePath: string, options?: Parameters<typeof acquireProcessLock>[1]): Promise<() => Promise<void>>;
type ProcessProbe = (pid: number, signal: 0) => void;
export declare function acquireProcessLock(path: string, options?: {
    pid?: number;
    probe?: ProcessProbe;
    attempts?: number;
    waitMilliseconds?: number;
    contentionMessage?: (pid: number) => string;
}): Promise<() => Promise<void>>;
export {};

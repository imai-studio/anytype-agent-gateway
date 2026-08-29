type ProcessProbe = (pid: number, signal: 0) => void;
export declare function acquireProcessLock(path: string, options?: {
    pid?: number;
    probe?: ProcessProbe;
    attempts?: number;
    waitMilliseconds?: number;
    contentionMessage?: (pid: number) => string;
}): Promise<() => Promise<void>>;
export {};

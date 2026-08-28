import type { AgentConfig } from "./config.js";
import { HeartDiscussionAdapter } from "./discussions.js";
import { Store } from "./store.js";
import type { AnytypePort, RuntimeDriver } from "./types.js";
export declare class Gateway {
    private readonly anytype;
    private readonly config;
    private readonly store;
    private readonly discussions;
    private readonly log;
    private readonly abort;
    private readonly routeIds;
    private readonly tasks;
    private readonly controller;
    private readonly terminal;
    private resolveTerminal;
    private rejectTerminal;
    constructor(anytype: AnytypePort, runtime: RuntimeDriver, config: AgentConfig, store: Store, discussions: HeartDiscussionAdapter, log: (event: string, fields?: Record<string, unknown>) => void);
    start(): Promise<void>;
    stop(): void;
    private addRoute;
    private track;
    private runRoute;
    private reconcileInterruptedRuns;
    private discoverDiscussions;
}

import type { AgentConfig } from "../config.js";
import { Store } from "../store.js";
import type { AnytypePort } from "../types.js";
import type { WorkflowVersionRecord } from "./store-types.js";
import type { WorkflowSourceResolver, WorkflowSourceSnapshot } from "./runner.js";
type ObserverConfig = AgentConfig["automation"];
export type WorkflowObserverScanResult = {
    spaceId: string;
    objects: number;
    changes: number;
    archived: number;
    failed: boolean;
    nextScanAt: number;
};
export declare class WorkflowObserver {
    private readonly anytype;
    private readonly store;
    private readonly config;
    private readonly log;
    private readonly now;
    private readonly random;
    private cursor;
    constructor(anytype: AnytypePort, store: Store, config: ObserverConfig, log: (event: string, fields?: Record<string, unknown>) => void, now?: () => number, random?: () => number);
    run(signal: AbortSignal): Promise<void>;
    scanSpaceOnce(spaceId: string): Promise<WorkflowObserverScanResult>;
    private state;
    private observeObject;
    private observeReadFailure;
    private archiveMissing;
    private recordEvent;
}
/** Refetches redacted workflow source from Anytype before an effect is allowed to run. */
export declare class AnytypeWorkflowSourceResolver implements WorkflowSourceResolver {
    private readonly anytype;
    private readonly definitionTypeKeys;
    private readonly pageSize;
    constructor(anytype: AnytypePort, definitionTypeKeys: string[], pageSize?: number);
    refetch(version: WorkflowVersionRecord, signal: AbortSignal): Promise<WorkflowSourceSnapshot | undefined>;
}
export declare function extractWorkflowSource(source: string | undefined): string;
export {};

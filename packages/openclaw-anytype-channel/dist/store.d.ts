import { type AnytypeRoute, type BridgeDelivery, type BridgeInbound, type StoredDelivery } from "./protocol.js";
export declare class BridgeStore {
    #private;
    constructor(path: string);
    close(): void;
    putInbound(message: BridgeInbound, now?: number): boolean;
    pendingInbound(limit?: number): BridgeInbound[];
    markInbound(id: string, status: "delivered" | "failed", error?: string, now?: number): void;
    inboundStatus(id: string): {
        status: string;
        lastError?: string;
    } | undefined;
    bindSession(sessionKey: string, accountId: string, route: AnytypeRoute, now?: number): void;
    bindingForSession(sessionKey: string): {
        accountId: string;
        route: AnytypeRoute;
    } | undefined;
    markOwnedRun(runId: string, now?: number): void;
    isOwnedRun(runId: string): boolean;
    pruneOwnedRuns(before: number): number;
    putDelivery(delivery: BridgeDelivery, now?: number): boolean;
    pendingDeliveries(now?: number, limit?: number, afterSequence?: number): StoredDelivery[];
    pendingDeliveriesFor(filter: {
        sessionKey: string;
        route: AnytypeRoute;
    }, now?: number, limit?: number, afterSequence?: number): StoredDelivery[];
    compactDelivered(before: number): number;
    pruneExpiredThinking(before: number): number;
    acknowledgeDelivery(id: string, now?: number): void;
    acknowledgeDeliveries(ids: string[], now?: number): void;
    retryDelivery(id: string, error: string, now?: number): void;
}
//# sourceMappingURL=store.d.ts.map
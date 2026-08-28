import { type BridgeDelivery, type BridgeInbound } from "./protocol.js";
import { BridgeStore } from "./store.js";
export type BridgeServerOptions = {
    host: string;
    port: number;
    token: string;
    store: BridgeStore;
    onInbound: (message: BridgeInbound) => Promise<void>;
    log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
};
export declare class BridgeServer {
    #private;
    constructor(options: BridgeServerOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    address(): {
        address: string;
        port: number;
    } | undefined;
    drainInbound(): Promise<void>;
}
export type DeliveryWorkerOptions = {
    store: BridgeStore;
    endpoint?: string;
    token: string;
    intervalMs?: number;
    fetch?: typeof fetch;
    log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
};
export declare class DeliveryWorker {
    #private;
    constructor(options: DeliveryWorkerOptions);
    start(): void;
    stop(): void;
    flush(): Promise<void>;
}
export declare function createDelivery(value: Omit<BridgeDelivery, "id" | "idempotencyKey" | "createdAt"> & {
    sourceKey: string;
    createdAt?: number;
}): BridgeDelivery;
//# sourceMappingURL=bridge.d.ts.map
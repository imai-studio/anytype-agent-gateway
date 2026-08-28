import { type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { BridgeServer } from "./bridge.js";
import { type CoreConfig, type ResolvedAnytypeAccount } from "./config.js";
import type { AnytypeRoute } from "./protocol.js";
import { BridgeStore } from "./store.js";
type AccountRuntime = {
    account: ResolvedAnytypeAccount;
    store: BridgeStore;
    server: BridgeServer;
    pruneTimer: NodeJS.Timeout;
};
export declare class AnytypeChannelRuntime {
    #private;
    constructor(api: OpenClawPluginApi);
    runtimeFor(cfg: CoreConfig, accountId?: string | null): AccountRuntime;
    startAccount(cfg: CoreConfig, accountId?: string | null): Promise<AccountRuntime>;
    stopAccount(accountId: string): Promise<void>;
    stopAll(): Promise<void>;
    enqueueFinal(params: {
        cfg: CoreConfig;
        accountId?: string | null;
        route: AnytypeRoute;
        text: string;
        replyToId?: string;
        sessionKey?: string;
        sourceKey?: string;
    }): string;
    observeAgentEvent(event: {
        runId: string;
        seq: number;
        stream: string;
        ts: number;
        data: Record<string, unknown>;
        sessionKey?: string;
    }): void;
}
declare const _default: {
    id: string;
    name: string;
    description: string;
    configSchema: import("openclaw/plugin-sdk").ChannelConfigSchema;
    register: (api: import("openclaw/plugin-sdk").OpenClawPluginApi) => void;
    channelPlugin: import("openclaw/plugin-sdk/core").ChannelPlugin<ResolvedAnytypeAccount>;
    setChannelRuntime?: (runtime: import("openclaw/plugin-sdk/core").PluginRuntime) => void;
};
export default _default;
export { BridgeServer, DeliveryWorker, createDelivery } from "./bridge.js";
export { encodeRouteTarget, decodeRouteTarget } from "./protocol.js";
export type { AnytypeRoute, BridgeBinding, BridgeDelivery, BridgeInbound } from "./protocol.js";
export { BridgeStore } from "./store.js";
//# sourceMappingURL=index.d.ts.map
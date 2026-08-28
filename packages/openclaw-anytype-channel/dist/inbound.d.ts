import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { ResolvedAnytypeAccount, CoreConfig } from "./config.js";
import { type BridgeInbound } from "./protocol.js";
import { BridgeStore } from "./store.js";
export type DeliverReply = (params: {
    account: ResolvedAnytypeAccount;
    inbound: BridgeInbound;
    sessionKey: string;
    text: string;
}) => Promise<void>;
export declare function dispatchAnytypeInbound(params: {
    api: OpenClawPluginApi;
    cfg: CoreConfig;
    account: ResolvedAnytypeAccount;
    store: BridgeStore;
    inbound: BridgeInbound;
    deliverReply: DeliverReply;
}): Promise<void>;
//# sourceMappingURL=inbound.d.ts.map
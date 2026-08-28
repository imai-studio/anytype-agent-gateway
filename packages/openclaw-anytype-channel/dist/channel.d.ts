import { type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { type CoreConfig, type ResolvedAnytypeAccount } from "./config.js";
import { type AnytypeRoute } from "./protocol.js";
export declare const CHANNEL_ID: "anytype";
export type SendAnytypeText = (params: {
    cfg: CoreConfig;
    accountId?: string | null;
    route: AnytypeRoute;
    text: string;
    replyToId?: string;
}) => Promise<{
    messageId: string;
}>;
export type StartAnytypeAccount = NonNullable<NonNullable<ChannelPlugin<ResolvedAnytypeAccount>["gateway"]>["startAccount"]>;
export declare function createAnytypeChannel(params: {
    sendText: SendAnytypeText;
    startAccount: StartAnytypeAccount;
}): ChannelPlugin<ResolvedAnytypeAccount>;
//# sourceMappingURL=channel.d.ts.map
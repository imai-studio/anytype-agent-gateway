import { buildChannelOutboundSessionRoute, buildThreadAwareOutboundSessionRoute, createChatChannelPlugin, } from "openclaw/plugin-sdk/channel-core";
import { createMessageReceiptFromOutboundResults, defineChannelMessageAdapter, } from "openclaw/plugin-sdk/channel-outbound";
import { DEFAULT_ACCOUNT_ID, anytypePluginConfigSchema, listAnytypeAccountIds, resolveAnytypeAccount, resolveDefaultAnytypeAccountId, } from "./config.js";
import { decodeRouteTarget, encodeRouteTarget } from "./protocol.js";
export const CHANNEL_ID = "anytype";
export function createAnytypeChannel(params) {
    const message = defineChannelMessageAdapter({
        id: CHANNEL_ID,
        durableFinal: {
            capabilities: {
                text: true,
                replyTo: true,
                thread: true,
                messageSendingHooks: true,
            },
        },
        send: {
            text: async (context) => {
                const base = decodeRouteTarget(context.to);
                const threadId = context.threadId == null ? undefined : String(context.threadId);
                const result = await params.sendText({
                    cfg: context.cfg,
                    ...(context.accountId === undefined ? {} : { accountId: context.accountId }),
                    route: {
                        ...base,
                        ...(threadId ? { discussionRootId: threadId } : {}),
                    },
                    text: context.text,
                    ...(context.replyToId ? { replyToId: context.replyToId } : {}),
                });
                return {
                    messageId: result.messageId,
                    receipt: createMessageReceiptFromOutboundResults({
                        results: [{ channel: CHANNEL_ID, messageId: result.messageId }],
                        ...(threadId ? { threadId } : {}),
                        ...(context.replyToId ? { replyToId: context.replyToId } : {}),
                        kind: "text",
                    }),
                };
            },
        },
    });
    return createChatChannelPlugin({
        base: {
            id: CHANNEL_ID,
            meta: {
                id: CHANNEL_ID,
                label: "Anytype",
                selectionLabel: "Anytype (AAG bridge)",
                docsPath: "/channels/anytype",
                docsLabel: "anytype",
                blurb: "Anytype chats and object discussions through AAG.",
                aliases: ["aag"],
                order: 80,
            },
            capabilities: {
                chatTypes: ["group", "thread"],
                reply: true,
                threads: true,
            },
            reload: { configPrefixes: ["channels.anytype"] },
            configSchema: anytypePluginConfigSchema,
            config: {
                listAccountIds: (cfg) => listAnytypeAccountIds(cfg),
                resolveAccount: (cfg, accountId) => resolveAnytypeAccount(cfg, accountId),
                defaultAccountId: (cfg) => resolveDefaultAnytypeAccountId(cfg),
                isConfigured: (account) => account.configured,
                resolveAllowFrom: ({ cfg, accountId }) => resolveAnytypeAccount(cfg, accountId).allowFrom,
            },
            messaging: {
                targetPrefixes: [CHANNEL_ID],
                normalizeTarget: (target) => target.trim().replace(/^anytype:/u, ""),
                inferTargetChatType: () => "group",
                targetResolver: {
                    looksLikeId: (target) => {
                        try {
                            decodeRouteTarget(target);
                            return true;
                        }
                        catch {
                            return false;
                        }
                    },
                    hint: "route:<base64url>",
                },
                resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target, replyToId, threadId, currentSessionKey, }) => {
                    const route = decodeRouteTarget(target);
                    const normalizedTarget = encodeRouteTarget(route);
                    const baseRoute = buildChannelOutboundSessionRoute({
                        cfg,
                        agentId,
                        channel: CHANNEL_ID,
                        ...(accountId === undefined ? {} : { accountId }),
                        peer: { kind: "channel", id: normalizedTarget },
                        chatType: "group",
                        from: `${CHANNEL_ID}:${accountId ?? DEFAULT_ACCOUNT_ID}`,
                        to: normalizedTarget,
                    });
                    return buildThreadAwareOutboundSessionRoute({
                        route: baseRoute,
                        ...(replyToId === undefined ? {} : { replyToId }),
                        ...(threadId === undefined ? {} : { threadId }),
                        ...(currentSessionKey === undefined ? {} : { currentSessionKey }),
                        canRecoverCurrentThread: () => true,
                    });
                },
                resolveSessionConversation: ({ rawId }) => {
                    const decoded = decodeRouteTarget(rawId);
                    return {
                        id: decoded.chatId,
                        baseConversationId: decoded.chatId,
                        parentConversationCandidates: [decoded.chatId],
                    };
                },
            },
            gateway: { startAccount: params.startAccount },
            message,
        },
        outbound: {
            base: { deliveryMode: "direct" },
            attachedResults: {
                channel: CHANNEL_ID,
                sendText: async ({ cfg, to, text, accountId, threadId, replyToId }) => {
                    const route = decodeRouteTarget(to);
                    const result = await params.sendText({
                        cfg: cfg,
                        ...(accountId === undefined ? {} : { accountId }),
                        route: {
                            ...route,
                            ...(threadId == null ? {} : { discussionRootId: String(threadId) }),
                        },
                        text,
                        ...(replyToId ? { replyToId } : {}),
                    });
                    return { messageId: result.messageId };
                },
            },
        },
    });
}
//# sourceMappingURL=channel.js.map
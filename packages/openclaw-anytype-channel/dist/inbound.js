import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import { encodeRouteTarget } from "./protocol.js";
const CHANNEL_ID = "anytype";
export async function dispatchAnytypeInbound(params) {
    const { inbound, account, api } = params;
    if (!account.allowFrom.includes(inbound.message.senderId)) {
        throw new Error(`sender ${inbound.message.senderId} is not allowed for this Anytype agent`);
    }
    const target = encodeRouteTarget(inbound.route);
    const isDiscussion = Boolean(inbound.route.discussionRootId);
    const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
        cfg: params.cfg,
        channel: CHANNEL_ID,
        accountId: account.accountId,
        peer: { kind: "channel", id: target },
        runtime: api.runtime.channel,
        ...(params.cfg.session?.store ? { sessionStore: params.cfg.session.store } : {}),
    });
    const access = await resolveStableChannelMessageIngress({
        channelId: CHANNEL_ID,
        accountId: account.accountId,
        identity: { key: "sender", entryIdPrefix: "anytype" },
        subject: { stableId: inbound.message.senderId },
        conversation: {
            kind: "channel",
            id: inbound.route.chatId,
            ...(inbound.route.discussionRootId
                ? { threadId: inbound.route.discussionRootId }
                : {}),
        },
        mentionFacts: {
            canDetectMention: true,
            wasMentioned: inbound.message.wasMentioned ?? false,
        },
        groupPolicy: "allowlist",
        groupAllowFrom: account.allowFrom,
        policy: { activation: { requireMention: false, allowTextCommands: true } },
    });
    if (access.ingress.admission !== "dispatch")
        return;
    const { storePath, body } = buildEnvelope({
        channel: "Anytype",
        from: inbound.message.senderName ?? inbound.message.senderId,
        ...(inbound.message.createdAt === undefined
            ? {}
            : { timestamp: inbound.message.createdAt }),
        body: inbound.message.text,
    });
    const context = api.runtime.channel.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: inbound.message.text,
        RawBody: inbound.message.text,
        CommandBody: inbound.message.text,
        From: target,
        To: target,
        SessionKey: route.sessionKey,
        AccountId: route.accountId ?? account.accountId,
        ChatType: "group",
        WasMentioned: inbound.message.wasMentioned ?? false,
        ConversationLabel: isDiscussion
            ? `Anytype discussion ${inbound.route.discussionRootId}`
            : `Anytype chat ${inbound.route.chatId}`,
        GroupSubject: inbound.route.chatId,
        GroupChannel: inbound.route.chatId,
        NativeChannelId: inbound.route.chatId,
        ...(inbound.route.discussionRootId
            ? {
                MessageThreadId: inbound.route.discussionRootId,
                ThreadParentId: inbound.route.chatId,
            }
            : {}),
        ...(inbound.message.senderName ? { SenderName: inbound.message.senderName } : {}),
        SenderId: inbound.message.senderId,
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        MessageSid: inbound.message.id,
        MessageSidFull: inbound.message.id,
        ...(inbound.message.replyToId ? { ReplyToId: inbound.message.replyToId } : {}),
        ...(inbound.message.createdAt === undefined
            ? {}
            : { Timestamp: inbound.message.createdAt }),
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: target,
        CommandAuthorized: true,
    });
    params.store.bindSession(route.sessionKey, account.accountId, inbound.route);
    await api.runtime.channel.inbound.dispatchReply({
        cfg: params.cfg,
        channel: CHANNEL_ID,
        accountId: account.accountId,
        agentId: route.agentId,
        routeSessionKey: route.sessionKey,
        storePath,
        ctxPayload: context,
        recordInboundSession: api.runtime.channel.session.recordInboundSession,
        dispatchReplyWithBufferedBlockDispatcher: api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
        delivery: {
            deliver: async (payload) => {
                const text = payload && typeof payload === "object" && "text" in payload
                    ? (payload.text ?? "")
                    : "";
                if (text.trim()) {
                    await params.deliverReply({ account, inbound, sessionKey: route.sessionKey, text });
                }
            },
            onError: (error) => {
                throw error instanceof Error ? error : new Error(String(error));
            },
        },
        replyOptions: {},
        replyPipeline: {},
        record: {
            onRecordError: (error) => {
                throw error instanceof Error ? error : new Error(String(error));
            },
        },
    });
}
//# sourceMappingURL=inbound.js.map
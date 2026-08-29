export function mergeWakeOverride(wake, override) {
    if (!override)
        return wake;
    return {
        ...wake,
        humans: override.humans,
        ...(override.prefix ? { prefix: override.prefix } : {}),
        ...(override.allowedUsers ? { allowedUsers: override.allowedUsers } : {}),
    };
}
export function isDirectMention(message, config, participantId = config.agent.participantId) {
    return isStructuredMention(message, participantId) || isTextMention(message, config);
}
function isStructuredMention(message, participantId) {
    if (message.mentioned)
        return true;
    const marks = message.content?.marks ?? [];
    return marks.some((mark) => mark.type === "mention" && mark.param && sameIdentity(mark.param, participantId));
}
function isTextMention(message, config) {
    const text = message.content?.text ?? "";
    const names = [config.agent.name, ...config.agent.aliases].map((name) => name.replace(/^@/, ""));
    return names.some((name) => new RegExp(`(^|\\s)@${escapeRegex(name)}(?=\\s|$|[.,:;!?])`, "i").test(text));
}
export function decideWake(message, wake, config, options) {
    const creator = message.creator ?? "";
    const selfParticipantId = options.selfParticipantId ?? config.agent.participantId;
    const isSelf = Boolean(creator && sameIdentity(creator, selfParticipantId));
    if (isSelf)
        return { wake: false, reason: "self", isAgent: true, directMention: false };
    const isAgent = config.coordination.agentParticipants.some((participant) => sameIdentity(creator, participant)) || config.coordination.peers.some((peer) => sameIdentity(creator, peer.participantId));
    const directMention = isAgent
        ? isStructuredMention(message, selfParticipantId)
        : isDirectMention(message, config, selfParticipantId);
    const allowed = wake.allowedUsers.some((participant) => participant === "*" || sameIdentity(creator, participant));
    if (!allowed)
        return { wake: false, reason: "unauthorized", isAgent, directMention };
    if (isAgent) {
        const result = wake.agents === "every-message" || (wake.agents === "direct-mention" && directMention);
        return {
            wake: result,
            reason: result ? `agent:${wake.agents}` : "agent-policy",
            isAgent,
            directMention,
        };
    }
    const text = message.content?.text ?? "";
    const result = wake.humans === "every-message" ||
        (wake.humans === "mention" && directMention) ||
        (wake.humans === "mention-or-reply" && (directMention || options.replyToAgent)) ||
        (wake.humans === "prefix" && Boolean(wake.prefix && text.trimStart().startsWith(wake.prefix)));
    return {
        wake: result,
        reason: result ? `human:${wake.humans}` : "human-policy",
        isAgent,
        directMention,
    };
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function sameIdentity(left, right) {
    if (left === right || left.endsWith(`_${right}`) || right.endsWith(`_${left}`))
        return true;
    return left.split("_").at(-1) === right.split("_").at(-1);
}

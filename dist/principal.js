import { createHash } from "node:crypto";
export function principalFromMessage(message) {
    return principalFromParticipantId(message.creator, message.creator_name);
}
export function principalFromParticipantId(participantId, displayName) {
    if (typeof participantId !== "string" ||
        participantId.length === 0 ||
        participantId.length > 512 ||
        participantId.trim() !== participantId ||
        /\s/u.test(participantId) ||
        [...participantId].some((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code <= 31 || code === 127;
        }))
        return undefined;
    return {
        participantId,
        ...(displayName ? { displayName } : {}),
        provenance: "anytype-native",
    };
}
export function principalAllowed(principal, configuredParticipantIds) {
    return Boolean(principal &&
        configuredParticipantIds.some((configured) => configured === "*" || sameIdentity(principal.participantId, configured)));
}
// Anytype APIs may expose the same immutable identity as either a global member
// ID or a space-scoped participant ID. Retain that released compatibility while
// never consulting display names or message content.
export function sameIdentity(left, right) {
    return left === right || left.endsWith(`_${right}`) || right.endsWith(`_${left}`);
}
export function principalAuditFields(principal) {
    if (!principal)
        return { actorProvenance: "unavailable" };
    return {
        actorProvenance: principal.provenance,
        actorIdHash: `sha256:${createHash("sha256").update(principal.participantId).digest("hex").slice(0, 16)}`,
    };
}

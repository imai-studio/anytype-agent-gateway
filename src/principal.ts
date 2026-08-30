import { createHash } from "node:crypto";
import type { ChatMessage } from "./types.js";

export type AnytypePrincipal = {
  participantId: string;
  displayName?: string;
  provenance: "anytype-native";
};

export function principalFromMessage(message: ChatMessage): AnytypePrincipal | undefined {
  return principalFromParticipantId(message.creator, message.creator_name);
}

export function principalFromParticipantId(
  participantId: string | undefined,
  displayName?: string,
): AnytypePrincipal | undefined {
  if (
    typeof participantId !== "string" ||
    participantId.length === 0 ||
    participantId.length > 512 ||
    participantId.trim() !== participantId ||
    /\s/u.test(participantId) ||
    [...participantId].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  )
    return undefined;
  return {
    participantId,
    ...(displayName ? { displayName } : {}),
    provenance: "anytype-native",
  };
}

export function principalFromActorRecord(value: unknown): AnytypePrincipal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as {
    actorId?: unknown;
    participantId?: unknown;
    provenance?: unknown;
  };
  if (record.provenance !== "anytype-native") return undefined;
  const participantId = record.participantId ?? record.actorId;
  return typeof participantId === "string" ? principalFromParticipantId(participantId) : undefined;
}

export function principalAllowed(
  principal: AnytypePrincipal | undefined,
  configuredParticipantIds: readonly string[],
): boolean {
  return Boolean(
    principal &&
    configuredParticipantIds.some(
      (configured) => configured === "*" || sameIdentity(principal.participantId, configured),
    ),
  );
}

// Anytype APIs may expose the same immutable identity as either a global member
// ID or a space-scoped participant ID. Retain that released compatibility while
// never consulting display names or message content.
export function sameIdentity(left: string, right: string): boolean {
  return left === right || left.endsWith(`_${right}`) || right.endsWith(`_${left}`);
}

export function principalAuditFields(
  principal: AnytypePrincipal | undefined,
): Record<string, string> {
  if (!principal) return { actorProvenance: "unavailable" };
  return {
    actorProvenance: principal.provenance,
    actorIdHash: `sha256:${createHash("sha256").update(principal.participantId).digest("hex").slice(0, 16)}`,
  };
}

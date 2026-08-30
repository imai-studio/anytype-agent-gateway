import type { ChatMessage } from "./types.js";
export type AnytypePrincipal = {
    participantId: string;
    displayName?: string;
    provenance: "anytype-native";
};
export declare function principalFromMessage(message: ChatMessage): AnytypePrincipal | undefined;
export declare function principalFromParticipantId(participantId: string | undefined, displayName?: string): AnytypePrincipal | undefined;
export declare function principalFromActorRecord(value: unknown): AnytypePrincipal | undefined;
export declare function principalAllowed(principal: AnytypePrincipal | undefined, configuredParticipantIds: readonly string[]): boolean;
export declare function sameIdentity(left: string, right: string): boolean;
export declare function principalAuditFields(principal: AnytypePrincipal | undefined): Record<string, string>;

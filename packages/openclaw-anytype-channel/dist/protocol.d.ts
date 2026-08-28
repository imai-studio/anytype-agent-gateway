import { z } from "zod";
export declare const AnytypeRouteSchema: z.ZodObject<{
    spaceId: z.ZodString;
    chatId: z.ZodString;
    discussionRootId: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type AnytypeRoute = z.infer<typeof AnytypeRouteSchema>;
export declare const BridgeInboundSchema: z.ZodObject<{
    id: z.ZodString;
    accountId: z.ZodDefault<z.ZodString>;
    route: z.ZodObject<{
        spaceId: z.ZodString;
        chatId: z.ZodString;
        discussionRootId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    message: z.ZodObject<{
        id: z.ZodString;
        senderId: z.ZodString;
        senderName: z.ZodOptional<z.ZodString>;
        text: z.ZodString;
        replyToId: z.ZodOptional<z.ZodString>;
        wasMentioned: z.ZodOptional<z.ZodBoolean>;
        createdAt: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type BridgeInbound = z.infer<typeof BridgeInboundSchema>;
export declare const BridgeBindingSchema: z.ZodObject<{
    accountId: z.ZodDefault<z.ZodString>;
    sessionKey: z.ZodString;
    route: z.ZodObject<{
        spaceId: z.ZodString;
        chatId: z.ZodString;
        discussionRootId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type BridgeBinding = z.infer<typeof BridgeBindingSchema>;
export declare const AgentEventEnvelopeSchema: z.ZodObject<{
    runId: z.ZodString;
    seq: z.ZodNumber;
    stream: z.ZodEnum<{
        assistant: "assistant";
        thinking: "thinking";
        tool: "tool";
        lifecycle: "lifecycle";
        item: "item";
    }>;
    timestamp: z.ZodNumber;
    data: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strict>;
export type AgentEventEnvelope = z.infer<typeof AgentEventEnvelopeSchema>;
export declare const BridgeDeliverySchema: z.ZodObject<{
    id: z.ZodString;
    idempotencyKey: z.ZodString;
    accountId: z.ZodString;
    sessionKey: z.ZodOptional<z.ZodString>;
    route: z.ZodObject<{
        spaceId: z.ZodString;
        chatId: z.ZodString;
        discussionRootId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    createdAt: z.ZodNumber;
    owned: z.ZodOptional<z.ZodBoolean>;
    kind: z.ZodEnum<{
        "agent-event": "agent-event";
        "message-final": "message-final";
    }>;
    agentEvent: z.ZodOptional<z.ZodObject<{
        runId: z.ZodString;
        seq: z.ZodNumber;
        stream: z.ZodEnum<{
            assistant: "assistant";
            thinking: "thinking";
            tool: "tool";
            lifecycle: "lifecycle";
            item: "item";
        }>;
        timestamp: z.ZodNumber;
        data: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    message: z.ZodOptional<z.ZodObject<{
        text: z.ZodString;
        replyToId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type BridgeDelivery = z.infer<typeof BridgeDeliverySchema>;
export type StoredDelivery = BridgeDelivery & {
    storeSequence: number;
    attempts: number;
    nextAttemptAt: number;
    lastError?: string;
};
export declare function routeKey(route: AnytypeRoute): string;
/**
 * Opaque OpenClaw peer target. Version one targets contained two array items;
 * the optional third item makes discussion identity durable outside transient
 * thread context while preserving backwards compatibility.
 */
export declare function encodeRouteTarget(route: AnytypeRoute): string;
export declare function decodeRouteTarget(target: string): AnytypeRoute;
/** Explicit OpenClaw thread context wins over the root encoded in the target. */
export declare function resolveTargetRoute(target: string, threadId?: string | number | null): AnytypeRoute;
//# sourceMappingURL=protocol.d.ts.map
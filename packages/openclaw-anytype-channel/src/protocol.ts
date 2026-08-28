import { z } from "zod";

export const AnytypeRouteSchema = z
  .object({
    spaceId: z.string().min(1),
    chatId: z.string().min(1),
    discussionRootId: z.string().min(1).optional(),
  })
  .strict();

export type AnytypeRoute = z.infer<typeof AnytypeRouteSchema>;

export const BridgeInboundSchema = z
  .object({
    id: z.string().min(1).max(256),
    accountId: z.string().min(1).default("default"),
    route: AnytypeRouteSchema,
    message: z
      .object({
        id: z.string().min(1),
        senderId: z.string().min(1),
        senderName: z.string().min(1).optional(),
        text: z.string(),
        replyToId: z.string().min(1).optional(),
        wasMentioned: z.boolean().optional(),
        createdAt: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

export type BridgeInbound = z.infer<typeof BridgeInboundSchema>;

export const BridgeBindingSchema = z
  .object({
    accountId: z.string().min(1).default("default"),
    sessionKey: z.string().min(1),
    route: AnytypeRouteSchema,
  })
  .strict();

export type BridgeBinding = z.infer<typeof BridgeBindingSchema>;

export const AgentEventEnvelopeSchema = z
  .object({
    runId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    stream: z.enum(["assistant", "thinking", "tool", "lifecycle", "item"]),
    timestamp: z.number().int().nonnegative(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export type AgentEventEnvelope = z.infer<typeof AgentEventEnvelopeSchema>;

export const BridgeDeliverySchema = z
  .object({
    id: z.string().min(1),
    idempotencyKey: z.string().min(1),
    accountId: z.string().min(1),
    sessionKey: z.string().min(1).optional(),
    route: AnytypeRouteSchema,
    createdAt: z.number().int().nonnegative(),
    owned: z.boolean().optional(),
    kind: z.enum(["agent-event", "message-final"]),
    agentEvent: AgentEventEnvelopeSchema.optional(),
    message: z
      .object({
        text: z.string(),
        replyToId: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "agent-event" && !value.agentEvent) {
      ctx.addIssue({ code: "custom", message: "agentEvent is required for agent-event" });
    }
    if (value.kind === "message-final" && !value.message) {
      ctx.addIssue({ code: "custom", message: "message is required for message-final" });
    }
  });

export type BridgeDelivery = z.infer<typeof BridgeDeliverySchema>;

export type StoredDelivery = BridgeDelivery & {
  storeSequence: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
};

export function routeKey(route: AnytypeRoute): string {
  return [route.spaceId, route.chatId, route.discussionRootId ?? ""].join("\u001f");
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

/** Opaque OpenClaw peer target. Discussion identity stays in the thread suffix. */
export function encodeRouteTarget(route: Pick<AnytypeRoute, "spaceId" | "chatId">): string {
  return `route:${base64UrlEncode(JSON.stringify([route.spaceId, route.chatId]))}`;
}

export function decodeRouteTarget(target: string): Pick<AnytypeRoute, "spaceId" | "chatId"> {
  const normalized = target.trim().replace(/^anytype:/u, "");
  if (!normalized.startsWith("route:")) {
    throw new Error("Invalid Anytype target; expected route:<base64url>");
  }
  const parsed: unknown = JSON.parse(base64UrlDecode(normalized.slice("route:".length)));
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    !parsed[0] ||
    !parsed[1]
  ) {
    throw new Error("Invalid Anytype route target payload");
  }
  return { spaceId: parsed[0], chatId: parsed[1] };
}

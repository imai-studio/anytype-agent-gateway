export type AgentRuntime = "openclaw" | "codex-acp" | "codex-app";

export type SessionBindingState = "active" | "detached" | "resetting";

export interface SessionBinding {
  threadKey: string;
  routeId: string;
  spaceId: string;
  chatId: string;
  discussionRootId?: string;
  runtime: AgentRuntime;
  nativeSessionKey: string;
  nativeSessionId?: string;
  generation: number;
  eventCursor?: string;
  state: SessionBindingState;
  createdAt: number;
  updatedAt: number;
}

export type RuntimeCapabilityValue = boolean | number | string | null;
export type RuntimeCapabilities = Record<string, RuntimeCapabilityValue>;

export interface ConversationModelState {
  threadKey: string;
  runtime: AgentRuntime;
  requestedModelId?: string;
  useDefault?: boolean;
  appliedGeneration?: number;
  appliedModelId?: string;
  defaultModelId?: string;
  catalog: Array<{ id: string; name: string; provider?: string; description?: string }>;
  updatedBy?: string;
  updatedAt: number;
}

export type OutputCycleState = "open" | "complete" | "failed" | "deleted";
export type OutputCyclePhase = "working" | "thinking" | "answer" | "error";

export interface OutputCycle {
  id: string;
  threadKey: string;
  sequence: number;
  anytypeMessageId: string;
  replyToMessageId?: string;
  state: OutputCycleState;
  phase: OutputCyclePhase;
  thinkingText: string;
  answerText: string;
  eventCursor?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export type OutboundOperation = "create" | "edit" | "delete" | "react-add" | "react-remove";
export type OutboundStatus = "pending" | "claimed" | "delivered" | "failed" | "dead";

export interface OutboundItem {
  id: string;
  threadKey: string;
  routeId: string;
  spaceId: string;
  chatId: string;
  discussionRootId?: string;
  operation: OutboundOperation;
  targetMessageId?: string;
  replyToMessageId?: string;
  payload: unknown;
  dedupeKey: string;
  status: OutboundStatus;
  attempts: number;
  availableAt: number;
  claimedAt?: number;
  claimedBy?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
}

export interface ProactiveDelivery {
  runtime: AgentRuntime;
  nativeSessionKey: string;
  nativeEventId: string;
  threadKey: string;
  payloadHash?: string;
  messageId?: string;
  deliveredAt: number;
}

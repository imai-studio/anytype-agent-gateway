export type TextMark = { type: string; from?: number; to?: number; param?: string };
export type ChatAttachment = { target: string; type: "file" | "image" | "link" };

export type ChatMessage = {
  id: string;
  order_id?: string;
  creator?: string;
  creator_name?: string;
  created_at?: number;
  modified_at?: number;
  reply_to_message_id?: string;
  content?: { text?: string; style?: string; marks?: TextMark[] };
  attachments?: ChatAttachment[];
  reactions?: Record<string, string[]>;
  mentioned?: boolean;
};

export type ConversationRef = {
  routeId: string;
  spaceId: string;
  spaceName?: string;
  chatId: string;
  kind: "chat" | "discussion";
  objectId?: string;
  discussionRootId?: string;
  objectName?: string;
  selfParticipantId?: string;
};

export type ContextBundle = {
  conversation: ConversationRef;
  trigger: ChatMessage;
  newSession?: boolean;
  history: ChatMessage[];
  replyAncestry: ChatMessage[];
  referencedObjects: Array<
    { id: string; name?: string; markdown?: string } & Record<string, unknown>
  >;
  attachments?: Array<{
    messageId: string;
    objectId: string;
    type: ChatAttachment["type"];
    localPath?: string;
    contentType?: string;
    sourceObjectId?: string;
    error?: string;
  }>;
  mentionTargets?: Array<{ name: string; participantId: string }>;
};

export type RuntimeEvent =
  | { type: "status"; text: string }
  | { type: "text-delta"; text: string; partId?: string; phase?: string; replace?: boolean }
  | { type: "thinking-delta"; text: string; partId?: string; phase?: string; replace?: boolean }
  | { type: "tool"; name: string; status: string }
  | { type: "silent"; reason?: string };

export type RuntimeResult = { text: string; silent?: boolean; reason?: string };

export type RuntimeCapabilities = {
  steering: boolean;
  thinking: boolean;
  multipleOutputParts: boolean;
  sessionObservation: boolean;
  nativeScheduling: boolean;
};

export type RuntimeSessionOutput = {
  id: string;
  cursor: string;
  events: RuntimeEvent[];
  result: RuntimeResult;
};

export type RuntimeSessionObserver = { readonly cursor?: string; close(): Promise<void> };

export type RuntimeTurn = {
  conversation: ConversationRef;
  message: ChatMessage;
  replyTargetId: string;
  wasMentioned?: boolean;
  workspacePath?: string;
};

export type ActiveRuntime = {
  sessionKey?: string;
  sessionId?: string;
  result: Promise<RuntimeResult>;
  steer(message: string, turn?: RuntimeTurn): Promise<void>;
  cancel(): Promise<void>;
};

export interface RuntimeDriver {
  readonly name: string;
  readonly projectEnforcement: "enforced" | "advisory" | "unknown";
  readonly capabilities: RuntimeCapabilities;
  start(
    input: { sessionKey: string; prompt: string; turn?: RuntimeTurn },
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<ActiveRuntime>;
  observeSession?(
    input: { sessionKey: string; afterCursor?: string; conversation?: ConversationRef },
    onOutput: (output: RuntimeSessionOutput) => Promise<void>,
  ): Promise<RuntimeSessionObserver>;
  doctor(): Promise<string[]>;
  close?(): Promise<void>;
}

export type AnytypeEvent = { type: string; payload?: { message?: ChatMessage } };

export interface AnytypePort {
  getMessage(spaceId: string, chatId: string, messageId: string): Promise<ChatMessage>;
  listMessages(
    spaceId: string,
    chatId: string,
    limit: number,
    afterOrderId?: string,
  ): Promise<ChatMessage[]>;
  sendMessage(
    spaceId: string,
    chatId: string,
    input: {
      text: string;
      replyTo?: string;
      marks?: TextMark[];
      attachments?: ChatAttachment[];
    },
  ): Promise<string>;
  editMessage(
    spaceId: string,
    chatId: string,
    messageId: string,
    text: string,
    marks?: TextMark[],
    attachments?: ChatAttachment[],
  ): Promise<void>;
  deleteMessage(spaceId: string, chatId: string, messageId: string): Promise<void>;
  ensureReaction(
    spaceId: string,
    chatId: string,
    messageId: string,
    emoji: string,
    present: boolean,
    participantId?: string,
  ): Promise<void>;
  stream(spaceId: string, chatId: string, signal: AbortSignal): AsyncIterable<AnytypeEvent>;
  resolveSpace(selector: { id?: string; name?: string }): Promise<{ id: string; name: string }>;
  resolveChat(
    spaceId: string,
    selector: { id?: string; name?: string },
  ): Promise<{ id: string; name: string }>;
  listChats(spaceId: string): Promise<Array<{ id: string; name: string }>>;
  getObject(
    spaceId: string,
    objectId: string,
  ): Promise<{ id: string; name?: string; markdown?: string }>;
  searchObjects(
    spaceId: string,
    offset: number,
    limit: number,
  ): Promise<Array<{ id: string; name?: string; type?: string }>>;
  downloadFile?(
    spaceId: string,
    fileId: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; contentType?: string }>;
}

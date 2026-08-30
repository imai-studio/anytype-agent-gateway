import type {
  ActiveRuntime,
  AnytypeEvent,
  AnytypeMember,
  AnytypePort,
  AnytypeSpace,
  ChatAttachment,
  ChatMessage,
  RuntimeDriver,
  RuntimeEvent,
  RuntimeModelState,
  RuntimeResult,
  TextMark,
} from "../src/types.js";

export class FakeAnytype implements AnytypePort {
  messages: ChatMessage[] = [];
  chats: Array<{ id: string; name: string }> = [{ id: "chat", name: "Chat" }];
  edits: Array<{ id: string; text: string }> = [];
  deleted: string[] = [];
  reactions: Array<{ id: string; emoji: string; present: boolean }> = [];
  reactionParticipants: Array<string | undefined> = [];
  private nextId = 1;

  async getMessage(_spaceId: string, _chatId: string, messageId: string): Promise<ChatMessage> {
    const message = this.messages.find((item) => item.id === messageId);
    if (!message) throw new Error("not found");
    return message;
  }
  async listMessages(
    _spaceId: string,
    _chatId: string,
    limit: number,
    afterOrderId?: string,
  ): Promise<ChatMessage[]> {
    const messages = afterOrderId
      ? this.messages.filter((message) => message.order_id && message.order_id > afterOrderId)
      : this.messages;
    return messages.slice(-limit);
  }
  async sendMessage(
    _spaceId: string,
    _chatId: string,
    input: {
      text: string;
      replyTo?: string;
      marks?: TextMark[];
      attachments?: ChatAttachment[];
    },
  ): Promise<string> {
    const id = `reply-${this.nextId++}`;
    this.messages.push({
      id,
      creator: "bot",
      ...(input.replyTo ? { reply_to_message_id: input.replyTo } : {}),
      content: { text: input.text, ...(input.marks ? { marks: input.marks } : {}) },
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    return id;
  }
  async editMessage(
    _spaceId: string,
    _chatId: string,
    messageId: string,
    text: string,
    _marks?: TextMark[],
    attachments?: ChatAttachment[],
  ): Promise<void> {
    this.edits.push({ id: messageId, text });
    const found = this.messages.find((item) => item.id === messageId);
    if (found?.content) found.content.text = text;
    if (found) found.attachments = attachments ?? [];
  }
  async deleteMessage(_spaceId: string, _chatId: string, messageId: string): Promise<void> {
    this.deleted.push(messageId);
  }
  async ensureReaction(
    _spaceId: string,
    _chatId: string,
    messageId: string,
    emoji: string,
    present: boolean,
    participantId?: string,
  ): Promise<void> {
    this.reactions.push({ id: messageId, emoji, present });
    this.reactionParticipants.push(participantId);
  }
  async *stream(
    _spaceId: string,
    _chatId: string,
    _signal: AbortSignal,
  ): AsyncIterable<AnytypeEvent> {}
  async resolveSpace(): Promise<{ id: string; name: string }> {
    return { id: "space", name: "Space" };
  }
  async listSpaces(): Promise<AnytypeSpace[]> {
    return [{ id: "space", name: "Space", object: "anytype.space" }];
  }
  async listMembers(_spaceId: string): Promise<AnytypeMember[]> {
    return [];
  }
  async resolveChat(): Promise<{ id: string; name: string }> {
    return { id: "chat", name: "Chat" };
  }
  async listChats(_spaceId: string): Promise<Array<{ id: string; name: string }>> {
    return this.chats;
  }
  async getObject(
    _spaceId: string,
    objectId: string,
  ): Promise<{ id: string; name?: string; markdown?: string }> {
    return { id: objectId, name: "Object", markdown: "Object context" };
  }
  async searchObjects(): Promise<Array<{ id: string; name?: string; type?: string }>> {
    return [];
  }
}

type Deferred = {
  promise: Promise<RuntimeResult>;
  resolve(value: RuntimeResult): void;
  reject(error: unknown): void;
};
function deferred(): Deferred {
  let resolve!: (value: RuntimeResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<RuntimeResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export class FakeRuntime implements RuntimeDriver {
  readonly name = "fake";
  readonly projectEnforcement = "enforced" as const;
  readonly capabilities = {
    steering: true,
    thinking: true,
    multipleOutputParts: true,
    sessionObservation: false,
    nativeScheduling: false,
    modelSelection: true,
  } as const;
  starts: Array<{ sessionKey: string; prompt: string }> = [];
  steers: string[] = [];
  events?: (event: RuntimeEvent) => void;
  current = deferred();
  model = "default-model";
  modelConfigurations: Array<string | null | undefined> = [];
  async doctor(): Promise<string[]> {
    return ["fake"];
  }
  async start(
    input: { sessionKey: string; prompt: string; modelId?: string | null },
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<ActiveRuntime> {
    this.current = deferred();
    this.starts.push(input);
    if (input.modelId !== undefined) {
      this.modelConfigurations.push(input.modelId);
      this.model = input.modelId ?? "default-model";
    }
    const modelState: RuntimeModelState = {
      options: [
        { id: "default-model", name: "Default" },
        { id: "fast-model", name: "Fast" },
      ],
      currentModelId: this.model,
      defaultModelId: "default-model",
    };
    this.events = onEvent;
    return {
      result: this.current.promise,
      modelState,
      steer: async (message) => {
        this.steers.push(message);
      },
      cancel: async () => {
        this.current.resolve({ text: "cancelled" });
      },
    };
  }
  async configureModel(input: { modelId?: string | null }): Promise<RuntimeModelState> {
    this.modelConfigurations.push(input.modelId);
    if (input.modelId === null) this.model = "default-model";
    else if (input.modelId) this.model = input.modelId;
    return {
      options: [
        { id: "default-model", name: "Default" },
        { id: "fast-model", name: "Fast" },
      ],
      currentModelId: this.model,
      defaultModelId: "default-model",
    };
  }
  finish(value: RuntimeResult): void {
    this.current.resolve(value);
  }
}

export function incoming(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    creator: "human-1",
    creator_name: "Raj",
    content: { text: "@AAG do the work", marks: [{ type: "mention", param: "bot" }] },
    ...overrides,
  };
}

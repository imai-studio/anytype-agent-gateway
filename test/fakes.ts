import type {
  ActiveRuntime,
  AnytypeEvent,
  AnytypeMember,
  AnytypePort,
  AnytypeSpace,
  AnytypeTag,
  AnytypeWorkflowObject,
  ChatAttachment,
  ChatMessage,
  RuntimeDriver,
  RuntimeEvent,
  RuntimeModelState,
  RuntimeResult,
  TextMark,
} from "../src/types.js";
import { AnytypeHttpError } from "../src/anytype-client.js";

export class FakeAnytype implements AnytypePort {
  messages: ChatMessage[] = [];
  chats: Array<{ id: string; name: string }> = [{ id: "chat", name: "Chat" }];
  edits: Array<{ id: string; text: string }> = [];
  deleted: string[] = [];
  reactions: Array<{ id: string; emoji: string; present: boolean }> = [];
  reactionParticipants: Array<string | undefined> = [];
  objects = new Map<string, Record<string, unknown>>();
  workflowObjects: AnytypeWorkflowObject[] = [];
  workflowSearchFailures = 0;
  missingObjectIds = new Set<string>();
  properties: Record<string, unknown>[] = [];
  propertyTags: AnytypeTag[] = [];
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
  ): Promise<{ id: string; name?: string; markdown?: string } & Record<string, unknown>> {
    if (this.missingObjectIds.has(objectId))
      throw new AnytypeHttpError(404, "GET", "/objects/redacted");
    const workflow = this.workflowObjects.find((candidate) => candidate.id === objectId);
    if (workflow)
      return {
        id: workflow.id,
        name: workflow.name,
        ...(workflow.source === undefined ? {} : { markdown: workflow.source }),
        archived: workflow.archived,
      };
    return {
      id: objectId,
      name: "Object",
      markdown: "Object context",
      ...this.objects.get(objectId),
    };
  }
  async getWorkflowObject(
    spaceId: string,
    objectId: string,
  ): Promise<{ id: string; name?: string; markdown?: string } & Record<string, unknown>> {
    return this.getObject(spaceId, objectId);
  }
  async listPropertyTags(_spaceId: string, _propertyId: string): Promise<AnytypeTag[]> {
    return this.propertyTags;
  }
  async listProperties(_spaceId: string): Promise<Record<string, unknown>[]> {
    return this.properties;
  }
  async createPropertyTag(
    _spaceId: string,
    _propertyId: string,
    input: { name: string; color: string },
  ): Promise<AnytypeTag> {
    const tag = { id: `tag-${this.propertyTags.length + 1}`, ...input };
    this.propertyTags.push(tag);
    return tag;
  }
  async updateObject(
    _spaceId: string,
    objectId: string,
    input: { properties?: Record<string, unknown>[] },
  ): Promise<Record<string, unknown>> {
    const first = input.properties?.[0] as { multi_select?: string[] } | undefined;
    const selected = first?.multi_select ?? [];
    const tags = selected.flatMap((id) => {
      const tag = this.propertyTags.find(
        (candidate) => candidate.id === id || candidate.key === id,
      );
      return tag ? [tag] : [];
    });
    this.objects.set(objectId, {
      ...(this.objects.get(objectId) ?? {}),
      properties: [{ id: "property-tag", key: "tag", format: "multi_select", multi_select: tags }],
    });
    return { id: objectId, ...this.objects.get(objectId) };
  }
  async searchObjects(): Promise<Array<{ id: string; name?: string; type?: string }>> {
    return [];
  }
  async searchWorkflowObjects(
    _spaceId: string,
    typeKeys: string[],
    offset: number,
    limit: number,
  ): Promise<AnytypeWorkflowObject[]> {
    if (this.workflowSearchFailures > 0) {
      this.workflowSearchFailures -= 1;
      throw new Error("workflow search unavailable");
    }
    return this.workflowObjects
      .filter((object) => typeKeys.includes(object.typeKey))
      .slice(offset, offset + limit);
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
  starts: Array<{ sessionKey: string; prompt: string; workspacePath?: string }> = [];
  steers: string[] = [];
  events?: (event: RuntimeEvent) => void;
  current = deferred();
  model = "default-model";
  modelConfigurations: Array<string | null | undefined> = [];
  async doctor(): Promise<string[]> {
    return ["fake"];
  }
  async start(
    input: {
      sessionKey: string;
      prompt: string;
      modelId?: string | null;
      turn?: { workspacePath?: string };
    },
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<ActiveRuntime> {
    this.current = deferred();
    this.starts.push({
      sessionKey: input.sessionKey,
      prompt: input.prompt,
      ...(input.turn?.workspacePath ? { workspacePath: input.turn.workspacePath } : {}),
    });
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

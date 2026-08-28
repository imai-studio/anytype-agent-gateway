import type { ActiveRuntime, AnytypeEvent, AnytypePort, ChatMessage, RuntimeDriver, RuntimeEvent, RuntimeResult, TextMark } from "../src/types.js";

export class FakeAnytype implements AnytypePort {
  messages: ChatMessage[] = [];
  chats: Array<{ id: string; name: string }> = [{ id: "chat", name: "Chat" }];
  edits: Array<{ id: string; text: string }> = [];
  deleted: string[] = [];
  reactions: Array<{ id: string; emoji: string; present: boolean }> = [];
  private nextId = 1;

  async getMessage(_spaceId: string, _chatId: string, messageId: string): Promise<ChatMessage> { const message = this.messages.find(item => item.id === messageId); if (!message) throw new Error("not found"); return message; }
  async listMessages(_spaceId: string, _chatId: string, limit: number, afterOrderId?: string): Promise<ChatMessage[]> { const messages = afterOrderId ? this.messages.filter(message => message.order_id && message.order_id > afterOrderId) : this.messages; return messages.slice(-limit); }
  async sendMessage(_spaceId: string, _chatId: string, input: { text: string; replyTo?: string; marks?: TextMark[] }): Promise<string> { const id = `reply-${this.nextId++}`; this.messages.push({ id, creator: "bot", ...(input.replyTo ? { reply_to_message_id: input.replyTo } : {}), content: { text: input.text, ...(input.marks ? { marks: input.marks } : {}) } }); return id; }
  async editMessage(_spaceId: string, _chatId: string, messageId: string, text: string): Promise<void> { this.edits.push({ id: messageId, text }); const found = this.messages.find(item => item.id === messageId); if (found?.content) found.content.text = text; }
  async deleteMessage(_spaceId: string, _chatId: string, messageId: string): Promise<void> { this.deleted.push(messageId); }
  async ensureReaction(_spaceId: string, _chatId: string, messageId: string, emoji: string, present: boolean): Promise<void> { this.reactions.push({ id: messageId, emoji, present }); }
  async *stream(_spaceId: string, _chatId: string, _signal: AbortSignal): AsyncIterable<AnytypeEvent> {}
  async resolveSpace(): Promise<{ id: string; name: string }> { return { id: "space", name: "Space" }; }
  async resolveChat(): Promise<{ id: string; name: string }> { return { id: "chat", name: "Chat" }; }
  async listChats(): Promise<Array<{ id: string; name: string }>> { return this.chats; }
  async getObject(_spaceId: string, objectId: string): Promise<{ id: string; name?: string; markdown?: string }> { return { id: objectId, name: "Object", markdown: "Object context" }; }
  async searchObjects(): Promise<Array<{ id: string; name?: string; type?: string }>> { return []; }
}

type Deferred = { promise: Promise<RuntimeResult>; resolve(value: RuntimeResult): void; reject(error: unknown): void };
function deferred(): Deferred { let resolve!: (value: RuntimeResult) => void; let reject!: (error: unknown) => void; const promise = new Promise<RuntimeResult>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

export class FakeRuntime implements RuntimeDriver {
  readonly name = "fake";
  readonly projectEnforcement = "enforced" as const;
  starts: Array<{ sessionKey: string; prompt: string }> = [];
  steers: string[] = [];
  events?: (event: RuntimeEvent) => void;
  current = deferred();
  async doctor(): Promise<string[]> { return ["fake"]; }
  async start(input: { sessionKey: string; prompt: string }, onEvent: (event: RuntimeEvent) => void): Promise<ActiveRuntime> {
    this.current = deferred();
    this.starts.push(input); this.events = onEvent;
    return { result: this.current.promise, steer: async message => { this.steers.push(message); }, cancel: async () => { this.current.resolve({ text: "cancelled" }); } };
  }
  finish(value: RuntimeResult): void { this.current.resolve(value); }
}

export function incoming(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "message-1", creator: "human-1", creator_name: "Raj", content: { text: "@AAG do the work", marks: [{ type: "mention", param: "bot" }] }, ...overrides };
}

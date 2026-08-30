import type { AgentConfig } from "./config.js";
import { runProcess } from "./process.js";
import type {
  AnytypeEvent,
  AnytypeMember,
  AnytypePort,
  AnytypeSpace,
  AnytypeTag,
  ChatAttachment,
  ChatMessage,
  TextMark,
} from "./types.js";

export type DiscussionResolution = { objectId: string; discussionId?: string; error?: string };
export type DirectMessageResolution = { spaceId: string; chatId: string };

export class HeartDiscussionAdapter {
  constructor(private readonly config: AgentConfig) {}

  async resolve(
    spaceId: string,
    objects: Array<{ id: string }>,
    createMissing: boolean,
  ): Promise<DiscussionResolution[]> {
    if (!objects.length) return [];
    const { command, grpcAddress } = this.config.anytype.heartAdapter;
    const args = [
      "resolve",
      "--space-id",
      spaceId,
      "--grpc-address",
      grpcAddress,
      ...(createMissing ? ["--create-missing"] : []),
    ];
    if (this.config.anytype.cli.configPath)
      args.push("--config", this.config.anytype.cli.configPath);
    const { stdout } = await runProcess(command, args, {
      stdin: `${JSON.stringify({ objectIds: objects.map((object) => object.id) })}\n`,
      timeoutMs: Math.max(30_000, objects.length * 12_000),
    });
    const result = JSON.parse(stdout) as { discussions: DiscussionResolution[] };
    return result.discussions;
  }

  async ensureDirectMessage(
    identity: string,
    signal?: AbortSignal,
  ): Promise<DirectMessageResolution> {
    const { command, grpcAddress } = this.config.anytype.heartAdapter;
    const args = ["ensure-dm", "--grpc-address", grpcAddress];
    if (this.config.anytype.cli.configPath)
      args.push("--config", this.config.anytype.cli.configPath);
    const { stdout } = await runProcess(command, args, {
      stdin: `${JSON.stringify({ identity })}\n`,
      timeoutMs: 35_000,
      ...(signal ? { signal } : {}),
    });
    const result = JSON.parse(stdout) as DirectMessageResolution;
    if (!result.spaceId || !result.chatId)
      throw new Error("Heart returned no direct-message space or chat ID");
    return result;
  }

  async hydrateMessages(chatId: string, messages: ChatMessage[]): Promise<ChatMessage[]> {
    const pending = messages.filter((message) => !message.content?.text);
    if (!pending.length) return messages;
    const { command, grpcAddress } = this.config.anytype.heartAdapter;
    const args = ["hydrate", "--grpc-address", grpcAddress];
    if (this.config.anytype.cli.configPath)
      args.push("--config", this.config.anytype.cli.configPath);
    const { stdout } = await runProcess(command, args, {
      stdin: `${JSON.stringify({ chatId, messageIds: pending.map((message) => message.id) })}\n`,
      timeoutMs: Math.max(30_000, pending.length * 2_000),
    });
    const result = JSON.parse(stdout) as { messages: ChatMessage[] };
    const hydrated = new Map(result.messages.map((message) => [message.id, message]));
    return messages.map((message) => {
      const full = hydrated.get(message.id);
      if (!full) return message;
      const content =
        full.content?.text || full.content?.marks?.length ? full.content : message.content;
      return {
        ...full,
        ...message,
        ...(content ? { content } : {}),
        ...(full.mentioned ? { mentioned: true } : {}),
      };
    });
  }

  async sendMessage(
    chatId: string,
    input: {
      text: string;
      replyTo?: string;
      marks?: TextMark[];
      attachments?: ChatAttachment[];
    },
  ): Promise<string> {
    const result = await this.mutate("send", {
      chatId,
      text: input.text,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.marks?.length ? { marks: input.marks } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    });
    if (!result.messageId) throw new Error("Heart returned no messageId");
    return result.messageId;
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    marks?: TextMark[],
    attachments?: ChatAttachment[],
  ): Promise<void> {
    await this.mutate("edit", {
      chatId,
      messageId,
      text,
      marks: marks ?? [],
      attachments: attachments ?? [],
    });
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    await this.mutate("delete", { chatId, messageId });
  }

  private async mutate(
    action: "send" | "edit" | "delete",
    input: Record<string, unknown>,
  ): Promise<{ messageId?: string }> {
    const { command, grpcAddress } = this.config.anytype.heartAdapter;
    const args = [action, "--grpc-address", grpcAddress];
    if (this.config.anytype.cli.configPath)
      args.push("--config", this.config.anytype.cli.configPath);
    const { stdout } = await runProcess(command, args, {
      stdin: `${JSON.stringify(input)}\n`,
      timeoutMs: 30_000,
    });
    return stdout.trim() ? (JSON.parse(stdout) as { messageId?: string }) : {};
  }
}

export class DiscussionAnytypePort implements AnytypePort {
  constructor(
    private readonly base: AnytypePort,
    private readonly heart: HeartDiscussionAdapter,
  ) {}

  async getMessage(spaceId: string, chatId: string, messageId: string): Promise<ChatMessage> {
    const message = await this.base.getMessage(spaceId, chatId, messageId);
    return (await this.heart.hydrateMessages(chatId, [message]))[0] ?? message;
  }
  async listMessages(
    spaceId: string,
    chatId: string,
    limit: number,
    afterOrderId?: string,
  ): Promise<ChatMessage[]> {
    return this.heart.hydrateMessages(
      chatId,
      await this.base.listMessages(spaceId, chatId, limit, afterOrderId),
    );
  }
  async sendMessage(
    _spaceId: string,
    chatId: string,
    input: {
      text: string;
      replyTo?: string;
      marks?: TextMark[];
      attachments?: ChatAttachment[];
    },
  ): Promise<string> {
    return this.heart.sendMessage(chatId, input);
  }
  async editMessage(
    _spaceId: string,
    chatId: string,
    messageId: string,
    text: string,
    marks?: TextMark[],
    attachments?: ChatAttachment[],
  ): Promise<void> {
    await this.heart.editMessage(chatId, messageId, text, marks, attachments);
  }
  async deleteMessage(_spaceId: string, chatId: string, messageId: string): Promise<void> {
    await this.heart.deleteMessage(chatId, messageId);
  }
  async ensureReaction(
    spaceId: string,
    chatId: string,
    messageId: string,
    emoji: string,
    present: boolean,
    participantId?: string,
  ): Promise<void> {
    await this.base.ensureReaction(spaceId, chatId, messageId, emoji, present, participantId);
  }
  async *stream(spaceId: string, chatId: string, signal: AbortSignal): AsyncIterable<AnytypeEvent> {
    for await (const event of this.base.stream(spaceId, chatId, signal)) {
      const message = event.payload?.message;
      if (!message) {
        yield event;
        continue;
      }
      const hydrated = (await this.heart.hydrateMessages(chatId, [message]))[0] ?? message;
      yield { ...event, payload: { ...event.payload, message: hydrated } };
    }
  }
  async resolveSpace(selector: {
    id?: string;
    name?: string;
  }): Promise<{ id: string; name: string }> {
    return this.base.resolveSpace(selector);
  }
  async listSpaces(): Promise<AnytypeSpace[]> {
    return this.base.listSpaces();
  }
  async listMembers(spaceId: string): Promise<AnytypeMember[]> {
    return this.base.listMembers(spaceId);
  }
  async resolveChat(
    spaceId: string,
    selector: { id?: string; name?: string },
  ): Promise<{ id: string; name: string }> {
    return this.base.resolveChat(spaceId, selector);
  }
  async listChats(spaceId: string): Promise<Array<{ id: string; name: string }>> {
    return this.base.listChats(spaceId);
  }
  async getObject(
    spaceId: string,
    objectId: string,
  ): Promise<{ id: string; name?: string; markdown?: string }> {
    return this.base.getObject(spaceId, objectId);
  }
  async listPropertyTags(spaceId: string, propertyId: string): Promise<AnytypeTag[]> {
    return this.base.listPropertyTags(spaceId, propertyId);
  }

  async listProperties(spaceId: string): Promise<Record<string, unknown>[]> {
    return this.base.listProperties ? this.base.listProperties(spaceId) : [];
  }
  async createPropertyTag(
    spaceId: string,
    propertyId: string,
    input: { name: string; color: string },
  ): Promise<AnytypeTag> {
    return this.base.createPropertyTag(spaceId, propertyId, input);
  }
  async updateObject(
    spaceId: string,
    objectId: string,
    input: { properties: Array<{ key: string; multi_select: string[] }> },
  ): Promise<Record<string, unknown>> {
    return this.base.updateObject(spaceId, objectId, input);
  }
  async downloadFile(
    spaceId: string,
    fileId: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; contentType?: string }> {
    if (!this.base.downloadFile)
      throw new Error("Anytype attachment downloads are unavailable for this discussion");
    return this.base.downloadFile(spaceId, fileId, maxBytes);
  }
  async searchObjects(
    spaceId: string,
    offset: number,
    limit: number,
  ): Promise<Array<{ id: string; name?: string; type?: string }>> {
    return this.base.searchObjects(spaceId, offset, limit);
  }
}

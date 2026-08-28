import type { AgentConfig } from "./config.js";
import { runProcess } from "./process.js";
import type { ChatMessage } from "./types.js";

export type DiscussionResolution = { objectId: string; discussionId?: string; error?: string };

export class HeartDiscussionAdapter {
  constructor(private readonly config: AgentConfig) {}

  async resolve(spaceId: string, objects: Array<{ id: string }>, createMissing: boolean): Promise<DiscussionResolution[]> {
    if (!objects.length) return [];
    const { command, grpcAddress } = this.config.anytype.heartAdapter;
    const args = ["resolve", "--space-id", spaceId, "--grpc-address", grpcAddress, ...(createMissing ? ["--create-missing"] : [])];
    if (this.config.anytype.cli.configPath) args.push("--config", this.config.anytype.cli.configPath);
    const { stdout } = await runProcess(command, args, { stdin: `${JSON.stringify({ objectIds: objects.map(object => object.id) })}\n`, timeoutMs: Math.max(30_000, objects.length * 12_000) });
    const result = JSON.parse(stdout) as { discussions: DiscussionResolution[] };
    return result.discussions;
  }

  async hydrateMessages(chatId: string, messages: ChatMessage[]): Promise<ChatMessage[]> {
    const pending = messages.filter(message => !message.content?.text);
    if (!pending.length) return messages;
    const { command, grpcAddress } = this.config.anytype.heartAdapter;
    const args = ["hydrate", "--grpc-address", grpcAddress];
    if (this.config.anytype.cli.configPath) args.push("--config", this.config.anytype.cli.configPath);
    const { stdout } = await runProcess(command, args, {
      stdin: `${JSON.stringify({ chatId, messageIds: pending.map(message => message.id) })}\n`,
      timeoutMs: Math.max(30_000, pending.length * 2_000)
    });
    const result = JSON.parse(stdout) as { messages: ChatMessage[] };
    const hydrated = new Map(result.messages.map(message => [message.id, message]));
    return messages.map(message => {
      const full = hydrated.get(message.id);
      if (!full) return message;
      const content = full.content?.text || full.content?.marks?.length ? full.content : message.content;
      return {
        ...full,
        ...message,
        ...(content ? { content } : {}),
        ...(full.mentioned ? { mentioned: true } : {})
      };
    });
  }
}

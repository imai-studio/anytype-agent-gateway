import type { AgentConfig } from "./config.js";
import type { AnytypePort, ConversationRef, RuntimeEvent, RuntimeResult, TextMark } from "./types.js";

export class RunProjection {
  private responseId: string;
  private reactionTargetId: string;
  private text = "";
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private writes: Promise<unknown> = Promise.resolve();

  private constructor(private readonly anytype: AnytypePort, private readonly config: AgentConfig, private readonly conversation: ConversationRef, responseId: string, reactionTargetId: string) {
    this.responseId = responseId;
    this.reactionTargetId = reactionTargetId;
  }

  static async create(anytype: AnytypePort, config: AgentConfig, conversation: ConversationRef, triggerId: string): Promise<RunProjection> {
    const responseId = await anytype.sendMessage(conversation.spaceId, conversation.chatId, { text: config.responses.workingText, replyTo: triggerId });
    const projection = new RunProjection(anytype, config, conversation, responseId, triggerId);
    await anytype.ensureReaction(conversation.spaceId, conversation.chatId, triggerId, config.responses.workingReaction, true);
    return projection;
  }

  static async resume(anytype: AnytypePort, config: AgentConfig, conversation: ConversationRef, responseId: string, triggerId: string, text = ""): Promise<RunProjection> {
    const projection = new RunProjection(anytype, config, conversation, responseId, triggerId);
    projection.text = text === config.responses.workingText ? "" : text;
    await anytype.ensureReaction(conversation.spaceId, conversation.chatId, triggerId, config.responses.workingReaction, true);
    return projection;
  }

  get messageId(): string { return this.responseId; }

  async move(triggerId: string): Promise<string> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    return this.enqueue(async () => {
      const previousId = this.responseId;
      await this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, previousId, this.currentDisplay());
      await this.anytype.ensureReaction(this.conversation.spaceId, this.conversation.chatId, this.reactionTargetId, this.config.responses.workingReaction, false);
      this.responseId = await this.anytype.sendMessage(this.conversation.spaceId, this.conversation.chatId, { text: this.currentDisplay(), replyTo: triggerId });
      this.reactionTargetId = triggerId;
      await this.anytype.ensureReaction(this.conversation.spaceId, this.conversation.chatId, this.reactionTargetId, this.config.responses.workingReaction, true);
      return this.responseId;
    });
  }

  onEvent(event: RuntimeEvent): void {
    if (this.closed) return;
    if (event.type === "text-delta") {
      this.text += event.text;
      if (this.config.responses.streaming) this.schedule();
    } else if (event.type === "tool" && this.config.responses.mode !== "single") {
      this.text = `${this.text.trimEnd()}\n\n${event.status === "completed" ? "✓" : "↻"} ${event.name}`.trim();
      this.schedule();
    } else if (event.type === "status" && this.config.responses.mode === "verbose" && event.text) {
      this.text = `${this.text.trimEnd()}\n\n${event.text}`.trim();
      this.schedule();
    }
  }

  async finish(result: RuntimeResult): Promise<"done" | "silent"> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    return this.enqueue(async () => {
      await this.anytype.ensureReaction(this.conversation.spaceId, this.conversation.chatId, this.reactionTargetId, this.config.responses.workingReaction, false);
      if (result.silent) {
        if (this.config.responses.silentPlaceholder === "delete") await this.anytype.deleteMessage(this.conversation.spaceId, this.conversation.chatId, this.responseId);
        else if (this.config.responses.silentPlaceholder === "replace") await this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, this.responseId, this.config.responses.silentText);
        return "silent" as const;
      }
      const rendered = renderCoordination(result.text || this.text || "Completed without a text response.", this.config);
      const finalText = truncateResponse(rendered.text, this.config.responses.maxCharacters);
      const marks = rendered.marks.filter(mark => (mark.to ?? 0) <= finalText.length);
      await this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, this.responseId, finalText, marks);
      return "done" as const;
    });
  }

  async fail(error: unknown): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.enqueue(async () => {
      await this.anytype.ensureReaction(this.conversation.spaceId, this.conversation.chatId, this.reactionTargetId, this.config.responses.workingReaction, false).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      await this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, this.responseId, `Agent run failed: ${message.slice(0, 1000)}`);
    });
  }

  async interrupt(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.enqueue(async () => {
      await this.anytype.ensureReaction(this.conversation.spaceId, this.conversation.chatId, this.reactionTargetId, this.config.responses.workingReaction, false).catch(() => undefined);
      await this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, this.responseId, "Agent run interrupted before completion.");
    });
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => undefined);
    }, 900);
  }

  private currentDisplay(): string { return (this.text || this.config.responses.workingText).slice(0, this.config.responses.maxCharacters); }
  private async flush(): Promise<void> {
    if (this.closed) return;
    const responseId = this.responseId;
    await this.enqueue(() => this.closed ? Promise.resolve() : this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, responseId, this.currentDisplay()));
  }

  private enqueue<T>(write: () => Promise<T>): Promise<T> {
    const next = this.writes.then(write, write);
    this.writes = next.catch(() => undefined);
    return next;
  }
}

function truncateResponse(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  const notice = "\n\n[Response truncated by AAG]";
  let prefix = text.slice(0, Math.max(0, maxCharacters - notice.length));
  if (prefix && /[\uD800-\uDBFF]/.test(prefix.at(-1)!)) prefix = prefix.slice(0, -1);
  return `${prefix}${notice}`;
}

export function renderCoordination(text: string, config: AgentConfig): { text: string; marks: TextMark[] } {
  const peers = new Map<string, AgentConfig["coordination"]["peers"][number]>();
  for (const peer of config.coordination.peers) for (const name of [peer.name, ...peer.aliases]) peers.set(name.toLocaleLowerCase(), peer);
  const marks: TextMark[] = [];
  const tagged = new Set<string>();
  const matcher = /\[\[AAG_MENTION:([^\]\n]+)\]\]/gi;
  let rendered = "";
  let cursor = 0;
  for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
    rendered += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const peer = peers.get((match[1] ?? "").trim().replace(/^@/, "").toLocaleLowerCase());
    if (!peer || (!tagged.has(peer.participantId) && tagged.size >= config.coordination.maxFanout)) { rendered += match[0]; continue; }
    const mention = `@${peer.name}`;
    if (!tagged.has(peer.participantId)) {
      marks.push({ type: "mention", from: rendered.length, to: rendered.length + mention.length, param: peer.participantId });
      tagged.add(peer.participantId);
    }
    rendered += mention;
  }
  rendered += text.slice(cursor);
  return { text: rendered, marks };
}

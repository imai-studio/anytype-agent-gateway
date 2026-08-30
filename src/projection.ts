import type { AgentConfig } from "./config.js";
import type {
  AnytypePort,
  ChatAttachment,
  ConversationRef,
  RuntimeEvent,
  RuntimeResult,
  TextMark,
} from "./types.js";
import { mentionMarker, objectCardMarker, objectMarker, replyMarker } from "./protocol-markers.js";

type CycleState = "transient" | "thinking" | "text";

type OutputCycle = {
  id: string;
  state: CycleState;
  sourceId: string | undefined;
  text: string;
  activities?: string[];
  replyToMessageId?: string;
  messageId?: string;
  completed: boolean;
  deleted?: boolean;
  failed?: boolean;
};

export type ProjectionCycleSnapshot = {
  id: string;
  messageId: string;
  replyToMessageId?: string;
  phase: "working" | "thinking" | "answer" | "error";
  state: "open" | "complete" | "failed" | "deleted";
  text: string;
};

export class RunProjection {
  private responseId: string;
  private reactionTargetId: string;
  private replyTargetId: string | undefined;
  private readonly triggerReplyTargetId: string;
  private readonly cycles: OutputCycle[] = [];
  private activeCycle: OutputCycle;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private writes: Promise<unknown> = Promise.resolve();
  private onMessage: ((messageId: string) => void) | undefined;
  private onCycle: ((cycle: ProjectionCycleSnapshot) => void) | undefined;
  private readonly createdMessageIds = new Set<string>();
  private readonly mentionTargets = new Map<string, { name: string; participantId: string }>();

  private constructor(
    private readonly anytype: AnytypePort,
    private readonly config: AgentConfig,
    private readonly conversation: ConversationRef,
    responseId: string,
    reactionTargetId: string,
    replyTargetId: string | undefined,
    triggerReplyTargetId: string,
    mentionTargets: Array<{ name: string; participantId: string }> = [],
  ) {
    this.responseId = responseId;
    this.reactionTargetId = reactionTargetId;
    this.replyTargetId = replyTargetId;
    this.triggerReplyTargetId = triggerReplyTargetId;
    this.activeCycle = {
      id: crypto.randomUUID(),
      state: "transient",
      sourceId: undefined,
      text: config.responses.workingText,
      ...(replyTargetId ? { replyToMessageId: replyTargetId } : {}),
      messageId: responseId,
      completed: false,
    };
    this.cycles.push(this.activeCycle);
    this.createdMessageIds.add(responseId);
    this.addMentionTargets(mentionTargets);
  }

  static async create(
    anytype: AnytypePort,
    config: AgentConfig,
    conversation: ConversationRef,
    triggerId: string,
    replyTargetId?: string,
    mentionTargets: Array<{ name: string; participantId: string }> = [],
  ): Promise<RunProjection> {
    await anytype.ensureReaction(
      conversation.spaceId,
      conversation.chatId,
      triggerId,
      config.responses.workingReaction,
      true,
      conversation.selfParticipantId,
    );
    try {
      const responseId = await anytype.sendMessage(conversation.spaceId, conversation.chatId, {
        text: config.responses.workingText,
        ...(replyTargetId ? { replyTo: replyTargetId } : {}),
      });
      return new RunProjection(
        anytype,
        config,
        conversation,
        responseId,
        triggerId,
        replyTargetId,
        triggerId,
        mentionTargets,
      );
    } catch (error) {
      await anytype
        .ensureReaction(
          conversation.spaceId,
          conversation.chatId,
          triggerId,
          config.responses.workingReaction,
          false,
          conversation.selfParticipantId,
        )
        .catch(() => undefined);
      throw error;
    }
  }

  static async resume(
    anytype: AnytypePort,
    config: AgentConfig,
    conversation: ConversationRef,
    responseId: string,
    triggerId: string,
    replyTargetId: string | undefined,
    text = "",
    mentionTargets: Array<{ name: string; participantId: string }> = [],
  ): Promise<RunProjection> {
    const projection = new RunProjection(
      anytype,
      config,
      conversation,
      responseId,
      triggerId,
      replyTargetId,
      triggerId,
      mentionTargets,
    );
    if (text && text !== config.responses.workingText) {
      projection.activeCycle.state = "text";
      projection.activeCycle.text = text;
    }
    await anytype.ensureReaction(
      conversation.spaceId,
      conversation.chatId,
      triggerId,
      config.responses.workingReaction,
      true,
      conversation.selfParticipantId,
    );
    return projection;
  }

  get messageId(): string {
    return this.responseId;
  }

  trackMessages(callback: (messageId: string) => void): void {
    this.onMessage = callback;
    for (const messageId of this.createdMessageIds) callback(messageId);
  }

  trackCycles(callback: (cycle: ProjectionCycleSnapshot) => void): void {
    this.onCycle = callback;
    for (const cycle of this.cycles) this.emitCycle(cycle);
  }

  addMentionTargets(targets: Array<{ name: string; participantId: string }>): void {
    for (const target of targets) this.mentionTargets.set(target.participantId, target);
  }

  async move(triggerId: string, replyTargetId?: string): Promise<string> {
    this.cancelScheduledEdit();
    return this.enqueue(async () => {
      const previous = this.activeCycle;
      if (previous.state === "text") {
        previous.completed = true;
        await this.editCycleNow(previous);
        this.emitCycle(previous);
      } else if (previous.messageId && !previous.deleted) {
        await this.anytype.deleteMessage(
          this.conversation.spaceId,
          this.conversation.chatId,
          previous.messageId,
        );
        previous.deleted = true;
        this.emitCycle(previous);
      }
      await this.setWorkingReaction(this.reactionTargetId, false);
      this.replyTargetId = replyTargetId;
      this.reactionTargetId = triggerId;
      const cycle: OutputCycle = {
        id: crypto.randomUUID(),
        state: "transient",
        sourceId: undefined,
        text: this.config.responses.workingText,
        ...(replyTargetId ? { replyToMessageId: replyTargetId } : {}),
        completed: false,
      };
      this.cycles.push(cycle);
      this.activeCycle = cycle;
      await this.createCycleMessageNow(cycle);
      await this.setWorkingReaction(this.reactionTargetId, true);
      return this.responseId;
    });
  }

  onEvent(event: RuntimeEvent): void {
    if (this.closed) return;
    if (event.type === "text-delta") {
      this.updateText(event.text, event.partId ?? event.phase, event.replace === true);
    } else if (event.type === "thinking-delta" && this.config.responses.thinking === "stream") {
      this.updateThinking(event.text, event.partId, event.replace === true);
    } else if (event.type === "tool" && this.config.responses.mode !== "single") {
      this.updateActivity(event.name, event.status);
    } else if (event.type === "status" && this.config.responses.mode === "verbose" && event.text) {
      this.updateTransient(event.text);
    }
  }

  async finish(result: RuntimeResult): Promise<"done" | "silent"> {
    this.closed = true;
    this.cancelScheduledEdit();
    return this.enqueue(async () => {
      await this.setWorkingReaction(this.reactionTargetId, false);
      if (result.silent) {
        if (this.config.responses.silentPlaceholder === "delete")
          for (const cycle of this.cycles) {
            if (!cycle.messageId || cycle.deleted) continue;
            await this.anytype.deleteMessage(
              this.conversation.spaceId,
              this.conversation.chatId,
              cycle.messageId,
            );
            cycle.deleted = true;
            this.emitCycle(cycle);
          }
        else if (this.config.responses.silentPlaceholder === "replace") {
          await this.anytype.editMessage(
            this.conversation.spaceId,
            this.conversation.chatId,
            this.responseId,
            this.config.responses.silentText,
          );
          for (const cycle of this.cycles) {
            if (!cycle.messageId || cycle.messageId === this.responseId || cycle.deleted) continue;
            await this.anytype.deleteMessage(
              this.conversation.spaceId,
              this.conversation.chatId,
              cycle.messageId,
            );
            cycle.deleted = true;
            this.emitCycle(cycle);
          }
        } else if (this.activeCycle.state !== "text" && this.activeCycle.messageId) {
          this.activeCycle.state = "transient";
          this.activeCycle.text = this.config.responses.workingText;
          await this.editCycleNow(this.activeCycle);
        }
        for (const cycle of this.cycles) {
          if (cycle.deleted) continue;
          cycle.completed = true;
          this.emitCycle(cycle);
        }
        return "silent" as const;
      }
      const textCycles = this.cycles.filter((cycle) => cycle.state === "text" && !cycle.deleted);
      if (this.activeCycle.state !== "text") {
        const streamed = textCycles
          .map((cycle) => cycle.text.trim())
          .filter(Boolean)
          .join("\n\n");
        const terminal = result.text.trim();
        const tail =
          streamed && terminal.startsWith(streamed)
            ? terminal.slice(streamed.length).trim()
            : terminal;
        if (textCycles.length > 0 && (!tail || sameRenderedText(streamed, terminal))) {
          if (this.activeCycle.messageId && !this.activeCycle.deleted)
            await this.anytype.deleteMessage(
              this.conversation.spaceId,
              this.conversation.chatId,
              this.activeCycle.messageId,
            );
          this.activeCycle.deleted = true;
        } else {
          this.activeCycle.state = "text";
          this.activeCycle.sourceId = "terminal-result";
          this.activeCycle.text = tail || "Completed without a text response.";
        }
      } else if (result.text && textCycles.length === 1) {
        this.activeCycle.text = result.text;
      } else if (
        result.text &&
        textCycles.length > 1 &&
        !textCycles.some((cycle) => sameRenderedText(cycle.text, result.text))
      ) {
        const joined = textCycles
          .map((cycle) => cycle.text.trim())
          .filter(Boolean)
          .join("\n\n");
        const last = textCycles.at(-1)!;
        if (sameRenderedText(joined, result.text)) {
          // The runtime returned all streamed text parts flattened together.
        } else if (result.text.startsWith(last.text) || last.text.startsWith(result.text)) {
          last.text = result.text;
        }
      }
      this.activeCycle.completed = true;
      this.emitCycle(this.activeCycle);
      for (const cycle of this.cycles) {
        if (cycle.state === "text" && !cycle.deleted) await this.editCycleNow(cycle);
      }
      return "done" as const;
    });
  }

  async fail(error: unknown): Promise<void> {
    this.closed = true;
    this.cancelScheduledEdit();
    await this.enqueue(async () => {
      await this.setWorkingReaction(this.reactionTargetId, false).catch(() => undefined);
      if (this.activeCycle.state === "text") await this.editCycleNow(this.activeCycle);
      const message = error instanceof Error ? error.message : String(error);
      await this.writeTerminalNotice(`Agent run failed: ${message.slice(0, 1000)}`);
      this.activeCycle.failed = true;
      this.emitCycle(this.activeCycle);
    });
  }

  async interrupt(message = "Agent run interrupted before completion."): Promise<void> {
    this.closed = true;
    this.cancelScheduledEdit();
    await this.enqueue(async () => {
      await this.setWorkingReaction(this.reactionTargetId, false).catch(() => undefined);
      if (this.activeCycle.state === "text") await this.editCycleNow(this.activeCycle);
      await this.writeTerminalNotice(message);
      this.activeCycle.failed = true;
      this.emitCycle(this.activeCycle);
    });
  }

  private updateText(text: string, sourceId: string | undefined, replace: boolean): void {
    if (!text && !replace) return;
    const current = this.activeCycle;
    if (current.state === "transient" || current.state === "thinking") {
      current.state = "text";
      current.sourceId = sourceId;
      current.text = text;
      this.emitCycle(current);
      if (this.config.responses.streaming) this.schedule(current);
      return;
    }
    const continues = current.state === "text" && current.sourceId === sourceId;
    if (continues) {
      current.text = replace ? text : `${current.text}${text}`;
      this.emitCycle(current);
      if (this.config.responses.streaming) this.schedule(current);
      return;
    }
    this.startCycle({
      id: crypto.randomUUID(),
      state: "text",
      sourceId,
      text,
      ...(this.replyTargetId ? { replyToMessageId: this.replyTargetId } : {}),
      completed: false,
    });
  }

  private updateThinking(text: string, sourceId: string | undefined, replace: boolean): void {
    if (!text && !replace) return;
    const current = this.activeCycle;
    if (current.state === "text") {
      this.startCycle({
        id: crypto.randomUUID(),
        state: "thinking",
        sourceId,
        text,
        ...(this.replyTargetId ? { replyToMessageId: this.replyTargetId } : {}),
        completed: false,
      });
      return;
    }
    if (current.state === "transient") {
      current.state = "thinking";
      current.sourceId = sourceId;
      current.text = text;
    } else if (replace) {
      current.sourceId = sourceId ?? current.sourceId;
      current.text = text;
    } else {
      current.text = `${current.text}${text}`;
    }
    this.emitCycle(current);
    if (this.config.responses.streaming) this.schedule(current);
  }

  private updateTransient(text: string): void {
    if (this.activeCycle.state !== "transient") return;
    this.activeCycle.text = text;
    this.emitCycle(this.activeCycle);
    if (this.config.responses.streaming) this.schedule(this.activeCycle);
  }

  private updateActivity(name: string, status: string): void {
    if (this.activeCycle.state === "text") return;
    const title = compactActivityLine(name);
    if (!title) return;
    const line = `${status === "completed" ? "✓" : "•"} ${title}`;
    const activities = this.activeCycle.activities ?? [];
    const existing = activities.findIndex((item) => item.slice(2) === title);
    if (existing >= 0) activities[existing] = line;
    else activities.push(line);
    this.activeCycle.activities = activities.slice(-4);
    this.emitCycle(this.activeCycle);
    if (this.config.responses.streaming) this.schedule(this.activeCycle);
  }

  private startCycle(cycle: OutputCycle): void {
    this.cancelScheduledEdit();
    this.activeCycle.completed = true;
    this.emitCycle(this.activeCycle);
    if (this.config.responses.streaming)
      void this.flushCycle(this.activeCycle).catch(() => undefined);
    this.cycles.push(cycle);
    this.activeCycle = cycle;
    if (this.config.responses.streaming)
      void this.enqueue(() => this.createCycleMessageNow(cycle)).catch(() => undefined);
  }

  private schedule(cycle: OutputCycle): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushCycle(cycle).catch(() => undefined);
    }, this.config.responses.editIntervalMilliseconds);
  }

  private cancelScheduledEdit(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private currentDisplay(cycle = this.activeCycle): {
    text: string;
    marks: TextMark[];
    attachments: ChatAttachment[];
  } {
    const raw = stripNativeReplyDirective(cycle.text) || this.config.responses.workingText;
    const labeled =
      cycle.state === "thinking"
        ? activityDisplay(raw, cycle.activities ?? [], this.config.responses.workingText)
        : cycle.state === "transient" && cycle.activities?.length
          ? activityDisplay("", cycle.activities, this.config.responses.workingText)
          : raw;
    const rendered = renderForAnytype(labeled, this.config, [...this.mentionTargets.values()]);
    return truncateRendered(rendered, this.config.responses.maxCharacters);
  }

  private setWorkingReaction(messageId: string, present: boolean): Promise<void> {
    return this.anytype.ensureReaction(
      this.conversation.spaceId,
      this.conversation.chatId,
      messageId,
      this.config.responses.workingReaction,
      present,
      this.conversation.selfParticipantId,
    );
  }

  private async flushCycle(cycle: OutputCycle): Promise<void> {
    await this.enqueue(() => this.editCycleNow(cycle));
  }

  private async editCycleNow(cycle: OutputCycle): Promise<void> {
    if (cycle.deleted) return;
    if (!cycle.replyToMessageId && cycle.state === "text" && requestsNativeReply(cycle.text)) {
      cycle.replyToMessageId = this.triggerReplyTargetId;
      if (cycle.messageId) {
        await this.anytype.deleteMessage(
          this.conversation.spaceId,
          this.conversation.chatId,
          cycle.messageId,
        );
        delete cycle.messageId;
      }
    }
    if (!cycle.messageId) {
      await this.createCycleMessageNow(cycle);
      return;
    }
    const current = this.currentDisplay(cycle);
    await this.anytype.editMessage(
      this.conversation.spaceId,
      this.conversation.chatId,
      cycle.messageId,
      current.text,
      current.marks,
      current.attachments,
    );
  }

  private async createCycleMessageNow(cycle: OutputCycle): Promise<void> {
    if (cycle.messageId || cycle.deleted) return;
    const current = this.currentDisplay(cycle);
    cycle.messageId = await this.anytype.sendMessage(
      this.conversation.spaceId,
      this.conversation.chatId,
      {
        text: current.text,
        marks: current.marks,
        attachments: current.attachments,
        ...(cycle.replyToMessageId ? { replyTo: cycle.replyToMessageId } : {}),
      },
    );
    this.responseId = cycle.messageId;
    this.createdMessageIds.add(cycle.messageId);
    this.onMessage?.(cycle.messageId);
    this.emitCycle(cycle);
  }

  private async writeTerminalNotice(text: string): Promise<void> {
    if (this.activeCycle.state !== "text" && !this.activeCycle.deleted) {
      this.activeCycle.state = "transient";
      this.activeCycle.text = text;
      this.activeCycle.activities = [];
      await this.editCycleNow(this.activeCycle);
      return;
    }
    this.activeCycle.completed = true;
    this.emitCycle(this.activeCycle);
    const messageId = await this.anytype.sendMessage(
      this.conversation.spaceId,
      this.conversation.chatId,
      { text, ...(this.replyTargetId ? { replyTo: this.replyTargetId } : {}) },
    );
    const cycle: OutputCycle = {
      id: crypto.randomUUID(),
      state: "transient",
      sourceId: "terminal-notice",
      text,
      ...(this.replyTargetId ? { replyToMessageId: this.replyTargetId } : {}),
      messageId,
      completed: false,
      failed: true,
    };
    this.cycles.push(cycle);
    this.activeCycle = cycle;
    this.responseId = messageId;
    this.createdMessageIds.add(messageId);
    this.onMessage?.(messageId);
    this.emitCycle(cycle);
  }

  private enqueue<T>(write: () => Promise<T>): Promise<T> {
    const next = this.writes.then(write, write);
    this.writes = next.catch(() => undefined);
    return next;
  }

  private emitCycle(cycle: OutputCycle): void {
    if (!this.onCycle || !cycle.messageId) return;
    this.onCycle({
      id: cycle.id,
      messageId: cycle.messageId,
      ...(cycle.replyToMessageId ? { replyToMessageId: cycle.replyToMessageId } : {}),
      phase: cycle.failed
        ? "error"
        : cycle.state === "thinking"
          ? "thinking"
          : cycle.state === "text"
            ? "answer"
            : "working",
      state: cycle.deleted
        ? "deleted"
        : cycle.failed
          ? "failed"
          : cycle.completed
            ? "complete"
            : "open",
      text: cycle.text,
    });
  }
}

const nativeReplyDirective = replyMarker;

function requestsNativeReply(text: string): boolean {
  return nativeReplyDirective.test(text);
}

function stripNativeReplyDirective(text: string): string {
  return text.replace(nativeReplyDirective, "");
}

function sameRenderedText(left: string, right: string): boolean {
  return left.trim().replace(/\s+/g, " ") === right.trim().replace(/\s+/g, " ");
}

function truncateRendered(
  rendered: { text: string; marks: TextMark[]; attachments: ChatAttachment[] },
  maxCharacters: number,
): { text: string; marks: TextMark[]; attachments: ChatAttachment[] } {
  if (rendered.text.length <= maxCharacters)
    return {
      text: rendered.text,
      marks: clampMarks(rendered.marks, rendered.text.length),
      attachments: rendered.attachments,
    };
  const notice = "\n\n[Response truncated by Knot]";
  let prefix = rendered.text.slice(0, Math.max(0, maxCharacters - notice.length));
  if (prefix && /[\uD800-\uDBFF]/.test(prefix.at(-1)!)) prefix = prefix.slice(0, -1);
  return {
    text: `${prefix}${notice}`,
    marks: clampMarks(rendered.marks, prefix.length),
    attachments: rendered.attachments,
  };
}

function clampMarks(marks: TextMark[], contentLength: number): TextMark[] {
  return marks.flatMap((mark) => {
    if (mark.from === undefined || mark.to === undefined) return [];
    const from = Math.max(0, Math.min(mark.from, contentLength));
    const to = Math.max(from, Math.min(mark.to, contentLength));
    return to > from ? [{ ...mark, from, to }] : [];
  });
}

export function renderCoordination(
  text: string,
  config: AgentConfig,
  dynamicTargets: Array<{ name: string; participantId: string }> = [],
): { text: string; marks: TextMark[] } {
  const peers = new Map<string, AgentConfig["coordination"]["peers"][number]>();
  for (const peer of config.coordination.peers)
    for (const name of [peer.name, ...peer.aliases]) peers.set(name.toLocaleLowerCase(), peer);
  for (const target of dynamicTargets)
    peers.set(target.name.toLocaleLowerCase(), {
      name: target.name,
      participantId: target.participantId,
      aliases: [],
    });
  const marks: TextMark[] = [];
  const tagged = new Set<string>();
  const matcher = new RegExp(mentionMarker.source, mentionMarker.flags);
  let rendered = "";
  let cursor = 0;
  for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
    rendered += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const peer = peers.get((match[1] ?? "").trim().replace(/^@/, "").toLocaleLowerCase());
    if (
      !peer ||
      (!tagged.has(peer.participantId) && tagged.size >= config.coordination.maxFanout)
    ) {
      rendered += match[0];
      continue;
    }
    const mention = `@${peer.name}`;
    if (!tagged.has(peer.participantId)) {
      marks.push({
        type: "mention",
        from: rendered.length,
        to: rendered.length + mention.length,
        param: peer.participantId,
      });
      tagged.add(peer.participantId);
    }
    rendered += mention;
  }
  rendered += text.slice(cursor);
  const occupied = marks.map((mark) => [mark.from ?? 0, mark.to ?? 0] as const);
  const uniqueTargets = new Map(
    [...peers.values()].map((target) => [target.participantId, target]),
  );
  for (const target of uniqueTargets.values()) {
    const matcher = new RegExp(`@${escapeRegExp(target.name)}(?![\\p{L}\\p{N}_])`, "giu");
    for (let match = matcher.exec(rendered); match; match = matcher.exec(rendered)) {
      const from = match.index;
      const to = from + match[0].length;
      if (occupied.some(([occupiedFrom, occupiedTo]) => from < occupiedTo && to > occupiedFrom))
        continue;
      if (!tagged.has(target.participantId) && tagged.size >= config.coordination.maxFanout)
        continue;
      marks.push({ type: "mention", from, to, param: target.participantId });
      tagged.add(target.participantId);
      occupied.push([from, to]);
    }
  }
  return { text: rendered, marks };
}

export function renderForAnytype(
  text: string,
  config: AgentConfig,
  dynamicTargets: Array<{ name: string; participantId: string }> = [],
): { text: string; marks: TextMark[]; attachments: ChatAttachment[] } {
  const coordinated = renderCoordination(text, config, dynamicTargets);
  return normalizeMarkdown(coordinated.text, coordinated.marks);
}

function normalizeMarkdown(
  text: string,
  existingMarks: TextMark[],
): { text: string; marks: TextMark[]; attachments: ChatAttachment[] } {
  let output = "";
  const marks: TextMark[] = [];
  const attachments: ChatAttachment[] = [];
  const attachedObjects = new Set<string>();
  const boundaries = new Array<number>(text.length + 1).fill(0);
  let index = 0;
  while (index < text.length) {
    boundaries[index] = output.length;
    const lineStart = index === 0 || text[index - 1] === "\n";
    if (lineStart) {
      const heading = /^(#{1,6})\s+/.exec(text.slice(index));
      if (heading) {
        for (let offset = 0; offset < heading[0].length; offset += 1)
          boundaries[index + offset] = output.length;
        index += heading[0].length;
        continue;
      }
      if (
        (text.startsWith("- ", index) || text.startsWith("* ", index)) &&
        !text.startsWith("**", index)
      ) {
        boundaries[index] = output.length;
        boundaries[index + 1] = output.length + 1;
        output += "• ";
        index += 2;
        continue;
      }
    }
    if (text.startsWith("```", index)) {
      const header = /^```[^\n`]*\n/.exec(text.slice(index));
      const contentStart = index + (header?.[0].length ?? 3);
      const closeAt = text.indexOf("```", contentStart);
      if (closeAt >= contentStart) {
        const rawContent = text.slice(contentStart, closeAt);
        const content = rawContent.endsWith("\n") ? rawContent.slice(0, -1) : rawContent;
        for (let offset = index; offset < contentStart; offset += 1)
          boundaries[offset] = output.length;
        const from = output.length;
        output += content;
        for (let offset = 0; offset <= rawContent.length; offset += 1)
          boundaries[contentStart + offset] = from + Math.min(offset, content.length);
        if (content) marks.push({ type: "keyboard", from, to: output.length });
        for (let offset = 0; offset < 3; offset += 1) boundaries[closeAt + offset] = output.length;
        index = closeAt + 3;
        continue;
      }
    }
    const objectCard = objectCardMarker.exec(text.slice(index));
    if (objectCard) {
      const objectId = objectCard[1]!.trim();
      const label = objectCard[2]!.trim();
      output += label;
      if (!attachedObjects.has(objectId)) {
        attachments.push({ target: objectId, type: "file" });
        attachedObjects.add(objectId);
      }
      for (let offset = 0; offset < objectCard[0].length; offset += 1)
        boundaries[index + offset] = output.length;
      index += objectCard[0].length;
      continue;
    }
    const objectReference = objectMarker.exec(text.slice(index));
    if (objectReference) {
      const objectId = objectReference[1]!.trim();
      const label = objectReference[2]!.trim();
      const from = output.length;
      output += label;
      marks.push({ type: "object", from, to: output.length, param: objectId });
      for (let offset = 0; offset < objectReference[0].length; offset += 1)
        boundaries[index + offset] = offset === 0 ? from : output.length;
      index += objectReference[0].length;
      continue;
    }
    const formats: Array<{ open: string; close: string; type: string }> = [
      { open: "**", close: "**", type: "bold" },
      { open: "__", close: "__", type: "bold" },
      { open: "~~", close: "~~", type: "strikethrough" },
      { open: "`", close: "`", type: "keyboard" },
      { open: "*", close: "*", type: "italic" },
      { open: "_", close: "_", type: "italic" },
    ];
    const format = formats.find((candidate) => {
      if (!text.startsWith(candidate.open, index)) return false;
      const closeAt = text.indexOf(candidate.close, index + candidate.open.length);
      if (closeAt <= index + candidate.open.length) return false;
      if (!candidate.open.includes("_")) return true;
      return (
        !isWordCharacter(text[index - 1]) &&
        !isWordCharacter(text[closeAt + candidate.close.length])
      );
    });
    if (format) {
      const closeAt = text.indexOf(format.close, index + format.open.length);
      for (let offset = 0; offset < format.open.length; offset += 1)
        boundaries[index + offset] = output.length;
      const from = output.length;
      const content = text.slice(index + format.open.length, closeAt);
      output += content;
      for (let offset = 0; offset <= content.length; offset += 1)
        boundaries[index + format.open.length + offset] = from + offset;
      marks.push({ type: format.type, from, to: output.length });
      for (let offset = 0; offset < format.close.length; offset += 1)
        boundaries[closeAt + offset] = output.length;
      index = closeAt + format.close.length;
      continue;
    }
    const link = /^\[([^\]\n]+)\]\(((?:https?|anytype):\/\/[^)\s]+)\)/.exec(text.slice(index));
    if (link) {
      const from = output.length;
      output += link[1]!;
      marks.push({ type: "link", from, to: output.length, param: link[2]! });
      for (let offset = 0; offset < link[0].length; offset += 1)
        boundaries[index + offset] =
          offset <= link[1]!.length ? from + Math.max(0, offset - 1) : output.length;
      index += link[0].length;
      continue;
    }
    output += text[index]!;
    index += 1;
  }
  boundaries[text.length] = output.length;
  for (const mark of existingMarks)
    marks.push({
      ...mark,
      ...(mark.from !== undefined ? { from: boundaries[mark.from] ?? mark.from } : {}),
      ...(mark.to !== undefined ? { to: boundaries[mark.to] ?? mark.to } : {}),
    });
  return { text: output, marks, attachments };
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function activityDisplay(thinking: string, activities: string[], workingText: string): string {
  const lines = thinking
    .split(/\n+/)
    .map(compactActivityLine)
    .filter(Boolean)
    .map((line) => `• ${line}`);
  const combined = [...lines, ...activities].filter(
    (line, index, all) =>
      all.findLastIndex((candidate) => candidate.slice(2) === line.slice(2)) === index,
  );
  return combined.length ? `${workingText}\n\n${combined.slice(-4).join("\n")}` : workingText;
}

function compactActivityLine(value: string): string {
  const plain = value
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^[\s#>*+\-\d.)]+/, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 140 ? `${plain.slice(0, 137).trimEnd()}…` : plain;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

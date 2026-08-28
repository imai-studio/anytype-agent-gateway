import { inactivityTimeoutSeconds, type AgentConfig, type WakeConfig } from "./config.js";
import { createHash } from "node:crypto";
import { buildContext, formatPrompt, isNewSessionCommand } from "./context.js";
import { renderForAnytype, RunProjection, type ProjectionCycleSnapshot } from "./projection.js";
import { Store } from "./store.js";
import type { AgentRuntime } from "./session-types.js";
import type { ActiveRuntime, AnytypePort, ChatMessage, ConversationRef, RuntimeDriver, RuntimeSessionObserver, RuntimeSessionOutput } from "./types.js";
import { decideWake } from "./wake.js";

type ActiveRun = { id: string; handle: ActiveRuntime; projection: RunProjection; conversation: ConversationRef; threadKey: string; completion: Promise<void>; cancelled: boolean };

export class AgentController {
  private readonly active = new Map<string, ActiveRun>();
  private readonly processing = new Set<string>();
  private readonly observers = new Map<string, RuntimeSessionObserver>();
  private readonly observerStarts = new Map<string, Promise<void>>();
  private readonly outboxWorkerId = `controller:${process.pid}:${crypto.randomUUID()}`;
  private readonly outboxTimer: NodeJS.Timeout;
  private readonly observerTimer: NodeJS.Timeout;
  constructor(private readonly anytype: AnytypePort, private readonly runtime: RuntimeDriver, private readonly config: AgentConfig, private readonly store: Store, private readonly log: (event: string, fields?: Record<string, unknown>) => void, private readonly discussionAnytype: AnytypePort = anytype, private readonly managementCommand?: (routeId: string) => string) {
    this.store.saveRuntimeCapabilities(this.runtimeName(), this.runtime.capabilities);
    this.outboxTimer = setInterval(() => { void this.drainOutbox(); }, 2_000);
    this.outboxTimer.unref?.();
    this.observerTimer = setInterval(() => {
      for (const binding of this.store.listSessionBindings("active")) {
        if (this.observers.has(binding.threadKey)) continue;
        void this.ensureObserver(binding.threadKey).catch(error => this.log("session_observer_retry_failed", { threadKey: binding.threadKey, error: error instanceof Error ? error.message : String(error) }));
      }
    }, 5_000);
    this.observerTimer.unref?.();
  }

  async process(conversation: ConversationRef, wake: WakeConfig, message: ChatMessage): Promise<void> {
    const version = message.modified_at ?? message.created_at;
    const fingerprint = messageFingerprint(message);
    if (!message.id || this.store.isHandled(conversation.routeId, message.id, version, fingerprint)) return;
    const claim = `${conversation.routeId}:${message.id}`;
    if (this.processing.has(claim)) return;
    this.processing.add(claim);
    try {
      await this.processClaimed(conversation, wake, message);
      this.store.markHandled(conversation.routeId, message.id, version, fingerprint);
    } finally { this.processing.delete(claim); }
  }

  private async processClaimed(conversation: ConversationRef, wake: WakeConfig, message: ChatMessage): Promise<void> {
    if (this.store.isResponse(message.id)) return;
    const humans = this.store.wakeOverride(conversation.routeId);
    const effectiveWake = humans ? { ...wake, humans: humans as WakeConfig["humans"] } : wake;
    const replyToAgent = Boolean(message.reply_to_message_id && this.store.isResponse(message.reply_to_message_id));
    const decision = decideWake(message, effectiveWake, this.config, { replyToAgent, ...(conversation.selfParticipantId ? { selfParticipantId: conversation.selfParticipantId } : {}) });
    if (!decision.wake) { this.log("message_ignored", { routeId: conversation.routeId, messageId: message.id, reason: decision.reason }); return; }
    const thread = await this.thread(conversation, message);
    const threadKey = thread.key;
    const replyTargetId = conversation.kind === "discussion" ? thread.rootId : message.id;
    const newSession = isNewSessionCommand(message.content?.text ?? "");
    const hop = decision.isAgent ? await this.agentHop(conversation, message) : 0;
    if (hop > this.config.coordination.maxHops) { this.log("hop_limit", { routeId: conversation.routeId, hop }); return; }
    const active = this.active.get(threadKey);
    if (active) {
      if (newSession) {
        await this.replaceActiveSession(active);
        const generation = this.store.resetSession(threadKey);
        await this.start(conversation, message, threadKey, replyTargetId, hop, true);
        this.log("session_reset", { routeId: conversation.routeId, messageId: message.id, generation });
        return;
      }
      try {
        active.projection.addMentionTargets(mentionTargetsFrom(message));
        const responseId = await active.projection.move(message.id, replyTargetId);
        this.store.updateRunResponse(active.id, responseId, message.id);
        if (this.active.get(threadKey)?.id !== active.id) {
          await active.completion.catch(() => undefined);
          await this.start(conversation, message, threadKey, replyTargetId, hop);
          this.log("run_restarted_after_completion", { routeId: conversation.routeId, messageId: message.id, previousRunId: active.id });
          return;
        }
        await active.handle.steer(this.steerPrompt(message), { conversation, message, replyTargetId, ...(message.mentioned === undefined ? {} : { wasMentioned: message.mentioned }) });
        this.log("run_steered", { routeId: conversation.routeId, messageId: message.id, runId: active.id });
      } catch (error) {
        if (this.active.get(threadKey)?.id !== active.id) {
          await active.completion.catch(() => undefined);
          await this.start(conversation, message, threadKey, replyTargetId, hop);
          this.log("run_restarted_after_completion", { routeId: conversation.routeId, messageId: message.id, previousRunId: active.id });
          return;
        }
        active.cancelled = true;
        await active.handle.cancel().catch(() => undefined);
        await active.projection.fail(error).catch(() => undefined);
        this.store.finishRun(active.id, "failed");
        this.active.delete(threadKey);
        this.log("run_steer_failed", { routeId: conversation.routeId, runId: active.id, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    const recent = this.store.recentActivations(conversation.routeId, threadKey, Date.now() - this.config.coordination.windowSeconds * 1000);
    if (recent >= this.config.coordination.maxActivationsPerThread) { this.log("activation_circuit_open", { routeId: conversation.routeId, recent }); return; }
    const generation = newSession ? this.store.resetSession(threadKey) : this.store.sessionGeneration(threadKey);
    await this.start(conversation, message, threadKey, replyTargetId, hop, newSession);
    if (newSession) this.log("session_reset", { routeId: conversation.routeId, messageId: message.id, generation });
  }

  async stop(): Promise<void> {
    clearInterval(this.outboxTimer);
    clearInterval(this.observerTimer);
    await Promise.allSettled([...this.observers.values()].map(observer => observer.close()));
    this.observers.clear();
    const runs = [...this.active.values()];
    for (const run of runs) {
      run.cancelled = true;
      await run.handle.cancel().catch(() => undefined);
      await run.projection.interrupt().catch(() => undefined);
      this.store.finishRun(run.id, "cancelled");
    }
    await Promise.race([
      Promise.allSettled(runs.map(run => run.completion)),
      new Promise(resolve => setTimeout(resolve, 10_000))
    ]);
    this.active.clear();
    await this.runtime.close?.();
  }

  private async start(conversation: ConversationRef, message: ChatMessage, threadKey: string, replyTargetId: string, hop: number, newSession = false): Promise<void> {
    const anytype = this.port(conversation);
    const runId = crypto.randomUUID();
    const recentMessages = await anytype.listMessages(conversation.spaceId, conversation.chatId, 100);
    const orphan = replyTargetId === message.id ? recentMessages.find(candidate => candidate.reply_to_message_id === message.id && candidate.creator === (conversation.selfParticipantId ?? this.config.agent.participantId)) : undefined;
    const context = await buildContext(anytype, this.config, conversation, message, { newSession });
    const projection = orphan
      ? await RunProjection.resume(anytype, this.config, conversation, orphan.id, message.id, replyTargetId, orphan.content?.text, context.mentionTargets ?? [])
      : await RunProjection.create(anytype, this.config, conversation, message.id, replyTargetId, context.mentionTargets ?? []);
    this.store.createRun({ id: runId, routeId: conversation.routeId, threadKey, triggerId: message.id, responseId: projection.messageId, hop });
    projection.trackMessages(messageId => this.store.updateRunResponse(runId, messageId));
    let startedHandle: ActiveRuntime | undefined;
    try {
      const generation = this.store.sessionGeneration(threadKey);
      const sessionKey = generation === 0 ? `aag:${threadKey}` : `aag:${threadKey}:g${generation}`;
      if (newSession) {
        const observer = this.observers.get(threadKey);
        if (observer) await observer.close().catch(() => undefined);
        this.observers.delete(threadKey);
        this.store.deleteSessionBinding(threadKey);
      }
      const existingBinding = this.store.sessionBinding(threadKey);
      this.store.saveSessionBinding({ threadKey, routeId: conversation.routeId, spaceId: conversation.spaceId, chatId: conversation.chatId, ...(conversation.kind === "discussion" ? { discussionRootId: replyTargetId } : {}), runtime: this.runtimeName(), nativeSessionKey: sessionKey, ...(!newSession && existingBinding?.nativeSessionId ? { nativeSessionId: existingBinding.nativeSessionId } : {}), generation, ...(!newSession && existingBinding?.eventCursor ? { eventCursor: existingBinding.eventCursor } : {}), state: newSession ? "resetting" : "active" });
      projection.trackCycles(cycle => {
        try { this.persistProjectionCycle(threadKey, cycle); }
        catch (error) { this.log("output_cycle_persist_failed", { threadKey, cycleId: cycle.id, error: error instanceof Error ? error.message : String(error) }); }
      });
      let lastActivityAt = Date.now();
      const handle = await this.runtime.start({ sessionKey, prompt: formatPrompt(context, this.config, this.managementCommand?.(conversation.routeId)), turn: { conversation, message, replyTargetId, ...(message.mentioned === undefined ? {} : { wasMentioned: message.mentioned }) } }, event => {
        lastActivityAt = Date.now();
        projection.onEvent(event);
      });
      startedHandle = handle;
      void handle.result.catch(() => undefined);
      const active: ActiveRun = { id: runId, handle, projection, conversation, threadKey, completion: Promise.resolve(), cancelled: false };
      this.active.set(threadKey, active);
      this.store.updateSessionBinding(threadKey, { nativeSessionId: handle.sessionId ?? sessionKey, state: "active" });
      await this.ensureObserver(threadKey).catch(error => {
        this.log("session_observer_deferred", { threadKey, error: error instanceof Error ? error.message : String(error) });
      });
      this.log("run_started", { routeId: conversation.routeId, runId, messageId: message.id });
      const result = withExecutionTimeouts(handle, inactivityTimeoutSeconds(this.config.runtime) * 1000, this.config.runtime.maxRunSeconds * 1000, () => lastActivityAt);
      active.completion = result.then(async value => {
        if (active.cancelled) return;
        if (this.active.get(threadKey)?.id === runId) this.active.delete(threadKey);
        const status = await projection.finish(value);
        this.store.finishRun(runId, status);
        this.log("run_finished", { routeId: conversation.routeId, runId, status });
      }).catch(async error => {
        if (active.cancelled) return;
        await projection.fail(error).catch(() => undefined);
        this.store.finishRun(runId, "failed");
        this.log("run_failed", { routeId: conversation.routeId, runId, error: error instanceof Error ? error.message : String(error) });
      }).finally(() => { if (this.active.get(threadKey)?.id === runId) this.active.delete(threadKey); });
    } catch (error) {
      if (startedHandle) {
        this.active.delete(threadKey);
        await startedHandle.cancel().catch(() => undefined);
      }
      await projection.fail(error).catch(() => undefined);
      this.store.finishRun(runId, "failed");
      this.log("run_start_failed", { routeId: conversation.routeId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async replaceActiveSession(active: ActiveRun): Promise<void> {
    active.cancelled = true;
    this.active.delete(active.threadKey);
    await active.handle.cancel().catch(() => undefined);
    await active.projection.interrupt("Agent session replaced by /new.").catch(() => undefined);
    this.store.finishRun(active.id, "cancelled");
  }

  private steerPrompt(message: ChatMessage): string { return `A follow-up arrived from ${message.creator_name ?? message.creator ?? "unknown"}. Incorporate it into the active run and continue:\n\n${message.content?.text ?? ""}`; }
  private async thread(conversation: ConversationRef, message: ChatMessage): Promise<{ key: string; rootId: string }> {
    if (conversation.kind === "chat") return { key: conversation.routeId, rootId: message.id };
    let rootId = message.id;
    let parentId = message.reply_to_message_id;
    const seen = new Set<string>();
    for (let depth = 0; parentId && depth < 1000 && !seen.has(parentId); depth += 1) {
      seen.add(parentId);
      rootId = parentId;
      try {
        const parent = await this.port(conversation).getMessage(conversation.spaceId, conversation.chatId, parentId);
        parentId = parent.reply_to_message_id;
      } catch { break; }
    }
    return { key: `${conversation.routeId}:root:${rootId}`, rootId };
  }
  private async agentHop(conversation: ConversationRef, message: ChatMessage): Promise<number> {
    let hop = 1;
    let parentId = message.reply_to_message_id;
    for (; parentId && hop <= this.config.coordination.maxHops + 1;) {
      try {
        const parent = await this.port(conversation).getMessage(conversation.spaceId, conversation.chatId, parentId);
        if (!parent.creator || !(this.config.coordination.agentParticipants.includes(parent.creator) || this.config.coordination.peers.some(peer => peer.participantId === parent?.creator))) break;
        hop += 1;
        parentId = parent.reply_to_message_id;
      } catch { break; }
    }
    return hop;
  }

  private port(conversation: ConversationRef): AnytypePort { return conversation.kind === "discussion" ? this.discussionAnytype : this.anytype; }

  private runtimeName(): AgentRuntime { return this.runtime.name === "openclaw" ? "openclaw" : "codex-acp"; }

  private async ensureObserver(threadKey: string): Promise<void> {
    if (!this.runtime.observeSession || this.observers.has(threadKey)) return;
    const pending = this.observerStarts.get(threadKey);
    if (pending) return pending;
    const start = this.startObserver(threadKey);
    this.observerStarts.set(threadKey, start);
    try { await start; }
    finally { this.observerStarts.delete(threadKey); }
  }

  private async startObserver(threadKey: string): Promise<void> {
    const observeSession = this.runtime.observeSession?.bind(this.runtime);
    if (!observeSession) return;
    const binding = this.store.sessionBinding(threadKey);
    if (!binding) return;
    const observer = await observeSession({ sessionKey: binding.nativeSessionKey, ...(binding.eventCursor ? { afterCursor: binding.eventCursor } : {}), conversation: { routeId: binding.routeId, spaceId: binding.spaceId, chatId: binding.chatId, kind: binding.discussionRootId ? "discussion" : "chat", ...(binding.discussionRootId ? { discussionRootId: binding.discussionRootId } : {}) } }, output => this.receiveSessionOutput(threadKey, output));
    this.observers.set(threadKey, observer);
    if (observer.cursor && observer.cursor !== binding.eventCursor) this.store.updateSessionBinding(threadKey, { eventCursor: observer.cursor });
  }

  async restoreObserversForRoute(conversation: ConversationRef): Promise<void> {
    const bindings = this.store.listSessionBindings("active").filter(binding => binding.routeId === conversation.routeId);
    for (const binding of bindings) await this.ensureObserver(binding.threadKey);
  }

  private async receiveSessionOutput(threadKey: string, output: RuntimeSessionOutput): Promise<void> {
    const binding = this.store.sessionBinding(threadKey);
    if (!binding) return;
    if (output.result.silent || this.store.isProactiveDelivered(binding.runtime, binding.nativeSessionKey, output.id)) {
      this.store.updateSessionBinding(threadKey, { eventCursor: output.cursor });
      return;
    }
    const rendered = renderForAnytype(output.result.text, this.config);
    const text = rendered.text.slice(0, this.config.responses.maxCharacters);
    const marks = rendered.marks.filter(mark => (mark.to ?? 0) <= text.length);
    this.store.enqueueOutbound({
      id: crypto.randomUUID(), threadKey, routeId: binding.routeId, spaceId: binding.spaceId, chatId: binding.chatId,
      ...(binding.discussionRootId ? { discussionRootId: binding.discussionRootId, replyToMessageId: binding.discussionRootId } : {}),
      operation: "create", payload: { text, marks, runtime: binding.runtime, nativeSessionKey: binding.nativeSessionKey, nativeEventId: output.id, cursor: output.cursor },
      dedupeKey: `proactive:${binding.runtime}:${binding.nativeSessionKey}:${output.id}`
    });
    await this.drainOutbox();
  }

  private async drainOutbox(): Promise<void> {
    const items = this.store.claimOutbound(this.outboxWorkerId, { limit: 20, leaseMs: 30_000 });
    for (const item of items) {
      try {
        if (item.operation !== "create") throw new Error(`Unsupported queued operation: ${item.operation}`);
        const payload = item.payload as { text: string; marks?: import("./types.js").TextMark[]; runtime?: AgentRuntime; nativeSessionKey?: string; nativeEventId?: string; cursor?: string };
        const port = item.discussionRootId ? this.discussionAnytype : this.anytype;
        const recovered = item.attempts > 1
          ? (await port.listMessages(item.spaceId, item.chatId, 100)).find(message =>
              sameParticipant(message.creator, this.config.agent.participantId) &&
              message.reply_to_message_id === item.replyToMessageId &&
              (message.created_at === undefined || message.created_at >= item.createdAt - 30_000) &&
              message.content?.text === payload.text)
          : undefined;
        const messageId = recovered?.id ?? await port.sendMessage(item.spaceId, item.chatId, { text: payload.text, ...(payload.marks?.length ? { marks: payload.marks } : {}), ...(item.replyToMessageId ? { replyTo: item.replyToMessageId } : {}) });
        if (payload.runtime && payload.nativeSessionKey && payload.nativeEventId) this.store.markProactiveDelivered({ runtime: payload.runtime, nativeSessionKey: payload.nativeSessionKey, nativeEventId: payload.nativeEventId, threadKey: item.threadKey, messageId });
        if (payload.cursor) this.store.updateSessionBinding(item.threadKey, { eventCursor: payload.cursor });
        this.store.acknowledgeOutbound(item.id, this.outboxWorkerId);
        this.log("proactive_output_delivered", { routeId: item.routeId, threadKey: item.threadKey, messageId });
      } catch (error) {
        const delay = Math.min(60_000, 1_000 * 2 ** Math.min(item.attempts, 6));
        this.store.failOutbound(item.id, error instanceof Error ? error.message : String(error), { workerId: this.outboxWorkerId, retryAt: Date.now() + delay });
        this.log("outbox_delivery_failed", { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private persistProjectionCycle(threadKey: string, cycle: ProjectionCycleSnapshot): void {
    const existing = this.store.outputCycle(cycle.id);
    const reused = existing ?? this.store.outputCycleForMessage(cycle.messageId);
    const cycleId = reused?.id ?? cycle.id;
    if (!reused) {
      if (cycle.state === "deleted") return;
      this.store.createOutputCycle({ id: cycle.id, threadKey, anytypeMessageId: cycle.messageId, replyToMessageId: cycle.replyToMessageId, phase: cycle.phase });
    } else if (cycle.state === "open" && reused.state !== "open") {
      this.store.reopenOutputCycle(cycleId, cycle.phase);
    }
    this.store.updateOutputCycle(cycleId, {
      phase: cycle.phase,
      ...(cycle.phase === "thinking" ? { thinkingText: cycle.text } : cycle.phase === "answer" || cycle.phase === "error" ? { answerText: cycle.text } : {}),
      replyToMessageId: cycle.replyToMessageId,
    });
    if (cycle.state !== "open") this.store.finishOutputCycle(cycleId, cycle.state);
  }
}

export function messageFingerprint(message: ChatMessage): string {
  return createHash("sha256").update(JSON.stringify({
    creator: message.creator ?? null,
    replyTo: message.reply_to_message_id ?? null,
    text: message.content?.text ?? "",
    style: message.content?.style ?? null,
    marks: message.content?.marks ?? []
  })).digest("hex");
}

function withExecutionTimeouts(handle: ActiveRuntime, inactivityMs: number, maximumMs: number, lastActivityAt: () => number): Promise<Awaited<ActiveRuntime["result"]>> {
  if (inactivityMs === 0 && maximumMs === 0) return handle.result;
  let inactivityTimer: NodeJS.Timeout | undefined;
  let maximumTimer: NodeJS.Timeout | undefined;
  let settled = false;
  const inactivity = new Promise<never>((_resolve, reject) => {
    const check = () => {
      if (settled) return;
      const remaining = inactivityMs - (Date.now() - lastActivityAt());
      if (remaining > 0) {
        inactivityTimer = setTimeout(check, remaining);
        inactivityTimer.unref?.();
        return;
      }
      void handle.cancel().catch(() => undefined);
      reject(new Error(`Agent run produced no activity for ${Math.round(inactivityMs / 1000)} seconds`));
    };
    if (inactivityMs > 0) {
      inactivityTimer = setTimeout(check, inactivityMs);
      inactivityTimer.unref?.();
    }
  });
  const maximum = new Promise<never>((_resolve, reject) => {
    if (maximumMs === 0) return;
    maximumTimer = setTimeout(() => {
      void handle.cancel().catch(() => undefined);
      reject(new Error(`Agent run exceeded the configured maximum of ${Math.round(maximumMs / 1000)} seconds`));
    }, maximumMs);
    maximumTimer.unref?.();
  });
  return Promise.race([handle.result, inactivity, maximum]).finally(() => {
    settled = true;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (maximumTimer) clearTimeout(maximumTimer);
  });
}

function mentionTargetsFrom(message: ChatMessage): Array<{ name: string; participantId: string }> {
  const targets: Array<{ name: string; participantId: string }> = [];
  if (message.creator && message.creator_name) targets.push({ name: message.creator_name, participantId: message.creator });
  const text = message.content?.text ?? "";
  for (const mark of message.content?.marks ?? []) {
    if (mark.type !== "mention" || !mark.param || mark.from === undefined || mark.to === undefined) continue;
    const name = text.slice(mark.from, mark.to).replace(/^@/, "").trim();
    if (name) targets.push({ name, participantId: mark.param });
  }
  return targets;
}

function sameParticipant(left: string | undefined, right: string): boolean {
  if (!left) return false;
  if (left === right || left.endsWith(`_${right}`) || right.endsWith(`_${left}`)) return true;
  return left.split("_").at(-1) === right.split("_").at(-1);
}

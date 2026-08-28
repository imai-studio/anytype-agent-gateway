import type { AgentConfig, WakeConfig } from "./config.js";
import { AgentController, messageFingerprint } from "./controller.js";
import { HeartDiscussionAdapter } from "./discussions.js";
import { Store } from "./store.js";
import type { AnytypePort, ConversationRef, RuntimeDriver } from "./types.js";

type Route = { conversation: ConversationRef; wake: WakeConfig };

export class Gateway {
  private readonly abort = new AbortController();
  private readonly routeIds = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly controller: AgentController;
  private readonly terminal: Promise<void>;
  private resolveTerminal!: () => void;
  private rejectTerminal!: (error: unknown) => void;

  constructor(private readonly anytype: AnytypePort, runtime: RuntimeDriver, private readonly config: AgentConfig, private readonly store: Store, private readonly discussions: HeartDiscussionAdapter, private readonly log: (event: string, fields?: Record<string, unknown>) => void) {
    this.controller = new AgentController(anytype, runtime, config, store, log);
    this.terminal = new Promise<void>((resolve, reject) => { this.resolveTerminal = resolve; this.rejectTerminal = reject; });
    void this.terminal.catch(() => undefined);
  }

  async start(): Promise<void> {
    try {
      this.store.prune(Date.now() - 30 * 24 * 60 * 60 * 1000);
      for (const configuredSpace of this.config.spaces) {
        if (!configuredSpace.id && !configuredSpace.name) throw new Error("A space needs id or name after its invite has been joined");
        const space = await this.anytype.resolveSpace({ ...(configuredSpace.id ? { id: configuredSpace.id } : {}), ...(configuredSpace.name ? { name: configuredSpace.name } : {}) });
        for (const configuredChat of configuredSpace.chats) {
          const chat = await this.anytype.resolveChat(space.id, { ...(configuredChat.id ? { id: configuredChat.id } : {}), ...(configuredChat.name ? { name: configuredChat.name } : {}) });
          this.addRoute({ conversation: { routeId: `chat:${space.id}:${chat.id}`, spaceId: space.id, chatId: chat.id, kind: "chat", selfParticipantId: configuredSpace.participantId ?? this.config.agent.participantId }, wake: configuredChat.wake });
        }
        if (configuredSpace.comments.mode !== "disabled") this.track(this.discoverDiscussions(space.id, configuredSpace.comments, configuredSpace.participantId ?? this.config.agent.participantId));
      }
      if (!this.tasks.size) throw new Error("Configuration produced no chat or discussion routes");
      await this.terminal;
    } finally {
      this.abort.abort();
      await this.controller.stop();
      await Promise.allSettled([...this.tasks]);
    }
  }

  stop(): void { this.abort.abort(); this.resolveTerminal(); }

  private addRoute(route: Route): void {
    if (this.routeIds.has(route.conversation.routeId)) return;
    this.routeIds.add(route.conversation.routeId);
    this.track(this.runRoute(route));
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      error => {
        this.tasks.delete(task);
        if (!this.abort.signal.aborted) { this.abort.abort(error); this.rejectTerminal(error); }
      }
    );
  }

  private async runRoute(route: Route): Promise<void> {
    const { conversation } = route;
    if (!this.store.isInitialized(conversation.routeId)) {
      const recent = await this.anytype.listMessages(conversation.spaceId, conversation.chatId, 100);
      for (const message of recent) this.store.markHandled(conversation.routeId, message.id, message.modified_at ?? message.created_at, messageFingerprint(message));
      this.store.initialize(conversation.routeId, recent.at(-1)?.order_id);
      this.log("route_baselined", { routeId: conversation.routeId, messages: recent.length });
    }
    await this.reconcileInterruptedRuns(conversation);
    let delay = 500;
    while (!this.abort.signal.aborted) {
      const attemptStarted = Date.now();
      try {
        let cursor = this.store.cursor(conversation.routeId);
        for (;;) {
          const previousCursor = cursor;
          const catchup = await this.anytype.listMessages(conversation.spaceId, conversation.chatId, 100, cursor);
          for (const message of catchup) {
            await this.controller.process(conversation, route.wake, message);
            if (message.order_id) { cursor = message.order_id; this.store.updateCursor(conversation.routeId, message.order_id); }
          }
          if (!catchup.length || cursor === previousCursor) break;
        }
        this.log("route_connecting", { routeId: conversation.routeId });
        for await (const event of this.anytype.stream(conversation.spaceId, conversation.chatId, this.abort.signal)) {
          const message = event.payload?.message;
          if ((event.type === "message_added" || event.type === "message_updated") && message) {
            await this.controller.process(conversation, route.wake, message);
            if (event.type === "message_added" && message.order_id) this.store.updateCursor(conversation.routeId, message.order_id);
          }
        }
        if (!this.abort.signal.aborted) throw new Error("event stream ended");
      } catch (error) {
        if (this.abort.signal.aborted) break;
        if (Date.now() - attemptStarted >= 30_000) delay = 500;
        this.log("route_disconnected", { routeId: conversation.routeId, error: error instanceof Error ? error.message : String(error), retryMs: delay });
        await wait(delay, this.abort.signal);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  private async reconcileInterruptedRuns(conversation: ConversationRef): Promise<void> {
    for (const run of this.store.runningRuns(conversation.routeId)) {
      try {
        await this.anytype.ensureReaction(conversation.spaceId, conversation.chatId, run.responseId, this.config.responses.workingReaction, false).catch(() => undefined);
        await this.anytype.editMessage(conversation.spaceId, conversation.chatId, run.responseId, "Agent run interrupted before completion.").catch(error => {
          this.log("run_reconcile_projection_failed", { routeId: conversation.routeId, runId: run.id, error: error instanceof Error ? error.message : String(error) });
        });
      } finally {
        this.store.finishRun(run.id, "failed");
        this.log("run_reconciled", { routeId: conversation.routeId, runId: run.id });
      }
    }
  }

  private async discoverDiscussions(spaceId: string, comments: AgentConfig["spaces"][number]["comments"], selfParticipantId: string): Promise<void> {
    let firstPass = true;
    while (!this.abort.signal.aborted) {
      try {
        const known = this.store.knownDiscussionObjectIds(spaceId);
        const objects: Array<{ id: string; name?: string; type?: string }> = [];
        const seenObjects = new Set<string>();
        let offset = 0;
        let exhausted = false;
        for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
          const page = await this.anytype.searchObjects(spaceId, offset, 250);
          if (!page.length) { exhausted = true; break; }
          const unique = page.filter(object => !seenObjects.has(object.id));
          for (const object of unique) { seenObjects.add(object.id); objects.push(object); }
          offset += page.length;
          if (!unique.length) { exhausted = true; break; }
        }
        if (!exhausted) throw new Error(`Discussion discovery exceeded 100 object-search pages in space ${spaceId}`);
        const candidates = objects.filter(object => !known.has(object.id) && (comments.mode === "all" || (!comments.includeObjectTypes.length || Boolean(object.type && comments.includeObjectTypes.includes(object.type)))) && !(object.type && comments.excludeObjectTypes.includes(object.type)));
        for (let index = 0; index < candidates.length; index += 10) {
          const batch = candidates.slice(index, index + 10);
          const resolved = await this.discussions.resolve(spaceId, batch, comments.createMissing);
          const failures = resolved.filter(item => item.error);
          if (failures.length) throw new Error(`Discussion resolution failed for ${failures.map(item => item.objectId).join(", ")}: ${failures.map(item => item.error).join("; ")}`);
          for (const item of resolved) {
            if (!item.discussionId) continue;
            const object = batch.find(candidate => candidate.id === item.objectId);
            this.store.cacheDiscussion({ spaceId, objectId: item.objectId, discussionId: item.discussionId, ...(object?.name ? { objectName: object.name } : {}), ...(object?.type ? { objectType: object.type } : {}) });
          }
        }
        for (const item of this.store.listDiscussions(spaceId)) {
          this.addRoute({ conversation: { routeId: `discussion:${spaceId}:${item.discussionId}`, spaceId, chatId: item.discussionId, kind: "discussion", objectId: item.objectId, selfParticipantId, ...(item.objectName ? { objectName: item.objectName } : {}) }, wake: comments.wake });
        }
        this.log("discussion_discovery_complete", { spaceId, objects: objects.length, discussions: this.store.listDiscussions(spaceId).length });
      } catch (error) {
        if (firstPass) throw error;
        this.log("discussion_discovery_failed", { spaceId, error: error instanceof Error ? error.message : String(error) });
      }
      firstPass = false;
      await wait(comments.discoveryIntervalSeconds * 1000, this.abort.signal).catch(() => undefined);
    }
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

import type { AgentConfig, WakeConfig } from "./config.js";
import { AgentController, messageFingerprint } from "./controller.js";
import { DiscussionAnytypePort, HeartDiscussionAdapter } from "./discussions.js";
import { Store } from "./store.js";
import type { AnytypePort, ConversationRef, RuntimeDriver } from "./types.js";

type Route = { conversation: ConversationRef; wake: WakeConfig; baselineExisting?: boolean };
const INTERRUPTED_RUN_RECOVERY_GRACE_MS = 60 * 60 * 1000;

export class Gateway {
  private readonly abort = new AbortController();
  private readonly routeIds = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly controller: AgentController;
  private readonly discussionAnytype: AnytypePort;
  private readonly terminal: Promise<void>;
  private pruneTimer: NodeJS.Timeout | undefined;
  private resolveTerminal!: () => void;
  private rejectTerminal!: (error: unknown) => void;

  constructor(
    private readonly anytype: AnytypePort,
    private readonly runtime: RuntimeDriver,
    private readonly config: AgentConfig,
    private readonly store: Store,
    private readonly discussions: HeartDiscussionAdapter,
    private readonly log: (event: string, fields?: Record<string, unknown>) => void,
    managementCommand?: (routeId: string) => string,
  ) {
    this.discussionAnytype = new DiscussionAnytypePort(anytype, discussions);
    this.controller = new AgentController(
      anytype,
      runtime,
      config,
      store,
      log,
      this.discussionAnytype,
      managementCommand,
    );
    this.terminal = new Promise<void>((resolve, reject) => {
      this.resolveTerminal = resolve;
      this.rejectTerminal = reject;
    });
    void this.terminal.catch(() => undefined);
  }

  async start(): Promise<void> {
    try {
      this.store.prune(Date.now() - 30 * 24 * 60 * 60 * 1000);
      this.pruneTimer = setInterval(
        () => {
          try {
            this.store.prune(Date.now() - 30 * 24 * 60 * 60 * 1000);
          } catch (error) {
            this.log("state_prune_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        6 * 60 * 60 * 1000,
      );
      this.pruneTimer.unref?.();
      for (const configuredSpace of this.config.spaces) {
        if (!configuredSpace.id && !configuredSpace.name)
          throw new Error("A space needs id or name after its invite has been joined");
        const space = await this.anytype.resolveSpace({
          ...(configuredSpace.id ? { id: configuredSpace.id } : {}),
          ...(configuredSpace.name ? { name: configuredSpace.name } : {}),
        });
        for (const configuredChat of configuredSpace.chats) {
          const chat = await this.anytype.resolveChat(space.id, {
            ...(configuredChat.id ? { id: configuredChat.id } : {}),
            ...(configuredChat.name ? { name: configuredChat.name } : {}),
          });
          const override = configuredSpace.wakeOverrides.find(
            (item) => item.kind === "chat" && item.id === chat.id,
          );
          this.addRoute({
            conversation: {
              routeId: `chat:${space.id}:${chat.id}`,
              spaceId: space.id,
              chatId: chat.id,
              kind: "chat",
              selfParticipantId: configuredSpace.participantId ?? this.config.agent.participantId,
            },
            wake: override?.wake ?? configuredChat.wake,
          });
        }
        if (configuredSpace.chatDiscovery.enabled)
          this.track(
            this.discoverChats(
              space.id,
              configuredSpace.chatDiscovery,
              configuredSpace.participantId ?? this.config.agent.participantId,
              configuredSpace.wakeOverrides,
            ),
          );
        if (configuredSpace.comments.mode !== "disabled")
          this.track(
            this.discoverDiscussions(
              space.id,
              configuredSpace.comments,
              configuredSpace.participantId ?? this.config.agent.participantId,
              configuredSpace.wakeOverrides,
            ),
          );
      }
      if (!this.tasks.size) throw new Error("Configuration produced no chat or discussion routes");
      await this.terminal;
    } finally {
      this.abort.abort();
      if (this.pruneTimer) clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
      await Promise.allSettled([...this.tasks]);
      await this.controller.stop();
    }
  }

  stop(): void {
    this.abort.abort();
    this.resolveTerminal();
  }

  private addRoute(route: Route): void {
    if (this.routeIds.has(route.conversation.routeId)) return;
    this.routeIds.add(route.conversation.routeId);
    this.track(this.runRoute(route));
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      (error) => {
        this.tasks.delete(task);
        if (!this.abort.signal.aborted) {
          this.abort.abort(error);
          this.rejectTerminal(error);
        }
      },
    );
  }

  private async runRoute(route: Route): Promise<void> {
    const { conversation } = route;
    const anytype = this.port(conversation);
    if (!this.store.isInitialized(conversation.routeId)) {
      const recent = await anytype.listMessages(conversation.spaceId, conversation.chatId, 100);
      const baseline = route.baselineExisting === false ? recent.slice(0, -20) : recent;
      for (const message of baseline)
        this.store.markHandled(
          conversation.routeId,
          message.id,
          message.modified_at ?? message.created_at,
          messageFingerprint(message),
        );
      this.store.initialize(conversation.routeId, baseline.at(-1)?.order_id);
      this.log(route.baselineExisting === false ? "route_recent_catchup" : "route_baselined", {
        routeId: conversation.routeId,
        messages: recent.length,
        pending: recent.length - baseline.length,
      });
    }
    await this.controller.restoreObserversForRoute(conversation);
    await this.reconcileInterruptedRuns(conversation);
    let delay = 500;
    while (!this.abort.signal.aborted) {
      const attemptStarted = Date.now();
      try {
        await this.controller.restoreObserversForRoute(conversation);
        let cursor = await this.catchUp(
          anytype,
          conversation,
          route.wake,
          this.store.cursor(conversation.routeId),
        );
        this.log("route_connecting", { routeId: conversation.routeId });
        const eventStream = anytype.stream(
          conversation.spaceId,
          conversation.chatId,
          this.abort.signal,
        );
        const stream = eventStream[Symbol.asyncIterator]();
        let next = stream.next();
        try {
          while (!this.abort.signal.aborted) {
            const outcome = await raceWithReconciliation(next, 10_000, this.abort.signal);
            if (outcome.kind === "reconcile") {
              cursor = await this.catchUp(anytype, conversation, route.wake, cursor);
              continue;
            }
            if (outcome.result.done) break;
            next = stream.next();
            const event = outcome.result.value;
            const message = event.payload?.message;
            if ((event.type === "message_added" || event.type === "message_updated") && message) {
              // Anytype order IDs are opaque fractional indexes, not strings with a
              // meaningful lexical ordering. Exact message-version dedupe belongs
              // in the controller; the periodic API reconciliation owns the cursor.
              await this.controller.process(conversation, route.wake, message);
            }
          }
        } finally {
          await stream.return?.().catch(() => undefined);
        }
        if (!this.abort.signal.aborted) throw new Error("event stream ended");
      } catch (error) {
        if (this.abort.signal.aborted) break;
        if (Date.now() - attemptStarted >= 30_000) delay = 500;
        this.log("route_disconnected", {
          routeId: conversation.routeId,
          error: error instanceof Error ? error.message : String(error),
          retryMs: delay,
        });
        await wait(delay, this.abort.signal);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  private async catchUp(
    anytype: AnytypePort,
    conversation: ConversationRef,
    wake: WakeConfig,
    initialCursor?: string,
  ): Promise<string | undefined> {
    let cursor = initialCursor;
    for (;;) {
      const previousCursor = cursor;
      const messages = await anytype.listMessages(
        conversation.spaceId,
        conversation.chatId,
        100,
        cursor,
      );
      for (const message of messages) {
        await this.controller.process(conversation, wake, message);
        if (message.order_id) {
          cursor = message.order_id;
          this.store.updateCursor(conversation.routeId, message.order_id);
        }
      }
      if (!messages.length || cursor === previousCursor) return cursor;
    }
  }

  private async discoverChats(
    spaceId: string,
    discovery: AgentConfig["spaces"][number]["chatDiscovery"],
    selfParticipantId: string,
    overrides: AgentConfig["spaces"][number]["wakeOverrides"],
  ): Promise<void> {
    let firstPass = true;
    while (!this.abort.signal.aborted) {
      try {
        const chats = await this.anytype.listChats(spaceId);
        for (const chat of chats) {
          this.addRoute({
            conversation: {
              routeId: `chat:${spaceId}:${chat.id}`,
              spaceId,
              chatId: chat.id,
              kind: "chat",
              selfParticipantId,
            },
            wake:
              overrides.find((item) => item.kind === "chat" && item.id === chat.id)?.wake ??
              discovery.wake,
            baselineExisting: firstPass,
          });
        }
        this.log("chat_discovery_complete", { spaceId, chats: chats.length });
      } catch (error) {
        if (firstPass) throw error;
        this.log("chat_discovery_failed", {
          spaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      firstPass = false;
      await wait(discovery.discoveryIntervalSeconds * 1000, this.abort.signal).catch(
        () => undefined,
      );
    }
  }

  private async reconcileInterruptedRuns(conversation: ConversationRef): Promise<void> {
    const anytype = this.port(conversation);
    for (const run of this.store.runningRuns(conversation.routeId)) {
      const binding = this.store.sessionBinding(run.threadKey);
      if (
        this.runtime.capabilities.sessionObservation &&
        this.runtime.observeSession &&
        binding?.state === "active" &&
        Date.now() - run.startedAt < INTERRUPTED_RUN_RECOVERY_GRACE_MS
      ) {
        this.log("run_reconcile_deferred", {
          routeId: conversation.routeId,
          runId: run.id,
          threadKey: run.threadKey,
        });
        continue;
      }
      try {
        await anytype
          .ensureReaction(
            conversation.spaceId,
            conversation.chatId,
            run.triggerId,
            this.config.responses.workingReaction,
            false,
            conversation.selfParticipantId ?? this.config.agent.participantId,
          )
          .catch(() => undefined);
        const response = await anytype
          .getMessage(conversation.spaceId, conversation.chatId, run.responseId)
          .catch(() => undefined);
        const visible = response?.content?.text?.trim();
        const text =
          visible && visible !== this.config.responses.workingText
            ? `${visible}\n\nAgent run interrupted before completion.`
            : "Agent run interrupted before completion.";
        await anytype
          .editMessage(conversation.spaceId, conversation.chatId, run.responseId, text)
          .catch((error) => {
            this.log("run_reconcile_projection_failed", {
              routeId: conversation.routeId,
              runId: run.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      } finally {
        const cycle = this.store.openOutputCycle(run.threadKey);
        if (cycle) this.store.finishOutputCycle(cycle.id, "failed");
        this.store.finishRun(run.id, "failed");
        this.log("run_reconciled", { routeId: conversation.routeId, runId: run.id });
      }
    }
  }

  private async discoverDiscussions(
    spaceId: string,
    comments: AgentConfig["spaces"][number]["comments"],
    selfParticipantId: string,
    overrides: AgentConfig["spaces"][number]["wakeOverrides"],
  ): Promise<void> {
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
          if (!page.length) {
            exhausted = true;
            break;
          }
          const unique = page.filter((object) => !seenObjects.has(object.id));
          for (const object of unique) {
            seenObjects.add(object.id);
            objects.push(object);
          }
          offset += page.length;
          if (!unique.length) {
            exhausted = true;
            break;
          }
        }
        if (!exhausted)
          throw new Error(
            `Discussion discovery exceeded 100 object-search pages in space ${spaceId}`,
          );
        const candidates = objects.filter(
          (object) =>
            !known.has(object.id) &&
            (comments.mode === "all" ||
              !comments.includeObjectTypes.length ||
              Boolean(object.type && comments.includeObjectTypes.includes(object.type))) &&
            !(object.type && comments.excludeObjectTypes.includes(object.type)),
        );
        for (let index = 0; index < candidates.length; index += 10) {
          const batch = candidates.slice(index, index + 10);
          let resolved: Awaited<ReturnType<HeartDiscussionAdapter["resolve"]>>;
          try {
            resolved = await this.discussions.resolve(spaceId, batch, comments.createMissing);
          } catch (error) {
            this.log("discussion_resolution_batch_failed", {
              spaceId,
              objectIds: batch.map((item) => item.id),
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          for (const item of resolved) {
            if (item.error) {
              this.log("discussion_resolution_failed", {
                spaceId,
                objectId: item.objectId,
                error: item.error,
              });
              continue;
            }
            if (!item.discussionId) continue;
            const object = batch.find((candidate) => candidate.id === item.objectId);
            this.store.cacheDiscussion({
              spaceId,
              objectId: item.objectId,
              discussionId: item.discussionId,
              ...(object?.name ? { objectName: object.name } : {}),
              ...(object?.type ? { objectType: object.type } : {}),
            });
          }
        }
        for (const item of this.store.listDiscussions(spaceId)) {
          this.addRoute({
            conversation: {
              routeId: `discussion:${spaceId}:${item.discussionId}`,
              spaceId,
              chatId: item.discussionId,
              kind: "discussion",
              objectId: item.objectId,
              selfParticipantId,
              ...(item.objectName ? { objectName: item.objectName } : {}),
            },
            wake:
              overrides.find(
                (override) => override.kind === "discussion" && override.id === item.discussionId,
              )?.wake ?? comments.wake,
            baselineExisting: firstPass,
          });
        }
        this.log("discussion_discovery_complete", {
          spaceId,
          objects: objects.length,
          discussions: this.store.listDiscussions(spaceId).length,
        });
      } catch (error) {
        if (firstPass) throw error;
        this.log("discussion_discovery_failed", {
          spaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      firstPass = false;
      await wait(comments.discoveryIntervalSeconds * 1000, this.abort.signal).catch(
        () => undefined,
      );
    }
  }

  private port(conversation: ConversationRef): AnytypePort {
    return conversation.kind === "discussion" ? this.discussionAnytype : this.anytype;
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function raceWithReconciliation<T>(
  next: Promise<IteratorResult<T>>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<{ kind: "event"; result: IteratorResult<T> } | { kind: "reconcile" }> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const reconcile = new Promise<{ kind: "reconcile" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "reconcile" }), milliseconds);
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new Error("Anytype route stopped"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([
      next.then((result) => ({ kind: "event" as const, result })),
      reconcile,
      aborted,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

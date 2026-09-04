import { randomUUID } from "node:crypto";
import { defineChannelPluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { BridgeServer, createDelivery } from "./bridge.js";
import { createAnytypeChannel } from "./channel.js";
import {
  anytypePluginConfigSchema,
  resolveAnytypeAccount,
  type CoreConfig,
  type ResolvedAnytypeAccount,
} from "./config.js";
import { dispatchAnytypeInbound } from "./inbound.js";
import type { AgentEventEnvelope, AnytypeRoute, BridgeInbound } from "./protocol.js";
import { BridgeStore } from "./store.js";

type AccountRuntime = {
  account: ResolvedAnytypeAccount;
  store: BridgeStore;
  server: BridgeServer;
  pruneTimer: NodeJS.Timeout;
};

export class AnytypeChannelRuntime {
  readonly #api: OpenClawPluginApi;
  readonly #accounts = new Map<string, AccountRuntime>();

  constructor(api: OpenClawPluginApi) {
    this.#api = api;
  }

  runtimeFor(cfg: CoreConfig, accountId?: string | null): AccountRuntime {
    const account = resolveAnytypeAccount(cfg, accountId);
    const existing = this.#accounts.get(account.accountId);
    if (existing) return existing;
    if (!account.configured) {
      throw new Error(`Anytype account ${account.accountId} is not configured`);
    }
    const store = new BridgeStore(account.databasePath);
    store.compactDelivered(Date.now() - 7 * 24 * 60 * 60 * 1000);
    store.pruneOwnedRuns(Date.now() - 7 * 24 * 60 * 60 * 1000);
    store.pruneExpiredThinking(Date.now() - 60 * 60 * 1000);
    const pruneTimer = setInterval(
      () => {
        store.compactDelivered(Date.now() - 7 * 24 * 60 * 60 * 1000);
        store.pruneOwnedRuns(Date.now() - 7 * 24 * 60 * 60 * 1000);
        store.pruneExpiredThinking(Date.now() - 60 * 60 * 1000);
      },
      24 * 60 * 60 * 1000,
    );
    pruneTimer.unref?.();
    const server = new BridgeServer({
      host: account.listenHost,
      port: account.listenPort,
      token: account.bridgeToken,
      store,
      log: (level, message) => this.#log(level, message),
      onInbound: async (inbound) => this.#dispatch(account, store, inbound),
    });
    const runtime = { account, store, server, pruneTimer };
    this.#accounts.set(account.accountId, runtime);
    return runtime;
  }

  async startAccount(cfg: CoreConfig, accountId?: string | null): Promise<AccountRuntime> {
    const runtime = this.runtimeFor(cfg, accountId);
    await runtime.server.start();
    return runtime;
  }

  async stopAccount(accountId: string): Promise<void> {
    const runtime = this.#accounts.get(accountId);
    if (!runtime) return;
    this.#accounts.delete(accountId);
    clearInterval(runtime.pruneTimer);
    await runtime.server.stop();
    runtime.store.close();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#accounts.keys()].map((id) => this.stopAccount(id)));
  }

  enqueueFinal(params: {
    cfg: CoreConfig;
    accountId?: string | null;
    route: AnytypeRoute;
    text: string;
    replyToId?: string;
    sessionKey?: string;
    sourceKey?: string;
  }): string {
    const runtime = this.runtimeFor(params.cfg, params.accountId);
    const delivery = createDelivery({
      sourceKey: params.sourceKey ?? `final:${runtime.account.accountId}:${randomUUID()}`,
      accountId: runtime.account.accountId,
      route: params.route,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      kind: "message-final",
      message: {
        text: params.text,
        ...(params.replyToId ? { replyToId: params.replyToId } : {}),
      },
    });
    runtime.store.putDelivery(delivery);
    return delivery.id;
  }

  observeAgentEvent(event: {
    runId: string;
    seq: number;
    stream: string;
    ts: number;
    data: Record<string, unknown>;
    sessionKey?: string;
  }): void {
    const sessionKey = event.sessionKey;
    if (!sessionKey) return;
    for (const runtime of this.#accounts.values()) {
      const binding = runtime.store.bindingForSession(sessionKey);
      if (!binding) continue;
      const allowedStreams = new Set(["assistant", "thinking", "tool", "lifecycle", "item"]);
      if (!allowedStreams.has(event.stream)) return;
      const agentEvent: AgentEventEnvelope = {
        runId: event.runId,
        seq: event.seq,
        stream: event.stream as AgentEventEnvelope["stream"],
        timestamp: event.ts,
        data: sanitizeAgentEventData(event.stream, event.data),
      };
      runtime.store.putDelivery(
        createDelivery({
          sourceKey: `agent-event:${event.runId}:${event.seq}`,
          accountId: binding.accountId,
          sessionKey,
          route: binding.route,
          ...(runtime.store.isOwnedRun(event.runId) ? { owned: true } : {}),
          kind: "agent-event",
          agentEvent,
          createdAt: event.ts,
        }),
      );
      return;
    }
  }

  async #dispatch(
    account: ResolvedAnytypeAccount,
    store: BridgeStore,
    inbound: BridgeInbound,
  ): Promise<void> {
    await dispatchAnytypeInbound({
      api: this.#api,
      cfg: this.#api.config as CoreConfig,
      account,
      store,
      inbound,
      deliverReply: async ({ sessionKey, text }) => {
        this.enqueueFinal({
          cfg: this.#api.config as CoreConfig,
          accountId: account.accountId,
          route: inbound.route,
          text,
          replyToId: inbound.message.id,
          sessionKey,
          sourceKey: `reply:${inbound.id}:${text}`,
        });
      },
    });
  }

  #log(level: "debug" | "info" | "warn" | "error", message: string): void {
    const logger = this.#api.logger;
    if (level === "debug") logger.debug?.(message);
    else if (level === "info") logger.info(message);
    else if (level === "warn") logger.warn(message);
    else logger.error(message);
  }
}

function sanitizeAgentEventData(
  stream: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const keys =
    stream === "assistant" || stream === "thinking"
      ? ["delta", "text", "itemId", "partId", "messageId", "phase", "replace"]
      : stream === "tool"
        ? ["name", "toolName", "status", "phase"]
        : ["itemId", "partId", "messageId", "status", "phase", "state", "text"];
  const sanitized: Record<string, unknown> = {};
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string") sanitized[key] = value.slice(0, 32_000);
    else if (typeof value === "boolean" || typeof value === "number") sanitized[key] = value;
  }
  return sanitized;
}

const activeRuntimeKey = Symbol.for("@imai/openclaw-anytype-channel/active-runtime");
type RuntimeGlobal = typeof globalThis & {
  [activeRuntimeKey]?: AnytypeChannelRuntime;
};

function activeRuntime(): AnytypeChannelRuntime | undefined {
  return (globalThis as RuntimeGlobal)[activeRuntimeKey];
}

function setActiveRuntime(runtime: AnytypeChannelRuntime | undefined): void {
  const shared = globalThis as RuntimeGlobal;
  if (runtime) shared[activeRuntimeKey] = runtime;
  else delete shared[activeRuntimeKey];
}

const requireRuntime = (): AnytypeChannelRuntime => {
  const runtime = activeRuntime();
  if (!runtime) throw new Error("Anytype channel runtime is not active");
  return runtime;
};

const channel = createAnytypeChannel({
  sendText: async ({ cfg, accountId, route, text, replyToId }) => ({
    messageId: requireRuntime().enqueueFinal({
      cfg,
      ...(accountId === undefined ? {} : { accountId }),
      route,
      text,
      ...(replyToId ? { replyToId } : {}),
    }),
  }),
  startAccount: async (ctx) => {
    const runtime = requireRuntime();
    const active = await runtime.startAccount(ctx.cfg as CoreConfig, ctx.account.accountId);
    ctx.setStatus({
      accountId: active.account.accountId,
      running: true,
      configured: true,
      enabled: active.account.enabled,
      mode: `bridge:${active.account.listenHost}:${active.account.listenPort}`,
    });
    await new Promise<void>((resolve) => {
      if (ctx.abortSignal.aborted) return resolve();
      ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    await runtime.stopAccount(active.account.accountId);
  },
});

export default defineChannelPluginEntry({
  id: "anytype",
  name: "Anytype",
  description: "Native Anytype channel backed by the authenticated Knot bridge.",
  plugin: channel,
  configSchema: anytypePluginConfigSchema,
  registerFull(api) {
    const runtime = new AnytypeChannelRuntime(api);
    // OpenClaw may evaluate the channel contribution and the full plugin entry
    // through separate module instances. A global symbol keeps both copies on
    // the same runtime without exposing it outside this process.
    setActiveRuntime(runtime);
    api.agent.events.registerAgentEventSubscription({
      id: "anytype-session-output",
      description: "Streams bound Anytype session output to Knot, including scheduled runs.",
      streams: ["assistant", "thinking", "tool", "lifecycle", "item"],
      handle(event) {
        runtime.observeAgentEvent(event);
      },
    });
    api.lifecycle.registerRuntimeLifecycle({
      id: "anytype-bridge-cleanup",
      cleanup: async () => {
        await runtime.stopAll();
        if (activeRuntime() === runtime) setActiveRuntime(undefined);
      },
    });
  },
});

export { BridgeServer, DeliveryWorker, createDelivery } from "./bridge.js";
export { encodeRouteTarget, decodeRouteTarget } from "./protocol.js";
export type { AnytypeRoute, BridgeBinding, BridgeDelivery, BridgeInbound } from "./protocol.js";
export { BridgeStore } from "./store.js";

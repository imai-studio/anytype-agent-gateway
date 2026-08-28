import { randomUUID } from "node:crypto";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { BridgeServer, DeliveryWorker, createDelivery } from "./bridge.js";
import { createAnytypeChannel } from "./channel.js";
import { anytypePluginConfigSchema, resolveAnytypeAccount, } from "./config.js";
import { dispatchAnytypeInbound } from "./inbound.js";
import { BridgeStore } from "./store.js";
export class AnytypeChannelRuntime {
    #api;
    #accounts = new Map();
    constructor(api) {
        this.#api = api;
    }
    runtimeFor(cfg, accountId) {
        const account = resolveAnytypeAccount(cfg, accountId);
        const existing = this.#accounts.get(account.accountId);
        if (existing)
            return existing;
        if (!account.configured) {
            throw new Error(`Anytype account ${account.accountId} is not configured`);
        }
        const store = new BridgeStore(account.databasePath);
        store.pruneDelivered(Date.now() - 7 * 24 * 60 * 60 * 1000);
        store.pruneOwnedRuns(Date.now() - 7 * 24 * 60 * 60 * 1000);
        store.pruneExpiredPending(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const pruneTimer = setInterval(() => {
            store.pruneDelivered(Date.now() - 7 * 24 * 60 * 60 * 1000);
            store.pruneOwnedRuns(Date.now() - 7 * 24 * 60 * 60 * 1000);
            store.pruneExpiredPending(Date.now() - 30 * 24 * 60 * 60 * 1000);
        }, 24 * 60 * 60 * 1000);
        pruneTimer.unref?.();
        const worker = new DeliveryWorker({
            store,
            token: account.bridgeToken,
            log: (level, message) => this.#log(level, message),
        });
        const server = new BridgeServer({
            host: account.listenHost,
            port: account.listenPort,
            token: account.bridgeToken,
            store,
            log: (level, message) => this.#log(level, message),
            onInbound: async (inbound) => this.#dispatch(account, store, inbound),
        });
        const runtime = { account, store, worker, server, pruneTimer };
        this.#accounts.set(account.accountId, runtime);
        return runtime;
    }
    async startAccount(cfg, accountId) {
        const runtime = this.runtimeFor(cfg, accountId);
        await runtime.server.start();
        runtime.worker.start();
        return runtime;
    }
    async stopAccount(accountId) {
        const runtime = this.#accounts.get(accountId);
        if (!runtime)
            return;
        this.#accounts.delete(accountId);
        clearInterval(runtime.pruneTimer);
        runtime.worker.stop();
        await runtime.server.stop();
        runtime.store.close();
    }
    async stopAll() {
        await Promise.all([...this.#accounts.keys()].map((id) => this.stopAccount(id)));
    }
    enqueueFinal(params) {
        const runtime = this.runtimeFor(params.cfg, params.accountId);
        const delivery = createDelivery({
            sourceKey: params.sourceKey ??
                `final:${runtime.account.accountId}:${randomUUID()}`,
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
        void runtime.worker.flush();
        return delivery.id;
    }
    observeAgentEvent(event) {
        const sessionKey = event.sessionKey;
        if (!sessionKey)
            return;
        for (const runtime of this.#accounts.values()) {
            const binding = runtime.store.bindingForSession(sessionKey);
            if (!binding)
                continue;
            const allowedStreams = new Set(["assistant", "thinking", "tool", "lifecycle", "item"]);
            if (!allowedStreams.has(event.stream))
                return;
            const agentEvent = {
                runId: event.runId,
                seq: event.seq,
                stream: event.stream,
                timestamp: event.ts,
                data: sanitizeAgentEventData(event.stream, event.data),
            };
            runtime.store.putDelivery(createDelivery({
                sourceKey: `agent-event:${event.runId}:${event.seq}`,
                accountId: binding.accountId,
                sessionKey,
                route: binding.route,
                ...(runtime.store.isOwnedRun(event.runId) ? { owned: true } : {}),
                kind: "agent-event",
                agentEvent,
                createdAt: event.ts,
            }));
            void runtime.worker.flush();
            return;
        }
    }
    async #dispatch(account, store, inbound) {
        await dispatchAnytypeInbound({
            api: this.#api,
            cfg: this.#api.config,
            account,
            store,
            inbound,
            deliverReply: async ({ sessionKey, text }) => {
                this.enqueueFinal({
                    cfg: this.#api.config,
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
    #log(level, message) {
        const logger = this.#api.logger;
        if (level === "debug")
            logger.debug?.(message);
        else if (level === "info")
            logger.info(message);
        else if (level === "warn")
            logger.warn(message);
        else
            logger.error(message);
    }
}
function sanitizeAgentEventData(stream, data) {
    const keys = stream === "assistant" || stream === "thinking"
        ? ["delta", "text", "itemId", "partId", "messageId", "phase", "replace"]
        : stream === "tool"
            ? ["name", "toolName", "status", "phase"]
            : ["itemId", "partId", "messageId", "status", "phase", "state", "text"];
    const sanitized = {};
    for (const key of keys) {
        const value = data[key];
        if (typeof value === "string")
            sanitized[key] = value.slice(0, 32_000);
        else if (typeof value === "boolean" || typeof value === "number")
            sanitized[key] = value;
    }
    return sanitized;
}
let activeRuntime;
const requireRuntime = () => {
    if (!activeRuntime)
        throw new Error("Anytype channel runtime is not active");
    return activeRuntime;
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
        const active = await runtime.startAccount(ctx.cfg, ctx.account.accountId);
        ctx.setStatus({
            accountId: active.account.accountId,
            running: true,
            configured: true,
            enabled: active.account.enabled,
            mode: `bridge:${active.account.listenHost}:${active.account.listenPort}`,
        });
        await new Promise((resolve) => {
            if (ctx.abortSignal.aborted)
                return resolve();
            ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        await runtime.stopAccount(active.account.accountId);
    },
});
export default defineChannelPluginEntry({
    id: "anytype",
    name: "Anytype",
    description: "Native Anytype channel backed by the authenticated AAG bridge.",
    plugin: channel,
    configSchema: anytypePluginConfigSchema,
    registerFull(api) {
        const runtime = new AnytypeChannelRuntime(api);
        activeRuntime = runtime;
        api.agent.events.registerAgentEventSubscription({
            id: "anytype-session-output",
            description: "Streams bound Anytype session output to AAG, including scheduled runs.",
            streams: ["assistant", "thinking", "tool", "lifecycle", "item"],
            handle(event) {
                runtime.observeAgentEvent(event);
            },
        });
        api.lifecycle.registerRuntimeLifecycle({
            id: "anytype-bridge-cleanup",
            cleanup: async () => {
                await runtime.stopAll();
                if (activeRuntime === runtime)
                    activeRuntime = undefined;
            },
        });
    },
});
export { BridgeServer, DeliveryWorker, createDelivery } from "./bridge.js";
export { encodeRouteTarget, decodeRouteTarget } from "./protocol.js";
export { BridgeStore } from "./store.js";
//# sourceMappingURL=index.js.map
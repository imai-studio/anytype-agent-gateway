import { access, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { commandExists, runProcess } from "../process.js";
import { parseSilenceMarker } from "../protocol-markers.js";
import { resolveEnvironmentPair } from "../compatibility.js";
import { VERSION } from "../version.js";
const GATEWAY_RECONNECT_TIMEOUT_MS = 120_000;
const RECOVERED_RUN_HISTORY_TIMEOUT_MS = 120_000;
const MAX_GATEWAY_REQUEST_ATTEMPTS = 3;
const MAX_BRIDGE_PAGES_PER_POLL = 10;
const BRIDGE_SHUTDOWN_DRAIN_MS = 10_000;
export class OpenClawDriver {
    config;
    clientConstructor;
    discoverModelsOnStart;
    name = "openclaw";
    projectEnforcement = "advisory";
    capabilities = {
        steering: true,
        thinking: true,
        multipleOutputParts: true,
        sessionObservation: true,
        nativeScheduling: true,
        modelSelection: true,
    };
    client;
    pendingClient;
    rejectPendingConnection;
    closed = false;
    connecting;
    connected = false;
    connectionGeneration = 0;
    connectionWaiters = new Set();
    eventCallbacks = new Map();
    ownedRunIds = new Set();
    ownedTerminalTexts = new Map();
    ownedSessionLaunches = new Map();
    bridgeObservers = new Map();
    bridgePollTimer;
    bridgePolling;
    bridgeReceiptAbort = new AbortController();
    closing;
    lastBridgePollErrorAt = 0;
    constructor(config, clientConstructor, discoverModelsOnStart = false) {
        this.config = config;
        this.clientConstructor = clientConstructor;
        this.discoverModelsOnStart = discoverModelsOnStart;
    }
    async doctor() {
        if (!(await commandExists(this.config.command)))
            throw new Error(`OpenClaw command not found: ${this.config.command}`);
        const { stdout } = await runProcess(this.config.command, ["--version"], { timeoutMs: 10_000 });
        const client = await this.getClient();
        try {
            await this.request(client, "health", {}, { timeoutMs: 10_000 });
        }
        finally {
            this.disconnect(client);
        }
        const results = [
            `OpenClaw ${stdout.trim()}`,
            `Gateway ${this.config.gateway.url} via ${this.config.gateway.clientModule}`,
            `project policy: ${this.projectEnforcement} (enforced by OpenClaw configuration)`,
            this.config.maxRunSeconds > 0
                ? `Knot-requested run cap: ${this.config.maxRunSeconds}s`
                : "Knot-requested run cap: none (OpenClaw and provider-native limits still apply)",
        ];
        if (this.config.channelBridge.enabled) {
            await this.bridgeToken();
            const response = await fetch(new URL("/health", this.config.channelBridge.url), {
                signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok)
                throw new Error(`OpenClaw Anytype channel bridge returned HTTP ${response.status}`);
            results.push(`Anytype channel bridge ${this.config.channelBridge.url}`);
        }
        return results;
    }
    async close() {
        if (this.closing)
            return this.closing;
        this.closed = true;
        this.rejectPendingConnection?.(new Error("OpenClaw driver closed"));
        if (this.pendingClient)
            this.disconnect(this.pendingClient);
        if (this.client)
            this.disconnect(this.client);
        this.rejectConnectionWaiters(new Error("OpenClaw driver closed"));
        this.eventCallbacks.clear();
        this.ownedSessionLaunches.clear();
        if (this.bridgePollTimer)
            clearInterval(this.bridgePollTimer);
        this.bridgePollTimer = undefined;
        for (const observer of this.bridgeObservers.values())
            observer.abort.abort();
        this.bridgeObservers.clear();
        this.closing = this.drainBridgeWork(this.bridgePolling, this.bridgeReceiptAbort);
        await this.closing;
    }
    async configureModel(input) {
        const client = await this.getClient();
        const catalog = await this.request(client, "models.list", {}, { timeoutMs: 30_000 });
        const options = (catalog.models ?? []).flatMap((model) => {
            const id = typeof model.id === "string" ? model.id : undefined;
            const provider = typeof model.provider === "string" ? model.provider : undefined;
            if (!id)
                return [];
            const qualifiedId = provider && !id.includes("/") ? `${provider}/${id}` : id;
            return [
                {
                    id: qualifiedId,
                    name: typeof model.name === "string" ? model.name : qualifiedId,
                    ...(provider ? { provider } : {}),
                },
            ];
        });
        let currentModelId;
        if (input.modelId !== undefined) {
            const patched = await this.request(client, "sessions.patch", { key: this.resolveSessionKey(input.sessionKey), model: input.modelId }, { timeoutMs: 30_000 });
            const entry = (patched.entry ?? patched);
            const provider = typeof entry.providerOverride === "string" ? entry.providerOverride : undefined;
            const model = typeof entry.modelOverride === "string" ? entry.modelOverride : undefined;
            currentModelId = provider && model && !model.includes("/") ? `${provider}/${model}` : model;
        }
        return { options, ...(currentModelId ? { currentModelId } : {}) };
    }
    async start(input, onEvent) {
        const requestedSessionKey = this.resolveSessionKey(input.sessionKey);
        let sessionKey = requestedSessionKey;
        const useChannelBridge = this.config.channelBridge.enabled && input.origin !== "workflow";
        if (useChannelBridge) {
            if (!input.turn)
                throw new Error("OpenClaw channel bridge requires Anytype turn context");
        }
        const client = await this.getClient();
        let modelState;
        if (input.modelId !== undefined) {
            modelState = await this.configureModel({
                sessionKey: input.sessionKey,
                modelId: input.modelId,
            });
        }
        else if (this.discoverModelsOnStart) {
            modelState = await this.configureModel({ sessionKey: input.sessionKey }).catch(() => undefined);
        }
        let generation = 0;
        let currentRunId;
        let settled = false;
        let resolveResult;
        let rejectResult;
        const result = new Promise((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
        });
        const launch = async (method, params, launchGeneration, activateGeneration) => {
            const previousTerminal = await this.readTerminalCursor(client, sessionKey);
            const acknowledgement = await this.request(client, method, params, {
                timeoutMs: 30_000,
            });
            const runId = openClawAcknowledgedRunId(acknowledgement);
            if (!runId)
                throw new Error(`OpenClaw ${method} returned no runId`);
            const acknowledgedSessionKey = openClawAcknowledgedSessionKey(acknowledgement);
            if (acknowledgedSessionKey)
                sessionKey = acknowledgedSessionKey;
            currentRunId = runId;
            if (useChannelBridge) {
                this.markOwnedRun(runId);
                try {
                    await this.markBridgeOwnedRun(runId);
                    await this.bindBridgeSession(sessionKey, input.turn);
                }
                catch (error) {
                    await this.request(client, "sessions.abort", { key: sessionKey, runId }, { timeoutMs: 30_000 }).catch(() => undefined);
                    throw error;
                }
            }
            else {
                this.beginOwnedSessionLaunch(sessionKey);
            }
            activateGeneration?.();
            this.eventCallbacks.set(runId, onEvent);
            const runConnectionGeneration = this.connectionGeneration;
            void this.waitForRun(client, runId)
                .then(async (value) => {
                if (!settled && launchGeneration === generation) {
                    const text = extractText(value) ??
                        (await this.readTerminalText(client, sessionKey, previousTerminal));
                    if (text === undefined)
                        throw new Error(`OpenClaw run ${runId} completed without a visible text reply`);
                    const parsed = parseSilence(text);
                    this.markOwnedTerminalText(sessionKey, text);
                    settled = true;
                    resolveResult(parsed);
                }
            })
                .catch(async (error) => {
                if (settled || launchGeneration !== generation)
                    return;
                if (this.connectionGeneration > runConnectionGeneration) {
                    try {
                        const recoveredText = await this.waitForTerminalText(client, sessionKey, previousTerminal);
                        if (recoveredText !== undefined && !settled && launchGeneration === generation) {
                            this.markOwnedTerminalText(sessionKey, recoveredText);
                            settled = true;
                            resolveResult(parseSilence(recoveredText));
                            return;
                        }
                    }
                    catch {
                        /* Preserve the original agent.wait error below. */
                    }
                }
                if (!settled && launchGeneration === generation) {
                    settled = true;
                    rejectResult(error);
                }
            })
                .finally(() => {
                if (runId)
                    this.eventCallbacks.delete(runId);
                if (!useChannelBridge)
                    this.endOwnedSessionLaunch(sessionKey);
            });
        };
        const runLimit = this.config.maxRunSeconds > 0 ? { timeout: this.config.maxRunSeconds } : {};
        await launch("agent", {
            message: input.prompt,
            agentId: this.config.agentId,
            sessionKey: requestedSessionKey,
            ...runLimit,
            idempotencyKey: crypto.randomUUID(),
        }, generation);
        return {
            sessionKey,
            sessionId: sessionKey,
            ...(modelState ? { modelState } : {}),
            result,
            steer: async (message) => {
                const nextGeneration = generation + 1;
                await launch("sessions.steer", {
                    key: sessionKey,
                    agentId: this.config.agentId,
                    message,
                    ...(this.config.maxRunSeconds > 0
                        ? { timeoutMs: this.config.maxRunSeconds * 1000 }
                        : {}),
                    idempotencyKey: crypto.randomUUID(),
                }, nextGeneration, () => {
                    generation = nextGeneration;
                });
            },
            cancel: async () => {
                await this.request(client, "sessions.abort", { key: sessionKey, ...(currentRunId ? { runId: currentRunId } : {}) }, { timeoutMs: 30_000 });
            },
        };
    }
    async observeSession(input, onOutput) {
        const sessionKey = this.resolveSessionKey(input.sessionKey);
        if (this.config.channelBridge.enabled) {
            if (!input.conversation)
                throw new Error("OpenClaw channel observation requires Anytype route context");
            return this.observeBridgeSession(sessionKey, input.conversation, onOutput);
        }
        const client = await this.getClient();
        const abort = new AbortController();
        let cursor = input.afterCursor;
        let running = false;
        const poll = async () => {
            if (running || abort.signal.aborted)
                return;
            running = true;
            try {
                const history = await this.request(client, "chat.history", { sessionKey, limit: 100 }, { timeoutMs: 10_000 });
                const messages = Array.isArray(history?.messages) ? history.messages : [];
                const assistants = messages
                    .filter((message) => message?.role === "assistant")
                    .map((message) => {
                    const text = historyMessageText(message);
                    const id = historyMessageCursor(message);
                    return { id, text, timestamp: historyMessageTimestamp(message) };
                })
                    .filter((message) => Boolean(message.text));
                if (cursor === undefined) {
                    cursor = assistants.at(-1)?.id;
                    return;
                }
                const cursorIndex = assistants.findIndex((message) => message.id === cursor);
                const cursorTime = fallbackCursorTimestamp(cursor);
                const pending = cursorIndex >= 0
                    ? assistants.slice(cursorIndex + 1)
                    : cursorTime === undefined
                        ? []
                        : assistants.filter((message) => message.timestamp > cursorTime);
                for (const message of pending) {
                    if (abort.signal.aborted)
                        break;
                    if (!this.ownedSessionLaunches.has(sessionKey) &&
                        !this.consumeOwnedTerminalText(sessionKey, message.text))
                        await onOutput({
                            id: message.id,
                            cursor: message.id,
                            events: [
                                {
                                    type: "text-delta",
                                    text: message.text,
                                    partId: message.id,
                                    phase: "external",
                                    replace: true,
                                },
                            ],
                            result: { text: message.text },
                        });
                    cursor = message.id;
                }
            }
            finally {
                running = false;
            }
        };
        await poll();
        const timer = setInterval(() => {
            void poll().catch(() => undefined);
        }, this.config.livenessProbeSeconds * 1000);
        timer.unref?.();
        return {
            ...(cursor ? { cursor } : {}),
            close: async () => {
                abort.abort();
                clearInterval(timer);
            },
        };
    }
    resolveSessionKey(sessionKey) {
        const prefix = this.config.sessionKey;
        if (!prefix || sessionKey === prefix || sessionKey.startsWith(`${prefix}:`))
            return sessionKey;
        if (sessionKey.startsWith("agent:"))
            return sessionKey;
        return `${prefix}:${sessionKey}`;
    }
    async bindBridgeSession(sessionKey, turn) {
        const token = await this.bridgeToken();
        const response = await fetch(new URL("/v1/bindings", this.config.channelBridge.url), {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({
                accountId: this.config.channelBridge.accountId,
                sessionKey,
                route: {
                    spaceId: turn.conversation.spaceId,
                    chatId: turn.conversation.chatId,
                    ...(turn.conversation.kind === "discussion"
                        ? { discussionRootId: turn.replyTargetId }
                        : {}),
                },
            }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
            throw new Error(`OpenClaw Anytype channel binding failed with HTTP ${response.status}`);
    }
    async observeBridgeSession(sessionKey, conversation, onOutput) {
        if (this.closed)
            throw new Error("OpenClaw driver closed");
        const id = crypto.randomUUID();
        const state = {
            id,
            sessionKey,
            conversation,
            onOutput,
            runs: new Map(),
            recentOutputs: new Map(),
            afterSequence: 0,
            abort: new AbortController(),
            receiptAbort: new AbortController(),
        };
        this.bridgeObservers.set(id, state);
        try {
            await this.pollBridgeOutbox();
            if (state.abort.signal.aborted)
                throw new Error("OpenClaw observer closed");
        }
        catch (error) {
            this.bridgeObservers.delete(id);
            throw error;
        }
        if (!this.bridgePollTimer) {
            this.bridgePollTimer = setInterval(() => {
                void this.pollBridgeOutbox().catch((error) => this.reportBridgePollError(error));
            }, this.config.channelBridge.pollIntervalMilliseconds);
            this.bridgePollTimer.unref?.();
        }
        let closing;
        return {
            ...(state.cursor ? { cursor: state.cursor } : {}),
            close: async () => {
                if (closing)
                    return closing;
                state.abort.abort();
                this.bridgeObservers.delete(id);
                state.runs.clear();
                state.recentOutputs.clear();
                if (this.bridgeObservers.size === 0 && this.bridgePollTimer) {
                    clearInterval(this.bridgePollTimer);
                    this.bridgePollTimer = undefined;
                }
                closing = this.drainBridgeWork(state.inFlight, state.receiptAbort);
                await closing;
            },
        };
    }
    async drainBridgeWork(poll, receipts) {
        if (!poll)
            return;
        // onOutput has no cancellation contract. Bound the entire drain, including
        // that callback; receipts left pending can retry against the controller's
        // persisted proactive-delivery records (subject to their retention window).
        await new Promise((resolve) => {
            let settled = false;
            const finish = (reason) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                receipts.abort();
                if (reason)
                    process.stderr.write(`${JSON.stringify({ level: "warn", event: "openclaw_bridge_shutdown_incomplete", reason })}\n`);
                resolve();
            };
            // Keep the process alive until successful delivery can finish its ACK,
            // or this deadline cancels the ACK and leaves the bridge record pending.
            const timer = setTimeout(() => finish("timeout"), BRIDGE_SHUTDOWN_DRAIN_MS);
            void poll.then(() => finish(), (error) => finish(error instanceof Error && error.name === "AbortError" ? undefined : "poll_failed"));
        });
    }
    async pollBridgeOutbox() {
        if (this.bridgePolling)
            return this.bridgePolling;
        const poll = this.bridgeToken().then((token) => this.drainBridgeOutbox(token));
        this.bridgePolling = poll;
        try {
            await poll;
        }
        finally {
            if (this.bridgePolling === poll)
                this.bridgePolling = undefined;
        }
    }
    reportBridgePollError(error) {
        if (this.closed)
            return;
        const now = Date.now();
        if (now - this.lastBridgePollErrorAt < 60_000)
            return;
        this.lastBridgePollErrorAt = now;
        process.stderr.write(`${JSON.stringify({ level: "error", event: "openclaw_bridge_poll_failed", error: error instanceof Error ? error.message : String(error) })}\n`);
    }
    async drainBridgeOutbox(token) {
        for (const observer of [...this.bridgeObservers.values()]) {
            const work = this.drainBridgeObserver(token, observer);
            observer.inFlight = work;
            try {
                await work;
            }
            catch (error) {
                if (!observer.abort.signal.aborted ||
                    !(error instanceof Error) ||
                    error.name !== "AbortError")
                    throw error;
            }
            finally {
                if (observer.inFlight === work)
                    observer.inFlight = undefined;
            }
        }
    }
    async drainBridgeObserver(token, observer) {
        for (let page = 0; page < MAX_BRIDGE_PAGES_PER_POLL; page += 1) {
            if (!this.bridgeObservers.has(observer.id))
                return;
            const query = new URLSearchParams({
                limit: "1000",
                sessionKey: observer.sessionKey,
                spaceId: observer.conversation.spaceId,
                chatId: observer.conversation.chatId,
            });
            if (observer.conversation.kind === "discussion" && observer.conversation.discussionRootId)
                query.set("discussionRootId", observer.conversation.discussionRootId);
            if (observer.afterSequence > 0)
                query.set("afterSequence", String(observer.afterSequence));
            const response = await fetch(new URL(`/v1/outbox?${query}`, this.config.channelBridge.url), {
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.any([observer.abort.signal, AbortSignal.timeout(10_000)]),
            });
            if (!response.ok)
                throw new Error(`OpenClaw Anytype channel outbox returned HTTP ${response.status}`);
            const body = (await response.json());
            if (!this.bridgeObservers.has(observer.id))
                return;
            const deliveries = body.deliveries ?? [];
            for (const delivery of deliveries) {
                if (!this.bridgeObservers.has(observer.id))
                    return;
                if (!bridgeDeliveryMatches(observer, delivery))
                    continue;
                observer.cursor = delivery.idempotencyKey;
                if (delivery.kind === "message-final" && delivery.message) {
                    const text = delivery.message.text;
                    const owned = text ? this.consumeOwnedTerminalText(observer.sessionKey, text) : false;
                    let delivered = false;
                    if (text && !owned && !shouldSuppressBridgeTwin(observer, text, "message-final")) {
                        await observer.onOutput({
                            id: delivery.idempotencyKey,
                            cursor: delivery.idempotencyKey,
                            events: [
                                { type: "text-delta", text, partId: delivery.id, phase: "external", replace: true },
                            ],
                            result: parseSilence(text),
                        });
                        delivered = true;
                    }
                    if (!delivered && !this.bridgeObservers.has(observer.id))
                        return;
                    try {
                        // A successful local delivery must finish its receipt even if close
                        // cancelled the observer while onOutput was awaiting the send.
                        await this.ackBridgeDelivery(delivery.id, token, delivered
                            ? AbortSignal.any([observer.receiptAbort.signal, this.bridgeReceiptAbort.signal])
                            : observer.abort.signal);
                    }
                    catch (error) {
                        if (owned)
                            this.markOwnedTerminalText(observer.sessionKey, text);
                        throw error;
                    }
                    continue;
                }
                if (delivery.kind !== "agent-event" || !delivery.agentEvent)
                    continue;
                const event = delivery.agentEvent;
                const run = observer.runs.get(event.runId) ?? {
                    events: new Map(),
                    cursor: delivery.idempotencyKey,
                    deliveryIds: [],
                };
                if (!run.deliveryIds.includes(delivery.id))
                    run.deliveryIds.push(delivery.id);
                run.cursor = delivery.idempotencyKey;
                run.events.set(event.seq, event);
                observer.runs.set(event.runId, run);
                if (!bridgeEventTerminal(event))
                    continue;
                const owned = delivery.owned === true || this.ownedRunIds.has(event.runId);
                let delivered = false;
                if (!owned) {
                    const text = renderBridgeRun(run) || bridgeTerminalFailure(event);
                    if (text && !shouldSuppressBridgeTwin(observer, text, "agent-event")) {
                        await observer.onOutput({
                            id: event.runId,
                            cursor: run.cursor,
                            events: [
                                { type: "text-delta", text, partId: event.runId, phase: "external", replace: true },
                            ],
                            result: parseSilence(text),
                        });
                        delivered = true;
                    }
                }
                if (!delivered && !this.bridgeObservers.has(observer.id))
                    return;
                await this.ackBridgeDeliveries(run.deliveryIds, token, delivered
                    ? AbortSignal.any([observer.receiptAbort.signal, this.bridgeReceiptAbort.signal])
                    : observer.abort.signal);
                if (owned)
                    this.ownedRunIds.delete(event.runId);
                observer.runs.delete(event.runId);
            }
            const last = deliveries.at(-1);
            if (last?.storeSequence)
                observer.afterSequence = last.storeSequence;
            else if (deliveries.length >= 1_000)
                throw new Error("OpenClaw Anytype channel outbox omitted its pagination sequence");
            if (deliveries.length < 1_000)
                return;
        }
    }
    async ackBridgeDelivery(id, token, signal) {
        const response = await fetch(new URL(`/v1/outbox/${encodeURIComponent(id)}/ack`, this.config.channelBridge.url), {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
                : AbortSignal.timeout(10_000),
        });
        if (!response.ok)
            throw new Error(`OpenClaw Anytype channel acknowledgement returned HTTP ${response.status}`);
    }
    async markBridgeOwnedRun(runId) {
        const token = await this.bridgeToken();
        const response = await fetch(new URL("/v1/owned-runs", this.config.channelBridge.url), {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ runId }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
            throw new Error(`OpenClaw Anytype channel owned-run registration failed with HTTP ${response.status}`);
    }
    async ackBridgeDeliveries(ids, token, signal) {
        const response = await fetch(new URL("/v1/outbox/ack", this.config.channelBridge.url), {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ ids }),
            signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
                : AbortSignal.timeout(10_000),
        });
        if (!response.ok)
            throw new Error(`OpenClaw Anytype channel batch acknowledgement returned HTTP ${response.status}`);
    }
    async bridgeToken() {
        const token = compatibleConfiguredEnvironment(this.config.channelBridge.tokenEnv) ??
            (this.config.channelBridge.tokenFile
                ? (await readFile(this.config.channelBridge.tokenFile, "utf8")).trim()
                : undefined);
        if (!token || token.length < 24)
            throw new Error(`No OpenClaw Anytype bridge token in ${this.config.channelBridge.tokenEnv}${this.config.channelBridge.tokenFile ? ` or ${this.config.channelBridge.tokenFile}` : ""}`);
        return token;
    }
    markOwnedTerminalText(sessionKey, text) {
        const values = this.ownedTerminalTexts.get(sessionKey) ?? new Map();
        const key = normalizeOwnedText(text);
        values.set(key, (values.get(key) ?? 0) + 1);
        while (values.size > 100) {
            const oldest = values.keys().next().value;
            if (!oldest)
                break;
            values.delete(oldest);
        }
        this.ownedTerminalTexts.delete(sessionKey);
        this.ownedTerminalTexts.set(sessionKey, values);
        while (this.ownedTerminalTexts.size > 1_000) {
            const oldestSession = this.ownedTerminalTexts.keys().next().value;
            if (!oldestSession)
                break;
            this.ownedTerminalTexts.delete(oldestSession);
        }
    }
    beginOwnedSessionLaunch(sessionKey) {
        this.ownedSessionLaunches.set(sessionKey, (this.ownedSessionLaunches.get(sessionKey) ?? 0) + 1);
    }
    endOwnedSessionLaunch(sessionKey) {
        const count = this.ownedSessionLaunches.get(sessionKey) ?? 0;
        if (count <= 1)
            this.ownedSessionLaunches.delete(sessionKey);
        else
            this.ownedSessionLaunches.set(sessionKey, count - 1);
    }
    markOwnedRun(runId) {
        this.ownedRunIds.add(runId);
        while (this.ownedRunIds.size > 10_000) {
            const oldest = this.ownedRunIds.values().next().value;
            if (!oldest)
                break;
            this.ownedRunIds.delete(oldest);
        }
    }
    consumeOwnedTerminalText(sessionKey, text) {
        const values = this.ownedTerminalTexts.get(sessionKey);
        const key = normalizeOwnedText(text);
        const count = values?.get(key) ?? 0;
        if (!values || count === 0)
            return false;
        if (count === 1)
            values.delete(key);
        else
            values.set(key, count - 1);
        if (values.size === 0)
            this.ownedTerminalTexts.delete(sessionKey);
        return true;
    }
    async getClient() {
        if (this.closed)
            throw new Error("OpenClaw driver closed");
        if (this.client)
            return this.client;
        if (this.connecting)
            return this.connecting;
        this.connecting = (async () => {
            const Client = this.clientConstructor ?? (await this.loadClientConstructor());
            const token = await this.readToken();
            if (this.closed)
                throw new Error("OpenClaw driver closed");
            let settle;
            let fail;
            const connected = new Promise((resolve, reject) => {
                settle = resolve;
                fail = reject;
            });
            this.rejectPendingConnection = fail;
            const client = new Client({
                url: this.config.gateway.url,
                token,
                clientName: "gateway-client",
                clientDisplayName: "Knot",
                clientVersion: VERSION,
                platform: process.platform,
                mode: "backend",
                role: "operator",
                scopes: ["operator.read", "operator.write"],
                minProtocol: this.config.gateway.protocolVersion,
                maxProtocol: this.config.gateway.protocolVersion,
                onHelloOk: () => {
                    if (this.closed || (this.pendingClient !== client && this.client !== client))
                        return;
                    this.connected = true;
                    this.connectionGeneration += 1;
                    this.resolveConnectionWaiters();
                    settle();
                },
                onConnectError: fail,
                onClose: () => {
                    if (this.pendingClient !== client && this.client !== client)
                        return;
                    this.connected = false;
                },
                onEvent: (event) => {
                    if (event?.event !== "agent")
                        return;
                    const payload = event.payload;
                    const callback = typeof payload?.runId === "string" ? this.eventCallbacks.get(payload.runId) : undefined;
                    if (!callback)
                        return;
                    if (payload?.stream === "tool")
                        callback({
                            type: "tool",
                            name: payload.data?.name ?? payload.data?.toolName ?? "tool",
                            status: payload.data?.status ?? "running",
                        });
                    else if (payload?.stream === "assistant") {
                        const text = typeof payload.data?.delta === "string"
                            ? payload.data.delta
                            : typeof payload.data?.text === "string"
                                ? payload.data.text
                                : undefined;
                        if (text !== undefined)
                            callback({
                                type: "text-delta",
                                text,
                                ...(payload.data?.itemId ? { partId: String(payload.data.itemId) } : {}),
                                ...(payload.data?.phase ? { phase: String(payload.data.phase) } : {}),
                                ...(payload.data?.replace === true ? { replace: true } : {}),
                            });
                    }
                    else if (payload?.stream === "thinking") {
                        const text = typeof payload.data?.delta === "string"
                            ? payload.data.delta
                            : typeof payload.data?.text === "string"
                                ? payload.data.text
                                : undefined;
                        if (text !== undefined)
                            callback({
                                type: "thinking-delta",
                                text,
                                ...(payload.data?.itemId ? { partId: String(payload.data.itemId) } : {}),
                                ...(payload.data?.phase ? { phase: String(payload.data.phase) } : {}),
                                ...(payload.data?.replace === true ? { replace: true } : {}),
                            });
                    }
                    else if (payload?.stream === "lifecycle" || payload?.stream === "item")
                        callback({
                            type: "status",
                            text: String(payload.data?.phase ?? payload.data?.status ?? payload.stream),
                        });
                },
            });
            this.pendingClient = client;
            try {
                client.start();
                await connected;
                if (this.closed)
                    throw new Error("OpenClaw driver closed");
                this.client = client;
                return client;
            }
            catch (error) {
                if (this.pendingClient === client)
                    this.disconnect(client);
                throw error;
            }
            finally {
                if (this.pendingClient === client)
                    this.pendingClient = undefined;
                this.rejectPendingConnection = undefined;
            }
        })().finally(() => {
            this.connecting = undefined;
        });
        return this.connecting;
    }
    async loadClientConstructor() {
        const candidates = await this.clientModuleCandidates();
        let lastError;
        for (const candidate of candidates) {
            const moduleName = isAbsolute(candidate) ? pathToFileURL(candidate).href : candidate;
            try {
                const loaded = (await import(moduleName));
                if (!loaded.GatewayClient)
                    throw new Error("module has no GatewayClient export");
                return loaded.GatewayClient;
            }
            catch (error) {
                lastError = error;
            }
        }
        throw new Error(`Could not load an OpenClaw Gateway client (tried ${candidates.join(", ")}): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    async request(client, method, params, options) {
        for (let attempt = 1; attempt <= MAX_GATEWAY_REQUEST_ATTEMPTS; attempt += 1) {
            if (this.closed)
                throw new Error("OpenClaw driver closed");
            await this.waitForConnection(this.connectionGeneration - (this.connected ? 1 : 0));
            if (this.closed)
                throw new Error("OpenClaw driver closed");
            const generation = this.connectionGeneration;
            try {
                return await client.request(method, params, options);
            }
            catch (error) {
                if (!isGatewayConnectionError(error) || attempt === MAX_GATEWAY_REQUEST_ATTEMPTS)
                    throw error;
                await this.waitForConnection(generation);
            }
        }
        throw new Error(`OpenClaw ${method} request exhausted reconnect attempts`);
    }
    waitForConnection(afterGeneration) {
        if (this.closed)
            return Promise.reject(new Error("OpenClaw driver closed"));
        if (this.connected && this.connectionGeneration > afterGeneration)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const waiter = {
                afterGeneration,
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.connectionWaiters.delete(waiter);
                    reject(new Error(`OpenClaw gateway did not reconnect within ${GATEWAY_RECONNECT_TIMEOUT_MS / 1000} seconds`));
                }, GATEWAY_RECONNECT_TIMEOUT_MS),
            };
            waiter.timer.unref?.();
            this.connectionWaiters.add(waiter);
        });
    }
    resolveConnectionWaiters() {
        for (const waiter of this.connectionWaiters) {
            if (this.connectionGeneration <= waiter.afterGeneration)
                continue;
            clearTimeout(waiter.timer);
            this.connectionWaiters.delete(waiter);
            waiter.resolve();
        }
    }
    rejectConnectionWaiters(error) {
        for (const waiter of this.connectionWaiters) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
        this.connectionWaiters.clear();
    }
    disconnect(client) {
        client.stop();
        if (this.client === client)
            this.client = undefined;
        if (this.pendingClient === client)
            this.pendingClient = undefined;
        this.connected = false;
    }
    async clientModuleCandidates() {
        const candidates = [this.config.gateway.clientModule];
        if (this.config.gateway.clientModule !== "@openclaw/gateway-client")
            return candidates;
        try {
            const { stdout } = await runProcess("sh", ["-lc", 'command -v -- "$1"', "sh", this.config.command], { timeoutMs: 5_000 });
            let root = dirname(await realpath(stdout.trim()));
            for (let depth = 0; depth < 6; depth += 1) {
                const candidate = join(root, "packages", "gateway-client", "dist", "index.mjs");
                try {
                    await access(candidate);
                    candidates.push(candidate);
                    break;
                }
                catch {
                    root = dirname(root);
                }
            }
        }
        catch {
            /* The import error below includes the configured module. */
        }
        return candidates;
    }
    async readToken() {
        const fromEnvironment = compatibleConfiguredEnvironment(this.config.gateway.tokenEnv);
        if (fromEnvironment)
            return fromEnvironment;
        const raw = JSON.parse(await readFile(this.config.gateway.configFile, "utf8"));
        const token = raw?.gateway?.auth?.token;
        if (typeof token !== "string" || !token)
            throw new Error(`No OpenClaw Gateway token in ${this.config.gateway.tokenEnv} or ${this.config.gateway.configFile}`);
        return token;
    }
    async waitForRun(client, runId) {
        const waitMilliseconds = this.config.livenessProbeSeconds * 1000;
        const deadline = this.config.maxRunSeconds > 0
            ? Date.now() + this.config.maxRunSeconds * 1000
            : Number.POSITIVE_INFINITY;
        while (Date.now() < deadline) {
            try {
                const value = await this.request(client, "agent.wait", { runId, timeoutMs: waitMilliseconds }, { timeoutMs: null });
                if (!agentWaitPending(value))
                    return value;
            }
            catch (error) {
                if (!agentWaitTimedOut(error))
                    throw error;
            }
        }
        throw new Error(`OpenClaw run exceeded the configured maximum of ${this.config.maxRunSeconds} seconds`);
    }
    async readTerminalCursor(client, sessionKey) {
        const history = await this.request(client, "chat.history", { sessionKey, limit: 20 }, { timeoutMs: 10_000 });
        const messages = Array.isArray(history?.messages) ? history.messages : [];
        const latest = [...messages]
            .reverse()
            .find((message) => message?.role === "assistant" && historyMessageText(message));
        return latest ? historyMessageCursor(latest) : undefined;
    }
    async readTerminalText(client, sessionKey, excludeCursor, attempts = 5) {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const history = await this.request(client, "chat.history", { sessionKey, limit: 20 }, { timeoutMs: 10_000 });
            const messages = Array.isArray(history?.messages) ? history.messages : [];
            for (const message of [...messages].reverse()) {
                if (message?.role !== "assistant")
                    continue;
                const content = Array.isArray(message.content)
                    ? message.content
                        .map((part) => part?.text)
                        .filter(Boolean)
                        .join("")
                    : typeof message.content === "string"
                        ? message.content
                        : undefined;
                if (content && historyMessageCursor(message) !== excludeCursor)
                    return content;
            }
            if (attempt + 1 < attempts)
                await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        }
        return undefined;
    }
    async waitForTerminalText(client, sessionKey, excludeCursor) {
        const configured = this.config.maxRunSeconds > 0
            ? this.config.maxRunSeconds * 1000
            : RECOVERED_RUN_HISTORY_TIMEOUT_MS;
        const deadline = Date.now() + Math.min(configured, RECOVERED_RUN_HISTORY_TIMEOUT_MS);
        while (Date.now() < deadline) {
            const text = await this.readTerminalText(client, sessionKey, excludeCursor, 1);
            if (text !== undefined)
                return text;
            await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        return undefined;
    }
}
function isGatewayConnectionError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /gateway (?:closed|not connected|client stopped)/i.test(message);
}
function extractText(value) {
    const payloads = value?.result?.payloads ?? value?.payloads;
    if (Array.isArray(payloads)) {
        const text = payloads
            .map((item) => item?.text)
            .filter((item) => typeof item === "string" && item.length > 0)
            .join("\n\n");
        return text || undefined;
    }
    for (const path of [
        value?.result?.text,
        value?.text,
        value?.message,
        value?.result?.message,
        value?.terminalReply,
        value?.terminalReply?.text,
    ])
        if (typeof path === "string" && path.length > 0)
            return path;
    return undefined;
}
function openClawAcknowledgedRunId(value) {
    const result = value.result && typeof value.result === "object"
        ? value.result
        : undefined;
    const runId = value.runId ?? result?.runId;
    return typeof runId === "string" && runId ? runId : undefined;
}
function openClawAcknowledgedSessionKey(value) {
    const result = value.result && typeof value.result === "object"
        ? value.result
        : undefined;
    const sessionKey = value.sessionKey ?? value.key ?? result?.sessionKey ?? result?.key;
    return typeof sessionKey === "string" && sessionKey ? sessionKey : undefined;
}
function agentWaitPending(value) {
    const status = String(value?.status ?? value?.result?.status ?? "").toLocaleLowerCase();
    return status === "timeout" || status === "pending" || status === "running";
}
function agentWaitTimedOut(error) {
    return /(?:agent\.wait|request|operation).*(?:timed out|timeout)|(?:timed out|timeout).*(?:agent\.wait|request|operation)/i.test(error instanceof Error ? error.message : String(error));
}
function historyMessageText(message) {
    if (typeof message?.content === "string")
        return message.content;
    if (!Array.isArray(message?.content))
        return undefined;
    const text = message.content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
    return text || undefined;
}
function historyMessageCursor(message) {
    const stable = message?.id ?? message?.messageId ?? message?.uuid;
    if (typeof stable === "string" && stable)
        return stable;
    const timestamp = historyMessageTimestamp(message);
    const digest = createHash("sha256")
        .update(JSON.stringify({ timestamp, role: message?.role, content: message?.content }))
        .digest("base64url")
        .slice(0, 16);
    return `t:${timestamp}:${digest}`;
}
function historyMessageTimestamp(message) {
    const value = Number(message?.timestamp ?? message?.createdAt ?? message?.created_at ?? 0);
    return Number.isFinite(value) ? value : 0;
}
function fallbackCursorTimestamp(cursor) {
    const match = /^t:(\d+):/u.exec(cursor ?? "");
    if (!match?.[1])
        return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
}
function bridgeDeliveryMatches(observer, delivery) {
    if (delivery.sessionKey !== undefined)
        return delivery.sessionKey === observer.sessionKey;
    const route = delivery.route;
    const conversation = observer.conversation;
    return (route?.spaceId === conversation.spaceId &&
        route.chatId === conversation.chatId &&
        (route.discussionRootId ?? "") ===
            (conversation.kind === "discussion" ? (conversation.discussionRootId ?? "") : ""));
}
function shouldSuppressBridgeTwin(observer, text, kind) {
    const now = Date.now();
    for (const [key, value] of observer.recentOutputs)
        if (now - value.timestamp > 30_000)
            observer.recentOutputs.delete(key);
    const key = normalizeOwnedText(text);
    const previous = observer.recentOutputs.get(key);
    if (previous && previous.kind !== kind) {
        observer.recentOutputs.delete(key);
        return true;
    }
    observer.recentOutputs.set(key, { kind, timestamp: now });
    while (observer.recentOutputs.size > 100)
        observer.recentOutputs.delete(observer.recentOutputs.keys().next().value);
    return false;
}
function renderBridgeRun(run) {
    const parts = new Map();
    const order = [];
    for (const event of [...run.events.values()].sort((left, right) => left.seq - right.seq)) {
        if (event.stream !== "assistant")
            continue;
        const text = typeof event.data.delta === "string"
            ? event.data.delta
            : typeof event.data.text === "string"
                ? event.data.text
                : undefined;
        if (text === undefined)
            continue;
        const partId = String(event.data.itemId ?? event.data.partId ?? event.data.messageId ?? "assistant");
        if (!parts.has(partId))
            order.push(partId);
        const previous = parts.get(partId) ?? "";
        parts.set(partId, event.data.replace === true ? text : previous + text);
    }
    return order
        .map((part) => parts.get(part) ?? "")
        .filter(Boolean)
        .join("\n\n");
}
function bridgeEventTerminal(event) {
    if (event.stream !== "lifecycle")
        return false;
    const status = String(event.data.phase ?? event.data.status ?? event.data.state ?? "").toLowerCase();
    return [
        "end",
        "ended",
        "error",
        "failed",
        "abort",
        "aborted",
        "cancelled",
        "canceled",
        "complete",
        "completed",
        "done",
    ].includes(status);
}
function bridgeTerminalFailure(event) {
    const status = String(event.data.phase ?? event.data.status ?? event.data.state ?? "").toLowerCase();
    if (!["error", "failed", "abort", "aborted", "cancelled", "canceled"].includes(status))
        return "";
    const detail = typeof event.data.text === "string" ? `: ${event.data.text}` : "";
    return `OpenClaw external run ${status}${detail}`;
}
function normalizeOwnedText(text) {
    return text.normalize("NFKC").replace(/\s+/gu, "");
}
export function parseSilence(text) {
    const marker = parseSilenceMarker(text);
    return marker ? { text: "", silent: true, ...marker } : { text };
}
function compatibleConfiguredEnvironment(name) {
    if (name.startsWith("AAG_"))
        return resolveEnvironmentPair(`KNOT_${name.slice(4)}`, name);
    if (name.startsWith("KNOT_"))
        return resolveEnvironmentPair(name, `AAG_${name.slice(5)}`);
    return process.env[name];
}

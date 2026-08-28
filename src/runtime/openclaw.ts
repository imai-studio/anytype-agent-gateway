import { access, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentConfig } from "../config.js";
import { commandExists, runProcess } from "../process.js";
import type { ActiveRuntime, ConversationRef, RuntimeDriver, RuntimeEvent, RuntimeResult, RuntimeSessionObserver, RuntimeSessionOutput, RuntimeTurn } from "../types.js";
import { VERSION } from "../version.js";

type GatewayClientLike = {
  start(): void;
  stop(): void;
  request<T = Record<string, unknown>>(method: string, params?: unknown, options?: { expectFinal?: boolean; timeoutMs?: number | null; onAccepted?: (payload: unknown) => void }): Promise<T>;
};
type GatewayClientConstructor = new (options: Record<string, unknown>) => GatewayClientLike;

const GATEWAY_RECONNECT_TIMEOUT_MS = 120_000;
const RECOVERED_RUN_HISTORY_TIMEOUT_MS = 120_000;
const MAX_GATEWAY_REQUEST_ATTEMPTS = 3;

type ConnectionWaiter = {
  afterGeneration: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class OpenClawDriver implements RuntimeDriver {
  readonly name = "openclaw";
  readonly projectEnforcement = "advisory" as const;
  readonly capabilities = {
    steering: true,
    thinking: true,
    multipleOutputParts: true,
    sessionObservation: true,
    nativeScheduling: true
  } as const;
  private client: GatewayClientLike | undefined;
  private connecting: Promise<GatewayClientLike> | undefined;
  private connected = false;
  private connectionGeneration = 0;
  private readonly connectionWaiters = new Set<ConnectionWaiter>();
  private readonly eventCallbacks = new Map<string, (event: RuntimeEvent) => void>();
  private readonly ownedRunIds = new Set<string>();
  private readonly ownedTerminalTexts = new Map<string, Map<string, number>>();
  private readonly bridgeObservers = new Map<string, BridgeObserverState>();
  private bridgePollTimer: NodeJS.Timeout | undefined;
  private bridgePolling: Promise<void> | undefined;
  private lastBridgePollErrorAt = 0;

  constructor(
    private readonly config: Extract<AgentConfig["runtime"], { kind: "openclaw" }>,
    private readonly clientConstructor?: GatewayClientConstructor
  ) {}

  async doctor(): Promise<string[]> {
    if (!await commandExists(this.config.command)) throw new Error(`OpenClaw command not found: ${this.config.command}`);
    const { stdout } = await runProcess(this.config.command, ["--version"], { timeoutMs: 10_000 });
    const client = await this.getClient();
    try { await this.request(client, "health", {}, { timeoutMs: 10_000 }); }
    finally { this.disconnect(client); }
    const results = [`OpenClaw ${stdout.trim()}`, `Gateway ${this.config.gateway.url} via ${this.config.gateway.clientModule}`, `project policy: ${this.projectEnforcement} (enforced by OpenClaw configuration)`];
    if (this.config.channelBridge.enabled) {
      await this.bridgeToken();
      const response = await fetch(new URL("/health", this.config.channelBridge.url), { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`OpenClaw Anytype channel bridge returned HTTP ${response.status}`);
      results.push(`Anytype channel bridge ${this.config.channelBridge.url}`);
    }
    return results;
  }

  async close(): Promise<void> {
    if (this.client) this.disconnect(this.client);
    this.rejectConnectionWaiters(new Error("OpenClaw driver closed"));
    this.eventCallbacks.clear();
    if (this.bridgePollTimer) clearInterval(this.bridgePollTimer);
    this.bridgePollTimer = undefined;
    this.bridgeObservers.clear();
  }

  async start(input: { sessionKey: string; prompt: string; turn?: RuntimeTurn }, onEvent: (event: RuntimeEvent) => void): Promise<ActiveRuntime> {
    const sessionKey = this.config.sessionKey ? `${this.config.sessionKey}:${input.sessionKey}` : input.sessionKey;
    if (this.config.channelBridge.enabled) {
      if (!input.turn) throw new Error("OpenClaw channel bridge requires Anytype turn context");
      await this.bindBridgeSession(sessionKey, input.turn);
    }
    const client = await this.getClient();
    let generation = 0;
    let currentRunId: string | undefined;
    let settled = false;
    let resolveResult!: (value: RuntimeResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<RuntimeResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });

    const launch = async (method: "agent" | "sessions.steer", params: Record<string, unknown>, launchGeneration: number, activateGeneration?: () => void): Promise<void> => {
      const previousTerminal = await this.readTerminalCursor(client, sessionKey);
      const acknowledgement = await this.request<{ runId?: string }>(client, method, params, { timeoutMs: 30_000 });
      const runId = acknowledgement.runId;
      if (!runId) throw new Error(`OpenClaw ${method} returned no runId`);
      currentRunId = runId;
      if (this.config.channelBridge.enabled) {
        try { await this.markBridgeOwnedRun(runId); }
        catch (error) {
          await this.request(client, "sessions.abort", { key: sessionKey, runId }, { timeoutMs: 30_000 }).catch(() => undefined);
          throw error;
        }
        this.markOwnedRun(runId);
      }
      activateGeneration?.();
      this.eventCallbacks.set(runId, onEvent);
      const runConnectionGeneration = this.connectionGeneration;
      void this.waitForRun(client, runId).then(async value => {
        if (!settled && launchGeneration === generation) {
          const text = extractText(value) ?? await this.readTerminalText(client, sessionKey, previousTerminal);
          if (text === undefined) throw new Error(`OpenClaw run ${runId} completed without a visible text reply`);
          const parsed = parseSilence(text);
          if (!this.config.channelBridge.enabled) this.markOwnedTerminalText(sessionKey, text);
          settled = true;
          resolveResult(parsed);
        }
      }).catch(async error => {
        if (settled || launchGeneration !== generation) return;
        if (this.connectionGeneration > runConnectionGeneration) {
          try {
            const recoveredText = await this.waitForTerminalText(client, sessionKey, previousTerminal);
            if (recoveredText !== undefined && !settled && launchGeneration === generation) {
              if (!this.config.channelBridge.enabled) this.markOwnedTerminalText(sessionKey, recoveredText);
              settled = true;
              resolveResult(parseSilence(recoveredText));
              return;
            }
          } catch { /* Preserve the original agent.wait error below. */ }
        }
        if (!settled && launchGeneration === generation) { settled = true; rejectResult(error); }
      }).finally(() => { if (runId) this.eventCallbacks.delete(runId); });
    };

    const runLimit = this.config.maxRunSeconds > 0 ? { timeout: this.config.maxRunSeconds } : {};
    await launch("agent", { message: input.prompt, agentId: this.config.agentId, sessionKey, ...runLimit, idempotencyKey: crypto.randomUUID() }, generation);
    return {
      sessionKey,
      sessionId: sessionKey,
      result,
      steer: async message => {
        const nextGeneration = generation + 1;
        await launch("sessions.steer", { key: sessionKey, agentId: this.config.agentId, message, ...(this.config.maxRunSeconds > 0 ? { timeoutMs: this.config.maxRunSeconds * 1000 } : {}), idempotencyKey: crypto.randomUUID() }, nextGeneration, () => { generation = nextGeneration; });
      },
      cancel: async () => { await this.request(client, "sessions.abort", { key: sessionKey, ...(currentRunId ? { runId: currentRunId } : {}) }, { timeoutMs: 30_000 }); }
    };
  }

  async observeSession(input: { sessionKey: string; afterCursor?: string; conversation?: ConversationRef }, onOutput: (output: RuntimeSessionOutput) => Promise<void>): Promise<RuntimeSessionObserver> {
    const sessionKey = this.config.sessionKey ? `${this.config.sessionKey}:${input.sessionKey}` : input.sessionKey;
    if (this.config.channelBridge.enabled) {
      if (!input.conversation) throw new Error("OpenClaw channel observation requires Anytype route context");
      return this.observeBridgeSession(sessionKey, input.conversation, onOutput);
    }
    const client = await this.getClient();
    const abort = new AbortController();
    let cursor = input.afterCursor;
    let running = false;
    const poll = async (): Promise<void> => {
      if (running || abort.signal.aborted) return;
      running = true;
      try {
        const history = await this.request<any>(client, "chat.history", { sessionKey, limit: 100 }, { timeoutMs: 10_000 });
        const messages = Array.isArray(history?.messages) ? history.messages : [];
        const assistants = messages.filter((message: any) => message?.role === "assistant").map((message: any) => {
          const text = historyMessageText(message);
          const id = historyMessageCursor(message);
          return { id, text, timestamp: historyMessageTimestamp(message) };
        }).filter((message: { id: string; text?: string }) => Boolean(message.text));
        if (cursor === undefined) {
          cursor = assistants.at(-1)?.id;
          return;
        }
        const cursorIndex = assistants.findIndex((message: { id: string }) => message.id === cursor);
        const cursorTime = fallbackCursorTimestamp(cursor);
        const pending = cursorIndex >= 0 ? assistants.slice(cursorIndex + 1) : cursorTime === undefined ? [] : assistants.filter((message: { timestamp: number }) => message.timestamp > cursorTime);
        for (const message of pending) {
          if (abort.signal.aborted) break;
          if (!this.consumeOwnedTerminalText(sessionKey, message.text!)) await onOutput({ id: message.id, cursor: message.id, events: [{ type: "text-delta", text: message.text!, partId: message.id, phase: "external", replace: true }], result: { text: message.text! } });
          cursor = message.id;
        }
      } finally { running = false; }
    };
    await poll();
    const timer = setInterval(() => { void poll().catch(() => undefined); }, this.config.livenessProbeSeconds * 1000);
    timer.unref?.();
    return { ...(cursor ? { cursor } : {}), close: async () => { abort.abort(); clearInterval(timer); } };
  }

  private async bindBridgeSession(sessionKey: string, turn: RuntimeTurn): Promise<void> {
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
          ...(turn.conversation.kind === "discussion" ? { discussionRootId: turn.replyTargetId } : {}),
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`OpenClaw Anytype channel binding failed with HTTP ${response.status}`);
  }

  private async observeBridgeSession(sessionKey: string, conversation: ConversationRef, onOutput: (output: RuntimeSessionOutput) => Promise<void>): Promise<RuntimeSessionObserver> {
    const id = crypto.randomUUID();
    const state: BridgeObserverState = { id, sessionKey, conversation, onOutput, runs: new Map() };
    this.bridgeObservers.set(id, state);
    try { await this.pollBridgeOutbox(); }
    catch (error) { this.bridgeObservers.delete(id); throw error; }
    if (!this.bridgePollTimer) {
      this.bridgePollTimer = setInterval(() => { void this.pollBridgeOutbox().catch(error => this.reportBridgePollError(error)); }, this.config.channelBridge.pollIntervalMilliseconds);
      this.bridgePollTimer.unref?.();
    }
    return {
      ...(state.cursor ? { cursor: state.cursor } : {}),
      close: async () => {
        this.bridgeObservers.delete(id);
        state.runs.clear();
        if (this.bridgeObservers.size === 0 && this.bridgePollTimer) {
          clearInterval(this.bridgePollTimer);
          this.bridgePollTimer = undefined;
        }
      },
    };
  }

  private async pollBridgeOutbox(): Promise<void> {
    if (this.bridgePolling) return this.bridgePolling;
    const poll = this.bridgeToken().then(token => this.drainBridgeOutbox(token));
    this.bridgePolling = poll;
    try { await poll; }
    finally { if (this.bridgePolling === poll) this.bridgePolling = undefined; }
  }

  private reportBridgePollError(error: unknown): void {
    const now = Date.now();
    if (now - this.lastBridgePollErrorAt < 60_000) return;
    this.lastBridgePollErrorAt = now;
    process.stderr.write(`${JSON.stringify({ level: "error", event: "openclaw_bridge_poll_failed", error: error instanceof Error ? error.message : String(error) })}\n`);
  }

  private async drainBridgeOutbox(token: string): Promise<void> {
    let afterSequence = 0;
    for (;;) {
      const query = new URLSearchParams({ limit: "1000" });
      if (afterSequence > 0) query.set("afterSequence", String(afterSequence));
      const response = await fetch(new URL(`/v1/outbox?${query}`, this.config.channelBridge.url), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`OpenClaw Anytype channel outbox returned HTTP ${response.status}`);
      const body = await response.json() as { deliveries?: BridgeDelivery[] };
      const deliveries = body.deliveries ?? [];
      for (const delivery of deliveries) {
        const observer = [...this.bridgeObservers.values()].find(candidate => bridgeDeliveryMatches(candidate, delivery));
        if (!observer) continue;
        observer.cursor = delivery.idempotencyKey;
        if (delivery.kind === "message-final" && delivery.message) {
          if (delivery.message.text) await observer.onOutput({ id: delivery.idempotencyKey, cursor: delivery.idempotencyKey, events: [{ type: "text-delta", text: delivery.message.text, partId: delivery.id, phase: "external", replace: true }], result: parseSilence(delivery.message.text) });
          await this.ackBridgeDelivery(delivery.id, token);
          continue;
        }
        if (delivery.kind !== "agent-event" || !delivery.agentEvent) continue;
        const event = delivery.agentEvent;
        const run: BridgeRun = observer.runs.get(event.runId) ?? { events: new Map(), cursor: delivery.idempotencyKey, deliveryIds: [] };
        if (!run.deliveryIds.includes(delivery.id)) run.deliveryIds.push(delivery.id);
        run.cursor = delivery.idempotencyKey;
        run.events.set(event.seq, event);
        observer.runs.set(event.runId, run);
        if (!bridgeEventTerminal(event)) continue;
        const owned = delivery.owned === true || this.ownedRunIds.has(event.runId);
        if (!owned) {
          const text = renderBridgeRun(run) || bridgeTerminalFailure(event);
          if (text) await observer.onOutput({ id: event.runId, cursor: run.cursor, events: [{ type: "text-delta", text, partId: event.runId, phase: "external", replace: true }], result: parseSilence(text) });
        }
        await this.ackBridgeDeliveries(run.deliveryIds, token);
        if (owned) this.ownedRunIds.delete(event.runId);
        observer.runs.delete(event.runId);
      }
      if (deliveries.length < 1_000) break;
      const last = deliveries.at(-1)!;
      afterSequence = last.storeSequence ?? 0;
      if (afterSequence === 0) throw new Error("OpenClaw Anytype channel outbox omitted its pagination sequence");
    }
  }

  private async ackBridgeDelivery(id: string, token: string): Promise<void> {
    const response = await fetch(new URL(`/v1/outbox/${encodeURIComponent(id)}/ack`, this.config.channelBridge.url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`OpenClaw Anytype channel acknowledgement returned HTTP ${response.status}`);
  }

  private async markBridgeOwnedRun(runId: string): Promise<void> {
    const token = await this.bridgeToken();
    const response = await fetch(new URL("/v1/owned-runs", this.config.channelBridge.url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ runId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`OpenClaw Anytype channel owned-run registration failed with HTTP ${response.status}`);
  }

  private async ackBridgeDeliveries(ids: string[], token: string): Promise<void> {
    const response = await fetch(new URL("/v1/outbox/ack", this.config.channelBridge.url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`OpenClaw Anytype channel batch acknowledgement returned HTTP ${response.status}`);
  }

  private async bridgeToken(): Promise<string> {
    const token = process.env[this.config.channelBridge.tokenEnv]
      ?? (this.config.channelBridge.tokenFile ? (await readFile(this.config.channelBridge.tokenFile, "utf8")).trim() : undefined);
    if (!token || token.length < 24) throw new Error(`No OpenClaw Anytype bridge token in ${this.config.channelBridge.tokenEnv}${this.config.channelBridge.tokenFile ? ` or ${this.config.channelBridge.tokenFile}` : ""}`);
    return token;
  }

  private markOwnedTerminalText(sessionKey: string, text: string): void {
    const values = this.ownedTerminalTexts.get(sessionKey) ?? new Map<string, number>();
    const key = normalizeOwnedText(text);
    values.set(key, (values.get(key) ?? 0) + 1);
    this.ownedTerminalTexts.set(sessionKey, values);
  }

  private markOwnedRun(runId: string): void {
    this.ownedRunIds.add(runId);
    while (this.ownedRunIds.size > 10_000) {
      const oldest = this.ownedRunIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.ownedRunIds.delete(oldest);
    }
  }

  private consumeOwnedTerminalText(sessionKey: string, text: string): boolean {
    const values = this.ownedTerminalTexts.get(sessionKey);
    const key = normalizeOwnedText(text);
    const count = values?.get(key) ?? 0;
    if (!values || count === 0) return false;
    if (count === 1) values.delete(key); else values.set(key, count - 1);
    if (values.size === 0) this.ownedTerminalTexts.delete(sessionKey);
    return true;
  }

  private async getClient(): Promise<GatewayClientLike> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const Client = this.clientConstructor ?? await this.loadClientConstructor();
      const token = await this.readToken();
      let settle!: () => void;
      let fail!: (error: unknown) => void;
      const connected = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });
      const client = new Client({
        url: this.config.gateway.url,
        token,
        clientName: "gateway-client",
        clientDisplayName: "Anytype Agent Gateway",
        clientVersion: VERSION,
        platform: process.platform,
        mode: "backend",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        minProtocol: this.config.gateway.protocolVersion,
        maxProtocol: this.config.gateway.protocolVersion,
        onHelloOk: () => {
          this.connected = true;
          this.connectionGeneration += 1;
          this.resolveConnectionWaiters();
          settle();
        },
        onConnectError: fail,
        onClose: () => { this.connected = false; },
        onEvent: (event: any) => {
          if (event?.event !== "agent") return;
          const payload = event.payload;
          const callback = typeof payload?.runId === "string" ? this.eventCallbacks.get(payload.runId) : undefined;
          if (!callback) return;
          if (payload?.stream === "tool") callback({ type: "tool", name: payload.data?.name ?? payload.data?.toolName ?? "tool", status: payload.data?.status ?? "running" });
          else if (payload?.stream === "assistant") {
            const text = typeof payload.data?.delta === "string" ? payload.data.delta : typeof payload.data?.text === "string" ? payload.data.text : undefined;
            if (text !== undefined) callback({ type: "text-delta", text, ...(payload.data?.itemId ? { partId: String(payload.data.itemId) } : {}), ...(payload.data?.phase ? { phase: String(payload.data.phase) } : {}), ...(payload.data?.replace === true ? { replace: true } : {}) });
          } else if (payload?.stream === "thinking") {
            const text = typeof payload.data?.delta === "string" ? payload.data.delta : typeof payload.data?.text === "string" ? payload.data.text : undefined;
            if (text !== undefined) callback({ type: "thinking-delta", text, ...(payload.data?.itemId ? { partId: String(payload.data.itemId) } : {}), ...(payload.data?.phase ? { phase: String(payload.data.phase) } : {}), ...(payload.data?.replace === true ? { replace: true } : {}) });
          } else if (payload?.stream === "lifecycle" || payload?.stream === "item") callback({ type: "status", text: String(payload.data?.phase ?? payload.data?.status ?? payload.stream) });
        }
      });
      client.start();
      await connected;
      this.client = client;
      return client;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async loadClientConstructor(): Promise<GatewayClientConstructor> {
    const candidates = await this.clientModuleCandidates();
    let lastError: unknown;
    for (const candidate of candidates) {
      const moduleName = isAbsolute(candidate) ? pathToFileURL(candidate).href : candidate;
      try {
        const loaded = await import(moduleName) as { GatewayClient?: GatewayClientConstructor };
        if (!loaded.GatewayClient) throw new Error("module has no GatewayClient export");
        return loaded.GatewayClient;
      } catch (error) { lastError = error; }
    }
    throw new Error(`Could not load an OpenClaw Gateway client (tried ${candidates.join(", ")}): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private async request<T>(client: GatewayClientLike, method: string, params: unknown, options: { expectFinal?: boolean; timeoutMs?: number | null; onAccepted?: (payload: unknown) => void }): Promise<T> {
    for (let attempt = 1; attempt <= MAX_GATEWAY_REQUEST_ATTEMPTS; attempt += 1) {
      await this.waitForConnection(this.connectionGeneration - (this.connected ? 1 : 0));
      const generation = this.connectionGeneration;
      try {
        return await client.request<T>(method, params, options);
      } catch (error) {
        if (!isGatewayConnectionError(error) || attempt === MAX_GATEWAY_REQUEST_ATTEMPTS) throw error;
        await this.waitForConnection(generation);
      }
    }
    throw new Error(`OpenClaw ${method} request exhausted reconnect attempts`);
  }

  private waitForConnection(afterGeneration: number): Promise<void> {
    if (this.connected && this.connectionGeneration > afterGeneration) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: ConnectionWaiter = {
        afterGeneration,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.connectionWaiters.delete(waiter);
          reject(new Error(`OpenClaw gateway did not reconnect within ${GATEWAY_RECONNECT_TIMEOUT_MS / 1000} seconds`));
        }, GATEWAY_RECONNECT_TIMEOUT_MS)
      };
      waiter.timer.unref?.();
      this.connectionWaiters.add(waiter);
    });
  }

  private resolveConnectionWaiters(): void {
    for (const waiter of this.connectionWaiters) {
      if (this.connectionGeneration <= waiter.afterGeneration) continue;
      clearTimeout(waiter.timer);
      this.connectionWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private rejectConnectionWaiters(error: Error): void {
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.connectionWaiters.clear();
  }

  private disconnect(client: GatewayClientLike): void {
    client.stop();
    if (this.client === client) this.client = undefined;
    this.connected = false;
  }

  private async clientModuleCandidates(): Promise<string[]> {
    const candidates = [this.config.gateway.clientModule];
    if (this.config.gateway.clientModule !== "@openclaw/gateway-client") return candidates;
    try {
      const { stdout } = await runProcess("sh", ["-lc", "command -v -- \"$1\"", "sh", this.config.command], { timeoutMs: 5_000 });
      let root = dirname(await realpath(stdout.trim()));
      for (let depth = 0; depth < 6; depth += 1) {
        const candidate = join(root, "packages", "gateway-client", "dist", "index.mjs");
        try { await access(candidate); candidates.push(candidate); break; } catch { root = dirname(root); }
      }
    } catch { /* The import error below includes the configured module. */ }
    return candidates;
  }

  private async readToken(): Promise<string> {
    const fromEnvironment = process.env[this.config.gateway.tokenEnv];
    if (fromEnvironment) return fromEnvironment;
    const raw = JSON.parse(await readFile(this.config.gateway.configFile, "utf8")) as any;
    const token = raw?.gateway?.auth?.token;
    if (typeof token !== "string" || !token) throw new Error(`No OpenClaw Gateway token in ${this.config.gateway.tokenEnv} or ${this.config.gateway.configFile}`);
    return token;
  }

  private async waitForRun(client: GatewayClientLike, runId: string): Promise<any> {
    const waitMilliseconds = this.config.livenessProbeSeconds * 1000;
    const deadline = this.config.maxRunSeconds > 0 ? Date.now() + this.config.maxRunSeconds * 1000 : Number.POSITIVE_INFINITY;
    while (Date.now() < deadline) {
      try {
        const value = await this.request<any>(client, "agent.wait", { runId, timeoutMs: waitMilliseconds }, { timeoutMs: null });
        if (!agentWaitPending(value)) return value;
      } catch (error) {
        if (!agentWaitTimedOut(error)) throw error;
      }
    }
    throw new Error(`OpenClaw run exceeded the configured maximum of ${this.config.maxRunSeconds} seconds`);
  }

  private async readTerminalCursor(client: GatewayClientLike, sessionKey: string): Promise<string | undefined> {
    const history = await this.request<any>(client, "chat.history", { sessionKey, limit: 20 }, { timeoutMs: 10_000 });
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    const latest = [...messages].reverse().find(message => message?.role === "assistant" && historyMessageText(message));
    return latest ? historyMessageCursor(latest) : undefined;
  }

  private async readTerminalText(client: GatewayClientLike, sessionKey: string, excludeCursor?: string, attempts = 5): Promise<string | undefined> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const history = await this.request<any>(client, "chat.history", { sessionKey, limit: 20 }, { timeoutMs: 10_000 });
      const messages = Array.isArray(history?.messages) ? history.messages : [];
      for (const message of [...messages].reverse()) {
        if (message?.role !== "assistant") continue;
        const content = Array.isArray(message.content) ? message.content.map((part: any) => part?.text).filter(Boolean).join("") : typeof message.content === "string" ? message.content : undefined;
        if (content && historyMessageCursor(message) !== excludeCursor) return content;
      }
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
    return undefined;
  }

  private async waitForTerminalText(client: GatewayClientLike, sessionKey: string, excludeCursor?: string): Promise<string | undefined> {
    const configured = this.config.maxRunSeconds > 0 ? this.config.maxRunSeconds * 1000 : RECOVERED_RUN_HISTORY_TIMEOUT_MS;
    const deadline = Date.now() + Math.min(configured, RECOVERED_RUN_HISTORY_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const text = await this.readTerminalText(client, sessionKey, excludeCursor, 1);
      if (text !== undefined) return text;
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    return undefined;
  }
}

function isGatewayConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /gateway (?:closed|not connected|client stopped)/i.test(message);
}

function extractText(value: any): string | undefined {
  const payloads = value?.result?.payloads ?? value?.payloads;
  if (Array.isArray(payloads)) return payloads.map(item => item?.text).filter(Boolean).join("\n\n");
  for (const path of [value?.result?.text, value?.text, value?.message, value?.result?.message, value?.terminalReply, value?.terminalReply?.text]) if (typeof path === "string") return path;
  return undefined;
}

function agentWaitPending(value: any): boolean {
  const status = String(value?.status ?? value?.result?.status ?? "").toLocaleLowerCase();
  return status === "timeout" || status === "pending" || status === "running";
}

function agentWaitTimedOut(error: unknown): boolean {
  return /(?:agent\.wait|request|operation).*(?:timed out|timeout)|(?:timed out|timeout).*(?:agent\.wait|request|operation)/i.test(error instanceof Error ? error.message : String(error));
}

function historyMessageText(message: any): string | undefined {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return undefined;
  const text = message.content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("");
  return text || undefined;
}

function historyMessageCursor(message: any): string {
  const stable = message?.id ?? message?.messageId ?? message?.uuid;
  if (typeof stable === "string" && stable) return stable;
  const timestamp = historyMessageTimestamp(message);
  const digest = createHash("sha256").update(JSON.stringify({ timestamp, role: message?.role, content: message?.content })).digest("base64url").slice(0, 16);
  return `t:${timestamp}:${digest}`;
}

function historyMessageTimestamp(message: any): number {
  const value = Number(message?.timestamp ?? message?.createdAt ?? message?.created_at ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function fallbackCursorTimestamp(cursor: string | undefined): number | undefined {
  const match = /^t:(\d+):/u.exec(cursor ?? "");
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

type BridgeAgentEvent = {
  runId: string;
  seq: number;
  stream: "assistant" | "thinking" | "tool" | "lifecycle" | "item";
  timestamp: number;
  data: Record<string, unknown>;
};

type BridgeDelivery = {
  id: string;
  idempotencyKey: string;
  sessionKey?: string;
  route?: { spaceId: string; chatId: string; discussionRootId?: string };
  createdAt?: number;
  storeSequence?: number;
  owned?: boolean;
  kind: "agent-event" | "message-final";
  agentEvent?: BridgeAgentEvent;
  message?: { text: string; replyToId?: string };
};

type BridgeRun = { events: Map<number, BridgeAgentEvent>; cursor: string; deliveryIds: string[] };

type BridgeObserverState = {
  id: string;
  sessionKey: string;
  conversation: ConversationRef;
  onOutput: (output: RuntimeSessionOutput) => Promise<void>;
  runs: Map<string, BridgeRun>;
  cursor?: string;
};

function bridgeDeliveryMatches(observer: BridgeObserverState, delivery: BridgeDelivery): boolean {
  if (delivery.sessionKey === observer.sessionKey) return true;
  const route = delivery.route;
  const conversation = observer.conversation;
  return route?.spaceId === conversation.spaceId
    && route.chatId === conversation.chatId
    && (route.discussionRootId ?? "") === (conversation.kind === "discussion" ? conversation.discussionRootId ?? "" : "");
}

function renderBridgeRun(run: BridgeRun): string {
  const parts = new Map<string, string>();
  const order: string[] = [];
  for (const event of [...run.events.values()].sort((left, right) => left.seq - right.seq)) {
    if (event.stream !== "assistant") continue;
    const text = typeof event.data.delta === "string" ? event.data.delta : typeof event.data.text === "string" ? event.data.text : undefined;
    if (text === undefined) continue;
    const partId = String(event.data.itemId ?? event.data.partId ?? event.data.messageId ?? "assistant");
    if (!parts.has(partId)) order.push(partId);
    const previous = parts.get(partId) ?? "";
    parts.set(partId, event.data.replace === true ? text : previous + text);
  }
  return order.map(part => parts.get(part) ?? "").filter(Boolean).join("\n\n");
}

function bridgeEventTerminal(event: BridgeAgentEvent): boolean {
  if (event.stream !== "lifecycle") return false;
  const status = String(event.data.phase ?? event.data.status ?? event.data.state ?? "").toLowerCase();
  return ["end", "ended", "error", "failed", "abort", "aborted", "cancelled", "canceled", "complete", "completed", "done"].includes(status);
}

function bridgeTerminalFailure(event: BridgeAgentEvent): string {
  const status = String(event.data.phase ?? event.data.status ?? event.data.state ?? "").toLowerCase();
  if (!["error", "failed", "abort", "aborted", "cancelled", "canceled"].includes(status)) return "";
  const detail = typeof event.data.text === "string" ? `: ${event.data.text}` : "";
  return `OpenClaw external run ${status}${detail}`;
}

function normalizeOwnedText(text: string): string { return text.normalize("NFKC").replace(/\s+/gu, ""); }

export function parseSilence(text: string): RuntimeResult {
  const match = text.trim().match(/^\[\[AAG_STAY_SILENT(?::\s*(.*?))?\]\]$/s);
  return match ? { text: "", silent: true, ...(match[1] ? { reason: match[1] } : {}) } : { text };
}

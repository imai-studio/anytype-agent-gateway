import { access, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { commandExists, runProcess } from "../process.js";
import { VERSION } from "../version.js";
const GATEWAY_RECONNECT_TIMEOUT_MS = 120_000;
const RECOVERED_RUN_HISTORY_TIMEOUT_MS = 120_000;
const MAX_GATEWAY_REQUEST_ATTEMPTS = 3;
export class OpenClawDriver {
    config;
    clientConstructor;
    name = "openclaw";
    projectEnforcement = "advisory";
    client;
    connecting;
    connected = false;
    connectionGeneration = 0;
    connectionWaiters = new Set();
    eventCallbacks = new Map();
    constructor(config, clientConstructor) {
        this.config = config;
        this.clientConstructor = clientConstructor;
    }
    async doctor() {
        if (!await commandExists(this.config.command))
            throw new Error(`OpenClaw command not found: ${this.config.command}`);
        const { stdout } = await runProcess(this.config.command, ["--version"], { timeoutMs: 10_000 });
        const client = await this.getClient();
        try {
            await this.request(client, "health", {}, { timeoutMs: 10_000 });
        }
        finally {
            this.disconnect(client);
        }
        return [`OpenClaw ${stdout.trim()}`, `Gateway ${this.config.gateway.url} via ${this.config.gateway.clientModule}`, `project policy: ${this.projectEnforcement} (enforced by OpenClaw configuration)`];
    }
    async close() {
        if (this.client)
            this.disconnect(this.client);
        this.rejectConnectionWaiters(new Error("OpenClaw driver closed"));
        this.eventCallbacks.clear();
    }
    async start(input, onEvent) {
        const sessionKey = this.config.sessionKey ? `${this.config.sessionKey}:${input.sessionKey}` : input.sessionKey;
        const client = await this.getClient();
        let generation = 0;
        let currentRunId;
        let settled = false;
        let resolveResult;
        let rejectResult;
        const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
        const launch = async (method, params, launchGeneration) => {
            const previousTerminal = await this.readTerminalText(client, sessionKey, undefined, 1);
            const acknowledgement = await this.request(client, method, params, { timeoutMs: 30_000 });
            const runId = acknowledgement.runId;
            if (!runId)
                throw new Error(`OpenClaw ${method} returned no runId`);
            currentRunId = runId;
            this.eventCallbacks.set(runId, onEvent);
            const runConnectionGeneration = this.connectionGeneration;
            void this.request(client, "agent.wait", { runId, timeoutMs: this.config.timeoutSeconds * 1000 }, { timeoutMs: null }).then(async (value) => {
                if (!settled && launchGeneration === generation) {
                    const text = extractText(value) ?? await this.readTerminalText(client, sessionKey, previousTerminal);
                    if (text === undefined)
                        throw new Error(`OpenClaw run ${runId} completed without a visible text reply`);
                    const parsed = parseSilence(text);
                    settled = true;
                    resolveResult(parsed);
                }
            }).catch(async (error) => {
                if (settled || launchGeneration !== generation)
                    return;
                if (this.connectionGeneration > runConnectionGeneration) {
                    try {
                        const recoveredText = await this.waitForTerminalText(client, sessionKey, previousTerminal);
                        if (recoveredText !== undefined && !settled && launchGeneration === generation) {
                            settled = true;
                            resolveResult(parseSilence(recoveredText));
                            return;
                        }
                    }
                    catch { /* Preserve the original agent.wait error below. */ }
                }
                if (!settled && launchGeneration === generation) {
                    settled = true;
                    rejectResult(error);
                }
            }).finally(() => { if (runId)
                this.eventCallbacks.delete(runId); });
        };
        await launch("agent", { message: input.prompt, agentId: this.config.agentId, sessionKey, timeout: this.config.timeoutSeconds, idempotencyKey: crypto.randomUUID() }, generation);
        return {
            result,
            steer: async (message) => {
                generation += 1;
                await launch("sessions.steer", { key: sessionKey, agentId: this.config.agentId, message, timeoutMs: this.config.timeoutSeconds * 1000, idempotencyKey: crypto.randomUUID() }, generation);
            },
            cancel: async () => { await this.request(client, "sessions.abort", { key: sessionKey, ...(currentRunId ? { runId: currentRunId } : {}) }, { timeoutMs: 30_000 }); }
        };
    }
    async getClient() {
        if (this.client)
            return this.client;
        if (this.connecting)
            return this.connecting;
        this.connecting = (async () => {
            const Client = this.clientConstructor ?? await this.loadClientConstructor();
            const token = await this.readToken();
            let settle;
            let fail;
            const connected = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
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
                onEvent: (event) => {
                    if (event?.event !== "agent")
                        return;
                    const payload = event.payload;
                    const callback = typeof payload?.runId === "string" ? this.eventCallbacks.get(payload.runId) : undefined;
                    if (!callback)
                        return;
                    if (payload?.stream === "tool")
                        callback({ type: "tool", name: payload.data?.name ?? payload.data?.toolName ?? "tool", status: payload.data?.status ?? "running" });
                    else if (payload?.stream === "assistant" && typeof payload.data?.delta === "string")
                        callback({ type: "text-delta", text: payload.data.delta });
                }
            });
            client.start();
            await connected;
            this.client = client;
            return client;
        })().finally(() => { this.connecting = undefined; });
        return this.connecting;
    }
    async loadClientConstructor() {
        const candidates = await this.clientModuleCandidates();
        let lastError;
        for (const candidate of candidates) {
            const moduleName = isAbsolute(candidate) ? pathToFileURL(candidate).href : candidate;
            try {
                const loaded = await import(moduleName);
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
            await this.waitForConnection(this.connectionGeneration - (this.connected ? 1 : 0));
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
                }, GATEWAY_RECONNECT_TIMEOUT_MS)
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
        this.connected = false;
    }
    async clientModuleCandidates() {
        const candidates = [this.config.gateway.clientModule];
        if (this.config.gateway.clientModule !== "@openclaw/gateway-client")
            return candidates;
        try {
            const { stdout } = await runProcess("sh", ["-lc", "command -v -- \"$1\"", "sh", this.config.command], { timeoutMs: 5_000 });
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
        catch { /* The import error below includes the configured module. */ }
        return candidates;
    }
    async readToken() {
        const fromEnvironment = process.env[this.config.gateway.tokenEnv];
        if (fromEnvironment)
            return fromEnvironment;
        const raw = JSON.parse(await readFile(this.config.gateway.configFile, "utf8"));
        const token = raw?.gateway?.auth?.token;
        if (typeof token !== "string" || !token)
            throw new Error(`No OpenClaw Gateway token in ${this.config.gateway.tokenEnv} or ${this.config.gateway.configFile}`);
        return token;
    }
    async readTerminalText(client, sessionKey, exclude, attempts = 5) {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const history = await this.request(client, "chat.history", { sessionKey, limit: 20 }, { timeoutMs: 10_000 });
            const messages = Array.isArray(history?.messages) ? history.messages : [];
            for (const message of [...messages].reverse()) {
                if (message?.role !== "assistant")
                    continue;
                const content = Array.isArray(message.content) ? message.content.map((part) => part?.text).filter(Boolean).join("") : typeof message.content === "string" ? message.content : undefined;
                if (content && content !== exclude)
                    return content;
            }
            if (attempt + 1 < attempts)
                await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
        return undefined;
    }
    async waitForTerminalText(client, sessionKey, exclude) {
        const deadline = Date.now() + Math.min(this.config.timeoutSeconds * 1000, RECOVERED_RUN_HISTORY_TIMEOUT_MS);
        while (Date.now() < deadline) {
            const text = await this.readTerminalText(client, sessionKey, exclude, 1);
            if (text !== undefined)
                return text;
            await new Promise(resolve => setTimeout(resolve, 2_000));
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
    if (Array.isArray(payloads))
        return payloads.map(item => item?.text).filter(Boolean).join("\n\n");
    for (const path of [value?.result?.text, value?.text, value?.message, value?.result?.message, value?.terminalReply, value?.terminalReply?.text])
        if (typeof path === "string")
            return path;
    return undefined;
}
export function parseSilence(text) {
    const match = text.trim().match(/^\[\[AAG_STAY_SILENT(?::\s*(.*?))?\]\]$/s);
    return match ? { text: "", silent: true, ...(match[1] ? { reason: match[1] } : {}) } : { text };
}

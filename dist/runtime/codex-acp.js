import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { associateCodexDesktopThread, createCodexDesktopThread, hydrateCodexDesktopTask, } from "../codex-desktop.js";
import { commandExists } from "../process.js";
import { parseSilence } from "./openclaw.js";
const SKILL_WARNING_PREFIXES = [
    "Warning: Skill descriptions were shortened",
    "Warning: Exceeded skills context budget",
];
const LEADING_SKILL_WARNING = /^\s*Warning:\s*(?:Skill descriptions were shortened to fit the (?:\d+%\s+)?skills context budget\. Codex can still see every skill, but some descriptions are shorter\. Disable unused skills or plugins to leave more room for the rest\.|Exceeded skills context budget\. All skill descriptions were removed and \d+ additional skills were not included in the model-visible skills list\.)/;
export class RuntimeTurnAlreadyCompletedError extends Error {
    name = "RuntimeTurnAlreadyCompletedError";
    constructor() {
        super("Codex ACP turn already completed before the steer arrived");
    }
}
export class CodexAcpDriver {
    config;
    store;
    mcpServer;
    agentName;
    name = "codex-acp";
    projectEnforcement = "advisory";
    capabilities = {
        steering: true,
        thinking: true,
        multipleOutputParts: true,
        sessionObservation: false,
        nativeScheduling: false,
        modelSelection: true,
    };
    repeatedInternalLoadFailures = new Map();
    hydratedDesktopSessions = new Set();
    constructor(config, store, mcpServer, agentName) {
        this.config = config;
        this.store = store;
        this.mcpServer = mcpServer;
        this.agentName = agentName;
    }
    async doctor() {
        if (!(await commandExists(this.config.command)))
            throw new Error(`Codex ACP command not found: ${this.config.command}`);
        const lines = [
            `Codex ACP command: ${this.config.command}`,
            `project policy: ${this.projectEnforcement} (ACP cwd + additionalDirectories)`,
        ];
        if (this.config.desktopProject === "auto")
            lines.push("Codex Desktop project association: auto (exact workspace match)");
        return lines;
    }
    async configureModel(input) {
        if (input.modelId !== undefined)
            throw new Error("Codex model changes must be applied with the next session prompt");
        const workspacePath = input.turn?.workspacePath ?? this.config.defaultProject;
        const child = spawn(this.config.command, this.config.args, {
            cwd: workspacePath,
            env: inheritedAgentEnvironment(this.config.environment),
            stdio: ["pipe", "pipe", "pipe"],
        });
        const childFailure = new Promise((_resolve, reject) => child.once("error", reject));
        void childFailure.catch(() => undefined);
        let actorFile;
        try {
            actorFile =
                this.mcpServer && input.turn
                    ? await writeActorContext(this.mcpServer.actorDirectory, input.sessionKey, input.turn.message.creator)
                    : undefined;
        }
        catch (error) {
            if (child.exitCode === null)
                child.kill("SIGTERM");
            throw error;
        }
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr = `${stderr}${String(chunk)}`.slice(-4000);
        });
        const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
        const app = acp.client({ name: "anytype-agent-gateway" });
        let timeout;
        try {
            const operation = app.connectWith(stream, async (ctx) => {
                const initialized = await ctx.request(acp.methods.agent.initialize, {
                    protocolVersion: acp.PROTOCOL_VERSION,
                    clientCapabilities: {},
                });
                const additionalDirectories = [
                    ...this.config.allowedProjects,
                    ...(this.config.defaultProject && this.config.defaultProject !== workspacePath
                        ? [this.config.defaultProject]
                        : []),
                ];
                const sessionSetup = {
                    cwd: workspacePath ?? process.cwd(),
                    mcpServers: this.mcpServer
                        ? [
                            {
                                name: "aag-anytype",
                                command: this.mcpServer.command,
                                args: this.mcpServer.args,
                                env: mcpEnvironment(this.mcpServer.env, input.turn, actorFile),
                            },
                        ]
                        : [],
                    ...(additionalDirectories.length ? { additionalDirectories } : {}),
                };
                let sessionId = this.store?.codexAcpSession(input.sessionKey);
                const persistedSessionId = sessionId;
                let response;
                if (sessionId && initialized.agentCapabilities?.loadSession) {
                    try {
                        try {
                            response = await ctx.request(acp.methods.agent.session.load, {
                                ...sessionSetup,
                                sessionId,
                            });
                        }
                        catch (error) {
                            if (!savedSessionInternallyBroken(error))
                                throw error;
                            await new Promise((resolve) => setTimeout(resolve, 250));
                            response = await ctx.request(acp.methods.agent.session.load, {
                                ...sessionSetup,
                                sessionId,
                            });
                        }
                    }
                    catch (error) {
                        if (!savedSessionUnavailable(error))
                            throw error;
                        this.store?.deleteCodexAcpSession(input.sessionKey);
                        sessionId = undefined;
                    }
                }
                if (!sessionId) {
                    const created = (await ctx.request(acp.methods.agent.session.new, sessionSetup));
                    response = created;
                    sessionId = created.sessionId;
                }
                if (!sessionId)
                    throw new Error("Codex ACP returned no session ID");
                if (persistedSessionId && sessionId === persistedSessionId) {
                    this.store?.saveCodexAcpSession(input.sessionKey, sessionId);
                    await this.associateDesktopProject(sessionId, input.turn);
                }
                const configOptions = response?.configOptions ?? [];
                const model = findModelConfig(configOptions);
                const defaultModelId = input.defaultModelId ?? model?.defaultValue ?? model?.currentValue;
                return {
                    options: model?.options ?? [],
                    ...(model?.currentValue ? { currentModelId: model.currentValue } : {}),
                    ...(defaultModelId ? { defaultModelId } : {}),
                    sessionId,
                };
            });
            const timeoutMs = (this.config.setupTimeoutSeconds ?? 30) * 1000;
            return await Promise.race([
                operation,
                childFailure,
                new Promise((_resolve, reject) => {
                    timeout = setTimeout(() => {
                        if (child.exitCode === null)
                            child.kill("SIGTERM");
                        reject(new Error(`Codex model discovery timed out after ${timeoutMs / 1000} seconds`));
                    }, timeoutMs);
                    timeout.unref?.();
                }),
            ]);
        }
        catch (error) {
            throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr.trim() ? `; codex-acp stderr: ${stderr.trim()}` : ""}`);
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
            if (child.exitCode === null)
                child.kill("SIGTERM");
            if (actorFile)
                await unlink(actorFile).catch(() => undefined);
        }
    }
    async start(input, onEvent) {
        const workspacePath = input.turn?.workspacePath ?? this.config.defaultProject;
        const environment = inheritedAgentEnvironment(this.config.environment);
        const child = spawn(this.config.command, this.config.args, {
            cwd: workspacePath,
            env: environment,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const childFailure = new Promise((_resolve, reject) => child.once("error", reject));
        void childFailure.catch(() => undefined);
        let actorFile;
        try {
            actorFile =
                this.mcpServer && input.turn
                    ? await writeActorContext(this.mcpServer.actorDirectory, input.sessionKey, input.turn.message.creator)
                    : undefined;
        }
        catch (error) {
            if (child.exitCode === null)
                child.kill("SIGTERM");
            throw error;
        }
        let actorId = input.turn?.message.creator;
        let gracefulTerminationTimer;
        let forceTerminationTimer;
        const clearTerminationTimers = () => {
            if (gracefulTerminationTimer)
                clearTimeout(gracefulTerminationTimer);
            if (forceTerminationTimer)
                clearTimeout(forceTerminationTimer);
            gracefulTerminationTimer = undefined;
            forceTerminationTimer = undefined;
        };
        const terminateNow = () => {
            if (gracefulTerminationTimer)
                clearTimeout(gracefulTerminationTimer);
            gracefulTerminationTimer = undefined;
            if (child.exitCode !== null)
                return;
            child.kill("SIGTERM");
            if (!forceTerminationTimer) {
                forceTerminationTimer = setTimeout(() => {
                    forceTerminationTimer = undefined;
                    if (child.exitCode === null)
                        child.kill("SIGKILL");
                }, 1_000);
                forceTerminationTimer.unref?.();
            }
        };
        const terminateAfterGrace = () => {
            if (child.exitCode !== null || gracefulTerminationTimer || forceTerminationTimer)
                return;
            const graceMs = (this.config.terminationGraceSeconds ?? 20) * 1000;
            if (graceMs === 0) {
                terminateNow();
                return;
            }
            gracefulTerminationTimer = setTimeout(terminateNow, graceMs);
            gracefulTerminationTimer.unref?.();
        };
        child.once("exit", clearTerminationTimers);
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr = `${stderr}${String(chunk)}`.slice(-4000);
        });
        const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
        let context;
        let sessionId;
        let modelState;
        let output = "";
        const messageTexts = new Map();
        let latestMessageId;
        let finalMessageId;
        let acceptingSteers = true;
        let replayingHistory = false;
        const filteredText = new LeadingSkillWarningFilter((text, metadata) => {
            output += text;
            onEvent({ type: "text-delta", text, ...metadata });
        });
        let markReady;
        let failReady;
        const ready = new Promise((resolve, reject) => {
            markReady = resolve;
            failReady = reject;
        });
        const app = acp
            .client({ name: "anytype-agent-gateway" })
            .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
            if (this.config.permissions === "deny")
                return { outcome: { outcome: "cancelled" } };
            const option = ctx.params.options.find((item) => item.kind === "allow_once") ??
                ctx.params.options.find((item) => item.kind.startsWith("allow"));
            return option
                ? { outcome: { outcome: "selected", optionId: option.optionId } }
                : { outcome: { outcome: "cancelled" } };
        })
            .onNotification(acp.methods.client.session.update, (ctx) => {
            if (replayingHistory)
                return;
            const update = ctx.params.update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
                const metadata = {
                    ...(typeof update.messageId === "string" ? { partId: update.messageId } : {}),
                    ...(typeof update._meta?.codex?.phase === "string"
                        ? { phase: update._meta.codex.phase }
                        : {}),
                    ...(update._meta?.codex?.replace === true ? { replace: true } : {}),
                };
                if (typeof update.messageId === "string") {
                    messageTexts.set(update.messageId, metadata.replace
                        ? update.content.text
                        : `${messageTexts.get(update.messageId) ?? ""}${update.content.text}`);
                    latestMessageId = update.messageId;
                    if (update._meta?.codex?.phase === "final_answer")
                        finalMessageId = update.messageId;
                }
                filteredText.push(update.content.text, metadata);
            }
            else if (update.sessionUpdate === "agent_thought_chunk" &&
                update.content?.type === "text") {
                onEvent({
                    type: "thinking-delta",
                    text: update.content.text,
                    ...(typeof update.messageId === "string" ? { partId: update.messageId } : {}),
                    ...(typeof update._meta?.codex?.phase === "string"
                        ? { phase: update._meta.codex.phase }
                        : {}),
                    ...(update._meta?.codex?.replace === true ? { replace: true } : {}),
                });
            }
            else if (update.sessionUpdate === "tool_call" ||
                update.sessionUpdate === "tool_call_update") {
                onEvent({
                    type: "tool",
                    name: codexToolActivitySummary(update.title, update.toolCallId),
                    status: update.status ?? "running",
                });
            }
        });
        const result = app
            .connectWith(stream, async (ctx) => {
            context = ctx;
            try {
                const initialized = await ctx.request(acp.methods.agent.initialize, {
                    protocolVersion: acp.PROTOCOL_VERSION,
                    clientCapabilities: {},
                });
                const additionalDirectories = [
                    ...this.config.allowedProjects,
                    ...(this.config.defaultProject && this.config.defaultProject !== workspacePath
                        ? [this.config.defaultProject]
                        : []),
                ];
                const sessionSetup = {
                    cwd: workspacePath ?? process.cwd(),
                    mcpServers: this.mcpServer
                        ? [
                            {
                                name: "aag-anytype",
                                command: this.mcpServer.command,
                                args: this.mcpServer.args,
                                env: mcpEnvironment(this.mcpServer.env, input.turn, actorFile),
                            },
                        ]
                        : [],
                    ...(additionalDirectories.length ? { additionalDirectories } : {}),
                };
                let savedSessionId = this.store?.codexAcpSession(input.sessionKey);
                let sessionResponse;
                if (!savedSessionId &&
                    this.config.desktopProject === "auto" &&
                    workspacePath &&
                    initialized.agentCapabilities?.loadSession) {
                    const nativeSessionId = await createCodexDesktopThread({
                        workspace: workspacePath,
                        title: `${this.agentName ?? "Agent"} — Anytype ${input.turn?.conversation.kind === "discussion" ? "discussion" : "chat"}`,
                        ...(this.config.environment.CODEX_HOME
                            ? { codexHome: this.config.environment.CODEX_HOME }
                            : process.env.CODEX_HOME
                                ? { codexHome: process.env.CODEX_HOME }
                                : {}),
                    });
                    if (nativeSessionId) {
                        savedSessionId = nativeSessionId;
                        this.store?.saveCodexAcpSession(input.sessionKey, nativeSessionId);
                    }
                }
                if (savedSessionId && initialized.agentCapabilities?.loadSession) {
                    replayingHistory = true;
                    try {
                        try {
                            sessionResponse = await ctx.request(acp.methods.agent.session.load, {
                                ...sessionSetup,
                                sessionId: savedSessionId,
                            });
                        }
                        catch (error) {
                            if (!savedSessionInternallyBroken(error))
                                throw error;
                            await new Promise((resolve) => setTimeout(resolve, 250));
                            sessionResponse = await ctx.request(acp.methods.agent.session.load, {
                                ...sessionSetup,
                                sessionId: savedSessionId,
                            });
                        }
                        sessionId = savedSessionId;
                        this.repeatedInternalLoadFailures.delete(input.sessionKey);
                    }
                    catch (error) {
                        if (savedSessionInternallyBroken(error)) {
                            const failures = (this.repeatedInternalLoadFailures.get(input.sessionKey) ?? 0) + 1;
                            this.repeatedInternalLoadFailures.set(input.sessionKey, failures);
                            if (failures < 2)
                                throw error;
                            this.store?.deleteCodexAcpSession(input.sessionKey);
                        }
                        else if (savedSessionUnavailable(error)) {
                            this.store?.deleteCodexAcpSession(input.sessionKey);
                        }
                        else {
                            throw error;
                        }
                    }
                    finally {
                        replayingHistory = false;
                    }
                }
                if (!sessionId) {
                    const session = (await ctx.request(acp.methods.agent.session.new, sessionSetup));
                    sessionId = session.sessionId;
                    sessionResponse = session;
                    this.repeatedInternalLoadFailures.delete(input.sessionKey);
                }
                this.store?.saveCodexAcpSession(input.sessionKey, sessionId);
                await this.associateDesktopProject(sessionId, input.turn);
                let model = findModelConfig(sessionResponse?.configOptions ?? []);
                if (model) {
                    const defaultModelId = input.defaultModelId ?? model.defaultValue ?? model.currentValue;
                    modelState = {
                        options: model.options,
                        currentModelId: model.currentValue,
                        ...(defaultModelId ? { defaultModelId } : {}),
                        sessionId,
                    };
                }
                if (input.modelId !== undefined) {
                    if (!model)
                        throw new Error("The Codex harness does not expose model selection over ACP");
                    const defaultModelId = input.defaultModelId ?? model.defaultValue ?? model.currentValue;
                    const desired = input.modelId === null ? defaultModelId : input.modelId;
                    if (!desired)
                        throw new Error("The Codex harness did not expose a default model for this session");
                    const resolved = resolveRuntimeModel(model.options, desired);
                    const updated = await ctx.request(acp.methods.agent.session.setConfigOption, {
                        sessionId,
                        configId: model.id,
                        value: resolved.id,
                    });
                    model = findModelConfig(updated.configOptions);
                    modelState = {
                        options: model?.options ?? [],
                        currentModelId: model?.currentValue ?? resolved.id,
                        defaultModelId,
                        sessionId,
                    };
                }
                markReady();
                try {
                    await ctx.request(acp.methods.agent.session.prompt, {
                        sessionId,
                        prompt: [{ type: "text", text: input.prompt }],
                    });
                }
                finally {
                    acceptingSteers = false;
                    filteredText.finish();
                }
                await this.associateDesktopProject(sessionId, input.turn);
                await this.hydrateDesktopProject(sessionId);
                this.retryDesktopProjectAssociation(sessionId, input.turn);
                const terminalText = messageTexts.get(finalMessageId ?? latestMessageId ?? "") ?? output;
                return parseSilence(stripLeadingSkillWarning(terminalText));
            }
            catch (error) {
                failReady(error);
                throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr.trim() ? `; codex-acp stderr: ${stderr.trim()}` : ""}`);
            }
        })
            .finally(async () => {
            terminateNow();
            if (actorFile)
                await unlink(actorFile).catch(() => undefined);
        });
        void result.catch(() => undefined);
        const setupSeconds = this.config.setupTimeoutSeconds ??
            (this.config.timeoutSeconds > 0 ? Math.min(this.config.timeoutSeconds, 30) : 30);
        await waitForSetup(Promise.race([ready, childFailure]), setupSeconds * 1000, terminateNow);
        return {
            sessionKey: input.sessionKey,
            ...(sessionId ? { sessionId } : {}),
            ...(modelState ? { modelState } : {}),
            result,
            steer: async (message, turn) => {
                if (!context || !sessionId)
                    throw new Error("Codex ACP session is not ready");
                if (!acceptingSteers)
                    throw new RuntimeTurnAlreadyCompletedError();
                if (actorFile && turn) {
                    const nextActorId = turn.message.creator;
                    actorId = actorId && nextActorId && actorId === nextActorId ? actorId : undefined;
                    await writeActorFile(actorFile, actorId);
                }
                await context.request("_session/steering", {
                    sessionId,
                    prompt: [{ type: "text", text: message }],
                });
            },
            cancel: async () => {
                try {
                    if (context && sessionId)
                        await context.notify(acp.methods.agent.session.cancel, { sessionId });
                }
                finally {
                    terminateAfterGrace();
                }
            },
        };
    }
    async associateDesktopProject(sessionId, turn) {
        const workspacePath = turn?.workspacePath ?? this.config.defaultProject;
        if (this.config.desktopProject !== "auto" || !workspacePath)
            return;
        await associateCodexDesktopThread({
            threadId: sessionId,
            workspace: workspacePath,
            ...(this.agentName
                ? {
                    title: `${this.agentName} — Anytype ${turn?.conversation.kind === "discussion" ? "discussion" : "chat"}`,
                }
                : {}),
            ...(this.config.environment.CODEX_HOME
                ? { codexHome: this.config.environment.CODEX_HOME }
                : process.env.CODEX_HOME
                    ? { codexHome: process.env.CODEX_HOME }
                    : {}),
        }).catch(() => undefined);
    }
    async hydrateDesktopProject(sessionId) {
        if (this.config.desktopProject !== "auto" || this.hydratedDesktopSessions.has(sessionId))
            return;
        this.hydratedDesktopSessions.add(sessionId);
        await hydrateCodexDesktopTask({
            threadId: sessionId,
            ...(this.config.environment.CODEX_HOME
                ? { codexHome: this.config.environment.CODEX_HOME }
                : process.env.CODEX_HOME
                    ? { codexHome: process.env.CODEX_HOME }
                    : {}),
        }).catch(() => undefined);
    }
    retryDesktopProjectAssociation(sessionId, turn) {
        if (this.config.desktopProject !== "auto" ||
            !(turn?.workspacePath ?? this.config.defaultProject))
            return;
        for (const delayMs of [1_000, 5_000, 30_000, 60_000]) {
            const timer = setTimeout(() => void this.associateDesktopProject(sessionId, turn), delayMs);
            timer.unref?.();
        }
    }
}
export function codexToolActivitySummary(title, toolCallId) {
    const candidate = typeof title === "string" ? title.trim() : "";
    const identifier = typeof toolCallId === "string" ? toolCallId.trim() : "";
    const source = `${candidate} ${identifier}`.toLocaleLowerCase();
    if (source.includes("anytypesearch") || source.includes("anytype search"))
        return "Searching Anytype";
    if (source.includes("anytypecreate") || source.includes("anytype create"))
        return "Creating in Anytype";
    if (source.includes("anytypeupdate") || source.includes("anytype update"))
        return "Updating Anytype";
    if (source.includes("anytypeget") || source.includes("anytype get"))
        return "Reading from Anytype";
    if (source.includes("guardian"))
        return "Reviewing changes";
    if (looksLikeShellActivity(candidate) || /(?:^|[.:-])exec(?:$|[.:-])/.test(source))
        return "Running a command";
    if (/(?:read|inspect|open|view).*(?:file|directory)|(?:file|directory).*(?:read|inspect)/.test(source))
        return "Reading files";
    if (/(?:write|edit|patch|create).*(?:file|directory)|(?:file|directory).*(?:write|edit)/.test(source))
        return "Editing files";
    if (isHumanActivityTitle(candidate))
        return candidate;
    return "Using a tool";
}
function looksLikeShellActivity(value) {
    return (/(?:^|\s)(?:curl|jq|cat|sed|rg|grep|find|ls|pwd|node|python\d*|pnpm|npm|git|gh|ssh|scp|rsync)(?:\s|$)/i.test(value) ||
        /(?:&&|\|\||\$\(|`|\s--[\w-]+)/.test(value) ||
        /(?:^|\s)(?:\.?\.?\/|~\/|\/Users\/|\/home\/|\/tmp\/)/.test(value));
}
function isHumanActivityTitle(value) {
    if (!value || value.length > 100 || /[\r\n]/.test(value))
        return false;
    if (/\b[0-9a-f]{8}-[0-9a-f-]{20,}\b/i.test(value))
        return false;
    if (/\b(?:exec|tool|call|assessment)[-_:][\w-]{8,}\b/i.test(value))
        return false;
    if (/^(?:mcp|function|tool)[.:_-]/i.test(value))
        return false;
    return true;
}
function savedSessionUnavailable(error) {
    const details = error instanceof acp.RequestError
        ? `${error.message} ${stringifyErrorData(error.data)}`
        : error instanceof Error
            ? error.message
            : String(error);
    return (/\b(?:session|thread)\b[^\n]*(?:not found|does not exist|unknown|stale|invalid (?:id|identifier))/i.test(details) ||
        /(?:not found|does not exist|unknown|stale|invalid (?:id|identifier))[^\n]*\b(?:session|thread)\b/i.test(details));
}
function savedSessionInternallyBroken(error) {
    return error instanceof acp.RequestError && error.code === -32603;
}
async function waitForSetup(ready, timeoutMs, terminate) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`Codex ACP setup timed out after ${Math.round(timeoutMs / 1000)} seconds`));
            terminate();
        }, timeoutMs);
    });
    try {
        await Promise.race([ready, timeout]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function stringifyErrorData(data) {
    try {
        return JSON.stringify(data);
    }
    catch {
        return String(data);
    }
}
function mcpEnvironment(configured, turn, actorFile) {
    const environment = {};
    for (const [name, value] of Object.entries(configured ?? {})) {
        if (/(?:api[_-]?key|anytype[^\n]*key)/i.test(name))
            continue;
        environment[name] = value;
    }
    if (turn) {
        environment.AAG_ROUTE_ID = turn.conversation.routeId;
        environment.KNOT_ROUTE_ID = turn.conversation.routeId;
        environment.AAG_SPACE_ID = turn.conversation.spaceId;
        environment.KNOT_SPACE_ID = turn.conversation.spaceId;
        if (actorFile) {
            environment.AAG_ACTOR_FILE = actorFile;
            environment.KNOT_ACTOR_FILE = actorFile;
        }
        if (turn.conversation.discussionRootId) {
            environment.AAG_DISCUSSION_ROOT_ID = turn.conversation.discussionRootId;
            environment.KNOT_DISCUSSION_ROOT_ID = turn.conversation.discussionRootId;
        }
    }
    return Object.entries(environment).map(([name, value]) => ({ name, value }));
}
async function writeActorContext(actorDirectory, sessionKey, actorId) {
    const name = `${createHash("sha256").update(sessionKey).digest("hex").slice(0, 20)}.json`;
    const path = join(actorDirectory, name);
    await writeActorFile(path, actorId);
    return path;
}
async function writeActorFile(path, actorId) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify({ actorId: actorId ?? "", participantId: actorId ?? "", provenance: actorId ? "anytype-native" : "unavailable" })}\n`, { mode: 0o600 });
    await rename(temporary, path);
}
function findModelConfig(configOptions) {
    const candidate = configOptions.find((option) => {
        const value = option;
        return value.type === "select" && (value.category === "model" || value.id === "model");
    });
    if (!candidate || typeof candidate.id !== "string" || typeof candidate.currentValue !== "string")
        return undefined;
    const raw = Array.isArray(candidate.options) ? candidate.options : [];
    const values = raw.flatMap((entry) => {
        const value = entry;
        if (Array.isArray(value.options))
            return value.options;
        return [entry];
    });
    const options = values.flatMap((entry) => {
        const value = entry;
        if (typeof value.value !== "string")
            return [];
        return [
            {
                id: value.value,
                name: typeof value.name === "string" ? value.name : value.value,
                ...(typeof value.description === "string" ? { description: value.description } : {}),
            },
        ];
    });
    return {
        id: candidate.id,
        currentValue: candidate.currentValue,
        ...(typeof candidate.defaultValue === "string" ? { defaultValue: candidate.defaultValue } : {}),
        options,
    };
}
function resolveRuntimeModel(options, requested) {
    const exact = options.find((option) => option.id === requested);
    if (exact)
        return exact;
    const folded = requested.toLocaleLowerCase();
    const matches = options.filter((option) => option.id.toLocaleLowerCase() === folded || option.name.toLocaleLowerCase() === folded);
    if (matches.length === 1)
        return matches[0];
    if (matches.length > 1)
        throw new Error(`Model name is ambiguous: ${requested}`);
    throw new Error(`Unknown model: ${requested}`);
}
function stripLeadingSkillWarning(text) {
    const warning = LEADING_SKILL_WARNING.exec(text);
    return warning ? text.slice(warning[0].length).replace(/^\s+/, "") : text;
}
function inheritedAgentEnvironment(configured) {
    const allowed = [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "TERM",
        "COLORTERM",
        "NO_COLOR",
        "CODEX_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ];
    const environment = {};
    for (const key of allowed)
        if (process.env[key] !== undefined)
            environment[key] = process.env[key];
    return { ...environment, ...configured };
}
class LeadingSkillWarningFilter {
    emit;
    pending = "";
    decided = false;
    metadata = {};
    constructor(emit) {
        this.emit = emit;
    }
    push(text, metadata) {
        if (this.decided) {
            this.emit(text, metadata);
            return;
        }
        this.metadata = metadata;
        this.pending += text;
        const warning = LEADING_SKILL_WARNING.exec(this.pending);
        if (warning) {
            const remainder = this.pending.slice(warning[0].length);
            if (/\S/.test(remainder))
                this.flush(remainder.replace(/^\s+/, ""));
            return;
        }
        const candidate = this.pending.trimStart();
        if (!SKILL_WARNING_PREFIXES.some((prefix) => prefix.startsWith(candidate) || candidate.startsWith(prefix)))
            this.flush(this.pending);
    }
    finish() {
        if (this.decided)
            return;
        const warning = LEADING_SKILL_WARNING.exec(this.pending);
        this.flush(warning ? this.pending.slice(warning[0].length).replace(/^\s+/, "") : this.pending);
    }
    flush(text) {
        this.decided = true;
        this.pending = "";
        if (text)
            this.emit(text, this.metadata);
    }
}

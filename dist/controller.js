import { createHash } from "node:crypto";
import { buildContext, formatPrompt, isNewSessionCommand } from "./context.js";
import { RunProjection } from "./projection.js";
import { decideWake } from "./wake.js";
export class AgentController {
    anytype;
    runtime;
    config;
    store;
    log;
    discussionAnytype;
    managementCommand;
    active = new Map();
    processing = new Set();
    constructor(anytype, runtime, config, store, log, discussionAnytype = anytype, managementCommand) {
        this.anytype = anytype;
        this.runtime = runtime;
        this.config = config;
        this.store = store;
        this.log = log;
        this.discussionAnytype = discussionAnytype;
        this.managementCommand = managementCommand;
    }
    async process(conversation, wake, message) {
        const version = message.modified_at ?? message.created_at;
        const fingerprint = messageFingerprint(message);
        if (!message.id || this.store.isHandled(conversation.routeId, message.id, version, fingerprint))
            return;
        const claim = `${conversation.routeId}:${message.id}`;
        if (this.processing.has(claim))
            return;
        this.processing.add(claim);
        try {
            await this.processClaimed(conversation, wake, message);
            this.store.markHandled(conversation.routeId, message.id, version, fingerprint);
        }
        finally {
            this.processing.delete(claim);
        }
    }
    async processClaimed(conversation, wake, message) {
        if (this.store.isResponse(message.id))
            return;
        const humans = this.store.wakeOverride(conversation.routeId);
        const effectiveWake = humans ? { ...wake, humans: humans } : wake;
        const replyToAgent = Boolean(message.reply_to_message_id && this.store.isResponse(message.reply_to_message_id));
        const decision = decideWake(message, effectiveWake, this.config, { replyToAgent, ...(conversation.selfParticipantId ? { selfParticipantId: conversation.selfParticipantId } : {}) });
        if (!decision.wake) {
            this.log("message_ignored", { routeId: conversation.routeId, messageId: message.id, reason: decision.reason });
            return;
        }
        const thread = await this.thread(conversation, message);
        const threadKey = thread.key;
        const replyTargetId = conversation.kind === "discussion" ? thread.rootId : message.id;
        const newSession = isNewSessionCommand(message.content?.text ?? "");
        const hop = decision.isAgent ? await this.agentHop(conversation, message) : 0;
        if (hop > this.config.coordination.maxHops) {
            this.log("hop_limit", { routeId: conversation.routeId, hop });
            return;
        }
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
                await active.handle.steer(this.steerPrompt(message));
                this.log("run_steered", { routeId: conversation.routeId, messageId: message.id, runId: active.id });
            }
            catch (error) {
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
        if (recent >= this.config.coordination.maxActivationsPerThread) {
            this.log("activation_circuit_open", { routeId: conversation.routeId, recent });
            return;
        }
        const generation = newSession ? this.store.resetSession(threadKey) : this.store.sessionGeneration(threadKey);
        await this.start(conversation, message, threadKey, replyTargetId, hop, newSession);
        if (newSession)
            this.log("session_reset", { routeId: conversation.routeId, messageId: message.id, generation });
    }
    async stop() {
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
    async start(conversation, message, threadKey, replyTargetId, hop, newSession = false) {
        const anytype = this.port(conversation);
        const runId = crypto.randomUUID();
        const recentMessages = await anytype.listMessages(conversation.spaceId, conversation.chatId, 100);
        const orphan = replyTargetId === message.id ? recentMessages.find(candidate => candidate.reply_to_message_id === message.id && candidate.creator === (conversation.selfParticipantId ?? this.config.agent.participantId)) : undefined;
        const context = await buildContext(anytype, this.config, conversation, message, { newSession });
        const projection = orphan
            ? await RunProjection.resume(anytype, this.config, conversation, orphan.id, message.id, orphan.content?.text, context.mentionTargets ?? [])
            : await RunProjection.create(anytype, this.config, conversation, message.id, replyTargetId, context.mentionTargets ?? []);
        this.store.createRun({ id: runId, routeId: conversation.routeId, threadKey, triggerId: message.id, responseId: projection.messageId, hop });
        try {
            const generation = this.store.sessionGeneration(threadKey);
            const sessionKey = generation === 0 ? `aag:${threadKey}` : `aag:${threadKey}:g${generation}`;
            const handle = await this.runtime.start({ sessionKey, prompt: formatPrompt(context, this.config, this.managementCommand?.(conversation.routeId)) }, event => projection.onEvent(event));
            const active = { id: runId, handle, projection, conversation, threadKey, completion: Promise.resolve(), cancelled: false };
            this.active.set(threadKey, active);
            this.log("run_started", { routeId: conversation.routeId, runId, messageId: message.id });
            const result = withTimeout(handle, this.config.runtime.timeoutSeconds * 1000);
            active.completion = result.then(async (value) => {
                if (active.cancelled)
                    return;
                if (this.active.get(threadKey)?.id === runId)
                    this.active.delete(threadKey);
                const status = await projection.finish(value);
                this.store.finishRun(runId, status);
                this.log("run_finished", { routeId: conversation.routeId, runId, status });
            }).catch(async (error) => {
                if (active.cancelled)
                    return;
                await projection.fail(error).catch(() => undefined);
                this.store.finishRun(runId, "failed");
                this.log("run_failed", { routeId: conversation.routeId, runId, error: error instanceof Error ? error.message : String(error) });
            }).finally(() => { if (this.active.get(threadKey)?.id === runId)
                this.active.delete(threadKey); });
        }
        catch (error) {
            await projection.fail(error).catch(() => undefined);
            this.store.finishRun(runId, "failed");
            this.log("run_start_failed", { routeId: conversation.routeId, error: error instanceof Error ? error.message : String(error) });
        }
    }
    async replaceActiveSession(active) {
        active.cancelled = true;
        this.active.delete(active.threadKey);
        await active.handle.cancel().catch(() => undefined);
        await active.projection.interrupt("Agent session replaced by /new.").catch(() => undefined);
        this.store.finishRun(active.id, "cancelled");
    }
    steerPrompt(message) { return `A follow-up arrived from ${message.creator_name ?? message.creator ?? "unknown"}. Incorporate it into the active run and continue:\n\n${message.content?.text ?? ""}`; }
    async thread(conversation, message) {
        if (conversation.kind === "chat")
            return { key: conversation.routeId, rootId: message.id };
        let rootId = message.id;
        let parentId = message.reply_to_message_id;
        for (let depth = 0; parentId && depth < this.config.context.replyDepth; depth += 1) {
            rootId = parentId;
            try {
                const parent = await this.port(conversation).getMessage(conversation.spaceId, conversation.chatId, parentId);
                parentId = parent.reply_to_message_id;
            }
            catch {
                break;
            }
        }
        return { key: `${conversation.routeId}:root:${rootId}`, rootId };
    }
    async agentHop(conversation, message) {
        let hop = 1;
        let parentId = message.reply_to_message_id;
        for (; parentId && hop <= this.config.coordination.maxHops + 1;) {
            try {
                const parent = await this.port(conversation).getMessage(conversation.spaceId, conversation.chatId, parentId);
                if (!parent.creator || !(this.config.coordination.agentParticipants.includes(parent.creator) || this.config.coordination.peers.some(peer => peer.participantId === parent?.creator)))
                    break;
                hop += 1;
                parentId = parent.reply_to_message_id;
            }
            catch {
                break;
            }
        }
        return hop;
    }
    port(conversation) { return conversation.kind === "discussion" ? this.discussionAnytype : this.anytype; }
}
export function messageFingerprint(message) {
    return createHash("sha256").update(JSON.stringify({
        creator: message.creator ?? null,
        replyTo: message.reply_to_message_id ?? null,
        text: message.content?.text ?? "",
        style: message.content?.style ?? null,
        marks: message.content?.marks ?? []
    })).digest("hex");
}
function withTimeout(handle, timeoutMs) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            void handle.cancel().catch(() => undefined);
            reject(new Error(`Agent run timed out after ${Math.round(timeoutMs / 1000)} seconds`));
        }, timeoutMs);
    });
    return Promise.race([handle.result, timeout]).finally(() => { if (timer)
        clearTimeout(timer); });
}
function mentionTargetsFrom(message) {
    const targets = [];
    if (message.creator && message.creator_name)
        targets.push({ name: message.creator_name, participantId: message.creator });
    const text = message.content?.text ?? "";
    for (const mark of message.content?.marks ?? []) {
        if (mark.type !== "mention" || !mark.param || mark.from === undefined || mark.to === undefined)
            continue;
        const name = text.slice(mark.from, mark.to).replace(/^@/, "").trim();
        if (name)
            targets.push({ name, participantId: mark.param });
    }
    return targets;
}

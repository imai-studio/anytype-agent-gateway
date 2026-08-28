export class RunProjection {
    anytype;
    config;
    conversation;
    responseId;
    reactionTargetId;
    text = "";
    timer;
    closed = false;
    writes = Promise.resolve();
    constructor(anytype, config, conversation, responseId, reactionTargetId) {
        this.anytype = anytype;
        this.config = config;
        this.conversation = conversation;
        this.responseId = responseId;
        this.reactionTargetId = reactionTargetId;
    }
    static async create(anytype, config, conversation, triggerId) {
        await anytype.ensureReaction(conversation.spaceId, conversation.chatId, triggerId, config.responses.workingReaction, true);
        try {
            const responseId = await anytype.sendMessage(conversation.spaceId, conversation.chatId, { text: config.responses.workingText, replyTo: triggerId });
            return new RunProjection(anytype, config, conversation, responseId, triggerId);
        }
        catch (error) {
            await anytype.ensureReaction(conversation.spaceId, conversation.chatId, triggerId, config.responses.workingReaction, false).catch(() => undefined);
            throw error;
        }
    }
    static async resume(anytype, config, conversation, responseId, triggerId, text = "") {
        const projection = new RunProjection(anytype, config, conversation, responseId, triggerId);
        projection.text = text === config.responses.workingText ? "" : text;
        await anytype.ensureReaction(conversation.spaceId, conversation.chatId, triggerId, config.responses.workingReaction, true);
        return projection;
    }
    get messageId() { return this.responseId; }
    async move(triggerId) {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        return this.enqueue(async () => {
            const previousId = this.responseId;
            await this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, previousId, this.currentDisplay());
            await this.anytype.ensureReaction(this.conversation.spaceId, this.conversation.chatId, this.reactionTargetId, this.config.responses.workingReaction, false);
            this.responseId = await this.anytype.sendMessage(this.conversation.spaceId, this.conversation.chatId, { text: this.currentDisplay(), replyTo: triggerId });
            this.reactionTargetId = triggerId;
            await this.anytype.ensureReaction(this.conversation.spaceId, this.conversation.chatId, this.reactionTargetId, this.config.responses.workingReaction, true);
            return this.responseId;
        });
    }
    onEvent(event) {
        if (this.closed)
            return;
        if (event.type === "text-delta") {
            this.text += event.text;
            if (this.config.responses.streaming)
                this.schedule();
        }
        else if (event.type === "tool" && this.config.responses.mode !== "single") {
            this.text = `${this.text.trimEnd()}\n\n${event.status === "completed" ? "✓" : "↻"} ${event.name}`.trim();
            this.schedule();
        }
        else if (event.type === "status" && this.config.responses.mode === "verbose" && event.text) {
            this.text = `${this.text.trimEnd()}\n\n${event.text}`.trim();
            this.schedule();
        }
    }
    async finish(result) {
        this.closed = true;
        if (this.timer)
            clearTimeout(this.timer);
        return this.enqueue(async () => {
            await this.anytype.ensureReaction(this.conversation.spaceId, this.conversation.chatId, this.reactionTargetId, this.config.responses.workingReaction, false);
            if (result.silent) {
                if (this.config.responses.silentPlaceholder === "delete")
                    await this.anytype.deleteMessage(this.conversation.spaceId, this.conversation.chatId, this.responseId);
                else if (this.config.responses.silentPlaceholder === "replace")
                    await this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, this.responseId, this.config.responses.silentText);
                return "silent";
            }
            const rendered = renderCoordination(result.text || this.text || "Completed without a text response.", this.config);
            const finalText = truncateResponse(rendered.text, this.config.responses.maxCharacters);
            const marks = rendered.marks.filter(mark => (mark.to ?? 0) <= finalText.length);
            await this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, this.responseId, finalText, marks);
            return "done";
        });
    }
    async fail(error) {
        this.closed = true;
        if (this.timer)
            clearTimeout(this.timer);
        await this.enqueue(async () => {
            await this.anytype.ensureReaction(this.conversation.spaceId, this.conversation.chatId, this.reactionTargetId, this.config.responses.workingReaction, false).catch(() => undefined);
            const message = error instanceof Error ? error.message : String(error);
            await this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, this.responseId, `Agent run failed: ${message.slice(0, 1000)}`);
        });
    }
    async interrupt(message = "Agent run interrupted before completion.") {
        this.closed = true;
        if (this.timer)
            clearTimeout(this.timer);
        await this.enqueue(async () => {
            await this.anytype.ensureReaction(this.conversation.spaceId, this.conversation.chatId, this.reactionTargetId, this.config.responses.workingReaction, false).catch(() => undefined);
            await this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, this.responseId, message);
        });
    }
    schedule() {
        if (this.timer)
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flush().catch(() => undefined);
        }, 900);
    }
    currentDisplay() { return (this.text || this.config.responses.workingText).slice(0, this.config.responses.maxCharacters); }
    async flush() {
        if (this.closed)
            return;
        const responseId = this.responseId;
        await this.enqueue(() => this.closed ? Promise.resolve() : this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, responseId, this.currentDisplay()));
    }
    enqueue(write) {
        const next = this.writes.then(write, write);
        this.writes = next.catch(() => undefined);
        return next;
    }
}
function truncateResponse(text, maxCharacters) {
    if (text.length <= maxCharacters)
        return text;
    const notice = "\n\n[Response truncated by AAG]";
    let prefix = text.slice(0, Math.max(0, maxCharacters - notice.length));
    if (prefix && /[\uD800-\uDBFF]/.test(prefix.at(-1)))
        prefix = prefix.slice(0, -1);
    return `${prefix}${notice}`;
}
export function renderCoordination(text, config) {
    const peers = new Map();
    for (const peer of config.coordination.peers)
        for (const name of [peer.name, ...peer.aliases])
            peers.set(name.toLocaleLowerCase(), peer);
    const marks = [];
    const tagged = new Set();
    const matcher = /\[\[AAG_MENTION:([^\]\n]+)\]\]/gi;
    let rendered = "";
    let cursor = 0;
    for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
        rendered += text.slice(cursor, match.index);
        cursor = match.index + match[0].length;
        const peer = peers.get((match[1] ?? "").trim().replace(/^@/, "").toLocaleLowerCase());
        if (!peer || (!tagged.has(peer.participantId) && tagged.size >= config.coordination.maxFanout)) {
            rendered += match[0];
            continue;
        }
        const mention = `@${peer.name}`;
        if (!tagged.has(peer.participantId)) {
            marks.push({ type: "mention", from: rendered.length, to: rendered.length + mention.length, param: peer.participantId });
            tagged.add(peer.participantId);
        }
        rendered += mention;
    }
    rendered += text.slice(cursor);
    return { text: rendered, marks };
}

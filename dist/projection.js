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
    mentionTargets = new Map();
    constructor(anytype, config, conversation, responseId, reactionTargetId, mentionTargets = []) {
        this.anytype = anytype;
        this.config = config;
        this.conversation = conversation;
        this.responseId = responseId;
        this.reactionTargetId = reactionTargetId;
        this.addMentionTargets(mentionTargets);
    }
    static async create(anytype, config, conversation, triggerId, replyTargetId = triggerId, mentionTargets = []) {
        await anytype.ensureReaction(conversation.spaceId, conversation.chatId, triggerId, config.responses.workingReaction, true);
        try {
            const responseId = await anytype.sendMessage(conversation.spaceId, conversation.chatId, { text: config.responses.workingText, replyTo: replyTargetId });
            return new RunProjection(anytype, config, conversation, responseId, triggerId, mentionTargets);
        }
        catch (error) {
            await anytype.ensureReaction(conversation.spaceId, conversation.chatId, triggerId, config.responses.workingReaction, false).catch(() => undefined);
            throw error;
        }
    }
    static async resume(anytype, config, conversation, responseId, triggerId, text = "", mentionTargets = []) {
        const projection = new RunProjection(anytype, config, conversation, responseId, triggerId, mentionTargets);
        projection.text = text === config.responses.workingText ? "" : text;
        await anytype.ensureReaction(conversation.spaceId, conversation.chatId, triggerId, config.responses.workingReaction, true);
        return projection;
    }
    get messageId() { return this.responseId; }
    addMentionTargets(targets) {
        for (const target of targets)
            this.mentionTargets.set(target.participantId, target);
    }
    async move(triggerId, replyTargetId = triggerId) {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        return this.enqueue(async () => {
            const previousId = this.responseId;
            const current = this.currentDisplay();
            await this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, previousId, current.text, current.marks);
            await this.anytype.ensureReaction(this.conversation.spaceId, this.conversation.chatId, this.reactionTargetId, this.config.responses.workingReaction, false);
            this.responseId = await this.anytype.sendMessage(this.conversation.spaceId, this.conversation.chatId, { text: current.text, marks: current.marks, replyTo: replyTargetId });
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
            const rendered = renderForAnytype(result.text || this.text || "Completed without a text response.", this.config, [...this.mentionTargets.values()]);
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
    currentDisplay() {
        const rendered = renderForAnytype(this.text || this.config.responses.workingText, this.config, [...this.mentionTargets.values()]);
        const text = truncateResponse(rendered.text, this.config.responses.maxCharacters);
        return { text, marks: rendered.marks.filter(mark => (mark.to ?? 0) <= text.length) };
    }
    async flush() {
        if (this.closed)
            return;
        const responseId = this.responseId;
        const current = this.currentDisplay();
        await this.enqueue(() => this.closed ? Promise.resolve() : this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, responseId, current.text, current.marks));
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
export function renderCoordination(text, config, dynamicTargets = []) {
    const peers = new Map();
    for (const peer of config.coordination.peers)
        for (const name of [peer.name, ...peer.aliases])
            peers.set(name.toLocaleLowerCase(), peer);
    for (const target of dynamicTargets)
        peers.set(target.name.toLocaleLowerCase(), { name: target.name, participantId: target.participantId, aliases: [] });
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
    const occupied = marks.map(mark => [mark.from ?? 0, mark.to ?? 0]);
    const uniqueTargets = new Map([...peers.values()].map(target => [target.participantId, target]));
    for (const target of uniqueTargets.values()) {
        const matcher = new RegExp(`@${escapeRegExp(target.name)}(?![\\p{L}\\p{N}_])`, "giu");
        for (let match = matcher.exec(rendered); match; match = matcher.exec(rendered)) {
            const from = match.index;
            const to = from + match[0].length;
            if (occupied.some(([occupiedFrom, occupiedTo]) => from < occupiedTo && to > occupiedFrom))
                continue;
            if (!tagged.has(target.participantId) && tagged.size >= config.coordination.maxFanout)
                continue;
            marks.push({ type: "mention", from, to, param: target.participantId });
            tagged.add(target.participantId);
            occupied.push([from, to]);
        }
    }
    return { text: rendered, marks };
}
export function renderForAnytype(text, config, dynamicTargets = []) {
    const coordinated = renderCoordination(text, config, dynamicTargets);
    return normalizeMarkdown(coordinated.text, coordinated.marks);
}
function normalizeMarkdown(text, existingMarks) {
    let output = "";
    const marks = [];
    const boundaries = new Array(text.length + 1).fill(0);
    let index = 0;
    while (index < text.length) {
        boundaries[index] = output.length;
        const lineStart = index === 0 || text[index - 1] === "\n";
        if (lineStart) {
            const heading = /^(#{1,6})\s+/.exec(text.slice(index));
            if (heading) {
                for (let offset = 0; offset < heading[0].length; offset += 1)
                    boundaries[index + offset] = output.length;
                index += heading[0].length;
                continue;
            }
            if ((text.startsWith("- ", index) || text.startsWith("* ", index)) && !text.startsWith("**", index)) {
                boundaries[index] = output.length;
                boundaries[index + 1] = output.length + 1;
                output += "• ";
                index += 2;
                continue;
            }
        }
        const formats = [
            { open: "**", close: "**", type: "bold" }, { open: "__", close: "__", type: "bold" },
            { open: "~~", close: "~~", type: "strikethrough" }, { open: "`", close: "`", type: "keyboard" },
            { open: "*", close: "*", type: "italic" }, { open: "_", close: "_", type: "italic" }
        ];
        const format = formats.find(candidate => text.startsWith(candidate.open, index) && text.indexOf(candidate.close, index + candidate.open.length) > index + candidate.open.length);
        if (format) {
            const closeAt = text.indexOf(format.close, index + format.open.length);
            for (let offset = 0; offset < format.open.length; offset += 1)
                boundaries[index + offset] = output.length;
            const from = output.length;
            const content = text.slice(index + format.open.length, closeAt);
            output += content;
            for (let offset = 0; offset <= content.length; offset += 1)
                boundaries[index + format.open.length + offset] = from + offset;
            marks.push({ type: format.type, from, to: output.length });
            for (let offset = 0; offset < format.close.length; offset += 1)
                boundaries[closeAt + offset] = output.length;
            index = closeAt + format.close.length;
            continue;
        }
        const link = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/.exec(text.slice(index));
        if (link) {
            const from = output.length;
            output += link[1];
            marks.push({ type: "link", from, to: output.length, param: link[2] });
            for (let offset = 0; offset < link[0].length; offset += 1)
                boundaries[index + offset] = offset <= link[1].length ? from + Math.max(0, offset - 1) : output.length;
            index += link[0].length;
            continue;
        }
        output += text[index];
        index += 1;
    }
    boundaries[text.length] = output.length;
    for (const mark of existingMarks)
        marks.push({ ...mark, ...(mark.from !== undefined ? { from: boundaries[mark.from] ?? mark.from } : {}), ...(mark.to !== undefined ? { to: boundaries[mark.to] ?? mark.to } : {}) });
    return { text: output, marks };
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

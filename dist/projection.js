export class RunProjection {
    anytype;
    config;
    conversation;
    responseId;
    reactionTargetId;
    replyTargetId;
    triggerReplyTargetId;
    cycles = [];
    activeCycle;
    timer;
    closed = false;
    writes = Promise.resolve();
    onMessage;
    onCycle;
    createdMessageIds = new Set();
    mentionTargets = new Map();
    constructor(anytype, config, conversation, responseId, reactionTargetId, replyTargetId, triggerReplyTargetId, mentionTargets = []) {
        this.anytype = anytype;
        this.config = config;
        this.conversation = conversation;
        this.responseId = responseId;
        this.reactionTargetId = reactionTargetId;
        this.replyTargetId = replyTargetId;
        this.triggerReplyTargetId = triggerReplyTargetId;
        this.activeCycle = {
            id: crypto.randomUUID(),
            state: "transient",
            sourceId: undefined,
            text: config.responses.workingText,
            ...(replyTargetId ? { replyToMessageId: replyTargetId } : {}),
            messageId: responseId,
            completed: false,
        };
        this.cycles.push(this.activeCycle);
        this.createdMessageIds.add(responseId);
        this.addMentionTargets(mentionTargets);
    }
    static async create(anytype, config, conversation, triggerId, replyTargetId, mentionTargets = []) {
        await anytype.ensureReaction(conversation.spaceId, conversation.chatId, triggerId, config.responses.workingReaction, true, conversation.selfParticipantId);
        try {
            const responseId = await anytype.sendMessage(conversation.spaceId, conversation.chatId, {
                text: config.responses.workingText,
                ...(replyTargetId ? { replyTo: replyTargetId } : {}),
            });
            return new RunProjection(anytype, config, conversation, responseId, triggerId, replyTargetId, triggerId, mentionTargets);
        }
        catch (error) {
            await anytype
                .ensureReaction(conversation.spaceId, conversation.chatId, triggerId, config.responses.workingReaction, false, conversation.selfParticipantId)
                .catch(() => undefined);
            throw error;
        }
    }
    static async resume(anytype, config, conversation, responseId, triggerId, replyTargetId, text = "", mentionTargets = []) {
        const projection = new RunProjection(anytype, config, conversation, responseId, triggerId, replyTargetId, triggerId, mentionTargets);
        if (text && text !== config.responses.workingText) {
            projection.activeCycle.state = "text";
            projection.activeCycle.text = text;
        }
        await anytype.ensureReaction(conversation.spaceId, conversation.chatId, triggerId, config.responses.workingReaction, true, conversation.selfParticipantId);
        return projection;
    }
    get messageId() {
        return this.responseId;
    }
    trackMessages(callback) {
        this.onMessage = callback;
        for (const messageId of this.createdMessageIds)
            callback(messageId);
    }
    trackCycles(callback) {
        this.onCycle = callback;
        for (const cycle of this.cycles)
            this.emitCycle(cycle);
    }
    addMentionTargets(targets) {
        for (const target of targets)
            this.mentionTargets.set(target.participantId, target);
    }
    async move(triggerId, replyTargetId) {
        this.cancelScheduledEdit();
        return this.enqueue(async () => {
            const previous = this.activeCycle;
            if (previous.state === "text") {
                previous.completed = true;
                await this.editCycleNow(previous);
                this.emitCycle(previous);
            }
            else if (previous.messageId && !previous.deleted) {
                await this.anytype.deleteMessage(this.conversation.spaceId, this.conversation.chatId, previous.messageId);
                previous.deleted = true;
                this.emitCycle(previous);
            }
            await this.setWorkingReaction(this.reactionTargetId, false);
            this.replyTargetId = replyTargetId;
            this.reactionTargetId = triggerId;
            const cycle = {
                id: crypto.randomUUID(),
                state: "transient",
                sourceId: undefined,
                text: this.config.responses.workingText,
                ...(replyTargetId ? { replyToMessageId: replyTargetId } : {}),
                completed: false,
            };
            this.cycles.push(cycle);
            this.activeCycle = cycle;
            await this.createCycleMessageNow(cycle);
            await this.setWorkingReaction(this.reactionTargetId, true);
            return this.responseId;
        });
    }
    onEvent(event) {
        if (this.closed)
            return;
        if (event.type === "text-delta") {
            this.updateText(event.text, event.partId ?? event.phase, event.replace === true);
        }
        else if (event.type === "thinking-delta" && this.config.responses.thinking === "stream") {
            this.updateThinking(event.text, event.partId, event.replace === true);
        }
        else if (event.type === "tool" && this.config.responses.mode !== "single") {
            this.updateTransient(`${event.status === "completed" ? "✓" : "↻"} ${event.name}`);
        }
        else if (event.type === "status" && this.config.responses.mode === "verbose" && event.text) {
            this.updateTransient(event.text);
        }
    }
    async finish(result) {
        this.closed = true;
        this.cancelScheduledEdit();
        return this.enqueue(async () => {
            await this.setWorkingReaction(this.reactionTargetId, false);
            if (result.silent) {
                if (this.config.responses.silentPlaceholder === "delete")
                    for (const cycle of this.cycles) {
                        if (!cycle.messageId || cycle.deleted)
                            continue;
                        await this.anytype.deleteMessage(this.conversation.spaceId, this.conversation.chatId, cycle.messageId);
                        cycle.deleted = true;
                        this.emitCycle(cycle);
                    }
                else if (this.config.responses.silentPlaceholder === "replace") {
                    await this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, this.responseId, this.config.responses.silentText);
                    for (const cycle of this.cycles) {
                        if (!cycle.messageId || cycle.messageId === this.responseId || cycle.deleted)
                            continue;
                        await this.anytype.deleteMessage(this.conversation.spaceId, this.conversation.chatId, cycle.messageId);
                        cycle.deleted = true;
                        this.emitCycle(cycle);
                    }
                }
                else if (this.activeCycle.state !== "text" && this.activeCycle.messageId) {
                    this.activeCycle.state = "transient";
                    this.activeCycle.text = this.config.responses.workingText;
                    await this.editCycleNow(this.activeCycle);
                }
                for (const cycle of this.cycles) {
                    if (cycle.deleted)
                        continue;
                    cycle.completed = true;
                    this.emitCycle(cycle);
                }
                return "silent";
            }
            const textCycles = this.cycles.filter((cycle) => cycle.state === "text" && !cycle.deleted);
            if (this.activeCycle.state !== "text") {
                const streamed = textCycles
                    .map((cycle) => cycle.text.trim())
                    .filter(Boolean)
                    .join("\n\n");
                const terminal = result.text.trim();
                const tail = streamed && terminal.startsWith(streamed)
                    ? terminal.slice(streamed.length).trim()
                    : terminal;
                if (textCycles.length > 0 && (!tail || sameRenderedText(streamed, terminal))) {
                    if (this.activeCycle.messageId && !this.activeCycle.deleted)
                        await this.anytype.deleteMessage(this.conversation.spaceId, this.conversation.chatId, this.activeCycle.messageId);
                    this.activeCycle.deleted = true;
                }
                else {
                    this.activeCycle.state = "text";
                    this.activeCycle.sourceId = "terminal-result";
                    this.activeCycle.text = tail || "Completed without a text response.";
                }
            }
            else if (result.text && textCycles.length === 1) {
                this.activeCycle.text = result.text;
            }
            else if (result.text &&
                textCycles.length > 1 &&
                !textCycles.some((cycle) => sameRenderedText(cycle.text, result.text))) {
                const joined = textCycles
                    .map((cycle) => cycle.text.trim())
                    .filter(Boolean)
                    .join("\n\n");
                const last = textCycles.at(-1);
                if (sameRenderedText(joined, result.text)) {
                    // The runtime returned all streamed text parts flattened together.
                }
                else if (result.text.startsWith(last.text) || last.text.startsWith(result.text)) {
                    last.text = result.text;
                }
            }
            this.activeCycle.completed = true;
            this.emitCycle(this.activeCycle);
            for (const cycle of this.cycles) {
                if (cycle.state === "text" && !cycle.deleted)
                    await this.editCycleNow(cycle);
            }
            return "done";
        });
    }
    async fail(error) {
        this.closed = true;
        this.cancelScheduledEdit();
        await this.enqueue(async () => {
            await this.setWorkingReaction(this.reactionTargetId, false).catch(() => undefined);
            if (this.activeCycle.state === "text")
                await this.editCycleNow(this.activeCycle);
            const message = error instanceof Error ? error.message : String(error);
            await this.writeTerminalNotice(`Agent run failed: ${message.slice(0, 1000)}`);
            this.activeCycle.failed = true;
            this.emitCycle(this.activeCycle);
        });
    }
    async interrupt(message = "Agent run interrupted before completion.") {
        this.closed = true;
        this.cancelScheduledEdit();
        await this.enqueue(async () => {
            await this.setWorkingReaction(this.reactionTargetId, false).catch(() => undefined);
            if (this.activeCycle.state === "text")
                await this.editCycleNow(this.activeCycle);
            await this.writeTerminalNotice(message);
            this.activeCycle.failed = true;
            this.emitCycle(this.activeCycle);
        });
    }
    updateText(text, sourceId, replace) {
        if (!text && !replace)
            return;
        const current = this.activeCycle;
        if (current.state === "transient" || current.state === "thinking") {
            current.state = "text";
            current.sourceId = sourceId;
            current.text = text;
            this.emitCycle(current);
            if (this.config.responses.streaming)
                this.schedule(current);
            return;
        }
        const continues = current.state === "text" && current.sourceId === sourceId;
        if (continues) {
            current.text = replace ? text : `${current.text}${text}`;
            this.emitCycle(current);
            if (this.config.responses.streaming)
                this.schedule(current);
            return;
        }
        this.startCycle({
            id: crypto.randomUUID(),
            state: "text",
            sourceId,
            text,
            ...(this.replyTargetId ? { replyToMessageId: this.replyTargetId } : {}),
            completed: false,
        });
    }
    updateThinking(text, sourceId, replace) {
        if (!text && !replace)
            return;
        const current = this.activeCycle;
        if (current.state === "text") {
            this.startCycle({
                id: crypto.randomUUID(),
                state: "thinking",
                sourceId,
                text,
                ...(this.replyTargetId ? { replyToMessageId: this.replyTargetId } : {}),
                completed: false,
            });
            return;
        }
        if (current.state === "transient") {
            current.state = "thinking";
            current.sourceId = sourceId;
            current.text = text;
        }
        else if (replace) {
            current.sourceId = sourceId ?? current.sourceId;
            current.text = text;
        }
        else {
            current.text = `${current.text}${text}`;
        }
        this.emitCycle(current);
        if (this.config.responses.streaming)
            this.schedule(current);
    }
    updateTransient(text) {
        if (this.activeCycle.state !== "transient")
            return;
        this.activeCycle.text = text;
        this.emitCycle(this.activeCycle);
        if (this.config.responses.streaming)
            this.schedule(this.activeCycle);
    }
    startCycle(cycle) {
        this.cancelScheduledEdit();
        this.activeCycle.completed = true;
        this.emitCycle(this.activeCycle);
        if (this.config.responses.streaming)
            void this.flushCycle(this.activeCycle).catch(() => undefined);
        this.cycles.push(cycle);
        this.activeCycle = cycle;
        if (this.config.responses.streaming)
            void this.enqueue(() => this.createCycleMessageNow(cycle)).catch(() => undefined);
    }
    schedule(cycle) {
        if (this.timer)
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flushCycle(cycle).catch(() => undefined);
        }, this.config.responses.editIntervalMilliseconds);
    }
    cancelScheduledEdit() {
        if (!this.timer)
            return;
        clearTimeout(this.timer);
        this.timer = undefined;
    }
    currentDisplay(cycle = this.activeCycle) {
        const raw = stripNativeReplyDirective(cycle.text) || this.config.responses.workingText;
        const labeled = cycle.state === "thinking" ? `Thinking…\n\n${raw}` : raw;
        const rendered = renderForAnytype(labeled, this.config, [...this.mentionTargets.values()]);
        return truncateRendered(rendered, this.config.responses.maxCharacters);
    }
    setWorkingReaction(messageId, present) {
        return this.anytype.ensureReaction(this.conversation.spaceId, this.conversation.chatId, messageId, this.config.responses.workingReaction, present, this.conversation.selfParticipantId);
    }
    async flushCycle(cycle) {
        await this.enqueue(() => this.editCycleNow(cycle));
    }
    async editCycleNow(cycle) {
        if (cycle.deleted)
            return;
        if (!cycle.replyToMessageId && cycle.state === "text" && requestsNativeReply(cycle.text)) {
            cycle.replyToMessageId = this.triggerReplyTargetId;
            if (cycle.messageId) {
                await this.anytype.deleteMessage(this.conversation.spaceId, this.conversation.chatId, cycle.messageId);
                delete cycle.messageId;
            }
        }
        if (!cycle.messageId) {
            await this.createCycleMessageNow(cycle);
            return;
        }
        const current = this.currentDisplay(cycle);
        await this.anytype.editMessage(this.conversation.spaceId, this.conversation.chatId, cycle.messageId, current.text, current.marks, current.attachments);
    }
    async createCycleMessageNow(cycle) {
        if (cycle.messageId || cycle.deleted)
            return;
        const current = this.currentDisplay(cycle);
        cycle.messageId = await this.anytype.sendMessage(this.conversation.spaceId, this.conversation.chatId, {
            text: current.text,
            marks: current.marks,
            attachments: current.attachments,
            ...(cycle.replyToMessageId ? { replyTo: cycle.replyToMessageId } : {}),
        });
        this.responseId = cycle.messageId;
        this.createdMessageIds.add(cycle.messageId);
        this.onMessage?.(cycle.messageId);
        this.emitCycle(cycle);
    }
    async writeTerminalNotice(text) {
        if (this.activeCycle.state !== "text" && !this.activeCycle.deleted) {
            this.activeCycle.state = "transient";
            this.activeCycle.text = text;
            await this.editCycleNow(this.activeCycle);
            return;
        }
        this.activeCycle.completed = true;
        this.emitCycle(this.activeCycle);
        const messageId = await this.anytype.sendMessage(this.conversation.spaceId, this.conversation.chatId, { text, ...(this.replyTargetId ? { replyTo: this.replyTargetId } : {}) });
        const cycle = {
            id: crypto.randomUUID(),
            state: "transient",
            sourceId: "terminal-notice",
            text,
            ...(this.replyTargetId ? { replyToMessageId: this.replyTargetId } : {}),
            messageId,
            completed: false,
            failed: true,
        };
        this.cycles.push(cycle);
        this.activeCycle = cycle;
        this.responseId = messageId;
        this.createdMessageIds.add(messageId);
        this.onMessage?.(messageId);
        this.emitCycle(cycle);
    }
    enqueue(write) {
        const next = this.writes.then(write, write);
        this.writes = next.catch(() => undefined);
        return next;
    }
    emitCycle(cycle) {
        if (!this.onCycle || !cycle.messageId)
            return;
        this.onCycle({
            id: cycle.id,
            messageId: cycle.messageId,
            ...(cycle.replyToMessageId ? { replyToMessageId: cycle.replyToMessageId } : {}),
            phase: cycle.failed
                ? "error"
                : cycle.state === "thinking"
                    ? "thinking"
                    : cycle.state === "text"
                        ? "answer"
                        : "working",
            state: cycle.deleted
                ? "deleted"
                : cycle.failed
                    ? "failed"
                    : cycle.completed
                        ? "complete"
                        : "open",
            text: cycle.text,
        });
    }
}
const nativeReplyDirective = /^\s*\[\[AAG_REPLY\]\]\s*/i;
function requestsNativeReply(text) {
    return nativeReplyDirective.test(text);
}
function stripNativeReplyDirective(text) {
    return text.replace(nativeReplyDirective, "");
}
function sameRenderedText(left, right) {
    return left.trim().replace(/\s+/g, " ") === right.trim().replace(/\s+/g, " ");
}
function truncateRendered(rendered, maxCharacters) {
    if (rendered.text.length <= maxCharacters)
        return {
            text: rendered.text,
            marks: clampMarks(rendered.marks, rendered.text.length),
            attachments: rendered.attachments,
        };
    const notice = "\n\n[Response truncated by AAG]";
    let prefix = rendered.text.slice(0, Math.max(0, maxCharacters - notice.length));
    if (prefix && /[\uD800-\uDBFF]/.test(prefix.at(-1)))
        prefix = prefix.slice(0, -1);
    return {
        text: `${prefix}${notice}`,
        marks: clampMarks(rendered.marks, prefix.length),
        attachments: rendered.attachments,
    };
}
function clampMarks(marks, contentLength) {
    return marks.flatMap((mark) => {
        if (mark.from === undefined || mark.to === undefined)
            return [];
        const from = Math.max(0, Math.min(mark.from, contentLength));
        const to = Math.max(from, Math.min(mark.to, contentLength));
        return to > from ? [{ ...mark, from, to }] : [];
    });
}
export function renderCoordination(text, config, dynamicTargets = []) {
    const peers = new Map();
    for (const peer of config.coordination.peers)
        for (const name of [peer.name, ...peer.aliases])
            peers.set(name.toLocaleLowerCase(), peer);
    for (const target of dynamicTargets)
        peers.set(target.name.toLocaleLowerCase(), {
            name: target.name,
            participantId: target.participantId,
            aliases: [],
        });
    const marks = [];
    const tagged = new Set();
    const matcher = /\[\[AAG_MENTION:([^\]\n]+)\]\]/gi;
    let rendered = "";
    let cursor = 0;
    for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
        rendered += text.slice(cursor, match.index);
        cursor = match.index + match[0].length;
        const peer = peers.get((match[1] ?? "").trim().replace(/^@/, "").toLocaleLowerCase());
        if (!peer ||
            (!tagged.has(peer.participantId) && tagged.size >= config.coordination.maxFanout)) {
            rendered += match[0];
            continue;
        }
        const mention = `@${peer.name}`;
        if (!tagged.has(peer.participantId)) {
            marks.push({
                type: "mention",
                from: rendered.length,
                to: rendered.length + mention.length,
                param: peer.participantId,
            });
            tagged.add(peer.participantId);
        }
        rendered += mention;
    }
    rendered += text.slice(cursor);
    const occupied = marks.map((mark) => [mark.from ?? 0, mark.to ?? 0]);
    const uniqueTargets = new Map([...peers.values()].map((target) => [target.participantId, target]));
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
    const attachments = [];
    const attachedObjects = new Set();
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
            if ((text.startsWith("- ", index) || text.startsWith("* ", index)) &&
                !text.startsWith("**", index)) {
                boundaries[index] = output.length;
                boundaries[index + 1] = output.length + 1;
                output += "• ";
                index += 2;
                continue;
            }
        }
        if (text.startsWith("```", index)) {
            const header = /^```[^\n`]*\n/.exec(text.slice(index));
            const contentStart = index + (header?.[0].length ?? 3);
            const closeAt = text.indexOf("```", contentStart);
            if (closeAt >= contentStart) {
                const rawContent = text.slice(contentStart, closeAt);
                const content = rawContent.endsWith("\n") ? rawContent.slice(0, -1) : rawContent;
                for (let offset = index; offset < contentStart; offset += 1)
                    boundaries[offset] = output.length;
                const from = output.length;
                output += content;
                for (let offset = 0; offset <= rawContent.length; offset += 1)
                    boundaries[contentStart + offset] = from + Math.min(offset, content.length);
                if (content)
                    marks.push({ type: "keyboard", from, to: output.length });
                for (let offset = 0; offset < 3; offset += 1)
                    boundaries[closeAt + offset] = output.length;
                index = closeAt + 3;
                continue;
            }
        }
        const objectCard = /^\[\[AAG_OBJECT_CARD:([^|\]\n]+)\|([^\]\n]+)\]\]/i.exec(text.slice(index));
        if (objectCard) {
            const objectId = objectCard[1].trim();
            const label = objectCard[2].trim();
            output += label;
            if (!attachedObjects.has(objectId)) {
                attachments.push({ target: objectId, type: "file" });
                attachedObjects.add(objectId);
            }
            for (let offset = 0; offset < objectCard[0].length; offset += 1)
                boundaries[index + offset] = output.length;
            index += objectCard[0].length;
            continue;
        }
        const objectReference = /^\[\[AAG_OBJECT:([^|\]\n]+)\|([^\]\n]+)\]\]/i.exec(text.slice(index));
        if (objectReference) {
            const objectId = objectReference[1].trim();
            const label = objectReference[2].trim();
            const from = output.length;
            output += label;
            marks.push({ type: "object", from, to: output.length, param: objectId });
            for (let offset = 0; offset < objectReference[0].length; offset += 1)
                boundaries[index + offset] = offset === 0 ? from : output.length;
            index += objectReference[0].length;
            continue;
        }
        const formats = [
            { open: "**", close: "**", type: "bold" },
            { open: "__", close: "__", type: "bold" },
            { open: "~~", close: "~~", type: "strikethrough" },
            { open: "`", close: "`", type: "keyboard" },
            { open: "*", close: "*", type: "italic" },
            { open: "_", close: "_", type: "italic" },
        ];
        const format = formats.find((candidate) => {
            if (!text.startsWith(candidate.open, index))
                return false;
            const closeAt = text.indexOf(candidate.close, index + candidate.open.length);
            if (closeAt <= index + candidate.open.length)
                return false;
            if (!candidate.open.includes("_"))
                return true;
            return (!isWordCharacter(text[index - 1]) &&
                !isWordCharacter(text[closeAt + candidate.close.length]));
        });
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
        const link = /^\[([^\]\n]+)\]\(((?:https?|anytype):\/\/[^)\s]+)\)/.exec(text.slice(index));
        if (link) {
            const from = output.length;
            output += link[1];
            marks.push({ type: "link", from, to: output.length, param: link[2] });
            for (let offset = 0; offset < link[0].length; offset += 1)
                boundaries[index + offset] =
                    offset <= link[1].length ? from + Math.max(0, offset - 1) : output.length;
            index += link[0].length;
            continue;
        }
        output += text[index];
        index += 1;
    }
    boundaries[text.length] = output.length;
    for (const mark of existingMarks)
        marks.push({
            ...mark,
            ...(mark.from !== undefined ? { from: boundaries[mark.from] ?? mark.from } : {}),
            ...(mark.to !== undefined ? { to: boundaries[mark.to] ?? mark.to } : {}),
        });
    return { text: output, marks, attachments };
}
function isWordCharacter(value) {
    return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

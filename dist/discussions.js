import { runProcess } from "./process.js";
export class HeartDiscussionAdapter {
    config;
    constructor(config) {
        this.config = config;
    }
    async resolve(spaceId, objects, createMissing) {
        if (!objects.length)
            return [];
        const { command, grpcAddress } = this.config.anytype.heartAdapter;
        const args = [
            "resolve",
            "--space-id",
            spaceId,
            "--grpc-address",
            grpcAddress,
            ...(createMissing ? ["--create-missing"] : []),
        ];
        if (this.config.anytype.cli.configPath)
            args.push("--config", this.config.anytype.cli.configPath);
        const { stdout } = await runProcess(command, args, {
            stdin: `${JSON.stringify({ objectIds: objects.map((object) => object.id) })}\n`,
            timeoutMs: Math.max(30_000, objects.length * 12_000),
        });
        const result = JSON.parse(stdout);
        return result.discussions;
    }
    async ensureDirectMessage(identity, signal) {
        const { command, grpcAddress } = this.config.anytype.heartAdapter;
        const args = ["ensure-dm", "--grpc-address", grpcAddress];
        if (this.config.anytype.cli.configPath)
            args.push("--config", this.config.anytype.cli.configPath);
        const { stdout } = await runProcess(command, args, {
            stdin: `${JSON.stringify({ identity })}\n`,
            timeoutMs: 35_000,
            ...(signal ? { signal } : {}),
        });
        const result = JSON.parse(stdout);
        if (!result.spaceId || !result.chatId)
            throw new Error("Heart returned no direct-message space or chat ID");
        return result;
    }
    async hydrateMessages(chatId, messages) {
        const pending = messages.filter((message) => !message.content?.text);
        if (!pending.length)
            return messages;
        const { command, grpcAddress } = this.config.anytype.heartAdapter;
        const args = ["hydrate", "--grpc-address", grpcAddress];
        if (this.config.anytype.cli.configPath)
            args.push("--config", this.config.anytype.cli.configPath);
        const { stdout } = await runProcess(command, args, {
            stdin: `${JSON.stringify({ chatId, messageIds: pending.map((message) => message.id) })}\n`,
            timeoutMs: Math.max(30_000, pending.length * 2_000),
        });
        const result = JSON.parse(stdout);
        const hydrated = new Map(result.messages.map((message) => [message.id, message]));
        return messages.map((message) => {
            const full = hydrated.get(message.id);
            if (!full)
                return message;
            const content = full.content?.text || full.content?.marks?.length ? full.content : message.content;
            return {
                ...full,
                ...message,
                ...(content ? { content } : {}),
                ...(full.mentioned ? { mentioned: true } : {}),
            };
        });
    }
    async sendMessage(chatId, input) {
        const result = await this.mutate("send", {
            chatId,
            text: input.text,
            ...(input.replyTo ? { replyTo: input.replyTo } : {}),
            ...(input.marks?.length ? { marks: input.marks } : {}),
            ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        });
        if (!result.messageId)
            throw new Error("Heart returned no messageId");
        return result.messageId;
    }
    async editMessage(chatId, messageId, text, marks, attachments) {
        await this.mutate("edit", {
            chatId,
            messageId,
            text,
            marks: marks ?? [],
            attachments: attachments ?? [],
        });
    }
    async deleteMessage(chatId, messageId) {
        await this.mutate("delete", { chatId, messageId });
    }
    async mutate(action, input) {
        const { command, grpcAddress } = this.config.anytype.heartAdapter;
        const args = [action, "--grpc-address", grpcAddress];
        if (this.config.anytype.cli.configPath)
            args.push("--config", this.config.anytype.cli.configPath);
        const { stdout } = await runProcess(command, args, {
            stdin: `${JSON.stringify(input)}\n`,
            timeoutMs: 30_000,
        });
        return stdout.trim() ? JSON.parse(stdout) : {};
    }
}
export class DiscussionAnytypePort {
    base;
    heart;
    constructor(base, heart) {
        this.base = base;
        this.heart = heart;
    }
    async getMessage(spaceId, chatId, messageId) {
        const message = await this.base.getMessage(spaceId, chatId, messageId);
        return (await this.heart.hydrateMessages(chatId, [message]))[0] ?? message;
    }
    async listMessages(spaceId, chatId, limit, afterOrderId) {
        return this.heart.hydrateMessages(chatId, await this.base.listMessages(spaceId, chatId, limit, afterOrderId));
    }
    async sendMessage(_spaceId, chatId, input) {
        return this.heart.sendMessage(chatId, input);
    }
    async editMessage(_spaceId, chatId, messageId, text, marks, attachments) {
        await this.heart.editMessage(chatId, messageId, text, marks, attachments);
    }
    async deleteMessage(_spaceId, chatId, messageId) {
        await this.heart.deleteMessage(chatId, messageId);
    }
    async ensureReaction(spaceId, chatId, messageId, emoji, present, participantId) {
        await this.base.ensureReaction(spaceId, chatId, messageId, emoji, present, participantId);
    }
    async *stream(spaceId, chatId, signal) {
        for await (const event of this.base.stream(spaceId, chatId, signal)) {
            const message = event.payload?.message;
            if (!message) {
                yield event;
                continue;
            }
            const hydrated = (await this.heart.hydrateMessages(chatId, [message]))[0] ?? message;
            yield { ...event, payload: { ...event.payload, message: hydrated } };
        }
    }
    async resolveSpace(selector) {
        return this.base.resolveSpace(selector);
    }
    async listSpaces() {
        return this.base.listSpaces();
    }
    async listMembers(spaceId) {
        return this.base.listMembers(spaceId);
    }
    async resolveChat(spaceId, selector) {
        return this.base.resolveChat(spaceId, selector);
    }
    async listChats(spaceId) {
        return this.base.listChats(spaceId);
    }
    async getObject(spaceId, objectId) {
        return this.base.getObject(spaceId, objectId);
    }
    async listPropertyTags(spaceId, propertyId) {
        return this.base.listPropertyTags(spaceId, propertyId);
    }
    async listProperties(spaceId) {
        return this.base.listProperties ? this.base.listProperties(spaceId) : [];
    }
    async createPropertyTag(spaceId, propertyId, input) {
        return this.base.createPropertyTag(spaceId, propertyId, input);
    }
    async updateObject(spaceId, objectId, input) {
        return this.base.updateObject(spaceId, objectId, input);
    }
    async downloadFile(spaceId, fileId, maxBytes) {
        if (!this.base.downloadFile)
            throw new Error("Anytype attachment downloads are unavailable for this discussion");
        return this.base.downloadFile(spaceId, fileId, maxBytes);
    }
    async searchObjects(spaceId, offset, limit) {
        return this.base.searchObjects(spaceId, offset, limit);
    }
}

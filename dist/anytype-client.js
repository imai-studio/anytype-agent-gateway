import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { runProcess } from "./process.js";
import { sameIdentity } from "./principal.js";
export class AnytypeClient {
    base;
    headers;
    participantId;
    heartAdapter;
    anytypeCliConfigPath;
    localReactions = new Set();
    reactionTails = new Map();
    writeTail = Promise.resolve();
    constructor(base, headers, participantId, heartAdapter, anytypeCliConfigPath) {
        this.base = base;
        this.headers = headers;
        this.participantId = participantId;
        this.heartAdapter = heartAdapter;
        this.anytypeCliConfigPath = anytypeCliConfigPath;
    }
    static async create(config) {
        const apiKey = (await readFile(config.anytype.apiKeyFile, "utf8")).trim();
        if (!apiKey)
            throw new Error(`Anytype API key file is empty: ${config.anytype.apiKeyFile}`);
        return new AnytypeClient(config.anytype.apiBase.replace(/\/$/, ""), { Authorization: `Bearer ${apiKey}`, "Anytype-Version": config.anytype.apiVersion }, config.agent.participantId, config.anytype.heartAdapter, config.anytype.cli.configPath);
    }
    async request(path, init = {}) {
        const method = init.method ?? "GET";
        const streaming = new Headers(init.headers).get("Accept") === "text/event-stream";
        if (method !== "GET" && !streaming) {
            const write = this.writeTail.then(() => this.requestWithRetry(path, init, method, streaming));
            this.writeTail = write.catch(() => undefined);
            return write;
        }
        return this.requestWithRetry(path, init, method, streaming);
    }
    async requestWithRetry(path, init, method, streaming) {
        const attempts = method === "GET" && !streaming ? 3 : method !== "GET" ? 4 : 1;
        let lastError;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                const timeout = streaming ? undefined : AbortSignal.timeout(15_000);
                const signal = timeout && init.signal
                    ? AbortSignal.any([timeout, init.signal])
                    : (timeout ?? init.signal);
                const contentHeaders = init.body instanceof FormData ? {} : { "Content-Type": "application/json" };
                const response = await fetch(`${this.base}${path}`, {
                    ...init,
                    ...(signal ? { signal } : {}),
                    headers: { ...this.headers, ...contentHeaders, ...init.headers },
                });
                if (response.ok)
                    return response;
                const retryable = response.status === 429 || (method === "GET" && response.status >= 500);
                const retryAfter = response.status === 429 ? retryAfterMs(response.headers.get("retry-after")) : undefined;
                const body = (await response.text()).slice(0, 1000);
                const error = new Error(`Anytype ${method} ${path} failed (${response.status}): ${body}`);
                if (attempt + 1 >= attempts || !retryable)
                    throw error;
                lastError = error;
                await new Promise((resolve) => setTimeout(resolve, retryAfter ?? 250 * 2 ** attempt));
                continue;
            }
            catch (error) {
                lastError = error;
                if (attempt + 1 >= attempts || init.signal?.aborted || method !== "GET")
                    throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        }
        throw lastError;
    }
    async resolveSpace(selector) {
        const spaces = await this.listPages("/v1/spaces");
        const matches = spaces.filter((space) => selector.id ? space.id === selector.id : space.name === selector.name);
        if (matches.length !== 1)
            throw new Error(`Expected one Anytype space matching ${selector.id ?? JSON.stringify(selector.name)}, found ${matches.length}`);
        const match = matches[0];
        return { id: match.id, name: match.name ?? match.id };
    }
    async listSpaces() {
        const spaces = await this.listPages("/v1/spaces");
        return spaces.map((space) => ({
            id: space.id,
            name: space.name || space.id,
            ...(typeof space.object === "string" ? { object: space.object } : {}),
        }));
    }
    async listMembers(spaceId) {
        const members = await this.listPages(`/v1/spaces/${encodeURIComponent(spaceId)}/members`);
        return members.map((member) => ({
            id: member.id,
            name: member.name || member.id,
            ...(member.identity ? { identity: member.identity } : {}),
            ...(member.status ? { status: member.status } : {}),
        }));
    }
    async resolveChat(spaceId, selector) {
        const chats = await this.listChats(spaceId);
        const matches = chats.filter((chat) => selector.id ? chat.id === selector.id : chat.name === selector.name);
        if (matches.length !== 1)
            throw new Error(`Expected one Anytype chat matching ${selector.id ?? JSON.stringify(selector.name)}, found ${matches.length}`);
        const match = matches[0];
        return { id: match.id, name: match.name ?? match.id };
    }
    async listChats(spaceId) {
        const chats = await this.listPages(`/v1/spaces/${encodeURIComponent(spaceId)}/chats`);
        return chats.map((chat) => ({ id: chat.id, name: chat.name ?? chat.id }));
    }
    async createChat(spaceId, input) {
        const json = (await (await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/chats`, {
            method: "POST",
            body: JSON.stringify({ name: input.name }),
        })).json());
        const chat = json.object;
        if (!chat?.id)
            throw new Error("Anytype returned no chat ID");
        return { id: String(chat.id), name: String(chat.name || input.name || chat.id) };
    }
    async downloadFile(spaceId, fileId, maxBytes) {
        const response = await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/files/${encodeURIComponent(fileId)}`);
        const declaredSize = Number(response.headers.get("content-length") ?? 0);
        if (declaredSize > maxBytes)
            throw new Error(`Anytype attachment exceeds the ${maxBytes}-byte download limit`);
        if (!response.body)
            throw new Error("Anytype returned an empty attachment body");
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > maxBytes) {
                await reader.cancel();
                throw new Error(`Anytype attachment exceeds the ${maxBytes}-byte download limit`);
            }
            chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
        return { bytes, ...(contentType ? { contentType } : {}) };
    }
    async getMessage(spaceId, chatId, messageId) {
        const json = (await (await this.request(this.messagePath(spaceId, chatId, messageId))).json());
        return json.message;
    }
    async listMessages(spaceId, chatId, limit, afterOrderId) {
        const query = new URLSearchParams({
            limit: String(limit),
            ...(afterOrderId ? { after_order_id: afterOrderId } : {}),
        });
        const json = (await (await this.request(`${this.messagesPath(spaceId, chatId)}?${query}`)).json());
        return json.messages ?? [];
    }
    async sendMessage(spaceId, chatId, input) {
        const body = { text: input.text, style: "paragraph" };
        if (input.replyTo)
            body.reply_to_message_id = input.replyTo;
        if (input.marks?.length)
            body.marks = input.marks;
        if (input.attachments?.length)
            body.attachments = input.attachments;
        const json = (await (await this.request(this.messagesPath(spaceId, chatId), {
            method: "POST",
            body: JSON.stringify(body),
        })).json());
        if (!json.message_id)
            throw new Error("Anytype returned no message_id");
        return json.message_id;
    }
    async editMessage(spaceId, chatId, messageId, text, marks, attachments) {
        await this.request(this.messagePath(spaceId, chatId, messageId), {
            method: "PATCH",
            body: JSON.stringify({
                text,
                style: "paragraph",
                marks: marks ?? [],
                attachments: attachments ?? [],
            }),
        });
    }
    async deleteMessage(spaceId, chatId, messageId) {
        await this.request(this.messagePath(spaceId, chatId, messageId), { method: "DELETE" });
    }
    async ensureReaction(spaceId, chatId, messageId, emoji, present, participantId = this.participantId) {
        const key = `${spaceId}:${chatId}:${messageId}:${emoji}`;
        const previous = this.reactionTails.get(key) ?? Promise.resolve();
        const current = previous.then(() => this.ensureReactionNow(spaceId, chatId, messageId, emoji, present, participantId));
        const tail = current.catch(() => undefined);
        this.reactionTails.set(key, tail);
        try {
            await current;
        }
        finally {
            if (this.reactionTails.get(key) === tail)
                this.reactionTails.delete(key);
        }
    }
    async ensureReactionNow(spaceId, chatId, messageId, emoji, present, participantId) {
        const message = await this.getMessage(spaceId, chatId, messageId);
        const reactors = message.reactions?.[emoji] ?? [];
        const key = `${spaceId}:${chatId}:${messageId}:${emoji}`;
        const remoteMatch = participantId
            ? reactors.some((reactor) => sameIdentity(reactor, participantId))
            : false;
        const already = remoteMatch || this.localReactions.has(key);
        if (already === present)
            return;
        await this.request(`${this.messagePath(spaceId, chatId, messageId)}/reactions`, {
            method: "POST",
            body: JSON.stringify({ emoji }),
        });
        if (present)
            this.localReactions.add(key);
        else
            this.localReactions.delete(key);
    }
    async *stream(spaceId, chatId, signal) {
        const response = await this.request(`${this.messagesPath(spaceId, chatId)}/stream?limit=50`, {
            headers: { Accept: "text/event-stream", "Anytype-Heartbeat-Seconds": "15" },
            signal,
        });
        if (!response.body)
            throw new Error("Anytype event stream had no body");
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = "";
        try {
            for (;;) {
                const { done, value } = await readWithIdleTimeout(reader, signal, 45_000);
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
                let boundary = buffer.indexOf("\n\n");
                while (boundary >= 0) {
                    const block = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    const event = parseSseBlock(block);
                    if (event)
                        yield event;
                    boundary = buffer.indexOf("\n\n");
                }
            }
        }
        finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
    }
    async getObject(spaceId, objectId) {
        const json = (await (await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`)).json());
        const object = json.object ?? json;
        return { ...object, id: object.id ?? objectId };
    }
    async listTypes(spaceId) {
        return this.listPages(`/v1/spaces/${encodeURIComponent(spaceId)}/types`);
    }
    async getType(spaceId, typeId) {
        const json = (await (await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/types/${encodeURIComponent(typeId)}`)).json());
        return json.type ?? json;
    }
    async listProperties(spaceId) {
        return this.listPages(`/v1/spaces/${encodeURIComponent(spaceId)}/properties`);
    }
    async getProperty(spaceId, propertyId) {
        const json = (await (await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/properties/${encodeURIComponent(propertyId)}`)).json());
        return json.property ?? json;
    }
    async listPropertyTags(spaceId, propertyId) {
        const tags = await this.listPages(`/v1/spaces/${encodeURIComponent(spaceId)}/properties/${encodeURIComponent(propertyId)}/tags`);
        return tags.map((tag) => ({
            id: String(tag.id),
            name: String(tag.name),
            ...(tag.key ? { key: String(tag.key) } : {}),
            ...(tag.color ? { color: String(tag.color) } : {}),
        }));
    }
    async createPropertyTag(spaceId, propertyId, input) {
        const json = (await (await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/properties/${encodeURIComponent(propertyId)}/tags`, { method: "POST", body: JSON.stringify(input) })).json());
        const tag = json.tag ?? json;
        if (!tag.id || !tag.name)
            throw new Error("Anytype returned an incomplete project tag");
        return {
            id: String(tag.id),
            name: String(tag.name),
            ...(tag.key ? { key: String(tag.key) } : {}),
            ...(tag.color ? { color: String(tag.color) } : {}),
        };
    }
    async listTemplates(spaceId, typeId) {
        return this.listPages(`/v1/spaces/${encodeURIComponent(spaceId)}/types/${encodeURIComponent(typeId)}/templates`);
    }
    async searchObjects(spaceId, offset, limit) {
        const json = (await (await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/search?offset=${offset}&limit=${limit}`, { method: "POST", body: JSON.stringify({ query: "" }) })).json());
        return (json.data ?? []).map((item) => ({
            id: item.id,
            ...(item.name ? { name: item.name } : {}),
            ...(item.type?.key ? { type: item.type.key } : item.type ? { type: String(item.type) } : {}),
        }));
    }
    async searchWorkflowObjects(spaceId, typeKeys, offset, limit) {
        const summaries = await this.searchSpace(spaceId, { types: typeKeys, offset, limit });
        return Promise.all(summaries.map(async (summary) => {
            const raw = await this.getObject(spaceId, String(summary.id));
            const typeKey = objectTypeKey(raw) ?? objectTypeKey(summary);
            if (!typeKey || !typeKeys.includes(typeKey))
                throw new Error(`Anytype workflow object ${String(summary.id)} has no configured type key`);
            const modifiedAt = objectModifiedAt(raw);
            if (modifiedAt === undefined)
                throw new Error(`Anytype workflow object ${String(summary.id)} has no native revision`);
            const source = objectSource(raw);
            const editorParticipantId = objectEditorParticipantId(raw);
            return {
                id: String(raw.id ?? summary.id),
                name: String(raw.name ?? summary.name ?? raw.id ?? summary.id),
                typeKey,
                ...(source === undefined ? {} : { source }),
                modifiedAt,
                ...(editorParticipantId ? { editorParticipantId } : {}),
                archived: raw.archived === true || raw.is_archived === true,
            };
        }));
    }
    async searchSpace(spaceId, input) {
        const query = new URLSearchParams({
            offset: String(input.offset ?? 0),
            limit: String(input.limit ?? 100),
        });
        const json = (await (await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/search?${query}`, {
            method: "POST",
            body: JSON.stringify({
                query: input.query ?? "",
                ...(input.types?.length ? { types: input.types } : {}),
            }),
        })).json());
        return Array.isArray(json.data) ? json.data : [];
    }
    async createObject(spaceId, input) {
        const json = (await (await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/objects`, {
            method: "POST",
            body: JSON.stringify(input),
        })).json());
        return json.object ?? json;
    }
    async updateObject(spaceId, objectId, input) {
        const json = (await (await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`, { method: "PATCH", body: JSON.stringify(input) })).json());
        return json.object ?? json;
    }
    async archiveObject(spaceId, objectId) {
        const json = (await (await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`, { method: "DELETE" })).json());
        return json.object ?? json;
    }
    async addObjectsToList(spaceId, listId, objectIds) {
        await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/lists/${encodeURIComponent(listId)}/objects`, { method: "POST", body: JSON.stringify({ objects: objectIds }) });
    }
    async listViews(spaceId, listId) {
        return this.listPages(`/v1/spaces/${encodeURIComponent(spaceId)}/lists/${encodeURIComponent(listId)}/views`);
    }
    async listViewObjects(spaceId, listId, viewId, page = { offset: 0, limit: 50 }) {
        const path = `/v1/spaces/${encodeURIComponent(spaceId)}/lists/${encodeURIComponent(listId)}/views/${encodeURIComponent(viewId)}/objects?offset=${page.offset}&limit=${page.limit}`;
        const json = (await (await this.request(path)).json());
        if (!Array.isArray(json.data))
            throw new Error(`Anytype ${path} returned an invalid list payload`);
        return json.data;
    }
    async removeObjectFromList(spaceId, listId, objectId) {
        await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/lists/${encodeURIComponent(listId)}/objects/${encodeURIComponent(objectId)}`, { method: "DELETE" });
    }
    async uploadFile(spaceId, path) {
        const form = new FormData();
        form.append("file", await openAsBlob(path), basename(path));
        return (await (await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/files`, {
            method: "POST",
            body: form,
        })).json());
    }
    async setProfileImage(spaceId, path) {
        if (!this.heartAdapter)
            throw new Error("Anytype Heart adapter is not configured for profile updates");
        const args = ["profile-image", "--grpc-address", this.heartAdapter.grpcAddress];
        if (this.anytypeCliConfigPath)
            args.push("--config", this.anytypeCliConfigPath);
        const { stdout } = await runProcess(this.heartAdapter.command, args, {
            stdin: `${JSON.stringify({ spaceId, localPath: path })}\n`,
            timeoutMs: 60_000,
        });
        return stdout.trim() ? JSON.parse(stdout) : { updated: true };
    }
    messagesPath(spaceId, chatId) {
        return `/v1/spaces/${encodeURIComponent(spaceId)}/chats/${encodeURIComponent(chatId)}/messages`;
    }
    messagePath(spaceId, chatId, messageId) {
        return `${this.messagesPath(spaceId, chatId)}/${encodeURIComponent(messageId)}`;
    }
    async listPages(path) {
        const items = [];
        const seen = new Set();
        for (let offset = 0, pageNumber = 0; pageNumber < 100; pageNumber += 1) {
            const separator = path.includes("?") ? "&" : "?";
            const json = (await (await this.request(`${path}${separator}offset=${offset}&limit=100`)).json());
            if (!Array.isArray(json.data))
                throw new Error(`Anytype ${path} returned an invalid list payload`);
            const rawPage = json.data;
            if (!rawPage.length)
                break;
            const page = rawPage.filter((item) => typeof item?.id === "string" && !seen.has(item.id));
            for (const item of page) {
                seen.add(item.id);
                items.push(item);
            }
            offset += rawPage.length;
        }
        return items;
    }
}
function objectTypeKey(value) {
    const candidate = value.type?.key ?? value.type_key ?? value.typeKey;
    return typeof candidate === "string" && candidate ? candidate : undefined;
}
function objectSource(value) {
    const candidate = value.markdown ?? value.body;
    return typeof candidate === "string" ? candidate : undefined;
}
function objectModifiedAt(value) {
    const candidate = value.modified_at ?? value.modifiedAt ?? value.updated_at ?? value.details?.lastModifiedDate;
    const parsed = typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && /^\d+$/.test(candidate)
            ? Number(candidate)
            : typeof candidate === "string"
                ? Date.parse(candidate)
                : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0)
        return undefined;
    return parsed < 100_000_000_000 ? parsed * 1_000 : parsed;
}
function objectEditorParticipantId(value) {
    const candidate = value.last_modified_by?.participant_id ??
        value.last_modified_by?.id ??
        value.updated_by?.participant_id ??
        value.updated_by?.id ??
        value.editor?.participant_id ??
        value.editor?.id;
    return typeof candidate === "string" ? candidate : undefined;
}
function retryAfterMs(value) {
    if (!value)
        return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.min(seconds * 1000, 30_000);
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 30_000) : undefined;
}
async function readWithIdleTimeout(reader, signal, timeoutMs) {
    let timer;
    let abort;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Anytype event stream idle for ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
    });
    const aborted = new Promise((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new Error("Anytype event stream aborted"));
        if (signal.aborted)
            abort();
        else
            signal.addEventListener("abort", abort, { once: true });
    });
    try {
        return await Promise.race([reader.read(), timeout, aborted]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        if (abort)
            signal.removeEventListener("abort", abort);
    }
}
export function parseSseBlock(block) {
    const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
    if (!data)
        return undefined;
    const value = JSON.parse(data);
    if (!value || typeof value !== "object" || typeof value.type !== "string")
        throw new Error("Anytype event stream returned an invalid event envelope");
    return value;
}

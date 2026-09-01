import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { runProcess } from "./process.js";
import { sameIdentity } from "./principal.js";
const MAX_OBJECT_RESPONSE_BYTES = 2 * 1024 * 1024;
const WORKFLOW_OBJECT_READ_CONCURRENCY = 4;
export class AnytypeHttpError extends Error {
    status;
    method;
    endpoint;
    constructor(status, method, path) {
        const endpoint = anytypeEndpointTemplate(path);
        super(`Anytype ${method} ${endpoint} request failed (${status})`);
        this.status = status;
        this.method = method;
        this.name = "AnytypeHttpError";
        this.endpoint = endpoint;
    }
}
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
                await response.body?.cancel().catch(() => undefined);
                const error = new AnytypeHttpError(response.status, method, path);
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
    async getWorkflowObject(spaceId, objectId) {
        const boundedSpaceId = requiredIdentifier(spaceId, "workflow space");
        const boundedObjectId = requiredIdentifier(objectId, "workflow object");
        const response = await this.request(`/v1/spaces/${encodeURIComponent(boundedSpaceId)}/objects/${encodeURIComponent(boundedObjectId)}`);
        const json = await readBoundedJson(response, MAX_OBJECT_RESPONSE_BYTES);
        const object = json.object ?? json;
        return { ...object, id: boundedObjectId };
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
        const boundedSpaceId = requiredIdentifier(spaceId, "workflow space");
        const summaries = (await this.searchSpaceRequest(boundedSpaceId, { types: typeKeys, offset, limit }, true)).slice(0, limit);
        return mapConcurrent(summaries, WORKFLOW_OBJECT_READ_CONCURRENCY, async (summary) => {
            const summaryId = validIdentifier(summary.id, 512);
            if (!summaryId)
                return invalidWorkflowSummary("", summary, "object_identifier_invalid");
            try {
                const raw = await this.getWorkflowObject(boundedSpaceId, summaryId);
                const typeKey = objectTypeKey(raw) ?? objectTypeKey(summary);
                if (!typeKey || !typeKeys.includes(typeKey))
                    return invalidWorkflowSummary(summaryId, summary, "object_type_unverified");
                const modifiedAt = objectModifiedAt(raw);
                if (modifiedAt === undefined)
                    return invalidWorkflowSummary(summaryId, summary, "native_revision_missing");
                const source = objectSource(raw);
                const editorParticipantId = objectEditorParticipantId(raw);
                return {
                    id: validIdentifier(raw.id ?? summary.id, 512) ?? summaryId,
                    name: boundedName(raw.name ?? summary.name ?? raw.id ?? summary.id, 256) ?? "Workflow",
                    typeKey,
                    ...(source === undefined ? {} : { source }),
                    modifiedAt,
                    ...(editorParticipantId ? { editorParticipantId } : {}),
                    archived: raw.archived === true || raw.is_archived === true,
                };
            }
            catch (error) {
                const observationError = error instanceof AnytypeHttpError && [404, 410].includes(error.status)
                    ? "object_not_found"
                    : error instanceof Error && error.message === "Anytype object response is too large"
                        ? "object_too_large"
                        : error instanceof AnytypeHttpError
                            ? "anytype_request_failed"
                            : "object_read_failed";
                return invalidWorkflowSummary(summaryId, summary, observationError);
            }
        });
    }
    async searchSpace(spaceId, input) {
        return this.searchSpaceRequest(spaceId, input, false);
    }
    async searchSpaceRequest(spaceId, input, sortByLastModified) {
        const query = new URLSearchParams({
            offset: String(input.offset ?? 0),
            limit: String(input.limit ?? 100),
        });
        const json = (await (await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/search?${query}`, {
            method: "POST",
            body: JSON.stringify({
                query: input.query ?? "",
                ...(sortByLastModified
                    ? { sort: { direction: "desc", property_key: "last_modified_date" } }
                    : {}),
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
    const milliseconds = parsed < 100_000_000_000 ? parsed * 1_000 : parsed;
    return milliseconds <= Date.now() + 5 * 60 * 1_000 ? milliseconds : undefined;
}
function objectEditorParticipantId(value) {
    const property = Array.isArray(value.properties)
        ? value.properties.find((candidate) => candidate &&
            typeof candidate === "object" &&
            candidate.key === "last_modified_by")
        : undefined;
    if (!property || !Array.isArray(property.objects) || property.objects.length !== 1)
        return undefined;
    return boundedName(property.objects[0], 512);
}
function invalidWorkflowSummary(id, summary, observationError) {
    return {
        id,
        name: boundedName(summary.name ?? id, 256) ?? "Workflow",
        typeKey: objectTypeKey(summary) ?? "unverified",
        modifiedAt: objectModifiedAt(summary) ?? 0,
        archived: summary.archived === true || summary.is_archived === true,
        observationError,
    };
}
function boundedName(value, maximum) {
    if (typeof value !== "string")
        return undefined;
    const normalized = value.trim();
    return normalized ? [...normalized].slice(0, maximum).join("") : undefined;
}
function validIdentifier(value, maximumCodeUnits) {
    if (typeof value !== "string" ||
        !value ||
        value.length > maximumCodeUnits ||
        value.includes("\0"))
        return undefined;
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next < 0xdc00 || next > 0xdfff)
                return undefined;
            index += 1;
        }
        else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff)
            return undefined;
    }
    return value;
}
function requiredIdentifier(value, label) {
    const identifier = validIdentifier(value, 512);
    if (!identifier)
        throw new Error(`Anytype ${label} ID is invalid`);
    return identifier;
}
function anytypeEndpointTemplate(path) {
    const identifiers = new Map([
        ["spaces", "spaceId"],
        ["objects", "objectId"],
        ["chats", "chatId"],
        ["messages", "messageId"],
        ["types", "typeId"],
        ["properties", "propertyId"],
        ["files", "fileId"],
        ["members", "memberId"],
        ["templates", "templateId"],
    ]);
    const staticSegments = new Set([
        "v1",
        ...identifiers.keys(),
        "search",
        "stream",
        "tags",
        "reactions",
        "spaces",
    ]);
    const segments = path.split("?", 1)[0].split("/").filter(Boolean);
    const templated = segments.map((segment, index) => {
        const parameter = index > 0 ? identifiers.get(segments[index - 1]) : undefined;
        if (parameter)
            return `:${parameter}`;
        return staticSegments.has(segment) ? segment : ":id";
    });
    return templated.length ? `/${templated.join("/")}` : "/";
}
async function mapConcurrent(items, concurrency, map) {
    const result = new Array(items.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        for (;;) {
            const index = cursor++;
            if (index >= items.length)
                return;
            result[index] = await map(items[index]);
        }
    }));
    return result;
}
async function readBoundedJson(response, maximumBytes) {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximumBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Anytype object response is too large");
    }
    if (!response.body)
        return {};
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.byteLength;
            if (total > maximumBytes)
                throw new Error("Anytype object response is too large");
            chunks.push(value);
        }
    }
    finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
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

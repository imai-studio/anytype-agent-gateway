import { readFile } from "node:fs/promises";
export class AnytypeClient {
    base;
    headers;
    participantId;
    localReactions = new Set();
    writeTail = Promise.resolve();
    constructor(base, headers, participantId) {
        this.base = base;
        this.headers = headers;
        this.participantId = participantId;
    }
    static async create(config) {
        const apiKey = (await readFile(config.anytype.apiKeyFile, "utf8")).trim();
        if (!apiKey)
            throw new Error(`Anytype API key file is empty: ${config.anytype.apiKeyFile}`);
        return new AnytypeClient(config.anytype.apiBase.replace(/\/$/, ""), { Authorization: `Bearer ${apiKey}`, "Anytype-Version": config.anytype.apiVersion }, config.agent.participantId);
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
                const signal = timeout && init.signal ? AbortSignal.any([timeout, init.signal]) : timeout ?? init.signal;
                const response = await fetch(`${this.base}${path}`, { ...init, ...(signal ? { signal } : {}), headers: { ...this.headers, "Content-Type": "application/json", ...init.headers } });
                if (response.ok)
                    return response;
                const retryable = response.status === 429 || (method === "GET" && response.status >= 500);
                const retryAfter = response.status === 429 ? retryAfterMs(response.headers.get("retry-after")) : undefined;
                const body = (await response.text()).slice(0, 1000);
                const error = new Error(`Anytype ${method} ${path} failed (${response.status}): ${body}`);
                if (attempt + 1 >= attempts || !retryable)
                    throw error;
                lastError = error;
                await new Promise(resolve => setTimeout(resolve, retryAfter ?? 250 * 2 ** attempt));
                continue;
            }
            catch (error) {
                lastError = error;
                if (attempt + 1 >= attempts || init.signal?.aborted || method !== "GET")
                    throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
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
        return chats.map(chat => ({ id: chat.id, name: chat.name ?? chat.id }));
    }
    async getMessage(spaceId, chatId, messageId) {
        const json = await (await this.request(this.messagePath(spaceId, chatId, messageId))).json();
        return json.message;
    }
    async listMessages(spaceId, chatId, limit, afterOrderId) {
        const query = new URLSearchParams({ limit: String(limit), ...(afterOrderId ? { after_order_id: afterOrderId } : {}) });
        const json = await (await this.request(`${this.messagesPath(spaceId, chatId)}?${query}`)).json();
        return json.messages ?? [];
    }
    async sendMessage(spaceId, chatId, input) {
        const body = { text: input.text, style: "paragraph" };
        if (input.replyTo)
            body.reply_to_message_id = input.replyTo;
        if (input.marks?.length)
            body.marks = input.marks;
        const json = await (await this.request(this.messagesPath(spaceId, chatId), { method: "POST", body: JSON.stringify(body) })).json();
        if (!json.message_id)
            throw new Error("Anytype returned no message_id");
        return json.message_id;
    }
    async editMessage(spaceId, chatId, messageId, text, marks) {
        await this.request(this.messagePath(spaceId, chatId, messageId), { method: "PATCH", body: JSON.stringify({ text, style: "paragraph", ...(marks?.length ? { marks } : {}) }) });
    }
    async deleteMessage(spaceId, chatId, messageId) {
        await this.request(this.messagePath(spaceId, chatId, messageId), { method: "DELETE" });
    }
    async ensureReaction(spaceId, chatId, messageId, emoji, present) {
        const message = await this.getMessage(spaceId, chatId, messageId);
        const reactors = message.reactions?.[emoji] ?? [];
        const key = `${spaceId}:${chatId}:${messageId}:${emoji}`;
        const remoteMatch = this.participantId ? reactors.some(reactor => sameIdentity(reactor, this.participantId)) : false;
        const already = remoteMatch || this.localReactions.has(key);
        if (already === present)
            return;
        await this.request(`${this.messagePath(spaceId, chatId, messageId)}/reactions`, { method: "POST", body: JSON.stringify({ emoji }) });
        if (present)
            this.localReactions.add(key);
        else
            this.localReactions.delete(key);
    }
    async *stream(spaceId, chatId, signal) {
        const response = await this.request(`${this.messagesPath(spaceId, chatId)}/stream?limit=50`, { headers: { Accept: "text/event-stream", "Anytype-Heartbeat-Seconds": "15" }, signal });
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
        const json = await (await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`)).json();
        const object = json.object ?? json;
        return { id: object.id ?? objectId, ...(object.name ? { name: object.name } : {}), ...(object.markdown ? { markdown: object.markdown } : {}) };
    }
    async searchObjects(spaceId, offset, limit) {
        const json = await (await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/search?offset=${offset}&limit=${limit}`, { method: "POST", body: JSON.stringify({ query: "" }) })).json();
        return (json.data ?? []).map((item) => ({ id: item.id, ...(item.name ? { name: item.name } : {}), ...(item.type?.key ? { type: item.type.key } : item.type ? { type: String(item.type) } : {}) }));
    }
    messagesPath(spaceId, chatId) { return `/v1/spaces/${encodeURIComponent(spaceId)}/chats/${encodeURIComponent(chatId)}/messages`; }
    messagePath(spaceId, chatId, messageId) { return `${this.messagesPath(spaceId, chatId)}/${encodeURIComponent(messageId)}`; }
    async listPages(path) {
        const items = [];
        const seen = new Set();
        for (let offset = 0, pageNumber = 0; pageNumber < 100; pageNumber += 1) {
            const separator = path.includes("?") ? "&" : "?";
            const json = await (await this.request(`${path}${separator}offset=${offset}&limit=100`)).json();
            if (!Array.isArray(json.data))
                throw new Error(`Anytype ${path} returned an invalid list payload`);
            const page = json.data.filter(item => typeof item?.id === "string" && !seen.has(item.id));
            for (const item of page) {
                seen.add(item.id);
                items.push(item);
            }
            if (!page.length)
                break;
            offset += page.length;
        }
        return items;
    }
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
    const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Anytype event stream idle for ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs); });
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
    const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data)
        return undefined;
    const value = JSON.parse(data);
    if (!value || typeof value !== "object" || typeof value.type !== "string")
        throw new Error("Anytype event stream returned an invalid event envelope");
    return value;
}
function sameIdentity(left, right) {
    if (left === right || left.endsWith(`_${right}`) || right.endsWith(`_${left}`))
        return true;
    return left.split("_").at(-1) === right.split("_").at(-1);
}

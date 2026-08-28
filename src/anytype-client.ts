import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentConfig } from "./config.js";
import type { AnytypeEvent, AnytypePort, ChatMessage, TextMark } from "./types.js";

type JsonRecord = Record<string, any>;

export class AnytypeClient implements AnytypePort {
  private readonly localReactions = new Set<string>();
  private readonly reactionTails = new Map<string, Promise<void>>();
  private writeTail: Promise<unknown> = Promise.resolve();
  private constructor(
    private readonly base: string,
    private readonly headers: Record<string, string>,
    private readonly participantId?: string,
  ) {}

  static async create(config: AgentConfig): Promise<AnytypeClient> {
    const apiKey = (await readFile(config.anytype.apiKeyFile, "utf8")).trim();
    if (!apiKey) throw new Error(`Anytype API key file is empty: ${config.anytype.apiKeyFile}`);
    return new AnytypeClient(
      config.anytype.apiBase.replace(/\/$/, ""),
      { Authorization: `Bearer ${apiKey}`, "Anytype-Version": config.anytype.apiVersion },
      config.agent.participantId,
    );
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? "GET";
    const streaming = new Headers(init.headers).get("Accept") === "text/event-stream";
    if (method !== "GET" && !streaming) {
      const write = this.writeTail.then(() => this.requestWithRetry(path, init, method, streaming));
      this.writeTail = write.catch(() => undefined);
      return write;
    }
    return this.requestWithRetry(path, init, method, streaming);
  }

  private async requestWithRetry(
    path: string,
    init: RequestInit,
    method: string,
    streaming: boolean,
  ): Promise<Response> {
    const attempts = method === "GET" && !streaming ? 3 : method !== "GET" ? 4 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const timeout = streaming ? undefined : AbortSignal.timeout(15_000);
        const signal =
          timeout && init.signal
            ? AbortSignal.any([timeout, init.signal])
            : (timeout ?? init.signal);
        const contentHeaders =
          init.body instanceof FormData ? {} : { "Content-Type": "application/json" };
        const response = await fetch(`${this.base}${path}`, {
          ...init,
          ...(signal ? { signal } : {}),
          headers: { ...this.headers, ...contentHeaders, ...init.headers },
        });
        if (response.ok) return response;
        const retryable = response.status === 429 || (method === "GET" && response.status >= 500);
        const retryAfter =
          response.status === 429 ? retryAfterMs(response.headers.get("retry-after")) : undefined;
        const body = (await response.text()).slice(0, 1000);
        const error = new Error(`Anytype ${method} ${path} failed (${response.status}): ${body}`);
        if (attempt + 1 >= attempts || !retryable) throw error;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, retryAfter ?? 250 * 2 ** attempt));
        continue;
      } catch (error) {
        lastError = error;
        if (attempt + 1 >= attempts || init.signal?.aborted || method !== "GET") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
    throw lastError;
  }

  async resolveSpace(selector: {
    id?: string;
    name?: string;
  }): Promise<{ id: string; name: string }> {
    const spaces = await this.listPages("/v1/spaces");
    const matches = spaces.filter((space: JsonRecord) =>
      selector.id ? space.id === selector.id : space.name === selector.name,
    );
    if (matches.length !== 1)
      throw new Error(
        `Expected one Anytype space matching ${selector.id ?? JSON.stringify(selector.name)}, found ${matches.length}`,
      );
    const match = matches[0]!;
    return { id: match.id, name: match.name ?? match.id };
  }

  async resolveChat(
    spaceId: string,
    selector: { id?: string; name?: string },
  ): Promise<{ id: string; name: string }> {
    const chats = await this.listChats(spaceId);
    const matches = chats.filter((chat: JsonRecord) =>
      selector.id ? chat.id === selector.id : chat.name === selector.name,
    );
    if (matches.length !== 1)
      throw new Error(
        `Expected one Anytype chat matching ${selector.id ?? JSON.stringify(selector.name)}, found ${matches.length}`,
      );
    const match = matches[0]!;
    return { id: match.id, name: match.name ?? match.id };
  }

  async listChats(spaceId: string): Promise<Array<{ id: string; name: string }>> {
    const chats = await this.listPages(`/v1/spaces/${encodeURIComponent(spaceId)}/chats`);
    return chats.map((chat) => ({ id: chat.id, name: chat.name ?? chat.id }));
  }

  async getMessage(spaceId: string, chatId: string, messageId: string): Promise<ChatMessage> {
    const json = (await (
      await this.request(this.messagePath(spaceId, chatId, messageId))
    ).json()) as { message: ChatMessage };
    return json.message;
  }

  async listMessages(
    spaceId: string,
    chatId: string,
    limit: number,
    afterOrderId?: string,
  ): Promise<ChatMessage[]> {
    const query = new URLSearchParams({
      limit: String(limit),
      ...(afterOrderId ? { after_order_id: afterOrderId } : {}),
    });
    const json = (await (
      await this.request(`${this.messagesPath(spaceId, chatId)}?${query}`)
    ).json()) as { messages?: ChatMessage[] };
    return json.messages ?? [];
  }

  async sendMessage(
    spaceId: string,
    chatId: string,
    input: { text: string; replyTo?: string; marks?: TextMark[] },
  ): Promise<string> {
    const body: JsonRecord = { text: input.text, style: "paragraph" };
    if (input.replyTo) body.reply_to_message_id = input.replyTo;
    if (input.marks?.length) body.marks = input.marks;
    const json = (await (
      await this.request(this.messagesPath(spaceId, chatId), {
        method: "POST",
        body: JSON.stringify(body),
      })
    ).json()) as { message_id?: string };
    if (!json.message_id) throw new Error("Anytype returned no message_id");
    return json.message_id;
  }

  async editMessage(
    spaceId: string,
    chatId: string,
    messageId: string,
    text: string,
    marks?: TextMark[],
  ): Promise<void> {
    await this.request(this.messagePath(spaceId, chatId, messageId), {
      method: "PATCH",
      body: JSON.stringify({ text, style: "paragraph", ...(marks?.length ? { marks } : {}) }),
    });
  }

  async deleteMessage(spaceId: string, chatId: string, messageId: string): Promise<void> {
    await this.request(this.messagePath(spaceId, chatId, messageId), { method: "DELETE" });
  }

  async ensureReaction(
    spaceId: string,
    chatId: string,
    messageId: string,
    emoji: string,
    present: boolean,
    participantId = this.participantId,
  ): Promise<void> {
    const key = `${spaceId}:${chatId}:${messageId}:${emoji}`;
    const previous = this.reactionTails.get(key) ?? Promise.resolve();
    const current = previous.then(() =>
      this.ensureReactionNow(spaceId, chatId, messageId, emoji, present, participantId),
    );
    const tail = current.catch(() => undefined);
    this.reactionTails.set(key, tail);
    try {
      await current;
    } finally {
      if (this.reactionTails.get(key) === tail) this.reactionTails.delete(key);
    }
  }

  private async ensureReactionNow(
    spaceId: string,
    chatId: string,
    messageId: string,
    emoji: string,
    present: boolean,
    participantId: string | undefined,
  ): Promise<void> {
    const message = await this.getMessage(spaceId, chatId, messageId);
    const reactors = message.reactions?.[emoji] ?? [];
    const key = `${spaceId}:${chatId}:${messageId}:${emoji}`;
    const remoteMatch = participantId
      ? reactors.some((reactor) => sameIdentity(reactor, participantId))
      : false;
    const already = remoteMatch || this.localReactions.has(key);
    if (already === present) return;
    await this.request(`${this.messagePath(spaceId, chatId, messageId)}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji }),
    });
    if (present) this.localReactions.add(key);
    else this.localReactions.delete(key);
  }

  async *stream(spaceId: string, chatId: string, signal: AbortSignal): AsyncIterable<AnytypeEvent> {
    const response = await this.request(`${this.messagesPath(spaceId, chatId)}/stream?limit=50`, {
      headers: { Accept: "text/event-stream", "Anytype-Heartbeat-Seconds": "15" },
      signal,
    });
    if (!response.body) throw new Error("Anytype event stream had no body");
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await readWithIdleTimeout(reader, signal, 45_000);
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseBlock(block);
          if (event) yield event;
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async getObject(spaceId: string, objectId: string): Promise<JsonRecord & { id: string }> {
    const json = (await (
      await this.request(
        `/v1/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`,
      )
    ).json()) as JsonRecord;
    const object = json.object ?? json;
    return { ...object, id: object.id ?? objectId };
  }

  async listTypes(spaceId: string): Promise<JsonRecord[]> {
    return this.listPages(`/v1/spaces/${encodeURIComponent(spaceId)}/types`);
  }

  async getType(spaceId: string, typeId: string): Promise<JsonRecord> {
    const json = (await (
      await this.request(
        `/v1/spaces/${encodeURIComponent(spaceId)}/types/${encodeURIComponent(typeId)}`,
      )
    ).json()) as JsonRecord;
    return json.type ?? json;
  }

  async listProperties(spaceId: string): Promise<JsonRecord[]> {
    return this.listPages(`/v1/spaces/${encodeURIComponent(spaceId)}/properties`);
  }

  async getProperty(spaceId: string, propertyId: string): Promise<JsonRecord> {
    const json = (await (
      await this.request(
        `/v1/spaces/${encodeURIComponent(spaceId)}/properties/${encodeURIComponent(propertyId)}`,
      )
    ).json()) as JsonRecord;
    return json.property ?? json;
  }

  async listPropertyTags(spaceId: string, propertyId: string): Promise<JsonRecord[]> {
    return this.listPages(
      `/v1/spaces/${encodeURIComponent(spaceId)}/properties/${encodeURIComponent(propertyId)}/tags`,
    );
  }

  async listTemplates(spaceId: string, typeId: string): Promise<JsonRecord[]> {
    return this.listPages(
      `/v1/spaces/${encodeURIComponent(spaceId)}/types/${encodeURIComponent(typeId)}/templates`,
    );
  }

  async searchObjects(
    spaceId: string,
    offset: number,
    limit: number,
  ): Promise<Array<{ id: string; name?: string; type?: string }>> {
    const json = (await (
      await this.request(
        `/v1/spaces/${encodeURIComponent(spaceId)}/search?offset=${offset}&limit=${limit}`,
        { method: "POST", body: JSON.stringify({ query: "" }) },
      )
    ).json()) as JsonRecord;
    return (json.data ?? []).map((item: JsonRecord) => ({
      id: item.id,
      ...(item.name ? { name: item.name } : {}),
      ...(item.type?.key ? { type: item.type.key } : item.type ? { type: String(item.type) } : {}),
    }));
  }

  async searchSpace(
    spaceId: string,
    input: { query?: string; types?: string[]; offset?: number; limit?: number },
  ): Promise<JsonRecord[]> {
    const query = new URLSearchParams({
      offset: String(input.offset ?? 0),
      limit: String(input.limit ?? 100),
    });
    const json = (await (
      await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/search?${query}`, {
        method: "POST",
        body: JSON.stringify({
          query: input.query ?? "",
          ...(input.types?.length ? { types: input.types } : {}),
        }),
      })
    ).json()) as JsonRecord;
    return Array.isArray(json.data) ? json.data : [];
  }

  async createObject(
    spaceId: string,
    input: {
      type_key: string;
      name?: string;
      body?: string;
      template_id?: string;
      properties?: JsonRecord[];
      icon?: JsonRecord;
    },
  ): Promise<JsonRecord> {
    const json = (await (
      await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/objects`, {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).json()) as JsonRecord;
    return json.object ?? json;
  }

  async updateObject(
    spaceId: string,
    objectId: string,
    input: {
      type_key?: string;
      name?: string;
      markdown?: string;
      properties?: JsonRecord[];
      icon?: JsonRecord;
    },
  ): Promise<JsonRecord> {
    const json = (await (
      await this.request(
        `/v1/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      )
    ).json()) as JsonRecord;
    return json.object ?? json;
  }

  async archiveObject(spaceId: string, objectId: string): Promise<JsonRecord> {
    const json = (await (
      await this.request(
        `/v1/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`,
        { method: "DELETE" },
      )
    ).json()) as JsonRecord;
    return json.object ?? json;
  }

  async addObjectsToList(spaceId: string, listId: string, objectIds: string[]): Promise<void> {
    await this.request(
      `/v1/spaces/${encodeURIComponent(spaceId)}/lists/${encodeURIComponent(listId)}/objects`,
      { method: "POST", body: JSON.stringify({ objects: objectIds }) },
    );
  }

  async listViews(spaceId: string, listId: string): Promise<JsonRecord[]> {
    return this.listPages(
      `/v1/spaces/${encodeURIComponent(spaceId)}/lists/${encodeURIComponent(listId)}/views`,
    );
  }

  async listViewObjects(
    spaceId: string,
    listId: string,
    viewId: string,
    page: { offset: number; limit: number } = { offset: 0, limit: 50 },
  ): Promise<JsonRecord[]> {
    const path = `/v1/spaces/${encodeURIComponent(spaceId)}/lists/${encodeURIComponent(listId)}/views/${encodeURIComponent(viewId)}/objects?offset=${page.offset}&limit=${page.limit}`;
    const json = (await (await this.request(path)).json()) as JsonRecord;
    if (!Array.isArray(json.data))
      throw new Error(`Anytype ${path} returned an invalid list payload`);
    return json.data as JsonRecord[];
  }

  async removeObjectFromList(spaceId: string, listId: string, objectId: string): Promise<void> {
    await this.request(
      `/v1/spaces/${encodeURIComponent(spaceId)}/lists/${encodeURIComponent(listId)}/objects/${encodeURIComponent(objectId)}`,
      { method: "DELETE" },
    );
  }

  async uploadFile(spaceId: string, path: string): Promise<JsonRecord> {
    const form = new FormData();
    form.append("file", await openAsBlob(path), basename(path));
    return (await (
      await this.request(`/v1/spaces/${encodeURIComponent(spaceId)}/files`, {
        method: "POST",
        body: form,
      })
    ).json()) as JsonRecord;
  }

  private messagesPath(spaceId: string, chatId: string): string {
    return `/v1/spaces/${encodeURIComponent(spaceId)}/chats/${encodeURIComponent(chatId)}/messages`;
  }
  private messagePath(spaceId: string, chatId: string, messageId: string): string {
    return `${this.messagesPath(spaceId, chatId)}/${encodeURIComponent(messageId)}`;
  }

  private async listPages(path: string): Promise<JsonRecord[]> {
    const items: JsonRecord[] = [];
    const seen = new Set<string>();
    for (let offset = 0, pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const json = (await (
        await this.request(`${path}${separator}offset=${offset}&limit=100`)
      ).json()) as JsonRecord;
      if (!Array.isArray(json.data))
        throw new Error(`Anytype ${path} returned an invalid list payload`);
      const rawPage = json.data as JsonRecord[];
      if (!rawPage.length) break;
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

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 30_000) : undefined;
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`Anytype event stream idle for ${Math.round(timeoutMs / 1000)} seconds`)),
      timeoutMs,
    );
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new Error("Anytype event stream aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export function parseSseBlock(block: string): AnytypeEvent | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return undefined;
  const value = JSON.parse(data) as unknown;
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string")
    throw new Error("Anytype event stream returned an invalid event envelope");
  return value as AnytypeEvent;
}

function sameIdentity(left: string, right: string): boolean {
  if (left === right || left.endsWith(`_${right}`) || right.endsWith(`_${left}`)) return true;
  return left.split("_").at(-1) === right.split("_").at(-1);
}

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  BridgeBindingSchema,
  BridgeInboundSchema,
  type BridgeDelivery,
  type BridgeInbound,
} from "./protocol.js";
import { BridgeStore } from "./store.js";

const MAX_BODY_BYTES = 1_048_576;

export type BridgeServerOptions = {
  host: string;
  port: number;
  token: string;
  store: BridgeStore;
  onInbound: (message: BridgeInbound) => Promise<void>;
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
};

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  const prefix = "Bearer ";
  if (!actual?.startsWith(prefix)) return false;
  const provided = Buffer.from(actual.slice(prefix.length));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class BridgeServer {
  readonly #options: BridgeServerOptions;
  #server: Server | undefined;
  #draining = false;

  constructor(options: BridgeServerOptions) {
    if (!options.token) throw new Error("bridge token must not be empty");
    if (!new Set(["127.0.0.1", "::1", "localhost"]).has(options.host)) {
      throw new Error("Anytype bridge must bind to loopback");
    }
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        this.#options.log?.("error", `bridge request failed: ${String(error)}`);
        if (!response.headersSent) json(response, 500, { error: "internal_error" });
        else response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.#server!;
      server.once("error", reject);
      server.listen(this.#options.port, this.#options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await this.drainInbound();
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  }

  address(): { address: string; port: number } | undefined {
    const value = this.#server?.address();
    if (!value || typeof value === "string") return undefined;
    return { address: value.address, port: value.port };
  }

  async drainInbound(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        const batch = this.#options.store.pendingInbound();
        if (batch.length === 0) return;
        for (const message of batch) {
          try {
            await this.#options.onInbound(message);
            this.#options.store.markInbound(message.id, "delivered");
          } catch (error) {
            this.#options.store.markInbound(message.id, "failed", String(error));
            this.#options.log?.("error", `inbound ${message.id} failed: ${String(error)}`);
          }
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { ok: true });
      return;
    }
    if (!tokenMatches(request.headers.authorization, this.#options.token)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/inbound") {
      const inbound = BridgeInboundSchema.parse(await readJson(request));
      const inserted = this.#options.store.putInbound(inbound);
      json(response, inserted ? 202 : 200, { id: inbound.id, accepted: inserted });
      if (inserted) queueMicrotask(() => void this.drainInbound());
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/bindings") {
      const binding = BridgeBindingSchema.parse(await readJson(request));
      this.#options.store.bindSession(binding.sessionKey, binding.accountId, binding.route);
      json(response, 200, { ok: true, sessionKey: binding.sessionKey });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/owned-runs") {
      const body = (await readJson(request)) as { runId?: unknown };
      if (typeof body.runId !== "string" || !body.runId || body.runId.length > 512) {
        json(response, 400, { error: "runId must be a non-empty string" });
        return;
      }
      this.#options.store.markOwnedRun(body.runId);
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/inbound/")) {
      const id = safeDecode(url.pathname.slice("/v1/inbound/".length));
      if (id === undefined) {
        json(response, 400, { error: "invalid_id" });
        return;
      }
      const status = this.#options.store.inboundStatus(id);
      json(response, status ? 200 : 404, status ?? { error: "not_found" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/outbox") {
      const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(1_000, Math.max(1, Math.trunc(requestedLimit)))
        : 50;
      const sessionKey = url.searchParams.get("sessionKey");
      const spaceId = url.searchParams.get("spaceId");
      const chatId = url.searchParams.get("chatId");
      const discussionRootId = url.searchParams.get("discussionRootId");
      const afterSequenceValue = Number(url.searchParams.get("afterSequence") ?? 0);
      const afterSequence =
        Number.isSafeInteger(afterSequenceValue) && afterSequenceValue >= 0
          ? afterSequenceValue
          : 0;
      const deliveries =
        sessionKey && spaceId && chatId
          ? this.#options.store.pendingDeliveriesFor(
              {
                sessionKey,
                route: { spaceId, chatId, ...(discussionRootId ? { discussionRootId } : {}) },
              },
              Date.now(),
              limit,
              afterSequence,
            )
          : this.#options.store.pendingDeliveries(Date.now(), limit, afterSequence);
      json(response, 200, { deliveries });
      return;
    }
    const ack = /^\/v1\/outbox\/([^/]+)\/ack$/u.exec(url.pathname);
    if (request.method === "POST" && ack?.[1]) {
      const id = safeDecode(ack[1]);
      if (id === undefined) {
        json(response, 400, { error: "invalid_id" });
        return;
      }
      this.#options.store.acknowledgeDelivery(id);
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/outbox/ack") {
      const body = (await readJson(request)) as { ids?: unknown };
      if (
        !Array.isArray(body.ids) ||
        body.ids.length === 0 ||
        body.ids.some((id) => typeof id !== "string" || !id)
      ) {
        json(response, 400, { error: "ids must be a non-empty string array" });
        return;
      }
      this.#options.store.acknowledgeDeliveries(body.ids);
      json(response, 200, { ok: true, count: body.ids.length });
      return;
    }
    json(response, 404, { error: "not_found" });
  }
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export type DeliveryWorkerOptions = {
  store: BridgeStore;
  endpoint?: string;
  token: string;
  intervalMs?: number;
  fetch?: typeof fetch;
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
};

export class DeliveryWorker {
  readonly #options: DeliveryWorkerOptions;
  #timer: NodeJS.Timeout | undefined;
  #flushing = false;

  constructor(options: DeliveryWorkerOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer || !this.#options.endpoint) return;
    const interval = Math.max(100, this.#options.intervalMs ?? 1_000);
    this.#timer = setInterval(() => void this.flush(), interval);
    this.#timer.unref?.();
    void this.flush();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async flush(): Promise<void> {
    if (this.#flushing || !this.#options.endpoint) return;
    this.#flushing = true;
    try {
      const send = this.#options.fetch ?? fetch;
      for (const delivery of this.#options.store.pendingDeliveries()) {
        try {
          const response = await send(this.#options.endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.#options.token}`,
              "content-type": "application/json",
              "idempotency-key": delivery.idempotencyKey,
            },
            body: JSON.stringify(delivery),
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) throw new Error(`Knot returned HTTP ${response.status}`);
          this.#options.store.acknowledgeDelivery(delivery.id);
        } catch (error) {
          this.#options.store.retryDelivery(delivery.id, String(error));
          this.#options.log?.("warn", `delivery ${delivery.id} deferred: ${String(error)}`);
        }
      }
    } finally {
      this.#flushing = false;
    }
  }
}

export function createDelivery(
  value: Omit<BridgeDelivery, "id" | "idempotencyKey" | "createdAt"> & {
    sourceKey: string;
    createdAt?: number;
  },
): BridgeDelivery {
  const { sourceKey, ...delivery } = value;
  const idempotencyKey = createHash("sha256").update(sourceKey).digest("hex");
  return {
    ...delivery,
    id: randomUUID(),
    idempotencyKey,
    createdAt: value.createdAt ?? Date.now(),
  };
}

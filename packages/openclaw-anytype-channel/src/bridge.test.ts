import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeServer, DeliveryWorker, createDelivery } from "./bridge.js";
import { BridgeStore } from "./store.js";

const servers: BridgeServer[] = [];
const stores: BridgeStore[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const store of stores.splice(0)) store.close();
});

function makeStore(): BridgeStore {
  const store = new BridgeStore(":memory:");
  stores.push(store);
  return store;
}

describe("BridgeServer", () => {
  it("requires bearer authentication, deduplicates ingress, and reports status", async () => {
    const delivered: string[] = [];
    const store = makeStore();
    const server = new BridgeServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token-that-is-long-enough",
      store,
      onInbound: async (message) => void delivered.push(message.id),
    });
    servers.push(server);
    await server.start();
    const address = server.address()!;
    const url = `http://127.0.0.1:${address.port}`;
    const body = {
      id: "inbound-1",
      accountId: "default",
      route: { spaceId: "space", chatId: "chat" },
      message: { id: "message", senderId: "owner", text: "hello" },
    };

    expect((await fetch(`${url}/v1/inbound`, { method: "POST" })).status).toBe(401);
    const first = await fetch(`${url}/v1/inbound`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token-that-is-long-enough",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(202);
    await vi.waitFor(() => expect(delivered).toEqual(["inbound-1"]));

    const duplicate = await fetch(`${url}/v1/inbound`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token-that-is-long-enough",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(duplicate.status).toBe(200);
    expect(delivered).toEqual(["inbound-1"]);

    const status = await fetch(`${url}/v1/inbound/inbound-1`, {
      headers: { authorization: "Bearer test-token-that-is-long-enough" },
    });
    expect(await status.json()).toEqual({ status: "delivered" });
  });

  it("exposes durable pull and explicit acknowledgement for AAG recovery", async () => {
    const store = makeStore();
    const delivery = createDelivery({
      sourceKey: "event:one",
      accountId: "default",
      route: { spaceId: "space", chatId: "chat" },
      kind: "message-final",
      message: { text: "done" },
    });
    store.putDelivery(delivery);
    const server = new BridgeServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token-that-is-long-enough",
      store,
      onInbound: async () => undefined,
    });
    servers.push(server);
    await server.start();
    const url = `http://127.0.0.1:${server.address()!.port}`;
    const headers = { authorization: "Bearer test-token-that-is-long-enough" };
    const response = await fetch(`${url}/v1/outbox`, { headers });
    const body = (await response.json()) as { deliveries: Array<{ id: string }> };
    expect(body.deliveries.map((item) => item.id)).toEqual([delivery.id]);
    await fetch(`${url}/v1/outbox/${encodeURIComponent(delivery.id)}/ack`, {
      method: "POST",
      headers,
    });
    expect(store.pendingDeliveries()).toEqual([]);
  });

  it("filters pull recovery by either the bound session or the exact Anytype route", async () => {
    const store = makeStore();
    const matchingRoute = createDelivery({ sourceKey: "route", accountId: "default", route: { spaceId: "space", chatId: "chat" }, kind: "message-final", message: { text: "scheduled" } });
    const matchingSession = createDelivery({ sourceKey: "session", accountId: "default", sessionKey: "native", route: { spaceId: "other", chatId: "other" }, kind: "agent-event", agentEvent: { runId: "run", seq: 1, stream: "lifecycle", timestamp: 1, data: { phase: "completed" } } });
    const unrelated = createDelivery({ sourceKey: "unrelated", accountId: "default", route: { spaceId: "elsewhere", chatId: "elsewhere" }, kind: "message-final", message: { text: "no" } });
    store.putDelivery(matchingRoute);
    store.putDelivery(matchingSession);
    store.putDelivery(unrelated);
    const server = new BridgeServer({ host: "127.0.0.1", port: 0, token: "test-token-that-is-long-enough", store, onInbound: async () => undefined });
    servers.push(server);
    await server.start();
    const query = new URLSearchParams({ sessionKey: "native", spaceId: "space", chatId: "chat" });
    const response = await fetch(`http://127.0.0.1:${server.address()!.port}/v1/outbox?${query}`, { headers: { authorization: "Bearer test-token-that-is-long-enough" } });
    const body = await response.json() as { deliveries: Array<{ id: string }> };
    expect(body.deliveries.map(delivery => delivery.id).sort()).toEqual([matchingRoute.id, matchingSession.id].sort());
  });

  it("acknowledges a completed run's event records atomically", async () => {
    const store = makeStore();
    const first = createDelivery({ sourceKey: "batch-1", accountId: "default", route: { spaceId: "space", chatId: "chat" }, kind: "agent-event", agentEvent: { runId: "run", seq: 1, stream: "assistant", timestamp: 1, data: { delta: "hello" } } });
    const terminal = createDelivery({ sourceKey: "batch-2", accountId: "default", route: { spaceId: "space", chatId: "chat" }, kind: "agent-event", agentEvent: { runId: "run", seq: 2, stream: "lifecycle", timestamp: 2, data: { phase: "completed" } } });
    store.putDelivery(first);
    store.putDelivery(terminal);
    const server = new BridgeServer({ host: "127.0.0.1", port: 0, token: "test-token-that-is-long-enough", store, onInbound: async () => undefined });
    servers.push(server);
    await server.start();
    const response = await fetch(`http://127.0.0.1:${server.address()!.port}/v1/outbox/ack`, {
      method: "POST",
      headers: { authorization: "Bearer test-token-that-is-long-enough", "content-type": "application/json" },
      body: JSON.stringify({ ids: [first.id, terminal.id] }),
    });
    expect(response.status).toBe(200);
    expect(store.pendingDeliveries()).toEqual([]);
  });

  it("accepts an authenticated operator-session binding before the first channel ingress", async () => {
    const store = makeStore();
    const server = new BridgeServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token-that-is-long-enough",
      store,
      onInbound: async () => undefined,
    });
    servers.push(server);
    await server.start();
    const response = await fetch(`http://127.0.0.1:${server.address()!.port}/v1/bindings`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token-that-is-long-enough",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        accountId: "default",
        sessionKey: "aag:discussion:one",
        route: { spaceId: "space", chatId: "discussion", discussionRootId: "root" },
      }),
    });
    expect(response.status).toBe(200);
    expect(store.bindingForSession("aag:discussion:one")).toEqual({
      accountId: "default",
      route: { spaceId: "space", chatId: "discussion", discussionRootId: "root" },
    });
  });

  it("persists owned run registration across AAG restarts", async () => {
    const store = makeStore();
    const server = new BridgeServer({ host: "127.0.0.1", port: 0, token: "test-token-that-is-long-enough", store, onInbound: async () => undefined });
    servers.push(server);
    await server.start();
    const response = await fetch(`http://127.0.0.1:${server.address()!.port}/v1/owned-runs`, {
      method: "POST",
      headers: { authorization: "Bearer test-token-that-is-long-enough", "content-type": "application/json" },
      body: JSON.stringify({ runId: "owned-run" }),
    });
    expect(response.status).toBe(200);
    expect(store.isOwnedRun("owned-run")).toBe(true);
  });
});

describe("DeliveryWorker", () => {
  it("keeps failed deliveries and acknowledges successful retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = makeStore();
    const delivery = createDelivery({
      sourceKey: "retry-event",
      accountId: "default",
      route: { spaceId: "space", chatId: "chat" },
      kind: "message-final",
      message: { text: "done" },
    });
    store.putDelivery(delivery, 0);
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const worker = new DeliveryWorker({
      store,
      endpoint: "http://127.0.0.1:1/v1/openclaw/deliveries",
      token: "secret",
      fetch: send,
    });
    await worker.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.pendingDeliveries(1_500)).toHaveLength(1);
    vi.setSystemTime(2_000);
    await worker.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.pendingDeliveries(Date.now() + 60_000)).toEqual([]);
  });
});

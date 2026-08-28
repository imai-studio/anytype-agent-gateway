import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDelivery } from "./bridge.js";
import type { BridgeInbound } from "./protocol.js";
import { BridgeStore } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): BridgeStore {
  const dir = mkdtempSync(join(tmpdir(), "aag-anytype-channel-"));
  dirs.push(dir);
  return new BridgeStore(join(dir, "bridge.sqlite"));
}

const inbound: BridgeInbound = {
  id: "in-1",
  accountId: "default",
  route: { spaceId: "s", chatId: "c", discussionRootId: "r" },
  message: { id: "m", senderId: "owner", text: "hello", wasMentioned: true },
};

describe("BridgeStore", () => {
  it("deduplicates inbound events and tracks delivery status", () => {
    const store = makeStore();
    expect(store.putInbound(inbound, 10)).toBe(true);
    expect(store.putInbound(inbound, 11)).toBe(false);
    expect(store.pendingInbound()).toEqual([inbound]);
    store.markInbound(inbound.id, "delivered", undefined, 12);
    expect(store.pendingInbound()).toEqual([]);
    expect(store.inboundStatus(inbound.id)).toEqual({ status: "delivered" });
    store.close();
  });

  it("allows AAG to replay an ingress event after a failed dispatch", () => {
    const store = makeStore();
    store.putInbound(inbound, 10);
    store.markInbound(inbound.id, "failed", "temporary", 11);
    expect(store.putInbound(inbound, 12)).toBe(true);
    expect(store.pendingInbound()).toEqual([inbound]);
    store.close();
  });

  it("persists the exact native session to Anytype route binding", () => {
    const store = makeStore();
    store.bindSession("agent:anya:anytype:channel:opaque:thread:r", "anya", inbound.route);
    expect(store.bindingForSession("agent:anya:anytype:channel:opaque:thread:r")).toEqual({
      accountId: "anya",
      route: inbound.route,
    });
    store.close();
  });

  it("deduplicates outbound source events and applies bounded retry", () => {
    const store = makeStore();
    const delivery = createDelivery({
      sourceKey: "run:1:seq:9",
      accountId: "default",
      route: inbound.route,
      kind: "message-final",
      message: { text: "done" },
      createdAt: 100,
    });
    expect(store.putDelivery(delivery, 100)).toBe(true);
    expect(store.putDelivery({ ...delivery, id: "another-id" }, 100)).toBe(false);
    expect(store.pendingDeliveries(100)).toHaveLength(1);
    store.retryDelivery(delivery.id, "offline", 100);
    expect(store.pendingDeliveries(599)).toHaveLength(0);
    expect(store.pendingDeliveries(600)[0]).toMatchObject({ attempts: 1, lastError: "offline" });
    store.acknowledgeDelivery(delivery.id, 700);
    expect(store.pendingDeliveries(1_000)).toHaveLength(0);
    store.close();
  });

  it("paginates pending records by the durable SQLite insertion sequence", () => {
    const store = makeStore();
    for (let index = 0; index < 1_001; index += 1) {
      store.putDelivery(createDelivery({ sourceKey: `page:${index}`, accountId: "default", route: inbound.route, kind: "message-final", message: { text: String(index) }, createdAt: 100 }), 100);
    }
    const first = store.pendingDeliveries(100, 1_000);
    const second = store.pendingDeliveries(100, 1_000, first.at(-1)!.storeSequence);
    expect(first).toHaveLength(1_000);
    expect(second).toHaveLength(1);
    expect(second[0]!.storeSequence).toBeGreaterThan(first.at(-1)!.storeSequence);
    store.close();
  });
});

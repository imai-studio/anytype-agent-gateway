import { describe, expect, it } from "vitest";
import { decodeRouteTarget, encodeRouteTarget, routeKey } from "./protocol.js";

describe("Anytype route target", () => {
  it("round-trips opaque Anytype ids without delimiter assumptions", () => {
    const route = { spaceId: "space:/with unicode/α", chatId: "chat:one/two" };
    expect(decodeRouteTarget(encodeRouteTarget(route))).toEqual(route);
  });

  it("keeps discussions distinct from their parent chat", () => {
    const chat = { spaceId: "space", chatId: "chat" };
    expect(routeKey(chat)).not.toBe(routeKey({ ...chat, discussionRootId: "root" }));
  });

  it("rejects arbitrary targets", () => {
    expect(() => decodeRouteTarget("room:123")).toThrow(/Invalid Anytype target/u);
  });
});

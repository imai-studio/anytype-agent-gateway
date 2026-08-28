import { describe, expect, it } from "vitest";
import { decodeRouteTarget, encodeRouteTarget, resolveTargetRoute, routeKey } from "./protocol.js";

describe("Anytype route target", () => {
  it("round-trips opaque Anytype ids without delimiter assumptions", () => {
    const route = { spaceId: "space:/with unicode/α", chatId: "chat:one/two" };
    expect(decodeRouteTarget(encodeRouteTarget(route))).toEqual(route);
  });

  it("keeps discussions distinct from their parent chat", () => {
    const chat = { spaceId: "space", chatId: "chat" };
    expect(routeKey(chat)).not.toBe(routeKey({ ...chat, discussionRootId: "root" }));
    expect(encodeRouteTarget({ ...chat, discussionRootId: "root-a" })).not.toBe(
      encodeRouteTarget({ ...chat, discussionRootId: "root-b" }),
    );
    expect(decodeRouteTarget(encodeRouteTarget({ ...chat, discussionRootId: "root-a" }))).toEqual({
      ...chat,
      discussionRootId: "root-a",
    });
  });

  it("decodes legacy two-field targets and lets explicit thread context override a root", () => {
    const legacy = `route:${Buffer.from(JSON.stringify(["space", "chat"])).toString("base64url")}`;
    expect(decodeRouteTarget(legacy)).toEqual({ spaceId: "space", chatId: "chat" });
    const rooted = encodeRouteTarget({
      spaceId: "space",
      chatId: "chat",
      discussionRootId: "encoded-root",
    });
    expect(resolveTargetRoute(rooted)).toEqual({
      spaceId: "space",
      chatId: "chat",
      discussionRootId: "encoded-root",
    });
    expect(resolveTargetRoute(rooted, "explicit-root")).toEqual({
      spaceId: "space",
      chatId: "chat",
      discussionRootId: "explicit-root",
    });
  });

  it("rejects arbitrary targets", () => {
    expect(() => decodeRouteTarget("room:123")).toThrow(/Invalid Anytype target/u);
  });
});

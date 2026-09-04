import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";

describe("bounded management authority", () => {
  it("keeps publish reusable within a finite budget without broadening other scopes", () => {
    const store = new Store(":memory:");
    try {
      const publish = store.issueManagementCapability("route", "owner", "publish");
      expect(store.consumeManagementCapability(publish, "other", "publish")).toBeUndefined();
      expect(store.consumeManagementCapability(publish, "route", "access")).toBeUndefined();
      for (let index = 0; index < 16; index++)
        expect(store.consumeManagementCapability(publish, "route", "publish")).toBe("owner");
      expect(store.consumeManagementCapability(publish, "route", "publish")).toBeUndefined();
      for (const scope of ["access", "wake", "model"] as const) {
        const token = store.issueManagementCapability("route", "owner", scope);
        expect(store.consumeManagementCapability(token, "route", scope)).toBe("owner");
        expect(store.consumeManagementCapability(token, "route", scope)).toBeUndefined();
      }
    } finally {
      store.close();
    }
  });

  it("expires and prunes capabilities without erasing durable automation state", () => {
    const store = new Store(":memory:");
    const time = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const token = store.issueManagementCapability("route", "owner", "publish", 10);
      time.mockReturnValue(1010);
      expect(store.consumeManagementCapability(token, "route", "publish")).toBeUndefined();
      store.prune(0);
      expect(
        store.db.prepare("SELECT count(*) AS n FROM management_actor_capabilities").get()?.n,
      ).toBe(0);
    } finally {
      time.mockRestore();
      store.close();
    }
  });

  it("separates discussion root lifetimes and model targets", () => {
    const store = new Store(":memory:");
    try {
      const first = store.issueManagementCapability(
        "discussion:s:c",
        "owner",
        "model",
        undefined,
        "discussion:s:c:root:first",
      );
      const second = store.issueManagementCapability(
        "discussion:s:c",
        "owner",
        "model",
        undefined,
        "discussion:s:c:root:second",
      );
      expect(
        store.consumeManagementCapability(
          first,
          "discussion:s:c",
          "model",
          "discussion:s:c:root:second",
        ),
      ).toBeUndefined();
      store.revokeManagementCapabilities("discussion:s:c", "discussion:s:c:root:second");
      expect(store.consumeManagementCapability(second, "discussion:s:c", "model")).toBeUndefined();
      expect(
        store.consumeManagementCapability(
          first,
          "discussion:s:c",
          "model",
          "discussion:s:c:root:first",
        ),
      ).toBe("owner");
    } finally {
      store.close();
    }
  });
});

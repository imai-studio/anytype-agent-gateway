import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  detectServices,
  logNamespace,
  PRODUCT,
  resetCompatibilityWarningsForTests,
  resolveConfigPath,
  resolveHeartBinary,
  resolveProductEnvironment,
  resolveStatePath,
} from "../src/compatibility.js";
import { parseSilenceMarker } from "../src/protocol-markers.js";

describe("Knot compatibility foundation", () => {
  beforeEach(() => resetCompatibilityWarningsForTests());

  it("keeps current public metadata and defaults while recording Knot names", () => {
    expect(PRODUCT.current.executable).toBe("aag");
    expect(PRODUCT.next.executable).toBe("knot");
    expect(resolveConfigPath({ home: "/home/fixture", environment: {} })).toBe(
      "/home/fixture/.config/aag/agent.yaml",
    );
    expect(resolveStatePath({ home: "/home/fixture", environment: {} })).toBe(
      "/home/fixture/.local/state/aag/state.sqlite",
    );
    expect(logNamespace()).toBe("AnytypeAgentGateway");
  });

  it("accepts old-only and warns at most once without revealing values", () => {
    const warn = vi.fn();
    const environment = {
      AAG_OPENCLAW_BRIDGE_TOKEN: "legacy-secret-one",
      AAG_ROUTE_ID: "legacy-secret-two",
    };
    expect(resolveProductEnvironment("OPENCLAW_BRIDGE_TOKEN", { environment, warn })).toBe(
      "legacy-secret-one",
    );
    expect(resolveProductEnvironment("ROUTE_ID", { environment, warn })).toBe("legacy-secret-two");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).not.toContain("legacy-secret");
    expect(warn.mock.calls[0]?.[0]).toContain("KNOT_OPENCLAW_BRIDGE_TOKEN");
  });

  it("accepts new-only and equivalent dual values", () => {
    expect(resolveProductEnvironment("ROUTE_ID", { environment: { KNOT_ROUTE_ID: "route" } })).toBe(
      "route",
    );
    expect(
      resolveProductEnvironment("ROUTE_ID", {
        environment: { KNOT_ROUTE_ID: " route ", AAG_ROUTE_ID: "route" },
      }),
    ).toBe(" route ");
  });

  it("rejects conflicting dual values without revealing either value", () => {
    expect(() =>
      resolveProductEnvironment("OPENCLAW_BRIDGE_TOKEN", {
        environment: {
          KNOT_OPENCLAW_BRIDGE_TOKEN: "new-secret",
          AAG_OPENCLAW_BRIDGE_TOKEN: "old-secret",
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining("new-secret"),
      }),
    );
    try {
      resolveProductEnvironment("OPENCLAW_BRIDGE_TOKEN", {
        environment: {
          KNOT_OPENCLAW_BRIDGE_TOKEN: "new-secret",
          AAG_OPENCLAW_BRIDGE_TOKEN: "old-secret",
        },
      });
    } catch (error) {
      expect(String(error)).not.toContain("old-secret");
    }
  });

  it("gives explicit paths precedence and normalizes equivalent environment paths", () => {
    expect(
      resolveConfigPath({
        explicit: "/operator/agent.yaml",
        environment: { KNOT_CONFIG: "/ignored", AAG_CONFIG: "/ignored" },
      }),
    ).toBe("/operator/agent.yaml");
    expect(
      resolveStatePath({
        home: "/home/fixture",
        environment: {
          KNOT_STATE_PATH: "~/.state.sqlite",
          AAG_STATE_PATH: "/home/fixture/.state.sqlite",
        },
      }),
    ).toBe("/home/fixture/.state.sqlite");
    expect(() =>
      resolveConfigPath({
        explicit: "/operator/agent.yaml",
        environment: { KNOT_CONFIG: "/conflict/new", AAG_CONFIG: "/conflict/old" },
      }),
    ).toThrow("Conflicting compatibility variables");
  });

  it("discovers either Heart binary and preserves explicit commands", async () => {
    await expect(
      resolveHeartBinary("aag-heart-adapter", async (command) => command === "knot-heart-adapter"),
    ).resolves.toBe("knot-heart-adapter");
    await expect(resolveHeartBinary("/opt/custom/heart", async () => false)).resolves.toBe(
      "/opt/custom/heart",
    );
  });

  it("detects legacy and Knot service identities independently", async () => {
    await expect(
      detectServices(
        "darwin",
        async (identity) => identity === "com.anytype.anytype-agent-gateway",
      ),
    ).resolves.toEqual([
      {
        generation: "aag",
        identity: "com.anytype.anytype-agent-gateway",
        installed: true,
      },
      { generation: "knot", identity: "com.imai.knot", installed: false },
    ]);
  });

  it("parses both permanent legacy markers and Knot markers", () => {
    expect(parseSilenceMarker("[[AAG_STAY_SILENT: legacy]]")).toEqual({ reason: "legacy" });
    expect(parseSilenceMarker("[[KNOT_STAY_SILENT: current]]")).toEqual({ reason: "current" });
    expect(parseSilenceMarker("not [[AAG_STAY_SILENT]] prose")).toBeUndefined();
  });
});

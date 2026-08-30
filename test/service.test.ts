import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLaunchdPlist,
  launchdServiceLabel,
  resolveInstalledService,
  systemdServiceName,
} from "../src/service.js";

describe("buildLaunchdPlist", () => {
  it("uses the Knot service identities for newly generated services", () => {
    expect(systemdServiceName).toBe("knot.service");
    expect(launchdServiceLabel).toBe("com.imai.knot");
  });
  it("discovers a legacy service for in-place management", async () => {
    const home = await mkdtemp(join(tmpdir(), "knot-service-home-"));
    const directory = join(home, "Library", "LaunchAgents");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "com.anytype.anytype-agent-gateway.plist"), "legacy");
    await expect(resolveInstalledService("darwin", home)).resolves.toEqual({
      generation: "aag",
      identity: "com.anytype.anytype-agent-gateway",
    });
  });
  it("fails closed when both service generations exist", async () => {
    const home = await mkdtemp(join(tmpdir(), "knot-service-conflict-"));
    const directory = join(home, ".config", "systemd", "user");
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, "anytype-agent-gateway.service"), "legacy"),
      writeFile(join(directory, "knot.service"), "current"),
    ]);
    await expect(resolveInstalledService("linux", home)).rejects.toThrow(
      "Both AAG and Knot service definitions exist",
    );
  });
  it("uses argument-array absolute paths, private log destinations, and the Anytype dependency", () => {
    const plist = buildLaunchdPlist({
      nodePath: "/opt/node/bin/node",
      cliPath: "/opt/aag/dist/cli.js",
      configPath: "/Users/test/.config/aag/agent.yaml",
      stdoutPath: "/Users/test/Library/Logs/AnytypeAgentGateway/gateway.log",
      stderrPath: "/Users/test/Library/Logs/AnytypeAgentGateway/gateway.error.log",
      pathEnvironment: "/opt/node/bin:/usr/bin:/bin",
      codexAppToolsPipePath: "/tmp/codex-app.sock",
      codexMcpNodePath: "/Applications/Codex.app/node",
      dependencyLabel: "anytype",
    });

    expect(plist).toContain("<string>/opt/node/bin/node</string>");
    expect(plist).toContain("<string>/opt/aag/dist/cli.js</string>");
    expect(plist).toContain("<string>/Users/test/.config/aag/agent.yaml</string>");
    expect(plist).toContain("<key>OtherJobEnabled</key>");
    expect(plist).toContain("<key>anytype</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<key>ExitTimeOut</key>");
    expect(plist).toContain("<integer>30</integer>");
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<key>CODEX_APP_TOOLS_PIPE_PATH</key>");
    expect(plist).toContain("<string>/tmp/codex-app.sock</string>");
    expect(plist).toContain("<key>CODEX_MCP_NODE_PATH</key>");
    expect(plist).not.toContain("/bin/sh");
  });

  it("escapes every operator-controlled plist string", () => {
    const plist = buildLaunchdPlist({
      nodePath: "/node&one",
      cliPath: "/cli<two>",
      configPath: '/config"three"',
      stdoutPath: "/log'out",
      stderrPath: "/log&err",
      pathEnvironment: "/bin&tools",
      dependencyLabel: "any&type",
    });

    expect(plist).toContain("/node&amp;one");
    expect(plist).toContain("/cli&lt;two&gt;");
    expect(plist).toContain("/config&quot;three&quot;");
    expect(plist).toContain("/log&apos;out");
    expect(plist).toContain("<key>any&amp;type</key>");
  });

  it("omits the Anytype dependency for remote API configurations", () => {
    const plist = buildLaunchdPlist({
      nodePath: "/node",
      cliPath: "/cli.js",
      configPath: "/config.yaml",
      stdoutPath: "/stdout.log",
      stderrPath: "/stderr.log",
      pathEnvironment: "/usr/bin:/bin",
    });

    expect(plist).not.toContain("OtherJobEnabled");
    expect(plist).toContain("<key>SuccessfulExit</key>");
  });
});

import { describe, expect, it } from "vitest";
import { buildLaunchdPlist } from "../src/service.js";

describe("buildLaunchdPlist", () => {
  it("uses argument-array absolute paths, private log destinations, and the Anytype dependency", () => {
    const plist = buildLaunchdPlist({
      nodePath: "/opt/node/bin/node",
      cliPath: "/opt/aag/dist/cli.js",
      configPath: "/Users/test/.config/aag/agent.yaml",
      stdoutPath: "/Users/test/Library/Logs/AnytypeAgentGateway/gateway.log",
      stderrPath: "/Users/test/Library/Logs/AnytypeAgentGateway/gateway.error.log",
      pathEnvironment: "/opt/node/bin:/usr/bin:/bin",
      dependencyLabel: "anytype"
    });

    expect(plist).toContain("<string>/opt/node/bin/node</string>");
    expect(plist).toContain("<string>/opt/aag/dist/cli.js</string>");
    expect(plist).toContain("<string>/Users/test/.config/aag/agent.yaml</string>");
    expect(plist).toContain("<key>OtherJobEnabled</key>");
    expect(plist).toContain("<key>anytype</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).not.toContain("/bin/sh");
  });

  it("escapes every operator-controlled plist string", () => {
    const plist = buildLaunchdPlist({
      nodePath: "/node&one",
      cliPath: "/cli<two>",
      configPath: "/config\"three\"",
      stdoutPath: "/log'out",
      stderrPath: "/log&err",
      pathEnvironment: "/bin&tools",
      dependencyLabel: "any&type"
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
      pathEnvironment: "/usr/bin:/bin"
    });

    expect(plist).not.toContain("OtherJobEnabled");
    expect(plist).toContain("<key>SuccessfulExit</key>");
  });
});

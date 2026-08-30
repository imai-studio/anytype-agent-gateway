import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildLaunchdPlist,
  launchdServiceLabel,
  resolveInstalledService,
  serviceRollbackCommands,
  systemdServiceName,
  migrateService,
  type ManagedServiceState,
  type ServiceMigrationManager,
} from "../src/service.js";

describe("buildLaunchdPlist", () => {
  it("uses the Knot service identities for newly generated services", () => {
    expect(systemdServiceName).toBe("knot.service");
    expect(launchdServiceLabel).toBe("com.imai.knot");
  });
  it("prints complete platform-specific rollback commands", () => {
    expect(serviceRollbackCommands("linux")).toEqual([
      "systemctl --user disable --now knot.service",
      "rm -f ~/.config/systemd/user/knot.service",
      "mv <legacy-backup> ~/.config/systemd/user/anytype-agent-gateway.service",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now anytype-agent-gateway.service",
    ]);
    expect(serviceRollbackCommands("darwin")).toEqual([
      "knot service stop",
      "rm -f ~/Library/LaunchAgents/com.imai.knot.plist",
      "mv <legacy-backup> ~/Library/LaunchAgents/com.anytype.anytype-agent-gateway.plist",
      "launchctl enable gui/$(id -u)/com.anytype.anytype-agent-gateway",
      "launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.anytype.anytype-agent-gateway.plist",
    ]);
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

describe.each(["systemd", "launchd"])("%s service migration harness", () => {
  it("leaves exactly one enabled and running generation", async () => {
    const home = await serviceMigrationHome();
    const manager = new FakeServiceManager();
    const result = await migrateService({ home, manager });
    expect(result.phases).toContain("one-healthy-process-verified");
    expect(await manager.inspect("aag")).toEqual({
      defined: false,
      enabled: false,
      running: false,
    });
    expect(await manager.inspect("knot")).toEqual({ defined: true, enabled: true, running: true });
  });

  it("installs the migrated service from a selected per-agent config", async () => {
    const home = await serviceMigrationHome("klee");
    const manager = new FakeServiceManager();
    await migrateService({
      home,
      manager,
      legacyConfigPath: join(home, ".config/aag/klee/agent.yaml"),
    });
    expect(manager.installedConfigPath).toBe(join(home, ".config/knot/klee/agent.yaml"));
  });

  it("fails before stopping legacy when a nested config was not selected", async () => {
    const home = await serviceMigrationHome("klee");
    const manager = new FakeServiceManager();
    await expect(migrateService({ home, manager })).rejects.toThrow("Rerun with --config");
    expect(manager.legacy).toEqual({ defined: true, enabled: true, running: true });
  });

  it("fails closed when both definitions are present", async () => {
    const home = await serviceMigrationHome();
    const manager = new FakeServiceManager();
    manager.current.defined = true;
    await expect(migrateService({ home, manager })).rejects.toThrow(
      "Both AAG and Knot service definitions exist",
    );
  });

  it("fails closed when a definitionless legacy job is still loaded", async () => {
    const home = await serviceMigrationHome();
    const manager = new FakeServiceManager();
    manager.legacy = { defined: false, enabled: false, running: true };
    manager.current = { defined: true, enabled: true, running: true };
    manager.backup = "/fixture/legacy.backup";
    await expect(migrateService({ home, manager })).rejects.toThrow(
      "Both AAG and Knot services are enabled or running",
    );
  });

  it("resumes when Knot definition exists but activation was interrupted", async () => {
    const home = await serviceMigrationHome();
    const manager = new FakeServiceManager();
    manager.legacy = { defined: false, enabled: false, running: false };
    manager.current = { defined: true, enabled: false, running: false };
    manager.backup = "/fixture/legacy.backup";
    const result = await migrateService({ home, manager });
    expect(result.phases).toContain("resumed-after-legacy-backup");
    expect(manager.current).toEqual({ defined: true, enabled: true, running: true });
  });

  it("recognizes an already migrated healthy service with live destination state", async () => {
    const home = await serviceMigrationHome();
    const manager = new FakeServiceManager();
    await migrateService({ home, manager });
    await writeFile(join(home, ".local/state/knot/state.sqlite-wal"), "live traffic");
    const result = await migrateService({ home, manager });
    expect(result.phases).toContain("already-migrated");
  });

  it("resumes after interruption immediately following legacy backup", async () => {
    const home = await serviceMigrationHome();
    const manager = new FakeServiceManager();
    manager.legacy = { defined: false, enabled: false, running: false };
    manager.backup = "/fixture/legacy.backup";
    const result = await migrateService({ home, manager });
    expect(result.phases).toContain("resumed-after-legacy-backup");
    expect(manager.current).toEqual({ defined: true, enabled: true, running: true });
  });

  it("rolls back the legacy service when current installation fails", async () => {
    const home = await serviceMigrationHome();
    const manager = new FakeServiceManager();
    manager.failInstall = true;
    await expect(migrateService({ home, manager })).rejects.toThrow("install failed");
    expect(await manager.inspect("aag")).toEqual({ defined: true, enabled: true, running: true });
    expect(await manager.inspect("knot")).toEqual({
      defined: false,
      enabled: false,
      running: false,
    });
  });
});

class FakeServiceManager implements ServiceMigrationManager {
  legacy: ManagedServiceState = { defined: true, enabled: true, running: true };
  current: ManagedServiceState = { defined: false, enabled: false, running: false };
  failInstall = false;
  backup: string | undefined;
  installedConfigPath: string | undefined;
  async inspect(generation: "aag" | "knot"): Promise<ManagedServiceState> {
    return { ...(generation === "aag" ? this.legacy : this.current) };
  }
  async stopAndDisableLegacy(): Promise<void> {
    this.legacy.enabled = false;
    this.legacy.running = false;
  }
  async backupLegacy(): Promise<string> {
    this.legacy.defined = false;
    this.backup = "/fixture/legacy.backup";
    return this.backup;
  }
  async installCurrent(configPath: string): Promise<void> {
    if (this.failInstall) throw new Error("install failed");
    this.installedConfigPath = configPath;
    this.current = { defined: true, enabled: true, running: true };
  }
  async stopAndDisableCurrent(): Promise<void> {
    this.current = { defined: false, enabled: false, running: false };
  }
  async restoreLegacy(): Promise<void> {
    this.legacy = { defined: true, enabled: true, running: true };
    this.backup = undefined;
  }
  async findLegacyBackup(): Promise<string | undefined> {
    return this.backup;
  }
}

async function serviceMigrationHome(agent?: string): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "knot-service-migration-")));
  const configDirectory = join(home, ".config/aag", agent ?? "");
  const stateDirectory = join(home, ".local/state/aag", agent ?? "");
  await mkdir(configDirectory, { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  const state = join(stateDirectory, "state.sqlite");
  await writeFile(
    join(configDirectory, "agent.yaml"),
    `version: 1\nagent:\n  name: Fixture\n  participantId: _participant_fixture_agent_01\nanytype:\n  apiKeyFile: /fixture/key\nspaces:
  - id: _space_fixture_01\nruntime:\n  kind: codex\nstate:\n  path: ${state}\n`,
  );
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/v0.1.3/state.sql");
  const database = new DatabaseSync(state);
  database.exec(await readFile(fixture, "utf8"));
  database.exec("PRAGMA journal_mode=WAL");
  database.close();
  return home;
}

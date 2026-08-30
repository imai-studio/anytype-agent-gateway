import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { runProcess } from "./process.js";
import { detectServices, logNamespace, PRODUCT } from "./compatibility.js";
import {
  latestMigrationManifest,
  migrateInstallation,
  resolveLegacyConfigSource,
  type MigrationResult,
} from "./migration.js";

export const systemdServiceName = PRODUCT.services.linux.current;
export const launchdServiceLabel = PRODUCT.services.darwin.current;
const anytypeLaunchAgentName = "anytype.plist";

interface LaunchdPlistOptions {
  nodePath: string;
  cliPath: string;
  configPath: string;
  stdoutPath: string;
  stderrPath: string;
  pathEnvironment: string;
  codexAppToolsPipePath?: string;
  codexMcpNodePath?: string;
  dependencyLabel?: string;
}

export async function installService(configPath: string): Promise<void> {
  if (process.platform === "linux") return installSystemdService(configPath);
  if (process.platform === "darwin") return installLaunchdService(configPath);
  throw new Error(
    "Service installation supports Linux systemd user services and macOS launchd agents",
  );
}

export async function serviceCommand(
  command: "status" | "restart" | "stop" | "logs",
): Promise<void> {
  if (process.platform === "linux") return systemdCommand(command);
  if (process.platform === "darwin") return launchdCommand(command);
  throw new Error(
    "Service management supports Linux systemd user services and macOS launchd agents",
  );
}

export type ManagedServiceState = { defined: boolean; enabled: boolean; running: boolean };
export interface ServiceMigrationManager {
  inspect(generation: "aag" | "knot"): Promise<ManagedServiceState>;
  stopAndDisableLegacy(): Promise<void>;
  backupLegacy(stamp: string): Promise<string>;
  installCurrent(configPath: string): Promise<void>;
  stopAndDisableCurrent(): Promise<void>;
  restoreLegacy(backup: string): Promise<void>;
  findLegacyBackup?(): Promise<string | undefined>;
}

export type ServiceMigrationResult = {
  migration: MigrationResult;
  phases: string[];
  legacyBackup?: string;
  rollback: string[];
};

export async function migrateService(
  options: {
    home?: string;
    legacyConfigPath?: string;
    dryRun?: boolean;
    manager?: ServiceMigrationManager;
    now?: Date;
  } = {},
): Promise<ServiceMigrationResult> {
  const home = resolve(options.home ?? homedir());
  const manager = options.manager ?? platformServiceMigrationManager(home);
  const legacy = await manager.inspect("aag");
  const current = await manager.inspect("knot");
  const resumableBackup = !legacy.defined ? await manager.findLegacyBackup?.() : undefined;
  const rollback = serviceRollbackCommands();
  if (legacy.defined && current.defined)
    throw new Error("Both AAG and Knot service definitions exist; refusing service migration");
  if ((legacy.enabled || legacy.running) && (current.enabled || current.running))
    throw new Error(
      "Both AAG and Knot services are enabled or running; refusing service migration",
    );
  const migrationOptions = {
    home,
    dryRun: true,
    ...(options.legacyConfigPath ? { legacyConfigPath: options.legacyConfigPath } : {}),
  };
  if (
    !legacy.defined &&
    !legacy.enabled &&
    !legacy.running &&
    current.defined &&
    current.enabled &&
    current.running
  ) {
    const selectedConfigSource = await resolveLegacyConfigSource(home, options.legacyConfigPath);
    const migration = await latestMigrationManifest(home, selectedConfigSource);
    if (!migration)
      throw new Error(
        "Knot is running but no verified migration manifest exists; refusing ambiguity",
      );
    const legacyBackup = await manager.findLegacyBackup?.();
    return {
      migration,
      phases: ["already-migrated", "one-healthy-process-verified"],
      ...(legacyBackup ? { legacyBackup } : {}),
      rollback,
    };
  }
  if (!legacy.defined && !resumableBackup)
    throw new Error(
      "No exact legacy AAG service definition was found; refusing ambiguous migration",
    );
  const phases = [resumableBackup ? "resumed-after-legacy-backup" : "legacy-detected"];
  const preflight = await migrateInstallation(migrationOptions);
  if (options.dryRun) return { migration: preflight, phases, rollback };

  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/gu, "-");
  let backup = resumableBackup;
  let legacyStopped = Boolean(resumableBackup);
  try {
    if (!backup) {
      legacyStopped = true;
      await manager.stopAndDisableLegacy();
      phases.push("legacy-stopped-disabled");
      const stopped = await manager.inspect("aag");
      if (stopped.enabled || stopped.running)
        throw new Error("Legacy service remained enabled or running; migration stopped");
    }
    const migration = await migrateInstallation({
      home,
      ...(options.legacyConfigPath ? { legacyConfigPath: options.legacyConfigPath } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    const migratedConfig = migration.items.find((item) => item.kind === "config");
    if (migratedConfig?.status !== "verified")
      throw new Error("Migration did not produce a verified Knot configuration");
    const configPath = join(migratedConfig.destination, "agent.yaml");
    const loadedConfig = await loadConfig(configPath);
    const knotStateRoot = join(home, ".local", "state", "knot");
    const stateRelative = relative(knotStateRoot, loadedConfig.state.path);
    if (stateRelative.startsWith("..") || isAbsolute(stateRelative))
      throw new Error("Migrated configuration does not resolve state inside the Knot state root");
    phases.push("config-verified");
    if (!backup) {
      backup = await manager.backupLegacy(stamp);
      phases.push("legacy-definition-backed-up");
    }
    await manager.installCurrent(configPath);
    phases.push("knot-installed-started");
    const [oldFinal, newFinal] = await Promise.all([
      manager.inspect("aag"),
      manager.inspect("knot"),
    ]);
    if (
      oldFinal.enabled ||
      oldFinal.running ||
      !newFinal.defined ||
      !newFinal.enabled ||
      !newFinal.running
    )
      throw new Error(
        "Service migration health check did not prove exactly one enabled, running Knot service",
      );
    phases.push("one-healthy-process-verified");
    return { migration, phases, legacyBackup: backup, rollback };
  } catch (error) {
    if (legacyStopped) {
      const rollbackErrors: unknown[] = [];
      await manager
        .stopAndDisableCurrent()
        .catch((rollbackError) => rollbackErrors.push(rollbackError));
      await manager
        .restoreLegacy(backup ?? "")
        .catch((rollbackError) => rollbackErrors.push(rollbackError));
      if (rollbackErrors.length)
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Service migration failed and automatic rollback was incomplete. Legacy backup: ${backup ?? "definition was not yet backed up"}. Follow the manual rollback guide.`,
        );
    }
    throw error;
  }
}

export function serviceRollbackCommands(platform = process.platform): string[] {
  return platform === "darwin"
    ? [
        "knot service stop",
        "rm -f ~/Library/LaunchAgents/com.imai.knot.plist",
        "mv <legacy-backup> ~/Library/LaunchAgents/com.anytype.anytype-agent-gateway.plist",
        "launchctl enable gui/$(id -u)/com.anytype.anytype-agent-gateway",
        "launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.anytype.anytype-agent-gateway.plist",
      ]
    : [
        "systemctl --user disable --now knot.service",
        "rm -f ~/.config/systemd/user/knot.service",
        "mv <legacy-backup> ~/.config/systemd/user/anytype-agent-gateway.service",
        "systemctl --user daemon-reload",
        "systemctl --user enable --now anytype-agent-gateway.service",
      ];
}

function platformServiceMigrationManager(home: string): ServiceMigrationManager {
  if (process.platform === "linux") return systemdMigrationManager(home);
  if (process.platform === "darwin") return launchdMigrationManager(home);
  throw new Error("Service migration supports Linux systemd and macOS launchd only");
}

function systemdMigrationManager(home: string): ServiceMigrationManager {
  const directory = join(home, ".config", "systemd", "user");
  const legacyPath = join(directory, PRODUCT.services.linux.legacy);
  return {
    async inspect(generation) {
      const identity =
        generation === "aag" ? PRODUCT.services.linux.legacy : PRODUCT.services.linux.current;
      const defined = await access(join(directory, identity), constants.R_OK)
        .then(() => true)
        .catch(() => false);
      const enabled = await runProcess("systemctl", ["--user", "is-enabled", "--quiet", identity])
        .then(() => true)
        .catch(() => false);
      const running = await runProcess("systemctl", ["--user", "is-active", "--quiet", identity])
        .then(() => true)
        .catch(() => false);
      return { defined, enabled, running };
    },
    async stopAndDisableLegacy() {
      await runProcess("systemctl", ["--user", "disable", "--now", PRODUCT.services.linux.legacy]);
    },
    async backupLegacy(stamp) {
      const backup = `${legacyPath}.pre-knot-${stamp}.bak`;
      await rename(legacyPath, backup);
      try {
        await runProcess("systemctl", ["--user", "daemon-reload"]);
      } catch (error) {
        await rename(backup, legacyPath).catch(() => undefined);
        throw error;
      }
      return backup;
    },
    installCurrent: installSystemdService,
    async stopAndDisableCurrent() {
      const currentPath = join(directory, PRODUCT.services.linux.current);
      if (
        !(await access(currentPath)
          .then(() => true)
          .catch(() => false))
      )
        return;
      await runProcess("systemctl", [
        "--user",
        "disable",
        "--now",
        PRODUCT.services.linux.current,
      ]).catch(() => undefined);
      await unlink(currentPath);
      await runProcess("systemctl", ["--user", "daemon-reload"]);
    },
    async restoreLegacy(backup) {
      if (backup) await rename(backup, legacyPath);
      await runProcess("systemctl", ["--user", "daemon-reload"]);
      await runProcess("systemctl", ["--user", "enable", "--now", PRODUCT.services.linux.legacy]);
    },
    async findLegacyBackup() {
      const matches = (await readdir(directory).catch(() => []))
        .filter(
          (name) =>
            name.startsWith(`${PRODUCT.services.linux.legacy}.pre-knot-`) && name.endsWith(".bak"),
        )
        .sort();
      if (matches.length > 1)
        throw new Error("Multiple legacy systemd backups exist; refusing ambiguous resume");
      return matches[0] ? join(directory, matches[0]) : undefined;
    },
  };
}

function launchdMigrationManager(home: string): ServiceMigrationManager {
  const directory = join(home, "Library", "LaunchAgents");
  const legacyPath = join(directory, `${PRODUCT.services.darwin.legacy}.plist`);
  const domain = launchdDomain();
  return {
    async inspect(generation) {
      const identity =
        generation === "aag" ? PRODUCT.services.darwin.legacy : PRODUCT.services.darwin.current;
      const defined = await access(join(directory, `${identity}.plist`), constants.R_OK)
        .then(() => true)
        .catch(() => false);
      const running = await launchdJobIsLoaded(`${domain}/${identity}`);
      const { stdout } = await runProcess("/bin/launchctl", ["print-disabled", domain]);
      const disabled = new RegExp(
        `"${identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*=>\\s*(?:true|disabled)`,
        "u",
      ).test(stdout);
      return { defined, enabled: defined && !disabled, running };
    },
    async stopAndDisableLegacy() {
      const target = `${domain}/${PRODUCT.services.darwin.legacy}`;
      await runProcess("/bin/launchctl", ["disable", target]);
      if (await launchdJobIsLoaded(target))
        await runProcess("/bin/launchctl", ["bootout", target]).catch(() => undefined);
      await waitForLaunchdUnloaded(target);
    },
    async backupLegacy(stamp) {
      const backup = `${legacyPath}.pre-knot-${stamp}.bak`;
      await rename(legacyPath, backup);
      return backup;
    },
    installCurrent: installLaunchdService,
    async stopAndDisableCurrent() {
      const target = `${domain}/${PRODUCT.services.darwin.current}`;
      await runProcess("/bin/launchctl", ["disable", target]).catch(() => undefined);
      if (await launchdJobIsLoaded(target))
        await runProcess("/bin/launchctl", ["bootout", target]).catch(() => undefined);
      await unlink(join(directory, `${PRODUCT.services.darwin.current}.plist`)).catch(
        () => undefined,
      );
    },
    async restoreLegacy(backup) {
      if (backup) await rename(backup, legacyPath);
      const target = `${domain}/${PRODUCT.services.darwin.legacy}`;
      await runProcess("/bin/launchctl", ["enable", target]);
      await bootstrapLaunchd(domain, legacyPath, target);
    },
    async findLegacyBackup() {
      const matches = (await readdir(directory).catch(() => []))
        .filter(
          (name) =>
            name.startsWith(`${PRODUCT.services.darwin.legacy}.plist.pre-knot-`) &&
            name.endsWith(".bak"),
        )
        .sort();
      if (matches.length > 1)
        throw new Error("Multiple legacy launchd backups exist; refusing ambiguous resume");
      return matches[0] ? join(directory, matches[0]) : undefined;
    },
  };
}

async function installSystemdService(configPath: string): Promise<void> {
  const home = homedir();
  const existing = await resolveInstalledService("linux", home);
  if (existing?.generation === "aag")
    throw new Error(
      `Existing AAG service ${existing.identity} is already installed; manage it in place with \`knot service\`. Service migration arrives in a later release.`,
    );
  const config = await loadConfig(configPath);
  const localAnytype = usesLocalHeadlessAnytype(config.anytype.apiBase);
  const executable = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
  await Promise.all([
    access(resolve(configPath), constants.R_OK),
    access(executable, constants.R_OK),
    access(resolve(process.execPath), constants.X_OK),
  ]);
  const target = `${home}/.config/systemd/user/${systemdServiceName}`;
  if (localAnytype)
    await installAnytypeUnitIfMissing(
      home,
      config.anytype.cli.command,
      config.anytype.cli.dataPath,
    );
  const dependencies = localAnytype
    ? " network-online.target anytype.service"
    : " network-online.target";
  const pathEnvironment = servicePathEnvironment(process.execPath);
  const unit = `[Unit]\nDescription=Knot\nAfter=${dependencies.trim()}\nWants=${dependencies.trim()}\n\n[Service]\nType=simple\nExecStart=${systemdQuote(process.execPath)} ${systemdQuote(executable)} run --config ${systemdQuote(resolve(configPath))}\nEnvironment=${systemdQuote(`PATH=${pathEnvironment}`)}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, unit, { mode: 0o600 });
  await chmod(target, 0o600);
  await runProcess("systemctl", ["--user", "daemon-reload"]);
  await runProcess("systemctl", ["--user", "enable", "--now", systemdServiceName]);
}

async function systemdCommand(command: "status" | "restart" | "stop" | "logs"): Promise<void> {
  const installed = await resolveInstalledService("linux", homedir());
  const serviceName = installed?.identity ?? systemdServiceName;
  const args =
    command === "logs"
      ? ["--user", "-u", serviceName, "-f"]
      : ["--user", ...(command === "status" ? ["--no-pager"] : []), command, serviceName];
  await spawnInherited(command === "logs" ? "journalctl" : "systemctl", args, command);
}

async function installLaunchdService(configPath: string): Promise<void> {
  const home = homedir();
  const existing = await resolveInstalledService("darwin", home);
  if (existing?.generation === "aag")
    throw new Error(
      `Existing AAG service ${existing.identity} is already installed; manage it in place with \`knot service\`. Service migration arrives in a later release.`,
    );
  const config = await loadConfig(configPath);
  const absoluteConfigPath = resolve(configPath);
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const nodePath = await resolveLaunchdNodePath(config.runtime);
  await Promise.all([
    access(absoluteConfigPath, constants.R_OK),
    access(cliPath, constants.R_OK),
    access(nodePath, constants.X_OK),
  ]);

  const launchAgentsDirectory = join(home, "Library", "LaunchAgents");
  const logsDirectory = join(home, "Library", "Logs", logNamespace());
  const stdoutPath = join(logsDirectory, "gateway.log");
  const stderrPath = join(logsDirectory, "gateway.error.log");
  const target = join(launchAgentsDirectory, `${launchdServiceLabel}.plist`);
  const domain = launchdDomain();
  const dependency = usesLocalHeadlessAnytype(config.anytype.apiBase)
    ? await readAnytypeLaunchAgent(home)
    : undefined;

  await mkdir(launchAgentsDirectory, { recursive: true });
  await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([ensurePrivateLogFile(stdoutPath), ensurePrivateLogFile(stderrPath)]);
  const plist = buildLaunchdPlist({
    nodePath,
    cliPath,
    configPath: absoluteConfigPath,
    stdoutPath,
    stderrPath,
    pathEnvironment: launchdPathEnvironment(nodePath),
    ...(process.env.CODEX_MCP_NODE_PATH
      ? { codexMcpNodePath: process.env.CODEX_MCP_NODE_PATH }
      : {}),
    ...(dependency ? { dependencyLabel: dependency.label } : {}),
  });
  await writePrivateFileAtomic(target, plist);

  if (dependency) await ensureLaunchdJob(domain, dependency.label, dependency.path);
  const serviceTarget = `${domain}/${launchdServiceLabel}`;
  if (await launchdJobIsLoaded(serviceTarget)) {
    // A KeepAlive job can report "operation now in progress" after accepting
    // bootout. The observed unloaded state below is the authoritative result.
    await runProcess("/bin/launchctl", ["bootout", serviceTarget]).catch(() => undefined);
    await waitForLaunchdUnloaded(serviceTarget);
  }
  await runProcess("/bin/launchctl", ["enable", serviceTarget]);
  await bootstrapLaunchd(domain, target, serviceTarget);
}

async function resolveLaunchdNodePath(
  runtime: Awaited<ReturnType<typeof loadConfig>>["runtime"],
): Promise<string> {
  if (runtime.kind === "codex" && runtime.desktopProject === "auto") {
    const candidates = [
      process.env.CODEX_MCP_NODE_PATH,
      "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
      const path = resolve(candidate);
      if (
        await access(path, constants.X_OK)
          .then(() => true)
          .catch(() => false)
      )
        return path;
    }
  }
  return resolve(process.execPath);
}

async function launchdCommand(command: "status" | "restart" | "stop" | "logs"): Promise<void> {
  const home = homedir();
  const domain = launchdDomain();
  const installed = await resolveInstalledService("darwin", home);
  const serviceLabel = installed?.identity ?? launchdServiceLabel;
  const generation = installed?.generation ?? "knot";
  const serviceTarget = `${domain}/${serviceLabel}`;
  const plistPath = join(home, "Library", "LaunchAgents", `${serviceLabel}.plist`);
  const logsDirectory = join(home, "Library", "Logs", logNamespace(generation));

  if (command === "status") {
    await spawnInherited("/bin/launchctl", ["print", serviceTarget], command);
    return;
  }
  if (command === "logs") {
    await access(plistPath, constants.R_OK).catch(() => {
      throw new Error(
        "Knot launch agent is not installed; run `knot service install --config <path>` first",
      );
    });
    await spawnInherited(
      "/usr/bin/tail",
      [
        "-n",
        "100",
        "-F",
        join(logsDirectory, "gateway.log"),
        join(logsDirectory, "gateway.error.log"),
      ],
      command,
    );
    return;
  }
  if (command === "stop") {
    if (await launchdJobIsLoaded(serviceTarget)) {
      await runProcess("/bin/launchctl", ["bootout", serviceTarget]).catch(() => undefined);
      await waitForLaunchdUnloaded(serviceTarget);
    }
    return;
  }

  await access(plistPath, constants.R_OK).catch(() => {
    throw new Error(
      "Knot launch agent is not installed; run `knot service install --config <path>` first",
    );
  });
  const installedPlist = await readFile(plistPath, "utf8");
  if (installedPlist.includes("<key>OtherJobEnabled</key>")) {
    const dependency = await readAnytypeLaunchAgent(home);
    await ensureLaunchdJob(domain, dependency.label, dependency.path);
  }
  await runProcess("/bin/launchctl", ["enable", serviceTarget]);
  if (!(await launchdJobIsLoaded(serviceTarget)))
    await bootstrapLaunchd(domain, plistPath, serviceTarget);
  await runProcess("/bin/launchctl", ["kickstart", "-k", serviceTarget]);
}

export async function resolveInstalledService(
  platform: "linux" | "darwin",
  home: string,
): Promise<{ generation: "aag" | "knot"; identity: string } | undefined> {
  const installations = await detectServices(platform, async (identity) => {
    const path =
      platform === "linux"
        ? join(home, ".config", "systemd", "user", identity)
        : join(home, "Library", "LaunchAgents", `${identity}.plist`);
    return access(path, constants.R_OK)
      .then(() => true)
      .catch(() => false);
  });
  const installedServices = installations.filter((candidate) => candidate.installed);
  if (installedServices.length > 1)
    throw new Error(
      "Both AAG and Knot service definitions exist; refusing to choose one. Disable or remove one definition before managing the service.",
    );
  const installed = installedServices[0];
  return installed ? { generation: installed.generation, identity: installed.identity } : undefined;
}

export function buildLaunchdPlist(options: LaunchdPlistOptions): string {
  const dependency = options.dependencyLabel
    ? `\n    <key>OtherJobEnabled</key>\n    <dict>\n      <key>${xmlEscape(options.dependencyLabel)}</key>\n      <true/>\n    </dict>`
    : "";
  const codexEnvironment = [
    options.codexAppToolsPipePath
      ? `\n    <key>CODEX_APP_TOOLS_PIPE_PATH</key>\n    <string>${xmlEscape(options.codexAppToolsPipePath)}</string>`
      : "",
    options.codexMcpNodePath
      ? `\n    <key>CODEX_MCP_NODE_PATH</key>\n    <string>${xmlEscape(options.codexMcpNodePath)}</string>`
      : "",
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(launchdServiceLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(options.nodePath)}</string>
    <string>${xmlEscape(options.cliPath)}</string>
    <string>run</string>
    <string>--config</string>
    <string>${xmlEscape(options.configPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(options.pathEnvironment)}</string>${codexEnvironment}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>${dependency}
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(options.stderrPath)}</string>
</dict>
</plist>
`;
}

function usesLocalHeadlessAnytype(apiBase: string): boolean {
  const apiUrl = new URL(apiBase);
  return (
    ["127.0.0.1", "localhost", "::1"].includes(apiUrl.hostname) && (apiUrl.port || "80") === "31012"
  );
}

function launchdDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Could not determine the current user ID for launchd");
  return `gui/${uid}`;
}

async function readAnytypeLaunchAgent(home: string): Promise<{ label: string; path: string }> {
  const path = join(home, "Library", "LaunchAgents", anytypeLaunchAgentName);
  await access(path, constants.R_OK).catch(() => {
    throw new Error(
      `Local Anytype API requires the existing headless launch agent at ${path}; run \`anytype service install\` first`,
    );
  });
  const { stdout } = await runProcess("/usr/bin/plutil", [
    "-extract",
    "Label",
    "raw",
    "-o",
    "-",
    path,
  ]);
  const label = stdout.trim();
  if (!label) throw new Error(`Anytype launch agent has no Label: ${path}`);
  return { label, path };
}

async function ensureLaunchdJob(domain: string, label: string, plistPath: string): Promise<void> {
  const serviceTarget = `${domain}/${label}`;
  await runProcess("/bin/launchctl", ["enable", serviceTarget]);
  if (!(await launchdJobIsLoaded(serviceTarget)))
    await bootstrapLaunchd(domain, plistPath, serviceTarget);
  await runProcess("/bin/launchctl", ["kickstart", serviceTarget]);
}

async function launchdJobIsLoaded(serviceTarget: string): Promise<boolean> {
  try {
    await runProcess("/bin/launchctl", ["print", serviceTarget]);
    return true;
  } catch {
    return false;
  }
}

async function bootstrapLaunchd(
  domain: string,
  plistPath: string,
  serviceTarget: string,
): Promise<void> {
  try {
    await runProcess("/bin/launchctl", ["bootstrap", domain, plistPath]);
  } catch (error) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    if (await launchdJobIsLoaded(serviceTarget)) return;
    try {
      await runProcess("/bin/launchctl", ["bootstrap", domain, plistPath]);
    } catch {
      throw error;
    }
  }
}

async function waitForLaunchdUnloaded(serviceTarget: string): Promise<void> {
  // launchd may keep a booted-out KeepAlive job visible for several seconds
  // while it tears down the process and dependency graph.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await launchdJobIsLoaded(serviceTarget))) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`launchd did not unload ${serviceTarget}`);
}

function servicePathEnvironment(nodePath: string): string {
  const paths = [
    dirname(nodePath),
    ...(process.env.PATH ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [
    ...new Set(paths.filter((path) => path && isAbsolute(path)).map((path) => resolve(path))),
  ].join(":");
}

function launchdPathEnvironment(nodePath: string): string {
  return servicePathEnvironment(nodePath);
}

async function ensurePrivateLogFile(path: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  await handle.close();
  await chmod(path, 0o600);
}

async function writePrivateFileAtomic(target: string, contents: string): Promise<void> {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function spawnInherited(command: string, args: string[], description: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const childProcess = spawn(command, args, { stdio: "inherit" });
    childProcess.on("error", reject);
    childProcess.on("close", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${description} exited ${code}`)),
    );
  });
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function installAnytypeUnitIfMissing(
  home: string,
  command: string,
  dataPath?: string,
): Promise<void> {
  const target = `${home}/.config/systemd/user/anytype.service`;
  try {
    await access(target);
    return;
  } catch {
    /* Create only when no operator-owned unit exists. */
  }
  const environment = dataPath ? `Environment=${systemdQuote(`DATA_PATH=${dataPath}`)}\n` : "";
  const unit = `[Unit]\nDescription=Anytype headless service for Knot\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n${environment}ExecStart=${systemdQuote(command)} serve --quiet\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, unit, { mode: 0o600, flag: "wx" });
}

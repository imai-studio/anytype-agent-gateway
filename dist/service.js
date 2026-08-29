import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { runProcess } from "./process.js";
const systemdServiceName = "anytype-agent-gateway.service";
const launchdServiceLabel = "com.anytype.anytype-agent-gateway";
const anytypeLaunchAgentName = "anytype.plist";
export async function installService(configPath) {
    if (process.platform === "linux")
        return installSystemdService(configPath);
    if (process.platform === "darwin")
        return installLaunchdService(configPath);
    throw new Error("Service installation supports Linux systemd user services and macOS launchd agents");
}
export async function serviceCommand(command) {
    if (process.platform === "linux")
        return systemdCommand(command);
    if (process.platform === "darwin")
        return launchdCommand(command);
    throw new Error("Service management supports Linux systemd user services and macOS launchd agents");
}
async function installSystemdService(configPath) {
    const home = homedir();
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
        await installAnytypeUnitIfMissing(home, config.anytype.cli.command, config.anytype.cli.dataPath);
    const dependencies = localAnytype
        ? " network-online.target anytype.service"
        : " network-online.target";
    const pathEnvironment = servicePathEnvironment(process.execPath);
    const unit = `[Unit]\nDescription=Anytype Agent Gateway\nAfter=${dependencies.trim()}\nWants=${dependencies.trim()}\n\n[Service]\nType=simple\nExecStart=${systemdQuote(process.execPath)} ${systemdQuote(executable)} run --config ${systemdQuote(resolve(configPath))}\nEnvironment=${systemdQuote(`PATH=${pathEnvironment}`)}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, unit, { mode: 0o600 });
    await chmod(target, 0o600);
    await runProcess("systemctl", ["--user", "daemon-reload"]);
    await runProcess("systemctl", ["--user", "enable", "--now", systemdServiceName]);
}
async function systemdCommand(command) {
    const args = command === "logs"
        ? ["--user", "-u", systemdServiceName, "-f"]
        : ["--user", ...(command === "status" ? ["--no-pager"] : []), command, systemdServiceName];
    await spawnInherited(command === "logs" ? "journalctl" : "systemctl", args, command);
}
async function installLaunchdService(configPath) {
    const home = homedir();
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
    const logsDirectory = join(home, "Library", "Logs", "AnytypeAgentGateway");
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
    if (dependency)
        await ensureLaunchdJob(domain, dependency.label, dependency.path);
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
async function resolveLaunchdNodePath(runtime) {
    if (runtime.kind === "codex" && runtime.desktopProject === "auto") {
        const candidates = [
            process.env.CODEX_MCP_NODE_PATH,
            "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
        ].filter((candidate) => Boolean(candidate));
        for (const candidate of candidates) {
            const path = resolve(candidate);
            if (await access(path, constants.X_OK)
                .then(() => true)
                .catch(() => false))
                return path;
        }
    }
    return resolve(process.execPath);
}
async function launchdCommand(command) {
    const home = homedir();
    const domain = launchdDomain();
    const serviceTarget = `${domain}/${launchdServiceLabel}`;
    const plistPath = join(home, "Library", "LaunchAgents", `${launchdServiceLabel}.plist`);
    const logsDirectory = join(home, "Library", "Logs", "AnytypeAgentGateway");
    if (command === "status") {
        await spawnInherited("/bin/launchctl", ["print", serviceTarget], command);
        return;
    }
    if (command === "logs") {
        await access(plistPath, constants.R_OK).catch(() => {
            throw new Error("AAG launch agent is not installed; run `aag service install --config <path>` first");
        });
        await spawnInherited("/usr/bin/tail", [
            "-n",
            "100",
            "-F",
            join(logsDirectory, "gateway.log"),
            join(logsDirectory, "gateway.error.log"),
        ], command);
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
        throw new Error("AAG launch agent is not installed; run `aag service install --config <path>` first");
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
export function buildLaunchdPlist(options) {
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
function usesLocalHeadlessAnytype(apiBase) {
    const apiUrl = new URL(apiBase);
    return (["127.0.0.1", "localhost", "::1"].includes(apiUrl.hostname) && (apiUrl.port || "80") === "31012");
}
function launchdDomain() {
    const uid = process.getuid?.();
    if (uid === undefined)
        throw new Error("Could not determine the current user ID for launchd");
    return `gui/${uid}`;
}
async function readAnytypeLaunchAgent(home) {
    const path = join(home, "Library", "LaunchAgents", anytypeLaunchAgentName);
    await access(path, constants.R_OK).catch(() => {
        throw new Error(`Local Anytype API requires the existing headless launch agent at ${path}; run \`anytype service install\` first`);
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
    if (!label)
        throw new Error(`Anytype launch agent has no Label: ${path}`);
    return { label, path };
}
async function ensureLaunchdJob(domain, label, plistPath) {
    const serviceTarget = `${domain}/${label}`;
    await runProcess("/bin/launchctl", ["enable", serviceTarget]);
    if (!(await launchdJobIsLoaded(serviceTarget)))
        await bootstrapLaunchd(domain, plistPath, serviceTarget);
    await runProcess("/bin/launchctl", ["kickstart", serviceTarget]);
}
async function launchdJobIsLoaded(serviceTarget) {
    try {
        await runProcess("/bin/launchctl", ["print", serviceTarget]);
        return true;
    }
    catch {
        return false;
    }
}
async function bootstrapLaunchd(domain, plistPath, serviceTarget) {
    try {
        await runProcess("/bin/launchctl", ["bootstrap", domain, plistPath]);
    }
    catch (error) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
        if (await launchdJobIsLoaded(serviceTarget))
            return;
        try {
            await runProcess("/bin/launchctl", ["bootstrap", domain, plistPath]);
        }
        catch {
            throw error;
        }
    }
}
async function waitForLaunchdUnloaded(serviceTarget) {
    // launchd may keep a booted-out KeepAlive job visible for several seconds
    // while it tears down the process and dependency graph.
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!(await launchdJobIsLoaded(serviceTarget)))
            return;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    throw new Error(`launchd did not unload ${serviceTarget}`);
}
function servicePathEnvironment(nodePath) {
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
function launchdPathEnvironment(nodePath) {
    return servicePathEnvironment(nodePath);
}
async function ensurePrivateLogFile(path) {
    const handle = await open(path, "a", 0o600);
    await handle.close();
    await chmod(path, 0o600);
}
async function writePrivateFileAtomic(target, contents) {
    const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(contents);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await chmod(temporary, 0o600);
        await rename(temporary, target);
        await chmod(target, 0o600);
    }
    finally {
        await unlink(temporary).catch(() => undefined);
    }
}
async function spawnInherited(command, args, description) {
    await new Promise((resolvePromise, reject) => {
        const childProcess = spawn(command, args, { stdio: "inherit" });
        childProcess.on("error", reject);
        childProcess.on("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`${description} exited ${code}`)));
    });
}
function xmlEscape(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
function systemdQuote(value) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
async function installAnytypeUnitIfMissing(home, command, dataPath) {
    const target = `${home}/.config/systemd/user/anytype.service`;
    try {
        await access(target);
        return;
    }
    catch {
        /* Create only when no operator-owned unit exists. */
    }
    const environment = dataPath ? `Environment=${systemdQuote(`DATA_PATH=${dataPath}`)}\n` : "";
    const unit = `[Unit]\nDescription=Anytype headless service for AAG\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n${environment}ExecStart=${systemdQuote(command)} serve --quiet\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, unit, { mode: 0o600, flag: "wx" });
}

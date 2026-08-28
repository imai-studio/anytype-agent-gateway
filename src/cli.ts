#!/usr/bin/env node
import { access, constants, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import YAML from "yaml";
import { AnytypeClient } from "./anytype-client.js";
import { configSchema, loadConfig } from "./config.js";
import { HeartDiscussionAdapter } from "./discussions.js";
import { Gateway } from "./gateway.js";
import { createIdentity, joinSpaces } from "./identity.js";
import { commandExists } from "./process.js";
import { CodexAcpDriver } from "./runtime/codex-acp.js";
import { OpenClawDriver } from "./runtime/openclaw.js";
import { installService, serviceCommand } from "./service.js";
import { Store } from "./store.js";
import { setRouteWake } from "./management.js";
import type { RuntimeDriver } from "./types.js";
import { VERSION } from "./version.js";

const program = new Command().name("aag").description("Anytype Agent Gateway").version(VERSION);

program.command("init").description("Interactively create a one-agent configuration").option("-o, --output <path>", "configuration file", "./agent.yaml").action(async options => {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const name = (await prompt.question("Agent display name: ")).trim();
    const participantId = (await prompt.question("Anytype participant ID: ")).trim();
    const apiKeyFile = (await prompt.question("Anytype API key file [~/.config/aag/anytype-api-key]: ")).trim() || "~/.config/aag/anytype-api-key";
    const spaceId = (await prompt.question("Anytype space ID: ")).trim();
    const chatId = (await prompt.question("Initial Anytype chat/channel ID (optional with discovery): ")).trim();
    const discoverChats = /^y(?:es)?$/i.test((await prompt.question("Discover new chats in this space [y/N]: ")).trim());
    const allowedUsers = (await prompt.question("Authorized participant IDs (comma-separated): ")).split(",").map(value => value.trim()).filter(Boolean);
    const runtimeKind = (await prompt.question("Runtime (openclaw/codex) [openclaw]: ")).trim().toLowerCase() || "openclaw";
    if (runtimeKind !== "openclaw" && runtimeKind !== "codex") throw new Error("Runtime must be openclaw or codex");
    const defaultProject = (await prompt.question("Default project directory (optional): ")).trim();
    const runtime = runtimeKind === "openclaw"
      ? { kind: "openclaw", agentId: (await prompt.question("OpenClaw agent ID [main]: ")).trim() || "main", ...(defaultProject ? { defaultProject } : {}) }
      : { kind: "codex", permissions: "deny", ...(defaultProject ? { defaultProject } : {}) };
    if (!chatId && !discoverChats) throw new Error("Provide an initial chat ID or enable chat discovery");
    const wake = { humans: "mention-or-reply", agents: "never", allowedUsers } as const;
    const value = { version: 1, agent: { name, participantId }, anytype: { apiKeyFile }, spaces: [{ id: spaceId, chats: chatId ? [{ id: chatId, wake }] : [], ...(discoverChats ? { chatDiscovery: { enabled: true, discoveryIntervalSeconds: 30, wake } } : {}), comments: { mode: "disabled" } }], runtime, responses: { mode: "single", streaming: true } };
    configSchema.parse(value);
    const output = resolve(options.output);
    await mkdir(dirname(output), { recursive: true });
    const handle = await open(output, "wx", 0o600);
    await handle.writeFile(YAML.stringify(value));
    await handle.close();
    console.log(`Wrote ${output}. Run: aag doctor --config ${output}`);
  } finally { prompt.close(); }
});

program.command("validate").description("Validate a configuration file").requiredOption("-c, --config <path>").action(async options => {
  const config = await loadConfig(options.config);
  console.log(`valid: ${config.agent.name} (${config.runtime.kind}, ${config.spaces.length} space configuration(s))`);
});

program.command("doctor").description("Check Anytype, configured routes, adapter, runtime, and projects").requiredOption("-c, --config <path>").action(async options => {
  const config = await loadConfig(options.config);
  await access(config.anytype.apiKeyFile, constants.R_OK);
  const anytype = await AnytypeClient.create(config);
  for (const configuredSpace of config.spaces) {
    if (!configuredSpace.id && !configuredSpace.name) throw new Error("Join invite-only spaces and add their id or name before running doctor");
    const space = await anytype.resolveSpace({ ...(configuredSpace.id ? { id: configuredSpace.id } : {}), ...(configuredSpace.name ? { name: configuredSpace.name } : {}) });
    console.log(`ok: Anytype space ${space.name}`);
    for (const chatConfig of configuredSpace.chats) {
      const chat = await anytype.resolveChat(space.id, { ...(chatConfig.id ? { id: chatConfig.id } : {}), ...(chatConfig.name ? { name: chatConfig.name } : {}) });
      console.log(`ok: chat ${chat.name}`);
    }
    if (configuredSpace.chatDiscovery.enabled) console.log(`ok: chat discovery (${(await anytype.listChats(space.id)).length} current chats)`);
  }
  if (config.spaces.some(space => space.comments.mode !== "disabled")) {
    if (!await commandExists(config.anytype.heartAdapter.command)) throw new Error(`Heart adapter not found: ${config.anytype.heartAdapter.command}`);
    console.log(`ok: Heart discussion adapter ${config.anytype.heartAdapter.command}`);
  }
  const runtime = makeRuntime(config);
  for (const line of await runtime.doctor()) console.log(`ok: ${line}`);
  for (const project of [config.runtime.defaultProject, ...config.runtime.allowedProjects].filter(Boolean) as string[]) { await access(project, constants.R_OK); console.log(`ok: project ${project}`); }
});

program.command("run").description("Run one configured Anytype agent in the foreground").requiredOption("-c, --config <path>").action(async options => {
  const config = await loadConfig(options.config);
  const anytype = await AnytypeClient.create(config);
  const releaseLock = await acquireProcessLock(`${config.state.path}.lock`);
  let store: Store | undefined;
  try {
    store = new Store(config.state.path);
    const configPath = resolve(options.config);
    const gateway = new Gateway(anytype, makeRuntime(config, store), config, store, new HeartDiscussionAdapter(config), log, routeId => managementCommand(configPath, routeId));
    const stop = () => gateway.stop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await gateway.start();
  } finally { store?.close(); await releaseLock(); }
});

const config = program.command("config").description("Manage constrained runtime configuration");
config.command("wake").description("Set the human wake mode for one AAG route")
  .requiredOption("-c, --config <path>")
  .requiredOption("--route-id <id>")
  .requiredOption("--humans <mode>")
  .option("--prefix <text>")
  .action(async options => {
    await setRouteWake({ configPath: options.config, routeId: options.routeId, humans: options.humans, ...(options.prefix ? { prefix: options.prefix } : {}) });
    console.log(`Updated ${options.routeId} to humans=${options.humans}. The running gateway will apply it to the next message.`);
  });

const identity = program.command("identity").description("Manage the one Anytype bot identity on this machine");
identity.command("create").argument("<name>").option("--anytype <command>", "Anytype CLI command", "anytype").option("--invite <url...>", "space invite link(s)", []).option("--api-key-file <path>", "where to save the API key", "./aag-anytype-api-key").option("--data-path <path>").action(async (name, options) => {
  const keyFile = resolve(options.apiKeyFile);
  await createIdentity({ command: options.anytype, name, invites: options.invite, apiKeyFile: keyFile, ...(options.dataPath ? { dataPath: resolve(options.dataPath) } : {}) });
  console.log(`Created identity and saved its revocable API key to ${keyFile}`);
});

program.command("join").description("Join this machine's bot identity to one or more spaces").argument("<invite...>").option("--anytype <command>", "Anytype CLI command", "anytype").option("--data-path <path>").action(async (invites, options) => {
  await joinSpaces(options.anytype, invites, options.dataPath);
});

const service = program.command("service").description("Manage the Linux systemd user service or macOS launch agent");
service.command("install").requiredOption("-c, --config <path>").action(async options => installService(options.config));
for (const command of ["status", "restart", "stop", "logs"] as const) service.command(command).action(async () => serviceCommand(command));

program.parseAsync().catch(error => { console.error(`error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });

function makeRuntime(config: Awaited<ReturnType<typeof loadConfig>>, store?: Store): RuntimeDriver {
  return config.runtime.kind === "openclaw" ? new OpenClawDriver(config.runtime) : new CodexAcpDriver(config.runtime, store);
}

function log(event: string, fields: Record<string, unknown> = {}): void { console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields })); }

function managementCommand(configPath: string, routeId: string): string {
  const executable = resolve(process.argv[1]!);
  return `${shellQuote(process.execPath)} ${shellQuote(executable)} config wake --config ${shellQuote(configPath)} --route-id ${shellQuote(routeId)} --humans <mode>`;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

async function acquireProcessLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return async () => { await unlink(path).catch(() => undefined); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number.parseInt((await readFile(path, "utf8").catch(() => "0")).trim(), 10);
      let alive = false;
      if (pid > 0) try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      if (alive) throw new Error(`Another AAG process is already running (pid ${pid})`);
      await unlink(path);
    }
  }
  throw new Error(`Could not acquire AAG process lock: ${path}`);
}

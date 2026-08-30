#!/usr/bin/env node
import { access, constants, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { AnytypeClient } from "./anytype-client.js";
import { loadConfig } from "./config.js";
import { HeartDiscussionAdapter } from "./discussions.js";
import { Gateway } from "./gateway.js";
import { createIdentity, joinSpaces } from "./identity.js";
import { commandExists, runProcess } from "./process.js";
import { acquireProcessLock } from "./process-lock.js";
import { CodexAcpDriver } from "./runtime/codex-acp.js";
import { OpenClawDriver } from "./runtime/openclaw.js";
import { installService, serviceCommand } from "./service.js";
import { Store } from "./store.js";
import { enrollChatRoute, setRouteAccess, setRouteWake } from "./management.js";
import { runMcpServer } from "./mcp.js";
import { VERSION } from "./version.js";
import { runInitOnboarding } from "./onboarding.js";
import { modelAllowed } from "./model-command.js";
const program = new Command().name("aag").description("Anytype Agent Gateway").version(VERSION);
program
    .command("init")
    .description("Interactively onboard a Codex or OpenClaw agent")
    .option("-o, --output <path>", "configuration file")
    .action(async (options) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const result = await runInitOnboarding(prompt, {
            ...(options.output ? { output: options.output } : {}),
        });
        console.log(`\nCreated ${result.runtimeKind} agent configuration: ${result.output}`);
        console.log(`Workspace: ${result.workspace}`);
        if (result.agentsFile)
            console.log(`Workspace instructions: ${result.agentsFile}`);
        console.log("\nNext steps:");
        console.log(`  aag doctor --config ${result.output}`);
        console.log(`  aag run --config ${result.output}`);
        console.log(`  aag service install --config ${result.output}`);
    }
    finally {
        prompt.close();
    }
});
program
    .command("validate")
    .description("Validate a configuration file")
    .requiredOption("-c, --config <path>")
    .action(async (options) => {
    const config = await loadConfig(options.config);
    console.log(`valid: ${config.agent.name} (${config.runtime.kind}, ${config.spaces.length} space configuration(s))`);
});
program
    .command("doctor")
    .description("Check Anytype, configured routes, adapter, runtime, and projects")
    .requiredOption("-c, --config <path>")
    .action(async (options) => {
    const config = await loadConfig(options.config);
    await access(config.anytype.apiKeyFile, constants.R_OK);
    const anytype = await AnytypeClient.create(config);
    for (const configuredSpace of config.spaces) {
        if (!configuredSpace.id && !configuredSpace.name)
            throw new Error("Join invite-only spaces and add their id or name before running doctor");
        const space = await anytype.resolveSpace({
            ...(configuredSpace.id ? { id: configuredSpace.id } : {}),
            ...(configuredSpace.name ? { name: configuredSpace.name } : {}),
        });
        console.log(`ok: Anytype space ${space.name}`);
        for (const chatConfig of configuredSpace.chats) {
            const chat = await anytype.resolveChat(space.id, {
                ...(chatConfig.id ? { id: chatConfig.id } : {}),
                ...(chatConfig.name ? { name: chatConfig.name } : {}),
            });
            console.log(`ok: chat ${chat.name}`);
        }
        if (configuredSpace.chatDiscovery.enabled)
            console.log(`ok: chat discovery (${(await anytype.listChats(space.id)).length} current chats)`);
    }
    if (config.spaces.some((space) => space.comments.mode !== "disabled")) {
        if (!(await commandExists(config.anytype.heartAdapter.command)))
            throw new Error(`Heart adapter not found: ${config.anytype.heartAdapter.command}`);
        console.log(`ok: Heart discussion adapter ${config.anytype.heartAdapter.command}`);
    }
    const runtime = makeRuntime(config, undefined, resolve(options.config));
    for (const line of await runtime.doctor())
        console.log(`ok: ${line}`);
    for (const project of [config.runtime.defaultProject, ...config.runtime.allowedProjects].filter(Boolean)) {
        await access(project, constants.R_OK);
        console.log(`ok: project ${project}`);
    }
});
program
    .command("run")
    .description("Run one configured Anytype agent in the foreground")
    .requiredOption("-c, --config <path>")
    .action(async (options) => {
    const config = await loadConfig(options.config);
    const anytype = await AnytypeClient.create(config);
    const releaseLock = await acquireProcessLock(`${config.state.path}.lock`);
    let store;
    try {
        store = new Store(config.state.path);
        const configPath = resolve(options.config);
        const gateway = new Gateway(anytype, makeRuntime(config, store, configPath), config, store, new HeartDiscussionAdapter(config), log, (routeId, actorId) => managementCommand(config, configPath, routeId, actorId), (spaceId, spaceName, chatId, chatName, wake) => enrollChatRoute({ configPath, spaceId, spaceName, chatId, chatName, wake }));
        const stop = () => gateway.stop({ drain: true });
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        await gateway.start();
    }
    finally {
        store?.close();
        await releaseLock();
    }
});
const config = program.command("config").description("Manage constrained runtime configuration");
config
    .command("wake")
    .description("Set the human wake mode for one AAG route")
    .requiredOption("-c, --config <path>")
    .requiredOption("--route-id <id>")
    .requiredOption("--humans <mode>")
    .option("--prefix <text>")
    .action(async (options) => {
    await setRouteWake({
        configPath: options.config,
        routeId: options.routeId,
        humans: options.humans,
        ...(options.prefix ? { prefix: options.prefix } : {}),
    });
    console.log(`Updated ${options.routeId} to humans=${options.humans}. The running gateway will apply it to the next message.`);
});
config
    .command("access")
    .description("Change the participant allowlist for one AAG route")
    .requiredOption("-c, --config <path>")
    .requiredOption("--route-id <id>")
    .requiredOption("--actor-id <id>")
    .requiredOption("--operation <operation>")
    .requiredOption("--participant-id <id...>")
    .action(async (options) => {
    const allowedUsers = await setRouteAccess({
        configPath: options.config,
        routeId: options.routeId,
        actorId: options.actorId,
        operation: options.operation,
        participantIds: options.participantId,
    });
    console.log(`Updated ${options.routeId} participant access. ${allowedUsers.length} participant(s) are now allowed. The running gateway will apply it to the next message.`);
});
config
    .command("models")
    .description("List cached native harness models for one conversation")
    .requiredOption("-c, --config <path>")
    .requiredOption("--thread-key <key>")
    .action(async (options) => {
    const loaded = await loadConfig(options.config);
    if (!loaded.models.enabled)
        throw new Error("Model selection is disabled");
    const store = new Store(loaded.state.path);
    try {
        const runtime = loaded.runtime.kind === "openclaw" ? "openclaw" : "codex-acp";
        const state = store.conversationModel(options.threadKey, runtime);
        if (!state?.catalog.length) {
            console.log("No model catalog is cached yet. Send /models in the Anytype conversation first.");
            return;
        }
        for (const model of state.catalog)
            console.log(`${model.id}${model.id === state.appliedModelId ? " (current)" : ""} — ${model.name}`);
    }
    finally {
        store.close();
    }
});
config
    .command("model")
    .description("Select a cached native harness model for one conversation")
    .requiredOption("-c, --config <path>")
    .requiredOption("--thread-key <key>")
    .requiredOption("--model <id>")
    .action(async (options) => {
    const loaded = await loadConfig(options.config);
    if (!loaded.models.enabled)
        throw new Error("Model selection is disabled");
    if (!loaded.management.allowModelChanges)
        throw new Error("Model changes are disabled");
    const store = new Store(loaded.state.path);
    try {
        const runtime = loaded.runtime.kind === "openclaw" ? "openclaw" : "codex-acp";
        const current = store.conversationModel(options.threadKey, runtime);
        const reset = /^(?:default|reset)$/i.test(options.model);
        const model = reset
            ? undefined
            : current?.catalog.find((entry) => entry.id === options.model)?.id;
        if (!reset && !model)
            throw new Error("Use an exact cached model ID from `aag config models`");
        if (model && !modelAllowed(model, loaded.models.allowed))
            throw new Error("That model is not allowed by the agent configuration");
        store.saveConversationModel({
            threadKey: options.threadKey,
            runtime: loaded.runtime.kind === "openclaw" ? "openclaw" : "codex-acp",
            ...(model ? { requestedModelId: model } : {}),
            useDefault: reset,
            ...(current?.appliedGeneration === undefined
                ? {}
                : { appliedGeneration: current.appliedGeneration }),
            ...(current?.appliedModelId ? { appliedModelId: current.appliedModelId } : {}),
            ...(current?.defaultModelId ? { defaultModelId: current.defaultModelId } : {}),
            catalog: current?.catalog ?? [],
            updatedBy: "cli-operator",
        });
        console.log(`${model ? `Selected ${model}` : "Selected the harness default"}. The running gateway applies it on the next turn.`);
    }
    finally {
        store.close();
    }
});
program
    .command("mcp")
    .description("Run the policy-mediated Anytype tool server over stdio")
    .requiredOption("-c, --config <path>")
    .option("--route-id <id>")
    .option("--space-id <id>")
    .option("--actor-id <id>")
    .action(async (options) => runMcpServer(resolve(options.config), {
    ...(options.routeId ? { routeId: options.routeId } : {}),
    ...(options.spaceId ? { spaceId: options.spaceId } : {}),
    ...(options.actorId ? { actorId: options.actorId } : {}),
}));
const identity = program
    .command("identity")
    .description("Manage the one Anytype bot identity on this machine");
identity
    .command("create")
    .argument("<name>")
    .option("--anytype <command>", "Anytype CLI command", "anytype")
    .option("--invite <url...>", "space invite link(s)", [])
    .option("--api-key-file <path>", "where to save the API key", "./aag-anytype-api-key")
    .option("--data-path <path>")
    .action(async (name, options) => {
    const keyFile = resolve(options.apiKeyFile);
    await createIdentity({
        command: options.anytype,
        name,
        invites: options.invite,
        apiKeyFile: keyFile,
        ...(options.dataPath ? { dataPath: resolve(options.dataPath) } : {}),
    });
    console.log(`Created identity and saved its revocable API key to ${keyFile}`);
});
program
    .command("join")
    .description("Join this machine's bot identity to one or more spaces")
    .argument("<invite...>")
    .option("--anytype <command>", "Anytype CLI command", "anytype")
    .option("--data-path <path>")
    .action(async (invites, options) => {
    await joinSpaces(options.anytype, invites, options.dataPath);
});
const openclaw = program
    .command("openclaw")
    .description("Manage the bundled native OpenClaw Anytype channel");
const openclawPlugin = openclaw
    .command("plugin")
    .description("Locate or install the OpenClaw channel plugin");
openclawPlugin.command("path").action(() => console.log(bundledOpenClawPluginPath()));
openclawPlugin
    .command("install")
    .option("--openclaw <command>", "OpenClaw CLI command", "openclaw")
    .action(async (options) => {
    const path = bundledOpenClawPluginPath();
    await access(path, constants.R_OK);
    const staging = await mkdtemp(join(tmpdir(), "aag-openclaw-plugin-"));
    try {
        await cp(path, staging, { recursive: true, dereference: true, force: true });
        const result = await runProcess(options.openclaw, ["plugins", "install", "--force", staging], { timeoutMs: 120_000 });
        if (result.stdout.trim())
            console.log(result.stdout.trim());
        if (result.stderr.trim())
            console.error(result.stderr.trim());
    }
    finally {
        await rm(staging, { recursive: true, force: true });
    }
});
const service = program
    .command("service")
    .description("Manage the Linux systemd user service or macOS launch agent");
service
    .command("install")
    .requiredOption("-c, --config <path>")
    .action(async (options) => installService(options.config));
for (const command of ["status", "restart", "stop", "logs"])
    service.command(command).action(async () => serviceCommand(command));
program.parseAsync().catch((error) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
function makeRuntime(config, store, configPath) {
    if (config.runtime.kind === "openclaw")
        return new OpenClawDriver(config.runtime, undefined, config.models.enabled);
    const executable = resolve(process.argv[1]);
    const mcpServer = config.tools.anytype.enabled && configPath
        ? {
            command: resolve(process.execPath),
            args: [executable, "mcp", "--config", configPath],
            actorDirectory: join(dirname(config.state.path), "actors"),
        }
        : undefined;
    return new CodexAcpDriver(config.runtime, store, mcpServer, config.agent.name);
}
function log(event, fields = {}) {
    console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}
function managementCommand(config, configPath, routeId, actorId) {
    const executable = resolve(process.argv[1]);
    const command = `${shellQuote(process.execPath)} ${shellQuote(executable)}`;
    const commands = [];
    if (config.management.allowWakeChanges)
        commands.push(`Wake command: ${command} config wake --config ${shellQuote(configPath)} --route-id ${shellQuote(routeId)} --humans <mode>`);
    if (config.management.allowAccessChanges)
        commands.push(`Access command: ${command} config access --config ${shellQuote(configPath)} --route-id ${shellQuote(routeId)} --actor-id ${shellQuote(actorId)} --operation <add|remove|replace> --participant-id <native-participant-id>`);
    return commands.join("\n");
}
function shellQuote(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
function bundledOpenClawPluginPath() {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages", "openclaw-anytype-channel");
}

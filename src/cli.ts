#!/usr/bin/env node
import { access, constants, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { AnytypeClient } from "./anytype-client.js";
import { loadConfig } from "./config.js";
import type { ManagementActorCapabilities } from "./controller.js";
import { HeartDiscussionAdapter } from "./discussions.js";
import { Gateway } from "./gateway.js";
import { createIdentity, joinSpaces } from "./identity.js";
import { commandExists, runProcess } from "./process.js";
import { acquireCompatibleProcessLocks } from "./process-lock.js";
import { CodexAcpDriver } from "./runtime/codex-acp.js";
import { OpenClawDriver } from "./runtime/openclaw.js";
import { installService, migrateService, serviceCommand } from "./service.js";
import { Store } from "./store.js";
import { enrollChatRoute, setRouteAccess, setRouteWake } from "./management.js";
import { runMcpServer } from "./mcp.js";
import type { RuntimeDriver } from "./types.js";
import { VERSION } from "./version.js";
import { runInitOnboarding } from "./onboarding.js";
import { modelAllowed } from "./model-command.js";
import { sameIdentity } from "./wake.js";
import { PRODUCT, resolveConfigPath } from "./compatibility.js";
import { migrateInstallation } from "./migration.js";
import {
  DEFAULT_CLOUD_SCOPES,
  DEFAULT_CLOUD_URL,
  cloudDoctor,
  cloudLogin,
  cloudPair,
  cloudRevoke,
  cloudStatus,
} from "./cloud-cli.js";
import {
  publicationAction,
  publicationOperationStatus,
  preparePublicationAssetManifest,
  readPublicationDocument,
  retryPublicationOperation,
} from "./cloud-publication.js";
import { cloudCommandAction, cloudCommandList, cloudCommandShow } from "./cloud-command-cli.js";

const program = new Command()
  .name(PRODUCT.current.executable)
  .description(PRODUCT.current.name)
  .version(VERSION);

program
  .command("migrate")
  .description("Copy and verify a legacy AAG installation without modifying it")
  .option("-c, --config <path>", "legacy AAG agent.yaml to migrate")
  .option("--dry-run", "print the migration plan without writing")
  .option("--json", "emit a machine-readable result")
  .action(async (options) => {
    const result = await migrateInstallation({
      dryRun: Boolean(options.dryRun),
      ...(options.config ? { legacyConfigPath: resolve(options.config) } : {}),
    });
    if (options.json) console.log(JSON.stringify(result));
    else {
      for (const item of result.items)
        console.log(`${item.status}: ${item.source} -> ${item.destination}`);
      if (result.manifest) console.log(`manifest: ${result.manifest}`);
      console.log(`rollback: ${result.rollback.join(" && ")}`);
    }
  });

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
      if (result.agentsFile) console.log(`Workspace instructions: ${result.agentsFile}`);
      console.log("\nNext steps:");
      console.log(`  knot doctor --config ${result.output}`);
      console.log(`  knot run --config ${result.output}`);
      console.log(`  knot service install --config ${result.output}`);
    } finally {
      prompt.close();
    }
  });

program
  .command("validate")
  .description("Validate a configuration file")
  .option(
    "-c, --config <path>",
    "configuration file (defaults to an existing AAG path, then ~/.config/knot/agent.yaml)",
  )
  .action(async (options) => {
    const config = await loadConfig(selectedConfigPath(options.config));
    console.log(
      `valid: ${config.agent.name} (${config.runtime.kind}, ${config.spaces.length} space configuration(s))`,
    );
  });

program
  .command("doctor")
  .description("Check Anytype, configured routes, adapter, runtime, and projects")
  .option("-c, --config <path>", "configuration file (discovers an existing AAG config first)")
  .action(async (options) => {
    const configPath = selectedConfigPath(options.config);
    const config = await loadConfig(configPath);
    const legacyConfig = configPath.includes("/.config/aag/");
    const legacyState = config.state.path.includes("/.local/state/aag/");
    console.log(
      `ok: migration compatibility (config=${legacyConfig ? "legacy" : "knot"}, state=${legacyState ? "legacy" : "knot"})`,
    );
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
        console.log(
          `ok: chat discovery (${(await anytype.listChats(space.id)).length} current chats)`,
        );
    }
    if (config.directMessages.enabled) {
      const spaces = await anytype.listSpaces();
      const observedKinds = [...new Set(spaces.map((space) => space.object ?? "missing"))].sort();
      const directSpaces = spaces.filter((space) => space.object === "anytype.onetoone");
      let authorized = 0;
      for (const space of directSpaces) {
        const members = (await anytype.listMembers(space.id)).filter(
          (member) => member.status === "active",
        );
        const self = members.find((member) =>
          sameIdentity(member.identity ?? member.id, config.agent.participantId),
        );
        const peers = members.filter(
          (member) => !sameIdentity(member.identity ?? member.id, config.agent.participantId),
        );
        if (
          self &&
          peers.length === 1 &&
          config.directMessages.wake.allowedUsers.some((allowed) =>
            sameIdentity(peers[0]!.identity ?? peers[0]!.id, allowed),
          )
        )
          authorized += 1;
        await anytype.listChats(space.id);
      }
      console.log(
        `ok: direct message discovery (${directSpaces.length} current DMs, ${authorized} authorized; observed kinds: ${observedKinds.join(", ") || "none"})`,
      );
      if (!directSpaces.length)
        console.warn(
          "warning: direct messages are enabled, but Anytype reported no anytype.onetoone spaces",
        );
      else if (!authorized)
        console.warn(
          "warning: direct messages are enabled, but no active one-to-one peer matched directMessages.wake.allowedUsers",
        );
    }
    if (config.spaces.some((space) => space.comments.mode !== "disabled")) {
      if (!(await commandExists(config.anytype.heartAdapter.command)))
        throw new Error(`Heart adapter not found: ${config.anytype.heartAdapter.command}`);
      console.log(`ok: Heart discussion adapter ${config.anytype.heartAdapter.command}`);
    }
    if (config.automation.enabled && config.automation.observation) {
      let visible = 0;
      let verifiedEditors = 0;
      let authorizedEditors = 0;
      for (const spaceId of config.automation.allowedSpaceIds) {
        const definitions = await anytype.searchWorkflowObjects(
          spaceId,
          config.automation.definitionTypeKeys,
          0,
          10,
        );
        visible += definitions.length;
        verifiedEditors += definitions.filter(
          (definition) => !definition.observationError && definition.editorParticipantId,
        ).length;
        authorizedEditors += definitions.filter(
          (definition) =>
            !definition.observationError &&
            definition.editorParticipantId &&
            config.automation.allowedAuthorIds.includes(definition.editorParticipantId),
        ).length;
      }
      console.log(
        `ok: read-only workflow observer (${config.automation.allowedSpaceIds.length} spaces, ${config.automation.definitionTypeKeys.length} type keys, ${visible} visible sample definitions, ${verifiedEditors} with native editor identity)`,
      );
      if (visible > 0 && verifiedEditors === 0)
        console.warn(
          "warning: Anytype did not expose the last_modified_by system object property; workflow definitions will remain invalid",
        );
      else if (visible > 0 && authorizedEditors === 0)
        console.warn(
          "warning: visible workflow definitions have verified editors, but none match automation.allowedAuthorIds",
        );
      if (config.automation.execution)
        console.log(
          `ok: durable workflow runner (${config.automation.runner.workerCount} workers, ${config.automation.runner.leaseSeconds}s leases; cloud commands ${config.cloudCommands.enabled ? "enabled" : "disabled"})`,
        );
    }
    const runtime = makeRuntime(config, undefined, configPath);
    for (const line of await runtime.doctor()) console.log(`ok: ${line}`);
    for (const project of [config.runtime.defaultProject, ...config.runtime.allowedProjects].filter(
      Boolean,
    ) as string[]) {
      await access(project, constants.R_OK);
      console.log(`ok: project ${project}`);
    }
  });

program
  .command("run")
  .description("Run one configured Anytype agent in the foreground")
  .option("-c, --config <path>", "configuration file (discovers an existing AAG config first)")
  .action(async (options) => {
    const selectedPath = selectedConfigPath(options.config);
    const config = await loadConfig(selectedPath);
    const anytype = await AnytypeClient.create(config);
    const releaseLock = await acquireCompatibleProcessLocks(config.state.path);
    let store: Store | undefined;
    try {
      store = new Store(config.state.path);
      const configPath = resolve(selectedPath);
      const gateway = new Gateway(
        anytype,
        makeRuntime(config, store, configPath),
        config,
        store,
        new HeartDiscussionAdapter(config),
        log,
        (routeId, capabilities) => managementCommand(config, routeId, capabilities),
        (spaceId, spaceName, chatId, chatName, wake) =>
          enrollChatRoute({ configPath, spaceId, spaceName, chatId, chatName, wake }),
      );
      const stop = () => gateway.stop({ drain: true });
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await gateway.start();
    } finally {
      store?.close();
      await releaseLock();
    }
  });

const config = program.command("config").description("Manage constrained runtime configuration");
config
  .command("wake")
  .description("Set the human wake mode for one Knot route")
  .requiredOption("-c, --config <path>")
  .requiredOption("--route-id <id>")
  .requiredOption("--humans <mode>")
  .option("--prefix <text>")
  .action(async (options) => {
    await setRouteWake({
      configPath: selectedConfigPath(options.config),
      routeId: options.routeId,
      humans: options.humans,
      ...(options.prefix ? { prefix: options.prefix } : {}),
    });
    console.log(
      `Updated ${options.routeId} to humans=${options.humans}. The running gateway will apply it to the next message.`,
    );
  });
config
  .command("access")
  .description("Change the participant allowlist for one Knot route")
  .requiredOption("-c, --config <path>")
  .requiredOption("--route-id <id>")
  .requiredOption("--operation <operation>")
  .requiredOption("--participant-id <id...>")
  .action(async (options) => {
    const allowedUsers = await setRouteAccess({
      configPath: selectedConfigPath(options.config),
      routeId: options.routeId,
      operation: options.operation,
      participantIds: options.participantId,
    });
    console.log(
      `Updated ${options.routeId} participant access. ${allowedUsers.length} participant(s) are now allowed. The running gateway will apply it to the next message.`,
    );
  });
config
  .command("models")
  .description("List cached native harness models for one conversation")
  .option("-c, --config <path>", "configuration file (discovers an existing AAG config first)")
  .requiredOption("--thread-key <key>")
  .action(async (options) => {
    const loaded = await loadConfig(selectedConfigPath(options.config));
    if (!loaded.models.enabled) throw new Error("Model selection is disabled");
    const store = new Store(loaded.state.path);
    try {
      const runtime = loaded.runtime.kind === "openclaw" ? "openclaw" : "codex-acp";
      const state = store.conversationModel(options.threadKey, runtime);
      if (!state?.catalog.length) {
        console.log(
          "No model catalog is cached yet. Send /models in the Anytype conversation first.",
        );
        return;
      }
      for (const model of state.catalog)
        console.log(
          `${model.id}${model.id === state.appliedModelId ? " (current)" : ""} — ${model.name}`,
        );
    } finally {
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
    const loaded = await loadConfig(selectedConfigPath(options.config));
    if (!loaded.models.enabled) throw new Error("Model selection is disabled");
    if (!loaded.management.allowModelChanges) throw new Error("Model changes are disabled");
    const store = new Store(loaded.state.path);
    try {
      const runtime = loaded.runtime.kind === "openclaw" ? "openclaw" : "codex-acp";
      const current = store.conversationModel(options.threadKey, runtime);
      const reset = /^(?:default|reset)$/i.test(options.model);
      const model = reset
        ? undefined
        : current?.catalog.find((entry) => entry.id === options.model)?.id;
      if (!reset && !model)
        throw new Error("Use an exact cached model ID from `knot config models`");
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
      console.log(
        `${model ? `Selected ${model}` : "Selected the harness default"}. The running gateway applies it on the next turn.`,
      );
    } finally {
      store.close();
    }
  });

program
  .command("mcp")
  .description("Run the policy-mediated Anytype tool server over stdio")
  .option("-c, --config <path>", "configuration file")
  .option("--route-id <id>")
  .option("--space-id <id>")
  .action(async (options) =>
    runMcpServer(selectedConfigPath(options.config), {
      ...(options.routeId ? { routeId: options.routeId } : {}),
      ...(options.spaceId ? { spaceId: options.spaceId } : {}),
    }),
  );

const cloud = program
  .command("cloud")
  .description("Connect this local Knot runtime to Knot Cloud without exposing a listener");
cloud
  .command("login")
  .description("Prepare a local connector identity and verify the Cloud server")
  .option("--url <url>", "Knot Cloud server", DEFAULT_CLOUD_URL)
  .option("--name <name>", "connector name shown during pairing")
  .option("--scope <scope...>", "requested connector scopes", DEFAULT_CLOUD_SCOPES)
  .option("--slug-grant <slug...>", "requested publication slug grants", [])
  .option("--asset-root <path...>", "local roots allowed for publication asset manifests")
  .option("--config <path>", "cloud configuration file")
  .action(async (options) => {
    await cloudLogin({
      baseUrl: options.url,
      ...(options.name ? { connectorName: options.name } : {}),
      scopes: options.scope,
      slugGrants: options.slugGrant,
      ...(options.assetRoot ? { assetRoots: options.assetRoot } : {}),
      ...(options.config ? { configFile: options.config } : {}),
    });
  });
cloud
  .command("pair")
  .description("Consume one-time dashboard credentials and wait for pairing approval")
  .option("--credentials-file <path>", "one-time pairing JSON file, or - for stdin")
  .option("--once", "poll once instead of waiting")
  .option("--timeout <seconds>", "maximum time to wait", "600")
  .option("--config <path>", "cloud configuration file")
  .action(async (options) => {
    const timeoutSeconds = Number(options.timeout);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3_600)
      throw new Error("--timeout must be an integer from 1 to 3600 seconds");
    await cloudPair({
      ...(options.credentialsFile ? { credentialsFile: options.credentialsFile } : {}),
      once: Boolean(options.once),
      timeoutSeconds,
      ...(options.config ? { configFile: options.config } : {}),
    });
  });
cloud
  .command("status")
  .description("Show local pairing state and check the Cloud server")
  .option("--json", "emit a machine-readable result")
  .option("--config <path>", "cloud configuration file")
  .action(async (options) => {
    await cloudStatus({
      json: Boolean(options.json),
      ...(options.config ? { configFile: options.config } : {}),
    });
  });
cloud
  .command("doctor")
  .description("Check the local Cloud identity, permissions, and protocol")
  .option("--config <path>", "cloud configuration file")
  .action(async (options) =>
    cloudDoctor({ ...(options.config ? { configFile: options.config } : {}) }),
  );
cloud
  .command("revoke")
  .description("Open the remote revocation path or remove local connector credentials")
  .option("--forget-local", "remove the local key and Cloud configuration after remote revocation")
  .option("--config <path>", "cloud configuration file")
  .action(async (options) =>
    cloudRevoke({
      forgetLocal: Boolean(options.forgetLocal),
      ...(options.config ? { configFile: options.config } : {}),
    }),
  );

const cloudOperation = cloud
  .command("operation")
  .description("Inspect or retry a durable local Cloud publication operation");
cloudOperation
  .command("status")
  .argument("<operation-id>")
  .option("--config <path>", "cloud configuration file")
  .action(async (operationId, options) => {
    console.log(
      JSON.stringify(
        await publicationOperationStatus({
          operationId,
          ...(options.config ? { configFile: options.config } : {}),
        }),
        null,
        2,
      ),
    );
  });

const cloudCommands = cloud
  .command("commands")
  .description("Inspect and control durable cloud-to-local workflow commands");
cloudCommands
  .command("list")
  .requiredOption("--agent-config <path>", "Knot agent configuration file")
  .option("--limit <count>", "maximum records", "100")
  .option("--json", "emit machine-readable records")
  .action(async (options) => {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error("--limit must be an integer from 1 to 500");
    await cloudCommandList({
      agentConfigFile: selectedConfigPath(options.agentConfig),
      limit,
      json: Boolean(options.json),
    });
  });
cloudCommands
  .command("show")
  .argument("<command-id>")
  .requiredOption("--agent-config <path>", "Knot agent configuration file")
  .action(async (commandId, options) =>
    cloudCommandShow({
      agentConfigFile: selectedConfigPath(options.agentConfig),
      commandId,
    }),
  );
for (const action of ["approve", "cancel", "retry"] as const)
  cloudCommands
    .command(action)
    .argument("<command-id>")
    .requiredOption("--agent-config <path>", "Knot agent configuration file")
    .action(async (commandId, options) =>
      cloudCommandAction({
        agentConfigFile: selectedConfigPath(options.agentConfig),
        commandId,
        action,
      }),
    );
cloudCommands
  .command("reject")
  .argument("<command-id>")
  .requiredOption("--agent-config <path>", "Knot agent configuration file")
  .option("--reason <code>", "stable local rejection reason", "operator-rejected")
  .action(async (commandId, options) =>
    cloudCommandAction({
      agentConfigFile: selectedConfigPath(options.agentConfig),
      commandId,
      action: "reject",
      reasonCode: options.reason,
    }),
  );
cloudOperation
  .command("retry")
  .argument("<operation-id>")
  .option("--force", "re-attempt a terminal failure and restart asset checkpoints")
  .option("--config <path>", "cloud configuration file")
  .action(async (operationId, options) => {
    console.log(
      JSON.stringify(
        await retryPublicationOperation({
          operationId,
          force: Boolean(options.force),
          ...(options.config ? { configFile: options.config } : {}),
        }),
        null,
        2,
      ),
    );
  });

const publish = program
  .command("publish")
  .description("Publish typed documents through the paired Knot Cloud connector");
publish
  .command("push")
  .argument("<document>", "typed publication JSON file, or - for stdin")
  .requiredOption("--site <uuid>", "approved Cloud site ID")
  .requiredOption("--publication <uuid>", "stable publication ID")
  .requiredOption("--slug <slug>", "approved publication slug")
  .option("--operation <mode>", "create or update", "create")
  .option("--asset-manifest <path>", "typed local asset manifest to approve before publishing")
  .option("--asset-manifest-id <uuid>", "previously approved local asset manifest")
  .option("--config <path>", "cloud configuration file")
  .action(async (documentPath, options) => {
    if (!["create", "update"].includes(options.operation))
      throw new Error("--operation must be create or update");
    if (options.assetManifest && options.assetManifestId)
      throw new Error("Use either --asset-manifest or --asset-manifest-id, not both");
    const configFile = options.config ? { configFile: options.config } : {};
    const prepared = options.assetManifest
      ? await preparePublicationAssetManifest({
          manifestPath: options.assetManifest,
          ...configFile,
        })
      : undefined;
    console.log(
      JSON.stringify(
        await publicationAction({
          action: "push",
          siteId: options.site,
          publicationId: options.publication,
          slug: options.slug,
          operation: options.operation,
          document: await readPublicationDocument(documentPath),
          ...(prepared?.manifestId
            ? { assetManifestId: prepared.manifestId }
            : options.assetManifestId
              ? { assetManifestId: options.assetManifestId }
              : {}),
          ...configFile,
        }),
        null,
        2,
      ),
    );
  });
const publishAssets = publish
  .command("assets")
  .description("Prepare bounded local assets for a later CLI or aag_publish request");
publishAssets
  .command("prepare")
  .argument("<manifest>", "JSON manifest containing approved local asset paths")
  .option("--config <path>", "cloud configuration file")
  .action(async (manifestPath, options) => {
    console.log(
      JSON.stringify(
        await preparePublicationAssetManifest({
          manifestPath,
          ...(options.config ? { configFile: options.config } : {}),
        }),
        null,
        2,
      ),
    );
  });
publish
  .command("status")
  .argument("<publication-id>")
  .option("--config <path>", "cloud configuration file")
  .action(async (publicationId, options) => {
    console.log(
      JSON.stringify(
        await publicationAction({
          action: "status",
          publicationId,
          ...(options.config ? { configFile: options.config } : {}),
        }),
        null,
        2,
      ),
    );
  });
publish
  .command("rollback")
  .argument("<publication-id>")
  .requiredOption("--version <uuid>", "version to make current")
  .option("--config <path>", "cloud configuration file")
  .action(async (publicationId, options) => {
    console.log(
      JSON.stringify(
        await publicationAction({
          action: "rollback",
          publicationId,
          versionId: options.version,
          ...(options.config ? { configFile: options.config } : {}),
        }),
        null,
        2,
      ),
    );
  });
publish
  .command("disable")
  .argument("<publication-id>")
  .option("--config <path>", "cloud configuration file")
  .action(async (publicationId, options) => {
    console.log(
      JSON.stringify(
        await publicationAction({
          action: "disable",
          publicationId,
          ...(options.config ? { configFile: options.config } : {}),
        }),
        null,
        2,
      ),
    );
  });
publish
  .command("unpublish")
  .argument("<publication-id>")
  .requiredOption("--confirm <uuid>", "repeat the publication ID to confirm destructive removal")
  .option("--config <path>", "cloud configuration file")
  .action(async (publicationId, options) => {
    console.log(
      JSON.stringify(
        await publicationAction({
          action: "unpublish",
          publicationId,
          confirmation: options.confirm,
          ...(options.config ? { configFile: options.config } : {}),
        }),
        null,
        2,
      ),
    );
  });

const identity = program
  .command("identity")
  .description("Manage the one Anytype bot identity on this machine");
identity
  .command("create")
  .argument("<name>")
  .option("--anytype <command>", "Anytype CLI command", "anytype")
  .option("--invite <url...>", "space invite link(s)", [])
  .option("--api-key-file <path>", "where to save the API key", "./knot-anytype-api-key")
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
    const staging = await mkdtemp(join(tmpdir(), "knot-openclaw-plugin-"));
    try {
      await cp(path, staging, { recursive: true, dereference: true, force: true });
      const result = await runProcess(
        options.openclaw,
        ["plugins", "install", "--force", staging],
        { timeoutMs: 120_000 },
      );
      if (result.stdout.trim()) console.log(result.stdout.trim());
      if (result.stderr.trim()) console.error(result.stderr.trim());
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

const service = program
  .command("service")
  .description("Manage the Linux systemd user service or macOS launch agent");
service
  .command("install")
  .requiredOption("-c, --config <path>")
  .action(async (options) => installService(selectedConfigPath(options.config)));
service
  .command("migrate")
  .description("Safely replace an exact legacy AAG service with Knot")
  .option("-c, --config <path>", "legacy AAG agent.yaml to migrate")
  .option("--dry-run", "print the service migration plan without writing")
  .option("--json", "emit a machine-readable result")
  .action(async (options) => {
    const result = await migrateService({
      dryRun: Boolean(options.dryRun),
      ...(options.config ? { legacyConfigPath: resolve(options.config) } : {}),
    });
    console.log(options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  });
for (const command of ["status", "restart", "stop", "logs"] as const)
  service.command(command).action(async () => serviceCommand(command));

program.parseAsync().catch((error) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

function makeRuntime(
  config: Awaited<ReturnType<typeof loadConfig>>,
  store?: Store,
  configPath?: string,
): RuntimeDriver {
  if (config.runtime.kind === "openclaw")
    return new OpenClawDriver(config.runtime, undefined, config.models.enabled);
  const executable = resolve(process.argv[1]!);
  const mcpServer =
    (config.tools.anytype.enabled || config.tools.publish.enabled) && configPath
      ? {
          command: resolve(process.execPath),
          args: [executable, "mcp", "--config", configPath],
          actorDirectory: join(dirname(config.state.path), "actors"),
        }
      : undefined;
  return new CodexAcpDriver(config.runtime, store, mcpServer, config.agent.name);
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

function managementCommand(
  config: Awaited<ReturnType<typeof loadConfig>>,
  routeId: string,
  capabilities?: ManagementActorCapabilities,
): string {
  const commands: string[] = [];
  if (config.management.allowWakeChanges)
    commands.push(
      `Wake tool: aag_set_wake with route_id=${JSON.stringify(routeId)}, humans=<mode>${capabilities?.wake ? `, and actor_capability=${JSON.stringify(capabilities.wake)}` : ""}`,
    );
  if (config.management.allowAccessChanges)
    commands.push(
      `Access tool: aag_set_access with route_id=${JSON.stringify(routeId)}, operation=<add|remove|replace>, participant_ids=[<native-participant-id>]${capabilities?.access ? `, and actor_capability=${JSON.stringify(capabilities.access)}` : ""}`,
    );
  if (config.models.enabled && config.management.allowModelChanges && capabilities?.model)
    commands.push(
      `Model tool: aag_set_model with route_id=${JSON.stringify(routeId)}, model_id=<exact-model-or-default>, and actor_capability=${JSON.stringify(capabilities.model)}`,
    );
  if (config.tools.publish.enabled)
    commands.push(
      `Publish tool: aag_publish with one configured typed action${capabilities?.publish ? ` and actor_capability=${JSON.stringify(capabilities.publish)}` : ""}`,
    );
  return commands.join("\n");
}

function bundledOpenClawPluginPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "packages",
    "openclaw-anytype-channel",
  );
}

function selectedConfigPath(explicit?: string): string {
  return resolveConfigPath({ ...(explicit ? { explicit } : {}) });
}

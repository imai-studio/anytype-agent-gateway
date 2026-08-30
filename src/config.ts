import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import YAML from "yaml";
import { z } from "zod";
import { resolveHeartBinary, resolveStatePath } from "./compatibility.js";

const wakeSchema = z
  .object({
    humans: z
      .enum(["mention", "mention-or-reply", "every-message", "prefix", "disabled"])
      .default("mention"),
    agents: z.enum(["never", "direct-mention", "every-message"]).default("direct-mention"),
    prefix: z.string().optional(),
    allowedUsers: z.array(z.string().min(1)).min(1),
  })
  .refine(
    (value) => value.humans !== "prefix" || value.prefix,
    "wake.prefix is required for prefix mode",
  );

const disabledWake = {
  humans: "disabled" as const,
  agents: "never" as const,
  allowedUsers: ["__disabled__"],
};
const chatSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    wake: wakeSchema,
  })
  .refine((value) => value.id || value.name, "chat id or name is required");

const commentsSchema = z
  .object({
    mode: z.enum(["all", "filtered", "disabled"]).default("disabled"),
    includeObjectTypes: z.array(z.string()).default([]),
    excludeObjectTypes: z.array(z.string()).default([]),
    discoveryIntervalSeconds: z.number().int().min(10).default(60),
    createMissing: z.boolean().default(false),
    wake: wakeSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.mode !== "disabled" && !value.wake)
      context.addIssue({
        code: "custom",
        path: ["wake"],
        message: "comments.wake is required when comments are enabled",
      });
    if (value.mode === "filtered" && value.includeObjectTypes.length === 0)
      context.addIssue({
        code: "custom",
        path: ["includeObjectTypes"],
        message: "comments.includeObjectTypes is required for filtered mode",
      });
  })
  .transform((value) => ({ ...value, wake: value.wake ?? disabledWake }));

const chatDiscoverySchema = z
  .object({
    enabled: z.boolean().default(false),
    autoEnroll: z.boolean().default(false),
    discoveryIntervalSeconds: z.number().int().min(10).default(30),
    wake: wakeSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.enabled && !value.wake)
      context.addIssue({
        code: "custom",
        path: ["wake"],
        message: "chatDiscovery.wake is required when chat discovery is enabled",
      });
    if (value.autoEnroll && !value.enabled)
      context.addIssue({
        code: "custom",
        path: ["enabled"],
        message: "chatDiscovery.enabled is required when auto enrollment is enabled",
      });
    if (
      value.autoEnroll &&
      value.wake &&
      value.wake.humans !== "mention" &&
      value.wake.humans !== "mention-or-reply"
    )
      context.addIssue({
        code: "custom",
        path: ["wake", "humans"],
        message: "chatDiscovery.autoEnroll requires a mention-based human wake policy",
      });
    if (value.autoEnroll && value.wake?.allowedUsers.includes("*"))
      context.addIssue({
        code: "custom",
        path: ["wake", "allowedUsers"],
        message: "chatDiscovery.autoEnroll requires an explicit sender allowlist",
      });
  })
  .transform((value) => ({ ...value, wake: value.wake ?? disabledWake }));

const directMessagesSchema = z
  .object({
    enabled: z.boolean().default(false),
    createMissing: z.boolean().default(false),
    discoveryIntervalSeconds: z.number().int().min(10).default(30),
    wake: wakeSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.enabled && !value.wake)
      context.addIssue({
        code: "custom",
        path: ["wake"],
        message: "directMessages.wake is required when direct messages are enabled",
      });
    if (value.enabled && value.wake && value.wake.humans !== "every-message")
      context.addIssue({
        code: "custom",
        path: ["wake", "humans"],
        message: "directMessages requires every-message human wake behavior",
      });
    if (value.enabled && value.wake?.allowedUsers.includes("*"))
      context.addIssue({
        code: "custom",
        path: ["wake", "allowedUsers"],
        message: "directMessages requires an explicit sender allowlist",
      });
  })
  .transform((value) => ({ ...value, wake: value.wake ?? disabledWake }));

const routeWakeOverrideSchema = z.object({
  kind: z.enum(["chat", "discussion"]),
  id: z.string().min(1),
  wake: wakeSchema,
});

const spaceSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    participantId: z.string().optional(),
    invite: z.string().url().optional(),
    chats: z.array(chatSchema).default([]),
    wakeOverrides: z.array(routeWakeOverrideSchema).default([]),
    chatDiscovery: chatDiscoverySchema.default({
      enabled: false,
      autoEnroll: false,
      discoveryIntervalSeconds: 30,
      wake: disabledWake,
    }),
    comments: commentsSchema.default({
      mode: "disabled",
      includeObjectTypes: [],
      excludeObjectTypes: [],
      discoveryIntervalSeconds: 60,
      createMissing: false,
      wake: disabledWake,
    }),
  })
  .superRefine((value, context) => {
    if (
      value.chatDiscovery.autoEnroll &&
      value.wakeOverrides.some(
        (override) => override.kind === "chat" && override.wake.allowedUsers.includes("*"),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["wakeOverrides"],
        message: "Chat auto-enrollment does not allow wildcard route overrides",
      });
  })
  .refine(
    (value) => value.id || value.name || value.invite,
    "space id, name, or invite is required",
  );

const baseRuntime = {
  defaultProject: z.string().optional(),
  allowedProjects: z.array(z.string()).default([]),
  environment: z.record(z.string(), z.string()).default({}),
  // timeoutSeconds remains the backward-compatible inactivity watchdog.
  timeoutSeconds: z.number().int().nonnegative().default(0),
  inactivityTimeoutSeconds: z.number().int().nonnegative().optional(),
  maxRunSeconds: z.number().int().nonnegative().default(0),
  setupTimeoutSeconds: z.number().int().positive().default(30),
  livenessProbeSeconds: z.number().int().positive().default(25),
  terminationGraceSeconds: z.number().int().nonnegative().default(20),
};

const runtimeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("openclaw"),
    ...baseRuntime,
    command: z.string().default("openclaw"),
    agentId: z.string().default("main"),
    sessionKey: z.string().optional(),
    gateway: z
      .object({
        url: z.string().url().default("ws://127.0.0.1:18789"),
        configFile: z.string().default("~/.openclaw/openclaw.json"),
        tokenEnv: z.string().default("OPENCLAW_GATEWAY_TOKEN"),
        clientModule: z.string().default("@openclaw/gateway-client"),
        protocolVersion: z.number().int().positive().default(4),
      })
      .default({
        url: "ws://127.0.0.1:18789",
        configFile: "~/.openclaw/openclaw.json",
        tokenEnv: "OPENCLAW_GATEWAY_TOKEN",
        clientModule: "@openclaw/gateway-client",
        protocolVersion: 4,
      }),
    channelBridge: z
      .object({
        enabled: z.boolean().default(false),
        url: z.string().url().default("http://127.0.0.1:18791"),
        tokenEnv: z.string().default("KNOT_OPENCLAW_BRIDGE_TOKEN"),
        tokenFile: z.string().optional(),
        accountId: z.string().default("default"),
        pollIntervalMilliseconds: z.number().int().min(100).max(10000).default(500),
      })
      .default({
        enabled: false,
        url: "http://127.0.0.1:18791",
        tokenEnv: "KNOT_OPENCLAW_BRIDGE_TOKEN",
        accountId: "default",
        pollIntervalMilliseconds: 500,
      }),
  }),
  z.object({
    kind: z.literal("codex"),
    ...baseRuntime,
    command: z.string().default("codex-acp"),
    args: z.array(z.string()).default([]),
    permissions: z.enum(["deny", "allow-once"]).default("deny"),
    desktopProject: z.enum(["disabled", "auto"]).default("disabled"),
  }),
]);

export const configSchema = z.object({
  version: z.literal(1),
  agent: z.object({
    name: z.string().trim().min(1),
    participantId: z.string().min(1),
    aliases: z.array(z.string()).default([]),
  }),
  anytype: z.object({
    apiBase: z.string().url().default("http://127.0.0.1:31012"),
    apiVersion: z.string().default("2025-11-08"),
    apiKeyFile: z.string(),
    cli: z
      .object({
        command: z.string().default("anytype"),
        configPath: z.string().optional(),
        dataPath: z.string().optional(),
      })
      .default({ command: "anytype" }),
    heartAdapter: z
      .object({
        command: z.string().default("knot-heart-adapter"),
        grpcAddress: z.string().default("127.0.0.1:31010"),
      })
      .default({ command: "knot-heart-adapter", grpcAddress: "127.0.0.1:31010" }),
  }),
  directMessages: directMessagesSchema.default({
    enabled: false,
    createMissing: false,
    discoveryIntervalSeconds: 30,
    wake: disabledWake,
  }),
  spaces: z.array(spaceSchema).min(1),
  runtime: runtimeSchema,
  models: z
    .object({
      enabled: z.boolean().default(false),
      allowed: z.array(z.string()).default(["*"]),
    })
    .default({ enabled: false, allowed: ["*"] }),
  management: z
    .object({
      allowWakeChanges: z.boolean().default(false),
      allowAccessChanges: z.boolean().default(false),
      allowModelChanges: z.boolean().default(false),
      allowProjectChanges: z.boolean().default(false),
      accessAdmins: z.array(z.string().min(1)).default([]),
      modelAdmins: z.array(z.string().min(1)).default([]),
      projectAdmins: z.array(z.string().min(1)).default([]),
    })
    .superRefine((value, context) => {
      if (value.allowAccessChanges && value.accessAdmins.length === 0)
        context.addIssue({
          code: "custom",
          path: ["accessAdmins"],
          message: "management.accessAdmins is required when access changes are enabled",
        });
      if (value.allowModelChanges && value.modelAdmins.length === 0)
        context.addIssue({
          code: "custom",
          path: ["modelAdmins"],
          message: "management.modelAdmins is required when model changes are enabled",
        });
      if (value.allowProjectChanges && value.projectAdmins.length === 0)
        context.addIssue({
          code: "custom",
          path: ["projectAdmins"],
          message: "management.projectAdmins is required when project changes are enabled",
        });
    })
    .default({
      allowWakeChanges: false,
      allowAccessChanges: false,
      allowModelChanges: false,
      allowProjectChanges: false,
      accessAdmins: [],
      modelAdmins: [],
      projectAdmins: [],
    }),
  tools: z
    .object({
      anytype: z
        .object({
          enabled: z.boolean().default(false),
          allowWrite: z.boolean().default(false),
          allowArchive: z.boolean().default(false),
          allowedSpaceIds: z.array(z.string()).default([]),
          allowedFileRoots: z.array(z.string()).default([]),
        })
        .default({
          enabled: false,
          allowWrite: false,
          allowArchive: false,
          allowedSpaceIds: [],
          allowedFileRoots: [],
        }),
      codex: z
        .object({
          enabled: z.boolean().default(false),
          command: z.string().default("codex"),
          sandbox: z.enum(["read-only", "workspace-write"]).default("workspace-write"),
        })
        .default({ enabled: false, command: "codex", sandbox: "workspace-write" }),
    })
    .default({
      anytype: {
        enabled: false,
        allowWrite: false,
        allowArchive: false,
        allowedSpaceIds: [],
        allowedFileRoots: [],
      },
      codex: { enabled: false, command: "codex", sandbox: "workspace-write" },
    }),
  responses: z
    .object({
      mode: z.enum(["single", "milestones", "verbose"]).default("single"),
      streaming: z.boolean().default(true),
      thinking: z.enum(["hidden", "stream"]).default("stream"),
      editIntervalMilliseconds: z.number().int().min(250).max(5000).default(900),
      workingText: z.string().default("Working…"),
      workingReaction: z.string().default("👀"),
      maxCharacters: z.number().int().min(100).max(20000).default(19000),
      silentPlaceholder: z.enum(["delete", "keep", "replace"]).default("delete"),
      silentText: z.string().default("Stayed silent by choice."),
    })
    .default({
      mode: "single",
      streaming: true,
      thinking: "stream",
      editIntervalMilliseconds: 900,
      workingText: "Working…",
      workingReaction: "👀",
      maxCharacters: 19000,
      silentPlaceholder: "delete",
      silentText: "Stayed silent by choice.",
    }),
  context: z
    .object({
      promptMode: z.enum(["full", "workspace"]).default("full"),
      historyMessages: z.number().int().min(0).max(200).default(30),
      replyDepth: z.number().int().min(0).max(50).default(12),
      referencedObjects: z.number().int().min(0).max(20).default(8),
    })
    .default({
      promptMode: "full",
      historyMessages: 30,
      replyDepth: 12,
      referencedObjects: 8,
    }),
  coordination: z
    .object({
      peers: z
        .array(
          z.object({
            name: z.string().min(1),
            participantId: z.string().min(1),
            aliases: z.array(z.string()).default([]),
          }),
        )
        .default([]),
      agentParticipants: z.array(z.string()).default([]),
      maxHops: z.number().int().min(0).default(3),
      maxFanout: z.number().int().min(1).default(4),
      maxActivationsPerThread: z.number().int().min(1).default(12),
      windowSeconds: z.number().int().min(1).default(300),
    })
    .default({
      peers: [],
      agentParticipants: [],
      maxHops: 3,
      maxFanout: 4,
      maxActivationsPerThread: 12,
      windowSeconds: 300,
    }),
  state: z
    .object({ path: z.string().default("~/.local/state/knot/state.sqlite") })
    .default({ path: "~/.local/state/knot/state.sqlite" }),
});

export type AgentConfig = z.infer<typeof configSchema>;
export type WakeConfig = z.infer<typeof wakeSchema>;

export function inactivityTimeoutSeconds(runtime: AgentConfig["runtime"]): number {
  return runtime.inactivityTimeoutSeconds ?? runtime.timeoutSeconds;
}

export function expandHome(value: string): string {
  return value === "~"
    ? homedir()
    : value.startsWith("~/")
      ? resolve(homedir(), value.slice(2))
      : value;
}

export async function loadConfig(path: string): Promise<AgentConfig> {
  const absolute = resolve(path);
  const text = await readFile(absolute, "utf8");
  const ext = extname(absolute).toLowerCase();
  const raw =
    ext === ".toml" ? parseToml(text) : ext === ".json" ? JSON.parse(text) : YAML.parse(text);
  const config = configSchema.parse(raw);
  if (ext === ".toml" && config.spaces.some((space) => space.chatDiscovery.autoEnroll))
    throw new Error("chatDiscovery.autoEnroll supports YAML and JSON configuration files only");
  config.anytype.apiKeyFile = expandHome(config.anytype.apiKeyFile);
  const explicitStatePath =
    raw &&
    typeof raw === "object" &&
    "state" in raw &&
    raw.state &&
    typeof raw.state === "object" &&
    "path" in raw.state &&
    typeof raw.state.path === "string"
      ? raw.state.path
      : undefined;
  config.state.path = resolveStatePath({ explicit: explicitStatePath });
  if (config.anytype.cli.configPath)
    config.anytype.cli.configPath = expandHome(config.anytype.cli.configPath);
  if (config.anytype.cli.dataPath)
    config.anytype.cli.dataPath = expandHome(config.anytype.cli.dataPath);
  if (config.runtime.defaultProject)
    config.runtime.defaultProject = expandHome(config.runtime.defaultProject);
  config.runtime.allowedProjects = config.runtime.allowedProjects.map(expandHome);
  const stateDirectory = await canonicalPath(dirname(config.state.path));
  const projectRoots = [config.runtime.defaultProject, ...config.runtime.allowedProjects].filter(
    (value): value is string => Boolean(value),
  );
  const canonicalProjectRoots = await Promise.all(projectRoots.map(canonicalPath));
  if (canonicalProjectRoots.some((root) => pathContains(root, stateDirectory)))
    throw new Error("state.path must be outside agent-accessible project directories");
  config.tools.anytype.allowedFileRoots = config.tools.anytype.allowedFileRoots.map(expandHome);
  if (config.runtime.kind === "codex" && config.runtime.command === "codex-acp") {
    const bundled = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "node_modules",
      ".bin",
      process.platform === "win32" ? "codex-acp.cmd" : "codex-acp",
    );
    try {
      await access(bundled, constants.X_OK);
      config.runtime.command = bundled;
    } catch {
      /* Fall back to PATH for source layouts or operator-managed installs. */
    }
  }
  if (config.runtime.kind === "openclaw") {
    config.runtime.gateway.configFile = expandHome(config.runtime.gateway.configFile);
    if (config.runtime.channelBridge.tokenFile)
      config.runtime.channelBridge.tokenFile = expandHome(config.runtime.channelBridge.tokenFile);
    if (
      config.runtime.gateway.clientModule.startsWith("~/") ||
      config.runtime.gateway.clientModule.startsWith("/")
    )
      config.runtime.gateway.clientModule = expandHome(config.runtime.gateway.clientModule);
  }
  config.anytype.heartAdapter.command = await resolveHeartBinary(
    config.anytype.heartAdapter.command,
  );
  return config;
}

function pathContains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function canonicalPath(value: string): Promise<string> {
  let cursor = resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(cursor), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(value);
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

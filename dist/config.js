import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import YAML from "yaml";
import { z } from "zod";
import { workflowAuthorityFields } from "./automation/policy.js";
import { cloudScopeSchema } from "./cloud-contract.js";
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
    .refine((value) => value.humans !== "prefix" || value.prefix, "wake.prefix is required for prefix mode");
const disabledWake = {
    humans: "disabled",
    agents: "never",
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
    if (value.autoEnroll &&
        value.wake &&
        value.wake.humans !== "mention" &&
        value.wake.humans !== "mention-or-reply")
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
    if (value.chatDiscovery.autoEnroll &&
        value.wakeOverrides.some((override) => override.kind === "chat" && override.wake.allowedUsers.includes("*")))
        context.addIssue({
            code: "custom",
            path: ["wakeOverrides"],
            message: "Chat auto-enrollment does not allow wildcard route overrides",
        });
})
    .refine((value) => value.id || value.name || value.invite, "space id, name, or invite is required");
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
const baseConfigSchema = z.object({
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
        publish: z
            .object({
            enabled: z.boolean().default(false),
            cloudConfigFile: z.string().optional(),
            allowedUsers: z.array(z.string().min(1)).default([]),
            allowedSiteIds: z.array(z.uuid()).default([]),
            allowedSlugPrefixes: z
                .array(z.string().regex(/^[a-z0-9](?:[a-z0-9/_-]*[a-z0-9/])?$/u))
                .default([]),
            allowUpdate: z.boolean().default(false),
            allowRollback: z.boolean().default(false),
            allowDisable: z.boolean().default(false),
            allowUnpublish: z.boolean().default(false),
        })
            .superRefine((value, context) => {
            if (value.enabled && value.allowedUsers.length === 0)
                context.addIssue({
                    code: "custom",
                    path: ["allowedUsers"],
                    message: "tools.publish.allowedUsers is required when publishing is enabled",
                });
            if (value.enabled && value.allowedUsers.includes("*"))
                context.addIssue({
                    code: "custom",
                    path: ["allowedUsers"],
                    message: "tools.publish.allowedUsers requires native participant IDs, not a wildcard",
                });
            if (value.enabled && value.allowedSiteIds.length === 0)
                context.addIssue({
                    code: "custom",
                    path: ["allowedSiteIds"],
                    message: "tools.publish.allowedSiteIds is required when publishing is enabled",
                });
            if (value.enabled && value.allowedSlugPrefixes.length === 0)
                context.addIssue({
                    code: "custom",
                    path: ["allowedSlugPrefixes"],
                    message: "tools.publish.allowedSlugPrefixes is required when publishing is enabled",
                });
        })
            .default({
            enabled: false,
            allowedUsers: [],
            allowedSiteIds: [],
            allowedSlugPrefixes: [],
            allowUpdate: false,
            allowRollback: false,
            allowDisable: false,
            allowUnpublish: false,
        }),
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
        publish: {
            enabled: false,
            allowedUsers: [],
            allowedSiteIds: [],
            allowedSlugPrefixes: [],
            allowUpdate: false,
            allowRollback: false,
            allowDisable: false,
            allowUnpublish: false,
        },
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
            .array(z.object({
            name: z.string().min(1),
            participantId: z.string().min(1),
            aliases: z.array(z.string()).default([]),
        }))
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
    automation: z
        .object({
        enabled: z.boolean().default(false),
        observation: z.boolean().default(false),
        execution: z.boolean().default(false),
        authoring: z.boolean().default(false),
        dataProducts: z.boolean().default(false),
        definitionTypeKeys: z.array(z.string().trim().min(1)).min(1).default(["knot-workflow"]),
        polling: z
            .object({
            minimumIntervalSeconds: z.number().int().min(1).max(3_600).default(10),
            maximumIntervalSeconds: z.number().int().min(1).max(86_400).default(300),
            pageSize: z.number().int().min(1).max(100).default(100),
        })
            .strict()
            .default({ minimumIntervalSeconds: 10, maximumIntervalSeconds: 300, pageSize: 100 }),
        runner: z
            .object({
            pollIntervalMilliseconds: z.number().int().min(50).max(60_000).default(1_000),
            leaseSeconds: z.number().int().min(5).max(3_600).default(30),
            workerCount: z.number().int().min(1).max(16).default(2),
            batchSize: z.number().int().min(1).max(500).default(100),
        })
            .strict()
            .default({
            pollIntervalMilliseconds: 1_000,
            leaseSeconds: 30,
            workerCount: 2,
            batchSize: 100,
        }),
        ...workflowAuthorityFields,
        heartHints: z.boolean().default(false),
    })
        .strict()
        .superRefine((value, context) => {
        if (value.enabled && value.allowedAuthorIds.length === 0)
            context.addIssue({
                code: "custom",
                path: ["allowedAuthorIds"],
                message: "automation.allowedAuthorIds is required when automation is enabled",
            });
        if (value.enabled && value.allowedSpaceIds.length === 0)
            context.addIssue({
                code: "custom",
                path: ["allowedSpaceIds"],
                message: "automation.allowedSpaceIds is required when automation is enabled",
            });
        if (!value.enabled &&
            (value.observation || value.execution || value.authoring || value.dataProducts))
            context.addIssue({
                code: "custom",
                path: ["enabled"],
                message: "automation.enabled is required before enabling automation subsystems",
            });
        if (value.execution && !value.observation)
            context.addIssue({
                code: "custom",
                path: ["observation"],
                message: "automation.observation is required before execution",
            });
        if (value.heartHints && !value.observation)
            context.addIssue({
                code: "custom",
                path: ["observation"],
                message: "automation.observation is required before Heart hints",
            });
        if ((value.authoring || value.dataProducts) && !value.execution)
            context.addIssue({
                code: "custom",
                path: ["execution"],
                message: "automation.execution is required before authoring or data products",
            });
        else if (value.authoring || value.dataProducts)
            context.addIssue({
                code: "custom",
                path: [value.authoring ? "authoring" : "dataProducts"],
                message: "automation authoring and data products are not available in this release",
            });
        if (value.polling.maximumIntervalSeconds < value.polling.minimumIntervalSeconds)
            context.addIssue({
                code: "custom",
                path: ["polling", "maximumIntervalSeconds"],
                message: "automation.polling.maximumIntervalSeconds must not be below the minimum",
            });
    })
        .default({
        enabled: false,
        observation: false,
        execution: false,
        authoring: false,
        dataProducts: false,
        definitionTypeKeys: ["knot-workflow"],
        polling: { minimumIntervalSeconds: 10, maximumIntervalSeconds: 300, pageSize: 100 },
        runner: {
            pollIntervalMilliseconds: 1_000,
            leaseSeconds: 30,
            workerCount: 2,
            batchSize: 100,
        },
        allowedAuthorIds: [],
        allowedSpaceIds: [],
        allowedCapabilities: [],
        allowedConnections: [],
        allowedSecretNames: [],
        allowedProjects: [],
        publishConnections: {},
        maximumRiskTier: "T0",
        heartHints: false,
        limits: {
            maximumConcurrentRuns: 4,
            maximumRunsPerHour: 60,
            maximumStepsPerRun: 100,
            maximumEffectsPerRun: 20,
            maximumRunSeconds: 3_600,
            maximumCausalDepth: 8,
        },
    }),
    cloudCommands: z
        .object({
        enabled: z.boolean().default(false),
        cloudConfigFile: z.string().optional(),
        pollIntervalSeconds: z.number().int().min(1).max(300).default(5),
        leaseSeconds: z.number().int().min(15).max(300).default(60),
        maximumLocalAttempts: z.number().int().min(1).max(10).default(3),
        approval: z.enum(["none", "writes", "all"]).default("writes"),
        allowedCreatorKinds: z
            .array(z.enum(["human-session", "connector-key", "consumer-api-key", "first-party-service"]))
            .default(["human-session"]),
        allowedSpaceIds: z.array(z.string().min(1)).default([]),
        allowedOriginParticipantIds: z
            .array(z
            .string()
            .min(1)
            .max(512)
            .refine((value) => value !== "*", "wildcard is not allowed"))
            .default([]),
        allowedActorDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).default([]),
        allowedScopes: z.array(cloudScopeSchema).default([]),
        projection: z
            .object({
            enabled: z.boolean().default(false),
            spaceId: z.string().min(1).optional(),
            chatId: z.string().min(1).optional(),
        })
            .superRefine((value, context) => {
            if (value.enabled && (!value.spaceId || !value.chatId))
                context.addIssue({
                    code: "custom",
                    message: "cloudCommands.projection requires spaceId and chatId when enabled",
                });
        })
            .default({ enabled: false }),
    })
        .strict()
        .default({
        enabled: false,
        pollIntervalSeconds: 5,
        leaseSeconds: 60,
        maximumLocalAttempts: 3,
        approval: "writes",
        allowedCreatorKinds: ["human-session"],
        allowedSpaceIds: [],
        allowedOriginParticipantIds: [],
        allowedActorDigests: [],
        allowedScopes: [],
        projection: { enabled: false },
    }),
    state: z
        .object({ path: z.string().default("~/.local/state/knot/state.sqlite") })
        .default({ path: "~/.local/state/knot/state.sqlite" }),
});
export const configSchema = baseConfigSchema.superRefine((value, context) => {
    if (value.cloudCommands.enabled && (!value.automation.enabled || !value.automation.execution))
        context.addIssue({
            code: "custom",
            path: ["cloudCommands", "enabled"],
            message: "cloudCommands requires the durable automation runner",
        });
    if (value.cloudCommands.enabled && value.cloudCommands.allowedScopes.length === 0)
        context.addIssue({
            code: "custom",
            path: ["cloudCommands", "allowedScopes"],
            message: "cloudCommands.allowedScopes is required when cloud commands are enabled",
        });
    if (value.cloudCommands.enabled && value.cloudCommands.allowedActorDigests.length === 0)
        context.addIssue({
            code: "custom",
            path: ["cloudCommands", "allowedActorDigests"],
            message: "cloudCommands.allowedActorDigests is required when cloud commands are enabled",
        });
    if (value.cloudCommands.enabled &&
        value.cloudCommands.allowedScopes.includes("anytype.chats.send") &&
        value.cloudCommands.allowedOriginParticipantIds.length === 0)
        context.addIssue({
            code: "custom",
            path: ["cloudCommands", "allowedOriginParticipantIds"],
            message: "cloudCommands.allowedOriginParticipantIds is required for chat.send",
        });
});
export function inactivityTimeoutSeconds(runtime) {
    return runtime.inactivityTimeoutSeconds ?? runtime.timeoutSeconds;
}
export function expandHome(value) {
    return value === "~"
        ? homedir()
        : value.startsWith("~/")
            ? resolve(homedir(), value.slice(2))
            : value;
}
export async function loadConfig(path) {
    const absolute = resolve(path);
    const text = await readFile(absolute, "utf8");
    const ext = extname(absolute).toLowerCase();
    const raw = ext === ".toml" ? parseToml(text) : ext === ".json" ? JSON.parse(text) : YAML.parse(text);
    const config = configSchema.parse(raw);
    if (ext === ".toml" && config.spaces.some((space) => space.chatDiscovery.autoEnroll))
        throw new Error("chatDiscovery.autoEnroll supports YAML and JSON configuration files only");
    config.anytype.apiKeyFile = expandHome(config.anytype.apiKeyFile);
    const explicitStatePath = raw &&
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
    for (const connection of Object.values(config.automation.publishConnections))
        connection.cloudConfigFile = expandHome(connection.cloudConfigFile);
    const stateDirectory = await canonicalPath(dirname(config.state.path));
    const projectRoots = [config.runtime.defaultProject, ...config.runtime.allowedProjects].filter((value) => Boolean(value));
    const canonicalProjectRoots = await Promise.all(projectRoots.map(canonicalPath));
    if (canonicalProjectRoots.some((root) => pathContains(root, stateDirectory)))
        throw new Error("state.path must be outside agent-accessible project directories");
    config.tools.anytype.allowedFileRoots = config.tools.anytype.allowedFileRoots.map(expandHome);
    if (config.tools.publish.cloudConfigFile)
        config.tools.publish.cloudConfigFile = expandHome(config.tools.publish.cloudConfigFile);
    if (config.cloudCommands.cloudConfigFile)
        config.cloudCommands.cloudConfigFile = expandHome(config.cloudCommands.cloudConfigFile);
    if (config.runtime.kind === "codex" && config.runtime.command === "codex-acp") {
        const bundled = resolve(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
        try {
            await access(bundled, constants.X_OK);
            config.runtime.command = bundled;
        }
        catch {
            /* Fall back to PATH for source layouts or operator-managed installs. */
        }
    }
    if (config.runtime.kind === "openclaw") {
        config.runtime.gateway.configFile = expandHome(config.runtime.gateway.configFile);
        if (config.runtime.channelBridge.tokenFile)
            config.runtime.channelBridge.tokenFile = expandHome(config.runtime.channelBridge.tokenFile);
        if (config.runtime.gateway.clientModule.startsWith("~/") ||
            config.runtime.gateway.clientModule.startsWith("/"))
            config.runtime.gateway.clientModule = expandHome(config.runtime.gateway.clientModule);
    }
    config.anytype.heartAdapter.command = await resolveHeartBinary(config.anytype.heartAdapter.command);
    return config;
}
function pathContains(root, candidate) {
    const path = relative(root, candidate);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
async function canonicalPath(value) {
    let cursor = resolve(value);
    const missing = [];
    for (;;) {
        try {
            return resolve(await realpath(cursor), ...missing.reverse());
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            const parent = dirname(cursor);
            if (parent === cursor)
                return resolve(value);
            missing.push(basename(cursor));
            cursor = parent;
        }
    }
}

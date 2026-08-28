import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import YAML from "yaml";
import { z } from "zod";
const wakeSchema = z.object({
    humans: z.enum(["mention", "mention-or-reply", "every-message", "prefix", "disabled"]).default("mention"),
    agents: z.enum(["never", "direct-mention", "every-message"]).default("direct-mention"),
    prefix: z.string().optional(),
    allowedUsers: z.array(z.string()).min(1)
}).refine(value => value.humans !== "prefix" || value.prefix, "wake.prefix is required for prefix mode");
const disabledWake = { humans: "disabled", agents: "never", allowedUsers: ["__disabled__"] };
const chatSchema = z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    wake: wakeSchema
}).refine(value => value.id || value.name, "chat id or name is required");
const commentsSchema = z.object({
    mode: z.enum(["all", "filtered", "disabled"]).default("disabled"),
    includeObjectTypes: z.array(z.string()).default([]),
    excludeObjectTypes: z.array(z.string()).default([]),
    discoveryIntervalSeconds: z.number().int().min(10).default(60),
    createMissing: z.boolean().default(false),
    wake: wakeSchema.optional()
}).superRefine((value, context) => {
    if (value.mode !== "disabled" && !value.wake)
        context.addIssue({ code: "custom", path: ["wake"], message: "comments.wake is required when comments are enabled" });
    if (value.mode === "filtered" && value.includeObjectTypes.length === 0)
        context.addIssue({ code: "custom", path: ["includeObjectTypes"], message: "comments.includeObjectTypes is required for filtered mode" });
}).transform(value => ({ ...value, wake: value.wake ?? disabledWake }));
const chatDiscoverySchema = z.object({
    enabled: z.boolean().default(false),
    discoveryIntervalSeconds: z.number().int().min(10).default(30),
    wake: wakeSchema.optional()
}).superRefine((value, context) => {
    if (value.enabled && !value.wake)
        context.addIssue({ code: "custom", path: ["wake"], message: "chatDiscovery.wake is required when chat discovery is enabled" });
}).transform(value => ({ ...value, wake: value.wake ?? disabledWake }));
const spaceSchema = z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    participantId: z.string().optional(),
    invite: z.string().url().optional(),
    chats: z.array(chatSchema).default([]),
    chatDiscovery: chatDiscoverySchema.default({ enabled: false, discoveryIntervalSeconds: 30, wake: disabledWake }),
    comments: commentsSchema.default({ mode: "disabled", includeObjectTypes: [], excludeObjectTypes: [], discoveryIntervalSeconds: 60, createMissing: false, wake: disabledWake })
}).refine(value => value.id || value.name || value.invite, "space id, name, or invite is required");
const baseRuntime = {
    defaultProject: z.string().optional(),
    allowedProjects: z.array(z.string()).default([]),
    environment: z.record(z.string(), z.string()).default({})
};
const runtimeSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("openclaw"), ...baseRuntime,
        command: z.string().default("openclaw"),
        agentId: z.string().default("main"),
        sessionKey: z.string().optional(),
        timeoutSeconds: z.number().int().positive().default(900),
        gateway: z.object({
            url: z.string().url().default("ws://127.0.0.1:18789"),
            configFile: z.string().default("~/.openclaw/openclaw.json"),
            tokenEnv: z.string().default("OPENCLAW_GATEWAY_TOKEN"),
            clientModule: z.string().default("@openclaw/gateway-client"),
            protocolVersion: z.number().int().positive().default(4)
        }).default({ url: "ws://127.0.0.1:18789", configFile: "~/.openclaw/openclaw.json", tokenEnv: "OPENCLAW_GATEWAY_TOKEN", clientModule: "@openclaw/gateway-client", protocolVersion: 4 })
    }),
    z.object({
        kind: z.literal("codex"), ...baseRuntime,
        command: z.string().default("codex-acp"),
        args: z.array(z.string()).default([]),
        timeoutSeconds: z.number().int().positive().default(900),
        permissions: z.enum(["deny", "allow-once"]).default("deny")
    })
]);
export const configSchema = z.object({
    version: z.literal(1),
    agent: z.object({ name: z.string().min(1), participantId: z.string().min(1), aliases: z.array(z.string()).default([]) }),
    anytype: z.object({
        apiBase: z.string().url().default("http://127.0.0.1:31012"),
        apiVersion: z.string().default("2025-11-08"),
        apiKeyFile: z.string(),
        cli: z.object({ command: z.string().default("anytype"), configPath: z.string().optional(), dataPath: z.string().optional() }).default({ command: "anytype" }),
        heartAdapter: z.object({ command: z.string().default("aag-heart-adapter"), grpcAddress: z.string().default("127.0.0.1:31010") }).default({ command: "aag-heart-adapter", grpcAddress: "127.0.0.1:31010" })
    }),
    spaces: z.array(spaceSchema).min(1),
    runtime: runtimeSchema,
    responses: z.object({
        mode: z.enum(["single", "milestones", "verbose"]).default("single"),
        streaming: z.boolean().default(true),
        workingText: z.string().default("Working…"),
        workingReaction: z.string().default("👀"),
        maxCharacters: z.number().int().min(100).max(20000).default(19000),
        silentPlaceholder: z.enum(["delete", "keep", "replace"]).default("delete"),
        silentText: z.string().default("Stayed silent by choice.")
    }).default({ mode: "single", streaming: true, workingText: "Working…", workingReaction: "👀", maxCharacters: 19000, silentPlaceholder: "delete", silentText: "Stayed silent by choice." }),
    context: z.object({ historyMessages: z.number().int().min(0).max(200).default(30), replyDepth: z.number().int().min(0).max(50).default(12), referencedObjects: z.number().int().min(0).max(20).default(8) }).default({ historyMessages: 30, replyDepth: 12, referencedObjects: 8 }),
    coordination: z.object({
        peers: z.array(z.object({ name: z.string().min(1), participantId: z.string().min(1), aliases: z.array(z.string()).default([]) })).default([]),
        agentParticipants: z.array(z.string()).default([]),
        maxHops: z.number().int().min(0).default(3),
        maxFanout: z.number().int().min(1).default(4),
        maxActivationsPerThread: z.number().int().min(1).default(12),
        windowSeconds: z.number().int().min(1).default(300)
    }).default({ peers: [], agentParticipants: [], maxHops: 3, maxFanout: 4, maxActivationsPerThread: 12, windowSeconds: 300 }),
    state: z.object({ path: z.string().default("~/.local/state/aag/state.sqlite") }).default({ path: "~/.local/state/aag/state.sqlite" })
});
export function expandHome(value) {
    return value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
}
export async function loadConfig(path) {
    const absolute = resolve(path);
    const text = await readFile(absolute, "utf8");
    const ext = extname(absolute).toLowerCase();
    const raw = ext === ".toml" ? parseToml(text) : ext === ".json" ? JSON.parse(text) : YAML.parse(text);
    const config = configSchema.parse(raw);
    config.anytype.apiKeyFile = expandHome(config.anytype.apiKeyFile);
    config.state.path = expandHome(config.state.path);
    if (config.anytype.cli.configPath)
        config.anytype.cli.configPath = expandHome(config.anytype.cli.configPath);
    if (config.anytype.cli.dataPath)
        config.anytype.cli.dataPath = expandHome(config.anytype.cli.dataPath);
    if (config.runtime.defaultProject)
        config.runtime.defaultProject = expandHome(config.runtime.defaultProject);
    config.runtime.allowedProjects = config.runtime.allowedProjects.map(expandHome);
    if (config.runtime.kind === "codex" && config.runtime.command === "codex-acp") {
        const bundled = resolve(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
        try {
            await access(bundled, constants.X_OK);
            config.runtime.command = bundled;
        }
        catch { /* Fall back to PATH for source layouts or operator-managed installs. */ }
    }
    if (config.runtime.kind === "openclaw") {
        config.runtime.gateway.configFile = expandHome(config.runtime.gateway.configFile);
        if (config.runtime.gateway.clientModule.startsWith("~/") || config.runtime.gateway.clientModule.startsWith("/"))
            config.runtime.gateway.clientModule = expandHome(config.runtime.gateway.clientModule);
    }
    return config;
}

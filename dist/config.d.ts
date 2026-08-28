import { z } from "zod";
declare const wakeSchema: z.ZodObject<{
    humans: z.ZodDefault<z.ZodEnum<{
        mention: "mention";
        "mention-or-reply": "mention-or-reply";
        "every-message": "every-message";
        prefix: "prefix";
        disabled: "disabled";
    }>>;
    agents: z.ZodDefault<z.ZodEnum<{
        "every-message": "every-message";
        never: "never";
        "direct-mention": "direct-mention";
    }>>;
    prefix: z.ZodOptional<z.ZodString>;
    allowedUsers: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export declare const configSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    agent: z.ZodObject<{
        name: z.ZodString;
        participantId: z.ZodString;
        aliases: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>;
    anytype: z.ZodObject<{
        apiBase: z.ZodDefault<z.ZodString>;
        apiVersion: z.ZodDefault<z.ZodString>;
        apiKeyFile: z.ZodString;
        cli: z.ZodDefault<z.ZodObject<{
            command: z.ZodDefault<z.ZodString>;
            configPath: z.ZodOptional<z.ZodString>;
            dataPath: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        heartAdapter: z.ZodDefault<z.ZodObject<{
            command: z.ZodDefault<z.ZodString>;
            grpcAddress: z.ZodDefault<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    spaces: z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        participantId: z.ZodOptional<z.ZodString>;
        invite: z.ZodOptional<z.ZodString>;
        chats: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            wake: z.ZodObject<{
                humans: z.ZodDefault<z.ZodEnum<{
                    mention: "mention";
                    "mention-or-reply": "mention-or-reply";
                    "every-message": "every-message";
                    prefix: "prefix";
                    disabled: "disabled";
                }>>;
                agents: z.ZodDefault<z.ZodEnum<{
                    "every-message": "every-message";
                    never: "never";
                    "direct-mention": "direct-mention";
                }>>;
                prefix: z.ZodOptional<z.ZodString>;
                allowedUsers: z.ZodArray<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>>>;
        comments: z.ZodDefault<z.ZodPipe<z.ZodObject<{
            mode: z.ZodDefault<z.ZodEnum<{
                disabled: "disabled";
                all: "all";
                filtered: "filtered";
            }>>;
            includeObjectTypes: z.ZodDefault<z.ZodArray<z.ZodString>>;
            excludeObjectTypes: z.ZodDefault<z.ZodArray<z.ZodString>>;
            discoveryIntervalSeconds: z.ZodDefault<z.ZodNumber>;
            createMissing: z.ZodDefault<z.ZodBoolean>;
            wake: z.ZodOptional<z.ZodObject<{
                humans: z.ZodDefault<z.ZodEnum<{
                    mention: "mention";
                    "mention-or-reply": "mention-or-reply";
                    "every-message": "every-message";
                    prefix: "prefix";
                    disabled: "disabled";
                }>>;
                agents: z.ZodDefault<z.ZodEnum<{
                    "every-message": "every-message";
                    never: "never";
                    "direct-mention": "direct-mention";
                }>>;
                prefix: z.ZodOptional<z.ZodString>;
                allowedUsers: z.ZodArray<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>, z.ZodTransform<{
            wake: {
                humans: "mention" | "mention-or-reply" | "every-message" | "prefix" | "disabled";
                agents: "every-message" | "never" | "direct-mention";
                allowedUsers: string[];
                prefix?: string | undefined;
            } | {
                humans: "disabled";
                agents: "never";
                allowedUsers: string[];
            };
            mode: "disabled" | "all" | "filtered";
            includeObjectTypes: string[];
            excludeObjectTypes: string[];
            discoveryIntervalSeconds: number;
            createMissing: boolean;
        }, {
            mode: "disabled" | "all" | "filtered";
            includeObjectTypes: string[];
            excludeObjectTypes: string[];
            discoveryIntervalSeconds: number;
            createMissing: boolean;
            wake?: {
                humans: "mention" | "mention-or-reply" | "every-message" | "prefix" | "disabled";
                agents: "every-message" | "never" | "direct-mention";
                allowedUsers: string[];
                prefix?: string | undefined;
            } | undefined;
        }>>>;
    }, z.core.$strip>>;
    runtime: z.ZodDiscriminatedUnion<[z.ZodObject<{
        command: z.ZodDefault<z.ZodString>;
        agentId: z.ZodDefault<z.ZodString>;
        sessionKey: z.ZodOptional<z.ZodString>;
        timeoutSeconds: z.ZodDefault<z.ZodNumber>;
        gateway: z.ZodDefault<z.ZodObject<{
            url: z.ZodDefault<z.ZodString>;
            configFile: z.ZodDefault<z.ZodString>;
            tokenEnv: z.ZodDefault<z.ZodString>;
            clientModule: z.ZodDefault<z.ZodString>;
            protocolVersion: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        defaultProject: z.ZodOptional<z.ZodString>;
        allowedProjects: z.ZodDefault<z.ZodArray<z.ZodString>>;
        environment: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        kind: z.ZodLiteral<"openclaw">;
    }, z.core.$strip>, z.ZodObject<{
        command: z.ZodDefault<z.ZodString>;
        args: z.ZodDefault<z.ZodArray<z.ZodString>>;
        timeoutSeconds: z.ZodDefault<z.ZodNumber>;
        permissions: z.ZodDefault<z.ZodEnum<{
            deny: "deny";
            "allow-once": "allow-once";
        }>>;
        defaultProject: z.ZodOptional<z.ZodString>;
        allowedProjects: z.ZodDefault<z.ZodArray<z.ZodString>>;
        environment: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        kind: z.ZodLiteral<"codex">;
    }, z.core.$strip>], "kind">;
    responses: z.ZodDefault<z.ZodObject<{
        mode: z.ZodDefault<z.ZodEnum<{
            single: "single";
            milestones: "milestones";
            verbose: "verbose";
        }>>;
        workingText: z.ZodDefault<z.ZodString>;
        workingReaction: z.ZodDefault<z.ZodString>;
        maxCharacters: z.ZodDefault<z.ZodNumber>;
        silentPlaceholder: z.ZodDefault<z.ZodEnum<{
            delete: "delete";
            keep: "keep";
            replace: "replace";
        }>>;
        silentText: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>;
    context: z.ZodDefault<z.ZodObject<{
        historyMessages: z.ZodDefault<z.ZodNumber>;
        replyDepth: z.ZodDefault<z.ZodNumber>;
        referencedObjects: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    coordination: z.ZodDefault<z.ZodObject<{
        peers: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            participantId: z.ZodString;
            aliases: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        agentParticipants: z.ZodDefault<z.ZodArray<z.ZodString>>;
        maxHops: z.ZodDefault<z.ZodNumber>;
        maxFanout: z.ZodDefault<z.ZodNumber>;
        maxActivationsPerThread: z.ZodDefault<z.ZodNumber>;
        windowSeconds: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    state: z.ZodDefault<z.ZodObject<{
        path: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type AgentConfig = z.infer<typeof configSchema>;
export type WakeConfig = z.infer<typeof wakeSchema>;
export declare function expandHome(value: string): string;
export declare function loadConfig(path: string): Promise<AgentConfig>;
export {};

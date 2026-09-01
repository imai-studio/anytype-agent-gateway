import { z } from "zod";
declare const wakeSchema: z.ZodObject<{
    humans: z.ZodDefault<z.ZodEnum<{
        disabled: "disabled";
        mention: "mention";
        "mention-or-reply": "mention-or-reply";
        "every-message": "every-message";
        prefix: "prefix";
    }>>;
    agents: z.ZodDefault<z.ZodEnum<{
        never: "never";
        "every-message": "every-message";
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
    directMessages: z.ZodDefault<z.ZodPipe<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        createMissing: z.ZodDefault<z.ZodBoolean>;
        discoveryIntervalSeconds: z.ZodDefault<z.ZodNumber>;
        wake: z.ZodOptional<z.ZodObject<{
            humans: z.ZodDefault<z.ZodEnum<{
                disabled: "disabled";
                mention: "mention";
                "mention-or-reply": "mention-or-reply";
                "every-message": "every-message";
                prefix: "prefix";
            }>>;
            agents: z.ZodDefault<z.ZodEnum<{
                never: "never";
                "every-message": "every-message";
                "direct-mention": "direct-mention";
            }>>;
            prefix: z.ZodOptional<z.ZodString>;
            allowedUsers: z.ZodArray<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>, z.ZodTransform<{
        wake: {
            humans: "disabled" | "mention" | "mention-or-reply" | "every-message" | "prefix";
            agents: "never" | "every-message" | "direct-mention";
            allowedUsers: string[];
            prefix?: string | undefined;
        } | {
            humans: "disabled";
            agents: "never";
            allowedUsers: string[];
        };
        enabled: boolean;
        createMissing: boolean;
        discoveryIntervalSeconds: number;
    }, {
        enabled: boolean;
        createMissing: boolean;
        discoveryIntervalSeconds: number;
        wake?: {
            humans: "disabled" | "mention" | "mention-or-reply" | "every-message" | "prefix";
            agents: "never" | "every-message" | "direct-mention";
            allowedUsers: string[];
            prefix?: string | undefined;
        } | undefined;
    }>>>;
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
                    disabled: "disabled";
                    mention: "mention";
                    "mention-or-reply": "mention-or-reply";
                    "every-message": "every-message";
                    prefix: "prefix";
                }>>;
                agents: z.ZodDefault<z.ZodEnum<{
                    never: "never";
                    "every-message": "every-message";
                    "direct-mention": "direct-mention";
                }>>;
                prefix: z.ZodOptional<z.ZodString>;
                allowedUsers: z.ZodArray<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>>>;
        wakeOverrides: z.ZodDefault<z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<{
                chat: "chat";
                discussion: "discussion";
            }>;
            id: z.ZodString;
            wake: z.ZodObject<{
                humans: z.ZodDefault<z.ZodEnum<{
                    disabled: "disabled";
                    mention: "mention";
                    "mention-or-reply": "mention-or-reply";
                    "every-message": "every-message";
                    prefix: "prefix";
                }>>;
                agents: z.ZodDefault<z.ZodEnum<{
                    never: "never";
                    "every-message": "every-message";
                    "direct-mention": "direct-mention";
                }>>;
                prefix: z.ZodOptional<z.ZodString>;
                allowedUsers: z.ZodArray<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>>>;
        chatDiscovery: z.ZodDefault<z.ZodPipe<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            autoEnroll: z.ZodDefault<z.ZodBoolean>;
            discoveryIntervalSeconds: z.ZodDefault<z.ZodNumber>;
            wake: z.ZodOptional<z.ZodObject<{
                humans: z.ZodDefault<z.ZodEnum<{
                    disabled: "disabled";
                    mention: "mention";
                    "mention-or-reply": "mention-or-reply";
                    "every-message": "every-message";
                    prefix: "prefix";
                }>>;
                agents: z.ZodDefault<z.ZodEnum<{
                    never: "never";
                    "every-message": "every-message";
                    "direct-mention": "direct-mention";
                }>>;
                prefix: z.ZodOptional<z.ZodString>;
                allowedUsers: z.ZodArray<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>, z.ZodTransform<{
            wake: {
                humans: "disabled" | "mention" | "mention-or-reply" | "every-message" | "prefix";
                agents: "never" | "every-message" | "direct-mention";
                allowedUsers: string[];
                prefix?: string | undefined;
            } | {
                humans: "disabled";
                agents: "never";
                allowedUsers: string[];
            };
            enabled: boolean;
            autoEnroll: boolean;
            discoveryIntervalSeconds: number;
        }, {
            enabled: boolean;
            autoEnroll: boolean;
            discoveryIntervalSeconds: number;
            wake?: {
                humans: "disabled" | "mention" | "mention-or-reply" | "every-message" | "prefix";
                agents: "never" | "every-message" | "direct-mention";
                allowedUsers: string[];
                prefix?: string | undefined;
            } | undefined;
        }>>>;
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
                    disabled: "disabled";
                    mention: "mention";
                    "mention-or-reply": "mention-or-reply";
                    "every-message": "every-message";
                    prefix: "prefix";
                }>>;
                agents: z.ZodDefault<z.ZodEnum<{
                    never: "never";
                    "every-message": "every-message";
                    "direct-mention": "direct-mention";
                }>>;
                prefix: z.ZodOptional<z.ZodString>;
                allowedUsers: z.ZodArray<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>, z.ZodTransform<{
            wake: {
                humans: "disabled" | "mention" | "mention-or-reply" | "every-message" | "prefix";
                agents: "never" | "every-message" | "direct-mention";
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
                humans: "disabled" | "mention" | "mention-or-reply" | "every-message" | "prefix";
                agents: "never" | "every-message" | "direct-mention";
                allowedUsers: string[];
                prefix?: string | undefined;
            } | undefined;
        }>>>;
    }, z.core.$strip>>;
    runtime: z.ZodDiscriminatedUnion<[z.ZodObject<{
        command: z.ZodDefault<z.ZodString>;
        agentId: z.ZodDefault<z.ZodString>;
        sessionKey: z.ZodOptional<z.ZodString>;
        gateway: z.ZodDefault<z.ZodObject<{
            url: z.ZodDefault<z.ZodString>;
            configFile: z.ZodDefault<z.ZodString>;
            tokenEnv: z.ZodDefault<z.ZodString>;
            clientModule: z.ZodDefault<z.ZodString>;
            protocolVersion: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        channelBridge: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            url: z.ZodDefault<z.ZodString>;
            tokenEnv: z.ZodDefault<z.ZodString>;
            tokenFile: z.ZodOptional<z.ZodString>;
            accountId: z.ZodDefault<z.ZodString>;
            pollIntervalMilliseconds: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        defaultProject: z.ZodOptional<z.ZodString>;
        allowedProjects: z.ZodDefault<z.ZodArray<z.ZodString>>;
        environment: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        timeoutSeconds: z.ZodDefault<z.ZodNumber>;
        inactivityTimeoutSeconds: z.ZodOptional<z.ZodNumber>;
        maxRunSeconds: z.ZodDefault<z.ZodNumber>;
        setupTimeoutSeconds: z.ZodDefault<z.ZodNumber>;
        livenessProbeSeconds: z.ZodDefault<z.ZodNumber>;
        terminationGraceSeconds: z.ZodDefault<z.ZodNumber>;
        kind: z.ZodLiteral<"openclaw">;
    }, z.core.$strip>, z.ZodObject<{
        command: z.ZodDefault<z.ZodString>;
        args: z.ZodDefault<z.ZodArray<z.ZodString>>;
        permissions: z.ZodDefault<z.ZodEnum<{
            deny: "deny";
            "allow-once": "allow-once";
        }>>;
        desktopProject: z.ZodDefault<z.ZodEnum<{
            disabled: "disabled";
            auto: "auto";
        }>>;
        defaultProject: z.ZodOptional<z.ZodString>;
        allowedProjects: z.ZodDefault<z.ZodArray<z.ZodString>>;
        environment: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        timeoutSeconds: z.ZodDefault<z.ZodNumber>;
        inactivityTimeoutSeconds: z.ZodOptional<z.ZodNumber>;
        maxRunSeconds: z.ZodDefault<z.ZodNumber>;
        setupTimeoutSeconds: z.ZodDefault<z.ZodNumber>;
        livenessProbeSeconds: z.ZodDefault<z.ZodNumber>;
        terminationGraceSeconds: z.ZodDefault<z.ZodNumber>;
        kind: z.ZodLiteral<"codex">;
    }, z.core.$strip>], "kind">;
    models: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        allowed: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    management: z.ZodDefault<z.ZodObject<{
        allowWakeChanges: z.ZodDefault<z.ZodBoolean>;
        allowAccessChanges: z.ZodDefault<z.ZodBoolean>;
        allowModelChanges: z.ZodDefault<z.ZodBoolean>;
        allowProjectChanges: z.ZodDefault<z.ZodBoolean>;
        accessAdmins: z.ZodDefault<z.ZodArray<z.ZodString>>;
        modelAdmins: z.ZodDefault<z.ZodArray<z.ZodString>>;
        projectAdmins: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    tools: z.ZodDefault<z.ZodObject<{
        anytype: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            allowWrite: z.ZodDefault<z.ZodBoolean>;
            allowArchive: z.ZodDefault<z.ZodBoolean>;
            allowedSpaceIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
            allowedFileRoots: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
        codex: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            command: z.ZodDefault<z.ZodString>;
            sandbox: z.ZodDefault<z.ZodEnum<{
                "read-only": "read-only";
                "workspace-write": "workspace-write";
            }>>;
        }, z.core.$strip>>;
        publish: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            cloudConfigFile: z.ZodOptional<z.ZodString>;
            allowedUsers: z.ZodDefault<z.ZodArray<z.ZodString>>;
            allowedSiteIds: z.ZodDefault<z.ZodArray<z.ZodUUID>>;
            allowedSlugPrefixes: z.ZodDefault<z.ZodArray<z.ZodString>>;
            allowUpdate: z.ZodDefault<z.ZodBoolean>;
            allowRollback: z.ZodDefault<z.ZodBoolean>;
            allowDisable: z.ZodDefault<z.ZodBoolean>;
            allowUnpublish: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    responses: z.ZodDefault<z.ZodObject<{
        mode: z.ZodDefault<z.ZodEnum<{
            single: "single";
            milestones: "milestones";
            verbose: "verbose";
        }>>;
        streaming: z.ZodDefault<z.ZodBoolean>;
        thinking: z.ZodDefault<z.ZodEnum<{
            hidden: "hidden";
            stream: "stream";
        }>>;
        editIntervalMilliseconds: z.ZodDefault<z.ZodNumber>;
        workingText: z.ZodDefault<z.ZodString>;
        workingReaction: z.ZodDefault<z.ZodString>;
        maxCharacters: z.ZodDefault<z.ZodNumber>;
        silentPlaceholder: z.ZodDefault<z.ZodEnum<{
            replace: "replace";
            delete: "delete";
            keep: "keep";
        }>>;
        silentText: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>;
    context: z.ZodDefault<z.ZodObject<{
        promptMode: z.ZodDefault<z.ZodEnum<{
            full: "full";
            workspace: "workspace";
        }>>;
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
    automation: z.ZodDefault<z.ZodObject<{
        heartHints: z.ZodDefault<z.ZodBoolean>;
        allowedAuthorIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowedSpaceIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowedCapabilities: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            "agent.invoke": "agent.invoke";
            "anytype.archive": "anytype.archive";
            "anytype.bulk": "anytype.bulk";
            "anytype.cross-space": "anytype.cross-space";
            "anytype.materialize": "anytype.materialize";
            "anytype.query": "anytype.query";
            "anytype.read": "anytype.read";
            "anytype.write": "anytype.write";
            "http.request": "http.request";
            notify: "notify";
            "publish.web": "publish.web";
        }>>>;
        allowedConnections: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowedSecretNames: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowedProjects: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowedModels: z.ZodDefault<z.ZodArray<z.ZodString>>;
        publishConnections: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
            cloudConfigFile: z.ZodString;
            allowedSiteIds: z.ZodArray<z.ZodUUID>;
            allowedSlugPrefixes: z.ZodArray<z.ZodString>;
            allowUpdate: z.ZodDefault<z.ZodBoolean>;
            allowRollback: z.ZodDefault<z.ZodBoolean>;
            allowDisable: z.ZodDefault<z.ZodBoolean>;
            allowUnpublish: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>>;
        notificationConnections: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
            spaceId: z.ZodString;
            chatId: z.ZodString;
        }, z.core.$strict>>>;
        maximumRiskTier: z.ZodDefault<z.ZodEnum<{
            T0: "T0";
            T1: "T1";
            T2: "T2";
        }>>;
        limits: z.ZodDefault<z.ZodObject<{
            maximumConcurrentRuns: z.ZodDefault<z.ZodNumber>;
            maximumRunsPerHour: z.ZodDefault<z.ZodNumber>;
            maximumStepsPerRun: z.ZodDefault<z.ZodNumber>;
            maximumEffectsPerRun: z.ZodDefault<z.ZodNumber>;
            maximumRunSeconds: z.ZodDefault<z.ZodNumber>;
            maximumCausalDepth: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        enabled: z.ZodDefault<z.ZodBoolean>;
        observation: z.ZodDefault<z.ZodBoolean>;
        execution: z.ZodDefault<z.ZodBoolean>;
        authoring: z.ZodDefault<z.ZodBoolean>;
        dataProducts: z.ZodDefault<z.ZodBoolean>;
        definitionTypeKeys: z.ZodDefault<z.ZodArray<z.ZodString>>;
        polling: z.ZodDefault<z.ZodObject<{
            minimumIntervalSeconds: z.ZodDefault<z.ZodNumber>;
            maximumIntervalSeconds: z.ZodDefault<z.ZodNumber>;
            pageSize: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        runner: z.ZodDefault<z.ZodObject<{
            pollIntervalMilliseconds: z.ZodDefault<z.ZodNumber>;
            leaseSeconds: z.ZodDefault<z.ZodNumber>;
            workerCount: z.ZodDefault<z.ZodNumber>;
            batchSize: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    cloudCommands: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        cloudConfigFile: z.ZodOptional<z.ZodString>;
        pollIntervalSeconds: z.ZodDefault<z.ZodNumber>;
        leaseSeconds: z.ZodDefault<z.ZodNumber>;
        maximumLocalAttempts: z.ZodDefault<z.ZodNumber>;
        approval: z.ZodDefault<z.ZodEnum<{
            all: "all";
            none: "none";
            writes: "writes";
        }>>;
        allowedCreatorKinds: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            "human-session": "human-session";
            "connector-key": "connector-key";
            "consumer-api-key": "consumer-api-key";
            "first-party-service": "first-party-service";
        }>>>;
        allowedSpaceIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowedOriginParticipantIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowedActorDigests: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowedScopes: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            "anytype.objects.read": "anytype.objects.read";
            "anytype.objects.write": "anytype.objects.write";
            "anytype.collections.read": "anytype.collections.read";
            "anytype.collections.write": "anytype.collections.write";
            "anytype.files.read": "anytype.files.read";
            "anytype.files.write": "anytype.files.write";
            "anytype.chats.read": "anytype.chats.read";
            "anytype.chats.send": "anytype.chats.send";
            "publications.read": "publications.read";
            "publications.write": "publications.write";
            "publications.unpublish": "publications.unpublish";
        }>>>;
        projection: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            spaceId: z.ZodOptional<z.ZodString>;
            chatId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strict>>;
    state: z.ZodDefault<z.ZodObject<{
        path: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type AgentConfig = z.infer<typeof configSchema>;
export type WakeConfig = z.infer<typeof wakeSchema>;
export declare function inactivityTimeoutSeconds(runtime: AgentConfig["runtime"]): number;
export declare function expandHome(value: string): string;
export declare function loadConfig(path: string): Promise<AgentConfig>;
export {};

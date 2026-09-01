import { z } from "zod";
export declare const jsonValueSchema: z.ZodType<JsonValue>;
export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
export declare const workflowCapabilitySchema: z.ZodEnum<{
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
}>;
export type WorkflowCapability = z.infer<typeof workflowCapabilitySchema>;
export declare const WORKFLOW_POLICY_VERSION = 2;
export declare const workflowStepKindSchema: z.ZodEnum<{
    transform: "transform";
    "anytype.materialize": "anytype.materialize";
    "anytype.query": "anytype.query";
    "anytype.read": "anytype.read";
    "anytype.write": "anytype.write";
    notify: "notify";
    agent: "agent";
    "anytype.upsert": "anytype.upsert";
    http: "http";
    approval: "approval";
}>;
export declare const workflowDefinitionSchema: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodObject<{
    apiVersion: z.ZodLiteral<"knot.imai.studio/v1alpha1">;
    kind: z.ZodLiteral<"KnotWorkflow">;
    metadata: z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        labels: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strict>;
    spec: z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        triggers: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"manual">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"schedule">;
            schedule: z.ZodString;
            timezone: z.ZodDefault<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"anytype.event">;
            events: z.ZodArray<z.ZodEnum<{
                created: "created";
                updated: "updated";
                archived: "archived";
            }>>;
            spaceId: z.ZodOptional<z.ZodString>;
            objectTypeId: z.ZodOptional<z.ZodString>;
            filter: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"anytype.chat">;
            spaceId: z.ZodOptional<z.ZodString>;
            chatId: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>], "kind">>;
        steps: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodLiteral<"agent">;
            dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
            config: z.ZodOptional<z.ZodObject<{
                project: z.ZodOptional<z.ZodString>;
                prompt: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            retry: z.ZodOptional<z.ZodObject<{
                attempts: z.ZodDefault<z.ZodNumber>;
                initialDelaySeconds: z.ZodDefault<z.ZodNumber>;
                maximumDelaySeconds: z.ZodDefault<z.ZodNumber>;
                multiplier: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodLiteral<"anytype.read">;
            dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
            config: z.ZodOptional<z.ZodObject<{
                spaceId: z.ZodOptional<z.ZodString>;
                objectId: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            retry: z.ZodOptional<z.ZodObject<{
                attempts: z.ZodDefault<z.ZodNumber>;
                initialDelaySeconds: z.ZodDefault<z.ZodNumber>;
                maximumDelaySeconds: z.ZodDefault<z.ZodNumber>;
                multiplier: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodLiteral<"anytype.query">;
            dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
            config: z.ZodOptional<z.ZodObject<{
                spaceId: z.ZodOptional<z.ZodString>;
                query: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>>;
            }, z.core.$strict>>;
            retry: z.ZodOptional<z.ZodObject<{
                attempts: z.ZodDefault<z.ZodNumber>;
                initialDelaySeconds: z.ZodDefault<z.ZodNumber>;
                maximumDelaySeconds: z.ZodDefault<z.ZodNumber>;
                multiplier: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodLiteral<"anytype.write">;
            dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
            config: z.ZodOptional<z.ZodObject<{
                spaceId: z.ZodOptional<z.ZodString>;
                objectId: z.ZodOptional<z.ZodString>;
                operation: z.ZodDefault<z.ZodEnum<{
                    create: "create";
                    update: "update";
                    archive: "archive";
                }>>;
                bulk: z.ZodDefault<z.ZodBoolean>;
                values: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>>;
            }, z.core.$strict>>;
            retry: z.ZodOptional<z.ZodObject<{
                attempts: z.ZodDefault<z.ZodNumber>;
                initialDelaySeconds: z.ZodDefault<z.ZodNumber>;
                maximumDelaySeconds: z.ZodDefault<z.ZodNumber>;
                multiplier: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodLiteral<"anytype.upsert">;
            dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
            config: z.ZodOptional<z.ZodObject<{
                spaceId: z.ZodOptional<z.ZodString>;
                objectTypeId: z.ZodOptional<z.ZodString>;
                uniqueKey: z.ZodOptional<z.ZodString>;
                bulk: z.ZodDefault<z.ZodBoolean>;
                values: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>>;
            }, z.core.$strict>>;
            retry: z.ZodOptional<z.ZodObject<{
                attempts: z.ZodDefault<z.ZodNumber>;
                initialDelaySeconds: z.ZodDefault<z.ZodNumber>;
                maximumDelaySeconds: z.ZodDefault<z.ZodNumber>;
                multiplier: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodLiteral<"anytype.materialize">;
            dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
            config: z.ZodOptional<z.ZodObject<{
                spaceId: z.ZodOptional<z.ZodString>;
                collectionId: z.ZodOptional<z.ZodString>;
                bulk: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strict>>;
            retry: z.ZodOptional<z.ZodObject<{
                attempts: z.ZodDefault<z.ZodNumber>;
                initialDelaySeconds: z.ZodDefault<z.ZodNumber>;
                maximumDelaySeconds: z.ZodDefault<z.ZodNumber>;
                multiplier: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodLiteral<"transform">;
            dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
            config: z.ZodOptional<z.ZodObject<{
                transformRef: z.ZodOptional<z.ZodString>;
                inputStepId: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            retry: z.ZodOptional<z.ZodObject<{
                attempts: z.ZodDefault<z.ZodNumber>;
                initialDelaySeconds: z.ZodDefault<z.ZodNumber>;
                maximumDelaySeconds: z.ZodDefault<z.ZodNumber>;
                multiplier: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodLiteral<"http">;
            dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
            config: z.ZodOptional<z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
                method: z.ZodDefault<z.ZodEnum<{
                    GET: "GET";
                    POST: "POST";
                    PUT: "PUT";
                    PATCH: "PATCH";
                    DELETE: "DELETE";
                }>>;
                connectionRef: z.ZodString;
                secretRefs: z.ZodDefault<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            retry: z.ZodOptional<z.ZodObject<{
                attempts: z.ZodDefault<z.ZodNumber>;
                initialDelaySeconds: z.ZodDefault<z.ZodNumber>;
                maximumDelaySeconds: z.ZodDefault<z.ZodNumber>;
                multiplier: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodLiteral<"approval">;
            dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
            config: z.ZodOptional<z.ZodObject<{
                message: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            retry: z.ZodOptional<z.ZodObject<{
                attempts: z.ZodDefault<z.ZodNumber>;
                initialDelaySeconds: z.ZodDefault<z.ZodNumber>;
                maximumDelaySeconds: z.ZodDefault<z.ZodNumber>;
                multiplier: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodLiteral<"notify">;
            dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
            config: z.ZodOptional<z.ZodObject<{
                destination: z.ZodOptional<z.ZodString>;
                message: z.ZodOptional<z.ZodString>;
                connectionRef: z.ZodString;
                secretRefs: z.ZodDefault<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            retry: z.ZodOptional<z.ZodObject<{
                attempts: z.ZodDefault<z.ZodNumber>;
                initialDelaySeconds: z.ZodDefault<z.ZodNumber>;
                maximumDelaySeconds: z.ZodDefault<z.ZodNumber>;
                multiplier: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>], "kind">>;
        capabilities: z.ZodDefault<z.ZodArray<z.ZodEnum<{
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
        }>>>;
        retry: z.ZodDefault<z.ZodObject<{
            attempts: z.ZodDefault<z.ZodNumber>;
            initialDelaySeconds: z.ZodDefault<z.ZodNumber>;
            maximumDelaySeconds: z.ZodDefault<z.ZodNumber>;
            multiplier: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        budget: z.ZodDefault<z.ZodObject<{
            maximumRunsPerHour: z.ZodDefault<z.ZodNumber>;
            maximumStepsPerRun: z.ZodDefault<z.ZodNumber>;
            maximumEffectsPerRun: z.ZodDefault<z.ZodNumber>;
            maximumRunSeconds: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        behavior: z.ZodDefault<z.ZodObject<{
            backfill: z.ZodDefault<z.ZodBoolean>;
            includeSelfWrites: z.ZodDefault<z.ZodBoolean>;
            maximumCausalDepth: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        behaviorReferences: z.ZodDefault<z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<{
                transform: "transform";
                prompt: "prompt";
                template: "template";
                policy: "policy";
            }>;
            id: z.ZodString;
            digest: z.ZodString;
        }, z.core.$strict>>>;
        concurrency: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>;
}, z.core.$strict>>;
export declare function unsafeObjectKey(value: unknown, seen?: WeakSet<object>): string | undefined;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export declare function canonicalJson(value: JsonValue): string;
export declare function workflowApprovalMaterial(workflow: WorkflowDefinition): JsonValue;
export declare function workflowApprovalHash(workflow: WorkflowDefinition): string;
export declare function canonicalWorkflowDefinition(workflow: WorkflowDefinition): string;
export declare function canonicalStoredWorkflowDefinition(workflow: WorkflowDefinition): string;
export declare function canonicalStoredWorkflowApproval(workflow: WorkflowDefinition): string;
export declare function redactStoredWorkflowJson(value: string): string;
export declare function workflowVersionHash(workflow: WorkflowDefinition): string;
export declare function workflowSourceDigest(source: string): string;

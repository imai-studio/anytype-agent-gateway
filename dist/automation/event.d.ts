import { z } from "zod";
import { type JsonValue } from "./workflow.js";
export declare const normalizedEventKindSchema: z.ZodEnum<{
    "chat.message": "chat.message";
    "object.created": "object.created";
    "object.updated": "object.updated";
    "object.unreadable": "object.unreadable";
    "object.archived": "object.archived";
    "property.changed": "property.changed";
    "collection.added": "collection.added";
    "collection.removed": "collection.removed";
    "schedule.tick": "schedule.tick";
    "external.webhook": "external.webhook";
    "manual.run": "manual.run";
}>;
export declare const normalizedEventSourceSchema: z.ZodEnum<{
    chat: "chat";
    workflow: "workflow";
    manual: "manual";
    schedule: "schedule";
    poll: "poll";
    heart: "heart";
    external: "external";
    self: "self";
}>;
export declare const normalizedEventSchema: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodObject<{
    eventId: z.ZodString;
    dedupeKey: z.ZodString;
    kind: z.ZodEnum<{
        "chat.message": "chat.message";
        "object.created": "object.created";
        "object.updated": "object.updated";
        "object.unreadable": "object.unreadable";
        "object.archived": "object.archived";
        "property.changed": "property.changed";
        "collection.added": "collection.added";
        "collection.removed": "collection.removed";
        "schedule.tick": "schedule.tick";
        "external.webhook": "external.webhook";
        "manual.run": "manual.run";
    }>;
    source: z.ZodEnum<{
        chat: "chat";
        workflow: "workflow";
        manual: "manual";
        schedule: "schedule";
        poll: "poll";
        heart: "heart";
        external: "external";
        self: "self";
    }>;
    sourceEventId: z.ZodOptional<z.ZodString>;
    sourceRevision: z.ZodOptional<z.ZodObject<{
        modifiedAt: z.ZodNumber;
        fingerprint: z.ZodString;
    }, z.core.$strict>>;
    spaceId: z.ZodString;
    objectId: z.ZodOptional<z.ZodString>;
    editor: z.ZodOptional<z.ZodObject<{
        principalDigest: z.ZodString;
        provenance: z.ZodEnum<{
            "anytype-native": "anytype-native";
            "authenticated-chat": "authenticated-chat";
            "operator-cli": "operator-cli";
        }>;
    }, z.core.$strict>>;
    observedAt: z.ZodNumber;
    payload: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
    diff: z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodArray<z.ZodString>;
        before: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
        after: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
    }, z.core.$strict>>>;
    causationRunId: z.ZodOptional<z.ZodString>;
    causalDepth: z.ZodNumber;
    originEffectKey: z.ZodOptional<z.ZodString>;
    recordedAt: z.ZodNumber;
}, z.core.$strict>>;
export type NormalizedEventRecord = z.infer<typeof normalizedEventSchema>;

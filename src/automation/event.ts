import { z } from "zod";
import { canonicalJson, jsonValueSchema, unsafeObjectKey, type JsonValue } from "./workflow.js";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const normalizedEventKindSchema = z.enum([
  "chat.message",
  "object.created",
  "object.updated",
  "object.unreadable",
  "object.archived",
  "property.changed",
  "collection.added",
  "collection.removed",
  "schedule.tick",
  "external.webhook",
  "manual.run",
]);

export const normalizedEventSourceSchema = z.enum([
  "poll",
  "heart",
  "chat",
  "schedule",
  "external",
  "manual",
  "self",
]);

const normalizedEventObjectSchema = z
  .object({
    eventId: z.string().trim().min(1).max(512),
    dedupeKey: z.string().trim().min(1).max(1_024),
    kind: normalizedEventKindSchema,
    source: normalizedEventSourceSchema,
    sourceEventId: z.string().trim().min(1).max(1_024).optional(),
    sourceRevision: z
      .object({
        modifiedAt: z.number().int().nonnegative(),
        fingerprint: digestSchema,
      })
      .strict()
      .optional(),
    spaceId: z.string().trim().min(1).max(512),
    objectId: z.string().trim().min(1).max(512).optional(),
    editor: z
      .object({
        principalDigest: digestSchema,
        provenance: z.enum(["anytype-native", "authenticated-chat", "operator-cli"]),
      })
      .strict()
      .optional(),
    observedAt: z.number().int().nonnegative(),
    payload: jsonValueSchema,
    diff: z
      .array(
        z
          .object({
            path: z.array(z.string().max(512)).min(1).max(64),
            before: jsonValueSchema.optional(),
            after: jsonValueSchema.optional(),
          })
          .strict()
          .refine((entry) => entry.before !== undefined || entry.after !== undefined, {
            message: "Event diff entries need a before or after value",
          }),
      )
      .max(1_000)
      .optional(),
    causationRunId: z.string().trim().min(1).max(512).optional(),
    causalDepth: z.number().int().min(0).max(100),
    originEffectKey: z.string().trim().min(1).max(1_024).optional(),
    recordedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((event, context) => {
    if (canonicalJson(event.payload).length > 1_000_000)
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "Event payload is too large",
      });
    if (event.diff && canonicalJson(event.diff as JsonValue).length > 1_000_000)
      context.addIssue({ code: "custom", path: ["diff"], message: "Event diff is too large" });
  });

export const normalizedEventSchema = z.preprocess((value, context) => {
  const unsafe = unsafeObjectKey(value);
  if (unsafe)
    context.addIssue({ code: "custom", message: `Unsafe object key is not allowed: ${unsafe}` });
  return value;
}, normalizedEventObjectSchema);

export type NormalizedEventRecord = z.infer<typeof normalizedEventSchema>;

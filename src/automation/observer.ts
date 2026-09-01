import { createHash } from "node:crypto";
import YAML from "yaml";
import type { AgentConfig } from "../config.js";
import { principalFromParticipantId } from "../principal.js";
import { Store } from "../store.js";
import type { AnytypePort, AnytypeWorkflowObject } from "../types.js";
import { evaluateWorkflowAuthority, evaluateWorkflowPolicy } from "./policy.js";
import type { WorkflowObserverState, WorkflowVersionRecord } from "./store-types.js";
import {
  canonicalJson,
  canonicalWorkflowDefinition,
  workflowApprovalHash,
  workflowApprovalMaterial,
  workflowDefinitionSchema,
  workflowSourceDigest,
  workflowVersionHash,
} from "./workflow.js";

type ObserverConfig = AgentConfig["automation"];

export type WorkflowObserverScanResult = {
  spaceId: string;
  objects: number;
  changes: number;
  archived: number;
  failed: boolean;
  nextScanAt: number;
};

export class WorkflowObserver {
  private cursor = 0;

  constructor(
    private readonly anytype: AnytypePort,
    private readonly store: Store,
    private readonly config: ObserverConfig,
    private readonly log: (event: string, fields?: Record<string, unknown>) => void,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    const spaces = [...new Set(this.config.allowedSpaceIds)];
    while (!signal.aborted) {
      const now = this.now();
      const due = spaces.filter((spaceId) => this.state(spaceId, now).nextScanAt <= now);
      if (!due.length) {
        const next = Math.min(...spaces.map((spaceId) => this.state(spaceId, now).nextScanAt));
        await wait(Math.max(1, next - now), signal);
        continue;
      }
      const selected = due[this.cursor % due.length]!;
      this.cursor += 1;
      const result = await this.scanSpaceOnce(selected);
      this.log(
        result.failed ? "workflow_observer_scan_failed" : "workflow_observer_scan_complete",
        {
          ...result,
        },
      );
    }
  }

  async scanSpaceOnce(spaceId: string): Promise<WorkflowObserverScanResult> {
    const startedAt = this.now();
    const state = this.state(spaceId, startedAt);
    try {
      const objects = await this.anytype.searchWorkflowObjects(
        spaceId,
        this.config.definitionTypeKeys,
        state.pageOffset,
        this.config.polling.pageSize,
      );
      let changes = 0;
      let watermarkModifiedAt = state.watermarkModifiedAt;
      let watermarkFingerprint = state.watermarkFingerprint;
      for (const object of objects) {
        const observed = this.observeObject(spaceId, object, startedAt);
        changes += observed.changed ? 1 : 0;
        if (
          compareRevision(
            object.modifiedAt,
            observed.sourceDigest,
            watermarkModifiedAt,
            watermarkFingerprint,
          ) > 0
        ) {
          watermarkModifiedAt = object.modifiedAt;
          watermarkFingerprint = observed.sourceDigest;
        }
      }
      const complete = objects.length < this.config.polling.pageSize;
      const archived = complete
        ? this.archiveMissing(spaceId, state.reconcileStartedAt, startedAt)
        : 0;
      changes += archived;
      const minimum = this.config.polling.minimumIntervalSeconds * 1_000;
      const maximum = this.config.polling.maximumIntervalSeconds * 1_000;
      const interval =
        changes > 0 || !complete
          ? minimum
          : Math.min(maximum, Math.max(minimum, state.pollIntervalMilliseconds * 2));
      const nextState: WorkflowObserverState = {
        spaceId,
        pageOffset: complete ? 0 : state.pageOffset + objects.length,
        reconcileStartedAt: complete ? startedAt + 1 : state.reconcileStartedAt,
        watermarkModifiedAt,
        watermarkFingerprint,
        pollIntervalMilliseconds: interval,
        consecutiveFailures: 0,
        nextScanAt: startedAt + jitter(interval, this.random),
        lastScanAt: startedAt,
        lastSuccessAt: startedAt,
      };
      this.store.saveWorkflowObserverState(nextState);
      return {
        spaceId,
        objects: objects.length,
        changes,
        archived,
        failed: false,
        nextScanAt: nextState.nextScanAt,
      };
    } catch (error) {
      const minimum = this.config.polling.minimumIntervalSeconds * 1_000;
      const maximum = this.config.polling.maximumIntervalSeconds * 1_000;
      const interval = Math.min(maximum, Math.max(minimum, state.pollIntervalMilliseconds * 2));
      const nextState: WorkflowObserverState = {
        ...state,
        pollIntervalMilliseconds: interval,
        consecutiveFailures: state.consecutiveFailures + 1,
        nextScanAt: startedAt + jitter(interval, this.random),
        lastScanAt: startedAt,
        lastError:
          error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
      };
      this.store.saveWorkflowObserverState(nextState);
      return {
        spaceId,
        objects: 0,
        changes: 0,
        archived: 0,
        failed: true,
        nextScanAt: nextState.nextScanAt,
      };
    }
  }

  private state(spaceId: string, now: number): WorkflowObserverState {
    return (
      this.store.workflowObserverState(spaceId) ?? {
        spaceId,
        pageOffset: 0,
        reconcileStartedAt: now,
        watermarkModifiedAt: 0,
        watermarkFingerprint: "",
        pollIntervalMilliseconds: this.config.polling.minimumIntervalSeconds * 1_000,
        consecutiveFailures: 0,
        nextScanAt: 0,
      }
    );
  }

  private observeObject(
    spaceId: string,
    object: AnytypeWorkflowObject,
    observedAt: number,
  ): { changed: boolean; sourceDigest: string } {
    const previous = this.store.workflowDefinition(spaceId, object.id);
    const workflowId = stableId("workflow", spaceId, object.id);
    let sourceDigest = workflowSourceDigest(object.source ?? "");
    if (object.archived) {
      this.store.recordWorkflowDefinitionStatus({
        workflowId,
        spaceId,
        objectId: object.id,
        name: object.name,
        state: "archived",
        sourceModifiedAt: object.modifiedAt,
        sourceDigest,
        seenAt: observedAt,
      });
      const inserted = this.recordEvent(
        "object.archived",
        spaceId,
        object,
        sourceDigest,
        observedAt,
        {
          workflowId,
          state: "archived",
        },
      );
      return { changed: previous?.state !== "archived" || inserted, sourceDigest };
    }

    let definition: ReturnType<typeof workflowDefinitionSchema.parse> | undefined;
    const errors: string[] = [];
    try {
      const definitionSource = extractWorkflowSource(object.source);
      sourceDigest = workflowSourceDigest(definitionSource);
      let parsed: unknown;
      try {
        parsed = YAML.parse(definitionSource, { maxAliasCount: 0 });
      } catch {
        errors.push("Workflow YAML could not be parsed");
      }
      if (parsed !== undefined) {
        const result = workflowDefinitionSchema.safeParse(parsed);
        if (result.success) definition = result.data;
        else
          errors.push(
            ...result.error.issues.map(
              (issue) =>
                `${issue.path.length ? issue.path.join(".") : "definition"}: ${issue.message}`,
            ),
          );
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Workflow source is invalid");
    }
    const principal = principalFromParticipantId(object.editorParticipantId);
    if (!principal) errors.push("Workflow editor identity is not verified");
    let version: WorkflowVersionRecord | undefined;
    if (definition) {
      const policy = evaluateWorkflowPolicy(definition, { sourceSpaceId: spaceId });
      if (policy.missingCapabilities.length)
        errors.push(
          `Workflow omits required capabilities: ${policy.missingCapabilities.join(", ")}`,
        );
      const authority = evaluateWorkflowAuthority(definition, this.config, {
        sourceSpaceId: spaceId,
        ...(principal
          ? {
              editor: {
                principalId: principal.participantId,
                provenance: principal.provenance,
              },
            }
          : {}),
      });
      errors.push(...authority.violations);
      if (!errors.length) {
        const candidate: WorkflowVersionRecord = {
          workflowId,
          spaceId,
          objectId: object.id,
          name: definition.metadata.name,
          versionHash: workflowVersionHash(definition),
          approvalHash: workflowApprovalHash(definition),
          schemaVersion: 1,
          canonicalDefinitionJson: canonicalWorkflowDefinition(definition),
          canonicalApprovalJson: canonicalJson(workflowApprovalMaterial(definition)),
          sourceDigest,
          riskTier: policy.riskTier,
          requiredCapabilities: policy.requiredCapabilities,
          sourceModifiedAt: object.modifiedAt,
          ...(principal
            ? {
                editorPrincipalDigest: principalDigest(principal.participantId),
                editorProvenance: principal.provenance,
              }
            : {}),
          createdAt: observedAt,
        };
        version =
          this.store.workflowVersion(workflowId, candidate.versionHash) ??
          this.store.saveWorkflowVersion(candidate);
      }
    }
    const state = errors.length ? "invalid" : "valid";
    const validationErrors = [...new Set(errors.map((error) => error.slice(0, 500)))]
      .sort()
      .slice(0, 50);
    const current = this.store.recordWorkflowDefinitionStatus({
      workflowId,
      spaceId,
      objectId: object.id,
      name: definition?.metadata.name ?? object.name,
      state,
      sourceModifiedAt: object.modifiedAt,
      sourceDigest,
      seenAt: observedAt,
      validationErrors,
    });
    const changed =
      previous?.activeVersionHash !== current.activeVersionHash ||
      previous?.state !== current.state ||
      previous?.sourceModifiedAt !== current.sourceModifiedAt ||
      previous?.sourceDigest !== current.sourceDigest;
    const alreadyRecorded = this.store.hasNormalizedDefinitionRevision(
      spaceId,
      object.id,
      object.modifiedAt,
      sourceDigest,
    );
    const inserted = alreadyRecorded
      ? false
      : this.recordEvent(
          this.store.hasNormalizedObjectEvent(spaceId, object.id)
            ? "object.updated"
            : "object.created",
          spaceId,
          object,
          sourceDigest,
          observedAt,
          {
            workflowId,
            state,
            enabled: definition?.spec.enabled ?? false,
            valid: errors.length === 0,
            ...(version
              ? { versionHash: version.versionHash, approvalHash: version.approvalHash }
              : {}),
          },
        );
    return { changed: changed || inserted, sourceDigest };
  }

  private archiveMissing(spaceId: string, startedAt: number, observedAt: number): number {
    const archived = this.store.workflowDefinitionsMissingSince(spaceId, startedAt);
    for (const definition of archived) {
      const sourceDigest = definition.sourceDigest || workflowSourceDigest("");
      this.recordEvent(
        "object.archived",
        spaceId,
        {
          id: definition.objectId,
          name: definition.name,
          typeKey: "missing",
          modifiedAt: definition.sourceModifiedAt,
          archived: true,
        },
        sourceDigest,
        observedAt,
        { workflowId: definition.workflowId, state: "archived", reason: "missing-on-reconcile" },
      );
      this.store.recordWorkflowDefinitionStatus({
        workflowId: definition.workflowId,
        spaceId,
        objectId: definition.objectId,
        name: definition.name,
        state: "archived",
        sourceModifiedAt: definition.sourceModifiedAt,
        sourceDigest,
        seenAt: definition.lastSeenAt,
      });
    }
    return archived.length;
  }

  private recordEvent(
    kind: "object.created" | "object.updated" | "object.archived",
    spaceId: string,
    object: AnytypeWorkflowObject,
    sourceDigest: string,
    observedAt: number,
    payload: Record<string, string | boolean>,
  ): boolean {
    const principal = principalFromParticipantId(object.editorParticipantId);
    const identity = `${spaceId}\0${object.id}\0${object.modifiedAt}\0${sourceDigest}\0${kind}`;
    const dedupeKey = stableId("dedupe", identity);
    if (this.store.hasNormalizedEvent(dedupeKey)) return false;
    this.store.recordNormalizedEvent({
      eventId: stableId("event", identity),
      dedupeKey,
      kind,
      source: "poll",
      sourceEventId: `${object.id}:${object.modifiedAt}:${sourceDigest}`,
      sourceRevision: { modifiedAt: object.modifiedAt, fingerprint: sourceDigest },
      spaceId,
      objectId: object.id,
      ...(principal
        ? {
            editor: {
              principalDigest: principalDigest(principal.participantId),
              provenance: principal.provenance,
            },
          }
        : {}),
      observedAt,
      payload,
      causalDepth: 0,
      recordedAt: observedAt,
    });
    return true;
  }
}

function extractWorkflowSource(source: string | undefined): string {
  if (!source) throw new Error("Workflow object has no source body");
  if (source.length > 1_000_000) throw new Error("Workflow source exceeds 1000000 characters");
  const matches = [...source.matchAll(/```(?:yaml|yml)\s*\n([\s\S]*?)\n```/gi)];
  if (matches.length !== 1)
    throw new Error("Workflow object needs exactly one fenced YAML definition");
  return matches[0]![1]!;
}

function stableId(domain: string, ...parts: string[]): string {
  return `sha256:${createHash("sha256")
    .update(`knot.workflow.${domain}.v1\0`)
    .update(parts.join("\0"))
    .digest("hex")}`;
}

function principalDigest(participantId: string): string {
  return stableId("principal", participantId);
}

function compareRevision(
  modifiedAt: number,
  fingerprint: string,
  otherModifiedAt: number,
  otherFingerprint: string,
): number {
  return modifiedAt === otherModifiedAt
    ? fingerprint.localeCompare(otherFingerprint)
    : modifiedAt - otherModifiedAt;
}

function jitter(milliseconds: number, random: () => number): number {
  return Math.max(1, Math.round(milliseconds * (0.9 + random() * 0.2)));
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

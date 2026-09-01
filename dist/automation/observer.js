import { createHash } from "node:crypto";
import YAML from "yaml";
import { AnytypeHttpError } from "../anytype-client.js";
import { principalFromParticipantId } from "../principal.js";
import { evaluateWorkflowAuthority, evaluateWorkflowPolicy } from "./policy.js";
import { canonicalJson, canonicalWorkflowDefinition, workflowApprovalHash, workflowApprovalMaterial, workflowDefinitionSchema, workflowSourceDigest, workflowVersionHash, } from "./workflow.js";
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_IDENTIFIER_CODE_UNITS = 512;
export class WorkflowObserver {
    anytype;
    store;
    config;
    log;
    now;
    random;
    cursor = 0;
    constructor(anytype, store, config, log, now = Date.now, random = Math.random) {
        this.anytype = anytype;
        this.store = store;
        this.config = config;
        this.log = log;
        this.now = now;
        this.random = random;
    }
    async run(signal) {
        const spaces = [...new Set(this.config.allowedSpaceIds.map(requiredIdentifier))];
        let escapedFailures = 0;
        while (!signal.aborted) {
            try {
                const now = this.now();
                const due = spaces.filter((spaceId) => this.state(spaceId, now).nextScanAt <= now);
                if (!due.length) {
                    const next = Math.min(...spaces.map((spaceId) => this.state(spaceId, now).nextScanAt));
                    await wait(Math.max(1, next - now), signal);
                    continue;
                }
                const selected = due[this.cursor % due.length];
                this.cursor += 1;
                const result = await this.scanSpaceOnce(selected);
                escapedFailures = 0;
                this.log(result.failed ? "workflow_observer_scan_failed" : "workflow_observer_scan_complete", {
                    ...result,
                });
            }
            catch (error) {
                if (signal.aborted)
                    return;
                escapedFailures = Math.min(escapedFailures + 1, 30);
                const minimum = this.config.polling.minimumIntervalSeconds * 1_000;
                const maximum = this.config.polling.maximumIntervalSeconds * 1_000;
                const interval = Math.min(maximum, minimum * 2 ** Math.min(escapedFailures - 1, 20));
                const retryInMilliseconds = jitter(interval, this.random);
                this.log("workflow_observer_loop_failed", {
                    errorCode: observerErrorCode(error),
                    consecutiveFailures: escapedFailures,
                    retryInMilliseconds,
                });
                try {
                    await wait(retryInMilliseconds, signal);
                }
                catch {
                    if (signal.aborted)
                        return;
                    throw error;
                }
            }
        }
    }
    async scanSpaceOnce(spaceId) {
        spaceId = requiredIdentifier(spaceId);
        const startedAt = this.now();
        const state = this.state(spaceId, startedAt);
        try {
            const objects = (await this.anytype.searchWorkflowObjects(spaceId, this.config.definitionTypeKeys, state.pageOffset, this.config.polling.pageSize)).slice(0, this.config.polling.pageSize);
            let changes = 0;
            let watermarkModifiedAt = state.watermarkModifiedAt;
            let watermarkFingerprint = state.watermarkFingerprint;
            for (const object of objects) {
                if (!validIdentifier(object.id) ||
                    object.observationError === "object_identifier_invalid") {
                    this.log("workflow_observer_object_dropped", {
                        spaceId,
                        errorCode: "object_identifier_invalid",
                    });
                    continue;
                }
                let observed;
                try {
                    observed = this.observeObject(spaceId, object, startedAt);
                }
                catch (error) {
                    const errorCode = observationFailureCode(error);
                    try {
                        observed = this.observeReadFailure(spaceId, object, startedAt, errorCode);
                        this.log("workflow_observer_object_failed", {
                            spaceId,
                            objectIdDigest: stableId("object-log", object.id),
                            errorCode,
                        });
                    }
                    catch {
                        observed = { changed: false, sourceDigest: workflowSourceDigest("") };
                        this.log("workflow_observer_object_failed", {
                            spaceId,
                            objectIdDigest: stableId("object-log", object.id),
                            errorCode: "read_failure_persistence_failed",
                        });
                    }
                }
                changes += observed.changed ? 1 : 0;
                const modifiedAt = validNativeRevision(object.modifiedAt, startedAt)
                    ? object.modifiedAt
                    : 0;
                if (compareRevision(modifiedAt, observed.sourceDigest, watermarkModifiedAt, watermarkFingerprint) > 0) {
                    watermarkModifiedAt = modifiedAt;
                    watermarkFingerprint = observed.sourceDigest;
                }
            }
            const pageComplete = objects.length < this.config.polling.pageSize;
            const archiveResult = pageComplete
                ? await this.archiveMissing(spaceId, state.reconcileStartedAt, startedAt, this.config.polling.pageSize)
                : { changed: 0, complete: false, failures: 0, errorCode: undefined };
            const archived = archiveResult.changed;
            const complete = pageComplete && archiveResult.complete;
            const failed = archiveResult.failures > 0;
            changes += archived;
            const minimum = this.config.polling.minimumIntervalSeconds * 1_000;
            const maximum = this.config.polling.maximumIntervalSeconds * 1_000;
            const interval = failed
                ? Math.min(maximum, Math.max(minimum, state.pollIntervalMilliseconds * 2))
                : changes > 0 || !complete
                    ? minimum
                    : Math.min(maximum, Math.max(minimum, state.pollIntervalMilliseconds * 2));
            const nextState = {
                spaceId,
                pageOffset: complete ? 0 : state.pageOffset + objects.length,
                reconcileStartedAt: complete ? startedAt + 1 : state.reconcileStartedAt,
                watermarkModifiedAt,
                watermarkFingerprint,
                pollIntervalMilliseconds: interval,
                consecutiveFailures: failed ? state.consecutiveFailures + 1 : 0,
                nextScanAt: startedAt + jitter(interval, this.random),
                lastScanAt: startedAt,
                ...(failed
                    ? {
                        ...(state.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
                        lastError: archiveResult.errorCode ?? "reconciliation_failed",
                    }
                    : { lastSuccessAt: startedAt }),
            };
            this.store.saveWorkflowObserverState(nextState);
            return {
                spaceId,
                objects: objects.length,
                changes,
                archived,
                failed,
                nextScanAt: nextState.nextScanAt,
            };
        }
        catch (error) {
            const minimum = this.config.polling.minimumIntervalSeconds * 1_000;
            const maximum = this.config.polling.maximumIntervalSeconds * 1_000;
            const interval = Math.min(maximum, Math.max(minimum, state.pollIntervalMilliseconds * 2));
            const nextState = {
                ...state,
                pollIntervalMilliseconds: interval,
                consecutiveFailures: state.consecutiveFailures + 1,
                nextScanAt: startedAt + jitter(interval, this.random),
                lastScanAt: startedAt,
                lastError: observerErrorCode(error),
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
    state(spaceId, now) {
        return (this.store.workflowObserverState(spaceId) ?? {
            spaceId,
            pageOffset: 0,
            reconcileStartedAt: now,
            watermarkModifiedAt: 0,
            watermarkFingerprint: "",
            pollIntervalMilliseconds: this.config.polling.minimumIntervalSeconds * 1_000,
            consecutiveFailures: 0,
            nextScanAt: 0,
        });
    }
    observeObject(spaceId, object, observedAt) {
        if (!validNativeRevision(object.modifiedAt, observedAt))
            return this.observeReadFailure(spaceId, { ...object, modifiedAt: 0 }, observedAt, "native_revision_missing");
        const previous = this.store.workflowDefinition(spaceId, object.id);
        const sourceDigest = workflowSourceDigest(object.source ?? "");
        if (object.observationError === "object_identifier_invalid")
            throw new ObserverValidationError("object_read_failed");
        if (object.observationError)
            return this.observeReadFailure(spaceId, object, observedAt, object.observationError);
        const workflowId = stableId("workflow", spaceId, object.id);
        if (object.archived) {
            this.store.recordWorkflowDefinitionStatus({
                workflowId,
                spaceId,
                objectId: object.id,
                name: boundedLabel(object.name),
                state: "archived",
                sourceModifiedAt: object.modifiedAt,
                sourceDigest,
                seenAt: observedAt,
            });
            const inserted = this.recordEvent("object.archived", spaceId, object, sourceDigest, observedAt, {
                workflowId,
                state: "archived",
            });
            return { changed: previous?.state !== "archived" || inserted, sourceDigest };
        }
        let definition;
        let definitionSourceDigest;
        const errors = [];
        try {
            const definitionSource = extractWorkflowSource(object.source);
            definitionSourceDigest = workflowSourceDigest(definitionSource);
            let parsed;
            try {
                parsed = YAML.parse(definitionSource, { maxAliasCount: 0 });
            }
            catch {
                errors.push("yaml_invalid");
            }
            if (parsed !== undefined) {
                const result = workflowDefinitionSchema.safeParse(parsed);
                if (result.success)
                    definition = result.data;
                else
                    errors.push("schema_invalid");
            }
        }
        catch (error) {
            errors.push(sourceErrorCode(error));
        }
        const principal = principalFromParticipantId(object.editorParticipantId);
        if (!principal)
            errors.push("editor_unverified");
        let version;
        if (definition && definitionSourceDigest) {
            const policy = evaluateWorkflowPolicy(definition, { sourceSpaceId: spaceId });
            if (policy.missingCapabilities.length)
                errors.push("capabilities_missing");
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
            errors.push(...authority.violations.map(authorityErrorCode));
            if (!errors.length) {
                const candidate = {
                    workflowId,
                    spaceId,
                    objectId: object.id,
                    name: definition.metadata.name,
                    versionHash: workflowVersionHash(definition),
                    approvalHash: workflowApprovalHash(definition),
                    schemaVersion: 1,
                    canonicalDefinitionJson: canonicalWorkflowDefinition(definition),
                    canonicalApprovalJson: canonicalJson(workflowApprovalMaterial(definition)),
                    sourceDigest: definitionSourceDigest,
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
                version = this.store.saveWorkflowVersion(candidate, sourceDigest);
            }
        }
        const state = errors.length ? "invalid" : "valid";
        const validationErrors = [...new Set(errors)].sort().slice(0, 50);
        const current = this.store.recordWorkflowDefinitionStatus({
            workflowId,
            spaceId,
            objectId: object.id,
            name: boundedLabel(definition?.metadata.name ?? object.name),
            state,
            sourceModifiedAt: object.modifiedAt,
            sourceDigest,
            seenAt: observedAt,
            validationErrors,
        });
        const changed = previous?.activeVersionHash !== current.activeVersionHash ||
            previous?.state !== current.state ||
            previous?.sourceModifiedAt !== current.sourceModifiedAt ||
            previous?.sourceDigest !== current.sourceDigest;
        const alreadyRecorded = this.store.hasNormalizedDefinitionRevision(spaceId, object.id, object.modifiedAt, sourceDigest);
        const inserted = alreadyRecorded
            ? false
            : this.recordEvent(this.store.hasNormalizedObjectEvent(spaceId, object.id)
                ? "object.updated"
                : "object.created", spaceId, object, sourceDigest, observedAt, {
                workflowId,
                state,
                enabled: definition?.spec.enabled ?? false,
                valid: errors.length === 0,
                ...(version
                    ? { versionHash: version.versionHash, approvalHash: version.approvalHash }
                    : {}),
            });
        return { changed: changed || inserted, sourceDigest };
    }
    observeReadFailure(spaceId, object, observedAt, errorCode) {
        const previous = this.store.workflowDefinition(spaceId, object.id);
        const workflowId = stableId("workflow", spaceId, object.id);
        const sourceDigest = workflowSourceDigest("");
        const current = this.store.recordWorkflowDefinitionReadFailure({
            workflowId,
            spaceId,
            objectId: object.id,
            name: boundedLabel(object.name),
            sourceDigest,
            sourceModifiedAt: object.modifiedAt,
            seenAt: observedAt,
            errorCode,
        });
        const inserted = this.recordEvent("object.unreadable", spaceId, object, sourceDigest, observedAt, { workflowId, state: "invalid", valid: false, errorCode });
        return {
            changed: inserted ||
                previous?.state !== current.state ||
                previous?.sourceDigest !== current.sourceDigest,
            sourceDigest: current.sourceDigest,
        };
    }
    async archiveMissing(spaceId, startedAt, observedAt, limit) {
        const candidates = this.store.workflowDefinitionsMissingSince(spaceId, startedAt, limit + 1);
        const batch = candidates.slice(0, limit);
        let changed = 0;
        let failures = 0;
        let errorCode;
        for (const definition of batch) {
            const objectId = validIdentifier(definition.objectId);
            if (!objectId) {
                failures += 1;
                errorCode ??= "reconciliation_identifier_invalid";
                this.store.recordWorkflowDefinitionStatus({ ...definition, seenAt: observedAt });
                this.log("workflow_observer_object_failed", {
                    spaceId,
                    errorCode: "reconciliation_identifier_invalid",
                });
                continue;
            }
            try {
                let confirmed = false;
                let confirmationFailed = false;
                try {
                    const object = await this.anytype.getWorkflowObject(spaceId, objectId);
                    confirmed = object.archived === true || object.is_archived === true;
                }
                catch (error) {
                    confirmed = error instanceof AnytypeHttpError && [404, 410].includes(error.status);
                    confirmationFailed = !confirmed;
                }
                if (!confirmed) {
                    this.store.recordWorkflowDefinitionStatus({ ...definition, seenAt: observedAt });
                    if (confirmationFailed) {
                        failures += 1;
                        errorCode ??= "reconciliation_confirmation_failed";
                        this.log("workflow_observer_object_failed", {
                            spaceId,
                            objectIdDigest: stableId("object-log", objectId),
                            errorCode: "reconciliation_confirmation_failed",
                        });
                    }
                    continue;
                }
                const sourceDigest = definition.sourceDigest || workflowSourceDigest("");
                const inserted = this.recordEvent("object.archived", spaceId, {
                    id: objectId,
                    name: definition.name,
                    typeKey: "missing",
                    modifiedAt: definition.sourceModifiedAt,
                    archived: true,
                }, sourceDigest, observedAt, { workflowId: definition.workflowId, state: "archived", reason: "missing-on-reconcile" });
                this.store.recordWorkflowDefinitionStatus({
                    workflowId: definition.workflowId,
                    spaceId,
                    objectId,
                    name: definition.name,
                    state: "archived",
                    sourceModifiedAt: definition.sourceModifiedAt,
                    sourceDigest,
                    seenAt: observedAt,
                });
                if (inserted || definition.state !== "archived")
                    changed += 1;
            }
            catch {
                // Even if the archive event or transition failed, move this candidate behind the
                // current reconciliation boundary so another poisoned object can be attempted next.
                // If this fallback store write also fails, let the whole scan enter durable backoff.
                this.store.recordWorkflowDefinitionStatus({ ...definition, seenAt: observedAt });
                failures += 1;
                errorCode ??= "reconciliation_persistence_failed";
                this.log("workflow_observer_object_failed", {
                    spaceId,
                    objectIdDigest: stableId("object-log", objectId),
                    errorCode: "reconciliation_persistence_failed",
                });
            }
        }
        return {
            changed,
            complete: candidates.length <= limit,
            failures,
            ...(errorCode ? { errorCode } : {}),
        };
    }
    recordEvent(kind, spaceId, object, sourceDigest, observedAt, payload) {
        const principal = principalFromParticipantId(object.editorParticipantId);
        const identity = `${spaceId}\0${object.id}\0${object.modifiedAt}\0${sourceDigest}\0${kind}`;
        const dedupeKey = stableId("dedupe", identity);
        if (this.store.hasNormalizedEvent(dedupeKey))
            return false;
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
function extractWorkflowSource(source) {
    if (!source)
        throw new ObserverValidationError("source_missing");
    if (source.length > 1_000_000)
        throw new ObserverValidationError("source_too_large");
    let cursor = 0;
    let match;
    while (cursor < source.length) {
        const fenceStart = source.indexOf("```", cursor);
        if (fenceStart < 0)
            break;
        const headerEnd = source.indexOf("\n", fenceStart + 3);
        if (headerEnd < 0)
            break;
        const language = source
            .slice(fenceStart + 3, headerEnd)
            .trim()
            .toLowerCase();
        if (language !== "yaml" && language !== "yml") {
            cursor = headerEnd + 1;
            continue;
        }
        const fenceEnd = source.indexOf("\n```", headerEnd + 1);
        if (fenceEnd < 0)
            throw new ObserverValidationError("source_fence_invalid");
        if (match !== undefined)
            throw new ObserverValidationError("source_fence_invalid");
        match = source.slice(headerEnd + 1, fenceEnd);
        cursor = fenceEnd + 4;
    }
    if (match === undefined)
        throw new ObserverValidationError("source_fence_invalid");
    return match;
}
class ObserverValidationError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
function sourceErrorCode(error) {
    return error instanceof ObserverValidationError ? error.code : "source_invalid";
}
function authorityErrorCode(error) {
    if (error.startsWith("Capability"))
        return "capability_unauthorized";
    if (error.startsWith("Risk tier"))
        return "risk_tier_unauthorized";
    if (error.startsWith("Space"))
        return "space_unauthorized";
    if (error.startsWith("Workflow editor"))
        return "editor_unverified";
    if (error.startsWith("Editor"))
        return "editor_unauthorized";
    if (error.startsWith("Project"))
        return "project_unauthorized";
    if (error.startsWith("Connection"))
        return "connection_unauthorized";
    if (error.startsWith("Secret"))
        return "secret_unauthorized";
    return "authority_rejected";
}
function observerErrorCode(error) {
    if (error instanceof AnytypeHttpError) {
        if (error.status === 401)
            return "anytype_unauthorized";
        if (error.status === 403)
            return "anytype_forbidden";
        if (error.status === 429)
            return "anytype_rate_limited";
        return error.status >= 500 ? "anytype_unavailable" : "anytype_request_failed";
    }
    return "scan_failed";
}
function validNativeRevision(modifiedAt, observedAt) {
    return (Number.isSafeInteger(modifiedAt) &&
        modifiedAt >= 0 &&
        modifiedAt <= observedAt + MAX_FUTURE_CLOCK_SKEW_MS);
}
function boundedLabel(value) {
    const label = [...value.trim()].slice(0, 256).join("");
    return label || "Workflow";
}
function validIdentifier(value) {
    if (!value || value.length > MAX_IDENTIFIER_CODE_UNITS)
        return undefined;
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next < 0xdc00 || next > 0xdfff)
                return undefined;
            index += 1;
        }
        else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff)
            return undefined;
    }
    return value;
}
function requiredIdentifier(value) {
    const identifier = validIdentifier(value);
    if (!identifier)
        throw new Error("Workflow space ID is invalid");
    return identifier;
}
function observationFailureCode(error) {
    if (error instanceof AnytypeHttpError)
        return "anytype_request_failed";
    if (error instanceof Error && /\b(collision|divergent|immutable)\b/iu.test(error.message))
        return "workflow_integrity_failed";
    return "store_write_failed";
}
function stableId(domain, ...parts) {
    return `sha256:${createHash("sha256")
        .update(`knot.workflow.${domain}.v1\0`)
        .update(parts.join("\0"))
        .digest("hex")}`;
}
function principalDigest(participantId) {
    return stableId("principal", participantId);
}
function compareRevision(modifiedAt, fingerprint, otherModifiedAt, otherFingerprint) {
    if (modifiedAt !== otherModifiedAt)
        return modifiedAt - otherModifiedAt;
    if (fingerprint === otherFingerprint)
        return 0;
    return fingerprint > otherFingerprint ? 1 : -1;
}
function jitter(milliseconds, random) {
    return Math.max(1, Math.round(milliseconds * (0.9 + random() * 0.2)));
}
function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted)
            return reject(signal.reason);
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

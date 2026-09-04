import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";
import { evaluateWorkflowAuthority, evaluateWorkflowPolicy, } from "./policy.js";
import { WorkflowQueue } from "./runner-store.js";
import { canonicalJson, canonicalStoredWorkflowApproval, canonicalStoredWorkflowDefinition, isSensitiveWorkflowTextPath, workflowApprovalHash, workflowApprovalMaterial, workflowDefinitionSchema, workflowPrincipalDigest, workflowSourceDigest, workflowVersionHash, } from "./workflow.js";
const SOURCE_REFETCH_REQUIRED = "source_refetch_required: workflow text is not stored; refetch and reverify the source before execution";
const MAXIMUM_DELIVERY_DISPATCH_ATTEMPTS = 24;
export class NoEffectWorkflowStepExecutor {
    async execute(claim, definition, _signal) {
        const step = definition.spec.steps.find((candidate) => candidate.id === claim.step.stepId);
        if (!step)
            return { ok: false, error: "Workflow step no longer exists", retryable: false };
        if (step.kind === "transform" && !step.config)
            return { ok: true, result: { kind: "no-op", stepId: step.id } };
        return {
            ok: false,
            error: `No effect executor is installed for workflow step kind: ${step.kind}`,
            retryable: false,
        };
    }
}
export class WorkflowRunner {
    store;
    config;
    log;
    executor;
    now;
    sourceResolver;
    extensions;
    queue;
    workerIds;
    inFlight = new Map();
    lastReauthorizedRunId;
    constructor(store, config, log, executor = new NoEffectWorkflowStepExecutor(), now = Date.now, sourceResolver, extensions = []) {
        this.store = store;
        this.config = config;
        this.log = log;
        this.executor = executor;
        this.now = now;
        this.sourceResolver = sourceResolver;
        this.extensions = extensions;
        this.queue = new WorkflowQueue(store);
        this.workerIds = Array.from({ length: config.runner.workerCount }, (_, index) => `workflow-worker-${index + 1}-${randomUUID()}`);
    }
    async run(signal) {
        try {
            while (!signal.aborted) {
                try {
                    await this.tickOnce(signal);
                }
                catch (error) {
                    this.log("workflow_runner_tick_failed", {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
                if (signal.aborted)
                    break;
                try {
                    await wait(this.config.runner.pollIntervalMilliseconds, signal);
                }
                catch (error) {
                    if (!signal.aborted)
                        throw error;
                }
            }
        }
        finally {
            for (const execution of this.inFlight.values())
                execution.controller.abort(new Error("Workflow runner stopped"));
            await Promise.allSettled([...this.inFlight.values()].map((execution) => execution.promise));
            await Promise.allSettled(this.extensions.map((extension) => extension.stop?.()));
        }
    }
    async tickOnce(signal = new AbortController().signal) {
        // Revoke authority and cancel running work before any extension or source
        // lookup can wait on a network dependency.
        const revoked = this.reauthorizeActiveRuns(this.now());
        this.reconcileInFlight(this.now());
        for (const extension of this.extensions) {
            try {
                await extension.beforeTick?.(signal);
            }
            catch (error) {
                this.log("workflow_runner_extension_failed", {
                    phase: "before_tick",
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        const now = this.now();
        const initialized = this.queue.initializeMatcher(now);
        const sourceResumed = await this.resumeSourceRefetchSteps(now, signal);
        this.reconcileInFlight(now);
        const expired = this.queue.expireRunDeadlines(now, this.config.runner.batchSize);
        const recovered = this.queue.recoverExpiredLeases((runId, stepId) => this.retryFor(runId, stepId), now, this.config.runner.batchSize);
        const matched = initialized ? 0 : this.matchEventsOnce(now);
        const dispatched = this.dispatchOnce(now);
        let claimed = 0;
        const started = [];
        for (const workerId of this.workerIds) {
            if (this.inFlight.has(workerId))
                continue;
            const claim = this.queue.claimStep(workerId, undefined, this.config.runner.leaseSeconds * 1_000, now);
            if (!claim)
                continue;
            claimed += 1;
            const controller = new AbortController();
            const executionSignal = AbortSignal.any([signal, controller.signal]);
            const promise = this.executeClaim(claim, signal, controller.signal)
                .catch((error) => {
                if (!executionSignal.aborted)
                    this.log("workflow_runner_worker_failed", {
                        error: error instanceof Error ? error.message : String(error),
                    });
            })
                .finally(() => {
                if (this.inFlight.get(workerId)?.claim.attempt.attemptId === claim.attempt.attemptId)
                    this.inFlight.delete(workerId);
            });
            this.inFlight.set(workerId, { claim, controller, promise });
            started.push(promise);
        }
        if (started.length)
            await Promise.race([
                Promise.allSettled(started).then(() => undefined),
                new Promise((resolve) => setImmediate(resolve)),
            ]);
        if (matched || dispatched || recovered || revoked || expired || claimed || sourceResumed)
            this.log("workflow_runner_tick_complete", {
                matched,
                dispatched,
                recovered,
                revoked,
                expired,
                claimed,
                sourceResumed,
            });
        for (const extension of this.extensions) {
            try {
                await extension.afterTick?.(signal);
            }
            catch (error) {
                this.log("workflow_runner_extension_failed", {
                    phase: "after_tick",
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    reconcileInFlight(now) {
        for (const execution of this.inFlight.values())
            if (!this.queue.claimMayExecute(execution.claim.run.runId, execution.claim.step.stepId, execution.claim.attempt.fencingToken, now))
                execution.controller.abort(new Error("Workflow authority, version, approval, or cancellation state changed"));
    }
    matchEventsOnce(now = this.now()) {
        let matched = 0;
        const cursor = this.queue.cursor();
        const events = this.queue.eventsAfter(cursor, this.config.runner.batchSize);
        for (const event of events) {
            const deliveries = [];
            if (!isControlPlaneEvent(event)) {
                for (const version of this.queue.activeWorkflowVersions()) {
                    let definition;
                    try {
                        definition = parseStoredVersion(version).definition;
                    }
                    catch (error) {
                        this.log(storedVersionFailure(error).event, {
                            workflowIdDigest: stableId("workflow-log", version.workflowId),
                        });
                        continue;
                    }
                    if (!definition.spec.enabled || !matchesAnyTrigger(version.workflowId, definition, event))
                        continue;
                    const authorization = this.authorize(version, definition);
                    if (!authorization?.evaluation.allowed)
                        continue;
                    if (event.causalDepth > authorization.evaluation.effectiveLimits.maximumCausalDepth)
                        continue;
                    if (!definition.spec.behavior.includeSelfWrites && event.source === "self")
                        continue;
                    this.ensureAutomaticApproval(version, authorization.evaluation, now);
                    deliveries.push({
                        deliveryId: stableId("delivery", version.workflowId, version.versionHash, event.dedupeKey),
                        workflowId: version.workflowId,
                        versionHash: version.versionHash,
                        eventId: event.eventId,
                        eventDedupeKey: event.dedupeKey,
                        approvalHash: version.approvalHash,
                        authorityHash: authorization.evaluation.authorityHash,
                        actorPrincipalDigest: event.editor?.principalDigest ?? version.editorPrincipalDigest,
                        actorProvenance: event.editor?.provenance ?? version.editorProvenance,
                    });
                    matched += 1;
                }
            }
            this.queue.createDeliveriesAndAdvanceCursor(event, deliveries, now);
        }
        return matched;
    }
    dispatchOnce(now = this.now()) {
        let dispatched = 0;
        for (const delivery of this.queue.pendingDeliveries(this.config.runner.batchSize, now)) {
            if (!this.queue.isActiveVersion(delivery.workflowId, delivery.versionHash)) {
                this.queue.cancelDelivery(delivery.deliveryId);
                continue;
            }
            const version = this.store.workflowVersion(delivery.workflowId, delivery.versionHash);
            if (!version)
                continue;
            let definition;
            try {
                definition = parseStoredVersion(version).definition;
            }
            catch (error) {
                this.queue.deadLetterDelivery(delivery.deliveryId);
                this.log(storedVersionFailure(error).event, {
                    workflowIdDigest: stableId("workflow-log", delivery.workflowId),
                });
                continue;
            }
            const authorization = this.authorize(version, definition);
            if (!authorization?.evaluation.allowed) {
                this.deferPendingDelivery(delivery, "current local authority rejected the delivery", now);
                continue;
            }
            this.ensureAutomaticApproval(version, authorization.evaluation, now);
            const authorityHash = authorization.evaluation.authorityHash;
            const approval = this.store.currentWorkflowApproval(delivery.workflowId, delivery.approvalHash, authorityHash, now);
            if (!approval) {
                this.deferApprovalPendingDelivery(delivery, now);
                continue;
            }
            if (this.queue.dispatchDelivery(delivery.deliveryId, definition, authorization.evaluation.effectiveLimits, authorityHash, now))
                dispatched += 1;
            else
                this.deferTransientDelivery(delivery, now);
        }
        return dispatched;
    }
    deferPendingDelivery(delivery, reason, now) {
        const baseDelay = Math.max(1_000, this.config.runner.pollIntervalMilliseconds * 5);
        const delay = Math.min(300_000, baseDelay * 2 ** Math.min(delivery.dispatchAttemptCount, 6));
        const outcome = this.queue.deferDelivery(delivery.deliveryId, now + delay, MAXIMUM_DELIVERY_DISPATCH_ATTEMPTS);
        if (outcome === "dead_letter")
            this.log("workflow_delivery_dead_lettered", {
                workflowIdDigest: stableId("workflow-log", delivery.workflowId),
                reason,
                attempts: delivery.dispatchAttemptCount + 1,
            });
    }
    deferApprovalPendingDelivery(delivery, now) {
        const delay = Math.max(1_000, this.config.runner.pollIntervalMilliseconds * 5);
        this.queue.deferDeliveryForApproval(delivery.deliveryId, now + delay);
    }
    deferTransientDelivery(delivery, now) {
        const delay = Math.max(1_000, this.config.runner.pollIntervalMilliseconds * 5);
        this.queue.deferDeliveryTransient(delivery.deliveryId, now + delay);
    }
    async executeClaim(claim, shutdownSignal, cooperativeSignal) {
        const now = this.now();
        if (!this.queue.startStep(claim.run.runId, claim.step.stepId, claim.attempt.fencingToken, now))
            return;
        const heartbeat = this.startLeaseHeartbeat(claim);
        const executionScope = deadlineSignal(cooperativeSignal ? AbortSignal.any([shutdownSignal, cooperativeSignal]) : shutdownSignal, claim.step.leaseHardExpiresAt ?? claim.step.runDeadlineAt, this.now);
        try {
            const version = this.store.workflowVersion(claim.run.workflowId, claim.run.versionHash);
            if (!version) {
                this.queue.deadLetterRun(claim.run.runId, "Workflow version is unavailable", now);
                return;
            }
            let stored;
            if (heartbeat.leaseLost() ||
                !this.queue.claimMayExecute(claim.run.runId, claim.step.stepId, claim.attempt.fencingToken, this.now()))
                return;
            try {
                stored = parseStoredVersion(version);
            }
            catch (error) {
                const failure = storedVersionFailure(error);
                this.queue.deadLetterRun(claim.run.runId, failure.reason, this.now());
                return;
            }
            const resolution = await this.definitionForExecution(version, stored, executionScope.signal);
            if (!resolution.ok) {
                this.queue.requireSourceRefetch(claim.run.runId, claim.step.stepId, claim.attempt.fencingToken, resolution.reason, this.now());
                return;
            }
            const definition = resolution.definition;
            const authorization = this.authorize(version, definition);
            const approval = authorization?.evaluation.allowed
                ? this.store.currentWorkflowApproval(version.workflowId, version.approvalHash, authorization.evaluation.authorityHash, this.now())
                : undefined;
            if (!authorization?.evaluation.allowed ||
                authorization.evaluation.authorityHash !== claim.run.authorityHash ||
                !approval) {
                if (!this.queue.claimIsCurrent(claim.run.runId, claim.step.stepId, claim.attempt.fencingToken, this.now()))
                    return;
                this.queue.pauseRunForApproval(claim.run.runId, "Source revalidation changed the workflow authority or exact approval", this.now());
                return;
            }
            if (heartbeat.leaseLost() ||
                !this.queue.claimMayExecute(claim.run.runId, claim.step.stepId, claim.attempt.fencingToken, this.now()))
                return;
            if (executionScope.signal.aborted)
                throw executionScope.signal.reason;
            let execution;
            try {
                execution = await abortable(this.executor.execute(claim, definition, executionScope.signal), executionScope.signal);
            }
            catch (error) {
                if (executionScope.signal.aborted)
                    throw executionScope.signal.reason;
                execution = {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                    retryable: true,
                };
            }
            const finishedAt = this.now();
            const settled = execution.ok
                ? this.queue.completeStep(claim.run.runId, claim.step.stepId, claim.attempt.fencingToken, execution.result, finishedAt)
                : this.queue.failStep(claim.run.runId, claim.step.stepId, claim.attempt.fencingToken, execution.error, retryForDefinition(definition, claim.step.stepId), execution.retryable, finishedAt);
            if (!settled)
                this.handleRejectedSettlement(claim, finishedAt);
        }
        catch (error) {
            if (executionScope.timedOut())
                this.handleRejectedSettlement(claim, this.now());
            else if (cooperativeSignal?.aborted && !shutdownSignal.aborted) {
                const run = this.queue.run(claim.run.runId);
                if (run?.cancelRequestedAt !== undefined)
                    this.queue.failStep(claim.run.runId, claim.step.stepId, claim.attempt.fencingToken, run.cancelReason ?? "Workflow execution cancelled", this.retryFor(claim.run.runId, claim.step.stepId), false, this.now());
            }
            else if (!shutdownSignal.aborted)
                throw error;
        }
        finally {
            executionScope.stop();
            heartbeat.stop();
        }
    }
    startLeaseHeartbeat(claim) {
        const leaseMilliseconds = this.config.runner.leaseSeconds * 1_000;
        const intervalMilliseconds = Math.max(50, Math.floor(leaseMilliseconds / 3));
        let lost = false;
        const timer = setInterval(() => {
            try {
                if (!this.queue.heartbeat(claim.run.runId, claim.step.stepId, claim.attempt.fencingToken, leaseMilliseconds, this.now()))
                    lost = true;
            }
            catch (error) {
                lost = true;
                this.log("workflow_step_heartbeat_failed", {
                    workflowIdDigest: stableId("workflow-log", claim.run.workflowId),
                    stepId: claim.step.stepId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }, intervalMilliseconds);
        timer.unref();
        return { leaseLost: () => lost, stop: () => clearInterval(timer) };
    }
    handleRejectedSettlement(claim, now) {
        try {
            if (this.queue.recoverTimedOutClaim(claim.run.runId, claim.step.stepId, claim.attempt.fencingToken, this.retryFor(claim.run.runId, claim.step.stepId), now)) {
                this.log("workflow_step_timed_out", {
                    workflowIdDigest: stableId("workflow-log", claim.run.workflowId),
                    stepId: claim.step.stepId,
                    recovered: true,
                });
                return;
            }
        }
        catch (error) {
            this.log("workflow_step_timeout_recovery_failed", {
                workflowIdDigest: stableId("workflow-log", claim.run.workflowId),
                stepId: claim.step.stepId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        const reason = "Workflow executor returned after its lease was lost; the outcome requires operator reconciliation";
        const deadLettered = this.queue.deadLetterRun(claim.run.runId, reason, now);
        this.log("workflow_step_settlement_rejected", {
            workflowIdDigest: stableId("workflow-log", claim.run.workflowId),
            stepId: claim.step.stepId,
            deadLettered,
        });
    }
    reauthorizeActiveRuns(now) {
        let revoked = 0;
        const runs = this.queue.activeRunsAfter(this.lastReauthorizedRunId, this.config.runner.batchSize);
        for (const run of runs) {
            this.lastReauthorizedRunId = run.runId;
            const version = this.store.workflowVersion(run.workflowId, run.versionHash);
            if (!version) {
                if (this.queue.deadLetterRun(run.runId, "Workflow version is unavailable", now))
                    revoked += 1;
                continue;
            }
            let definition;
            try {
                definition = parseStoredVersion(version).definition;
            }
            catch (error) {
                const failure = storedVersionFailure(error);
                if (this.queue.deadLetterRun(run.runId, failure.reason, now))
                    revoked += 1;
                continue;
            }
            if (!definition.spec.enabled ||
                !this.queue.isActiveVersion(run.workflowId, run.versionHash)) {
                if (this.queue.cancelRun(run.runId, workflowPrincipalDigest("system:workflow-runner"), definition.spec.enabled
                    ? "Workflow version was superseded or archived"
                    : "Workflow was disabled", now))
                    revoked += 1;
                continue;
            }
            const authorization = this.authorize(version, definition);
            if (!authorization?.evaluation.allowed) {
                if (this.queue.pauseRunForApproval(run.runId, "Current local authority does not permit this run", now))
                    revoked += 1;
                continue;
            }
            this.ensureAutomaticApproval(version, authorization.evaluation, now);
            const currentHash = authorization.evaluation.authorityHash;
            const approval = this.store.currentWorkflowApproval(run.workflowId, run.approvalHash, currentHash, now);
            if (!approval) {
                if (this.queue.pauseRunForApproval(run.runId, "Current authority requires a new exact approval", now))
                    revoked += 1;
            }
            else
                this.queue.resumeRunWithAuthority(run.runId, currentHash, now);
        }
        return revoked;
    }
    authorize(version, definition) {
        if (!version.editorPrincipalDigest || !version.editorProvenance)
            return undefined;
        const participantId = this.config.allowedAuthorIds.find((candidate) => workflowPrincipalDigest(candidate) === version.editorPrincipalDigest);
        if (!participantId)
            return undefined;
        return {
            participantId,
            evaluation: evaluateWorkflowAuthority(definition, this.config, {
                sourceSpaceId: version.spaceId,
                editor: { principalId: participantId, provenance: version.editorProvenance },
            }),
        };
    }
    ensureAutomaticApproval(version, authority, now) {
        if (authority.riskTier !== "T0")
            return;
        const latest = this.store.latestWorkflowApproval(version.workflowId, version.approvalHash);
        if (latest && latest.decision !== "approved")
            return;
        if (this.store.currentWorkflowApproval(version.workflowId, version.approvalHash, authority.authorityHash, now))
            return;
        this.store.recordWorkflowApproval({
            decisionId: randomUUID(),
            workflowId: version.workflowId,
            approvalHash: version.approvalHash,
            decision: "approved",
            mode: "automatic",
            authorityHash: authority.authorityHash,
            actorPrincipalDigest: version.editorPrincipalDigest,
            reason: "T0 workflow approved by the configured local policy",
            decidedAt: now,
        });
    }
    retryFor(runId, stepId) {
        const run = this.queue.run(runId);
        if (!run)
            throw new Error("Unknown workflow run");
        const version = this.store.workflowVersion(run.workflowId, run.versionHash);
        if (!version)
            throw new Error("Workflow version is unavailable");
        return retryForDefinition(parseStoredVersion(version).definition, stepId);
    }
    async resumeSourceRefetchSteps(now, shutdownSignal) {
        if (!this.sourceResolver)
            return 0;
        let resumed = 0;
        for (const step of this.queue.sourceRefetchSteps(now, this.config.runner.batchSize)) {
            if (shutdownSignal.aborted)
                break;
            const run = this.queue.run(step.runId);
            if (!run)
                continue;
            const version = this.store.workflowVersion(run.workflowId, run.versionHash);
            if (!version)
                continue;
            let stored;
            try {
                stored = parseStoredVersion(version);
            }
            catch (error) {
                const failure = storedVersionFailure(error);
                this.queue.deadLetterRun(run.runId, failure.reason, now);
                continue;
            }
            const refetchScope = deadlineSignal(shutdownSignal, Math.min(step.runDeadlineAt, now + step.timeoutSeconds * 1_000), this.now);
            let resolution;
            try {
                resolution = await this.definitionForExecution(version, stored, refetchScope.signal);
            }
            catch {
                if (shutdownSignal.aborted)
                    break;
                this.deferSourceRefetch(step, stored.definition, "source_refetch_timed_out: source resolution exceeded its bounded deadline", this.now());
                continue;
            }
            finally {
                refetchScope.stop();
            }
            if (!resolution.ok) {
                this.deferSourceRefetch(step, stored.definition, resolution.reason, now);
                continue;
            }
            const authorization = this.authorize(version, resolution.definition);
            if (!authorization?.evaluation.allowed) {
                this.deferSourceRefetch(step, stored.definition, "source_reverification_failed: current local authority rejected the refetched definition", now);
                continue;
            }
            const approval = this.store.currentWorkflowApproval(version.workflowId, version.approvalHash, authorization.evaluation.authorityHash, now);
            if (!approval) {
                this.deferSourceRefetch(step, stored.definition, "source_reverification_failed: no exact approval exists for the refetched definition", now);
                continue;
            }
            if (this.queue.resumeSourceRefetchStep(step.runId, step.stepId, now))
                resumed += 1;
        }
        return resumed;
    }
    deferSourceRefetch(step, definition, reason, now) {
        const retry = retryForDefinition(definition, step.stepId);
        const attempt = step.sourceRefetchAttemptCount + 1;
        const delaySeconds = Math.min(retry.maximumDelaySeconds, retry.initialDelaySeconds * Math.pow(retry.multiplier, Math.max(0, attempt - 1)));
        const outcome = this.queue.deferSourceRefetch(step.runId, step.stepId, reason, now + Math.max(1_000, Math.round(delaySeconds * 1_000)), retry.attempts, now);
        if (outcome === "dead_letter")
            this.log("workflow_source_refetch_dead_lettered", {
                workflowIdDigest: stableId("workflow-log", step.workflowId),
                stepId: step.stepId,
                attempts: attempt,
            });
    }
    async definitionForExecution(version, stored, signal) {
        if (signal.aborted)
            throw signal.reason;
        if (!stored.sensitiveText.size)
            return { ok: true, definition: stored.definition };
        if (!this.sourceResolver)
            return { ok: false, reason: SOURCE_REFETCH_REQUIRED };
        let snapshot;
        try {
            snapshot = await abortable(this.sourceResolver.refetch(version, signal), signal);
        }
        catch {
            if (signal.aborted)
                throw signal.reason;
            return { ok: false, reason: SOURCE_REFETCH_REQUIRED };
        }
        if (!snapshot)
            return { ok: false, reason: SOURCE_REFETCH_REQUIRED };
        try {
            return { ok: true, definition: verifyRefetchedDefinition(version, snapshot) };
        }
        catch (error) {
            if (error instanceof WorkflowSourceSchemaError)
                return {
                    ok: false,
                    reason: "source_schema_rejected: refetched workflow source does not satisfy the supported schema",
                };
            return {
                ok: false,
                reason: "source_reverification_failed: refetched workflow source did not match the stored version, approval, editor, and revision hashes",
            };
        }
    }
}
class StoredWorkflowSchemaError extends Error {
}
class WorkflowIntegrityError extends Error {
}
class WorkflowSourceSchemaError extends Error {
}
function storedVersionFailure(error) {
    if (error instanceof StoredWorkflowSchemaError)
        return {
            event: "workflow_version_schema_rejected",
            reason: "workflow_version_schema_rejected: stored definition does not satisfy the supported schema",
        };
    return {
        event: "workflow_version_integrity_failed",
        reason: "workflow_version_integrity_failed: stored definition, approval, or policy did not match its immutable hashes",
    };
}
function parseStoredVersion(version) {
    let raw;
    try {
        raw = JSON.parse(version.storedDefinitionJson);
    }
    catch (cause) {
        throw new WorkflowIntegrityError("Stored workflow definition is not JSON", { cause });
    }
    if (canonicalJson(raw) !== version.storedDefinitionJson)
        throw new WorkflowIntegrityError("Stored workflow definition is not canonical JSON");
    const sensitiveText = new Map();
    let materialized;
    try {
        materialized = materializeStoredDefinition(raw, [], sensitiveText);
    }
    catch (cause) {
        throw new WorkflowIntegrityError("Stored workflow redaction material is invalid", { cause });
    }
    let definition;
    try {
        definition = workflowDefinitionSchema.parse(materialized);
    }
    catch (cause) {
        throw new StoredWorkflowSchemaError("Stored workflow definition does not satisfy the supported schema", { cause });
    }
    const policy = evaluateWorkflowPolicy(definition, { sourceSpaceId: version.spaceId });
    if (policy.riskTier !== version.riskTier ||
        canonicalJson(policy.requiredCapabilities) !== canonicalJson(version.requiredCapabilities))
        throw new WorkflowIntegrityError("Stored workflow policy no longer matches the immutable version record");
    if (!/^sha256:[a-f0-9]{64}$/.test(version.versionHash) ||
        !/^sha256:[a-f0-9]{64}$/.test(version.approvalHash) ||
        !/^sha256:[a-f0-9]{64}$/.test(version.sourceDigest))
        throw new WorkflowIntegrityError("Stored workflow digest is invalid");
    if (!sensitiveText.size) {
        if (workflowVersionHash(definition) !== version.versionHash ||
            workflowApprovalHash(definition) !== version.approvalHash ||
            canonicalJson(workflowApprovalMaterial(definition)) !== version.storedApprovalJson)
            throw new WorkflowIntegrityError("Stored workflow hashes no longer match the immutable definition");
    }
    else {
        const approval = JSON.parse(canonicalJson(workflowApprovalMaterial(definition)));
        for (const [path, digest] of sensitiveText)
            setJsonPath(approval, path.split("/"), { redacted: true, digest });
        if (canonicalJson(approval) !== version.storedApprovalJson)
            throw new WorkflowIntegrityError("Stored workflow approval projection does not match the redacted definition");
    }
    return { definition, sensitiveText };
}
function materializeStoredDefinition(value, path, sensitiveText) {
    if (Array.isArray(value))
        return value.map((item, index) => materializeStoredDefinition(item, [...path, String(index)], sensitiveText));
    if (!value || typeof value !== "object")
        return value;
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
        const nestedPath = [...path, key];
        if (isSensitiveWorkflowTextPath(nestedPath)) {
            if (isRedactedText(nested)) {
                const pointer = nestedPath.join("/");
                sensitiveText.set(pointer, nested.digest);
                result[key] =
                    key === "href"
                        ? "https://redacted.invalid/"
                        : `[${key} unavailable until source refetch]`;
            }
            else
                result[key] = materializeStoredDefinition(nested, nestedPath, sensitiveText);
        }
        else
            result[key] = materializeStoredDefinition(nested, nestedPath, sensitiveText);
    }
    return result;
}
function isRedactedText(value) {
    return (!Array.isArray(value) &&
        value !== null &&
        typeof value === "object" &&
        Object.keys(value).length === 2 &&
        value.redacted === true &&
        typeof value.digest === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(value.digest));
}
function setJsonPath(target, path, value) {
    let current = target;
    for (const part of path.slice(0, -1)) {
        if (!current || typeof current !== "object")
            return false;
        const next = Array.isArray(current) ? current[Number(part)] : current[part];
        if (next === undefined)
            return false;
        current = next;
    }
    const final = path.at(-1);
    if (!final || !current || typeof current !== "object")
        return false;
    if (Array.isArray(current)) {
        const index = Number(final);
        if (!Number.isSafeInteger(index) || current[index] === undefined)
            return false;
        current[index] = value;
    }
    else {
        if (!(final in current))
            return false;
        current[final] = value;
    }
    return true;
}
function verifyRefetchedDefinition(version, snapshot) {
    if (snapshot.sourceModifiedAt !== version.sourceModifiedAt ||
        snapshot.editorProvenance !== version.editorProvenance ||
        workflowPrincipalDigest(snapshot.editorParticipantId) !== version.editorPrincipalDigest ||
        workflowSourceDigest(snapshot.definitionSource) !== version.sourceDigest)
        throw new Error("Refetched workflow source identity or revision changed");
    let definition;
    try {
        definition = workflowDefinitionSchema.parse(YAML.parse(snapshot.definitionSource, { maxAliasCount: 0 }));
    }
    catch (cause) {
        throw new WorkflowSourceSchemaError("Refetched workflow source does not satisfy the supported schema", { cause });
    }
    const policy = evaluateWorkflowPolicy(definition, { sourceSpaceId: version.spaceId });
    if (workflowVersionHash(definition) !== version.versionHash ||
        workflowApprovalHash(definition) !== version.approvalHash ||
        canonicalStoredWorkflowDefinition(definition) !== version.storedDefinitionJson ||
        canonicalStoredWorkflowApproval(definition) !== version.storedApprovalJson ||
        policy.riskTier !== version.riskTier ||
        canonicalJson(policy.requiredCapabilities) !== canonicalJson(version.requiredCapabilities))
        throw new Error("Refetched workflow source does not match the immutable version");
    return definition;
}
function retryForDefinition(definition, stepId) {
    return definition.spec.steps.find((step) => step.id === stepId)?.retry ?? definition.spec.retry;
}
function matchesAnyTrigger(workflowId, definition, event) {
    return definition.spec.triggers.some((trigger) => {
        if (trigger.kind === "manual")
            return (event.kind === "manual.run" &&
                event.editor !== undefined &&
                ["operator-cli", "authenticated-chat"].includes(event.editor.provenance) &&
                payloadString(event, "workflowId") === workflowId);
        if (trigger.kind === "schedule")
            return event.kind === "schedule.tick" && payloadString(event, "workflowId") === workflowId;
        if (trigger.kind === "anytype.chat")
            return (event.kind === "chat.message" &&
                event.editor !== undefined &&
                (!trigger.spaceId || trigger.spaceId === event.spaceId) &&
                (!trigger.chatId || trigger.chatId === payloadString(event, "chatId")));
        const eventName = event.kind.startsWith("object.") ? event.kind.slice("object.".length) : "";
        return (trigger.kind === "anytype.event" &&
            event.editor !== undefined &&
            event.editor.provenance === "anytype-native" &&
            trigger.events.includes(eventName) &&
            (!trigger.spaceId || trigger.spaceId === event.spaceId) &&
            (!trigger.objectTypeId || trigger.objectTypeId === payloadString(event, "objectTypeId")) &&
            Object.entries(trigger.filter).every(([key, value]) => JSON.stringify(payloadValue(event, key)) === JSON.stringify(value)));
    });
}
function isControlPlaneEvent(event) {
    return event.source === "workflow" && event.kind.startsWith("object.");
}
function payloadValue(event, key) {
    if (!event.payload || Array.isArray(event.payload) || typeof event.payload !== "object")
        return undefined;
    return event.payload[key];
}
function payloadString(event, key) {
    const value = payloadValue(event, key);
    return typeof value === "string" ? value : undefined;
}
function stableId(domain, ...parts) {
    return `sha256:${createHash("sha256")
        .update(`knot.workflow.${domain}.v1\0`)
        .update(parts.join("\0"))
        .digest("hex")}`;
}
function deadlineSignal(parent, deadline, now) {
    const controller = new AbortController();
    let timeoutReached = false;
    const onParentAbort = () => controller.abort(parent.reason);
    if (parent.aborted)
        onParentAbort();
    else
        parent.addEventListener("abort", onParentAbort, { once: true });
    const expire = () => {
        timeoutReached = true;
        controller.abort(new Error("Workflow execution lease hard deadline expired"));
    };
    const delay = deadline - now();
    const timer = delay <= 0 ? undefined : setTimeout(expire, delay);
    if (timer)
        timer.unref();
    else if (!parent.aborted)
        expire();
    return {
        signal: controller.signal,
        timedOut: () => timeoutReached,
        stop: () => {
            if (timer)
                clearTimeout(timer);
            parent.removeEventListener("abort", onParentAbort);
        },
    };
}
function abortable(operation, signal) {
    if (signal.aborted)
        return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        operation.then((value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
        });
    });
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

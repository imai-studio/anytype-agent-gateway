import type { AgentConfig } from "../config.js";
import {
  publicationAction,
  type PublicationContext,
  type PublicationPolicy,
  type PublishAction,
} from "../cloud-publication.js";
import type { PublicationOperation } from "../cloud-publication-outbox.js";
import { workflowAuthorityHash } from "./policy.js";
import type { WorkflowStepExecution, WorkflowStepExecutor } from "./runner.js";
import type { WorkflowClaim } from "./runner-store.js";
import {
  publishWebConfigSchema,
  workflowApprovalHash,
  type WorkflowDefinition,
} from "./workflow.js";

type RunnerConfig = AgentConfig["automation"];
type PublicationEffect = (
  input: PublishAction & { configFile?: string; policy?: PublicationPolicy },
  context?: PublicationContext,
) => Promise<PublicationOperation | Record<string, unknown>>;

/** Routes the closed publish.web effect through the existing Cloud publication outbox. */
export class PublishWebWorkflowStepExecutor implements WorkflowStepExecutor {
  constructor(
    private readonly config: RunnerConfig,
    private readonly fallback: WorkflowStepExecutor,
    private readonly effect: PublicationEffect = publicationAction,
  ) {}

  async execute(
    claim: WorkflowClaim,
    definition: WorkflowDefinition,
    signal: AbortSignal,
  ): Promise<WorkflowStepExecution> {
    const step = definition.spec.steps.find((candidate) => candidate.id === claim.step.stepId);
    if (!step) return { ok: false, error: "Workflow step no longer exists", retryable: false };
    if (step.kind !== "publish.web") return this.fallback.execute(claim, definition, signal);
    if (signal.aborted) throw signal.reason;

    // This is intentionally repeated at the last local boundary before the outbox/network effect.
    // It prevents a stale claim from using a changed approval or changed operator policy.
    if (claim.run.approvalHash !== workflowApprovalHash(definition))
      return { ok: false, error: "publish.web exact approval hash changed", retryable: false };
    if (claim.run.authorityHash !== workflowAuthorityHash(this.config))
      return { ok: false, error: "publish.web local authority changed", retryable: false };

    const parsed = publishWebConfigSchema.safeParse(step.config);
    if (!parsed.success)
      return { ok: false, error: "publish.web configuration is invalid", retryable: false };
    const input = parsed.data;
    if (!this.config.allowedConnections.includes(input.connectionRef))
      return { ok: false, error: "publish.web connection is not authorized", retryable: false };
    const connection = this.config.publishConnections[input.connectionRef];
    if (!connection)
      return { ok: false, error: "publish.web connection is not configured", retryable: false };

    const policy: PublicationPolicy = {
      allowedSiteIds: connection.allowedSiteIds,
      allowedSlugPrefixes: connection.allowedSlugPrefixes,
      allowUpdate: connection.allowUpdate,
      allowRollback: connection.allowRollback,
      allowDisable: connection.allowDisable,
      allowUnpublish: connection.allowUnpublish,
    };
    const action = mapAction(input);
    try {
      const result = await this.effect(
        { ...action, configFile: connection.cloudConfigFile, policy },
        { workerId: `workflow:${claim.attempt.attemptId}` },
      );
      if (!isPublicationOperation(result))
        return { ok: false, error: "publish.web returned no durable receipt", retryable: false };
      const operation = result;
      if (operation.state === "succeeded")
        return {
          ok: true,
          result: {
            operationId: operation.operationId,
            publicationId: operation.publicationId,
            state: operation.state,
          },
        };
      if (operation.state === "failed")
        return {
          ok: false,
          error: operation.lastErrorCode ?? "publish.web operation failed",
          retryable: false,
        };
      return {
        ok: false,
        error: operation.lastErrorCode ?? `publish.web operation is ${operation.state}`,
        retryable: true,
      };
    } catch {
      return {
        ok: false,
        error: "publish.web was rejected by local publication policy or configuration",
        retryable: false,
      };
    }
  }
}

function isPublicationOperation(
  value: PublicationOperation | Record<string, unknown>,
): value is PublicationOperation {
  return (
    typeof value.operationId === "string" &&
    typeof value.publicationId === "string" &&
    ["queued", "in-flight", "retrying", "succeeded", "failed"].includes(String(value.state))
  );
}

function mapAction(input: ReturnType<typeof publishWebConfigSchema.parse>): PublishAction {
  if (input.action === "create" || input.action === "update")
    return {
      action: "push",
      operation: input.action,
      siteId: input.siteId,
      publicationId: input.publicationId,
      slug: input.slug,
      document: input.document,
      ...(input.assetManifestId ? { assetManifestId: input.assetManifestId } : {}),
    };
  if (input.action === "rollback")
    return {
      action: "rollback",
      publicationId: input.publicationId,
      versionId: input.versionId,
    };
  if (input.action === "disable") return { action: "disable", publicationId: input.publicationId };
  if (input.action === "unpublish")
    return {
      action: "unpublish",
      publicationId: input.publicationId,
      confirmation: input.confirmation,
    };
  throw new Error("Unsupported publish.web lifecycle action");
}

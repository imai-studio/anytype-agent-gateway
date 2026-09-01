import type { AgentConfig } from "../config.js";
import { type PublicationContext, type PublicationPolicy, type PublishAction } from "../cloud-publication.js";
import type { PublicationOperation } from "../cloud-publication-outbox.js";
import type { WorkflowStepExecution, WorkflowStepExecutor } from "./runner.js";
import type { WorkflowClaim } from "./runner-store.js";
import { type WorkflowDefinition } from "./workflow.js";
type RunnerConfig = AgentConfig["automation"];
type PublicationEffect = (input: PublishAction & {
    configFile?: string;
    policy?: PublicationPolicy;
}, context?: PublicationContext) => Promise<PublicationOperation | Record<string, unknown>>;
/** Routes the closed publish.web effect through the existing Cloud publication outbox. */
export declare class PublishWebWorkflowStepExecutor implements WorkflowStepExecutor {
    private readonly config;
    private readonly fallback;
    private readonly effect;
    constructor(config: RunnerConfig, fallback: WorkflowStepExecutor, effect?: PublicationEffect);
    execute(claim: WorkflowClaim, definition: WorkflowDefinition, signal: AbortSignal): Promise<WorkflowStepExecution>;
}
export {};

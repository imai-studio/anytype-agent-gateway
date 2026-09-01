import type { WorkflowRunState } from "./automation/store-types.js";
type Output = (line: string) => void;
interface ReadOptions {
    agentConfigFile: string;
    json?: boolean;
    output?: Output;
}
interface MutationOptions extends ReadOptions {
    actorDigest?: string;
    yes: boolean;
    reasonCode?: string;
    now?: number;
}
export declare function workflowList(input: ReadOptions & {
    limit?: number;
}): Promise<void>;
export declare function workflowShow(input: ReadOptions & {
    workflowId: string;
}): Promise<void>;
export declare function workflowApprovalAction(input: MutationOptions & {
    workflowId: string;
    approvalHash: string;
    action: "approve" | "reject" | "revoke";
    expiresAt?: number;
}): Promise<void>;
export declare function workflowSetEnabled(input: MutationOptions & {
    workflowId: string;
    enabled: boolean;
}): Promise<void>;
export declare function workflowManualRun(input: MutationOptions & {
    workflowId: string;
    approvalHash: string;
}): Promise<void>;
export declare function workflowRunList(input: ReadOptions & {
    limit?: number;
    state?: WorkflowRunState;
}): Promise<void>;
export declare function workflowRunShow(input: ReadOptions & {
    runId: string;
}): Promise<void>;
export declare function workflowRunMutation(input: MutationOptions & {
    runId: string;
    action: "cancel" | "retry";
}): Promise<void>;
export declare function workflowEventList(input: ReadOptions & {
    limit?: number;
}): Promise<void>;
export declare function workflowAuditList(input: ReadOptions & {
    limit?: number;
}): Promise<void>;
export declare function workflowDeadLetterList(input: ReadOptions & {
    limit?: number;
}): Promise<void>;
export {};

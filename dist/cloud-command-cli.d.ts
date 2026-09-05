export declare function cloudCommandList(input: {
    agentConfigFile: string;
    json?: boolean;
    limit?: number;
    output?: (line: string) => void;
}): Promise<void>;
export declare function cloudCommandShow(input: {
    agentConfigFile: string;
    commandId: string;
    output?: (line: string) => void;
}): Promise<void>;
export declare function cloudCommandAction(input: {
    agentConfigFile: string;
    commandId: string;
    action: "approve" | "reject" | "cancel" | "retry" | "result-retry";
    reasonCode?: string;
    output?: (line: string) => void;
}): Promise<void>;

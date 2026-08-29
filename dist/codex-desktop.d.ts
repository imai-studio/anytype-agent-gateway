export type CodexDesktopAssociation = {
    projectId: string;
    projectName: string;
};
export declare function createCodexDesktopThread(input: {
    sourceThreadId?: string;
    workspace: string;
    title: string;
    codexHome?: string;
    pipePath?: string;
    timeoutMs?: number;
    codexNodePath?: string;
    helperPath?: string;
    nodeArguments?: string[];
}): Promise<string | undefined>;
export declare function hydrateCodexDesktopTask(input: {
    threadId: string;
    codexHome?: string;
    pipePath?: string;
    timeoutMs?: number;
    codexNodePath?: string;
    helperPath?: string;
    nodeArguments?: string[];
}): Promise<void>;
export declare function prepareCodexDesktopProject(input: {
    workspace: string;
    codexHome?: string;
}): Promise<CodexDesktopAssociation | undefined>;
export declare function associateCodexDesktopThread(input: {
    threadId: string;
    workspace: string;
    codexHome?: string;
    title?: string;
}): Promise<CodexDesktopAssociation | undefined>;
export declare function refreshCodexDesktopThread(input: {
    codexHome?: string;
    socketPath?: string;
    timeoutMs?: number;
}): Promise<boolean>;

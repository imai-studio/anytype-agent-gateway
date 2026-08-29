export type CodexDesktopAssociation = {
    projectId: string;
    projectName: string;
};
export declare function associateCodexDesktopThread(input: {
    threadId: string;
    workspace: string;
    codexHome?: string;
    title?: string;
}): Promise<CodexDesktopAssociation | undefined>;
export declare function refreshCodexDesktopThread(input: {
    threadId: string;
    title: string;
    codexHome?: string;
    appToolsServerPath?: string;
    pipePath?: string;
    nodePath?: string;
    timeoutMs?: number;
}): Promise<boolean>;

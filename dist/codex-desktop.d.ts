export type CodexDesktopAssociation = {
    projectId: string;
    projectName: string;
};
export declare function associateCodexDesktopThread(input: {
    threadId: string;
    workspace: string;
    codexHome?: string;
}): Promise<CodexDesktopAssociation | undefined>;

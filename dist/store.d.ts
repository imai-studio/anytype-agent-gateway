import { DatabaseSync } from "node:sqlite";
export declare class Store {
    readonly db: DatabaseSync;
    constructor(path: string);
    isInitialized(routeId: string): boolean;
    initialize(routeId: string, newestOrderId?: string): void;
    cursor(routeId: string): string | undefined;
    updateCursor(routeId: string, newestOrderId: string): void;
    isHandled(routeId: string, messageId: string, modifiedAt?: number, fingerprint?: string): boolean;
    markHandled(routeId: string, messageId: string, modifiedAt?: number, fingerprint?: string): void;
    unmarkHandled(routeId: string, messageId: string): void;
    createRun(run: {
        id: string;
        routeId: string;
        threadKey: string;
        triggerId: string;
        responseId: string;
        hop: number;
    }): void;
    updateRunResponse(id: string, responseId: string): void;
    isResponse(messageId: string): boolean;
    runningRuns(routeId: string): Array<{
        id: string;
        responseId: string;
    }>;
    finishRun(id: string, status: "done" | "failed" | "silent" | "cancelled"): void;
    recentActivations(routeId: string, threadKey: string, since: number): number;
    prune(before: number): void;
    cacheDiscussion(value: {
        spaceId: string;
        objectId: string;
        discussionId: string;
        objectName?: string;
        objectType?: string;
    }): void;
    knownDiscussionObjectIds(spaceId: string): Set<string>;
    listDiscussions(spaceId: string): Array<{
        objectId: string;
        discussionId: string;
        objectName?: string;
        objectType?: string;
    }>;
    codexAcpSession(sessionKey: string): string | undefined;
    saveCodexAcpSession(sessionKey: string, sessionId: string): void;
    deleteCodexAcpSession(sessionKey: string): void;
    close(): void;
}

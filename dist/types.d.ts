export type TextMark = {
    type: string;
    from?: number;
    to?: number;
    param?: string;
};
export type ChatAttachment = {
    target: string;
    type: "file" | "image" | "link";
};
export type ChatMessage = {
    id: string;
    order_id?: string;
    creator?: string;
    creator_name?: string;
    created_at?: number;
    modified_at?: number;
    reply_to_message_id?: string;
    content?: {
        text?: string;
        style?: string;
        marks?: TextMark[];
    };
    attachments?: ChatAttachment[];
    reactions?: Record<string, string[]>;
    mentioned?: boolean;
};
export type { AnytypePrincipal } from "./principal.js";
export type ConversationRef = {
    routeId: string;
    spaceId: string;
    spaceName?: string;
    chatId: string;
    kind: "chat" | "discussion";
    objectId?: string;
    discussionRootId?: string;
    objectName?: string;
    selfParticipantId?: string;
    managementEnabled?: boolean;
};
export type ContextBundle = {
    conversation: ConversationRef;
    trigger: ChatMessage;
    actor?: import("./principal.js").AnytypePrincipal;
    newSession?: boolean;
    history: ChatMessage[];
    replyAncestry: ChatMessage[];
    referencedObjects: Array<{
        id: string;
        name?: string;
        markdown?: string;
    } & Record<string, unknown>>;
    attachments?: Array<{
        messageId: string;
        objectId: string;
        type: ChatAttachment["type"];
        localPath?: string;
        contentType?: string;
        sourceObjectId?: string;
        error?: string;
    }>;
    mentionTargets?: Array<{
        name: string;
        participantId: string;
    }>;
};
export type RuntimeEvent = {
    type: "status";
    text: string;
} | {
    type: "text-delta";
    text: string;
    partId?: string;
    phase?: string;
    replace?: boolean;
} | {
    type: "thinking-delta";
    text: string;
    partId?: string;
    phase?: string;
    replace?: boolean;
} | {
    type: "tool";
    name: string;
    status: string;
} | {
    type: "silent";
    reason?: string;
};
export type RuntimeResult = {
    text: string;
    silent?: boolean;
    reason?: string;
};
export type RuntimeCapabilities = {
    steering: boolean;
    thinking: boolean;
    multipleOutputParts: boolean;
    sessionObservation: boolean;
    nativeScheduling: boolean;
    modelSelection: boolean;
};
export type RuntimeModelOption = {
    id: string;
    name: string;
    provider?: string;
    description?: string;
};
export type RuntimeModelState = {
    options: RuntimeModelOption[];
    currentModelId?: string;
    defaultModelId?: string;
    sessionId?: string;
};
export type RuntimeSessionOutput = {
    id: string;
    cursor: string;
    events: RuntimeEvent[];
    result: RuntimeResult;
};
export type RuntimeSessionObserver = {
    readonly cursor?: string;
    close(): Promise<void>;
};
export type RuntimeTurn = {
    conversation: ConversationRef;
    message: ChatMessage;
    actor?: import("./principal.js").AnytypePrincipal;
    replyTargetId: string;
    wasMentioned?: boolean;
    workspacePath?: string;
};
export type ActiveRuntime = {
    sessionKey?: string;
    sessionId?: string;
    modelState?: RuntimeModelState;
    result: Promise<RuntimeResult>;
    steer(message: string, turn?: RuntimeTurn): Promise<void>;
    cancel(): Promise<void>;
};
export interface RuntimeDriver {
    readonly name: string;
    readonly projectEnforcement: "enforced" | "advisory" | "unknown";
    readonly capabilities: RuntimeCapabilities;
    configureModel?(input: {
        sessionKey: string;
        turn?: RuntimeTurn;
        modelId?: string | null;
        defaultModelId?: string;
    }): Promise<RuntimeModelState>;
    start(input: {
        sessionKey: string;
        prompt: string;
        turn?: RuntimeTurn;
        modelId?: string | null;
        defaultModelId?: string;
    }, onEvent: (event: RuntimeEvent) => void): Promise<ActiveRuntime>;
    observeSession?(input: {
        sessionKey: string;
        afterCursor?: string;
        conversation?: ConversationRef;
    }, onOutput: (output: RuntimeSessionOutput) => Promise<void>): Promise<RuntimeSessionObserver>;
    doctor(): Promise<string[]>;
    close?(): Promise<void>;
}
export type AnytypeEvent = {
    type: string;
    payload?: {
        message?: ChatMessage;
    };
};
export type AnytypeSpace = {
    id: string;
    name: string;
    object?: string;
};
export type AnytypeMember = {
    id: string;
    name: string;
    identity?: string;
    status?: string;
};
export type AnytypeTag = {
    id: string;
    name: string;
    key?: string;
    color?: string;
};
export interface AnytypePort {
    getMessage(spaceId: string, chatId: string, messageId: string): Promise<ChatMessage>;
    listMessages(spaceId: string, chatId: string, limit: number, afterOrderId?: string): Promise<ChatMessage[]>;
    sendMessage(spaceId: string, chatId: string, input: {
        text: string;
        replyTo?: string;
        marks?: TextMark[];
        attachments?: ChatAttachment[];
    }): Promise<string>;
    editMessage(spaceId: string, chatId: string, messageId: string, text: string, marks?: TextMark[], attachments?: ChatAttachment[]): Promise<void>;
    deleteMessage(spaceId: string, chatId: string, messageId: string): Promise<void>;
    ensureReaction(spaceId: string, chatId: string, messageId: string, emoji: string, present: boolean, participantId?: string): Promise<void>;
    stream(spaceId: string, chatId: string, signal: AbortSignal): AsyncIterable<AnytypeEvent>;
    resolveSpace(selector: {
        id?: string;
        name?: string;
    }): Promise<{
        id: string;
        name: string;
    }>;
    listSpaces(): Promise<AnytypeSpace[]>;
    listMembers(spaceId: string): Promise<AnytypeMember[]>;
    resolveChat(spaceId: string, selector: {
        id?: string;
        name?: string;
    }): Promise<{
        id: string;
        name: string;
    }>;
    listChats(spaceId: string): Promise<Array<{
        id: string;
        name: string;
    }>>;
    getObject(spaceId: string, objectId: string): Promise<{
        id: string;
        name?: string;
        markdown?: string;
    } & Record<string, unknown>>;
    listPropertyTags(spaceId: string, propertyId: string): Promise<AnytypeTag[]>;
    createPropertyTag(spaceId: string, propertyId: string, input: {
        name: string;
        color: string;
    }): Promise<AnytypeTag>;
    updateObject(spaceId: string, objectId: string, input: {
        properties: Array<{
            key: string;
            multi_select: string[];
        }>;
    }): Promise<Record<string, unknown>>;
    searchObjects(spaceId: string, offset: number, limit: number): Promise<Array<{
        id: string;
        name?: string;
        type?: string;
    }>>;
    downloadFile?(spaceId: string, fileId: string, maxBytes: number): Promise<{
        bytes: Uint8Array;
        contentType?: string;
    }>;
}

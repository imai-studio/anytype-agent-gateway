import type { AgentConfig } from "./config.js";
import type { AnytypeEvent, AnytypeMember, AnytypePort, AnytypeSpace, AnytypeTag, ChatAttachment, ChatMessage, TextMark } from "./types.js";
export type DiscussionResolution = {
    objectId: string;
    discussionId?: string;
    error?: string;
};
export type DirectMessageResolution = {
    spaceId: string;
    chatId: string;
};
export declare class HeartDiscussionAdapter {
    private readonly config;
    constructor(config: AgentConfig);
    resolve(spaceId: string, objects: Array<{
        id: string;
    }>, createMissing: boolean): Promise<DiscussionResolution[]>;
    ensureDirectMessage(identity: string, signal?: AbortSignal): Promise<DirectMessageResolution>;
    hydrateMessages(chatId: string, messages: ChatMessage[]): Promise<ChatMessage[]>;
    sendMessage(chatId: string, input: {
        text: string;
        replyTo?: string;
        marks?: TextMark[];
        attachments?: ChatAttachment[];
    }): Promise<string>;
    editMessage(chatId: string, messageId: string, text: string, marks?: TextMark[], attachments?: ChatAttachment[]): Promise<void>;
    deleteMessage(chatId: string, messageId: string): Promise<void>;
    private mutate;
}
export declare class DiscussionAnytypePort implements AnytypePort {
    private readonly base;
    private readonly heart;
    constructor(base: AnytypePort, heart: HeartDiscussionAdapter);
    getMessage(spaceId: string, chatId: string, messageId: string): Promise<ChatMessage>;
    listMessages(spaceId: string, chatId: string, limit: number, afterOrderId?: string): Promise<ChatMessage[]>;
    sendMessage(_spaceId: string, chatId: string, input: {
        text: string;
        replyTo?: string;
        marks?: TextMark[];
        attachments?: ChatAttachment[];
    }): Promise<string>;
    editMessage(_spaceId: string, chatId: string, messageId: string, text: string, marks?: TextMark[], attachments?: ChatAttachment[]): Promise<void>;
    deleteMessage(_spaceId: string, chatId: string, messageId: string): Promise<void>;
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
    }>;
    listPropertyTags(spaceId: string, propertyId: string): Promise<AnytypeTag[]>;
    listProperties(spaceId: string): Promise<Record<string, unknown>[]>;
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
    downloadFile(spaceId: string, fileId: string, maxBytes: number): Promise<{
        bytes: Uint8Array;
        contentType?: string;
    }>;
    searchObjects(spaceId: string, offset: number, limit: number): Promise<Array<{
        id: string;
        name?: string;
        type?: string;
    }>>;
}

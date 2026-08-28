import type { AgentConfig } from "./config.js";
import type { AnytypeEvent, AnytypePort, ChatMessage, TextMark } from "./types.js";
type JsonRecord = Record<string, any>;
export declare class AnytypeClient implements AnytypePort {
    private readonly base;
    private readonly headers;
    private readonly participantId?;
    private readonly localReactions;
    private readonly reactionTails;
    private writeTail;
    private constructor();
    static create(config: AgentConfig): Promise<AnytypeClient>;
    private request;
    private requestWithRetry;
    resolveSpace(selector: {
        id?: string;
        name?: string;
    }): Promise<{
        id: string;
        name: string;
    }>;
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
    getMessage(spaceId: string, chatId: string, messageId: string): Promise<ChatMessage>;
    listMessages(spaceId: string, chatId: string, limit: number, afterOrderId?: string): Promise<ChatMessage[]>;
    sendMessage(spaceId: string, chatId: string, input: {
        text: string;
        replyTo?: string;
        marks?: TextMark[];
    }): Promise<string>;
    editMessage(spaceId: string, chatId: string, messageId: string, text: string, marks?: TextMark[]): Promise<void>;
    deleteMessage(spaceId: string, chatId: string, messageId: string): Promise<void>;
    ensureReaction(spaceId: string, chatId: string, messageId: string, emoji: string, present: boolean, participantId?: string | undefined): Promise<void>;
    private ensureReactionNow;
    stream(spaceId: string, chatId: string, signal: AbortSignal): AsyncIterable<AnytypeEvent>;
    getObject(spaceId: string, objectId: string): Promise<JsonRecord & {
        id: string;
    }>;
    listTypes(spaceId: string): Promise<JsonRecord[]>;
    getType(spaceId: string, typeId: string): Promise<JsonRecord>;
    listProperties(spaceId: string): Promise<JsonRecord[]>;
    getProperty(spaceId: string, propertyId: string): Promise<JsonRecord>;
    listPropertyTags(spaceId: string, propertyId: string): Promise<JsonRecord[]>;
    listTemplates(spaceId: string, typeId: string): Promise<JsonRecord[]>;
    searchObjects(spaceId: string, offset: number, limit: number): Promise<Array<{
        id: string;
        name?: string;
        type?: string;
    }>>;
    searchSpace(spaceId: string, input: {
        query?: string;
        types?: string[];
        offset?: number;
        limit?: number;
    }): Promise<JsonRecord[]>;
    createObject(spaceId: string, input: {
        type_key: string;
        name?: string;
        body?: string;
        template_id?: string;
        properties?: JsonRecord[];
        icon?: JsonRecord;
    }): Promise<JsonRecord>;
    updateObject(spaceId: string, objectId: string, input: {
        type_key?: string;
        name?: string;
        markdown?: string;
        properties?: JsonRecord[];
        icon?: JsonRecord;
    }): Promise<JsonRecord>;
    archiveObject(spaceId: string, objectId: string): Promise<JsonRecord>;
    addObjectsToList(spaceId: string, listId: string, objectIds: string[]): Promise<void>;
    listViews(spaceId: string, listId: string): Promise<JsonRecord[]>;
    listViewObjects(spaceId: string, listId: string, viewId: string, page?: {
        offset: number;
        limit: number;
    }): Promise<JsonRecord[]>;
    removeObjectFromList(spaceId: string, listId: string, objectId: string): Promise<void>;
    uploadFile(spaceId: string, path: string): Promise<JsonRecord>;
    private messagesPath;
    private messagePath;
    private listPages;
}
export declare function parseSseBlock(block: string): AnytypeEvent | undefined;
export {};

import type { AgentConfig } from "./config.js";
import type { AnytypeEvent, AnytypePort, ChatMessage, TextMark } from "./types.js";
export declare class AnytypeClient implements AnytypePort {
    private readonly base;
    private readonly headers;
    private readonly participantId?;
    private readonly localReactions;
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
    getMessage(spaceId: string, chatId: string, messageId: string): Promise<ChatMessage>;
    listMessages(spaceId: string, chatId: string, limit: number, afterOrderId?: string): Promise<ChatMessage[]>;
    sendMessage(spaceId: string, chatId: string, input: {
        text: string;
        replyTo?: string;
        marks?: TextMark[];
    }): Promise<string>;
    editMessage(spaceId: string, chatId: string, messageId: string, text: string, marks?: TextMark[]): Promise<void>;
    deleteMessage(spaceId: string, chatId: string, messageId: string): Promise<void>;
    ensureReaction(spaceId: string, chatId: string, messageId: string, emoji: string, present: boolean): Promise<void>;
    stream(spaceId: string, chatId: string, signal: AbortSignal): AsyncIterable<AnytypeEvent>;
    getObject(spaceId: string, objectId: string): Promise<{
        id: string;
        name?: string;
        markdown?: string;
    }>;
    searchObjects(spaceId: string, offset: number, limit: number): Promise<Array<{
        id: string;
        name?: string;
        type?: string;
    }>>;
    private messagesPath;
    private messagePath;
    private listPages;
}
export declare function parseSseBlock(block: string): AnytypeEvent | undefined;

import { type WakeConfig } from "./config.js";
import { type AnytypePrincipal } from "./principal.js";
export declare function enrollChatRoute(input: {
    configPath: string;
    spaceId: string;
    spaceName: string;
    chatId: string;
    chatName: string;
    wake: WakeConfig;
}): Promise<"enrolled" | "existing" | "disabled">;
export declare function setRouteWake(input: {
    configPath: string;
    routeId: string;
    humans: string;
    prefix?: string;
    actor?: AnytypePrincipal;
}): Promise<void>;
export declare function setRouteAccess(input: {
    configPath: string;
    routeId: string;
    actor?: AnytypePrincipal;
    operation: string;
    participantIds: string[];
}): Promise<string[]>;

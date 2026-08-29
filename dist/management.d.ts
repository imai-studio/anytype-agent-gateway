export declare function setRouteWake(input: {
    configPath: string;
    routeId: string;
    humans: string;
    prefix?: string;
}): Promise<void>;
export declare function setRouteAccess(input: {
    configPath: string;
    routeId: string;
    actorId: string;
    operation: string;
    participantIds: string[];
}): Promise<string[]>;

export declare function createIdentity(options: {
    command: string;
    name: string;
    invites: string[];
    apiKeyFile: string;
    dataPath?: string;
}): Promise<void>;
export declare function joinSpaces(command: string, invites: string[], dataPath?: string): Promise<void>;

export type ModelCommand = {
    kind: "list";
} | {
    kind: "status";
} | {
    kind: "set";
    model: string;
} | {
    kind: "reset";
} | {
    kind: "new";
    model: string;
};
export declare function parseModelCommand(text: string): ModelCommand | undefined;
export declare function modelAllowed(modelId: string, patterns: string[]): boolean;

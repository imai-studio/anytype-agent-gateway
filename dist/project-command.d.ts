export type ProjectCommand = {
    kind: "list";
} | {
    kind: "status";
} | {
    kind: "reset";
} | {
    kind: "set";
    project: string;
};
export declare function parseProjectCommand(text: string): ProjectCommand | undefined;

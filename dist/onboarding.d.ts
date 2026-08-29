export type InitPrompter = {
    question(message: string): Promise<string>;
};
export type InitOptions = {
    cwd?: string;
    output?: string;
};
export type InitResult = {
    output: string;
    workspace: string;
    agentsFile?: string;
    runtimeKind: "codex" | "openclaw";
};
export declare function runInitOnboarding(prompt: InitPrompter, options?: InitOptions): Promise<InitResult>;

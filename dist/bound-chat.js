import { createCodexTask, resolveConfiguredProject } from "./codex-task.js";
import { workspaceContextFile } from "./context.js";
import { enrollChatRoute } from "./management.js";
import { Store } from "./store.js";
export async function createBoundCodexChat(anytype, config, configPath, input, dependencies = {}) {
    if (!config.tools.anytype.enabled || !config.tools.anytype.allowWrite)
        throw new Error("Anytype chat creation is disabled for this agent");
    if (config.runtime.kind !== "codex" || !config.tools.codex.enabled)
        throw new Error("Codex task creation is disabled for this agent");
    const configuredSpace = config.spaces.find((space) => space.id === input.spaceId);
    if (!configuredSpace)
        throw new Error("Bound chats can only be created in a configured gateway space");
    if (!configuredSpace.chatDiscovery.enabled || !configuredSpace.chatDiscovery.autoEnroll)
        throw new Error("Bound chat creation requires chat discovery with auto-enrollment");
    const name = input.name.trim();
    if (!name)
        throw new Error("name is required");
    const project = await resolveConfiguredProject(config, input.project);
    const chat = await anytype.createChat(input.spaceId, { name });
    const routeId = `chat:${input.spaceId}:${chat.id}`;
    const sessionKey = `aag:${routeId}`;
    const prompt = boundTaskPrompt(config, sessionKey, input.prompt);
    let task;
    try {
        task = await (dependencies.createTask ?? createCodexTask)(config, {
            project,
            prompt,
        });
    }
    catch (error) {
        throw new Error(`Anytype chat ${chat.id} was created, but its Codex task could not be created: ${error instanceof Error ? error.message : String(error)}`);
    }
    const store = new Store(config.state.path);
    try {
        store.saveCodexAcpSession(sessionKey, task.thread_id);
        store.saveSessionBinding({
            threadKey: routeId,
            routeId,
            spaceId: input.spaceId,
            chatId: chat.id,
            runtime: "codex-acp",
            nativeSessionKey: sessionKey,
            nativeSessionId: task.thread_id,
            generation: 0,
            state: "active",
        });
        store.saveSessionWorkspace(routeId, task.project);
    }
    finally {
        store.close();
    }
    try {
        const enrollment = await (dependencies.enrollRoute ?? enrollChatRoute)({
            configPath,
            spaceId: input.spaceId,
            spaceName: configuredSpace.name ?? input.spaceId,
            chatId: chat.id,
            chatName: chat.name,
            wake: configuredSpace.chatDiscovery.wake,
        });
        if (enrollment === "disabled")
            throw new Error("chat route enrollment is disabled");
    }
    catch (error) {
        storeBindingCleanup(config.state.path, routeId, sessionKey);
        throw new Error(`Anytype chat ${chat.id} and Codex task ${task.thread_id} were created, but the route could not be enrolled: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
        chat_id: chat.id,
        chat_name: chat.name,
        route_id: routeId,
        thread_id: task.thread_id,
        project: task.project,
        status: "bound",
    };
}
function boundTaskPrompt(config, sessionKey, prompt) {
    const agentWorkspace = config.runtime.defaultProject;
    if (!agentWorkspace)
        return prompt;
    return [
        "This Codex task is the persistent harness session for an Anytype chat connected through Knot.",
        `Read the agent and gateway instructions at ${agentWorkspace}/AGENTS.md as well as this project's own AGENTS.md.`,
        `For later Anytype turns, Knot updates untrusted route context at ${workspaceContextFile(agentWorkspace, sessionKey)}. Read it only when the request needs conversation metadata or history.`,
        "Knot will send ordinary later chat messages as their exact user text.",
        "",
        prompt,
    ].join("\n");
}
function storeBindingCleanup(statePath, routeId, sessionKey) {
    const store = new Store(statePath);
    try {
        store.deleteSessionBinding(routeId);
        store.deleteCodexAcpSession(sessionKey);
    }
    finally {
        store.close();
    }
}

import { createConnection } from "node:net";
async function main() {
    // This file is evaluated as a standalone module by Codex Desktop, so it
    // cannot import the shared resolver. Mirror the same conflict contract at
    // this single process boundary without including either JSON value in logs.
    const knotInput = process.env.KNOT_CODEX_APP_TOOLS_INPUT;
    const aagInput = process.env.AAG_CODEX_APP_TOOLS_INPUT;
    if (knotInput !== undefined && aagInput !== undefined && knotInput !== aagInput)
        throw new Error("Conflicting compatibility variables: KNOT_CODEX_APP_TOOLS_INPUT and AAG_CODEX_APP_TOOLS_INPUT must resolve to the same value");
    if (aagInput !== undefined && knotInput === undefined)
        console.error("compatibility warning: AAG_CODEX_APP_TOOLS_INPUT is deprecated; configure KNOT_CODEX_APP_TOOLS_INPUT before Knot 1.0");
    const serializedInput = knotInput ?? aagInput ?? (await readStdin());
    const input = JSON.parse(serializedInput);
    const client = new CodexAppHostClient(input.pipePath, input.timeoutMs);
    try {
        const catalog = (await client.request("tools/list", { threadStartKind: "all" }));
        if (input.action === "hydrate") {
            if (!input.threadId)
                throw new Error("Codex Desktop hydration requires a task ID");
            const navigateTool = catalog.tools?.find((tool) => tool.name === "navigate_to_codex_page");
            if (!navigateTool?.namespace)
                throw new Error("Codex Desktop does not expose navigate_to_codex_page");
            const navigation = { name: navigateTool.name, namespace: navigateTool.namespace };
            await callTool(client, navigation, input.sourceThreadId, {
                threadId: input.threadId,
            });
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            await callTool(client, navigation, input.sourceThreadId, {
                threadId: input.sourceThreadId,
            });
            process.stdout.write(`${JSON.stringify({ hydrated: true })}\n`);
            return;
        }
        if (!input.projectId || !input.title)
            throw new Error("Codex Desktop task creation requires a project and title");
        const createTool = catalog.tools?.find((tool) => tool.name === "create_thread");
        if (!createTool?.namespace)
            throw new Error("Codex Desktop does not expose create_thread");
        const created = await client.request("tools/call", {
            arguments: {
                target: {
                    type: "project",
                    projectId: input.projectId,
                    environment: { type: "local" },
                },
                title: input.title,
                prompt: "This task backs an Anytype conversation. Reply exactly AAG_SESSION_READY.",
            },
            callId: `aag-create-${crypto.randomUUID()}`,
            namespace: createTool.namespace,
            threadId: input.sourceThreadId,
            tool: createTool.name,
            turnId: `aag-bootstrap-${crypto.randomUUID()}`,
        });
        const threadId = extractThreadId(JSON.stringify(created));
        if (!threadId)
            throw new Error("Codex Desktop did not return a task ID");
        const waitTool = catalog.tools?.find((tool) => tool.name === "wait_threads");
        if (waitTool?.namespace)
            await client
                .request("tools/call", {
                arguments: { targets: [{ threadId }], timeoutMs: 60_000 },
                callId: `aag-wait-${crypto.randomUUID()}`,
                namespace: waitTool.namespace,
                threadId: input.sourceThreadId,
                tool: waitTool.name,
                turnId: `aag-bootstrap-${crypto.randomUUID()}`,
            })
                .catch(() => undefined);
        // Read the result so callers can inspect it immediately without waiting for a
        // later recent-task refresh.
        const readTool = catalog.tools?.find((tool) => tool.name === "read_thread");
        if (readTool?.namespace)
            await client
                .request("tools/call", {
                arguments: { threadId, turnLimit: 1 },
                callId: `aag-read-${crypto.randomUUID()}`,
                namespace: readTool.namespace,
                threadId: input.sourceThreadId,
                tool: readTool.name,
                turnId: `aag-bootstrap-${crypto.randomUUID()}`,
            })
                .catch(() => undefined);
        process.stdout.write(`${JSON.stringify({ threadId })}\n`);
    }
    finally {
        client.close();
    }
}
async function callTool(client, tool, sourceThreadId, args) {
    return client.request("tools/call", {
        arguments: args,
        callId: `aag-${tool.name}-${crypto.randomUUID()}`,
        namespace: tool.namespace,
        threadId: sourceThreadId,
        tool: tool.name,
        turnId: `aag-hydrate-${crypto.randomUUID()}`,
    });
}
function extractThreadId(text) {
    return text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0];
}
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}
function writeFrame(socket, message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    socket.write(frame);
}
class CodexAppHostClient {
    buffer = Buffer.alloc(0);
    nextId = 1;
    pending = new Map();
    socket;
    connected;
    timeoutMs;
    constructor(pipePath, timeoutMs) {
        this.timeoutMs = timeoutMs;
        this.socket = createConnection(pipePath);
        this.connected = new Promise((resolveConnected, rejectConnected) => {
            this.socket.once("connect", resolveConnected);
            this.socket.once("error", rejectConnected);
        });
        this.socket.on("data", (chunk) => this.onData(chunk));
        this.socket.on("error", (error) => this.rejectAll(error));
        this.socket.on("close", () => this.rejectAll(new Error("Codex app tools pipe closed")));
    }
    async request(method, params) {
        await this.connected;
        const id = this.nextId++;
        return new Promise((resolveRequest, rejectRequest) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                rejectRequest(new Error(`Codex app tool request timed out: ${method}`));
            }, this.timeoutMs);
            timer.unref?.();
            this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
            writeFrame(this.socket, { id, jsonrpc: "2.0", method, params });
        });
    }
    close() {
        this.socket.destroy();
    }
    onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32LE(0);
            if (this.buffer.length < length + 4)
                return;
            const payload = this.buffer.subarray(4, length + 4).toString("utf8");
            this.buffer = this.buffer.subarray(length + 4);
            const response = JSON.parse(payload);
            if (typeof response.id !== "number")
                continue;
            const pending = this.pending.get(response.id);
            if (!pending)
                continue;
            this.pending.delete(response.id);
            clearTimeout(pending.timer);
            if (response.error)
                pending.reject(new Error(response.error.message ?? "Codex app tool failed"));
            else
                pending.resolve(response.result);
        }
    }
    rejectAll(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
}
main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});

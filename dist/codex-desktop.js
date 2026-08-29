import { spawn } from "node:child_process";
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile, } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
const refreshedThreads = new Set();
const refreshingThreads = new Set();
export async function associateCodexDesktopThread(input) {
    const workspace = resolve(input.workspace);
    const codexHome = resolve(input.codexHome ?? join(homedir(), ".codex"));
    const statePath = join(codexHome, ".codex-global-state.json");
    const lockPath = `${statePath}.aag.lock`;
    await mkdir(dirname(statePath), { recursive: true });
    const release = await acquireLock(lockPath);
    try {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        const entry = Object.entries(state["local-projects"] ?? {}).find(([, project]) => project.rootPaths?.some((path) => resolve(path) === workspace));
        if (!entry)
            return undefined;
        const [projectId, project] = entry;
        state["thread-project-assignments"] ??= {};
        state["thread-project-assignments"][input.threadId] = {
            projectKind: "local",
            projectId,
        };
        state["thread-workspace-root-hints"] ??= {};
        state["thread-workspace-root-hints"][input.threadId] = workspace;
        state["projectless-thread-ids"] = (state["projectless-thread-ids"] ?? []).filter((threadId) => threadId !== input.threadId);
        state["sidebar-project-thread-orders"] ??= {};
        const order = state["sidebar-project-thread-orders"][projectId] ?? { threadIds: [] };
        order.threadIds = [
            input.threadId,
            ...order.threadIds.filter((threadId) => threadId !== input.threadId),
        ];
        state["sidebar-project-thread-orders"][projectId] = order;
        const info = await stat(statePath);
        const temporaryPath = `${statePath}.aag-${process.pid}-${Date.now()}`;
        await copyFile(statePath, `${statePath}.aag-backup`);
        await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { mode: info.mode });
        await rename(temporaryPath, statePath);
        touchCodexThread(codexHome, input.threadId, projectId, input.title);
        if (input.title &&
            !refreshedThreads.has(input.threadId) &&
            !refreshingThreads.has(input.threadId)) {
            refreshingThreads.add(input.threadId);
            void refreshCodexDesktopThread({
                threadId: input.threadId,
                title: input.title,
                codexHome,
            })
                .then((refreshed) => {
                if (refreshed)
                    refreshedThreads.add(input.threadId);
            })
                .finally(() => refreshingThreads.delete(input.threadId));
        }
        return { projectId, projectName: project.name ?? projectId };
    }
    finally {
        await release();
    }
}
export async function refreshCodexDesktopThread(input) {
    const codexHome = resolve(input.codexHome ?? join(homedir(), ".codex"));
    const [appToolsServerPath, pipePaths] = await Promise.all([
        input.appToolsServerPath
            ? Promise.resolve(resolve(input.appToolsServerPath))
            : findCodexAppToolsServer(codexHome),
        input.pipePath ? Promise.resolve([input.pipePath]) : findCodexAppToolsPipes(),
    ]);
    if (!appToolsServerPath || pipePaths.length === 0)
        return false;
    for (const pipePath of pipePaths) {
        if (await callCodexAppTools({
            threadId: input.threadId,
            title: input.title,
            appToolsServerPath,
            pipePath,
            ...(input.nodePath ? { nodePath: input.nodePath } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        }))
            return true;
    }
    return false;
}
async function callCodexAppTools(input) {
    return new Promise((resolveResult) => {
        let settled = false;
        let stdout = "";
        const child = spawn(input.nodePath ?? process.env.CODEX_MCP_NODE_PATH ?? process.execPath, [input.appToolsServerPath], {
            env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: input.pipePath },
            stdio: ["pipe", "pipe", "pipe"],
        });
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            child.kill();
            resolveResult(result);
        };
        const timeout = setTimeout(() => finish(false), input.timeoutMs ?? 2_000);
        timeout.unref?.();
        child.on("error", (error) => {
            debugCodexDesktop(`app-tools process error: ${error.message}`);
            finish(false);
        });
        child.on("exit", (code) => {
            debugCodexDesktop(`app-tools process exited: ${String(code)}`);
            finish(false);
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => debugCodexDesktop(chunk.trim()));
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            const lines = stdout.split("\n");
            stdout = lines.pop() ?? "";
            for (const line of lines) {
                try {
                    const message = JSON.parse(line);
                    debugCodexDesktop(`app-tools response: ${String(message.id)}`);
                    if (message.id === 1 && !message.error) {
                        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
                        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} })}\n`);
                    }
                    if (message.id === 9 && !message.error) {
                        child.stdin.write(`${JSON.stringify({
                            jsonrpc: "2.0",
                            id: 2,
                            method: "tools/call",
                            params: {
                                name: "set_thread_title",
                                arguments: { threadId: input.threadId, title: input.title },
                                _meta: { threadId: input.threadId },
                            },
                        })}\n`);
                    }
                    if (message.id === 2)
                        finish(!message.error && message.result?.isError !== true);
                }
                catch {
                    // Ignore non-protocol output from the optional Desktop integration.
                }
            }
        });
        child.stdin.on("error", () => finish(false));
        child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "anytype-agent-gateway", version: "0.1.0" },
            },
        })}\n`);
    });
}
function debugCodexDesktop(message) {
    if (process.env.AAG_DEBUG_CODEX_DESKTOP === "1")
        process.stderr.write(`[aag codex-desktop] ${message}\n`);
}
async function findCodexAppToolsServer(codexHome) {
    const configured = process.env.AAG_CODEX_APP_TOOLS_SERVER?.trim();
    if (configured)
        return resolve(configured);
    const root = join(codexHome, "plugins", "cache", "openai-bundled", "codex-app-tools");
    try {
        const versions = (await readdir(root, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
        for (const version of versions) {
            const candidate = join(root, version, "server.mjs");
            if (await stat(candidate)
                .then((info) => info.isFile())
                .catch(() => false))
                return candidate;
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
async function findCodexAppToolsPipes() {
    const configured = process.env.CODEX_APP_TOOLS_PIPE_PATH?.trim();
    const root = "/tmp/codex-browser-use";
    try {
        const candidates = await Promise.all((await readdir(root))
            .filter((name) => name.endsWith(".sock"))
            .map(async (name) => {
            const path = join(root, name);
            const info = await stat(path).catch(() => undefined);
            return info?.isSocket() ? { path, modifiedAt: info.mtimeMs } : undefined;
        }));
        const discovered = candidates
            .filter((candidate) => Boolean(candidate))
            .sort((left, right) => right.modifiedAt - left.modifiedAt)
            .slice(0, 4)
            .map((candidate) => candidate.path);
        return [...new Set([...(configured ? [configured] : []), ...discovered])];
    }
    catch {
        return configured ? [configured] : [];
    }
}
function touchCodexThread(codexHome, threadId, projectId, title) {
    const databasePath = join(codexHome, "state_5.sqlite");
    try {
        const database = new DatabaseSync(databasePath);
        try {
            // Saved local projects currently live in .codex-global-state.json and may not have a
            // matching row in Codex's transitional `projects` table. Node's SQLite binding enables
            // foreign-key checks, which otherwise rejects this valid Desktop association.
            database.exec("PRAGMA foreign_keys = OFF");
            const nowMs = Date.now();
            if (title) {
                database
                    .prepare(`UPDATE threads
             SET project_id = ?, title = ?, updated_at = ?, updated_at_ms = ?
             WHERE id = ?`)
                    .run(projectId, title, Math.floor(nowMs / 1000), nowMs, threadId);
            }
            else {
                database
                    .prepare(`UPDATE threads
             SET project_id = ?, updated_at = ?, updated_at_ms = ?
             WHERE id = ?`)
                    .run(projectId, Math.floor(nowMs / 1000), nowMs, threadId);
            }
        }
        finally {
            database.close();
        }
    }
    catch {
        // Codex Desktop metadata is best-effort and must never break an agent turn.
    }
}
async function acquireLock(path) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            const handle = await open(path, "wx", 0o600);
            return async () => {
                await handle.close();
                await unlink(path).catch(() => undefined);
            };
        }
        catch (error) {
            if (!isAlreadyExists(error) || attempt === 19)
                throw error;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    throw new Error(`Could not acquire Codex Desktop state lock: ${path}`);
}
function isAlreadyExists(error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}

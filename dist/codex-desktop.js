import { copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
        touchCodexThread(codexHome, input.threadId, projectId);
        return { projectId, projectName: project.name ?? projectId };
    }
    finally {
        await release();
    }
}
function touchCodexThread(codexHome, threadId, projectId) {
    const databasePath = join(codexHome, "state_5.sqlite");
    try {
        const database = new DatabaseSync(databasePath);
        try {
            const nowMs = Date.now();
            database
                .prepare(`UPDATE threads
           SET project_id = ?, updated_at = ?, updated_at_ms = ?
           WHERE id = ?`)
                .run(projectId, Math.floor(nowMs / 1000), nowMs, threadId);
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

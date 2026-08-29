import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export async function createCodexTask(config, input) {
    if (config.runtime.kind !== "codex" || !config.tools.codex.enabled)
        throw new Error("Codex task creation is disabled for this agent");
    const project = await resolveConfiguredProject(config, input.project);
    const prompt = input.prompt.trim();
    if (!prompt)
        throw new Error("prompt is required");
    const jobDirectory = join(dirname(config.state.path), "codex-tasks", randomUUID());
    await mkdir(jobDirectory, { recursive: true });
    const jobPath = join(jobDirectory, "job.json");
    const statePath = join(jobDirectory, "state.json");
    await writeFile(jobPath, JSON.stringify({
        command: config.tools.codex.command,
        sandbox: config.tools.codex.sandbox,
        project,
        prompt,
        statePath,
        logPath: join(jobDirectory, "events.jsonl"),
        codexHome: config.runtime.environment.CODEX_HOME ?? process.env.CODEX_HOME,
    }), { mode: 0o600 });
    await writeFile(statePath, JSON.stringify({ status: "starting" }), { mode: 0o600 });
    const worker = fileURLToPath(new URL("./codex-task-worker.js", import.meta.url));
    const child = spawn(process.execPath, [worker, jobPath], {
        detached: true,
        stdio: "ignore",
    });
    child.unref();
    const state = await waitForThread(statePath);
    if (!state.threadId)
        throw new Error(state.error ?? "Codex did not return a task ID before startup timed out");
    return { thread_id: state.threadId, project, status: "running" };
}
export async function resolveConfiguredProject(config, requested) {
    const configured = [config.runtime.defaultProject, ...config.runtime.allowedProjects].filter(Boolean);
    const canonical = await Promise.all(configured.map(async (path) => await realpath(resolve(path)).catch(() => resolve(path))));
    const requestedPath = resolve(requested);
    const exact = await realpath(requestedPath).catch(() => requestedPath);
    const exactIndex = canonical.indexOf(exact);
    if (exactIndex >= 0)
        return canonical[exactIndex];
    const named = canonical.filter((path) => path.split("/").at(-1) === requested);
    if (named.length === 1)
        return named[0];
    throw new Error(`Project must be one of the configured Codex projects: ${canonical.join(", ")}`);
}
async function waitForThread(statePath) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        if (state.threadId || state.status === "failed")
            return state;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { status: "failed", error: "Codex task startup timed out" };
}

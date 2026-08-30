import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "./config.js";

type CodexTaskState = {
  status: "starting" | "running" | "completed" | "failed";
  threadId?: string;
  error?: string;
};

export async function createCodexTask(
  config: AgentConfig,
  input: { project: string; prompt: string },
): Promise<{ thread_id: string; project: string; status: "running" }> {
  if (config.runtime.kind !== "codex" || !config.tools.codex.enabled)
    throw new Error("Codex task creation is disabled for this agent");
  const project = await resolveConfiguredProject(config, input.project);
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("prompt is required");

  const jobDirectory = join(dirname(config.state.path), "codex-tasks", randomUUID());
  await mkdir(jobDirectory, { recursive: true });
  const jobPath = join(jobDirectory, "job.json");
  const statePath = join(jobDirectory, "state.json");
  await writeFile(
    jobPath,
    JSON.stringify({
      command: config.tools.codex.command,
      sandbox: config.tools.codex.sandbox,
      project,
      prompt,
      statePath,
      logPath: join(jobDirectory, "events.jsonl"),
      codexHome: config.runtime.environment.CODEX_HOME ?? process.env.CODEX_HOME,
    }),
    { mode: 0o600 },
  );
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

export async function resolveConfiguredProject(
  config: AgentConfig,
  requested: string,
): Promise<string> {
  const projects = await configuredCodexProjects(config);
  const requestedValue = requested.trim();
  const requestedPath = resolve(requestedValue);
  const exact = await realpath(requestedPath).catch(() => requestedPath);
  const exactProject = projects.find((project) => project.path === exact);
  if (exactProject) return exactProject.path;
  const named = projects.filter((project) => project.name === requestedValue);
  if (named.length === 1) return named[0]!.path;
  const folded = projects.filter(
    (project) => project.name.toLocaleLowerCase() === requestedValue.toLocaleLowerCase(),
  );
  if (folded.length === 1) return folded[0]!.path;
  throw new Error(
    `Project must match one configured Codex project: ${projects.map((project) => project.name).join(", ")}`,
  );
}

export async function configuredCodexProjects(
  config: AgentConfig,
): Promise<Array<{ name: string; path: string }>> {
  const configured = [config.runtime.defaultProject, ...config.runtime.allowedProjects].filter(
    Boolean,
  ) as string[];
  const canonical = await Promise.all(
    configured.map(async (path) => await realpath(resolve(path)).catch(() => resolve(path))),
  );
  return [...new Set(canonical)].map((path) => ({ name: path.split("/").at(-1) ?? path, path }));
}

async function waitForThread(statePath: string): Promise<CodexTaskState> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = JSON.parse(await readFile(statePath, "utf8")) as CodexTaskState;
    if (state.threadId || state.status === "failed") return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { status: "failed", error: "Codex task startup timed out" };
}

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { associateCodexDesktopThread } from "./codex-desktop.js";

type Job = {
  command: string;
  sandbox: "read-only" | "workspace-write";
  project: string;
  prompt: string;
  statePath: string;
  logPath: string;
  codexHome?: string;
};

const jobPath = process.argv[2];
if (!jobPath) throw new Error("Codex task worker requires a job file");
const job = JSON.parse(await readFile(jobPath, "utf8")) as Job;
const log = createWriteStream(job.logPath, { flags: "a", mode: 0o600 });
const child = spawn(
  job.command,
  [
    "exec",
    "--json",
    "--cd",
    job.project,
    "--skip-git-repo-check",
    ...(job.sandbox === "workspace-write" ? ["--approve-for-me"] : ["--sandbox", "read-only"]),
    job.prompt,
  ],
  { cwd: job.project, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
child.stderr.pipe(log, { end: false });
let threadId: string | undefined;
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
for await (const line of lines) {
  log.write(`${line}\n`);
  if (threadId) continue;
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const candidate = event.thread_id ?? event.threadId;
    if (typeof candidate !== "string") continue;
    threadId = candidate;
    await writeState(job.statePath, { status: "running", threadId });
    await associateCodexDesktopThread({
      threadId,
      workspace: job.project,
      ...(job.codexHome ? { codexHome: job.codexHome } : {}),
    }).catch(() => undefined);
  } catch {
    // Non-JSON diagnostics stay in the per-task event log.
  }
}
const exitCode = await exited;
if (threadId)
  await associateCodexDesktopThread({
    threadId,
    workspace: job.project,
    ...(job.codexHome ? { codexHome: job.codexHome } : {}),
  }).catch(() => undefined);
await writeState(
  job.statePath,
  exitCode === 0
    ? { status: "completed", ...(threadId ? { threadId } : {}) }
    : {
        status: "failed",
        ...(threadId ? { threadId } : {}),
        error: `Codex task exited with status ${exitCode ?? "unknown"}`,
      },
);
log.end();

async function writeState(path: string, state: Record<string, unknown>): Promise<void> {
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
}

import { spawn } from "node:child_process";
import { copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

type LocalProject = {
  id?: string;
  name?: string;
  rootPaths?: string[];
};

type CodexDesktopState = {
  "local-projects"?: Record<string, LocalProject>;
  "thread-project-assignments"?: Record<string, { projectKind: "local"; projectId: string }>;
  "thread-workspace-root-hints"?: Record<string, string>;
  "sidebar-project-thread-orders"?: Record<string, { threadIds: string[] }>;
  "projectless-thread-ids"?: string[];
  [key: string]: unknown;
};

export type CodexDesktopAssociation = {
  projectId: string;
  projectName: string;
};

export async function createCodexDesktopThread(input: {
  sourceThreadId?: string;
  workspace: string;
  title: string;
  codexHome?: string;
  pipePath?: string;
  timeoutMs?: number;
  codexNodePath?: string;
  helperPath?: string;
  nodeArguments?: string[];
}): Promise<string | undefined> {
  const project = await prepareCodexDesktopProject(input);
  if (!project) return undefined;
  const codexHome = resolve(input.codexHome ?? join(homedir(), ".codex"));
  const sourceThreadId = input.sourceThreadId ?? findCodexDesktopControllerThread(codexHome);
  if (!sourceThreadId) return undefined;
  const pipePaths = input.pipePath ? [input.pipePath] : await findCodexAppToolsPipes();
  for (const pipePath of pipePaths) {
    try {
      const threadId = await runCodexAppToolsHelper({
        pipePath,
        projectId: project.projectId,
        sourceThreadId,
        title: input.title,
        timeoutMs: input.timeoutMs ?? 90_000,
        ...(input.codexNodePath ? { codexNodePath: input.codexNodePath } : {}),
        ...(input.helperPath ? { helperPath: input.helperPath } : {}),
        ...(input.nodeArguments ? { nodeArguments: input.nodeArguments } : {}),
      });
      if (threadId) return threadId;
    } catch (error) {
      if (process.env.AAG_DEBUG_CODEX_DESKTOP === "1")
        process.stderr.write(
          `[aag codex-desktop] app-tools pipe ${pipePath} failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
    }
  }
  return undefined;
}

export async function hydrateCodexDesktopTask(input: {
  threadId: string;
  codexHome?: string;
  pipePath?: string;
  timeoutMs?: number;
  codexNodePath?: string;
  helperPath?: string;
  nodeArguments?: string[];
}): Promise<void> {
  const debug = (message: string) => {
    if (process.env.AAG_DEBUG_CODEX_DESKTOP === "1")
      process.stderr.write(`[aag codex-desktop] ${message}\n`);
  };
  // Codex Desktop runs on macOS in production. An explicit pipe is also a
  // supported dependency-injection seam for protocol tests on other hosts.
  if (process.platform !== "darwin" && !input.pipePath) return;
  const codexHome = resolve(input.codexHome ?? join(homedir(), ".codex"));
  const sourceThreadId = findCodexDesktopControllerThread(codexHome);
  if (!sourceThreadId) {
    debug("cannot hydrate task: no desktop controller task");
    return;
  }
  const pipePaths = input.pipePath ? [input.pipePath] : await findCodexAppToolsPipes();
  for (const pipePath of pipePaths) {
    try {
      const hydrated = await runCodexAppToolsHelper({
        action: "hydrate",
        pipePath,
        sourceThreadId,
        threadId: input.threadId,
        timeoutMs: input.timeoutMs ?? 15_000,
        ...(input.codexNodePath ? { codexNodePath: input.codexNodePath } : {}),
        ...(input.helperPath ? { helperPath: input.helperPath } : {}),
        ...(input.nodeArguments ? { nodeArguments: input.nodeArguments } : {}),
      });
      if (hydrated) {
        debug(`hydrated task ${input.threadId} through Codex app tools`);
        return;
      }
    } catch (error) {
      debug(
        `task hydration through ${pipePath} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (process.platform !== "darwin") return;
  const open = async (id: string) => {
    const url = `codex://threads/${id}`;
    const openedThroughApp = await spawnAndWait("/usr/bin/osascript", [
      "-e",
      `tell application "Codex" to open location "${url}"`,
    ]);
    if (!openedThroughApp) await spawnAndWait("/usr/bin/open", ["-g", url]);
  };
  const navigate = async (id: string) => {
    if (await navigateCodexDesktopThread({ codexHome, threadId: id })) return;
    await open(id);
  };
  await navigate(input.threadId);
  debug(`opened task ${input.threadId} for sidebar hydration`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
  await navigate(sourceThreadId);
  debug(`restored controller task ${sourceThreadId}`);
}

function spawnAndWait(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", () => resolveResult(false));
    child.once("close", (code) => resolveResult(code === 0));
  });
}

async function navigateCodexDesktopThread(input: {
  codexHome: string;
  threadId: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const socketPath = join(input.codexHome, "ipc", "ipc.sock");
  return new Promise<boolean>((resolveResult) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const socket = createConnection(socketPath);
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveResult(result);
    };
    const timeout = setTimeout(() => finish(false), input.timeoutMs ?? 2_000);
    timeout.unref?.();
    socket.on("connect", () => {
      writeIpcFrame(socket, {
        type: "request",
        requestId: "initialize",
        method: "initialize",
        sourceClientId: "initializing-client",
        params: { clientType: "anytype-agent-gateway" },
        version: 0,
      });
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const payload = buffer.subarray(4, length + 4).toString("utf8");
        buffer = buffer.subarray(length + 4);
        try {
          const message = JSON.parse(payload) as {
            type?: string;
            requestId?: string;
            resultType?: string;
            result?: { clientId?: string };
          };
          if (
            message.type === "response" &&
            message.requestId === "initialize" &&
            message.resultType === "success" &&
            message.result?.clientId
          ) {
            writeIpcFrame(socket, {
              type: "broadcast",
              method: "navigate-to-route",
              sourceClientId: message.result.clientId,
              params: { path: `/local/${input.threadId}` },
              version: 0,
            });
            setTimeout(() => finish(true), 100).unref?.();
          }
        } catch {
          finish(false);
        }
      }
    });
    socket.on("error", () => finish(false));
  });
}

async function runCodexAppToolsHelper(input: {
  action?: "create" | "hydrate";
  pipePath: string;
  projectId?: string;
  sourceThreadId: string;
  threadId?: string;
  title?: string;
  timeoutMs: number;
  codexNodePath?: string;
  helperPath?: string;
  nodeArguments?: string[];
}): Promise<string | undefined> {
  const codexNodePath = input.codexNodePath ?? findCodexBundledNode();
  if (!codexNodePath) return undefined;
  const helperPath =
    input.helperPath ?? fileURLToPath(new URL("./codex-app-tools-helper.js", import.meta.url));
  const helperSource = await readFile(helperPath, "utf8");
  const helperInput = JSON.stringify({
    action: input.action ?? "create",
    pipePath: input.pipePath,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    sourceThreadId: input.sourceThreadId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    timeoutMs: input.timeoutMs,
    ...(input.title ? { title: input.title } : {}),
  });
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(
      codexNodePath,
      [...(input.nodeArguments ?? []), "--input-type=module", "-e", helperSource],
      {
        env: { ...process.env, AAG_CODEX_APP_TOOLS_INPUT: helperInput },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectResult(error);
      else {
        const parsed = JSON.parse(stdout.trim()) as { threadId?: string; hydrated?: boolean };
        resolveResult(
          input.action === "hydrate" ? (parsed.hydrated ? "hydrated" : undefined) : parsed.threadId,
        );
      }
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Codex Desktop task creation timed out"));
    }, input.timeoutMs + 5_000);
    timeout.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", finish);
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `Codex Desktop helper exited with code ${code}`));
    });
  });
}

function findCodexBundledNode(): string | undefined {
  const configured = process.env.CODEX_MCP_NODE_PATH?.trim();
  if (configured) return configured;
  if (process.platform !== "darwin") return undefined;
  return "/Applications/Codex.app/Contents/Resources/cua_node/bin/node";
}

function findCodexDesktopControllerThread(codexHome: string): string | undefined {
  try {
    const database = new DatabaseSync(join(codexHome, "state_5.sqlite"), { readOnly: true });
    try {
      const row = database
        .prepare(
          `SELECT id
           FROM threads
           WHERE archived = 0
             AND source = 'vscode'
             AND thread_source IS NOT NULL
             AND thread_source <> ''
           ORDER BY recency_at_ms DESC, updated_at_ms DESC
           LIMIT 1`,
        )
        .get() as { id?: string } | undefined;
      return row?.id;
    } finally {
      database.close();
    }
  } catch {
    return undefined;
  }
}

export async function prepareCodexDesktopProject(input: {
  workspace: string;
  codexHome?: string;
}): Promise<CodexDesktopAssociation | undefined> {
  const workspace = resolve(input.workspace);
  const codexHome = resolve(input.codexHome ?? join(homedir(), ".codex"));
  const state = JSON.parse(
    await readFile(join(codexHome, ".codex-global-state.json"), "utf8"),
  ) as CodexDesktopState;
  const entry = findSavedProject(state, workspace);
  if (!entry) return undefined;
  const [projectId, project] = entry;
  registerCodexProject(codexHome, projectId, project.name ?? projectId, workspace);
  return { projectId, projectName: project.name ?? projectId };
}

export async function associateCodexDesktopThread(input: {
  threadId: string;
  workspace: string;
  codexHome?: string;
  title?: string;
}): Promise<CodexDesktopAssociation | undefined> {
  const workspace = resolve(input.workspace);
  const codexHome = resolve(input.codexHome ?? join(homedir(), ".codex"));
  const statePath = join(codexHome, ".codex-global-state.json");
  const lockPath = `${statePath}.aag.lock`;
  await mkdir(dirname(statePath), { recursive: true });
  const release = await acquireLock(lockPath);
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as CodexDesktopState;
    const entry = findSavedProject(state, workspace);
    if (!entry) return undefined;
    const [projectId, project] = entry;
    state["thread-project-assignments"] ??= {};
    state["thread-project-assignments"][input.threadId] = {
      projectKind: "local",
      projectId,
    };
    state["thread-workspace-root-hints"] ??= {};
    state["thread-workspace-root-hints"][input.threadId] = workspace;
    state["projectless-thread-ids"] = (state["projectless-thread-ids"] ?? []).filter(
      (threadId) => threadId !== input.threadId,
    );
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
    touchCodexThread(
      codexHome,
      input.threadId,
      projectId,
      project.name ?? projectId,
      workspace,
      input.title,
    );
    await refreshCodexDesktopThread({ codexHome });
    return { projectId, projectName: project.name ?? projectId };
  } finally {
    await release();
  }
}

function findSavedProject(
  state: CodexDesktopState,
  workspace: string,
): [string, LocalProject] | undefined {
  return Object.entries(state["local-projects"] ?? {}).find(([, project]) =>
    project.rootPaths?.some((path) => resolve(path) === workspace),
  );
}

export async function refreshCodexDesktopThread(input: {
  codexHome?: string;
  socketPath?: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const codexHome = resolve(input.codexHome ?? join(homedir(), ".codex"));
  const socketPath = resolve(input.socketPath ?? join(codexHome, "ipc", "ipc.sock"));
  return new Promise<boolean>((resolveResult) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const socket = createConnection(socketPath);
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveResult(result);
    };
    const timeout = setTimeout(() => finish(false), input.timeoutMs ?? 1_000);
    timeout.unref?.();
    socket.on("connect", () => {
      writeIpcFrame(socket, {
        type: "request",
        requestId: "initialize",
        method: "initialize",
        sourceClientId: "initializing-client",
        params: { clientType: "anytype-agent-gateway" },
        version: 0,
      });
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const payload = buffer.subarray(4, length + 4).toString("utf8");
        buffer = buffer.subarray(length + 4);
        try {
          const message = JSON.parse(payload) as {
            type?: string;
            requestId?: string;
            resultType?: string;
            result?: { clientId?: string };
          };
          if (
            message.type === "response" &&
            message.requestId === "initialize" &&
            message.resultType === "success" &&
            message.result?.clientId
          ) {
            writeIpcFrame(socket, {
              type: "broadcast",
              method: "query-cache-invalidate",
              sourceClientId: message.result.clientId,
              params: { queryKey: ["tasks"] },
              version: 0,
            });
            finish(true);
          }
        } catch {
          finish(false);
        }
      }
    });
    socket.on("error", () => finish(false));
  });
}

function writeIpcFrame(socket: NodeJS.WritableStream, message: unknown): void {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, "utf8");
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  socket.write(frame);
}

async function findCodexAppToolsPipes(): Promise<string[]> {
  const configured = process.env.CODEX_APP_TOOLS_PIPE_PATH?.trim();
  const { readdir } = await import("node:fs/promises");
  try {
    const sockets = await Promise.all(
      (await readdir("/tmp/codex-browser-use"))
        .filter((name) => name.endsWith(".sock"))
        .map(async (name) => {
          const path = join("/tmp/codex-browser-use", name);
          const info = await stat(path).catch(() => undefined);
          return info?.isSocket() ? { path, modifiedAt: info.mtimeMs } : undefined;
        }),
    );
    const discovered = sockets
      .filter((socket): socket is { path: string; modifiedAt: number } => Boolean(socket))
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .map((socket) => socket.path);
    return [...new Set([...discovered, ...(configured ? [configured] : [])])].slice(0, 3);
  } catch {
    return configured ? [configured] : [];
  }
}

function touchCodexThread(
  codexHome: string,
  threadId: string,
  projectId: string,
  projectName: string,
  workspace: string,
  title?: string,
): void {
  const databasePath = join(codexHome, "state_5.sqlite");
  try {
    registerCodexProject(codexHome, projectId, projectName, workspace);
    const database = new DatabaseSync(databasePath);
    try {
      const nowMs = Date.now();
      database.exec("PRAGMA foreign_keys = ON");
      if (title) {
        database
          .prepare(
            `UPDATE threads
             SET project_id = ?, title = ?, updated_at = ?, updated_at_ms = ?
             WHERE id = ?`,
          )
          .run(projectId, title, Math.floor(nowMs / 1000), nowMs, threadId);
      } else {
        database
          .prepare(
            `UPDATE threads
             SET project_id = ?, updated_at = ?, updated_at_ms = ?
             WHERE id = ?`,
          )
          .run(projectId, Math.floor(nowMs / 1000), nowMs, threadId);
      }
    } finally {
      database.close();
    }
  } catch {
    // Codex Desktop metadata is best-effort and must never break an agent turn.
  }
}

function registerCodexProject(
  codexHome: string,
  projectId: string,
  projectName: string,
  workspace: string,
): void {
  const database = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    try {
      const nowMs = Date.now();
      database
        .prepare(
          `INSERT INTO projects (id, name, metadata, position, created_at_ms, updated_at_ms)
           VALUES (?, ?, '{}', COALESCE((SELECT MAX(position) + 1 FROM projects), 0), ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at_ms = excluded.updated_at_ms`,
        )
        .run(projectId, projectName, nowMs, nowMs);
      database
        .prepare(
          `INSERT INTO project_roots (project_id, position, path)
           VALUES (?, 0, ?)
           ON CONFLICT(project_id, position) DO UPDATE SET path = excluded.path`,
        )
        .run(projectId, workspace);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      return async () => {
        await handle.close();
        await unlink(path).catch(() => undefined);
      };
    } catch (error) {
      if (!isAlreadyExists(error) || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Could not acquire Codex Desktop state lock: ${path}`);
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

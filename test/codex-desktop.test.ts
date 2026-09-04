import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  associateCodexDesktopThread,
  createCodexDesktopThread,
  hydrateCodexDesktopTask,
  refreshCodexDesktopThread,
} from "../src/codex-desktop.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Codex Desktop project association", () => {
  it.each(["", "not-json"])(
    "handles malformed helper output %j without escaping the fallback",
    async (output) => {
      const fixture = await helperFixture(`process.stdout.write(${JSON.stringify(output)});`);
      await expect(createCodexDesktopThread(fixture)).resolves.toBeUndefined();
    },
  );

  it("kills an unresponsive helper after its timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "aag-codex-timeout-pid-"));
    temporaryDirectories.push(root);
    const pidPath = join(root, "helper.pid");
    const fixture = await helperFixture(
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 100);`,
    );
    await expect(createCodexDesktopThread({ ...fixture, timeoutMs: 20 })).resolves.toBeUndefined();
    const pid = Number(await readFile(pidPath, "utf8"));
    // Process-group termination may take a scheduling turn to become observable.
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      })
      .toBe(true);
  }, 10_000);

  it("creates a native project task through the authenticated Codex app tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "aag-codex-native-thread-"));
    temporaryDirectories.push(root);
    const codexHome = join(root, ".codex");
    const workspace = join(root, "workspace");
    const pipePath = join(root, "app-tools.sock");
    await mkdir(codexHome);
    await mkdir(workspace);
    await writeFile(
      join(codexHome, ".codex-global-state.json"),
      JSON.stringify({
        "local-projects": {
          "project-klee": { name: "klee", rootPaths: [workspace] },
        },
      }),
    );
    createCodexDatabase(codexHome);
    const calls: Array<{ method: string; params: any }> = [];
    const server = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (buffer.length < length + 4) return;
          const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
          buffer = buffer.subarray(length + 4);
          calls.push(message);
          writeFrame(socket, {
            id: message.id,
            jsonrpc: "2.0",
            result:
              message.method === "tools/list"
                ? {
                    tools: [
                      { name: "create_thread", namespace: "codex_app" },
                      { name: "wait_threads", namespace: "codex_app" },
                      { name: "read_thread", namespace: "codex_app" },
                    ],
                  }
                : message.params.tool === "create_thread"
                  ? {
                      success: true,
                      contentItems: [
                        {
                          type: "inputText",
                          text: '{"threadId":"01a04e2f-d594-7e62-8c6b-26a67985b9df"}',
                        },
                      ],
                    }
                  : { success: true, contentItems: [{ type: "inputText", text: "ok" }] },
          });
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipePath, resolve);
    });

    try {
      await expect(
        createCodexDesktopThread({
          sourceThreadId: "bootstrap-thread",
          workspace,
          title: "Klee — Anytype chat",
          codexHome,
          pipePath,
          timeoutMs: 2_000,
          codexNodePath: process.execPath,
          helperPath: join(process.cwd(), "dist", "codex-app-tools-helper.js"),
        }),
      ).resolves.toBe("01a04e2f-d594-7e62-8c6b-26a67985b9df");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(calls.map((call) => call.method)).toEqual([
      "tools/list",
      "tools/call",
      "tools/call",
      "tools/call",
    ]);
    expect(calls[1]?.params).toMatchObject({
      threadId: "bootstrap-thread",
      tool: "create_thread",
      arguments: {
        target: {
          type: "project",
          projectId: "project-klee",
          environment: { type: "local" },
        },
      },
    });
    expect(calls[3]?.params).toMatchObject({
      tool: "read_thread",
      arguments: {
        threadId: "01a04e2f-d594-7e62-8c6b-26a67985b9df",
        turnLimit: 1,
      },
    });
  });

  it("notifies a running Codex app so its project sidebar refreshes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aag-codex-desktop-ipc-"));
    temporaryDirectories.push(root);
    const socketPath = join(root, "ipc.sock");
    let captured: unknown;
    const server = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (buffer.length < length + 4) return;
          const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
          buffer = buffer.subarray(length + 4);
          if (message.method === "initialize") {
            writeFrame(socket, {
              type: "response",
              requestId: message.requestId,
              resultType: "success",
              method: "initialize",
              handledByClientId: "desktop-client",
              result: { clientId: "aag-client" },
            });
          } else if (message.method === "query-cache-invalidate") {
            captured = message;
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      await expect(refreshCodexDesktopThread({ socketPath, timeoutMs: 2_000 })).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(captured).toMatchObject({
      type: "broadcast",
      method: "query-cache-invalidate",
      sourceClientId: "aag-client",
      params: { queryKey: ["tasks"] },
      version: 0,
    });
  });

  it("hydrates a task through the Codex app and restores the controller task", async () => {
    const root = await mkdtemp(join(tmpdir(), "aag-codex-hydrate-"));
    temporaryDirectories.push(root);
    const codexHome = join(root, ".codex");
    const pipePath = join(root, "app-tools.sock");
    await mkdir(codexHome);
    const database = createCodexDatabase(codexHome);
    database
      .prepare(
        `INSERT INTO threads
         (id, project_id, title, updated_at, updated_at_ms, source, thread_source, recency_at_ms)
         VALUES (?, ?, ?, ?, ?, 'vscode', 'desktop', ?)`,
      )
      .run("controller-thread", null, "Controller", 1, 1, 1);
    database.close();
    const calls: Array<{ method: string; params: any }> = [];
    const server = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (buffer.length < length + 4) return;
          const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
          buffer = buffer.subarray(length + 4);
          calls.push(message);
          writeFrame(socket, {
            id: message.id,
            jsonrpc: "2.0",
            result:
              message.method === "tools/list"
                ? { tools: [{ name: "navigate_to_codex_page", namespace: "codex_app" }] }
                : { success: true },
          });
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipePath, resolve);
    });

    try {
      await hydrateCodexDesktopTask({
        threadId: "new-thread",
        codexHome,
        pipePath,
        timeoutMs: 2_000,
        codexNodePath: process.execPath,
        helperPath: join(process.cwd(), "dist", "codex-app-tools-helper.js"),
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(
      calls.filter((call) => call.method === "tools/call").map((call) => call.params.arguments),
    ).toEqual([{ threadId: "new-thread" }, { threadId: "controller-thread" }]);
  });

  it("associates an ACP thread with the saved project matching its workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "aag-codex-desktop-"));
    temporaryDirectories.push(root);
    const codexHome = join(root, ".codex");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await mkdir(codexHome);
    await writeFile(
      join(codexHome, ".codex-global-state.json"),
      JSON.stringify({
        "local-projects": {
          "project-klee": {
            id: "project-klee",
            name: "klee",
            rootPaths: [workspace],
          },
        },
        "thread-project-assignments": {},
        "thread-workspace-root-hints": {},
        "sidebar-project-thread-orders": {
          "project-klee": { threadIds: ["older-thread"] },
        },
        "projectless-thread-ids": ["new-thread", "other-thread"],
      }),
    );
    const database = createCodexDatabase(codexHome);
    database
      .prepare(
        "INSERT INTO threads (id, project_id, title, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
      )
      .run("new-thread", null, "Generated prompt title", 1, 1);
    database.close();

    await expect(
      associateCodexDesktopThread({
        threadId: "new-thread",
        workspace,
        codexHome,
        title: "Klee — Anytype chat",
      }),
    ).resolves.toEqual({ projectId: "project-klee", projectName: "klee" });

    const state = JSON.parse(await readFile(join(codexHome, ".codex-global-state.json"), "utf8"));
    expect(state["thread-project-assignments"]["new-thread"]).toEqual({
      projectKind: "local",
      projectId: "project-klee",
    });
    expect(state["thread-workspace-root-hints"]["new-thread"]).toBe(workspace);
    expect(state["sidebar-project-thread-orders"]["project-klee"].threadIds).toEqual([
      "new-thread",
      "older-thread",
    ]);
    expect(state["projectless-thread-ids"]).toEqual(["other-thread"]);
    const updatedDatabase = new DatabaseSync(join(codexHome, "state_5.sqlite"), {
      readOnly: true,
    });
    const thread = updatedDatabase
      .prepare("SELECT project_id, title, updated_at, updated_at_ms FROM threads WHERE id = ?")
      .get("new-thread") as {
      project_id: string;
      title: string;
      updated_at: number;
      updated_at_ms: number;
    };
    expect(thread.project_id).toBe("project-klee");
    expect(thread.title).toBe("Klee — Anytype chat");
    expect(thread.updated_at).toBeGreaterThan(1);
    expect(thread.updated_at_ms).toBeGreaterThan(1);
    const project = updatedDatabase
      .prepare(
        `SELECT projects.name, project_roots.path
         FROM projects JOIN project_roots ON project_roots.project_id = projects.id
         WHERE projects.id = ?`,
      )
      .get("project-klee") as { name: string; path: string };
    expect(project).toEqual({ name: "klee", path: workspace });
    updatedDatabase.close();
  });

  it("leaves state unchanged when no saved project matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "aag-codex-desktop-"));
    temporaryDirectories.push(root);
    const codexHome = join(root, ".codex");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await mkdir(codexHome);
    await writeFile(
      join(codexHome, ".codex-global-state.json"),
      JSON.stringify({ "local-projects": {} }),
    );

    await expect(
      associateCodexDesktopThread({ threadId: "new-thread", workspace, codexHome }),
    ).resolves.toBeUndefined();
  });
});

function createCodexDatabase(codexHome: string): DatabaseSync {
  const database = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  database.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`);
  database.exec(`CREATE TABLE project_roots (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (project_id, position)
    )`);
  database.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      thread_source TEXT,
      recency_at_ms INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(project_id) REFERENCES projects(id)
    )`);
  return database;
}

function writeFrame(socket: NodeJS.WritableStream, message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  socket.write(frame);
}

async function helperFixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "aag-codex-helper-fallback-"));
  temporaryDirectories.push(root);
  const codexHome = join(root, ".codex");
  const workspace = join(root, "workspace");
  await mkdir(codexHome);
  await mkdir(workspace);
  await writeFile(
    join(codexHome, ".codex-global-state.json"),
    JSON.stringify({
      "local-projects": { "project-fixture": { name: "fixture", rootPaths: [workspace] } },
    }),
  );
  createCodexDatabase(codexHome).close();
  const helperPath = join(root, "helper.js");
  await writeFile(helperPath, source);
  return {
    sourceThreadId: "fixture-controller",
    title: "Fixture",
    codexHome,
    workspace,
    pipePath: join(root, "unused.sock"),
    codexNodePath: process.execPath,
    helperPath,
  };
}

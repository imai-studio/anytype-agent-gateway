import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { associateCodexDesktopThread, refreshCodexDesktopThread } from "../src/codex-desktop.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Codex Desktop project association", () => {
  it("notifies a running Codex app so its project sidebar refreshes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aag-codex-desktop-mcp-"));
    temporaryDirectories.push(root);
    const serverPath = join(root, "server.mjs");
    const capturePath = join(root, "request.json");
    await writeFile(
      serverPath,
      `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const capturePath = ${JSON.stringify(capturePath)};
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\\n");
  }
  if (message.id === 9) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 9, result: { tools: [] } }) + "\\n");
  }
  if (message.id === 2) {
    appendFileSync(capturePath, line);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [], isError: false } }) + "\\n");
  }
});
`,
    );

    await expect(
      refreshCodexDesktopThread({
        threadId: "new-thread",
        title: "Klee — Anytype chat",
        appToolsServerPath: serverPath,
        pipePath: "/tmp/test-codex-app.sock",
        nodePath: process.execPath,
        timeoutMs: 2_000,
      }),
    ).resolves.toBe(true);

    const request = JSON.parse(await readFile(capturePath, "utf8"));
    expect(request.params).toMatchObject({
      name: "set_thread_title",
      arguments: { threadId: "new-thread", title: "Klee — Anytype chat" },
      _meta: { threadId: "new-thread" },
    });
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
    const database = new DatabaseSync(join(codexHome, "state_5.sqlite"));
    database.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY
    )`);
    database.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id)
    )`);
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
    updatedDatabase.close();
    expect(thread.project_id).toBe("project-klee");
    expect(thread.title).toBe("Klee — Anytype chat");
    expect(thread.updated_at).toBeGreaterThan(1);
    expect(thread.updated_at_ms).toBeGreaterThan(1);
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

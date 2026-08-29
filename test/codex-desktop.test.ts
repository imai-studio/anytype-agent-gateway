import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { associateCodexDesktopThread } from "../src/codex-desktop.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Codex Desktop project association", () => {
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
    database.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      updated_at INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`);
    database
      .prepare(
        "INSERT INTO threads (id, project_id, updated_at, updated_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run("new-thread", null, 1, 1);
    database.close();

    await expect(
      associateCodexDesktopThread({ threadId: "new-thread", workspace, codexHome }),
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
      .prepare("SELECT project_id, updated_at, updated_at_ms FROM threads WHERE id = ?")
      .get("new-thread") as {
      project_id: string;
      updated_at: number;
      updated_at_ms: number;
    };
    updatedDatabase.close();
    expect(thread.project_id).toBe("project-klee");
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

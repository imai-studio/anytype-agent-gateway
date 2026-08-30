import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateInstallation } from "../src/migration.js";
import { loadConfig } from "../src/config.js";

const roots: string[] = [];
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "v0.1.3");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installation migration", () => {
  it("dry-runs and then preserves replay-sensitive v0.1.3 state", async () => {
    const home = await legacyHome();
    const plan = await migrateInstallation({ home, dryRun: true });
    expect(plan.state).toBe("planned");
    expect(plan.items.filter((item) => item.status === "copy")).toHaveLength(2);
    const result = await migrateInstallation({ home });
    expect(result.state).toBe("complete");
    expect(result.manifest).toBeTruthy();
    const legacy = snapshot(join(home, ".local/state/aag/state.sqlite"));
    const current = snapshot(join(home, ".local/state/knot/state.sqlite"));
    expect(current).toEqual(legacy);
    expect(await readFile(join(home, ".config/knot/agent.yaml"), "utf8")).toContain(
      ".local/state/knot/state.sqlite",
    );
  });

  it("is resumable and idempotent but refuses a divergent destination", async () => {
    const home = await legacyHome();
    await expect(migrateInstallation({ home, interruptAfterCopies: 1 })).rejects.toThrow(
      "simulated migration interruption",
    );
    await expect(migrateInstallation({ home })).resolves.toMatchObject({ state: "complete" });
    await expect(migrateInstallation({ home })).resolves.toMatchObject({ state: "complete" });
    await writeFile(join(home, ".config/knot/agent.yaml"), "divergent\n");
    await expect(migrateInstallation({ home })).rejects.toThrow("Divergent migration destination");
  });

  it("refuses WAL sidecars and removes partial temporary copies", async () => {
    const home = await legacyHome();
    await writeFile(join(home, ".local/state/aag/state.sqlite-wal"), "active");
    await expect(migrateInstallation({ home })).rejects.toThrow("sidecar exists");
    const stateParent = join(home, ".local/state");
    await expect(
      (await import("node:fs/promises")).readdir(stateParent),
    ).resolves.not.toContainEqual(expect.stringContaining(".migrating."));
  });

  it("materializes the Knot state path when legacy config used its default", async () => {
    const home = await legacyHome();
    await writeFile(
      join(home, ".config/aag/agent.yaml"),
      "version: 1\nagent:\n  name: Fixture\n  participantId: _participant_fixture_agent_01\nanytype:\n  apiKeyFile: /fixture/key\nspaces:\n  - id: _space_fixture_01\nruntime:\n  kind: codex\n",
    );
    await migrateInstallation({ home });
    const config = await loadConfig(join(home, ".config/knot/agent.yaml"));
    expect(config.state.path).toBe(join(home, ".local/state/knot/state.sqlite"));
  });
});

async function legacyHome(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "knot-migration-")));
  roots.push(home);
  await mkdir(join(home, ".config/aag"), { recursive: true });
  await mkdir(join(home, ".local/state/aag"), { recursive: true });
  const statePath = join(home, ".local/state/aag/state.sqlite");
  const config = `version: 1\nagent:\n  name: Fixture\n  participantId: _participant_fixture_agent_01\nanytype:\n  apiKeyFile: /fixture/key\nspaces:
  - id: _space_fixture_01\nruntime:\n  kind: codex\nstate:\n  path: ${statePath}\n`;
  await writeFile(join(home, ".config/aag/agent.yaml"), config, { mode: 0o600 });
  const database = new DatabaseSync(statePath);
  database.exec(await readFile(join(fixture, "state.sql"), "utf8"));
  database.exec("PRAGMA journal_mode=WAL");
  database.close();
  return home;
}

function snapshot(path: string): unknown {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      cursor: database.prepare("SELECT * FROM cursors").all(),
      handled: database.prepare("SELECT * FROM handled_message_versions").all(),
      sessions: database.prepare("SELECT * FROM session_bindings").all(),
      authorization: database.prepare("SELECT * FROM route_wake_overrides").all(),
      outbox: database.prepare("SELECT * FROM outbound_outbox").all(),
    };
  } finally {
    database.close();
  }
}

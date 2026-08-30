import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { latestMigrationManifest, migrateInstallation } from "../src/migration.js";
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

  it("preserves a selected per-agent config and state layout", async () => {
    const home = await nestedLegacyHome("klee");
    const legacyConfigPath = join(home, ".config/aag/klee/agent.yaml");
    const plan = await migrateInstallation({ home, legacyConfigPath, dryRun: true });
    expect(plan.items.find((item) => item.kind === "config")).toMatchObject({
      source: join(home, ".config/aag/klee"),
      destination: join(home, ".config/knot/klee"),
    });
    await migrateInstallation({ home, legacyConfigPath });
    const config = await loadConfig(join(home, ".config/knot/klee/agent.yaml"));
    expect(config.state.path).toBe(join(home, ".local/state/knot/klee/state.sqlite"));
    expect(snapshot(config.state.path)).toEqual(
      snapshot(join(home, ".local/state/aag/klee/state.sqlite")),
    );
  });

  it("refuses selected configs outside the legacy AAG config tree", async () => {
    const home = await legacyHome();
    const outside = join(home, ".config/other/agent.yaml");
    await mkdir(dirname(outside), { recursive: true });
    await writeFile(outside, "version: 1\n");
    await expect(migrateInstallation({ home, legacyConfigPath: outside })).rejects.toThrow(
      "beneath",
    );
  });

  it("refuses a selected config reached through a symbolic link", async () => {
    const home = await legacyHome();
    const linkedDirectory = join(home, ".config/aag/linked");
    await mkdir(linkedDirectory);
    const linkedConfig = join(linkedDirectory, "agent.yaml");
    await symlink(join(home, ".config/aag/agent.yaml"), linkedConfig);
    await expect(
      migrateInstallation({ home, legacyConfigPath: linkedConfig, dryRun: true }),
    ).rejects.toThrow("safe regular file");
  });

  it("requires an explicit selection when only nested configs exist", async () => {
    const home = await nestedLegacyHome("klee");
    await symlink("/fixture/key", join(home, ".config/aag/key.link"));
    await expect(migrateInstallation({ home, dryRun: true })).rejects.toThrow(
      "Rerun with --config <legacy agent.yaml>",
    );
  });

  it("selects the newest manifest for the requested config source", async () => {
    const home = await nestedLegacyHome("klee");
    await addNestedLegacyAgent(home, "anya");
    const klee = join(home, ".config/aag/klee/agent.yaml");
    const anya = join(home, ".config/aag/anya/agent.yaml");
    await migrateInstallation({
      home,
      legacyConfigPath: klee,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    await migrateInstallation({
      home,
      legacyConfigPath: anya,
      now: new Date("2026-01-02T00:00:00Z"),
    });
    await writeFile(
      join(home, ".local/state/knot-migration-manifests/2026-01-03T00-00-00-000Z.json"),
      "interrupted",
    );
    const manifest = await latestMigrationManifest(home, dirname(klee));
    expect(manifest?.items.find((item) => item.kind === "config")?.source).toBe(dirname(klee));
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

async function nestedLegacyHome(agent: string): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "knot-migration-nested-")));
  roots.push(home);
  await addNestedLegacyAgent(home, agent);
  return home;
}

async function addNestedLegacyAgent(home: string, agent: string): Promise<void> {
  const configDirectory = join(home, ".config/aag", agent);
  const stateDirectory = join(home, ".local/state/aag", agent);
  await mkdir(configDirectory, { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  const statePath = join(stateDirectory, "state.sqlite");
  await writeFile(
    join(configDirectory, "agent.yaml"),
    `version: 1\nagent:\n  name: Fixture\n  participantId: _participant_fixture_agent_01\nanytype:\n  apiKeyFile: /fixture/key\nspaces:\n  - id: _space_fixture_01\nruntime:\n  kind: codex\nstate:\n  path: ${statePath}\n`,
    { mode: 0o600 },
  );
  const database = new DatabaseSync(statePath);
  database.exec(await readFile(join(fixture, "state.sql"), "utf8"));
  database.exec("PRAGMA journal_mode=WAL");
  database.close();
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

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { runInitOnboarding } from "../src/onboarding.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("aag init", () => {
  it("defaults a Codex agent workspace to the directory where init runs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aag-init-"));
    temporaryDirectories.push(cwd);
    const answers = [
      "Klee",
      "",
      "",
      "participant-klee",
      "",
      "space-imai",
      "participant-raj",
      "y",
      "",
      "",
      "",
      "",
      "n",
      "",
      "",
      "",
    ];
    const result = await runInitOnboarding(
      { question: async () => answers.shift() ?? "" },
      { cwd },
    );

    expect(result.workspace).toBe(cwd);
    expect(result.output).toBe(join(cwd, "agent.yaml"));
    expect(result.agentsFile).toBe(join(cwd, "AGENTS.md"));
    const config = YAML.parse(await readFile(result.output, "utf8"));
    expect(config.runtime).toMatchObject({
      kind: "codex",
      defaultProject: cwd,
      desktopProject: "auto",
      permissions: "allow-once",
    });
    expect(config.context.promptMode).toBe("workspace");
    expect(config.tools.codex).toMatchObject({ enabled: true, sandbox: "workspace-write" });
    expect(config.spaces[0].chatDiscovery).toMatchObject({ enabled: true, autoEnroll: true });
    expect(config.directMessages).toMatchObject({
      enabled: true,
      wake: { humans: "every-message", allowedUsers: ["participant-raj"] },
    });
    expect(await readFile(result.agentsFile!, "utf8")).toContain(
      "Turns may arrive through Anytype Agent Gateway",
    );
  });
});

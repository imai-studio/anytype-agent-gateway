import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config.js";
import { callTool, toolDefinitions } from "../src/mcp.js";
import type { AnytypeClient } from "../src/anytype-client.js";

function config(overrides: Record<string, unknown> = {}) {
  return configSchema.parse({
    version: 1,
    agent: { name: "Tool Agent", participantId: "bot" },
    anytype: { apiKeyFile: "/private/key" },
    spaces: [{ id: "space-1" }],
    runtime: { kind: "codex", defaultProject: "/workspace" },
    tools: { anytype: { allowWrite: true } },
    ...overrides,
  });
}

function client() {
  return {
    resolveSpace: vi.fn(),
    searchSpace: vi.fn().mockResolvedValue([{ id: "found" }]),
    getObject: vi.fn().mockResolvedValue({ id: "object-1", name: "Note" }),
    createObject: vi.fn().mockResolvedValue({ id: "created", name: "Created" }),
    updateObject: vi.fn().mockResolvedValue({ id: "updated" }),
    addObjectsToList: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue({ object_id: "file-object" }),
    archiveObject: vi.fn().mockResolvedValue({ id: "archived" }),
  } as unknown as AnytypeClient;
}

describe("AAG Anytype MCP policy", () => {
  it("reports its gateway context without exposing the API key", async () => {
    const result = await callTool(client(), config(), "/config.yaml", "chat:space-1:chat", "space-1", "aag_context", {});
    expect(result).toMatchObject({ gateway: "Anytype Agent Gateway", route_id: "chat:space-1:chat", space_id: "space-1" });
    expect(JSON.stringify(result)).not.toContain("/private/key");
  });

  it("enforces the space allowlist before making a request", async () => {
    const anytype = client();
    await expect(callTool(anytype, config({ tools: { anytype: { allowedSpaceIds: ["space-1"] } } }), "/config.yaml", undefined, undefined, "anytype_search", { space_id: "space-2", query: "x" })).rejects.toThrow("not allowed");
    expect((anytype as any).searchSpace).not.toHaveBeenCalled();
  });

  it("returns a native Anytype link for created objects", async () => {
    const anytype = client();
    const result = await callTool(anytype, config(), "/config.yaml", undefined, "space-1", "anytype_create_object", { type_key: "page", name: "Daily note" });
    expect(result).toMatchObject({ id: "created", link: "anytype://object/?objectId=created&spaceId=space-1" });
  });

  it("blocks every mutation when writes are disabled", async () => {
    await expect(callTool(client(), config({ tools: { anytype: { allowWrite: false } } }), "/config.yaml", undefined, "space-1", "anytype_update_object", { object_id: "object-1", name: "No" })).rejects.toThrow("writes are disabled");
  });

  it("keeps implicit access on the current conversation space", async () => {
    const scoped = config({ spaces: [{ id: "space-1" }, { id: "space-2" }], tools: { anytype: { allowWrite: true } } });
    await expect(callTool(client(), scoped, "/config.yaml", "chat:space-1:chat", "space-1", "anytype_get_object", { space_id: "space-2", object_id: "object" })).rejects.toThrow("No cross-space");
  });

  it("advertises route wake management independently of object writes", () => {
    const managed = config({ management: { allowWakeChanges: true }, tools: { anytype: { allowWrite: false } } });
    expect(toolDefinitions(managed).map(tool => tool.name)).toContain("aag_set_wake");
  });

  it("rejects a non-numeric search limit before calling Anytype", async () => {
    const anytype = client();
    await expect(callTool(anytype, config(), "/config.yaml", undefined, "space-1", "anytype_search", { query: "x", limit: "many" })).rejects.toThrow("positive number");
    expect((anytype as any).searchSpace).not.toHaveBeenCalled();
  });

  it("resolves symlinks before applying upload roots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aag-mcp-"));
    const allowed = join(directory, "allowed");
    const outside = join(directory, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "secret");
    const link = join(allowed, "escape.txt");
    await symlink(secret, link);
    await expect(callTool(client(), config({ tools: { anytype: { allowWrite: true, allowedFileRoots: [allowed] } } }), "/config.yaml", undefined, "space-1", "anytype_upload_file", { path: link })).rejects.toThrow("outside");
  });
});

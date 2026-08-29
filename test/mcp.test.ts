import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config.js";
import { callTool, toolDefinitions } from "../src/mcp.js";
import { Store } from "../src/store.js";
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
    listSpaces: vi.fn().mockResolvedValue([
      { id: "space-1", name: "Agents" },
      { id: "space-2", name: "imai.tech" },
    ]),
    listChats: vi.fn().mockResolvedValue([{ id: "chat-1", name: "main" }]),
    searchSpace: vi.fn().mockResolvedValue([{ id: "found" }]),
    getObject: vi.fn().mockResolvedValue({
      id: "object-1",
      name: "Note",
      type: { key: "page" },
      properties: [{ key: "status", text: "Open" }],
    }),
    listTypes: vi.fn().mockResolvedValue([{ id: "type-page", key: "page" }]),
    getType: vi
      .fn()
      .mockResolvedValue({ id: "type-page", key: "page", properties: [{ key: "status" }] }),
    listProperties: vi
      .fn()
      .mockResolvedValue([{ id: "property-status", key: "status", format: "select" }]),
    getProperty: vi
      .fn()
      .mockResolvedValue({ id: "property-status", key: "status", format: "select" }),
    listPropertyTags: vi.fn().mockResolvedValue([{ id: "tag-open", name: "Open" }]),
    listTemplates: vi.fn().mockResolvedValue([{ id: "template-daily", name: "Daily" }]),
    listViews: vi.fn().mockResolvedValue([{ id: "view-board", name: "Board" }]),
    listViewObjects: vi.fn().mockResolvedValue([{ id: "task-1", name: "Task" }]),
    createObject: vi.fn().mockResolvedValue({ id: "created", name: "Created" }),
    updateObject: vi.fn().mockResolvedValue({ id: "updated" }),
    addObjectsToList: vi.fn().mockResolvedValue(undefined),
    removeObjectFromList: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue({ object: { id: "file-object", name: "Asset" } }),
    archiveObject: vi.fn().mockResolvedValue({ id: "archived" }),
  } as unknown as AnytypeClient;
}

describe("AAG Anytype MCP policy", () => {
  it("exposes separate Codex task creation only when explicitly enabled", () => {
    expect(toolDefinitions(config()).map((tool) => tool.name)).not.toContain(
      "aag_create_codex_task",
    );
    const enabled = toolDefinitions(
      config({ tools: { anytype: { allowWrite: true }, codex: { enabled: true } } }),
    ).map((tool) => tool.name);
    expect(enabled.filter((name) => name === "aag_create_codex_task")).toEqual([
      "aag_create_codex_task",
    ]);
    expect(enabled.filter((name) => name === "aag_create_bound_chat")).toEqual([
      "aag_create_bound_chat",
    ]);
  });

  it("reports its gateway context without exposing the API key", async () => {
    const result = await callTool(
      client(),
      config(),
      "/config.yaml",
      "chat:space-1:chat",
      "space-1",
      "aag_context",
      {},
    );
    expect(result).toMatchObject({
      gateway: "Anytype Agent Gateway",
      route_id: "chat:space-1:chat",
      space_id: "space-1",
    });
    expect(JSON.stringify(result)).not.toContain("/private/key");
  });

  it("describes a native OpenClaw command job bound to the current chat session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aag-mcp-schedule-"));
    const statePath = join(directory, "state.sqlite");
    const store = new Store(statePath);
    store.saveSessionBinding({
      threadKey: "chat:space-1:chat",
      routeId: "chat:space-1:chat",
      spaceId: "space-1",
      chatId: "chat",
      runtime: "openclaw",
      nativeSessionKey: "agent:main:aag:chat:space-1:chat",
      generation: 0,
      state: "active",
    });
    store.close();

    const result = await callTool(
      client(),
      config({
        runtime: { kind: "openclaw", command: "/opt/openclaw" },
        state: { path: statePath },
      }),
      "/config.yaml",
      "chat:space-1:chat",
      "space-1",
      "aag_context",
      {},
    );
    expect(result).toMatchObject({
      scheduling: {
        provider: "openclaw",
        available: true,
        session_key: "agent:main:aag:chat:space-1:chat",
        delivery_channel: "anytype",
        continuation_argv: [
          "/opt/openclaw",
          "agent",
          "--session-key",
          "agent:main:aag:chat:space-1:chat",
          "--message",
          "<scheduled prompt>",
          "--deliver",
          "--reply-channel",
          "anytype",
          "--reply-to",
          expect.stringMatching(/^route:/),
        ],
      },
    });
    await rm(directory, { recursive: true, force: true });
  });

  it("requires the current discussion root before exposing a scheduled continuation", async () => {
    const result = await callTool(
      client(),
      config({ runtime: { kind: "openclaw" } }),
      "/config.yaml",
      "discussion:space-1:discussion",
      "space-1",
      "aag_context",
      {},
    );
    expect(result).toMatchObject({
      scheduling: {
        available: false,
        reason: expect.stringContaining("discussion_root_id"),
      },
    });
  });

  it("enforces the space allowlist before making a request", async () => {
    const anytype = client();
    await expect(
      callTool(
        anytype,
        config({ tools: { anytype: { allowedSpaceIds: ["space-1"] } } }),
        "/config.yaml",
        undefined,
        undefined,
        "anytype_search",
        { space_id: "space-2", query: "x" },
      ),
    ).rejects.toThrow("not allowed");
    expect((anytype as any).searchSpace).not.toHaveBeenCalled();
  });

  it("can discover every space joined by the identity when explicitly configured", async () => {
    const anytype = client();
    const joinedSpaces = config({ tools: { anytype: { allowedSpaceIds: ["*"] } } });

    await expect(
      callTool(
        anytype,
        joinedSpaces,
        "/config.yaml",
        "chat:space-1:chat",
        "space-1",
        "anytype_list_spaces",
        {},
      ),
    ).resolves.toEqual([
      { id: "space-1", name: "Agents" },
      { id: "space-2", name: "imai.tech" },
    ]);
    await expect(
      callTool(
        anytype,
        joinedSpaces,
        "/config.yaml",
        "chat:space-1:chat",
        "space-1",
        "anytype_list_chats",
        { space_id: "space-2" },
      ),
    ).resolves.toEqual([{ id: "chat-1", name: "main" }]);
  });

  it("returns native links for search results", async () => {
    await expect(
      callTool(client(), config(), "/config.yaml", undefined, "space-1", "anytype_search", {
        query: "x",
      }),
    ).resolves.toEqual([
      {
        id: "found",
        link: "anytype://object?objectId=found&spaceId=space-1",
        object_ref: "[[AAG_OBJECT:found|Open in Anytype]]",
        object_card: "[[AAG_OBJECT_CARD:found|Open in Anytype]]",
      },
    ]);
  });

  it("returns a native Anytype link for created objects", async () => {
    const anytype = client();
    const result = await callTool(
      anytype,
      config(),
      "/config.yaml",
      undefined,
      "space-1",
      "anytype_create_object",
      { type_key: "page", name: "Daily note" },
    );
    expect(result).toMatchObject({
      id: "created",
      link: "anytype://object?objectId=created&spaceId=space-1",
      object_ref: "[[AAG_OBJECT:created|Created]]",
      object_card: "[[AAG_OBJECT_CARD:created|Created]]",
    });
  });

  it("rejects collection bodies with an actionable workflow", async () => {
    const anytype = client();
    await expect(
      callTool(anytype, config(), "/config.yaml", undefined, "space-1", "anytype_create_object", {
        type_key: "collection",
        name: "Changelog",
        body: "Entry",
      }),
    ).rejects.toThrow("create the content object separately");
    expect((anytype as any).createObject).not.toHaveBeenCalled();
  });

  it("exposes schema discovery and complete object data without write permission", async () => {
    const anytype = client();
    const readOnly = config({ tools: { anytype: { enabled: true, allowWrite: false } } });
    await expect(
      callTool(anytype, readOnly, "/config.yaml", undefined, "space-1", "anytype_list_types", {}),
    ).resolves.toEqual([{ id: "type-page", key: "page" }]);
    await expect(
      callTool(anytype, readOnly, "/config.yaml", undefined, "space-1", "anytype_get_type", {
        type_id: "type-page",
      }),
    ).resolves.toMatchObject({ properties: [{ key: "status" }] });
    await expect(
      callTool(
        anytype,
        readOnly,
        "/config.yaml",
        undefined,
        "space-1",
        "anytype_list_properties",
        {},
      ),
    ).resolves.toMatchObject([{ format: "select" }]);
    await expect(
      callTool(
        anytype,
        readOnly,
        "/config.yaml",
        undefined,
        "space-1",
        "anytype_list_property_tags",
        { property_id: "property-status" },
      ),
    ).resolves.toEqual([{ id: "tag-open", name: "Open" }]);
    await expect(
      callTool(anytype, readOnly, "/config.yaml", undefined, "space-1", "anytype_list_templates", {
        type_id: "type-page",
      }),
    ).resolves.toEqual([{ id: "template-daily", name: "Daily" }]);
    await expect(
      callTool(anytype, readOnly, "/config.yaml", undefined, "space-1", "anytype_list_views", {
        list_id: "collection",
      }),
    ).resolves.toEqual([{ id: "view-board", name: "Board" }]);
    await expect(
      callTool(
        anytype,
        readOnly,
        "/config.yaml",
        undefined,
        "space-1",
        "anytype_list_view_objects",
        { list_id: "collection", view_id: "view-board" },
      ),
    ).resolves.toEqual([
      {
        id: "task-1",
        name: "Task",
        link: "anytype://object?objectId=task-1&spaceId=space-1",
        object_ref: "[[AAG_OBJECT:task-1|Task]]",
        object_card: "[[AAG_OBJECT_CARD:task-1|Task]]",
      },
    ]);
    await expect(
      callTool(anytype, readOnly, "/config.yaml", undefined, "space-1", "anytype_get_object", {
        object_id: "object-1",
      }),
    ).resolves.toMatchObject({
      type: { key: "page" },
      properties: [{ key: "status", text: "Open" }],
    });
  });

  it("blocks every mutation when writes are disabled", async () => {
    await expect(
      callTool(
        client(),
        config({ tools: { anytype: { allowWrite: false } } }),
        "/config.yaml",
        undefined,
        "space-1",
        "anytype_update_object",
        { object_id: "object-1", name: "No" },
      ),
    ).rejects.toThrow("writes are disabled");
  });

  it("validates typed property values and prevents type changes on update", async () => {
    const anytype = client();
    await callTool(
      anytype,
      config(),
      "/config.yaml",
      undefined,
      "space-1",
      "anytype_update_object",
      {
        object_id: "object-1",
        properties: [
          { key: "status", select: "tag-open" },
          { key: "done", checkbox: true },
        ],
      },
    );
    expect((anytype as any).updateObject).toHaveBeenCalledWith("space-1", "object-1", {
      properties: [
        { key: "status", select: "tag-open" },
        { key: "done", checkbox: true },
      ],
    });
    await expect(
      callTool(anytype, config(), "/config.yaml", undefined, "space-1", "anytype_update_object", {
        object_id: "object-1",
        type_key: "participant",
      }),
    ).rejects.toThrow("type is not allowed");
    await expect(
      callTool(anytype, config(), "/config.yaml", undefined, "space-1", "anytype_update_object", {
        object_id: "object-1",
        properties: [{ key: "archived", checkbox: true }],
      }),
    ).rejects.toThrow("reserved");
    await expect(
      callTool(anytype, config(), "/config.yaml", undefined, "space-1", "anytype_update_object", {
        object_id: "object-1",
        properties: [{ key: "status", select: "open", text: "also" }],
      }),
    ).rejects.toThrow("exactly one");
  });

  it("fails file uploads closed when no explicit roots are configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aag-mcp-no-roots-"));
    const path = join(directory, "asset.txt");
    await writeFile(path, "asset");
    await expect(
      callTool(client(), config(), "/config.yaml", undefined, "space-1", "anytype_upload_file", {
        path,
      }),
    ).rejects.toThrow("explicit allowedFileRoots");
  });

  it("returns a usable object reference for a nested file response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aag-mcp-upload-"));
    const path = join(directory, "asset.txt");
    await writeFile(path, "asset");
    await expect(
      callTool(
        client(),
        config({ tools: { anytype: { allowWrite: true, allowedFileRoots: [directory] } } }),
        "/config.yaml",
        undefined,
        "space-1",
        "anytype_upload_file",
        { path },
      ),
    ).resolves.toMatchObject({
      link: "anytype://object?objectId=file-object&spaceId=space-1",
      object_ref: "[[AAG_OBJECT:file-object|Asset]]",
      object_card: "[[AAG_OBJECT_CARD:file-object|Asset]]",
    });
  });

  it("keeps implicit access on the current conversation space", async () => {
    const scoped = config({
      spaces: [{ id: "space-1" }, { id: "space-2" }],
      tools: { anytype: { allowWrite: true } },
    });
    await expect(
      callTool(
        client(),
        scoped,
        "/config.yaml",
        "chat:space-1:chat",
        "space-1",
        "anytype_get_object",
        { space_id: "space-2", object_id: "object" },
      ),
    ).rejects.toThrow("No cross-space");
  });

  it("advertises route wake management independently of object writes", () => {
    const managed = config({
      management: { allowWakeChanges: true },
      tools: { anytype: { allowWrite: false } },
    });
    expect(toolDefinitions(managed).map((tool) => tool.name)).toContain("aag_set_wake");
  });

  it("advertises constrained participant access management", () => {
    const managed = config({
      management: {
        allowAccessChanges: true,
        accessAdmins: ["admin"],
      },
      tools: { anytype: { allowWrite: false } },
    });
    expect(toolDefinitions(managed).map((tool) => tool.name)).toContain("aag_set_access");
  });

  it("cannot change wake policy outside the bound Anytype conversation", async () => {
    const managed = config({ management: { allowWakeChanges: true } });
    await expect(
      callTool(
        client(),
        managed,
        "/config.yaml",
        "chat:space-1:current-chat",
        "space-1",
        "aag_set_wake",
        { route_id: "chat:space-1:other-chat", humans: "every-message" },
      ),
    ).rejects.toThrow("must match the current Anytype conversation");
  });

  it("binds participant access changes to the current sender", async () => {
    const managed = config({
      management: { allowAccessChanges: true, accessAdmins: ["admin"] },
    });
    await expect(
      callTool(
        client(),
        managed,
        "/config.yaml",
        "chat:space-1:current-chat",
        "space-1",
        "aag_set_access",
        {
          actor_id: "forged-admin",
          operation: "add",
          participant_ids: ["member"],
        },
        "actual-sender",
      ),
    ).rejects.toThrow("must match the current Anytype sender");
  });

  it("keeps archive independent from general write permission", async () => {
    const noArchive = config({ tools: { anytype: { allowWrite: true, allowArchive: false } } });
    expect(toolDefinitions(noArchive).map((tool) => tool.name)).not.toContain(
      "anytype_archive_object",
    );
    await expect(
      callTool(
        client(),
        noArchive,
        "/config.yaml",
        undefined,
        "space-1",
        "anytype_archive_object",
        { object_id: "object-1" },
      ),
    ).rejects.toThrow("Archiving is disabled");
  });

  it("rejects a non-numeric search limit before calling Anytype", async () => {
    const anytype = client();
    await expect(
      callTool(anytype, config(), "/config.yaml", undefined, "space-1", "anytype_search", {
        query: "x",
        limit: "many",
      }),
    ).rejects.toThrow("positive number");
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
    await expect(
      callTool(
        client(),
        config({ tools: { anytype: { allowWrite: true, allowedFileRoots: [allowed] } } }),
        "/config.yaml",
        undefined,
        "space-1",
        "anytype_upload_file",
        { path: link },
      ),
    ).rejects.toThrow("outside");
  });
});

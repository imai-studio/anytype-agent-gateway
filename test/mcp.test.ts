import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { configSchema, loadConfig } from "../src/config.js";
import { callTool, toolDefinitions } from "../src/mcp.js";
import { Store } from "../src/store.js";
import { runProcess } from "../src/process.js";
import type { AnytypeClient } from "../src/anytype-client.js";
import {
  initializeCloudConfig,
  resolveCloudPaths,
  saveCloudConfig,
  type CloudConfig,
} from "../src/cloud-config.js";

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
    setProfileImage: vi.fn().mockResolvedValue({ file: { object_id: "file-object" } }),
    archiveObject: vi.fn().mockResolvedValue({ id: "archived" }),
  } as unknown as AnytypeClient;
}

describe("AAG Anytype MCP policy", () => {
  it("exposes one typed publication tool without runtime URLs, keys, HTML, or file paths", () => {
    const configured = config({
      tools: {
        publish: {
          enabled: true,
          allowedUsers: ["owner"],
          allowedSiteIds: ["00000000-0000-4000-8000-000000000011"],
          allowedSlugPrefixes: ["notes/"],
        },
      },
    });
    const tool = toolDefinitions(configured).find((entry) => entry.name === "aag_publish");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toHaveProperty("properties.actor_capability");
    const fields = Object.keys((tool?.inputSchema.properties ?? {}) as Record<string, unknown>);
    expect(fields).not.toContain("url");
    expect(fields).not.toContain("api_key");
    expect(fields).not.toContain("html");
    expect(fields).not.toContain("path");
    expect(JSON.stringify(tool?.inputSchema)).not.toContain('"href"');
  });

  it("requires verified native sender authority before a publication can reach Cloud", async () => {
    const configured = config({
      tools: {
        publish: {
          enabled: true,
          allowedUsers: ["owner"],
          allowedSiteIds: ["00000000-0000-4000-8000-000000000011"],
          allowedSlugPrefixes: ["notes/"],
        },
      },
    });
    await expect(
      callTool(
        client(),
        configured,
        "/config.yaml",
        "chat:space-1:chat",
        "space-1",
        "aag_publish",
        {
          action: "status",
          publication_id: "00000000-0000-4000-8000-000000000022",
        },
        "intruder",
      ),
    ).rejects.toThrow("current Anytype sender is not allowed to publish");
  });

  it.each([
    { authority: "bound", routeId: "chat:space-1:chat" },
    { authority: "capability", routeId: "chat:space-1:chat" },
    { authority: "capability", routeId: "discussion:space-1:discussion" },
  ])(
    "publishes through the constrained tool ($authority, $routeId) with status then multiple pushes",
    async ({ authority, routeId }) => {
      const directory = await mkdtemp(join(tmpdir(), "knot-mcp-publish-"));
      const paths = resolveCloudPaths({ configFile: join(directory, "cloud.json") });
      const base = await initializeCloudConfig({
        paths,
        baseUrl: "https://knot.example",
        connectorName: "Test Mac",
        requestedScopes: ["publications.read", "publications.write"],
        requestedSlugGrants: ["notes/*"],
      });
      const siteId = "00000000-0000-4000-8000-000000000011";
      const publicationId = "00000000-0000-4000-8000-000000000022";
      const paired: CloudConfig = {
        ...base,
        paired: {
          connectorId: "00000000-0000-4000-8000-000000000033",
          tenantId: "00000000-0000-4000-8000-000000000044",
          scopes: ["publications.read", "publications.write"],
          siteIds: [siteId],
          slugGrants: ["notes/*"],
          approvedAt: 1,
        },
      };
      await saveCloudConfig(paths, paired);
      const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
        if (String(_input).endsWith("/status"))
          return Response.json({
            protocolVersion: "1.0",
            publicationId,
            siteId,
            slug: "notes/status",
            state: "ready",
            updatedAt: 1,
          });
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("Knot-Signature")).toBeTruthy();
        return Response.json(
          {
            protocolVersion: "1.0",
            publicationId,
            versionId: "00000000-0000-4000-8000-000000000055",
            state: "ready",
          },
          { status: 201 },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      try {
        const configured = config({
          runtime:
            authority === "capability"
              ? { kind: "openclaw" }
              : { kind: "codex", defaultProject: "/workspace" },
          state: { path: join(directory, "state.sqlite") },
          tools: {
            publish: {
              enabled: true,
              allowedUsers: ["owner"],
              allowedSiteIds: [siteId],
              allowedSlugPrefixes: ["notes/"],
              cloudConfigFile: paths.configFile,
            },
          },
        });
        const store = new Store(configured.state.path);
        const capability = store.issueManagementCapability(
          routeId,
          "owner",
          "publish",
          undefined,
          routeId.startsWith("discussion:") ? `${routeId}:root:source` : routeId,
        );
        store.close();
        const actorId = authority === "bound" ? "owner" : undefined;
        const metadata =
          authority === "capability" ? { actor_capability: capability, route_id: routeId } : {};
        const boundRoute = authority === "bound" ? routeId : undefined;
        await expect(
          callTool(
            client(),
            configured,
            "/config.yaml",
            boundRoute,
            "space-1",
            "aag_publish",
            {
              action: "status",
              publication_id: publicationId,
              ...metadata,
            },
            actorId,
          ),
        ).resolves.toMatchObject({ state: "ready" });
        for (const slug of ["notes/hello", "notes/second"])
          await expect(
            callTool(
              client(),
              configured,
              "/config.yaml",
              boundRoute,
              "space-1",
              "aag_publish",
              {
                ...metadata,
                action: "push",
                publication_id: publicationId,
                site_id: siteId,
                slug,
                operation: "create",
                document: {
                  schemaVersion: "1.0",
                  title: "Release",
                  blocks: [{ type: "paragraph", content: [{ text: "Ready" }] }],
                },
              },
              actorId,
            ),
          ).resolves.toMatchObject({ state: "succeeded" });
        expect(fetchMock).toHaveBeenCalledTimes(3);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("rejects runtime-provided links in the constrained publication tool", async () => {
    const configured = config({
      tools: {
        publish: {
          enabled: true,
          allowedUsers: ["owner"],
          allowedSiteIds: ["00000000-0000-4000-8000-000000000011"],
          allowedSlugPrefixes: ["notes/"],
        },
      },
    });
    await expect(
      callTool(
        client(),
        configured,
        "/config.yaml",
        "chat:space-1:chat",
        "space-1",
        "aag_publish",
        {
          action: "push",
          publication_id: "00000000-0000-4000-8000-000000000022",
          site_id: "00000000-0000-4000-8000-000000000011",
          slug: "notes/link",
          operation: "create",
          document: {
            schemaVersion: "1.0",
            title: "Link",
            blocks: [
              {
                type: "paragraph",
                content: [{ text: "Link", href: "https://example.com" }],
              },
            ],
          },
        },
        "owner",
      ),
    ).rejects.toThrow("does not accept runtime-provided URLs");
  });

  it("exposes only digest-addressed media in the constrained publication tool", () => {
    const configured = config({
      tools: {
        publish: {
          enabled: true,
          allowedUsers: ["owner"],
          allowedSiteIds: ["00000000-0000-4000-8000-000000000011"],
          allowedSlugPrefixes: ["notes/"],
        },
      },
    });
    const tool = toolDefinitions(configured).find((entry) => entry.name === "aag_publish");
    expect(tool).toBeDefined();
    const serialized = JSON.stringify(tool!.inputSchema);
    expect(serialized).toContain("assetDigest");
    expect(serialized).toContain("image");
    expect(serialized).toContain("file");
    expect(serialized).not.toContain('"requiredHeaders"');
  });

  it("rejects wildcard or incomplete publication policy at configuration time", () => {
    expect(() =>
      config({
        tools: {
          publish: {
            enabled: true,
            allowedUsers: ["*"],
            allowedSiteIds: [],
            allowedSlugPrefixes: [],
          },
        },
      }),
    ).toThrow();
  });

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
      gateway: "Knot",
      route_id: "chat:space-1:chat",
      space_id: "space-1",
    });
    expect(JSON.stringify(result)).not.toContain("/private/key");
  });

  it("pins model changes to the bound discussion and authorized sender", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aag-mcp-model-"));
    const statePath = join(directory, "state.sqlite");
    const threadKey = "discussion:space-1:discussion:root:root-1";
    const store = new Store(statePath);
    store.saveConversationModel({
      threadKey,
      runtime: "codex-acp",
      appliedModelId: "gpt-default",
      defaultModelId: "gpt-default",
      catalog: [
        { id: "gpt-default", name: "Default" },
        { id: "gpt-fast", name: "Fast" },
      ],
    });
    store.close();
    const configured = config({
      state: { path: statePath },
      models: { enabled: true, allowed: ["*"] },
      management: { allowModelChanges: true, modelAdmins: ["owner"] },
    });

    await expect(
      callTool(
        client(),
        configured,
        "/config.yaml",
        "discussion:space-1:discussion",
        "space-1",
        "aag_set_model",
        { model_id: "gpt-fast", discussion_root_id: "root-2" },
        "owner",
        "root-1",
      ),
    ).rejects.toThrow("must match the current Anytype discussion");
    await expect(
      callTool(
        client(),
        configured,
        "/config.yaml",
        "discussion:space-1:discussion",
        "space-1",
        "aag_set_model",
        { model_id: "gpt-fast" },
        "intruder",
        "root-1",
      ),
    ).rejects.toThrow("not allowed");
    await expect(
      callTool(
        client(),
        configured,
        "/config.yaml",
        "discussion:space-1:discussion",
        "space-1",
        "aag_set_model",
        { model_id: "gpt-fast" },
        "owner",
        "root-1",
      ),
    ).resolves.toMatchObject({ requested_model: "gpt-fast", applies: "next turn" });
    await rm(directory, { recursive: true, force: true });
  });

  it("allows bound DM model tools without widening unbound space access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aag-mcp-dm-model-"));
    const configured = config({
      state: { path: join(directory, "state.sqlite") },
      models: { enabled: true, allowed: ["*"] },
      tools: { anytype: { allowWrite: true, allowedSpaceIds: ["space-1"] } },
    });
    await expect(
      callTool(
        client(),
        configured,
        "/config.yaml",
        "chat:dm-space:chat",
        "dm-space",
        "aag_list_models",
        {},
      ),
    ).resolves.toMatchObject({ thread_key: "chat:dm-space:chat" });
    await expect(
      callTool(client(), configured, "/config.yaml", undefined, "space-1", "aag_list_models", {
        route_id: "chat:dm-space:chat",
      }),
    ).rejects.toThrow("not allowed");
    await rm(directory, { recursive: true, force: true });
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

  it("updates only the configured agent identity's profile image", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aag-mcp-profile-"));
    const path = join(directory, "avatar.png");
    await writeFile(path, "image");
    const anytype = client();
    const result = await callTool(
      anytype,
      config({
        agent: { name: "Tool Agent", participantId: "agent-member" },
        tools: { anytype: { allowWrite: true, allowedFileRoots: [directory] } },
      }),
      "/config.yaml",
      undefined,
      "space-1",
      "aag_set_profile_image",
      { path },
    );

    expect((anytype as any).setProfileImage).toHaveBeenCalledWith("space-1", await realpath(path));
    expect(result).toMatchObject({ updated: true, member_id: "agent-member" });
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

  it("does not expose a caller-supplied actor identity for access changes", () => {
    const managed = config({
      management: { allowAccessChanges: true, accessAdmins: ["admin"] },
    });
    const access = toolDefinitions(managed).find((tool) => tool.name === "aag_set_access");
    expect(access?.inputSchema).not.toHaveProperty("properties.actor_id");
    expect(access?.inputSchema).toHaveProperty("properties.actor_capability");
  });

  it("fails closed when participant access changes have no verified sender", async () => {
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
        { operation: "add", participant_ids: ["member"] },
      ),
    ).rejects.toThrow("could not be verified");
  });

  it("accepts one route-scoped capability minted for the authenticated OpenClaw turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "knot-mcp-capability-"));
    const configPath = join(directory, "agent.yaml");
    const statePath = join(directory, "state.sqlite");
    await writeFile(
      configPath,
      YAML.stringify({
        version: 1,
        agent: { name: "Anya", participantId: "bot" },
        anytype: { apiKeyFile: "/private/key" },
        spaces: [
          {
            id: "space-1",
            chats: [
              {
                id: "current-chat",
                wake: { humans: "mention", agents: "never", allowedUsers: ["admin"] },
              },
            ],
          },
        ],
        runtime: { kind: "openclaw" },
        tools: { anytype: { allowWrite: false } },
        management: { allowAccessChanges: true, accessAdmins: ["admin"] },
        state: { path: statePath },
      }),
    );
    const managed = await loadConfig(configPath);
    const store = new Store(statePath);
    const capability = store.issueManagementCapability(
      "chat:space-1:current-chat",
      "admin",
      "access",
    );
    store.close();

    await expect(
      callTool(
        client(),
        managed,
        configPath,
        "chat:space-1:current-chat",
        "space-1",
        "aag_set_access",
        { operation: "add", participant_ids: ["member"], actor_capability: capability },
      ),
    ).resolves.toMatchObject({ allowed_users: ["admin", "member"] });
    await expect(
      callTool(
        client(),
        managed,
        configPath,
        "chat:space-1:current-chat",
        "space-1",
        "aag_set_access",
        { operation: "add", participant_ids: ["other"], actor_capability: capability },
      ),
    ).rejects.toThrow("could not be verified");
    await rm(directory, { recursive: true, force: true });
  });

  it("preserves route-wide discussion management and thread-specific models in unbound OpenClaw MCP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "knot-mcp-discussion-capability-"));
    const configPath = join(directory, "agent.yaml");
    const statePath = join(directory, "state.sqlite");
    const routeId = "discussion:space-1:discussion";
    const threadKey = `${routeId}:root:source`;
    await writeFile(
      configPath,
      YAML.stringify({
        version: 1,
        agent: { name: "Anya", participantId: "bot" },
        anytype: { apiKeyFile: "/private/key" },
        spaces: [
          {
            id: "space-1",
            comments: {
              mode: "all",
              wake: { humans: "mention", agents: "never", allowedUsers: ["admin"] },
            },
          },
        ],
        runtime: { kind: "openclaw" },
        tools: { anytype: { enabled: true, allowWrite: false, allowedSpaceIds: ["space-1"] } },
        management: {
          allowWakeChanges: true,
          allowAccessChanges: true,
          accessAdmins: ["admin"],
          allowModelChanges: true,
          modelAdmins: ["admin"],
        },
        models: { enabled: true },
        state: { path: statePath },
      }),
    );
    const managed = await loadConfig(configPath);
    const store = new Store(statePath);
    try {
      const wake = store.issueManagementCapability(routeId, "admin", "wake", undefined, threadKey);
      const access = store.issueManagementCapability(
        routeId,
        "admin",
        "access",
        undefined,
        threadKey,
      );
      const model = store.issueManagementCapability(
        routeId,
        "admin",
        "model",
        undefined,
        threadKey,
      );
      const invoke = (name: string, input: Record<string, unknown>) =>
        callTool(client(), managed, configPath, undefined, undefined, name, {
          route_id: routeId,
          ...input,
        });

      await expect(
        invoke("aag_set_wake", {
          route_id: "discussion:space-1:other",
          humans: "every-message",
          actor_capability: wake,
        }),
      ).rejects.toThrow("could not be verified");
      await expect(
        invoke("aag_set_wake", {
          humans: "every-message",
          actor_capability: wake,
        }),
      ).resolves.toMatchObject({ route_id: routeId, humans: "every-message" });
      await expect(
        invoke("aag_set_access", {
          operation: "add",
          participant_ids: ["member"],
          actor_capability: access,
        }),
      ).resolves.toMatchObject({ allowed_users: ["admin", "member"] });
      const persisted = await loadConfig(configPath);
      expect(persisted.spaces[0]!.wakeOverrides).toEqual([
        {
          kind: "discussion",
          id: "discussion",
          wake: expect.objectContaining({
            humans: "every-message",
            allowedUsers: ["admin", "member"],
          }),
        },
      ]);

      await expect(
        invoke("aag_set_model", {
          model_id: "default",
          actor_capability: model,
        }),
      ).rejects.toThrow("discussion_root_id is required");
      await expect(
        invoke("aag_set_model", {
          model_id: "default",
          discussion_root_id: "other",
          actor_capability: model,
        }),
      ).rejects.toThrow("could not be verified");
      await expect(
        invoke("aag_set_model", {
          model_id: "default",
          discussion_root_id: "source",
          actor_capability: model,
        }),
      ).resolves.toMatchObject({ thread_key: threadKey, applies: "next turn" });
      expect(store.conversationModel(threadKey, "openclaw")).toMatchObject({ useDefault: true });
      expect(store.conversationModel(`${routeId}:root:other`, "openclaw")).toBeUndefined();
      await expect(
        invoke("aag_set_model", {
          model_id: "default",
          discussion_root_id: "source",
          actor_capability: model,
        }),
      ).rejects.toThrow("could not be verified");
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves unbound capability metadata through the real MCP stdio subprocess", async () => {
    const directory = await mkdtemp(join(tmpdir(), "knot-mcp-stdio-"));
    const configPath = join(directory, "agent.yaml");
    const statePath = join(directory, "state.sqlite");
    const apiKeyFile = join(directory, "synthetic-key");
    const routeId = "discussion:space-1:discussion";
    const threadKey = `${routeId}:root:source`;
    await writeFile(apiKeyFile, "synthetic-unused-key");
    await writeFile(
      configPath,
      YAML.stringify({
        version: 1,
        agent: { name: "Anya", participantId: "bot" },
        anytype: { apiKeyFile, apiBase: "http://127.0.0.1:1" },
        spaces: [{ id: "space-1" }],
        runtime: { kind: "openclaw" },
        tools: { anytype: { enabled: true, allowWrite: false, allowedSpaceIds: ["space-1"] } },
        models: { enabled: true },
        management: { allowModelChanges: true, modelAdmins: ["admin"] },
        state: { path: statePath },
      }),
    );
    const store = new Store(statePath);
    const capability = store.issueManagementCapability(
      routeId,
      "admin",
      "model",
      undefined,
      threadKey,
    );
    store.close();
    const environment = { ...process.env };
    // Isolate from the operator's MCP bindings and credentials. ACTOR_ID alone
    // deliberately claims admin, proving it cannot substitute for a capability.
    for (const key of Object.keys(environment))
      if (/^(?:KNOT_|AAG_|ANYTYPE_|OPENCLAW_)/u.test(key)) delete environment[key];
    environment.KNOT_ACTOR_ID = "admin";
    const argumentsForModel = {
      route_id: routeId,
      discussion_root_id: "source",
      model_id: "default",
    };
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "aag_set_model", arguments: argumentsForModel },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "aag_set_model",
          arguments: {
            ...argumentsForModel,
            discussion_root_id: "other",
            actor_capability: capability,
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "aag_set_model",
          arguments: { ...argumentsForModel, actor_capability: capability },
        },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "aag_set_model",
          arguments: { ...argumentsForModel, actor_capability: capability },
        },
      },
    ];
    try {
      const result = await runProcess(
        process.execPath,
        [resolve("dist/cli.js"), "mcp", "--config", configPath],
        {
          env: environment,
          stdin: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
          timeoutMs: 5_000,
        },
      );
      const responses = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(responses.map((response) => response.id)).toEqual([1, 2, 3, 4, 5]);
      expect(responses[0].result).toMatchObject({ protocolVersion: "2025-06-18" });
      expect(responses[1].result.isError).toBe(true);
      expect(responses[1].result.content[0].text).toContain("not allowed to change models");
      for (const index of [2, 4]) {
        expect(responses[index].result.isError).toBe(true);
        expect(responses[index].result.content[0].text).toContain("could not be verified");
      }
      expect(responses[3].result.isError).toBeUndefined();
      expect(JSON.parse(responses[3].result.content[0].text)).toMatchObject({
        thread_key: threadKey,
        applies: "next turn",
      });
      const reopened = new Store(statePath);
      try {
        expect(reopened.conversationModel(threadKey, "openclaw")).toMatchObject({
          useDefault: true,
          updatedBy: "admin",
        });
        expect(reopened.conversationModel(`${routeId}:root:other`, "openclaw")).toBeUndefined();
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("publishes status and multiple pushes through unbound MCP stdio and the native HTTP client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "knot-mcp-stdio-publish-"));
    const siteId = "00000000-0000-4000-8000-000000000011";
    const publicationId = "00000000-0000-4000-8000-000000000022";
    const requests: Array<{ method: string; signed: boolean; body: string }> = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ method: request.method!, signed: !!request.headers["knot-signature"], body });
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/status")) {
        response.end(
          JSON.stringify({
            protocolVersion: "1.0",
            publicationId,
            siteId,
            slug: "notes/status",
            state: "ready",
            updatedAt: 1,
          }),
        );
      } else {
        response.statusCode = 201;
        response.end(
          JSON.stringify({
            protocolVersion: "1.0",
            publicationId,
            versionId: "00000000-0000-4000-8000-000000000055",
            state: "ready",
          }),
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test address");
      const paths = resolveCloudPaths({ configFile: join(directory, "cloud.json") });
      const base = await initializeCloudConfig({
        paths,
        baseUrl: `http://127.0.0.1:${address.port}`,
        connectorName: "Synthetic",
        requestedScopes: ["publications.read", "publications.write"],
        requestedSlugGrants: ["notes/*"],
      });
      await saveCloudConfig(paths, {
        ...base,
        paired: {
          connectorId: "00000000-0000-4000-8000-000000000033",
          tenantId: "00000000-0000-4000-8000-000000000044",
          scopes: ["publications.read", "publications.write"],
          siteIds: [siteId],
          slugGrants: ["notes/*"],
          approvedAt: 1,
        },
      });
      const apiKeyFile = join(directory, "synthetic-key");
      await writeFile(apiKeyFile, "synthetic-unused-key");
      const configPath = join(directory, "agent.yaml");
      const statePath = join(directory, "state.sqlite");
      await writeFile(
        configPath,
        YAML.stringify({
          version: 1,
          agent: { name: "Synthetic", participantId: "bot" },
          anytype: { apiKeyFile, apiBase: "http://127.0.0.1:1" },
          runtime: { kind: "openclaw" },
          spaces: [{ id: "space-1" }],
          state: { path: statePath },
          tools: {
            anytype: { allowedSpaceIds: ["space-1"] },
            publish: {
              enabled: true,
              allowedUsers: ["owner"],
              allowedSiteIds: [siteId],
              allowedSlugPrefixes: ["notes/"],
              cloudConfigFile: paths.configFile,
            },
          },
        }),
      );
      const routeId = "discussion:space-1:discussion";
      const store = new Store(statePath);
      const capability = store.issueManagementCapability(
        routeId,
        "owner",
        "publish",
        undefined,
        `${routeId}:root:source`,
      );
      store.close();
      const metadata = { route_id: routeId, actor_capability: capability };
      const status = { action: "status", publication_id: publicationId };
      const push = {
        ...metadata,
        action: "push",
        publication_id: publicationId,
        site_id: siteId,
        operation: "create",
        document: {
          schemaVersion: "1.0",
          title: "Synthetic",
          blocks: [{ type: "paragraph", content: [{ text: "Ready" }] }],
        },
      };
      const calls = [
        { ...status, route_id: routeId },
        { ...status, ...metadata },
        { ...push, slug: "notes/one" },
        { ...push, slug: "notes/two" },
        { ...push, slug: "outside/denied" },
      ];
      const environment = { ...process.env };
      for (const key of Object.keys(environment))
        if (/^(?:KNOT_|AAG_|ANYTYPE_|OPENCLAW_)/u.test(key)) delete environment[key];
      const { stdout } = await runProcess(
        process.execPath,
        [resolve("dist/cli.js"), "mcp", "--config", configPath],
        {
          env: environment,
          timeoutMs: 5_000,
          stdin:
            calls
              .map((args, index) =>
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: index + 1,
                  method: "tools/call",
                  params: { name: "aag_publish", arguments: args },
                }),
              )
              .join("\n") + "\n",
        },
      );
      const responses = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).result);
      expect(responses).toHaveLength(5);
      expect(responses[0].isError).toBe(true);
      expect(responses[4].isError).toBe(true);
      expect(
        responses.slice(1, 4).map((result) => JSON.parse(result.content[0].text).state),
      ).toEqual(["ready", "succeeded", "succeeded"]);
      expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "POST"]);
      expect(requests.every((request) => request.signed)).toBe(true);
      expect(requests.slice(1).map((request) => JSON.parse(request.body).slug)).toEqual([
        "notes/one",
        "notes/two",
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
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

import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnytypeClient, AnytypeHttpError } from "../src/anytype-client.js";
import { configSchema } from "../src/config.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("Anytype object REST client", () => {
  it("loads workflow definitions with native revision and editor fields", async () => {
    const calls: Array<{ method: string; path: string; body: string }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const url = new URL(request.url ?? "/", "http://localhost");
      calls.push({
        method: request.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.setHeader("content-type", "application/json");
      if (request.method === "POST")
        response.end(
          JSON.stringify({ data: [{ id: "workflow-1", type: { key: "knot-workflow" } }] }),
        );
      else
        response.end(
          JSON.stringify({
            object: {
              id: "workflow-1",
              name: "Daily digest",
              type: { key: "knot-workflow" },
              markdown: "```yaml\nkind: KnotWorkflow\n```",
              modified_at: 1_700_000_000,
              properties: [
                {
                  key: "last_modified_by",
                  format: "objects",
                  objects: ["participant-1"],
                },
              ],
              archived: false,
            },
          }),
        );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const dir = await mkdtemp(join(tmpdir(), "knot-workflow-search-"));
    const keyPath = join(dir, "key");
    await writeFile(keyPath, "secret-key\n");
    const client = await AnytypeClient.create(
      configSchema.parse({
        version: 1,
        agent: { name: "Knot", participantId: "bot" },
        anytype: { apiBase: `http://127.0.0.1:${address.port}`, apiKeyFile: keyPath },
        spaces: [{ id: "space" }],
        runtime: { kind: "codex" },
      }),
    );

    await expect(client.searchWorkflowObjects("space", ["knot-workflow"], 50, 25)).resolves.toEqual(
      [
        {
          id: "workflow-1",
          name: "Daily digest",
          typeKey: "knot-workflow",
          source: "```yaml\nkind: KnotWorkflow\n```",
          modifiedAt: 1_700_000_000_000,
          editorParticipantId: "participant-1",
          archived: false,
        },
      ],
    );
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/spaces/space/search?offset=50&limit=25",
        body: JSON.stringify({
          query: "",
          sort: { direction: "desc", property_key: "last_modified_date" },
          types: ["knot-workflow"],
        }),
      },
      {
        method: "GET",
        path: "/v1/spaces/space/objects/workflow-1",
        body: "",
      },
    ]);
  });

  it("caps workflow search hydration at the requested limit", async () => {
    const hydrated: string[] = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("content-type", "application/json");
      if (request.method === "POST") {
        response.end(
          JSON.stringify({
            data: ["one", "two", "three"].map((id) => ({
              id,
              type: { key: "knot-workflow" },
            })),
          }),
        );
        return;
      }
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      hydrated.push(id);
      response.end(
        JSON.stringify({
          object: {
            id,
            type: { key: "knot-workflow" },
            modified_at: 1_700_000_000,
          },
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const dir = await mkdtemp(join(tmpdir(), "knot-workflow-limit-"));
    const keyPath = join(dir, "key");
    await writeFile(keyPath, "secret-key\n");
    const client = await AnytypeClient.create(
      configSchema.parse({
        version: 1,
        agent: { name: "Knot", participantId: "bot" },
        anytype: { apiBase: `http://127.0.0.1:${address.port}`, apiKeyFile: keyPath },
        spaces: [{ id: "space" }],
        runtime: { kind: "codex" },
      }),
    );

    const workflows = await client.searchWorkflowObjects("space", ["knot-workflow"], 0, 1);

    expect(workflows.map((workflow) => workflow.id)).toEqual(["one"]);
    expect(hydrated).toEqual(["one"]);
  });

  it("rejects overlong workflow space IDs and drops overlong object IDs before hydration", async () => {
    const hostileId = "😀".repeat(400);
    const paths: string[] = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      paths.push(url.pathname);
      response.setHeader("content-type", "application/json");
      if (request.method === "POST") {
        response.end(JSON.stringify({ data: [{ id: hostileId, type: { key: "knot-workflow" } }] }));
        return;
      }
      response.end(JSON.stringify({ object: { id: "unexpected" } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const dir = await mkdtemp(join(tmpdir(), "knot-workflow-identifiers-"));
    const keyPath = join(dir, "key");
    await writeFile(keyPath, "secret-key\n");
    const client = await AnytypeClient.create(
      configSchema.parse({
        version: 1,
        agent: { name: "Knot", participantId: "bot" },
        anytype: { apiBase: `http://127.0.0.1:${address.port}`, apiKeyFile: keyPath },
        spaces: [{ id: "space" }],
        runtime: { kind: "codex" },
      }),
    );

    await expect(client.searchWorkflowObjects(hostileId, ["knot-workflow"], 0, 1)).rejects.toThrow(
      "workflow space ID is invalid",
    );
    expect(paths).toEqual([]);

    await expect(client.searchWorkflowObjects("space", ["knot-workflow"], 0, 1)).resolves.toEqual([
      {
        id: hostileId,
        name: [...hostileId].slice(0, 256).join(""),
        typeKey: "knot-workflow",
        modifiedAt: 0,
        archived: false,
        observationError: "object_identifier_invalid",
      },
    ]);
    expect(paths).toEqual(["/v1/spaces/space/search"]);
  });

  it("reports endpoint templates without leaking concrete Anytype IDs", () => {
    const error = new AnytypeHttpError(
      503,
      "GET",
      "/v1/spaces/private-space/objects/private-object?token=private-token",
    );

    expect(error.endpoint).toBe("/v1/spaces/:spaceId/objects/:objectId");
    expect(error.message).toContain("/v1/spaces/:spaceId/objects/:objectId");
    expect(error.message).not.toContain("private-space");
    expect(error.message).not.toContain("private-object");
    expect(error.message).not.toContain("private-token");
  });

  it("does not trust undocumented top-level editor aliases", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "POST") {
        response.end(
          JSON.stringify({ data: [{ id: "workflow-1", type: { key: "knot-workflow" } }] }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          object: {
            id: "workflow-1",
            name: "Unverified editor",
            type: { key: "knot-workflow" },
            markdown: "```yaml\nkind: KnotWorkflow\n```",
            modified_at: 1_700_000_000,
            last_modified_by: { participant_id: "participant-1" },
          },
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const dir = await mkdtemp(join(tmpdir(), "knot-workflow-editor-alias-"));
    const keyPath = join(dir, "key");
    await writeFile(keyPath, "secret-key\n");
    const client = await AnytypeClient.create(
      configSchema.parse({
        version: 1,
        agent: { name: "Knot", participantId: "bot" },
        anytype: { apiBase: `http://127.0.0.1:${address.port}`, apiKeyFile: keyPath },
        spaces: [{ id: "space" }],
        runtime: { kind: "codex" },
      }),
    );

    const [workflow] = await client.searchWorkflowObjects("space", ["knot-workflow"], 0, 25);

    expect(workflow).toMatchObject({ id: "workflow-1", name: "Unverified editor" });
    expect(workflow).not.toHaveProperty("editorParticipantId");
  });

  it("isolates oversized workflow object responses as invalid observations", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "POST") {
        response.end(
          JSON.stringify({ data: [{ id: "workflow-1", type: { key: "knot-workflow" } }] }),
        );
        return;
      }
      response.setHeader("content-length", String(2 * 1024 * 1024 + 1));
      response.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const dir = await mkdtemp(join(tmpdir(), "knot-workflow-object-limit-"));
    const keyPath = join(dir, "key");
    await writeFile(keyPath, "secret-key\n");
    const client = await AnytypeClient.create(
      configSchema.parse({
        version: 1,
        agent: { name: "Knot", participantId: "bot" },
        anytype: { apiBase: `http://127.0.0.1:${address.port}`, apiKeyFile: keyPath },
        spaces: [{ id: "space" }],
        runtime: { kind: "codex" },
      }),
    );

    await expect(client.searchWorkflowObjects("space", ["knot-workflow"], 0, 25)).resolves.toEqual([
      {
        id: "workflow-1",
        name: "workflow-1",
        typeKey: "knot-workflow",
        modifiedAt: 0,
        archived: false,
        observationError: "object_too_large",
      },
    ]);
  });

  it("rejects future workflow timestamps as missing native revisions", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "POST") {
        response.end(
          JSON.stringify({ data: [{ id: "workflow-1", type: { key: "knot-workflow" } }] }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          object: {
            id: "workflow-1",
            type: { key: "knot-workflow" },
            modified_at: Date.now() + 10 * 60 * 1_000,
          },
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const dir = await mkdtemp(join(tmpdir(), "knot-workflow-future-revision-"));
    const keyPath = join(dir, "key");
    await writeFile(keyPath, "secret-key\n");
    const client = await AnytypeClient.create(
      configSchema.parse({
        version: 1,
        agent: { name: "Knot", participantId: "bot" },
        anytype: { apiBase: `http://127.0.0.1:${address.port}`, apiKeyFile: keyPath },
        spaces: [{ id: "space" }],
        runtime: { kind: "codex" },
      }),
    );

    await expect(client.searchWorkflowObjects("space", ["knot-workflow"], 0, 25)).resolves.toEqual([
      {
        id: "workflow-1",
        name: "workflow-1",
        typeKey: "knot-workflow",
        modifiedAt: 0,
        archived: false,
        observationError: "native_revision_missing",
      },
    ]);
  });

  it("does not cap general object reads at the observer response limit", async () => {
    const body = "x".repeat(2 * 1024 * 1024 + 1);
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ object: { id: "large", markdown: body } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const dir = await mkdtemp(join(tmpdir(), "knot-general-object-read-"));
    const keyPath = join(dir, "key");
    await writeFile(keyPath, "secret-key\n");
    const client = await AnytypeClient.create(
      configSchema.parse({
        version: 1,
        agent: { name: "Knot", participantId: "bot" },
        anytype: { apiBase: `http://127.0.0.1:${address.port}`, apiKeyFile: keyPath },
        spaces: [{ id: "space" }],
        runtime: { kind: "codex" },
      }),
    );

    await expect(client.getObject("space", "large")).resolves.toMatchObject({
      id: "large",
      markdown: body,
    });
  });

  it("downloads file bytes without treating media as JSON", async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe("/v1/spaces/space/files/video%2Fid");
      response.setHeader("content-type", "video/mp4");
      response.end(Buffer.from([0, 1, 2, 255]));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const dir = await mkdtemp(join(tmpdir(), "aag-anytype-download-"));
    const keyPath = join(dir, "key");
    await writeFile(keyPath, "secret-key\n");
    const client = await AnytypeClient.create(
      configSchema.parse({
        version: 1,
        agent: { name: "AAG", participantId: "bot" },
        anytype: { apiBase: `http://127.0.0.1:${address.port}`, apiKeyFile: keyPath },
        spaces: [{ id: "space" }],
        runtime: { kind: "openclaw" },
      }),
    );

    const downloaded = await client.downloadFile("space", "video/id", 1024);

    expect([...downloaded.bytes]).toEqual([0, 1, 2, 255]);
    expect(downloaded.contentType).toBe("video/mp4");
  });

  it("rejects file downloads above the configured byte limit", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-length", "5");
      response.end("large");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const dir = await mkdtemp(join(tmpdir(), "aag-anytype-download-limit-"));
    const keyPath = join(dir, "key");
    await writeFile(keyPath, "secret-key\n");
    const client = await AnytypeClient.create(
      configSchema.parse({
        version: 1,
        agent: { name: "AAG", participantId: "bot" },
        anytype: { apiBase: `http://127.0.0.1:${address.port}`, apiKeyFile: keyPath },
        spaces: [{ id: "space" }],
        runtime: { kind: "openclaw" },
      }),
    );

    await expect(client.downloadFile("space", "video", 4)).rejects.toThrow(
      "exceeds the 4-byte download limit",
    );
  });

  it("sends and edits native chat attachments", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      calls.push({
        method: request.method ?? "GET",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      response.setHeader("content-type", "application/json");
      response.end(request.method === "POST" ? JSON.stringify({ message_id: "reply" }) : "{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const dir = await mkdtemp(join(tmpdir(), "aag-anytype-chat-"));
    const keyPath = join(dir, "key");
    await writeFile(keyPath, "secret-key\n");
    const client = await AnytypeClient.create(
      configSchema.parse({
        version: 1,
        agent: { name: "AAG", participantId: "bot" },
        anytype: { apiBase: `http://127.0.0.1:${address.port}`, apiKeyFile: keyPath },
        spaces: [{ id: "space" }],
        runtime: { kind: "openclaw" },
      }),
    );

    const attachments = [{ target: "object-id", type: "file" as const }];
    await expect(
      client.sendMessage("space", "chat", { text: "Object", attachments }),
    ).resolves.toBe("reply");
    await client.editMessage("space", "chat", "reply", "Updated", [], attachments);

    expect(calls).toEqual([
      {
        method: "POST",
        body: { text: "Object", style: "paragraph", attachments },
      },
      {
        method: "PATCH",
        body: { text: "Updated", style: "paragraph", marks: [], attachments },
      },
    ]);
  });

  it("advances pagination by the raw page length even when pages overlap", async () => {
    const offsets: string[] = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const offset = url.searchParams.get("offset") ?? "0";
      offsets.push(offset);
      const data =
        offset === "0"
          ? [{ id: "one" }, { id: "two" }]
          : offset === "2"
            ? [{ id: "two" }, { id: "three" }]
            : [];
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const dir = await mkdtemp(join(tmpdir(), "aag-anytype-pages-"));
    const keyPath = join(dir, "key");
    await writeFile(keyPath, "secret-key\n");
    const client = await AnytypeClient.create(
      configSchema.parse({
        version: 1,
        agent: { name: "AAG", participantId: "bot" },
        anytype: { apiBase: `http://127.0.0.1:${address.port}`, apiKeyFile: keyPath },
        spaces: [{ id: "space" }],
        runtime: { kind: "openclaw" },
      }),
    );

    await expect(client.listTypes("space")).resolves.toEqual([
      { id: "one" },
      { id: "two" },
      { id: "three" },
    ]);
    expect(offsets).toEqual(["0", "2", "4"]);
  });

  it("uses the documented object, list, search, archive, and upload contracts", async () => {
    const calls: Array<{
      method: string;
      path: string;
      body: string;
      contentType?: string;
      authorization?: string;
      version?: string;
    }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const url = new URL(request.url ?? "/", "http://localhost");
      calls.push({
        method: request.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        body: Buffer.concat(chunks).toString("utf8"),
        ...(request.headers["content-type"]
          ? { contentType: request.headers["content-type"] }
          : {}),
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(request.headers["anytype-version"]
          ? { version: String(request.headers["anytype-version"]) }
          : {}),
      });
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && url.pathname.endsWith("/search"))
        response.end(JSON.stringify({ data: [{ id: "found" }] }));
      else if (request.method === "POST" && url.pathname.endsWith("/objects"))
        response.end(JSON.stringify({ object: { id: "created" } }));
      else if (request.method === "GET" && url.pathname.endsWith("/objects/object"))
        response.end(
          JSON.stringify({
            object: { id: "object", type: { key: "page" }, properties: [{ key: "status" }] },
          }),
        );
      else if (request.method === "GET" && url.pathname.endsWith("/types/type-page"))
        response.end(
          JSON.stringify({
            type: { id: "type-page", key: "page", properties: [{ key: "status" }] },
          }),
        );
      else if (request.method === "GET" && url.pathname.endsWith("/properties/property-status"))
        response.end(
          JSON.stringify({ property: { id: "property-status", key: "status", format: "select" } }),
        );
      else if (
        request.method === "GET" &&
        url.pathname.endsWith("/properties/property-status/tags")
      )
        response.end(
          JSON.stringify({
            data: url.searchParams.get("offset") === "0" ? [{ id: "tag-open", name: "Open" }] : [],
          }),
        );
      else if (
        request.method === "POST" &&
        url.pathname.endsWith("/properties/property-status/tags")
      )
        response.end(
          JSON.stringify({ tag: { id: "tag-project", name: "klee:imai", color: "blue" } }),
        );
      else if (request.method === "GET" && url.pathname.endsWith("/types/type-page/templates"))
        response.end(
          JSON.stringify({
            data:
              url.searchParams.get("offset") === "0"
                ? [{ id: "template-daily", name: "Daily" }]
                : [],
          }),
        );
      else if (request.method === "GET" && url.pathname.endsWith("/types"))
        response.end(
          JSON.stringify({
            data: url.searchParams.get("offset") === "0" ? [{ id: "type-page", key: "page" }] : [],
          }),
        );
      else if (request.method === "GET" && url.pathname.endsWith("/properties"))
        response.end(
          JSON.stringify({
            data:
              url.searchParams.get("offset") === "0"
                ? [{ id: "property-status", key: "status", format: "select" }]
                : [],
          }),
        );
      else if (
        request.method === "GET" &&
        url.pathname.endsWith("/lists/list/views/view-board/objects")
      )
        response.end(
          JSON.stringify({
            data: url.searchParams.get("offset") === "0" ? [{ id: "task-1" }] : [],
          }),
        );
      else if (request.method === "GET" && url.pathname.endsWith("/lists/list/views"))
        response.end(
          JSON.stringify({
            data: url.searchParams.get("offset") === "0" ? [{ id: "view-board" }] : [],
          }),
        );
      else if (request.method === "PATCH")
        response.end(JSON.stringify({ object: { id: "object", name: "Updated" } }));
      else if (request.method === "DELETE" && url.pathname.endsWith("/objects/object"))
        response.end(JSON.stringify({ object: { id: "object", archived: true } }));
      else if (request.method === "DELETE" && url.pathname.endsWith("/lists/list/objects/task-1"))
        response.end("{}");
      else if (url.pathname.endsWith("/lists/list/objects")) response.end("{}");
      else if (url.pathname.endsWith("/files")) response.end(JSON.stringify({ object_id: "file" }));
      else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not_found" }));
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const dir = await mkdtemp(join(tmpdir(), "aag-anytype-client-"));
    const keyPath = join(dir, "key");
    const filePath = join(dir, "asset.txt");
    await writeFile(keyPath, "secret-key\n");
    await writeFile(filePath, "asset body");
    const config = configSchema.parse({
      version: 1,
      agent: { name: "AAG", participantId: "bot" },
      anytype: { apiBase: `http://127.0.0.1:${address.port}`, apiKeyFile: keyPath },
      spaces: [{ id: "space" }],
      runtime: { kind: "openclaw" },
    });
    const client = await AnytypeClient.create(config);

    await expect(
      client.searchSpace("space", { query: "roadmap", types: ["page"], limit: 5 }),
    ).resolves.toEqual([{ id: "found" }]);
    await expect(client.getObject("space", "object")).resolves.toMatchObject({
      type: { key: "page" },
      properties: [{ key: "status" }],
    });
    await expect(client.listTypes("space")).resolves.toEqual([{ id: "type-page", key: "page" }]);
    await expect(client.getType("space", "type-page")).resolves.toMatchObject({
      key: "page",
      properties: [{ key: "status" }],
    });
    await expect(client.listProperties("space")).resolves.toEqual([
      { id: "property-status", key: "status", format: "select" },
    ]);
    await expect(client.getProperty("space", "property-status")).resolves.toMatchObject({
      format: "select",
    });
    await expect(client.listPropertyTags("space", "property-status")).resolves.toEqual([
      { id: "tag-open", name: "Open" },
    ]);
    await expect(
      client.createPropertyTag("space", "property-status", { name: "klee:imai", color: "blue" }),
    ).resolves.toEqual({ id: "tag-project", name: "klee:imai", color: "blue" });
    await expect(client.listTemplates("space", "type-page")).resolves.toEqual([
      { id: "template-daily", name: "Daily" },
    ]);
    await expect(
      client.createObject("space", { type_key: "page", name: "Plan", body: "Body" }),
    ).resolves.toEqual({ id: "created" });
    await expect(
      client.updateObject("space", "object", { name: "Updated", markdown: "Text" }),
    ).resolves.toMatchObject({ id: "object", name: "Updated" });
    await expect(client.archiveObject("space", "object")).resolves.toMatchObject({
      archived: true,
    });
    await expect(client.addObjectsToList("space", "list", ["one", "two"])).resolves.toBeUndefined();
    await expect(client.listViews("space", "list")).resolves.toEqual([{ id: "view-board" }]);
    await expect(client.listViewObjects("space", "list", "view-board")).resolves.toEqual([
      { id: "task-1" },
    ]);
    await expect(client.removeObjectFromList("space", "list", "task-1")).resolves.toBeUndefined();
    await expect(client.uploadFile("space", filePath)).resolves.toEqual({ object_id: "file" });

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/v1/spaces/space/search?offset=0&limit=5"],
      ["GET", "/v1/spaces/space/objects/object"],
      ["GET", "/v1/spaces/space/types?offset=0&limit=100"],
      ["GET", "/v1/spaces/space/types?offset=1&limit=100"],
      ["GET", "/v1/spaces/space/types/type-page"],
      ["GET", "/v1/spaces/space/properties?offset=0&limit=100"],
      ["GET", "/v1/spaces/space/properties?offset=1&limit=100"],
      ["GET", "/v1/spaces/space/properties/property-status"],
      ["GET", "/v1/spaces/space/properties/property-status/tags?offset=0&limit=100"],
      ["GET", "/v1/spaces/space/properties/property-status/tags?offset=1&limit=100"],
      ["POST", "/v1/spaces/space/properties/property-status/tags"],
      ["GET", "/v1/spaces/space/types/type-page/templates?offset=0&limit=100"],
      ["GET", "/v1/spaces/space/types/type-page/templates?offset=1&limit=100"],
      ["POST", "/v1/spaces/space/objects"],
      ["PATCH", "/v1/spaces/space/objects/object"],
      ["DELETE", "/v1/spaces/space/objects/object"],
      ["POST", "/v1/spaces/space/lists/list/objects"],
      ["GET", "/v1/spaces/space/lists/list/views?offset=0&limit=100"],
      ["GET", "/v1/spaces/space/lists/list/views?offset=1&limit=100"],
      ["GET", "/v1/spaces/space/lists/list/views/view-board/objects?offset=0&limit=50"],
      ["DELETE", "/v1/spaces/space/lists/list/objects/task-1"],
      ["POST", "/v1/spaces/space/files"],
    ]);
    expect(JSON.parse(calls[0]!.body)).toEqual({
      query: "roadmap",
      types: ["page"],
    });
    expect(JSON.parse(calls[10]!.body)).toEqual({ name: "klee:imai", color: "blue" });
    expect(JSON.parse(calls[13]!.body)).toEqual({ type_key: "page", name: "Plan", body: "Body" });
    expect(JSON.parse(calls[14]!.body)).toEqual({ name: "Updated", markdown: "Text" });
    expect(JSON.parse(calls[16]!.body)).toEqual({ objects: ["one", "two"] });
    expect(calls[21]!.contentType).toMatch(/^multipart\/form-data; boundary=/u);
    expect(calls[21]!.body).toContain("asset body");
    expect(
      calls.every(
        (call) => call.authorization === "Bearer secret-key" && call.version === "2025-11-08",
      ),
    ).toBe(true);
  });
});

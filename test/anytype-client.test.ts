import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnytypeClient } from "../src/anytype-client.js";
import { configSchema } from "../src/config.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("Anytype object REST client", () => {
  it("uses the documented object, list, search, archive, and upload contracts", async () => {
    const calls: Array<{ method: string; path: string; body: string; contentType?: string; authorization?: string; version?: string }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const url = new URL(request.url ?? "/", "http://localhost");
      calls.push({
        method: request.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        body: Buffer.concat(chunks).toString("utf8"),
        ...(request.headers["content-type"] ? { contentType: request.headers["content-type"] } : {}),
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(request.headers["anytype-version"] ? { version: String(request.headers["anytype-version"]) } : {}),
      });
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && url.pathname.endsWith("/search")) response.end(JSON.stringify({ data: [{ id: "found" }] }));
      else if (request.method === "POST" && url.pathname.endsWith("/objects")) response.end(JSON.stringify({ object: { id: "created" } }));
      else if (request.method === "PATCH") response.end(JSON.stringify({ object: { id: "object", name: "Updated" } }));
      else if (request.method === "DELETE") response.end(JSON.stringify({ object: { id: "object", archived: true } }));
      else if (url.pathname.endsWith("/lists/list/objects")) response.end("{}");
      else if (url.pathname.endsWith("/files")) response.end(JSON.stringify({ object_id: "file" }));
      else { response.statusCode = 404; response.end(JSON.stringify({ error: "not_found" })); }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
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

    await expect(client.searchSpace("space", { query: "roadmap", types: ["page"], limit: 5 })).resolves.toEqual([{ id: "found" }]);
    await expect(client.createObject("space", { type_key: "page", name: "Plan", body: "Body" })).resolves.toEqual({ id: "created" });
    await expect(client.updateObject("space", "object", { name: "Updated", markdown: "Text" })).resolves.toMatchObject({ id: "object", name: "Updated" });
    await expect(client.archiveObject("space", "object")).resolves.toMatchObject({ archived: true });
    await expect(client.addObjectsToList("space", "list", ["one", "two"])).resolves.toBeUndefined();
    await expect(client.uploadFile("space", filePath)).resolves.toEqual({ object_id: "file" });

    expect(calls.map(call => [call.method, call.path])).toEqual([
      ["POST", "/v1/spaces/space/search?offset=0&limit=5"],
      ["POST", "/v1/spaces/space/objects"],
      ["PATCH", "/v1/spaces/space/objects/object"],
      ["DELETE", "/v1/spaces/space/objects/object"],
      ["POST", "/v1/spaces/space/lists/list/objects"],
      ["POST", "/v1/spaces/space/files"],
    ]);
    expect(JSON.parse(calls[0]!.body)).toEqual({ query: "roadmap", types: ["page"] });
    expect(JSON.parse(calls[1]!.body)).toEqual({ type_key: "page", name: "Plan", body: "Body" });
    expect(JSON.parse(calls[2]!.body)).toEqual({ name: "Updated", markdown: "Text" });
    expect(JSON.parse(calls[4]!.body)).toEqual({ objects: ["one", "two"] });
    expect(calls[5]!.contentType).toMatch(/^multipart\/form-data; boundary=/u);
    expect(calls[5]!.body).toContain("asset body");
    expect(calls.every(call => call.authorization === "Bearer secret-key" && call.version === "2025-11-08")).toBe(true);
  });
});

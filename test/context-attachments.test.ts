import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { buildContext, preparePrompt } from "../src/context.js";
import { renderCoordination } from "../src/projection.js";
import type { ConversationRef } from "../src/types.js";
import { FakeAnytype, incoming } from "./fakes.js";

describe("Anytype attachment context", () => {
  it("retains conflicting observed attribution so rendering can reject an ambiguous name", async () => {
    const anytype = new FakeAnytype();
    const config = configSchema.parse({
      version: 1,
      agent: { name: "Fixture", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ id: "space" }],
      runtime: { kind: "codex" },
    });
    const trigger = incoming({
      creator: "person-a",
      creator_name: "Alice",
      content: {
        text: "@Alice @Elsewhere",
        marks: [
          { type: "mention", param: "person-b", from: 0, to: 6 },
          { type: "mention", param: "person-b", from: 7, to: 17 },
        ],
      },
    });
    const bundle = await buildContext(
      anytype,
      config,
      {
        routeId: "chat:space:chat",
        kind: "chat",
        spaceId: "space",
        chatId: "chat",
      },
      trigger,
    );
    // Two labels for the same mark target must not erase evidence of the spoofed label.
    expect(bundle.mentionTargets).toHaveLength(3);
    expect(renderCoordination("@Alice", config, bundle.mentionTargets).marks).toEqual([]);
    expect(renderCoordination("@Elsewhere", config, bundle.mentionTargets).marks).toHaveLength(1);
  });

  it("materializes the current media attachment and gives Codex its local path", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "aag-attachment-context-"));
    const anytype = new (class extends FakeAnytype {
      async downloadFile(): Promise<{ bytes: Uint8Array; contentType: string }> {
        return {
          bytes: Uint8Array.from([0, 1, 2, 3]),
          contentType: "video/mp4",
        };
      }
    })();
    const config = configSchema.parse({
      version: 1,
      agent: { name: "Klee", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ id: "space" }],
      runtime: { kind: "codex", defaultProject: workspace },
      context: { promptMode: "workspace" },
      state: {
        path: join(workspace, "..", `${workspace.split("/").at(-1)}-state`, "state.sqlite"),
      },
    });
    const conversation: ConversationRef = {
      routeId: "chat:space:chat",
      kind: "chat",
      spaceId: "space",
      spaceName: "Space",
      chatId: "chat",
      selfParticipantId: "bot",
    };
    const trigger = incoming({
      id: "message-with-video",
      content: { text: "Make this square and convert it to a GIF." },
      attachments: [{ target: "video-object", type: "file" }],
    });

    const bundle = await buildContext(anytype, config, conversation, trigger);
    const prompt = await preparePrompt(bundle, config, "chat:space:chat", undefined, {
      bootstrapWorkspace: false,
    });

    const attachment = bundle.attachments?.[0];
    expect(attachment?.contentType).toBe("video/mp4");
    expect(attachment?.localPath).toMatch(/\.aag\/attachments\/.+\.mp4$/);
    await expect(stat(attachment!.localPath!)).resolves.toMatchObject({ size: 4 });
    expect(prompt).toContain("Make this square and convert it to a GIF.");
    expect(prompt).toContain("Attached media available locally:");
    expect(prompt).toContain(attachment!.localPath!);

    const contextPath = join(workspace, ".aag", "context");
    const contextFiles = await import("node:fs/promises").then(({ readdir }) =>
      readdir(contextPath),
    );
    const context = JSON.parse(await readFile(join(contextPath, contextFiles[0]!), "utf8")) as {
      attachments: Array<{ localPath?: string }>;
    };
    expect(context.attachments[0]?.localPath).toBe(attachment!.localPath);
  });

  it("materializes media embedded in a referenced Anytype object", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "aag-object-media-context-"));
    const downloads: string[] = [];
    const anytype = new (class extends FakeAnytype {
      override async getObject(): Promise<{
        id: string;
        name: string;
        properties: Array<{ key: string; files: string[] }>;
      }> {
        return {
          id: "note-with-image",
          name: "Visual note",
          properties: [
            {
              key: "files",
              files: ["http://127.0.0.1/v1/spaces/space/files/embedded-image"],
            },
          ],
        };
      }
      async downloadFile(
        _spaceId: string,
        fileId: string,
      ): Promise<{ bytes: Uint8Array; contentType: string }> {
        downloads.push(fileId);
        return { bytes: Uint8Array.from([1, 2, 3]), contentType: "image/png" };
      }
    })();
    const config = configSchema.parse({
      version: 1,
      agent: { name: "Klee", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ id: "space" }],
      runtime: { kind: "codex", defaultProject: workspace },
      context: { promptMode: "workspace" },
      state: {
        path: join(workspace, "..", `${workspace.split("/").at(-1)}-state`, "state.sqlite"),
      },
    });
    const conversation: ConversationRef = {
      routeId: "chat:space:chat",
      kind: "chat",
      spaceId: "space",
      chatId: "chat",
      selfParticipantId: "bot",
    };
    const trigger = incoming({
      id: "message-with-object",
      content: {
        text: "What is in this note?",
        marks: [{ type: "object", param: "note-with-image" }],
      },
    });

    const bundle = await buildContext(anytype, config, conversation, trigger);
    const prompt = await preparePrompt(bundle, config, "chat:space:chat", undefined, {
      bootstrapWorkspace: false,
    });

    expect(downloads).toEqual(["embedded-image"]);
    expect(bundle.attachments?.[0]).toMatchObject({
      sourceObjectId: "note-with-image",
      contentType: "image/png",
    });
    expect(prompt).toContain("Referenced object media available locally:");
    expect(prompt).toContain(bundle.attachments?.[0]?.localPath);
  });
});

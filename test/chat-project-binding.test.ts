import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { AgentController } from "../src/controller.js";
import { Store } from "../src/store.js";
import type { ConversationRef } from "../src/types.js";
import { FakeAnytype, FakeRuntime, incoming } from "./fakes.js";

const conversation: ConversationRef = {
  routeId: "chat:space:chat",
  spaceId: "space",
  chatId: "chat",
  kind: "chat",
};
const wake = {
  humans: "mention-or-reply" as const,
  agents: "never" as const,
  allowedUsers: ["*"],
};

function setup(tags: string[]) {
  const anytype = new FakeAnytype();
  anytype.propertyTags = tags.map((name, index) => ({ id: `tag-${index}`, name }));
  anytype.objects.set("chat", {
    properties: [
      {
        id: "property-tag",
        key: "tag",
        format: "multi_select",
        multi_select: anytype.propertyTags,
      },
    ],
  });
  const runtime = new FakeRuntime();
  const store = new Store(":memory:");
  const config = configSchema.parse({
    version: 1,
    agent: { name: "Klee", participantId: "bot" },
    anytype: { apiKeyFile: "/tmp/key" },
    spaces: [{ name: "Test" }],
    runtime: {
      kind: "codex",
      defaultProject: "/projects/klee",
      allowedProjects: ["/projects/imai", "/projects/other"],
    },
    management: { allowProjectChanges: true, projectAdmins: ["human-1"] },
  });
  const controller = new AgentController(anytype, runtime, config, store, () => undefined);
  return { anytype, runtime, store, controller, config };
}

describe("Anytype chat Codex project tags", () => {
  it("binds /new to the project named by this agent's tag", async () => {
    const { anytype, runtime, store, controller } = setup(["KLEE:imai", "anya:other"]);
    const message = incoming({ id: "new", mentioned: true, content: { text: "/new" } });
    anytype.messages.push(message);

    await controller.process(conversation, wake, message);

    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0]?.workspacePath).toBe("/projects/imai");
    expect(store.sessionWorkspace(conversation.routeId)).toBe("/projects/imai");
    expect(store.sessionWorkspaceSource(conversation.routeId)).toBe("chat-tag");
    runtime.finish({ text: "Started" });
    await controller.stop();
  });

  it("resolves string tag references through the Anytype tag catalog", async () => {
    const { anytype, runtime, controller } = setup(["klee:imai"]);
    anytype.objects.set("chat", {
      properties: [
        {
          id: "property-tag",
          key: "tag",
          format: "multi_select",
          multi_select: ["tag-0"],
        },
      ],
    });
    const message = incoming({ id: "new", mentioned: true, content: { text: "/new" } });
    anytype.messages.push(message);

    await controller.process(conversation, wake, message);

    expect(runtime.starts[0]?.workspacePath).toBe("/projects/imai");
    runtime.finish({ text: "Started" });
    await controller.stop();
  });

  it("blocks /new when the tagged project does not exist", async () => {
    const { anytype, runtime, store, controller } = setup(["klee:missing"]);
    const message = incoming({ id: "new", mentioned: true, content: { text: "/new" } });
    anytype.messages.push(message);

    await controller.process(conversation, wake, message);

    expect(runtime.starts).toHaveLength(0);
    expect(anytype.messages.at(-1)?.content?.text).toContain(
      'No configured Codex project named "missing" exists for Klee.',
    );
    expect(store.sessionGeneration(conversation.routeId)).toBe(0);
    await controller.stop();
  });

  it("blocks ambiguous tags for the same agent", async () => {
    const { anytype, runtime, store, controller } = setup(["klee:imai", "Klee:other"]);
    const message = incoming({ id: "new", mentioned: true, content: { text: "/new" } });
    anytype.messages.push(message);

    await controller.process(conversation, wake, message);

    expect(runtime.starts).toHaveLength(0);
    expect(anytype.messages.at(-1)?.content?.text).toContain("multiple Klee:project tags");
    expect(store.sessionGeneration(conversation.routeId)).toBe(0);
    await controller.stop();
  });

  it("applies the activation circuit breaker before validating /new tags", async () => {
    const { anytype, runtime, store, controller, config } = setup(["klee:imai"]);
    for (let index = 0; index < config.coordination.maxActivationsPerThread; index += 1)
      store.recordControlActivation(conversation.routeId, conversation.routeId);
    const message = incoming({ id: "new", mentioned: true, content: { text: "/new" } });
    anytype.messages.push(message);

    await controller.process(conversation, wake, message);

    expect(runtime.starts).toHaveLength(0);
    expect(store.sessionWorkspace(conversation.routeId)).toBeUndefined();
    await controller.stop();
  });

  it("ignores project tags belonging to a different agent", async () => {
    const { anytype, runtime, controller } = setup(["anya:imai"]);
    const message = incoming({ id: "new", mentioned: true, content: { text: "/new" } });
    anytype.messages.push(message);

    await controller.process(conversation, wake, message);

    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0]?.workspacePath).toBeUndefined();
    runtime.finish({ text: "Started" });
    await controller.stop();
  });

  it("returns to the runtime default after a project tag is removed", async () => {
    const { anytype, runtime, store, controller } = setup(["klee:imai"]);
    const first = incoming({ id: "new-1", mentioned: true, content: { text: "/new" } });
    anytype.messages.push(first);
    await controller.process(conversation, wake, first);
    runtime.finish({ text: "Started" });
    expect(store.sessionWorkspace(conversation.routeId)).toBe("/projects/imai");

    anytype.objects.set("chat", { properties: [] });
    const second = incoming({ id: "new-2", mentioned: true, content: { text: "/new" } });
    anytype.messages.push(second);
    await controller.process(conversation, wake, second);

    expect(runtime.starts.at(-1)?.workspacePath).toBeUndefined();
    expect(store.sessionWorkspace(conversation.routeId)).toBeUndefined();
    runtime.finish({ text: "Started" });
    await controller.stop();
  });

  it("restores an explicit bound-chat workspace after its tag override is removed", async () => {
    const { anytype, runtime, store, controller } = setup(["klee:imai"]);
    store.saveSessionBinding({
      threadKey: conversation.routeId,
      routeId: conversation.routeId,
      spaceId: conversation.spaceId,
      chatId: conversation.chatId,
      runtime: "codex-acp",
      nativeSessionKey: "bound-session",
      generation: 0,
      state: "active",
    });
    store.saveSessionWorkspace(conversation.routeId, "/projects/other");
    const first = incoming({ id: "new-1", mentioned: true, content: { text: "/new" } });
    anytype.messages.push(first);
    await controller.process(conversation, wake, first);
    expect(runtime.starts.at(-1)?.workspacePath).toBe("/projects/imai");
    expect(store.explicitSessionWorkspace(conversation.routeId)).toBe("/projects/other");
    runtime.finish({ text: "Started" });

    anytype.objects.set("chat", { properties: [] });
    const second = incoming({ id: "new-2", mentioned: true, content: { text: "/new" } });
    anytype.messages.push(second);
    await controller.process(conversation, wake, second);

    expect(runtime.starts.at(-1)?.workspacePath).toBe("/projects/other");
    expect(store.sessionWorkspaceSource(conversation.routeId)).toBe("explicit");
    runtime.finish({ text: "Started" });
    await controller.stop();
  });

  it("lists projects and writes the selected project to the Chat tag", async () => {
    const { anytype, runtime, controller } = setup(["ordinary", "anya:other"]);
    const list = incoming({ id: "projects", mentioned: true, content: { text: "/projects" } });
    anytype.messages.push(list);
    await controller.process(conversation, wake, list);
    expect(anytype.messages.at(-1)?.content?.text).toContain("1. klee");
    expect(anytype.messages.at(-1)?.content?.text).toContain("2. imai");

    const select = incoming({ id: "project", mentioned: true, content: { text: "/project imai" } });
    anytype.messages.push(select);
    await controller.process(conversation, wake, select);
    const tags = (
      (
        anytype.objects.get("chat")?.properties as Array<{ multi_select: Array<{ name: string }> }>
      )[0]?.multi_select ?? []
    ).map((tag) => tag.name);
    expect(tags).toEqual(["ordinary", "anya:other", "klee:imai"]);
    expect(anytype.messages.at(-1)?.content?.text).toContain("Project tag set to klee:imai");

    const reset = incoming({
      id: "reset-project",
      mentioned: true,
      content: { text: "/project default" },
    });
    anytype.messages.push(reset);
    await controller.process(conversation, wake, reset);
    const resetTags = (
      (
        anytype.objects.get("chat")?.properties as Array<{ multi_select: Array<{ name: string }> }>
      )[0]?.multi_select ?? []
    ).map((tag) => tag.name);
    expect(resetTags).toEqual(["ordinary", "anya:other"]);
    expect(runtime.starts).toHaveLength(0);
    await controller.stop();
  });

  it("retries a project-tag update when a concurrent writer removes its result", async () => {
    const { anytype, controller } = setup(["ordinary", "anya:other"]);
    const updateObject = anytype.updateObject.bind(anytype);
    let calls = 0;
    anytype.updateObject = async (...args) => {
      calls += 1;
      const result = await updateObject(...args);
      if (calls === 1) {
        anytype.objects.set("chat", {
          properties: [
            {
              id: "property-tag",
              key: "tag",
              format: "multi_select",
              multi_select: anytype.propertyTags.filter((tag) => tag.name !== "klee:imai"),
            },
          ],
        });
      }
      return result;
    };
    const select = incoming({ id: "project", mentioned: true, content: { text: "/project imai" } });
    anytype.messages.push(select);

    await controller.process(conversation, wake, select);

    expect(calls).toBe(2);
    const tags = (
      (
        anytype.objects.get("chat")?.properties as Array<{ multi_select: Array<{ name: string }> }>
      )[0]?.multi_select ?? []
    ).map((tag) => tag.name);
    expect(tags).toEqual(["ordinary", "anya:other", "klee:imai"]);
    await controller.stop();
  });

  it("does not alter the Chat tag for an unknown project or unauthorized sender", async () => {
    const { anytype, runtime, controller } = setup(["ordinary"]);
    const unknown = incoming({
      id: "unknown",
      mentioned: true,
      content: { text: "/project missing" },
    });
    anytype.messages.push(unknown);
    await controller.process(conversation, wake, unknown);
    expect(anytype.messages.at(-1)?.content?.text).toContain("Project must match one configured");

    const denied = incoming({
      id: "denied",
      creator: "human-2",
      mentioned: true,
      content: { text: "/project imai" },
    });
    anytype.messages.push(denied);
    await controller.process(conversation, wake, denied);
    expect(anytype.messages.at(-1)?.content?.text).toBe(
      "You are not allowed to inspect or change this agent's Codex project.",
    );
    expect(anytype.propertyTags.map((tag) => tag.name)).toEqual(["ordinary"]);
    expect(runtime.starts).toHaveLength(0);
    await controller.stop();
  });
});

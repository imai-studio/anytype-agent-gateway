import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("session persistence", () => {
  it("upgrades a legacy database without losing existing state", () => {
    const path = temporaryDatabase();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE cursors (route_id TEXT PRIMARY KEY, newest_order_id TEXT, initialized_at INTEGER NOT NULL);
      INSERT INTO cursors VALUES ('route','order-7',1);
      CREATE TABLE handled_messages (route_id TEXT NOT NULL, message_id TEXT NOT NULL, handled_at INTEGER NOT NULL, PRIMARY KEY (route_id, message_id));
      CREATE TABLE handled_message_versions (route_id TEXT NOT NULL, message_id TEXT NOT NULL, modified_at INTEGER NOT NULL, PRIMARY KEY (route_id, message_id));
    `);
    legacy.close();

    const store = new Store(path);
    expect(store.schemaVersion()).toBe(18);
    expect(store.cursor("route")).toBe("order-7");
    expect(
      (
        store.db.prepare("PRAGMA table_info(handled_message_versions)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    ).toContain("fingerprint");
    expect(
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_bindings'")
        .get(),
    ).toBeDefined();
    store.close();
  });

  it("upgrades the released v4 model table with generation tracking", () => {
    const directory = mkdtempSync(join(tmpdir(), "aag-store-v4-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE conversation_models (
        thread_key TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        requested_model_id TEXT,
        use_default INTEGER NOT NULL DEFAULT 0,
        applied_model_id TEXT,
        default_model_id TEXT,
        catalog_json TEXT NOT NULL DEFAULT '[]',
        updated_by TEXT,
        updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = 4;
    `);
    legacy.close();

    const store = new Store(path);
    expect(store.schemaVersion()).toBe(18);
    expect(
      (
        store.db.prepare("PRAGMA table_info(conversation_models)").all() as Array<{ name: string }>
      ).map((column) => column.name),
    ).toContain("applied_generation");
    expect(
      store.db.prepare("SELECT name FROM sqlite_master WHERE name='control_activations'").get(),
    ).toBeTruthy();
    store.close();
  });

  it("preserves explicit session workspaces when upgrading the released v5 schema", () => {
    const path = temporaryDatabase();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE session_bindings (
        thread_key TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        discussion_root_id TEXT,
        runtime TEXT NOT NULL,
        native_session_key TEXT NOT NULL,
        native_session_id TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        event_cursor TEXT,
        state TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_workspaces (
        thread_key TEXT PRIMARY KEY REFERENCES session_bindings(thread_key) ON DELETE CASCADE,
        workspace_path TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO session_bindings VALUES (
        'chat:space:chat','chat:space:chat','space','chat',NULL,'codex-acp','native',NULL,0,NULL,'active',1,1
      );
      INSERT INTO session_workspaces VALUES ('chat:space:chat','/projects/imai',2);
      PRAGMA user_version = 5;
    `);
    legacy.close();

    const store = new Store(path);
    expect(store.schemaVersion()).toBe(18);
    expect(store.sessionWorkspace("chat:space:chat")).toBe("/projects/imai");
    expect(store.sessionWorkspaceSource("chat:space:chat")).toBe("explicit");
    expect(store.db.prepare("PRAGMA foreign_key_list(session_workspaces)").all()).not.toHaveLength(
      0,
    );
    store.deleteSessionBinding("chat:space:chat");
    expect(store.sessionWorkspace("chat:space:chat")).toBeUndefined();
    store.close();
  });

  it("maps an Anytype thread to exactly one native session and persists capabilities", () => {
    const store = new Store(":memory:");
    const binding = store.saveSessionBinding(
      {
        threadKey: "discussion:root",
        routeId: "discussion:space:chat",
        spaceId: "space",
        chatId: "chat",
        discussionRootId: "root",
        runtime: "openclaw",
        nativeSessionKey: "agent:anya:anytype:channel:space/chat:thread:root",
        nativeSessionId: "native-1",
        generation: 0,
        eventCursor: "event-1",
        state: "active",
      },
      10,
    );

    expect(binding.createdAt).toBe(10);
    expect(store.bindingForNativeSession("openclaw", { id: "native-1" })?.threadKey).toBe(
      "discussion:root",
    );
    expect(
      store.bindingForNativeSession("openclaw", { key: binding.nativeSessionKey })?.routeId,
    ).toBe(binding.routeId);

    const reset = store.updateSessionBinding(
      binding.threadKey,
      {
        nativeSessionId: "native-2",
        generation: 1,
        eventCursor: null,
        state: "resetting",
      },
      20,
    );
    expect(reset).toMatchObject({
      nativeSessionId: "native-2",
      generation: 1,
      state: "resetting",
      updatedAt: 20,
    });
    expect(reset).not.toHaveProperty("eventCursor");
    expect(reset?.createdAt).toBe(10);

    store.saveRuntimeCapabilities("openclaw", {
      nativeScheduling: true,
      sessionEvents: true,
      protocol: "channel-v1",
    });
    expect(store.runtimeCapabilities("openclaw")).toEqual({
      nativeScheduling: true,
      sessionEvents: true,
      protocol: "channel-v1",
    });
    store.close();
  });

  it("binds management capabilities to one route, actor, scope, and finite use budget", () => {
    const store = new Store(":memory:");
    for (const scope of ["wake", "access", "model", "publish"] as const) {
      const wrongRoute = store.issueManagementCapability(
        "chat:space:chat",
        "participant-admin",
        scope,
      );
      expect(
        store.consumeManagementCapability(wrongRoute, "chat:space:other", scope),
      ).toBeUndefined();
      expect(store.consumeManagementCapability(wrongRoute, "chat:space:chat", scope)).toBe(
        "participant-admin",
      );

      const valid = store.issueManagementCapability("chat:space:chat", "participant-admin", scope);
      expect(store.consumeManagementCapability(valid, "chat:space:chat", scope)).toBe(
        "participant-admin",
      );
      if (scope === "publish")
        for (let i = 1; i < 16; i++)
          expect(store.consumeManagementCapability(valid, "chat:space:chat", scope)).toBe(
            "participant-admin",
          );
      expect(store.consumeManagementCapability(valid, "chat:space:chat", scope)).toBeUndefined();
    }
    store.close();
  });

  it("upgrades schema 13 capability constraints before issuing publish authority", () => {
    const path = temporaryDatabase();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE management_actor_capabilities (
        token_hash TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('wake','access','model')),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_management_actor_capabilities_route
        ON management_actor_capabilities(route_id,expires_at);
      CREATE TABLE workflow_deliveries (
        delivery_id TEXT PRIMARY KEY
      );
      CREATE TABLE workflow_steps (
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        PRIMARY KEY(run_id,step_id)
      );
      PRAGMA user_version=13;
    `);
    legacy.close();

    const store = new Store(path);
    expect(store.schemaVersion()).toBe(18);
    const token = store.issueManagementCapability("chat:space:chat", "owner", "publish");
    expect(store.consumeManagementCapability(token, "chat:space:chat", "publish")).toBe("owner");
    store.close();
  });

  it("expires pre-upgrade capabilities without changing durable session state", () => {
    const directory = mkdtempSync(join(tmpdir(), "knot-capability-v17-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    const previous = new Store(path);
    const token = previous.issueManagementCapability("discussion:space:chat", "owner", "publish");
    previous.initialize("chat:space:chat", "existing-cursor");
    previous.db.exec(`DROP INDEX idx_management_actor_capabilities_thread;
      ALTER TABLE management_actor_capabilities DROP COLUMN thread_key;
      ALTER TABLE management_actor_capabilities DROP COLUMN uses_remaining;
      PRAGMA user_version=17;`);
    previous.close();
    const upgraded = new Store(path, () => {});
    try {
      expect(
        upgraded.consumeManagementCapability(token, "discussion:space:chat", "publish"),
      ).toBeUndefined();
      expect(upgraded.cursor("chat:space:chat")).toBe("existing-cursor");
      expect(upgraded.migrationBackupPath).toBeDefined();
    } finally {
      upgraded.close();
    }
  });

  it("invalidates unused management capabilities when the route receives a new turn", () => {
    const store = new Store(":memory:");
    const old = store.issueManagementCapability("chat:space:chat", "participant-admin", "wake");
    store.revokeManagementCapabilities("chat:space:chat");
    expect(store.consumeManagementCapability(old, "chat:space:chat", "wake")).toBeUndefined();
    store.close();
  });

  it("persists an independent model preference and catalog for each conversation", () => {
    const store = new Store(":memory:");
    store.saveConversationModel(
      {
        threadKey: "chat:one",
        runtime: "codex-acp",
        requestedModelId: "gpt-5.6-sol",
        appliedModelId: "gpt-5.6-sol",
        defaultModelId: "gpt-5.6-terra",
        catalog: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
        updatedBy: "raj",
      },
      42,
    );
    expect(store.conversationModel("chat:one")).toEqual({
      threadKey: "chat:one",
      runtime: "codex-acp",
      requestedModelId: "gpt-5.6-sol",
      appliedModelId: "gpt-5.6-sol",
      defaultModelId: "gpt-5.6-terra",
      catalog: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
      updatedBy: "raj",
      updatedAt: 42,
    });
    store.close();
  });

  it("persists a pending reset to the harness default model", () => {
    const store = new Store(":memory:");
    store.saveConversationModel({
      threadKey: "chat:reset",
      runtime: "openclaw",
      useDefault: true,
      appliedModelId: "provider/custom",
      catalog: [],
    });
    expect(store.conversationModel("chat:reset")).toMatchObject({ useDefault: true });
    expect(store.conversationModel("chat:reset")).not.toHaveProperty("requestedModelId");
    store.close();
  });

  it("keeps one open output cycle per thread and advances its durable sequence", () => {
    const store = boundStore();
    const first = store.createOutputCycle(
      {
        id: "cycle-1",
        threadKey: "thread",
        anytypeMessageId: "message-1",
        replyToMessageId: "trigger",
        phase: "thinking",
      },
      10,
    );
    expect(first.sequence).toBe(1);
    expect(() =>
      store.createOutputCycle({
        id: "cycle-conflict",
        threadKey: "thread",
        anytypeMessageId: "message-conflict",
      }),
    ).toThrow();

    expect(
      store.updateOutputCycle(
        "cycle-1",
        {
          thinkingText: "Considering",
          answerText: "Done",
          phase: "answer",
          eventCursor: "cursor-2",
        },
        20,
      ),
    ).toMatchObject({
      thinkingText: "Considering",
      answerText: "Done",
      phase: "answer",
      eventCursor: "cursor-2",
    });
    expect(store.finishOutputCycle("cycle-1", "complete", 30)).toMatchObject({
      state: "complete",
      completedAt: 30,
    });

    const second = store.createOutputCycle(
      { id: "cycle-2", threadKey: "thread", anytypeMessageId: "message-2" },
      40,
    );
    expect(second.sequence).toBe(2);
    expect(store.listOutputCycles("thread").map((cycle) => cycle.id)).toEqual([
      "cycle-1",
      "cycle-2",
    ]);
    store.close();
  });
});

describe("durable outbound delivery", () => {
  it("deduplicates enqueue, leases work, retries failures, and acknowledges delivery", () => {
    const store = boundStore();
    const first = store.enqueueOutbound(
      {
        id: "out-1",
        threadKey: "thread",
        routeId: "route",
        spaceId: "space",
        chatId: "chat",
        operation: "edit",
        targetMessageId: "message-1",
        payload: { text: "hello" },
        dedupeKey: "cycle-1:answer:1",
      },
      100,
    );
    const duplicate = store.enqueueOutbound(
      {
        id: "out-duplicate",
        threadKey: "thread",
        routeId: "route",
        spaceId: "space",
        chatId: "chat",
        operation: "edit",
        payload: { text: "ignored" },
        dedupeKey: "cycle-1:answer:1",
      },
      101,
    );
    expect(duplicate.id).toBe(first.id);

    const [claimed] = store.claimOutbound("worker-a", { now: 110, leaseMs: 20 });
    expect(claimed).toMatchObject({
      id: "out-1",
      status: "claimed",
      claimedBy: "worker-a",
      attempts: 1,
      payload: { text: "hello" },
    });
    expect(
      store.failOutbound("out-1", "temporary", { workerId: "worker-a", retryAt: 200, now: 120 }),
    ).toBe(true);
    expect(store.claimOutbound("worker-b", { now: 199 })).toEqual([]);

    expect(store.claimOutbound("worker-b", { now: 200 })[0]).toMatchObject({
      id: "out-1",
      attempts: 2,
      claimedBy: "worker-b",
    });
    expect(store.acknowledgeOutbound("out-1", "worker-a", 210)).toBe(false);
    expect(store.acknowledgeOutbound("out-1", "worker-b", 210)).toBe(true);
    expect(store.outbound("out-1")).toMatchObject({ status: "delivered", deliveredAt: 210 });
    store.close();
  });

  it("reclaims expired leases and records proactive delivery and bridge cursors idempotently", () => {
    const store = boundStore();
    store.enqueueOutbound(
      {
        id: "out-lease",
        threadKey: "thread",
        routeId: "route",
        spaceId: "space",
        chatId: "chat",
        operation: "create",
        dedupeKey: "event-1",
      },
      100,
    );
    expect(store.claimOutbound("worker-a", { now: 100, leaseMs: 10 })).toHaveLength(1);
    expect(store.claimOutbound("worker-b", { now: 109, leaseMs: 10 })).toEqual([]);
    expect(store.claimOutbound("worker-b", { now: 110, leaseMs: 10 })[0]).toMatchObject({
      claimedBy: "worker-b",
      attempts: 2,
      lastError: "Delivery lease expired before acknowledgement",
    });

    const delivery = {
      runtime: "openclaw" as const,
      nativeSessionKey: "native",
      nativeEventId: "event-1",
      threadKey: "thread",
      payloadHash: "sha256:value",
      messageId: "message-1",
    };
    expect(store.markProactiveDelivered(delivery, 300)).toBe(true);
    expect(store.markProactiveDelivered(delivery, 301)).toBe(false);
    expect(store.isProactiveDelivered("openclaw", "native", "event-1")).toBe(true);
    expect(store.isResponse("message-1")).toBe(true);

    expect(store.bridgeCursor("openclaw", "native")).toBeUndefined();
    store.saveBridgeCursor("openclaw", "native", "cursor-1", 400);
    store.saveBridgeCursor("openclaw", "native", "cursor-2", 401);
    expect(store.bridgeCursor("openclaw", "native")).toBe("cursor-2");
    store.close();
  });

  it("keeps retrying outages by default and preserves explicitly dead items for operators", () => {
    const store = boundStore();
    store.enqueueOutbound(
      {
        id: "out-long-outage",
        threadKey: "thread",
        routeId: "route",
        spaceId: "space",
        chatId: "chat",
        operation: "create",
        dedupeKey: "long-outage",
      },
      0,
    );
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      expect(store.claimOutbound("worker", { now: attempt })[0]?.attempts).toBe(attempt);
      expect(
        store.failOutbound("out-long-outage", "still unavailable", {
          workerId: "worker",
          retryAt: attempt,
          now: attempt,
        }),
      ).toBe(true);
    }
    expect(store.outbound("out-long-outage")).toMatchObject({
      status: "failed",
      attempts: 12,
      lastError: "still unavailable",
    });
    expect(store.outboundStatusCounts().failed).toBe(1);

    expect(store.claimOutbound("worker", { now: 13 })[0]?.attempts).toBe(13);
    expect(
      store.failOutbound("out-long-outage", "operator intervention required", {
        workerId: "worker",
        maxAttempts: 13,
        now: 13,
      }),
    ).toBe(true);
    expect(store.outbound("out-long-outage")?.status).toBe("dead");
    store.prune(Number.MAX_SAFE_INTEGER);
    expect(store.outbound("out-long-outage")?.status).toBe("dead");
    store.close();
  });
});

function boundStore(): Store {
  const store = new Store(":memory:");
  store.saveSessionBinding({
    threadKey: "thread",
    routeId: "route",
    spaceId: "space",
    chatId: "chat",
    runtime: "openclaw",
    nativeSessionKey: "native",
    generation: 0,
    state: "active",
  });
  return store;
}

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "aag-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite");
}

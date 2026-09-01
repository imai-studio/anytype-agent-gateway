import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowObserver } from "../src/automation/observer.js";
import type { WorkflowObserverState } from "../src/automation/store-types.js";
import { workflowSourceDigest } from "../src/automation/workflow.js";
import { configSchema } from "../src/config.js";
import { Store } from "../src/store.js";
import type { AnytypeWorkflowObject } from "../src/types.js";
import { FakeAnytype } from "./fakes.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function automationConfig(pageSize = 100) {
  return configSchema.parse({
    version: 1,
    agent: { name: "Knot", participantId: "agent" },
    anytype: { apiKeyFile: "/tmp/key" },
    spaces: [{ id: "space-1" }],
    runtime: { kind: "codex" },
    automation: {
      enabled: true,
      observation: true,
      execution: false,
      definitionTypeKeys: ["knot-workflow"],
      polling: { minimumIntervalSeconds: 10, maximumIntervalSeconds: 40, pageSize },
      allowedAuthorIds: ["operator"],
      allowedSpaceIds: ["space-1"],
      allowedCapabilities: ["anytype.read"],
      maximumRiskTier: "T0",
    },
  }).automation;
}

function source(name: string, enabled = false, objectId = "target-1"): string {
  return `# ${name}

\`\`\`yaml
apiVersion: knot.imai.studio/v1alpha1
kind: KnotWorkflow
metadata:
  name: ${name}
spec:
  enabled: ${enabled}
  triggers:
    - kind: manual
  steps:
    - id: read
      kind: anytype.read
      config:
        objectId: ${objectId}
  capabilities:
    - anytype.read
\`\`\`
`;
}

function workflowObject(overrides: Partial<AnytypeWorkflowObject> = {}): AnytypeWorkflowObject {
  return {
    id: "definition-1",
    name: "Workflow one",
    typeKey: "knot-workflow",
    source: source("Workflow one"),
    modifiedAt: 100,
    editorParticipantId: "operator",
    archived: false,
    ...overrides,
  };
}

function definitionDigest(markdown: string): string {
  const body = /```yaml\s*\n([\s\S]*?)\n```/i.exec(markdown)?.[1];
  if (!body) throw new Error("test workflow source is missing YAML");
  return workflowSourceDigest(body);
}

function eventRows(store: Store): Array<Record<string, unknown>> {
  return store.db
    .prepare(
      `SELECT kind,source_modified_at,source_fingerprint,editor_principal_digest,payload_json
       FROM normalized_events ORDER BY recorded_at,event_id`,
    )
    .all() as Array<Record<string, unknown>>;
}

describe("read-only workflow observer", () => {
  it("discovers a valid definition without executing or persisting source text", async () => {
    const anytype = new FakeAnytype();
    const object = workflowObject({ source: source("Disabled workflow", false) });
    anytype.workflowObjects = [object];
    const store = new Store(":memory:");
    const observer = new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => 200,
    );

    const result = await observer.scanSpaceOnce("space-1");

    expect(result).toMatchObject({ objects: 1, changes: 1, archived: 0, failed: false });
    expect(store.workflowDefinition("space-1", object.id)).toMatchObject({
      name: "Disabled workflow",
      state: "valid",
      sourceModifiedAt: 100,
      sourceDigest: definitionDigest(object.source!),
      lastSeenAt: 200,
    });
    expect(store.db.prepare("SELECT source_text FROM workflow_versions").get()).toEqual({
      source_text: "",
    });
    expect(eventRows(store)).toHaveLength(1);
    expect(JSON.parse(String(eventRows(store)[0]!.payload_json))).toMatchObject({
      enabled: false,
      valid: true,
    });
    store.close();
  });

  it("resumes from persisted state and deduplicates a repeated observation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "knot-observer-restart-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    const anytype = new FakeAnytype();
    anytype.workflowObjects = [workflowObject()];
    let store = new Store(path);
    await new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => 200,
    ).scanSpaceOnce("space-1");
    const firstState = store.workflowObserverState("space-1");
    store.close();

    store = new Store(path);
    const result = await new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => 300,
    ).scanSpaceOnce("space-1");

    expect(result.changes).toBe(0);
    expect(eventRows(store)).toHaveLength(1);
    expect(store.workflowObserverState("space-1")?.watermarkFingerprint).toBe(
      firstState?.watermarkFingerprint,
    );
    store.close();
  });

  it("repairs a missing audit event after a partial observation commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "knot-observer-repair-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    const anytype = new FakeAnytype();
    anytype.workflowObjects = [workflowObject()];
    let store = new Store(path);
    const eventWrite = vi.spyOn(store, "recordNormalizedEvent").mockImplementationOnce(() => {
      throw new Error("simulated crash before event commit");
    });
    expect(
      await new WorkflowObserver(
        anytype,
        store,
        automationConfig(),
        () => {},
        () => 200,
      ).scanSpaceOnce("space-1"),
    ).toMatchObject({ failed: true });
    expect(eventRows(store)).toHaveLength(0);
    eventWrite.mockRestore();
    store.close();

    store = new Store(path);
    const result = await new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => 300,
    ).scanSpaceOnce("space-1");

    expect(result.changes).toBe(1);
    expect(eventRows(store)).toHaveLength(1);
    expect(eventRows(store)[0]!.kind).toBe("object.created");
    store.close();
  });

  it("records distinct same-timestamp edits and retains the watermark tie-break", async () => {
    const anytype = new FakeAnytype();
    const store = new Store(":memory:");
    let now = 200;
    const observer = new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => now,
    );
    const first = workflowObject({ source: source("First", false, "target-a") });
    const second = workflowObject({ source: source("Second", false, "target-b") });
    anytype.workflowObjects = [first];
    await observer.scanSpaceOnce("space-1");
    now = 300;
    anytype.workflowObjects = [second];

    const result = await observer.scanSpaceOnce("space-1");

    expect(result.changes).toBe(1);
    expect(eventRows(store)).toHaveLength(2);
    const expectedWatermark = [
      definitionDigest(first.source!),
      definitionDigest(second.source!),
    ].sort()[1];
    expect(store.workflowObserverState("space-1")?.watermarkFingerprint).toBe(expectedWatermark);
    store.close();
  });

  it("accepts the same canonical definition at a later native revision", async () => {
    const anytype = new FakeAnytype();
    const store = new Store(":memory:");
    let now = 200;
    const observer = new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => now,
    );
    anytype.workflowObjects = [workflowObject({ modifiedAt: 100 })];
    await observer.scanSpaceOnce("space-1");
    now = 300;
    anytype.workflowObjects = [workflowObject({ modifiedAt: 150 })];

    expect(await observer.scanSpaceOnce("space-1")).toMatchObject({ failed: false, changes: 1 });
    expect(eventRows(store).map((event) => event.kind)).toEqual([
      "object.created",
      "object.updated",
    ]);
    expect(
      (
        store.db.prepare("SELECT COUNT(*) AS count FROM workflow_versions").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    store.close();
  });

  it("marks archive and missing-on-reconcile transitions without effects", async () => {
    const anytype = new FakeAnytype();
    const store = new Store(":memory:");
    let now = 100;
    const observer = new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => now,
    );
    anytype.workflowObjects = [workflowObject()];
    await observer.scanSpaceOnce("space-1");
    now = 200;
    anytype.workflowObjects = [];

    expect(await observer.scanSpaceOnce("space-1")).toMatchObject({ archived: 1, changes: 1 });
    expect(store.workflowDefinition("space-1", "definition-1")?.state).toBe("archived");
    expect(eventRows(store).map((event) => event.kind)).toEqual([
      "object.created",
      "object.archived",
    ]);
    store.close();
  });

  it("records an explicit native archive once", async () => {
    const anytype = new FakeAnytype();
    const store = new Store(":memory:");
    let now = 100;
    const observer = new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => now,
    );
    anytype.workflowObjects = [workflowObject()];
    await observer.scanSpaceOnce("space-1");
    now = 200;
    anytype.workflowObjects = [workflowObject({ archived: true, modifiedAt: 150 })];
    await observer.scanSpaceOnce("space-1");
    now = 300;
    await observer.scanSpaceOnce("space-1");

    expect(store.workflowDefinition("space-1", "definition-1")?.state).toBe("archived");
    expect(eventRows(store).map((event) => event.kind)).toEqual([
      "object.created",
      "object.archived",
    ]);
    store.close();
  });

  it("rejects an unverified editor but keeps a safe audit event", async () => {
    const anytype = new FakeAnytype();
    const unverified = workflowObject();
    delete unverified.editorParticipantId;
    anytype.workflowObjects = [unverified];
    const store = new Store(":memory:");

    await new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => 200,
    ).scanSpaceOnce("space-1");

    expect(store.workflowDefinition("space-1", "definition-1")).toMatchObject({
      state: "invalid",
      validationErrors: expect.arrayContaining(["Workflow editor identity is not verified"]),
    });
    expect(eventRows(store)[0]!.editor_principal_digest).toBeNull();
    expect(String(eventRows(store)[0]!.payload_json).includes("operator")).toBe(false);
    expect(
      (
        store.db.prepare("SELECT COUNT(*) AS count FROM workflow_versions").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    store.close();
  });

  it("does not persist source snippets from malformed YAML", async () => {
    const anytype = new FakeAnytype();
    anytype.workflowObjects = [
      workflowObject({
        source: "```yaml\nsecret: never-store-this\ninvalid: [\n```",
      }),
    ];
    const store = new Store(":memory:");

    await new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => 200,
    ).scanSpaceOnce("space-1");

    const observation = store.workflowDefinition("space-1", "definition-1");
    expect(observation?.state).toBe("invalid");
    expect(observation?.validationErrors).toEqual(["Workflow YAML could not be parsed"]);
    expect(JSON.stringify(observation)).not.toContain("never-store-this");
    expect(String(eventRows(store)[0]!.payload_json)).not.toContain("never-store-this");
    store.close();
  });

  it("backs off after failure and returns to a successful persisted scan", async () => {
    const anytype = new FakeAnytype();
    anytype.workflowSearchFailures = 1;
    const store = new Store(":memory:");
    let now = 100;
    const observer = new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => now,
      () => 0.5,
    );

    expect(await observer.scanSpaceOnce("space-1")).toMatchObject({ failed: true });
    expect(store.workflowObserverState("space-1")).toMatchObject({
      consecutiveFailures: 1,
      pollIntervalMilliseconds: 20_000,
      nextScanAt: 20_100,
      lastError: "workflow search unavailable",
    } satisfies Partial<WorkflowObserverState>);
    now = 20_100;
    anytype.workflowObjects = [workflowObject()];
    expect(await observer.scanSpaceOnce("space-1")).toMatchObject({ failed: false, changes: 1 });
    expect(store.workflowObserverState("space-1")).toMatchObject({
      consecutiveFailures: 0,
      pollIntervalMilliseconds: 10_000,
      lastSuccessAt: 20_100,
    });
    store.close();
  });
});

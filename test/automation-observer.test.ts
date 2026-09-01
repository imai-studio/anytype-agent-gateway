import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowObserver } from "../src/automation/observer.js";
import type { WorkflowObserverState } from "../src/automation/store-types.js";
import { workflowSourceDigest } from "../src/automation/workflow.js";
import { AnytypeHttpError } from "../src/anytype-client.js";
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

function observationDigest(markdown: string): string {
  return workflowSourceDigest(markdown);
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
      sourceDigest: observationDigest(object.source!),
      lastSeenAt: 200,
    });
    expect(store.db.prepare("SELECT source_text FROM workflow_versions").get()).toEqual({
      source_text: "",
    });
    expect(store.db.prepare("SELECT source_digest FROM workflow_versions").get()).toEqual({
      source_digest: definitionDigest(object.source!),
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

  it("isolates an audit write failure and repairs the valid revision on retry", async () => {
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
    ).toMatchObject({ failed: false });
    expect(eventRows(store)).toHaveLength(1);
    expect(store.workflowDefinition("space-1", "definition-1")).toMatchObject({
      state: "valid",
    });
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
    expect(eventRows(store)).toHaveLength(2);
    expect(eventRows(store).map((event) => event.kind)).toEqual([
      "object.unreadable",
      "object.created",
    ]);
    expect(store.workflowDefinition("space-1", "definition-1")?.state).toBe("valid");
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
      observationDigest(first.source!),
      observationDigest(second.source!),
    ].sort()[1];
    expect(store.workflowObserverState("space-1")?.watermarkFingerprint).toBe(expectedWatermark);
    store.close();
  });

  it("accepts comment-only YAML changes at a later native revision", async () => {
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
    anytype.workflowObjects = [
      workflowObject({
        modifiedAt: 150,
        source: source("Workflow one").replace("metadata:", "# formatting-only comment\nmetadata:"),
      }),
    ];

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
    anytype.missingObjectIds.add("definition-1");

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
      validationErrors: expect.arrayContaining(["editor_unverified"]),
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
    expect(observation?.validationErrors).toEqual(["yaml_invalid"]);
    expect(JSON.stringify(observation)).not.toContain("never-store-this");
    expect(String(eventRows(store)[0]!.payload_json)).not.toContain("never-store-this");
    store.close();
  });

  it("rejects many unterminated workflow fences without regex backtracking", async () => {
    const anytype = new FakeAnytype();
    anytype.workflowObjects = [
      workflowObject({
        source: Array.from({ length: 20_000 }, (_, index) => `\`\`\`yaml ${index}`).join("\n"),
      }),
    ];
    const store = new Store(":memory:");

    const result = await new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => 200,
    ).scanSpaceOnce("space-1");

    expect(result.failed).toBe(false);
    expect(store.workflowDefinition("space-1", "definition-1")).toMatchObject({
      state: "invalid",
      validationErrors: ["source_fence_invalid"],
    });
    store.close();
  });

  it("uses the raw object digest to resolve valid and invalid same-timestamp revisions", async () => {
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
    let validSource = source("Valid revision");
    const fencedDigest = definitionDigest(validSource);
    let invalidSource = "";
    for (let index = 0; index < 50_000; index += 1) {
      const candidate = `malformed workflow revision ${index}`;
      const candidateDigest = observationDigest(candidate);
      if (observationDigest(validSource) < candidateDigest && candidateDigest < fencedDigest) {
        invalidSource = candidate;
        break;
      }
      validSource = `wrapper ${index}\n${source("Valid revision")}`;
    }
    expect(invalidSource).not.toBe("");
    anytype.workflowObjects = [workflowObject({ source: validSource, modifiedAt: 100 })];
    await observer.scanSpaceOnce("space-1");
    now = 300;
    anytype.workflowObjects = [workflowObject({ source: invalidSource, modifiedAt: 100 })];

    await observer.scanSpaceOnce("space-1");

    expect(store.workflowDefinition("space-1", "definition-1")).toMatchObject({
      state: "invalid",
      sourceDigest: observationDigest(invalidSource),
      validationErrors: ["source_fence_invalid"],
    });
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
      lastError: "scan_failed",
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

  it("finishes a multi-page reconciliation before considering missing definitions", async () => {
    const anytype = new FakeAnytype();
    anytype.workflowObjects = [
      workflowObject({ id: "definition-1", source: source("One") }),
      workflowObject({ id: "definition-2", source: source("Two") }),
    ];
    const store = new Store(":memory:");
    let now = 100;
    const observer = new WorkflowObserver(
      anytype,
      store,
      automationConfig(1),
      () => {},
      () => now++,
    );

    expect(await observer.scanSpaceOnce("space-1")).toMatchObject({ objects: 1, archived: 0 });
    expect(await observer.scanSpaceOnce("space-1")).toMatchObject({ objects: 1, archived: 0 });
    expect(await observer.scanSpaceOnce("space-1")).toMatchObject({ objects: 0, archived: 0 });
    expect(store.workflowDefinition("space-1", "definition-1")?.state).toBe("valid");
    expect(store.workflowDefinition("space-1", "definition-2")?.state).toBe("valid");
    store.close();
  });

  it("bounds missing-object reconciliation to one configured page per scan", async () => {
    const anytype = new FakeAnytype();
    const store = new Store(":memory:");
    for (let index = 1; index <= 3; index += 1) {
      const objectId = `missing-${index}`;
      store.recordWorkflowDefinitionStatus({
        workflowId: `workflow-${index}`,
        spaceId: "space-1",
        objectId,
        name: `Missing ${index}`,
        state: "invalid",
        sourceModifiedAt: 1,
        sourceDigest: workflowSourceDigest(objectId),
        seenAt: 1,
        validationErrors: ["source_missing"],
      });
      anytype.missingObjectIds.add(objectId);
    }
    let now = 100;
    const observer = new WorkflowObserver(
      anytype,
      store,
      automationConfig(1),
      () => {},
      () => now++,
    );

    expect(await observer.scanSpaceOnce("space-1")).toMatchObject({ archived: 1 });
    expect(await observer.scanSpaceOnce("space-1")).toMatchObject({ archived: 1 });
    expect(await observer.scanSpaceOnce("space-1")).toMatchObject({ archived: 1 });
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM workflow_definitions WHERE state='archived'")
        .get(),
    ).toEqual({ count: 3 });
    store.close();
  });

  it("does not infer archive from a search miss while the object still exists", async () => {
    const anytype = new FakeAnytype();
    anytype.workflowObjects = [workflowObject()];
    const store = new Store(":memory:");
    let now = 100;
    const observer = new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => now,
    );
    await observer.scanSpaceOnce("space-1");
    now = 200;
    anytype.workflowObjects = [];

    expect(await observer.scanSpaceOnce("space-1")).toMatchObject({ archived: 0 });
    expect(store.workflowDefinition("space-1", "definition-1")?.state).toBe("valid");
    store.close();
  });

  it("isolates an unreadable object and continues observing the rest of the page", async () => {
    const anytype = new FakeAnytype();
    const unreadable = workflowObject({ id: "bad", observationError: "object_read_failed" });
    delete unreadable.source;
    delete unreadable.editorParticipantId;
    anytype.workflowObjects = [unreadable, workflowObject({ id: "good", source: source("Good") })];
    const store = new Store(":memory:");

    const result = await new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => 200,
    ).scanSpaceOnce("space-1");

    expect(result).toMatchObject({ failed: false, objects: 2, changes: 2 });
    expect(store.workflowDefinition("space-1", "bad")).toMatchObject({
      state: "invalid",
      validationErrors: ["object_read_failed"],
    });
    expect(store.workflowDefinition("space-1", "good")?.state).toBe("valid");
    store.close();
  });

  it("preserves the first successful object.created after an unreadable observation", async () => {
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
    anytype.workflowObjects = [
      workflowObject({ observationError: "object_read_failed", modifiedAt: 100 }),
    ];
    await observer.scanSpaceOnce("space-1");
    now = 300;
    anytype.workflowObjects = [workflowObject({ modifiedAt: 101 })];

    await observer.scanSpaceOnce("space-1");

    expect(eventRows(store).map((event) => event.kind)).toEqual([
      "object.unreadable",
      "object.created",
    ]);
    expect(store.workflowDefinition("space-1", "definition-1")?.state).toBe("valid");
    store.close();
  });

  it("does not discard an active version for a stale or same-revision read failure", async () => {
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
    const activeVersionHash = store.workflowDefinition(
      "space-1",
      "definition-1",
    )?.activeVersionHash;
    now = 300;
    anytype.workflowObjects = [
      workflowObject({ modifiedAt: 100, observationError: "object_read_failed" }),
    ];

    await observer.scanSpaceOnce("space-1");

    expect(store.workflowDefinition("space-1", "definition-1")).toMatchObject({
      state: "valid",
      activeVersionHash,
      sourceModifiedAt: 100,
    });
    now = 400;
    anytype.workflowObjects = [
      workflowObject({ modifiedAt: 150, observationError: "object_read_failed" }),
    ];
    await observer.scanSpaceOnce("space-1");
    expect(store.workflowDefinition("space-1", "definition-1")).toMatchObject({
      state: "invalid",
      sourceModifiedAt: 150,
      validationErrors: ["object_read_failed"],
    });
    expect(store.workflowDefinition("space-1", "definition-1")?.activeVersionHash).toBeUndefined();
    store.close();
  });

  it("records a poisoned object and advances pagination through reconciliation", async () => {
    const anytype = new FakeAnytype();
    anytype.workflowObjects = [
      workflowObject({ id: "poisoned", source: source("Poisoned") }),
      workflowObject({ id: "good-1", source: source("Good one") }),
      workflowObject({ id: "good-2", source: source("Good two") }),
    ];
    anytype.missingObjectIds.add("missing");
    const store = new Store(":memory:");
    store.recordWorkflowDefinitionStatus({
      workflowId: "missing-workflow",
      spaceId: "space-1",
      objectId: "missing",
      name: "Missing",
      state: "invalid",
      sourceModifiedAt: 1,
      sourceDigest: workflowSourceDigest("missing"),
      seenAt: 1,
      validationErrors: ["source_missing"],
    });
    const saveVersion = vi.spyOn(store, "saveWorkflowVersion").mockImplementationOnce(() => {
      throw new Error("poisoned version record");
    });
    let now = 200;
    const observer = new WorkflowObserver(
      anytype,
      store,
      automationConfig(2),
      () => {},
      () => now++,
    );

    expect(await observer.scanSpaceOnce("space-1")).toMatchObject({
      failed: false,
      objects: 2,
    });
    expect(store.workflowObserverState("space-1")?.pageOffset).toBe(2);
    expect(store.workflowDefinition("space-1", "poisoned")).toMatchObject({
      state: "invalid",
      validationErrors: ["store_write_failed"],
    });
    expect(await observer.scanSpaceOnce("space-1")).toMatchObject({
      failed: false,
      objects: 1,
      archived: 1,
    });
    expect(store.workflowObserverState("space-1")?.pageOffset).toBe(0);
    expect(store.workflowDefinition("space-1", "good-2")?.state).toBe("valid");
    expect(store.workflowDefinition("space-1", "missing")?.state).toBe("archived");
    expect(saveVersion).toHaveBeenCalled();
    store.close();
  });

  it("classifies immutable workflow collisions separately from transient store failures", async () => {
    const anytype = new FakeAnytype();
    anytype.workflowObjects = [workflowObject()];
    const store = new Store(":memory:");
    vi.spyOn(store, "saveWorkflowVersion").mockImplementationOnce(() => {
      throw new Error("Workflow version collision or divergent immutable record");
    });

    await new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => 200,
    ).scanSpaceOnce("space-1");

    expect(store.workflowDefinition("space-1", "definition-1")).toMatchObject({
      state: "invalid",
      validationErrors: ["workflow_integrity_failed"],
    });
    store.close();
  });

  it("rejects future native revisions without pinning the watermark", async () => {
    const anytype = new FakeAnytype();
    anytype.workflowObjects = [
      workflowObject({ id: "future", modifiedAt: 5 * 60 * 1_000 + 201 }),
      workflowObject({ id: "current", modifiedAt: 150, source: source("Current") }),
    ];
    const store = new Store(":memory:");

    const result = await new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => 200,
    ).scanSpaceOnce("space-1");

    expect(result.failed).toBe(false);
    expect(store.workflowDefinition("space-1", "future")).toMatchObject({
      state: "invalid",
      validationErrors: ["native_revision_missing"],
    });
    expect(store.workflowObserverState("space-1")?.watermarkModifiedAt).toBe(150);
    store.close();
  });

  it("advances past an object when recording its read failure also fails", async () => {
    const anytype = new FakeAnytype();
    anytype.workflowObjects = [
      workflowObject({ id: "poisoned", source: source("Poisoned") }),
      workflowObject({ id: "good", source: source("Good") }),
    ];
    const store = new Store(":memory:");
    vi.spyOn(store, "saveWorkflowVersion").mockImplementationOnce(() => {
      throw new Error("poisoned version");
    });
    vi.spyOn(store, "recordWorkflowDefinitionReadFailure").mockImplementationOnce(() => {
      throw new Error("temporary store failure");
    });
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];

    const result = await new WorkflowObserver(
      anytype,
      store,
      automationConfig(2),
      (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }),
      () => 200,
    ).scanSpaceOnce("space-1");

    expect(result).toMatchObject({ failed: false, objects: 2 });
    expect(store.workflowObserverState("space-1")?.pageOffset).toBe(2);
    expect(store.workflowDefinition("space-1", "good")?.state).toBe("valid");
    expect(logs).toContainEqual({
      event: "workflow_observer_object_failed",
      fields: expect.objectContaining({ errorCode: "read_failure_persistence_failed" }),
    });
    store.close();
  });

  it("isolates reconciliation persistence failures per object", async () => {
    const anytype = new FakeAnytype();
    const store = new Store(":memory:");
    for (const objectId of ["missing-1", "missing-2"]) {
      store.recordWorkflowDefinitionStatus({
        workflowId: `workflow-${objectId}`,
        spaceId: "space-1",
        objectId,
        name: objectId,
        state: "invalid",
        sourceModifiedAt: 1,
        sourceDigest: workflowSourceDigest(objectId),
        seenAt: 1,
        validationErrors: ["source_missing"],
      });
      anytype.missingObjectIds.add(objectId);
    }
    vi.spyOn(store, "recordWorkflowDefinitionStatus").mockImplementationOnce(() => {
      throw new Error("temporary reconciliation write failure");
    });
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];

    const result = await new WorkflowObserver(
      anytype,
      store,
      automationConfig(2),
      (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }),
      () => 200,
    ).scanSpaceOnce("space-1");

    expect(result).toMatchObject({ failed: true, archived: 1 });
    expect(store.workflowDefinition("space-1", "missing-1")?.state).toBe("invalid");
    expect(store.workflowDefinition("space-1", "missing-2")?.state).toBe("archived");
    expect(logs).toContainEqual({
      event: "workflow_observer_object_failed",
      fields: expect.objectContaining({ errorCode: "reconciliation_persistence_failed" }),
    });
    store.close();
  });

  it("uses bounded object reads while reconciling missing definitions", async () => {
    const anytype = new FakeAnytype();
    const store = new Store(":memory:");
    store.recordWorkflowDefinitionStatus({
      workflowId: "workflow-missing",
      spaceId: "space-1",
      objectId: "missing",
      name: "Missing",
      state: "invalid",
      sourceModifiedAt: 1,
      sourceDigest: workflowSourceDigest("missing"),
      seenAt: 1,
      validationErrors: ["source_missing"],
    });
    const boundedRead = vi
      .spyOn(anytype, "getWorkflowObject")
      .mockRejectedValueOnce(new Error("Anytype object response is too large"));
    const generalRead = vi.spyOn(anytype, "getObject");

    const result = await new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => 200,
    ).scanSpaceOnce("space-1");

    expect(result).toMatchObject({ failed: true, archived: 0 });
    expect(store.workflowDefinition("space-1", "missing")?.lastSeenAt).toBe(200);
    expect(boundedRead).toHaveBeenCalledWith("space-1", "missing");
    expect(generalRead).not.toHaveBeenCalled();
    store.close();
  });

  it("backs off a failed confirmation without letting it pin later reconciliation candidates", async () => {
    const anytype = new FakeAnytype();
    const store = new Store(":memory:");
    for (const objectId of ["bad", "good"]) {
      store.recordWorkflowDefinitionStatus({
        workflowId: `workflow-${objectId}`,
        spaceId: "space-1",
        objectId,
        name: objectId,
        state: "invalid",
        sourceModifiedAt: 1,
        sourceDigest: workflowSourceDigest(objectId),
        seenAt: 1,
        validationErrors: ["source_missing"],
      });
    }
    anytype.missingObjectIds.add("good");
    const originalRead = anytype.getWorkflowObject.bind(anytype);
    vi.spyOn(anytype, "getWorkflowObject").mockImplementation((spaceId, objectId) => {
      if (objectId === "bad")
        return Promise.reject(
          new AnytypeHttpError(503, "GET", `/v1/spaces/${spaceId}/objects/${objectId}`),
        );
      return originalRead(spaceId, objectId);
    });
    let now = 200;
    const observer = new WorkflowObserver(
      anytype,
      store,
      automationConfig(1),
      () => {},
      () => now,
      () => 0.5,
    );

    const failed = await observer.scanSpaceOnce("space-1");
    expect(failed).toMatchObject({ failed: true, archived: 0 });
    expect(store.workflowDefinition("space-1", "bad")?.lastSeenAt).toBe(200);
    expect(store.workflowObserverState("space-1")).toMatchObject({
      pageOffset: 0,
      consecutiveFailures: 1,
      pollIntervalMilliseconds: 20_000,
      lastError: "reconciliation_confirmation_failed",
    });

    now = 300;
    const progressed = await observer.scanSpaceOnce("space-1");
    expect(progressed.archived).toBe(1);
    expect(store.workflowDefinition("space-1", "good")?.state).toBe("archived");
    store.close();
  });

  it("rejects hostile space IDs and drops overlong object IDs without sentinel collisions", async () => {
    const anytype = new FakeAnytype();
    const hostileId = "😀".repeat(400);
    const search = vi.spyOn(anytype, "searchWorkflowObjects");
    const store = new Store(":memory:");
    const observer = new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      () => {},
      () => 200,
    );

    await expect(observer.scanSpaceOnce(hostileId)).rejects.toThrow("Workflow space ID is invalid");
    expect(search).not.toHaveBeenCalled();

    anytype.workflowObjects = [
      workflowObject({ id: hostileId }),
      workflowObject({ id: "invalid-object-id", source: source("Safe") }),
    ];
    const result = await observer.scanSpaceOnce("space-1");
    expect(result.failed).toBe(false);
    expect(result.objects).toBe(2);
    expect(store.workflowDefinition("space-1", hostileId)).toBeUndefined();
    expect(store.workflowDefinition("space-1", "invalid-object-id")?.state).toBe("valid");
    store.close();
  });

  it("keeps the run loop alive through escaped observer-state errors", async () => {
    const anytype = new FakeAnytype();
    const store = new Store(":memory:");
    vi.spyOn(store, "workflowObserverState").mockImplementationOnce(() => {
      throw new Error("temporary state read failure");
    });
    const abort = new AbortController();
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const observer = new WorkflowObserver(
      anytype,
      store,
      automationConfig(),
      (event, fields) => {
        logs.push({ event, ...(fields ? { fields } : {}) });
        if (event === "workflow_observer_loop_failed") abort.abort();
      },
      () => 200,
      () => 0,
    );

    await expect(observer.run(abort.signal)).resolves.toBeUndefined();
    expect(logs).toContainEqual({
      event: "workflow_observer_loop_failed",
      fields: {
        errorCode: "scan_failed",
        consecutiveFailures: 1,
        retryInMilliseconds: 9_000,
      },
    });
    store.close();
  });

  it("requires exact configured participant identity for workflow authority", async () => {
    const anytype = new FakeAnytype();
    anytype.workflowObjects = [workflowObject({ editorParticipantId: "_participant_operator" })];
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
      validationErrors: ["editor_unauthorized"],
    });
    store.close();
  });

  it("keeps pagination and object identity isolated across spaces", async () => {
    const anytype = new FakeAnytype();
    const bySpace = new Map([
      ["space-1", [workflowObject({ id: "shared", source: source("Space one") })]],
      ["space-2", [workflowObject({ id: "shared", source: source("Space two") })]],
    ]);
    vi.spyOn(anytype, "searchWorkflowObjects").mockImplementation(
      async (spaceId, _typeKeys, offset, limit) =>
        (bySpace.get(spaceId) ?? []).slice(offset, offset + limit),
    );
    const store = new Store(":memory:");
    const config = {
      ...automationConfig(),
      allowedSpaceIds: ["space-1", "space-2"],
    };
    const observer = new WorkflowObserver(
      anytype,
      store,
      config,
      () => {},
      () => 200,
    );

    await observer.scanSpaceOnce("space-1");
    await observer.scanSpaceOnce("space-2");

    expect(store.workflowDefinition("space-1", "shared")?.name).toBe("Space one");
    expect(store.workflowDefinition("space-2", "shared")?.name).toBe("Space two");
    expect(store.workflowObserverState("space-1")).toBeDefined();
    expect(store.workflowObserverState("space-2")).toBeDefined();
    store.close();
  });
});

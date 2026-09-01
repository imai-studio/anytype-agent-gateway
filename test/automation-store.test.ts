import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateWorkflowPolicy } from "../src/automation/policy.js";
import {
  canonicalJson,
  canonicalWorkflowDefinition,
  workflowApprovalHash,
  workflowApprovalMaterial,
  workflowDefinitionSchema,
  workflowSourceDigest,
  workflowVersionHash,
} from "../src/automation/workflow.js";
import { Store } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function versionRecord(
  definition = workflowDefinitionSchema.parse({
    apiVersion: "knot.imai.studio/v1alpha1",
    kind: "KnotWorkflow",
    metadata: { name: "Digest" },
    spec: {
      triggers: [{ kind: "manual" }],
      steps: [{ id: "read", kind: "anytype.read", config: { objectId: "object-1" } }],
      capabilities: ["anytype.read"],
    },
  }),
  overrides: Partial<{
    workflowId: string;
    spaceId: string;
    objectId: string;
    sourceModifiedAt: number;
    createdAt: number;
  }> = {},
) {
  const spaceId = overrides.spaceId ?? "space-1";
  const policy = evaluateWorkflowPolicy(definition, { sourceSpaceId: spaceId });
  return {
    workflowId: overrides.workflowId ?? "workflow-1",
    spaceId,
    objectId: overrides.objectId ?? "object-workflow-1",
    name: definition.metadata.name,
    versionHash: workflowVersionHash(definition),
    approvalHash: workflowApprovalHash(definition),
    schemaVersion: 1,
    canonicalDefinitionJson: canonicalWorkflowDefinition(definition),
    canonicalApprovalJson: canonicalJson(workflowApprovalMaterial(definition)),
    sourceDigest: workflowSourceDigest(canonicalWorkflowDefinition(definition)),
    riskTier: policy.riskTier,
    requiredCapabilities: policy.requiredCapabilities,
    sourceModifiedAt: overrides.sourceModifiedAt ?? 100,
    editorPrincipalDigest: `sha256:${"a".repeat(64)}`,
    editorProvenance: "anytype-native" as const,
    createdAt: overrides.createdAt ?? 200,
  };
}

describe("automation persistence foundation", () => {
  it("retains the v7 automation foundation tables without enabling execution", () => {
    const store = new Store(":memory:");
    expect(store.schemaVersion()).toBe(11);
    for (const table of [
      "workflow_definitions",
      "workflow_approval_subjects",
      "workflow_versions",
      "workflow_approval_decisions",
      "normalized_events",
      "workflow_observer_spaces",
    ])
      expect(
        store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
      ).toBeDefined();
    expect(
      store.db
        .prepare("SELECT 1 FROM pragma_table_info('workflow_definitions') WHERE name=?")
        .get("observed_source_digest"),
    ).toBeDefined();
    expect(store.migrationBackupPath).toBeUndefined();
    store.close();
  });

  it("takes a consistent mode-0600 backup before upgrading an on-disk v6 database", () => {
    const directory = mkdtempSync(join(tmpdir(), "knot-v6-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "CREATE TABLE fixture(value TEXT NOT NULL); INSERT INTO fixture VALUES('kept'); PRAGMA user_version=6;",
    );
    legacy.close();

    const reports: string[] = [];
    const store = new Store(path, (message) => reports.push(message));
    expect(store.schemaVersion()).toBe(11);
    expect(store.migrationBackupPath).toBeTruthy();
    expect(store.migrationBackupPath).toContain(".pre-v6.");
    expect(reports[0]).toContain("from schema 6 to 11");
    expect(statSync(store.migrationBackupPath!).mode & 0o777).toBe(0o600);
    const backup = new DatabaseSync(store.migrationBackupPath!, { readOnly: true });
    expect(
      (backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(6);
    expect(backup.prepare("SELECT value FROM fixture").get()).toEqual({ value: "kept" });
    backup.close();
    store.close();
  });

  it("scrubs legacy raw workflow source during the v8 to v9 migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "knot-v8-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE workflow_versions (
        workflow_id TEXT NOT NULL,
        version_hash TEXT NOT NULL,
        source_text TEXT NOT NULL,
        author_principal_digest TEXT,
        PRIMARY KEY(workflow_id,version_hash)
      );
      CREATE TABLE normalized_events (event_id TEXT PRIMARY KEY);
      CREATE TRIGGER workflow_versions_no_update BEFORE UPDATE ON workflow_versions
        BEGIN SELECT RAISE(ABORT,'workflow versions are append-only'); END;
      INSERT INTO workflow_versions VALUES(
        'workflow-1','version-1','secret-bearing source','legacy-unverified-editor'
      );
      PRAGMA user_version=8;
    `);
    legacy.close();

    const store = new Store(path);
    expect(
      store.db
        .prepare(
          `SELECT source_text,source_digest,author_principal_digest,editor_provenance
           FROM workflow_versions`,
        )
        .get(),
    ).toEqual({
      source_text: "",
      source_digest: workflowSourceDigest("secret-bearing source"),
      author_principal_digest: null,
      editor_provenance: null,
    });
    expect(() =>
      store.db.prepare("UPDATE workflow_versions SET source_text='restored'").run(),
    ).toThrow("append-only");
    store.close();
  });

  it("removes author prompt text from a migrated live database and WAL", () => {
    const directory = mkdtempSync(join(tmpdir(), "knot-v10-redaction-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    const secret = "prompt-that-must-not-survive-in-live-sqlite";
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE workflow_versions (
        canonical_definition_json TEXT NOT NULL
      );
      CREATE TABLE workflow_approval_subjects (
        canonical_approval_json TEXT NOT NULL
      );
      INSERT INTO workflow_versions VALUES(
        '{"spec":{"steps":[{"config":{"prompt":"${secret}"}}]}}'
      );
      INSERT INTO workflow_approval_subjects VALUES(
        '{"spec":{"steps":[{"config":{"prompt":"${secret}"}}]}}'
      );
      PRAGMA user_version=10;
    `);
    legacy.close();

    const store = new Store(path);
    store.close();

    expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
    if (existsSync(`${path}-wal`))
      expect(readFileSync(`${path}-wal`).includes(Buffer.from(secret))).toBe(false);
  });

  it("stores immutable versions idempotently across equivalent source formatting", () => {
    const store = new Store(":memory:");
    const input = versionRecord();
    expect(store.saveWorkflowVersion(input)).toEqual(input);
    expect(store.saveWorkflowVersion(input)).toEqual(input);
    expect(
      store.saveWorkflowVersion({
        ...input,
        sourceDigest: workflowSourceDigest("# comment-only YAML representation"),
      }),
    ).toEqual(input);
    expect(store.workflowVersion(input.workflowId, input.versionHash)).toEqual(input);
    expect(
      store.db
        .prepare(
          "SELECT policy_version FROM workflow_approval_subjects WHERE workflow_id=? AND approval_hash=?",
        )
        .get(input.workflowId, input.approvalHash),
    ).toEqual({ policy_version: 2 });
    store.close();
  });

  it("rejects future-pinned source timestamps", () => {
    const store = new Store(":memory:");
    expect(() =>
      store.saveWorkflowVersion(
        versionRecord(undefined, { sourceModifiedAt: Date.now() + 10 * 60 * 1_000 }),
      ),
    ).toThrow("too far in the future");
    store.close();
  });

  it("does not let stale observations reactivate an older version or rewrite its metadata", () => {
    const store = new Store(":memory:");
    const firstDefinition = workflowDefinitionSchema.parse({
      apiVersion: "knot.imai.studio/v1alpha1",
      kind: "KnotWorkflow",
      metadata: { name: "First name" },
      spec: {
        triggers: [{ kind: "manual" }],
        steps: [{ id: "read", kind: "anytype.read", config: { objectId: "object-1" } }],
        capabilities: ["anytype.read"],
      },
    });
    const secondDefinition = workflowDefinitionSchema.parse({
      ...firstDefinition,
      metadata: { ...firstDefinition.metadata, name: "Second name" },
      spec: {
        ...firstDefinition.spec,
        steps: [{ id: "read", kind: "anytype.read", config: { objectId: "object-2" } }],
      },
    });
    const staleDefinition = workflowDefinitionSchema.parse({
      ...firstDefinition,
      metadata: { ...firstDefinition.metadata, name: "Stale name" },
      spec: {
        ...firstDefinition.spec,
        steps: [{ id: "read", kind: "anytype.read", config: { objectId: "object-stale" } }],
      },
    });
    const first = store.saveWorkflowVersion(
      versionRecord(firstDefinition, { sourceModifiedAt: 100, createdAt: 100 }),
    );
    const second = store.saveWorkflowVersion(
      versionRecord(secondDefinition, { sourceModifiedAt: 200, createdAt: 200 }),
    );
    store.saveWorkflowVersion(
      versionRecord(staleDefinition, { sourceModifiedAt: 50, createdAt: 300 }),
    );

    expect(
      store.db
        .prepare(
          "SELECT active_version_hash,source_modified_at,name FROM workflow_definitions WHERE workflow_id=?",
        )
        .get(first.workflowId),
    ).toEqual({
      active_version_hash: second.versionHash,
      source_modified_at: 200,
      name: "Second name",
    });
    expect(store.workflowVersion(first.workflowId, first.versionHash)).toMatchObject({
      name: "First name",
      sourceModifiedAt: 100,
    });
    store.close();
  });

  it("resolves same-timestamp workflow edits by source digest", () => {
    const firstDefinition = workflowDefinitionSchema.parse({
      apiVersion: "knot.imai.studio/v1alpha1",
      kind: "KnotWorkflow",
      metadata: { name: "Same timestamp A" },
      spec: {
        triggers: [{ kind: "manual" }],
        steps: [{ id: "read", kind: "anytype.read", config: { objectId: "a" } }],
        capabilities: ["anytype.read"],
      },
    });
    const secondDefinition = workflowDefinitionSchema.parse({
      ...firstDefinition,
      metadata: { name: "Same timestamp B" },
      spec: {
        ...firstDefinition.spec,
        steps: [{ id: "read", kind: "anytype.read", config: { objectId: "b" } }],
      },
    });
    const versions = [versionRecord(firstDefinition), versionRecord(secondDefinition)];
    const expected = [...versions].sort((left, right) =>
      left.sourceDigest === right.sourceDigest
        ? 0
        : left.sourceDigest > right.sourceDigest
          ? 1
          : -1,
    )[1]!;
    for (const ordered of [versions, [...versions].reverse()]) {
      const store = new Store(":memory:");
      for (const version of ordered)
        store.saveWorkflowVersion({ ...version, sourceModifiedAt: 500, createdAt: 500 });
      expect(
        store.db
          .prepare("SELECT active_version_hash,name FROM workflow_definitions WHERE workflow_id=?")
          .get(expected.workflowId),
      ).toEqual({ active_version_hash: expected.versionHash, name: expected.name });
      store.close();
    }
  });

  it("reactivates a prior content version when a newer native revision reverts", () => {
    const store = new Store(":memory:");
    const firstDefinition = workflowDefinitionSchema.parse({
      apiVersion: "knot.imai.studio/v1alpha1",
      kind: "KnotWorkflow",
      metadata: { name: "First" },
      spec: {
        triggers: [{ kind: "manual" }],
        steps: [{ id: "read", kind: "anytype.read", config: { objectId: "one" } }],
        capabilities: ["anytype.read"],
      },
    });
    const secondDefinition = workflowDefinitionSchema.parse({
      ...firstDefinition,
      metadata: { name: "Second" },
      spec: {
        ...firstDefinition.spec,
        steps: [{ id: "read", kind: "anytype.read", config: { objectId: "two" } }],
      },
    });
    const first = store.saveWorkflowVersion(
      versionRecord(firstDefinition, { sourceModifiedAt: 100, createdAt: 100 }),
    );
    store.saveWorkflowVersion(
      versionRecord(secondDefinition, { sourceModifiedAt: 200, createdAt: 200 }),
    );
    store.saveWorkflowVersion(
      versionRecord(firstDefinition, { sourceModifiedAt: 300, createdAt: 300 }),
    );

    expect(
      store.db
        .prepare("SELECT active_version_hash,source_modified_at,name FROM workflow_definitions")
        .get(),
    ).toEqual({
      active_version_hash: first.versionHash,
      source_modified_at: 300,
      name: "First",
    });
    store.close();
  });

  it("persists prompt and message digests without plaintext content", () => {
    const store = new Store(":memory:");
    const secret = "private author prompt that must never enter SQLite";
    const definition = workflowDefinitionSchema.parse({
      apiVersion: "knot.imai.studio/v1alpha1",
      kind: "KnotWorkflow",
      metadata: { name: "Prompted" },
      spec: {
        triggers: [{ kind: "manual" }],
        steps: [{ id: "ask", kind: "agent", config: { prompt: secret } }],
        capabilities: ["agent.invoke"],
      },
    });

    const stored = store.saveWorkflowVersion(versionRecord(definition));
    expect(stored.canonicalDefinitionJson).not.toContain(secret);
    expect(stored.canonicalApprovalJson).not.toContain(secret);
    expect(stored.canonicalDefinitionJson).toContain('"redacted":true');
    expect(stored.canonicalApprovalJson).toContain('"redacted":true');
    expect(
      JSON.stringify(
        store.db
          .prepare(
            "SELECT canonical_definition_json FROM workflow_versions UNION ALL SELECT canonical_approval_json FROM workflow_approval_subjects",
          )
          .all(),
      ),
    ).not.toContain(secret);
    store.close();
  });

  it("keeps an append-only approval ledger tied to the current authority hash", () => {
    const store = new Store(":memory:");
    const version = store.saveWorkflowVersion(versionRecord());
    const approved = store.recordWorkflowApproval({
      decisionId: "decision-1",
      workflowId: version.workflowId,
      approvalHash: version.approvalHash,
      decision: "approved",
      mode: "automatic",
      authorityHash: "authority-1",
      actorPrincipalDigest: "sha256:operator",
      decidedAt: 300,
      expiresAt: 500,
    });
    expect(approved.sequence).toBe(1);
    expect(
      store.currentWorkflowApproval(version.workflowId, version.approvalHash, "authority-1", 400),
    ).toEqual(approved);
    expect(
      store.currentWorkflowApproval(version.workflowId, version.approvalHash, "authority-2", 400),
    ).toBeUndefined();
    store.recordWorkflowApproval({
      decisionId: "decision-2",
      workflowId: version.workflowId,
      approvalHash: version.approvalHash,
      decision: "revoked",
      mode: "manual",
      authorityHash: "authority-1",
      actorPrincipalDigest: "sha256:operator",
      decidedAt: 401,
      supersedesDecisionId: approved.decisionId,
    });
    expect(
      store.currentWorkflowApproval(version.workflowId, version.approvalHash, "authority-1", 402),
    ).toBeUndefined();
    store.close();
  });

  it("validates approval inputs transactionally and protects audit rows from mutation", () => {
    const store = new Store(":memory:");
    const version = store.saveWorkflowVersion(versionRecord());
    expect(() =>
      store.recordWorkflowApproval({
        decisionId: "invalid-empty-authority",
        workflowId: version.workflowId,
        approvalHash: version.approvalHash,
        decision: "approved",
        mode: "automatic",
        authorityHash: "",
        actorPrincipalDigest: "sha256:operator",
        decidedAt: 300,
      }),
    ).toThrow("authority hash must not be empty");
    expect(() =>
      store.recordWorkflowApproval({
        decisionId: "invalid-expiry",
        workflowId: version.workflowId,
        approvalHash: version.approvalHash,
        decision: "approved",
        mode: "automatic",
        authorityHash: "authority-1",
        actorPrincipalDigest: "sha256:operator",
        decidedAt: 300,
        expiresAt: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow("safe integer");
    expect(
      (
        store.db.prepare("SELECT COUNT(*) AS count FROM workflow_approval_decisions").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(() =>
      store.db
        .prepare("UPDATE workflow_versions SET source_text='tampered' WHERE workflow_id=?")
        .run(version.workflowId),
    ).toThrow("append-only");
    expect(() =>
      store.db
        .prepare("DELETE FROM workflow_approval_subjects WHERE workflow_id=?")
        .run(version.workflowId),
    ).toThrow("append-only");
    store.close();
  });

  it("refuses automatic approval for T2 effects", () => {
    const store = new Store(":memory:");
    const definition = workflowDefinitionSchema.parse({
      apiVersion: "knot.imai.studio/v1alpha1",
      kind: "KnotWorkflow",
      metadata: { name: "External" },
      spec: {
        triggers: [{ kind: "manual" }],
        steps: [{ id: "send", kind: "http", config: { connectionRef: "example" } }],
        capabilities: ["http.request"],
      },
    });
    const version = store.saveWorkflowVersion(versionRecord(definition));
    expect(() =>
      store.recordWorkflowApproval({
        decisionId: "automatic-t2",
        workflowId: version.workflowId,
        approvalHash: version.approvalHash,
        decision: "approved",
        mode: "automatic",
        authorityHash: "authority-1",
        actorPrincipalDigest: "sha256:operator",
        decidedAt: 300,
      }),
    ).toThrow("explicit manual approval");
    expect(
      store.recordWorkflowApproval({
        decisionId: "automatic-t2-rejection",
        workflowId: version.workflowId,
        approvalHash: version.approvalHash,
        decision: "rejected",
        mode: "automatic",
        authorityHash: "authority-1",
        actorPrincipalDigest: "sha256:policy",
        decidedAt: 301,
      }).decision,
    ).toBe("rejected");
    store.close();
  });

  it("deduplicates normalized events without mutating the first immutable fact", () => {
    const store = new Store(":memory:");
    const first = store.recordNormalizedEvent({
      eventId: "event-1",
      dedupeKey: "anytype:space-1:order-1",
      kind: "object.updated",
      source: "poll",
      sourceEventId: "order-1",
      spaceId: "space-1",
      objectId: "object-1",
      observedAt: 100,
      sourceRevision: { modifiedAt: 100, fingerprint: `sha256:${"b".repeat(64)}` },
      editor: {
        principalDigest: `sha256:${"c".repeat(64)}`,
        provenance: "anytype-native",
      },
      payload: { value: 1 },
      causalDepth: 0,
      recordedAt: 101,
    });
    expect(store.recordNormalizedEvent({ ...first, recordedAt: 102 })).toEqual(first);
    expect(() =>
      store.recordNormalizedEvent({
        ...first,
        eventId: "event-2",
        payload: { value: 2 },
        recordedAt: 102,
      }),
    ).toThrow("divergent immutable event");
    expect(
      (
        store.db.prepare("SELECT COUNT(*) AS count FROM normalized_events").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    store.close();
  });

  it("rejects unknown event kinds and unbounded event payloads", () => {
    const store = new Store(":memory:");
    const base = {
      eventId: "event-1",
      dedupeKey: "manual:event-1",
      kind: "manual.run" as const,
      source: "manual" as const,
      spaceId: "space-1",
      observedAt: 100,
      payload: {},
      causalDepth: 0,
      recordedAt: 101,
    };
    expect(() => store.recordNormalizedEvent({ ...base, kind: "unknown" as never })).toThrow();
    expect(() => store.recordNormalizedEvent({ ...base, payload: "x".repeat(1_000_001) })).toThrow(
      "too large",
    );
    store.close();
  });
});

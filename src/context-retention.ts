import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { AgentConfig } from "./config.js";
import { acquireProcessLock } from "./process-lock.js";

type ManagedFile = {
  kind: "attachment" | "context";
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
  usedAt: number;
};
type SessionReferences = { usedAt: number; paths: string[] };
type Registry = {
  version: 1;
  files: Record<string, ManagedFile>;
  sessions: Record<string, SessionReferences>;
};

const holds = new Map<string, number>();

/** Prevent a sweep while a turn is assembling or using not-yet-bound context. */
export function holdWorkspaceContext(config: AgentConfig): () => void {
  const project = config.runtime.defaultProject;
  if (!project) return () => undefined;
  const key = resolve(project);
  holds.set(key, (holds.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (holds.get(key) ?? 1) - 1;
    if (remaining) holds.set(key, remaining);
    else holds.delete(key);
  };
}

/** Create only Knot's own directories without following nested symlinks. */
export async function prepareWorkspaceDirectory(
  config: AgentConfig,
  directory: string,
): Promise<void> {
  const project = resolve(config.runtime.defaultProject!);
  const path = relative(project, directory);
  if (!/^\.aag\/(?:context|attachments\/[a-f0-9]{24})$/u.test(path))
    throw new Error("Unsafe Knot context directory");
  await mkdir(project, { recursive: true, mode: 0o700 });
  let parent = project;
  for (const part of path.split("/")) {
    parent = join(parent, part);
    await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Unsafe Knot context directory");
  }
}

async function registerFiles(registry: Registry, project: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    const local = relative(project, path);
    const kind = validManagedPath(local, "context") ? "context" : "attachment";
    if (!validManagedPath(local, kind) || !(await safeParents(project, local)))
      throw new Error("Unsafe Knot context file location");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe Knot context file");
    registry.files[local] = {
      kind,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ino: info.ino,
      dev: info.dev,
      usedAt: Date.now(),
    };
  }
}

export async function recordWorkspaceSession(
  config: AgentConfig,
  sessionKey: string,
  paths: string[],
): Promise<void> {
  await withRegistry(config, true, async (registry, project) => {
    // Register files and session references atomically. A skipped update must not
    // leave registered media unprotected while its runtime session is active.
    await registerFiles(registry, project, paths);
    const key = sessionHash(sessionKey);
    const previous = registry.sessions[key]?.paths ?? [];
    // Resumed sessions can refer back to media from any earlier turn.
    registry.sessions[key] = {
      usedAt: Date.now(),
      paths: [...new Set([...previous, ...paths.map((path) => relative(project, path))])].filter(
        (path) => registry.files[path],
      ),
    };
  });
}

/** Evict inactive context and unreferenced media; never scan arbitrary project files. */
export async function pruneWorkspaceContext(
  config: AgentConfig,
  activeSessionKeys: string[],
  now = Date.now(),
): Promise<{ removedFiles: number; retainedBytes: number }> {
  const result = { removedFiles: 0, retainedBytes: 0 };
  if (!config.runtime.defaultProject) return result;
  await withRegistry(config, false, async (registry, project) => {
    const active = new Set(activeSessionKeys.map(sessionHash));
    const cutoff = now - config.context.retention.maxAgeDays * 86_400_000;
    const maxBytes = config.context.retention.maxBytes;
    const currentFiles: Array<[string, ManagedFile]> = [];
    for (const [path, file] of Object.entries(registry.files)) {
      if (!(await unchangedManagedFile(project, path, file))) {
        // Replaced, modified, missing or unsafe files no longer belong to cleanup.
        delete registry.files[path];
        continue;
      }
      currentFiles.push([path, file]);
      result.retainedBytes += file.size;
    }
    if (holds.has(project)) return;
    const retainedSessions = new Set(active);
    const sessions = Object.entries(registry.sessions).sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [key, session] of sessions)
      if (active.has(key) || session.usedAt >= cutoff) retainedSessions.add(key);

    // Remove old inactive session references first; under byte pressure release oldest
    // inactive sessions. Active references are a soft-cap exception, never data loss.
    for (const [key] of sessions) {
      if (active.has(key)) continue;
      if (result.retainedBytes > maxBytes || !retainedSessions.has(key)) {
        retainedSessions.delete(key);
        const protectedPaths = referencedPaths(registry, retainedSessions);
        // A retained context JSON must never point at an evicted attachment.
        for (const path of registry.sessions[key]?.paths ?? []) {
          const file = registry.files[path];
          if (!file || file.kind !== "context" || protectedPaths.has(path)) continue;
          if (holds.has(project)) return;
          if (await removeManagedFile(project, path, file)) {
            delete registry.files[path];
            result.removedFiles += 1;
            result.retainedBytes -= file.size;
          }
        }
        delete registry.sessions[key];
        for (const [path, file] of currentFiles) {
          if (!registry.files[path] || protectedPaths.has(path)) continue;
          if (holds.has(project)) return;
          if (file.usedAt >= cutoff && result.retainedBytes <= maxBytes) continue;
          if (await removeManagedFile(project, path, file)) {
            delete registry.files[path];
            result.removedFiles += 1;
            result.retainedBytes -= file.size;
          }
        }
      }
    }
    const protectedPaths = referencedPaths(registry, retainedSessions);
    for (const [path, file] of currentFiles.sort((a, b) => a[1].usedAt - b[1].usedAt)) {
      if (holds.has(project)) return;
      if (!registry.files[path] || protectedPaths.has(path)) continue;
      if (file.usedAt >= cutoff && result.retainedBytes <= maxBytes) continue;
      if (await removeManagedFile(project, path, file)) {
        delete registry.files[path];
        result.removedFiles += 1;
        result.retainedBytes -= file.size;
      }
    }
  });
  return result;
}

function referencedPaths(registry: Registry, retainedSessions: Set<string>): Set<string> {
  return new Set([...retainedSessions].flatMap((key) => registry.sessions[key]?.paths ?? []));
}

function sessionHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validRegistry(value: unknown): value is Registry {
  if (
    !plainRecord(value) ||
    value.version !== 1 ||
    !plainRecord(value.files) ||
    !plainRecord(value.sessions)
  )
    return false;
  for (const [path, file] of Object.entries(value.files)) {
    if (
      !plainRecord(file) ||
      (file.kind !== "context" && file.kind !== "attachment") ||
      !validManagedPath(path, file.kind) ||
      ![file.size, file.ino, file.dev].every(
        (field) => nonnegativeNumber(field) && Number.isInteger(field),
      ) ||
      !nonnegativeNumber(file.mtimeMs) ||
      !nonnegativeNumber(file.usedAt)
    )
      return false;
  }
  for (const [key, session] of Object.entries(value.sessions)) {
    if (
      !/^[a-f0-9]{64}$/u.test(key) ||
      !plainRecord(session) ||
      !nonnegativeNumber(session.usedAt) ||
      !Array.isArray(session.paths) ||
      !session.paths.every(
        (path) =>
          typeof path === "string" &&
          (validManagedPath(path, "context") || validManagedPath(path, "attachment")),
      )
    )
      return false;
  }
  return true;
}

function validManagedPath(path: string, kind: ManagedFile["kind"]): boolean {
  return kind === "context"
    ? /^\.aag\/context\/[a-f0-9]{20}\.json$/u.test(path)
    : kind === "attachment" &&
        /^\.aag\/attachments\/[a-f0-9]{24}\/[a-f0-9]{24}\.(?:gif|jpg|png|webp|mp4|mov|mp3|wav|pdf|bin)$/u.test(
          path,
        );
}

async function safeParents(project: string, path: string): Promise<boolean> {
  const parts = path.split("/").slice(0, -1);
  let parent = project;
  for (const part of parts) {
    parent = join(parent, part);
    const info = await lstat(parent).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) return false;
  }
  return true;
}

async function unchangedManagedFile(
  project: string,
  path: string,
  file: ManagedFile,
): Promise<boolean> {
  if (!validManagedPath(path, file.kind) || !(await safeParents(project, path))) return false;
  const info = await lstat(join(project, path)).catch(() => undefined);
  return !!(
    info?.isFile() &&
    !info.isSymbolicLink() &&
    info.size === file.size &&
    info.mtimeMs === file.mtimeMs &&
    info.ino === file.ino &&
    info.dev === file.dev
  );
}

async function removeManagedFile(
  project: string,
  path: string,
  file: ManagedFile,
): Promise<boolean> {
  if (!(await unchangedManagedFile(project, path, file)) || holds.has(project)) return false;
  await unlink(join(project, path));
  if (file.kind === "attachment") await rmdir(dirname(join(project, path))).catch(() => undefined);
  return true;
}

async function withRegistry(
  config: AgentConfig,
  createIfMissing: boolean,
  operation: (registry: Registry, project: string) => Promise<void>,
): Promise<void> {
  if (!config.runtime.defaultProject) return;
  const project = resolve(config.runtime.defaultProject);
  const registryPath = join(
    dirname(resolve(config.state.path)),
    `context-${sessionHash(project)}.json`,
  );
  const temporary = `${registryPath}.${randomUUID()}.tmp`;
  let release: (() => Promise<void>) | undefined;
  try {
    // Retention is best effort: contention or inaccessible state must never delay
    // attachment delivery or prevent the runtime from receiving its prompt.
    release = await acquireProcessLock(`${registryPath}.lock`, {
      attempts: 1,
      waitMilliseconds: 0,
    });
    const info = await lstat(registryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info && (!info.isFile() || info.isSymbolicLink())) return;
    if (!info && !createIfMissing) return;
    const registry: unknown = info
      ? JSON.parse(await readFile(registryPath, "utf8"))
      : { version: 1, files: {}, sessions: {} };
    // Validate everything before considering a single deletion. Preserve corrupt
    // evidence for the operator; do not replace it with an empty or partial map.
    if (!validRegistry(registry)) return;
    await operation(registry, project);
    await writeFile(temporary, `${JSON.stringify(registry)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, registryPath);
  } catch {
    // Unregistered files remain unmanaged. A later successful turn can register
    // them, while damaged registry data requires operator repair.
  } finally {
    await unlink(temporary).catch(() => undefined);
    await release?.().catch(() => undefined);
  }
}

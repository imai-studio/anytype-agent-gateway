import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { acquireProcessLock } from "./process-lock.js";
const holds = new Map();
/** Prevent a sweep while a turn is assembling or using not-yet-bound context. */
export function holdWorkspaceContext(config) {
    const project = config.runtime.defaultProject;
    if (!project)
        return () => undefined;
    const key = resolve(project);
    holds.set(key, (holds.get(key) ?? 0) + 1);
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        const remaining = (holds.get(key) ?? 1) - 1;
        if (remaining)
            holds.set(key, remaining);
        else
            holds.delete(key);
    };
}
/** Create only Knot's own directories without following nested symlinks. */
export async function prepareWorkspaceDirectory(config, directory) {
    const project = resolve(config.runtime.defaultProject);
    const path = relative(project, directory);
    if (!/^\.aag\/(?:context|attachments\/[a-f0-9]{24})$/u.test(path))
        throw new Error("Unsafe Knot context directory");
    await mkdir(project, { recursive: true, mode: 0o700 });
    let parent = project;
    for (const part of path.split("/")) {
        parent = join(parent, part);
        await mkdir(parent, { mode: 0o700 }).catch((error) => {
            if (error.code !== "EEXIST")
                throw error;
        });
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("Unsafe Knot context directory");
    }
}
async function registerFiles(registry, project, paths) {
    for (const path of paths) {
        const local = relative(project, path);
        const kind = validManagedPath(local, "context") ? "context" : "attachment";
        if (!validManagedPath(local, kind) || !(await safeParents(project, local)))
            throw new Error("Unsafe Knot context file location");
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink())
            throw new Error("Unsafe Knot context file");
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
export async function recordWorkspaceSession(config, sessionKey, paths) {
    return withRegistry(config, true, async (registry, project) => {
        // Register files and session references atomically. A skipped update must not
        // leave registered media unprotected while its runtime session is active.
        await registerFiles(registry, project, paths);
        const key = sessionHash(sessionKey);
        const previous = registry.sessions[key]?.paths ?? [];
        // Resumed sessions can refer back to media from any earlier turn.
        registry.sessions[key] = {
            usedAt: Date.now(),
            paths: [...new Set([...previous, ...paths.map((path) => relative(project, path))])].filter((path) => registry.files[path]),
        };
    });
}
/** Evict inactive context and unreferenced media; never scan arbitrary project files. */
export async function pruneWorkspaceContext(config, activeSessionKeys, now = Date.now()) {
    const result = { removedFiles: 0, retainedBytes: 0 };
    const maintenance = await withRegistry(config, false, async (registry, project) => {
        const active = new Set(activeSessionKeys.map(sessionHash));
        const cutoff = now - config.context.retention.maxAgeDays * 86_400_000;
        const maxBytes = config.context.retention.maxBytes;
        const currentFiles = [];
        for (const [path, file] of Object.entries(registry.files)) {
            if (!(await unchangedManagedFile(project, path, file))) {
                // Replaced, modified, missing or unsafe files no longer belong to cleanup.
                delete registry.files[path];
                continue;
            }
            currentFiles.push([path, file]);
            result.retainedBytes += file.size;
        }
        if (holds.has(project))
            return;
        const retainedSessions = new Set(active);
        const sessions = Object.entries(registry.sessions).sort((a, b) => a[1].usedAt - b[1].usedAt);
        for (const [key, session] of sessions)
            if (active.has(key) || session.usedAt >= cutoff)
                retainedSessions.add(key);
        // Remove old inactive session references first; under byte pressure release oldest
        // inactive sessions. Active references are a soft-cap exception, never data loss.
        for (const [key] of sessions) {
            if (active.has(key))
                continue;
            if (result.retainedBytes > maxBytes || !retainedSessions.has(key)) {
                retainedSessions.delete(key);
                const protectedPaths = referencedPaths(registry, retainedSessions);
                // A retained context JSON must never point at an evicted attachment.
                for (const path of registry.sessions[key]?.paths ?? []) {
                    const file = registry.files[path];
                    if (!file || file.kind !== "context" || protectedPaths.has(path))
                        continue;
                    if (holds.has(project))
                        return;
                    if (await removeManagedFile(project, path, file)) {
                        delete registry.files[path];
                        result.removedFiles += 1;
                        result.retainedBytes -= file.size;
                    }
                }
                delete registry.sessions[key];
                for (const [path, file] of currentFiles) {
                    if (!registry.files[path] || protectedPaths.has(path))
                        continue;
                    if (holds.has(project))
                        return;
                    if (file.usedAt >= cutoff && result.retainedBytes <= maxBytes)
                        continue;
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
            if (holds.has(project))
                return;
            if (!registry.files[path] || protectedPaths.has(path))
                continue;
            if (file.usedAt >= cutoff && result.retainedBytes <= maxBytes)
                continue;
            if (await removeManagedFile(project, path, file)) {
                delete registry.files[path];
                result.removedFiles += 1;
                result.retainedBytes -= file.size;
            }
        }
    });
    return { ...result, ...maintenance };
}
/** Inspect registry and recorded files without locks, writes, repairs or cleanup. */
export async function inspectContextRegistry(config) {
    if (!config.runtime.defaultProject)
        return { status: "disabled", lock: "not-applicable" };
    const project = resolve(config.runtime.defaultProject);
    const path = registryPathFor(config, project);
    const lock = await lstat(`${path}.lock`).then(() => "present", (error) => error.code === "ENOENT" ? "absent" : "unreadable");
    const loaded = await readRegistry(path);
    if (loaded.status !== "ready")
        return { status: loaded.status, lock };
    let managedFiles = 0;
    let managedBytes = 0;
    for (const [local, file] of Object.entries(loaded.registry.files)) {
        if (await unchangedManagedFile(project, local, file)) {
            managedFiles += 1;
            managedBytes += file.size;
        }
    }
    return {
        status: "ready",
        lock,
        registeredFiles: Object.keys(loaded.registry.files).length,
        managedFiles,
        managedBytes,
    };
}
export function contextRegistryDoctorLine(diagnostics) {
    const healthy = diagnostics.status === "ready" || diagnostics.status === "disabled";
    return `${healthy ? "ok" : "warning"}: context retention registry (status=${diagnostics.status}, registered_files=${diagnostics.registeredFiles ?? "unavailable"}, managed_files=${diagnostics.managedFiles ?? "unavailable"}, managed_bytes=${diagnostics.managedBytes ?? "unavailable"}, lock=${diagnostics.lock})`;
}
function referencedPaths(registry, retainedSessions) {
    return new Set([...retainedSessions].flatMap((key) => registry.sessions[key]?.paths ?? []));
}
function sessionHash(key) {
    return createHash("sha256").update(key).digest("hex");
}
function plainRecord(value) {
    return (value !== null &&
        typeof value === "object" &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}
function nonnegativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function validRegistry(value) {
    if (!plainRecord(value) ||
        value.version !== 1 ||
        !plainRecord(value.files) ||
        !plainRecord(value.sessions))
        return false;
    for (const [path, file] of Object.entries(value.files)) {
        if (!plainRecord(file) ||
            (file.kind !== "context" && file.kind !== "attachment") ||
            !validManagedPath(path, file.kind) ||
            ![file.size, file.ino, file.dev].every((field) => nonnegativeNumber(field) && Number.isInteger(field)) ||
            !nonnegativeNumber(file.mtimeMs) ||
            !nonnegativeNumber(file.usedAt))
            return false;
    }
    for (const [key, session] of Object.entries(value.sessions)) {
        if (!/^[a-f0-9]{64}$/u.test(key) ||
            !plainRecord(session) ||
            !nonnegativeNumber(session.usedAt) ||
            !Array.isArray(session.paths) ||
            !session.paths.every((path) => typeof path === "string" &&
                (validManagedPath(path, "context") || validManagedPath(path, "attachment"))))
            return false;
    }
    return true;
}
function validManagedPath(path, kind) {
    return kind === "context"
        ? /^\.aag\/context\/[a-f0-9]{20}\.json$/u.test(path)
        : kind === "attachment" &&
            /^\.aag\/attachments\/[a-f0-9]{24}\/[a-f0-9]{24}\.(?:gif|jpg|png|webp|mp4|mov|mp3|wav|pdf|bin)$/u.test(path);
}
async function safeParents(project, path) {
    const parts = path.split("/").slice(0, -1);
    let parent = project;
    for (const part of parts) {
        parent = join(parent, part);
        const info = await lstat(parent).catch(() => undefined);
        if (!info?.isDirectory() || info.isSymbolicLink())
            return false;
    }
    return true;
}
async function unchangedManagedFile(project, path, file) {
    if (!validManagedPath(path, file.kind) || !(await safeParents(project, path)))
        return false;
    const info = await lstat(join(project, path)).catch(() => undefined);
    return !!(info?.isFile() &&
        !info.isSymbolicLink() &&
        info.size === file.size &&
        info.mtimeMs === file.mtimeMs &&
        info.ino === file.ino &&
        info.dev === file.dev);
}
async function removeManagedFile(project, path, file) {
    if (!(await unchangedManagedFile(project, path, file)) || holds.has(project))
        return false;
    await unlink(join(project, path));
    if (file.kind === "attachment")
        await rmdir(dirname(join(project, path))).catch(() => undefined);
    return true;
}
async function withRegistry(config, createIfMissing, operation) {
    if (!config.runtime.defaultProject)
        return { status: "skipped", reason: "disabled" };
    const project = resolve(config.runtime.defaultProject);
    const registryPath = registryPathFor(config, project);
    const temporary = `${registryPath}.${randomUUID()}.tmp`;
    let release;
    let failure = "lock-unavailable";
    try {
        // Retention is best effort: contention or inaccessible state must never delay
        // attachment delivery or prevent the runtime from receiving its prompt.
        release = await acquireProcessLock(`${registryPath}.lock`, {
            // A second immediate attempt can acquire the lock after reclaiming a dead
            // owner. Live contention still throws immediately because wait is zero.
            attempts: 2,
            waitMilliseconds: 0,
            contentionMessage: () => {
                failure = "lock-contended";
                return "Context registry is locked";
            },
        });
        const loaded = await readRegistry(registryPath);
        if (loaded.status !== "ready" && !(loaded.status === "missing" && createIfMissing))
            return { status: "skipped", reason: loaded.status };
        const registry = loaded.status === "ready" ? loaded.registry : { version: 1, files: {}, sessions: {} };
        // Validate everything before considering a single deletion. Preserve corrupt
        // evidence for the operator; do not replace it with an empty or partial map.
        failure = createIfMissing ? "registration-failed" : "cleanup-failed";
        await operation(registry, project);
        failure = "write-failed";
        await writeFile(temporary, `${JSON.stringify(registry)}\n`, { mode: 0o600, flag: "wx" });
        await rename(temporary, registryPath);
        return { status: "ok" };
    }
    catch {
        // Unregistered files remain unmanaged. A later successful turn can register
        // them, while damaged registry data requires operator repair. Never expose
        // an OS error message here: it can include private paths or session data.
        return { status: "skipped", reason: failure };
    }
    finally {
        await unlink(temporary).catch(() => undefined);
        await release?.().catch(() => undefined);
    }
}
function registryPathFor(config, project) {
    return join(dirname(resolve(config.state.path)), `context-${sessionHash(project)}.json`);
}
async function readRegistry(path) {
    let contents;
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink())
            return { status: "nonregular" };
        contents = await readFile(path, "utf8");
    }
    catch (error) {
        return {
            status: error.code === "ENOENT" ? "missing" : "unreadable",
        };
    }
    let registry;
    try {
        registry = JSON.parse(contents);
    }
    catch {
        return { status: "invalid-json" };
    }
    return validRegistry(registry) ? { status: "ready", registry } : { status: "invalid-schema" };
}

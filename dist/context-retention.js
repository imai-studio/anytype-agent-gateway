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
/** Record only files this process just wrote, outside the runtime project. */
export async function recordWorkspaceFile(config, path, kind) {
    await withRegistry(config, async (registry, project) => {
        const local = relative(project, path);
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
    });
}
export async function recordWorkspaceSession(config, sessionKey, paths) {
    await withRegistry(config, async (registry, project) => {
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
    if (!config.runtime.defaultProject)
        return result;
    await withRegistry(config, async (registry, project) => {
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
    return result;
}
function referencedPaths(registry, retainedSessions) {
    return new Set([...retainedSessions].flatMap((key) => registry.sessions[key]?.paths ?? []));
}
function sessionHash(key) {
    return createHash("sha256").update(key).digest("hex");
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
async function withRegistry(config, operation) {
    if (!config.runtime.defaultProject)
        return;
    const project = resolve(config.runtime.defaultProject);
    const registryPath = join(dirname(resolve(config.state.path)), `context-${sessionHash(project)}.json`);
    await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
    const release = await acquireProcessLock(`${registryPath}.lock`, {
        attempts: 101,
        waitMilliseconds: 20,
        contentionMessage: () => "Another process is maintaining Knot context files",
    });
    const temporary = `${registryPath}.${randomUUID()}.tmp`;
    try {
        const contents = await readFile(registryPath, "utf8").catch((error) => {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        });
        const registry = contents
            ? JSON.parse(contents)
            : { version: 1, files: {}, sessions: {} };
        if (registry.version !== 1 || !registry.files || !registry.sessions)
            throw new Error("Invalid Knot context retention registry");
        await operation(registry, project);
        await writeFile(temporary, `${JSON.stringify(registry)}\n`, { mode: 0o600, flag: "wx" });
        await rename(temporary, registryPath);
    }
    finally {
        await unlink(temporary).catch(() => undefined);
        await release();
    }
}

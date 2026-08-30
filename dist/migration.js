import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink, } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse, stringify } from "yaml";
import { acquireCompatibleProcessLocks } from "./process-lock.js";
import { resolveStatePath } from "./compatibility.js";
const replayTables = [
    "cursors",
    "handled_messages",
    "handled_message_versions",
    "session_generations",
    "session_bindings",
    "route_wake_overrides",
    "outbound_outbox",
    "proactive_deliveries",
    "bridge_cursors",
];
export function migrationPaths(home = homedir(), legacyStatePath) {
    const defaultState = join(home, ".local", "state", "aag", "state.sqlite");
    const statePath = resolve(legacyStatePath ?? defaultState);
    const stateMarker = `${sep}.local${sep}state${sep}aag${sep}`;
    if (!statePath.includes(stateMarker))
        throw new Error(`Legacy state path is outside the migratable AAG state tree: ${statePath}. Configure an AAG path beneath ~/.local/state/aag before migration.`);
    const stateSource = dirname(statePath);
    const stateDestination = dirname(statePath.replace(stateMarker, `${sep}.local${sep}state${sep}knot${sep}`));
    const paths = [
        ["config", join(home, ".config", "aag"), join(home, ".config", "knot")],
        ["state", stateSource, stateDestination],
        ["support", join(home, ".local", "share", "aag"), join(home, ".local", "share", "knot")],
        [
            "logs",
            join(home, "Library", "Logs", "AnytypeAgentGateway"),
            join(home, "Library", "Logs", "Knot"),
        ],
    ];
    return paths.map(([kind, source, destination]) => ({
        kind,
        source,
        destination,
        status: "copy",
    }));
}
export async function migrateInstallation(options = {}) {
    const home = resolve(options.home ?? homedir());
    await assertSafeHome(home);
    const legacyState = await resolvedLegacyStatePath(home);
    const items = migrationPaths(home, legacyState);
    for (const item of items) {
        if (!(await exists(item.source)))
            item.status = "missing";
        else if (await exists(item.destination)) {
            await verifyTree(item.source, item.destination, item.kind === "config" ? configTransform : undefined);
            item.status = "verified";
        }
    }
    const rollback = [
        "The legacy source is untouched; stop any Knot process and restart AAG with its original configuration and state",
    ];
    if (options.dryRun)
        return { version: 1, dryRun: true, state: "planned", items, rollback };
    const release = await acquireCompatibleProcessLocks(legacyState, { attempts: 2 });
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/gu, "-");
    const manifestDirectory = join(home, ".local", "state", "knot-migration-manifests");
    let copied = 0;
    try {
        for (const item of items) {
            if (item.status !== "copy")
                continue;
            await copyTreeAtomic(item.source, item.destination, item.kind === "config" ? configTransform : undefined);
            await verifyTree(item.source, item.destination, item.kind === "config" ? configTransform : undefined);
            item.status = "verified";
            copied += 1;
            if (options.interruptAfterCopies === copied)
                throw new Error("simulated migration interruption");
        }
        await mkdir(manifestDirectory, { recursive: true, mode: 0o700 });
        const manifest = join(manifestDirectory, `${stamp}.json`);
        const result = {
            version: 1,
            dryRun: false,
            state: "complete",
            items,
            manifest,
            rollback,
        };
        await writeAtomic(manifest, `${JSON.stringify(result, null, 2)}\n`, 0o600);
        return result;
    }
    finally {
        await release();
    }
}
export async function latestMigrationManifest(home = homedir()) {
    const directory = join(resolve(home), ".local", "state", "knot-migration-manifests");
    const names = (await readdir(directory).catch(() => []))
        .filter((name) => /^\d{4}-.*\.json$/u.test(name))
        .sort();
    const name = names.at(-1);
    if (!name)
        return undefined;
    const value = JSON.parse(await readFile(join(directory, name), "utf8"));
    if (value.version !== 1 || value.state !== "complete" || value.dryRun)
        throw new Error(`Invalid migration manifest: ${join(directory, name)}`);
    return value;
}
async function configTransform(source, destination, contents) {
    if (basename(source) !== "agent.yaml")
        return contents;
    const document = rewriteLegacyPaths(parse(contents.toString("utf8")));
    const state = document.state && typeof document.state === "object"
        ? document.state
        : {};
    if (typeof state.path !== "string") {
        const marker = `${sep}.config${sep}aag${sep}`;
        const index = source.indexOf(marker);
        if (index < 0)
            throw new Error(`Could not derive the migrated state path from ${source}`);
        state.path = join(source.slice(0, index), ".local", "state", "knot", "state.sqlite");
    }
    document.state = state;
    return Buffer.from(stringify(document), "utf8");
}
function rewriteLegacyPaths(value) {
    if (typeof value === "string")
        return value
            .replaceAll(/\/\.config\/aag(?=\/|$)/gu, "/.config/knot")
            .replaceAll(/\/\.local\/state\/aag(?=\/|$)/gu, "/.local/state/knot")
            .replaceAll(/\/\.local\/share\/aag(?=\/|$)/gu, "/.local/share/knot")
            .replaceAll(/\/Library\/Logs\/AnytypeAgentGateway(?=\/|$)/gu, "/Library/Logs/Knot");
    if (Array.isArray(value))
        return value.map(rewriteLegacyPaths);
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteLegacyPaths(item)]));
    return value;
}
async function copyTreeAtomic(source, destination, transform) {
    const sourceInfo = await lstat(source);
    if (sourceInfo.isSymbolicLink())
        throw new Error(`Refusing symbolic-link migration source: ${source}`);
    if (!sourceInfo.isDirectory())
        throw new Error(`Migration source is not a directory: ${source}`);
    await ensureSafeDestination(destination);
    const temporary = `${destination}.migrating.${process.pid}.${randomUUID()}`;
    await mkdir(temporary, { recursive: false, mode: sourceInfo.mode & 0o777 });
    try {
        await copyDirectoryContents(source, temporary, transform);
        await chmod(temporary, sourceInfo.mode & 0o7777);
        await syncDirectory(temporary);
        await rename(temporary, destination);
        await syncDirectory(dirname(destination));
    }
    catch (error) {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}
async function copyDirectoryContents(source, destination, transform) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
        if (ignoredRuntimeFile(entry.name))
            continue;
        const from = join(source, entry.name);
        const to = join(destination, entry.name);
        const info = await lstat(from);
        if (info.isSymbolicLink())
            throw new Error(`Refusing symbolic link: ${from}`);
        if (info.isDirectory()) {
            await mkdir(to, { mode: info.mode & 0o7777 });
            await copyDirectoryContents(from, to, transform);
            await chmod(to, info.mode & 0o7777);
            await syncDirectory(to);
        }
        else if (info.isFile()) {
            const contents = transform ? await transform(from, to, await readFile(from)) : undefined;
            if (contents)
                await writeAtomic(to, contents, info.mode & 0o7777);
            else {
                await copyFile(from, to, constants.COPYFILE_EXCL);
                await chmod(to, info.mode & 0o7777);
                const handle = await open(to, "r");
                await handle.sync();
                await handle.close();
            }
        }
        else
            throw new Error(`Refusing non-regular migration source: ${from}`);
    }
}
async function verifyTree(source, destination, transform) {
    const sourceFiles = await regularFiles(source);
    const destinationFiles = await regularFiles(destination);
    if (sourceFiles.join("\n") !== destinationFiles.join("\n"))
        throw new Error(`Divergent migration destination: ${destination} has a different file set`);
    for (const name of sourceFiles) {
        const from = join(source, name);
        const to = join(destination, name);
        const expected = transform
            ? await transform(from, to, await readFile(from))
            : await readFile(from);
        const actual = await readFile(to);
        if (expected.length !== actual.length || digest(expected) !== digest(actual))
            throw new Error(`Divergent migration destination file: ${to}`);
        if (name.endsWith(".sqlite"))
            await verifySqlite(to);
    }
}
async function verifySqlite(destination) {
    const directory = await mkdtemp(join(tmpdir(), "knot-sqlite-verify-"));
    const copy = join(directory, "state.sqlite");
    try {
        await copyFile(destination, copy, constants.COPYFILE_EXCL);
        sqliteSnapshot(copy);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}
async function resolvedLegacyStatePath(home) {
    const configPath = join(home, ".config", "aag", "agent.yaml");
    let explicit;
    if (await exists(configPath)) {
        const raw = parse(await readFile(configPath, "utf8"));
        if (typeof raw.state?.path === "string")
            explicit = raw.state.path;
    }
    return resolveStatePath({ ...(explicit ? { explicit } : {}), home });
}
function sqliteSnapshot(path) {
    const db = new DatabaseSync(path);
    try {
        const quick = db.prepare("PRAGMA quick_check").all();
        const integrity = db.prepare("PRAGMA integrity_check").all();
        if (JSON.stringify(quick) !== '[{"quick_check":"ok"}]' ||
            JSON.stringify(integrity) !== '[{"integrity_check":"ok"}]')
            throw new Error(`SQLite integrity check failed: ${path}`);
        const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
        const tables = {};
        for (const table of replayTables) {
            if (!present.has(table))
                continue;
            const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
            tables[table] = db
                .prepare(`SELECT * FROM ${table} ORDER BY ${columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(",")}`)
                .all();
        }
        return { userVersion: db.prepare("PRAGMA user_version").get(), tables };
    }
    finally {
        db.close();
    }
}
async function regularFiles(root) {
    const output = [];
    async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (ignoredRuntimeFile(entry.name))
                continue;
            const path = join(directory, entry.name);
            const info = await lstat(path);
            if (info.isSymbolicLink())
                throw new Error(`Refusing symbolic link: ${path}`);
            if (info.isDirectory())
                await visit(path);
            else if (info.isFile())
                output.push(relative(root, path));
            else
                throw new Error(`Refusing non-regular path: ${path}`);
        }
    }
    await visit(root);
    return output.sort();
}
function ignoredRuntimeFile(name) {
    if (name.endsWith("-wal") || name.endsWith("-shm"))
        throw new Error(`Refusing SQLite migration while a sidecar exists: ${name}`);
    return name.endsWith(".lock") || name.includes(".stale.") || name.includes(".migrating.");
}
async function ensureSafeDestination(destination) {
    if (await exists(destination))
        throw new Error(`Destination appeared during migration: ${destination}`);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const parent = await realpath(dirname(destination));
    if (resolve(parent, basename(destination)) !== resolve(destination))
        throw new Error(`Unsafe migration destination: ${destination}`);
}
async function assertSafeHome(home) {
    const info = await lstat(home);
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`Unsafe migration home: ${home}`);
    const canonical = await realpath(home);
    if (canonical !== home || home === sep)
        throw new Error(`Migration home must be a canonical directory: ${home}`);
}
async function writeAtomic(path, contents, mode) {
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", mode);
    try {
        await handle.writeFile(contents);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, mode);
    await syncDirectory(dirname(path));
    await unlink(temporary).catch(() => undefined);
}
async function syncDirectory(path) {
    const handle = await open(path, "r");
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
function digest(contents) {
    return createHash("sha256").update(contents).digest("hex");
}
async function exists(path) {
    return access(path)
        .then(() => true)
        .catch(() => false);
}

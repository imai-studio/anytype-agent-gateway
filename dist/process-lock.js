import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
export async function acquireProcessLock(path, options = {}) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const pid = options.pid ?? process.pid;
    const probe = options.probe ?? process.kill.bind(process);
    const owner = `${pid} ${crypto.randomUUID()}\n`;
    const attempts = options.attempts ?? 20;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
            try {
                await handle.writeFile(owner);
            }
            catch (error) {
                await handle.close().catch(() => undefined);
                await unlink(path).catch(() => undefined);
                throw error;
            }
            await handle.close();
            return async () => {
                const current = await readFile(path, "utf8").catch(() => undefined);
                if (current === owner)
                    await unlink(path).catch(() => undefined);
            };
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const observed = await readFile(path, "utf8").catch(() => undefined);
            if (observed === undefined)
                continue;
            const ownerPid = Number.parseInt(observed.trim().split(/\s+/u)[0] ?? "0", 10);
            if (!ownerPid) {
                await new Promise((resolve) => setTimeout(resolve, 10));
                continue;
            }
            if (ownerPid > 0 && processIsLive(ownerPid, probe))
                throw new Error(`Another AAG process is already running (pid ${ownerPid})`);
            const stalePath = `${path}.stale.${pid}.${crypto.randomUUID()}`;
            try {
                await rename(path, stalePath);
            }
            catch (staleError) {
                if (staleError.code === "ENOENT")
                    continue;
                throw staleError;
            }
            const moved = await readFile(stalePath, "utf8").catch(() => undefined);
            if (moved !== observed) {
                await rename(stalePath, path).catch(() => undefined);
                continue;
            }
            await unlink(stalePath).catch(() => undefined);
        }
    }
    throw new Error(`Could not acquire AAG process lock: ${path}`);
}
function processIsLive(pid, probe) {
    try {
        probe(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM means the process exists but this user cannot signal it.
        return error.code === "EPERM";
    }
}

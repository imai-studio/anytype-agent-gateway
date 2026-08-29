import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import YAML from "yaml";
import { AnytypeClient } from "./anytype-client.js";
import { configSchema, loadConfig } from "./config.js";
import { acquireProcessLock } from "./process-lock.js";
import { Store } from "./store.js";
import { sameIdentity } from "./wake.js";
const humanModes = ["mention", "mention-or-reply", "every-message", "prefix", "disabled"];
export async function enrollChatRoute(input) {
    return withConfigWriteLock(input.configPath, async () => {
        const configFile = await resolveConfigFile(input.configPath, input.spaceId, input.spaceName);
        const parsedSpace = configFile.parsed.spaces[configFile.spaceIndex];
        if (!parsedSpace.chatDiscovery.enabled || !parsedSpace.chatDiscovery.autoEnroll)
            return "disabled";
        if (parsedSpace.chats.some((chat) => chat.id === input.chatId))
            return "existing";
        const rawSpace = configFile.rawSpaces[configFile.spaceIndex];
        const chats = Array.isArray(rawSpace.chats)
            ? rawSpace.chats
            : [];
        chats.push({ id: input.chatId, name: input.chatName, wake: input.wake });
        rawSpace.chats = chats;
        configSchema.parse(configFile.raw);
        await writePrivateFileAtomic(configFile.absolute, serializeConfig(configFile.raw, configFile.extension));
        return "enrolled";
    });
}
export async function setRouteWake(input) {
    if (!humanModes.includes(input.humans))
        throw new Error(`Invalid human wake mode: ${input.humans}`);
    if (input.humans === "prefix" && !input.prefix)
        throw new Error("--prefix is required when --humans is prefix");
    const spaceName = await resolveRouteSpaceName(input.configPath, input.routeId);
    await withConfigWriteLock(input.configPath, async () => {
        const route = await resolveRouteConfig(input.configPath, input.routeId, spaceName);
        if (!route.parsed.management.allowWakeChanges)
            throw new Error("management.allowWakeChanges is disabled");
        const wake = { ...route.base, humans: input.humans };
        if (input.humans === "prefix")
            wake.prefix = input.prefix;
        else
            delete wake.prefix;
        await persistRouteWake(route, wake);
    });
}
export async function setRouteAccess(input) {
    if (!["add", "remove", "replace"].includes(input.operation))
        throw new Error(`Invalid access operation: ${input.operation}`);
    const participantIds = [
        ...new Set(input.participantIds.map((participant) => participant.trim()).filter(Boolean)),
    ];
    if (!participantIds.length)
        throw new Error("At least one participant ID is required");
    if (participantIds.includes("*"))
        throw new Error("Self-management cannot grant wildcard access; edit the operator config manually");
    const spaceName = await resolveRouteSpaceName(input.configPath, input.routeId);
    return withConfigWriteLock(input.configPath, async () => {
        const route = await resolveRouteConfig(input.configPath, input.routeId, spaceName);
        if (!route.parsed.management.allowAccessChanges)
            throw new Error("management.allowAccessChanges is disabled");
        if (!route.parsed.management.accessAdmins.some((participant) => sameIdentity(input.actorId, participant)))
            throw new Error("Only a configured access admin may change the route allowlist");
        const admins = route.parsed.management.accessAdmins;
        let allowedUsers;
        if (input.operation === "add")
            allowedUsers = [...route.base.allowedUsers, ...participantIds, ...admins];
        else if (input.operation === "remove") {
            if (participantIds.some((candidate) => admins.some((admin) => sameIdentity(candidate, admin))))
                throw new Error("An access admin cannot remove an access admin from the route allowlist");
            allowedUsers = route.base.allowedUsers.filter((candidate) => !participantIds.some((participant) => sameIdentity(candidate, participant)));
        }
        else
            allowedUsers = [...participantIds, ...admins];
        allowedUsers = allowedUsers.filter((participant, index, all) => all.findIndex((candidate) => sameIdentity(candidate, participant)) === index);
        if (!allowedUsers.length)
            throw new Error("A route allowlist cannot be empty");
        await persistRouteWake(route, { ...route.base, allowedUsers });
        return allowedUsers;
    });
}
async function resolveRouteConfig(configPath, routeId, knownSpaceName) {
    const match = /^(chat|discussion):([^:]+):(.+)$/.exec(routeId);
    if (!match)
        throw new Error("Route ID must be chat:<space-id>:<chat-id> or discussion:<space-id>:<discussion-id>");
    const kind = match[1];
    const spaceId = match[2];
    const id = match[3];
    const configFile = await resolveConfigFile(configPath, spaceId, knownSpaceName);
    const parsedSpace = configFile.parsed.spaces[configFile.spaceIndex];
    const existing = parsedSpace.wakeOverrides.find((item) => item.kind === kind && item.id === id);
    const base = existing?.wake ??
        (kind === "chat"
            ? (parsedSpace.chats.find((chat) => chat.id === id)?.wake ?? parsedSpace.chatDiscovery.wake)
            : parsedSpace.comments.wake);
    return {
        absolute: configFile.absolute,
        extension: configFile.extension,
        raw: configFile.raw,
        parsed: configFile.parsed,
        rawSpace: configFile.rawSpaces[configFile.spaceIndex],
        kind,
        id,
        routeId,
        base,
    };
}
async function persistRouteWake(route, wake) {
    const overrides = Array.isArray(route.rawSpace.wakeOverrides)
        ? route.rawSpace.wakeOverrides
        : [];
    const overrideIndex = overrides.findIndex((item) => item.kind === route.kind && item.id === route.id);
    const next = { kind: route.kind, id: route.id, wake };
    if (overrideIndex < 0)
        overrides.push(next);
    else
        overrides[overrideIndex] = next;
    route.rawSpace.wakeOverrides = overrides;
    configSchema.parse(route.raw);
    await writePrivateFileAtomic(route.absolute, serializeConfig(route.raw, route.extension));
    const config = await loadConfig(route.absolute);
    const store = new Store(config.state.path);
    try {
        store.setWakeOverride(route.routeId, wake.humans, wake.prefix, wake.allowedUsers);
    }
    finally {
        store.close();
    }
}
async function resolveConfigFile(configPath, spaceId, knownSpaceName) {
    const absolute = resolve(configPath);
    const extension = extname(absolute).toLowerCase();
    if (extension === ".toml")
        throw new Error("Runtime configuration changes support YAML and JSON files only");
    const raw = parseConfig(await readFile(absolute, "utf8"), extension);
    const parsed = configSchema.parse(raw);
    const rawSpaces = raw.spaces;
    let spaceIndex = parsed.spaces.findIndex((space) => space.id === spaceId);
    if (spaceIndex < 0 && knownSpaceName)
        spaceIndex = parsed.spaces.findIndex((space) => space.name === knownSpaceName);
    if (spaceIndex < 0 && parsed.spaces.some((space) => !space.id && space.name)) {
        const anytype = await AnytypeClient.create(parsed);
        const resolvedSpaces = await Promise.all(parsed.spaces.map(async (space) => space.id ??
            (space.name ? (await anytype.resolveSpace({ name: space.name })).id : undefined)));
        spaceIndex = resolvedSpaces.findIndex((resolvedId) => resolvedId === spaceId);
    }
    if (spaceIndex < 0)
        throw new Error(`Space ${spaceId} is not configured by ID`);
    return { absolute, extension, raw, parsed, rawSpaces, spaceIndex };
}
async function resolveRouteSpaceName(configPath, routeId) {
    const match = /^(?:chat|discussion):([^:]+):.+$/.exec(routeId);
    if (!match)
        throw new Error("Route ID must include a configured space ID");
    const configFile = await resolveConfigFile(configPath, match[1]);
    return configFile.parsed.spaces[configFile.spaceIndex].name ?? "";
}
async function withConfigWriteLock(configPath, operation) {
    const absolute = resolve(configPath);
    const release = await acquireProcessLock(`${absolute}.write.lock`, {
        attempts: 101,
        waitMilliseconds: 50,
        contentionMessage: (pid) => `Another process is updating ${absolute} (pid ${pid})`,
    });
    try {
        return await operation();
    }
    finally {
        await release();
    }
}
function parseConfig(text, extension) {
    return extension === ".json" ? JSON.parse(text) : YAML.parse(text);
}
function serializeConfig(value, extension) {
    return extension === ".json" ? `${JSON.stringify(value, null, 2)}\n` : YAML.stringify(value);
}
async function writePrivateFileAtomic(target, contents) {
    const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(contents);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temporary, target);
        await chmod(target, 0o600);
    }
    finally {
        await unlink(temporary).catch(() => undefined);
    }
}

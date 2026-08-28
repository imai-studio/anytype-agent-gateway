import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import YAML from "yaml";
import { configSchema, loadConfig } from "./config.js";
import { Store } from "./store.js";
const humanModes = ["mention", "mention-or-reply", "every-message", "prefix", "disabled"];
export async function setRouteWake(input) {
    if (!humanModes.includes(input.humans))
        throw new Error(`Invalid human wake mode: ${input.humans}`);
    if (input.humans === "prefix" && !input.prefix)
        throw new Error("--prefix is required when --humans is prefix");
    const match = /^(chat|discussion):([^:]+):(.+)$/.exec(input.routeId);
    if (!match)
        throw new Error("Route ID must be chat:<space-id>:<chat-id> or discussion:<space-id>:<discussion-id>");
    const kind = match[1];
    const spaceId = match[2];
    const id = match[3];
    const absolute = resolve(input.configPath);
    const extension = extname(absolute).toLowerCase();
    if (extension === ".toml")
        throw new Error("Wake self-management currently supports YAML and JSON configuration files");
    const raw = parseConfig(await readFile(absolute, "utf8"), extension);
    const parsed = configSchema.parse(raw);
    if (!parsed.management.allowWakeChanges)
        throw new Error("management.allowWakeChanges is disabled");
    const rawSpaces = raw.spaces;
    const index = parsed.spaces.findIndex(space => space.id === spaceId);
    if (index < 0)
        throw new Error(`Space ${spaceId} is not configured by ID`);
    const parsedSpace = parsed.spaces[index];
    const rawSpace = rawSpaces[index];
    const existing = parsedSpace.wakeOverrides.find(item => item.kind === kind && item.id === id);
    const base = existing?.wake ?? (kind === "chat"
        ? parsedSpace.chats.find(chat => chat.id === id)?.wake ?? parsedSpace.chatDiscovery.wake
        : parsedSpace.comments.wake);
    const wake = { ...base, humans: input.humans };
    if (input.humans === "prefix")
        wake.prefix = input.prefix;
    else
        delete wake.prefix;
    const overrides = Array.isArray(rawSpace.wakeOverrides) ? rawSpace.wakeOverrides : [];
    const overrideIndex = overrides.findIndex(item => item.kind === kind && item.id === id);
    const next = { kind, id, wake };
    if (overrideIndex < 0)
        overrides.push(next);
    else
        overrides[overrideIndex] = next;
    rawSpace.wakeOverrides = overrides;
    configSchema.parse(raw);
    const temporary = `${absolute}.tmp-${process.pid}`;
    await writeFile(temporary, serializeConfig(raw, extension), { mode: 0o600 });
    await rename(temporary, absolute);
    await chmod(absolute, 0o600);
    const config = await loadConfig(absolute);
    const store = new Store(config.state.path);
    try {
        store.setWakeOverride(input.routeId, input.humans);
    }
    finally {
        store.close();
    }
}
function parseConfig(text, extension) { return extension === ".json" ? JSON.parse(text) : YAML.parse(text); }
function serializeConfig(value, extension) { return extension === ".json" ? `${JSON.stringify(value, null, 2)}\n` : YAML.stringify(value); }

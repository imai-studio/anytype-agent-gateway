import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import YAML from "yaml";
import { AnytypeClient } from "./anytype-client.js";
import { configSchema, loadConfig, type WakeConfig } from "./config.js";
import { Store } from "./store.js";

const humanModes = ["mention", "mention-or-reply", "every-message", "prefix", "disabled"] as const;
type HumanMode = (typeof humanModes)[number];

export async function setRouteWake(input: {
  configPath: string;
  routeId: string;
  humans: string;
  prefix?: string;
}): Promise<void> {
  if (!humanModes.includes(input.humans as HumanMode))
    throw new Error(`Invalid human wake mode: ${input.humans}`);
  if (input.humans === "prefix" && !input.prefix)
    throw new Error("--prefix is required when --humans is prefix");
  const match = /^(chat|discussion):([^:]+):(.+)$/.exec(input.routeId);
  if (!match)
    throw new Error(
      "Route ID must be chat:<space-id>:<chat-id> or discussion:<space-id>:<discussion-id>",
    );
  const kind = match[1] as "chat" | "discussion";
  const spaceId = match[2]!;
  const id = match[3]!;
  const absolute = resolve(input.configPath);
  const extension = extname(absolute).toLowerCase();
  if (extension === ".toml")
    throw new Error("Wake self-management currently supports YAML and JSON configuration files");
  const raw = parseConfig(await readFile(absolute, "utf8"), extension) as Record<string, unknown>;
  const parsed = configSchema.parse(raw);
  if (!parsed.management.allowWakeChanges)
    throw new Error("management.allowWakeChanges is disabled");
  const rawSpaces = raw.spaces as Array<Record<string, unknown>>;
  let index = parsed.spaces.findIndex((space) => space.id === spaceId);
  if (index < 0 && parsed.spaces.some((space) => !space.id && space.name)) {
    const anytype = await AnytypeClient.create(parsed);
    const resolvedSpaces = await Promise.all(
      parsed.spaces.map(
        async (space) =>
          space.id ??
          (space.name ? (await anytype.resolveSpace({ name: space.name })).id : undefined),
      ),
    );
    index = resolvedSpaces.findIndex((id) => id === spaceId);
  }
  if (index < 0) throw new Error(`Space ${spaceId} is not configured by ID`);
  const parsedSpace = parsed.spaces[index]!;
  const rawSpace = rawSpaces[index]!;
  const existing = parsedSpace.wakeOverrides.find((item) => item.kind === kind && item.id === id);
  const base =
    existing?.wake ??
    (kind === "chat"
      ? (parsedSpace.chats.find((chat) => chat.id === id)?.wake ?? parsedSpace.chatDiscovery.wake)
      : parsedSpace.comments.wake);
  const wake: WakeConfig = { ...base, humans: input.humans as HumanMode };
  if (input.humans === "prefix") wake.prefix = input.prefix;
  else delete wake.prefix;
  const overrides = Array.isArray(rawSpace.wakeOverrides)
    ? (rawSpace.wakeOverrides as Array<Record<string, unknown>>)
    : [];
  const overrideIndex = overrides.findIndex((item) => item.kind === kind && item.id === id);
  const next = { kind, id, wake };
  if (overrideIndex < 0) overrides.push(next);
  else overrides[overrideIndex] = next;
  rawSpace.wakeOverrides = overrides;
  configSchema.parse(raw);
  await writePrivateFileAtomic(absolute, serializeConfig(raw, extension));
  const config = await loadConfig(absolute);
  const store = new Store(config.state.path);
  try {
    store.setWakeOverride(input.routeId, input.humans, input.prefix);
  } finally {
    store.close();
  }
}

function parseConfig(text: string, extension: string): unknown {
  return extension === ".json" ? JSON.parse(text) : YAML.parse(text);
}
function serializeConfig(value: unknown, extension: string): string {
  return extension === ".json" ? `${JSON.stringify(value, null, 2)}\n` : YAML.stringify(value);
}

async function writePrivateFileAtomic(target: string, contents: string): Promise<void> {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

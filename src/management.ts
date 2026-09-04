import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import YAML from "yaml";
import { AnytypeClient } from "./anytype-client.js";
import { configSchema, loadConfig, type AgentConfig, type WakeConfig } from "./config.js";
import { acquireProcessLock } from "./process-lock.js";
import { Store } from "./store.js";
import { sameIdentity } from "./wake.js";
import { principalAllowed, type AnytypePrincipal } from "./principal.js";

const humanModes = ["mention", "mention-or-reply", "every-message", "prefix", "disabled"] as const;
type HumanMode = (typeof humanModes)[number];

export async function enrollChatRoute(input: {
  configPath: string;
  spaceId: string;
  spaceName: string;
  chatId: string;
  chatName: string;
  wake: WakeConfig;
}): Promise<"enrolled" | "existing" | "disabled"> {
  return withConfigWriteLock(input.configPath, async () => {
    const configFile = await resolveConfigFile(input.configPath, input.spaceId, input.spaceName);
    const parsedSpace = configFile.parsed.spaces[configFile.spaceIndex]!;
    if (!parsedSpace.chatDiscovery.enabled || !parsedSpace.chatDiscovery.autoEnroll)
      return "disabled";
    if (parsedSpace.chats.some((chat) => chat.id === input.chatId)) return "existing";
    const rawSpace = configFile.rawSpaces[configFile.spaceIndex]!;
    const chats = Array.isArray(rawSpace.chats)
      ? (rawSpace.chats as Array<Record<string, unknown>>)
      : [];
    chats.push({ id: input.chatId, name: input.chatName, wake: input.wake });
    rawSpace.chats = chats;
    configSchema.parse(configFile.raw);
    await writePrivateFileAtomic(configFile.absolute, serializeConfig(configFile));
    return "enrolled";
  });
}

export async function setRouteWake(input: {
  configPath: string;
  routeId: string;
  humans: string;
  prefix?: string;
  actor?: AnytypePrincipal;
}): Promise<void> {
  if (!humanModes.includes(input.humans as HumanMode))
    throw new Error(`Invalid human wake mode: ${input.humans}`);
  if (input.humans === "prefix" && !input.prefix)
    throw new Error("--prefix is required when --humans is prefix");
  const spaceName = await resolveRouteSpaceName(input.configPath, input.routeId);
  await withConfigWriteLock(input.configPath, async () => {
    const route = await resolveRouteConfig(input.configPath, input.routeId, spaceName);
    if (!route.parsed.management.allowWakeChanges)
      throw new Error("management.allowWakeChanges is disabled");
    if (input.actor && !principalAllowed(input.actor, route.base.allowedUsers))
      throw new Error("The current Anytype sender is not allowed to change this route");
    const wake: WakeConfig = { ...route.base, humans: input.humans as HumanMode };
    if (input.humans === "prefix") wake.prefix = input.prefix;
    else delete wake.prefix;
    await persistRouteWake(route, wake);
  });
}

export async function setRouteAccess(input: {
  configPath: string;
  routeId: string;
  actor?: AnytypePrincipal;
  operation: string;
  participantIds: string[];
}): Promise<string[]> {
  if (!(["add", "remove", "replace"] as const).includes(input.operation as never))
    throw new Error(`Invalid access operation: ${input.operation}`);
  const participantIds = [
    ...new Set(input.participantIds.map((participant) => participant.trim()).filter(Boolean)),
  ];
  if (!participantIds.length) throw new Error("At least one participant ID is required");
  if (participantIds.includes("*"))
    throw new Error(
      "Self-management cannot grant wildcard access; edit the operator config manually",
    );
  const spaceName = await resolveRouteSpaceName(input.configPath, input.routeId);
  return withConfigWriteLock(input.configPath, async () => {
    const route = await resolveRouteConfig(input.configPath, input.routeId, spaceName);
    if (!route.parsed.management.allowAccessChanges)
      throw new Error("management.allowAccessChanges is disabled");
    if (input.actor && !principalAllowed(input.actor, route.parsed.management.accessAdmins))
      throw new Error("Only a configured access admin may change the route allowlist");
    const admins = route.parsed.management.accessAdmins;
    let allowedUsers: string[];
    if (input.operation === "add")
      allowedUsers = [...route.base.allowedUsers, ...participantIds, ...admins];
    else if (input.operation === "remove") {
      if (
        participantIds.some((candidate) => admins.some((admin) => sameIdentity(candidate, admin)))
      )
        throw new Error("An access admin cannot remove an access admin from the route allowlist");
      allowedUsers = route.base.allowedUsers.filter(
        (candidate) => !participantIds.some((participant) => sameIdentity(candidate, participant)),
      );
    } else allowedUsers = [...participantIds, ...admins];
    allowedUsers = allowedUsers.filter(
      (participant, index, all) =>
        all.findIndex((candidate) => sameIdentity(candidate, participant)) === index,
    );
    if (!allowedUsers.length) throw new Error("A route allowlist cannot be empty");
    await persistRouteWake(route, { ...route.base, allowedUsers });
    return allowedUsers;
  });
}

type ConfigFile = {
  absolute: string;
  extension: string;
  document: YAML.Document | undefined;
  original: unknown;
  raw: Record<string, unknown>;
  parsed: AgentConfig;
  rawSpaces: Array<Record<string, unknown>>;
  spaceIndex: number;
};

type RouteConfig = {
  absolute: string;
  extension: string;
  document: YAML.Document | undefined;
  original: unknown;
  raw: Record<string, unknown>;
  parsed: AgentConfig;
  rawSpace: Record<string, unknown>;
  kind: "chat" | "discussion";
  id: string;
  routeId: string;
  base: WakeConfig;
};

async function resolveRouteConfig(
  configPath: string,
  routeId: string,
  knownSpaceName?: string,
): Promise<RouteConfig> {
  const match = /^(chat|discussion):([^:]+):(.+)$/.exec(routeId);
  if (!match)
    throw new Error(
      "Route ID must be chat:<space-id>:<chat-id> or discussion:<space-id>:<discussion-id>",
    );
  const kind = match[1] as "chat" | "discussion";
  const spaceId = match[2]!;
  const id = match[3]!;
  const configFile = await resolveConfigFile(configPath, spaceId, knownSpaceName);
  const parsedSpace = configFile.parsed.spaces[configFile.spaceIndex]!;
  const existing = parsedSpace.wakeOverrides.find((item) => item.kind === kind && item.id === id);
  const base =
    existing?.wake ??
    (kind === "chat"
      ? (parsedSpace.chats.find((chat) => chat.id === id)?.wake ?? parsedSpace.chatDiscovery.wake)
      : parsedSpace.comments.wake);
  return {
    absolute: configFile.absolute,
    extension: configFile.extension,
    document: configFile.document,
    original: configFile.original,
    raw: configFile.raw,
    parsed: configFile.parsed,
    rawSpace: configFile.rawSpaces[configFile.spaceIndex]!,
    kind,
    id,
    routeId,
    base,
  };
}

async function persistRouteWake(route: RouteConfig, wake: WakeConfig): Promise<void> {
  const overrides = Array.isArray(route.rawSpace.wakeOverrides)
    ? (route.rawSpace.wakeOverrides as Array<Record<string, unknown>>)
    : [];
  const overrideIndex = overrides.findIndex(
    (item) => item.kind === route.kind && item.id === route.id,
  );
  const next = { kind: route.kind, id: route.id, wake };
  if (overrideIndex < 0) overrides.push(next);
  else overrides[overrideIndex] = next;
  route.rawSpace.wakeOverrides = overrides;
  configSchema.parse(route.raw);
  await writePrivateFileAtomic(route.absolute, serializeConfig(route));
  const config = await loadConfig(route.absolute);
  const store = new Store(config.state.path);
  try {
    store.setWakeOverride(route.routeId, wake.humans, wake.prefix, wake.allowedUsers);
  } finally {
    store.close();
  }
}

async function resolveConfigFile(
  configPath: string,
  spaceId: string,
  knownSpaceName?: string,
): Promise<ConfigFile> {
  const absolute = resolve(configPath);
  const extension = extname(absolute).toLowerCase();
  if (extension === ".toml")
    throw new Error("Runtime configuration changes support YAML and JSON files only");
  const text = await readFile(absolute, "utf8");
  const document = extension === ".json" ? undefined : YAML.parseDocument(text);
  if (document?.errors.length) throw document.errors[0];
  const original: unknown = document ? document.toJS() : JSON.parse(text);
  // Detach YAML aliases before changing a route so another alias stays untouched.
  const raw = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
  const parsed = configSchema.parse(raw);
  const rawSpaces = raw.spaces as Array<Record<string, unknown>>;
  let spaceIndex = parsed.spaces.findIndex((space) => space.id === spaceId);
  if (spaceIndex < 0 && knownSpaceName)
    spaceIndex = parsed.spaces.findIndex((space) => space.name === knownSpaceName);
  if (spaceIndex < 0 && parsed.spaces.some((space) => !space.id && space.name)) {
    const anytype = await AnytypeClient.create(parsed);
    const resolvedSpaces = await Promise.all(
      parsed.spaces.map(
        async (space) =>
          space.id ??
          (space.name ? (await anytype.resolveSpace({ name: space.name })).id : undefined),
      ),
    );
    spaceIndex = resolvedSpaces.findIndex((resolvedId) => resolvedId === spaceId);
  }
  if (spaceIndex < 0) throw new Error(`Space ${spaceId} is not configured by ID`);
  return { absolute, extension, document, original, raw, parsed, rawSpaces, spaceIndex };
}

async function resolveRouteSpaceName(configPath: string, routeId: string): Promise<string> {
  const match = /^(?:chat|discussion):([^:]+):.+$/.exec(routeId);
  if (!match) throw new Error("Route ID must include a configured space ID");
  const configFile = await resolveConfigFile(configPath, match[1]!);
  return configFile.parsed.spaces[configFile.spaceIndex]!.name ?? "";
}

async function withConfigWriteLock<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
  const absolute = resolve(configPath);
  const release = await acquireProcessLock(`${absolute}.write.lock`, {
    attempts: 101,
    waitMilliseconds: 50,
    contentionMessage: (pid) => `Another process is updating ${absolute} (pid ${pid})`,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

function serializeConfig(config: Pick<ConfigFile, "raw" | "original" | "document">): string {
  if (!config.document) return `${JSON.stringify(config.raw, null, 2)}\n`;
  patchDocument(config.document, [], config.original, config.raw);
  return config.document.toString();
}

function patchDocument(
  document: YAML.Document,
  path: Array<string | number>,
  before: unknown,
  after: unknown,
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const node = document.getIn(path, true);
  if (YAML.isNode(node) && !YAML.isAlias(node) && node.anchor) {
    const anchor = node.anchor;
    YAML.visit(document, {
      Alias: (_key, alias) => (alias.source === anchor ? document.createNode(before) : undefined),
    });
  }
  // Updating through an alias would change its anchor and all other consumers.
  if (YAML.isAlias(node)) {
    document.setIn(path, document.createNode(after));
  } else if (Array.isArray(before) && Array.isArray(after) && YAML.isSeq(node)) {
    for (let index = before.length - 1; index >= after.length; index -= 1)
      document.deleteIn([...path, index]);
    for (let index = 0; index < after.length; index += 1)
      patchDocument(document, [...path, index], before[index], after[index]);
  } else if (isRecord(before) && isRecord(after) && YAML.isMap(node)) {
    for (const key of Object.keys(before)) if (!(key in after)) document.deleteIn([...path, key]);
    for (const [key, value] of Object.entries(after))
      patchDocument(document, [...path, key], before[key], value);
  } else {
    document.setIn(path, after);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

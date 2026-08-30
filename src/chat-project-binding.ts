import type { AgentConfig } from "./config.js";
import { configuredCodexProjects, resolveConfiguredProject } from "./codex-task.js";
import type { AnytypePort, ConversationRef } from "./types.js";

export type ChatProjectBinding =
  | { kind: "none" }
  | { kind: "bound"; tag: string; projectName: string; workspacePath: string }
  | { kind: "invalid"; message: string };

export async function resolveChatProjectBinding(
  anytype: AnytypePort,
  config: AgentConfig,
  conversation: ConversationRef,
): Promise<ChatProjectBinding> {
  if (
    config.runtime.kind !== "codex" ||
    conversation.kind !== "chat" ||
    conversation.managementEnabled === false
  )
    return { kind: "none" };

  const object = await anytype.getObject(conversation.spaceId, conversation.chatId);
  const property = tagProperty(object);
  const catalog = property?.id
    ? await anytype.listPropertyTags(conversation.spaceId, String(property.id))
    : [];
  const prefix = `${config.agent.name.trim().toLocaleLowerCase()}:`;
  const matching = resolvedTagNames(property, catalog).filter((tag) =>
    tag.trim().toLocaleLowerCase().startsWith(prefix),
  );
  if (matching.length === 0) return { kind: "none" };
  if (matching.length > 1)
    return {
      kind: "invalid",
      message: `This chat has multiple ${config.agent.name}:project tags. Keep exactly one before using /new.`,
    };

  const tag = matching[0]!.trim();
  const projectName = tag.slice(prefix.length).trim();
  if (!projectName)
    return {
      kind: "invalid",
      message: `The tag ${tag} has no Codex project name. Use ${config.agent.name}:project-name.`,
    };

  try {
    return {
      kind: "bound",
      tag,
      projectName,
      workspacePath: await resolveConfiguredProject(config, projectName),
    };
  } catch {
    const available = (await configuredCodexProjects(config)).map((project) => project.name);
    return {
      kind: "invalid",
      message: `No configured Codex project named ${JSON.stringify(projectName)} exists for ${config.agent.name}. Available projects: ${available.join(", ") || "none"}.`,
    };
  }
}

export async function setChatProjectBindingTag(
  anytype: AnytypePort,
  config: AgentConfig,
  conversation: ConversationRef,
  projectName?: string,
): Promise<string | undefined> {
  if (conversation.kind !== "chat" || conversation.managementEnabled === false)
    throw new Error("Project tags can only be changed on an Anytype Chat object");
  const agentName = config.agent.name.trim().toLocaleLowerCase();
  let tagName: string | undefined;
  if (projectName) {
    await resolveConfiguredProject(config, projectName);
    tagName = `${agentName}:${projectName}`;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const object = await anytype.getObject(conversation.spaceId, conversation.chatId);
    const property = tagProperty(object);
    if (!property?.id) throw new Error("This Chat type has no writable Tag property");
    const catalog = await anytype.listPropertyTags(conversation.spaceId, String(property.id));
    const byReference = tagCatalogByReference(catalog);
    const prefix = `${agentName}:`;
    const kept = selectedTagReferences(property).filter((reference) => {
      const selected = typeof reference === "string" ? byReference.get(reference) : reference;
      return !selected?.name.trim().toLocaleLowerCase().startsWith(prefix);
    });
    let selected = kept.map((value) => (typeof value === "string" ? value : value.id));
    if (tagName) {
      let tag = catalog.find(
        (candidate) => candidate.name.toLocaleLowerCase() === tagName!.toLocaleLowerCase(),
      );
      tag ??= await anytype.createPropertyTag(conversation.spaceId, String(property.id), {
        name: tagName,
        color: "blue",
      });
      selected = [...new Set([...selected, tag.id])];
    }
    await anytype.updateObject(conversation.spaceId, conversation.chatId, {
      properties: [{ key: "tag", multi_select: selected }],
    });
    const verified = await anytype.getObject(conversation.spaceId, conversation.chatId);
    const verifiedProperty = tagProperty(verified);
    const verifiedCatalog = verifiedProperty?.id
      ? await anytype.listPropertyTags(conversation.spaceId, String(verifiedProperty.id))
      : [];
    const ownTags = resolvedTagNames(verifiedProperty, verifiedCatalog).filter((name) =>
      name.trim().toLocaleLowerCase().startsWith(prefix),
    );
    const matches = tagName
      ? ownTags.length === 1 && ownTags[0]!.toLocaleLowerCase() === tagName.toLocaleLowerCase()
      : ownTags.length === 0;
    if (matches) return tagName;
  }
  throw new Error("The Chat tags changed concurrently; retry the project command");
}

function tagProperty(object: Record<string, unknown>): Record<string, unknown> | undefined {
  const properties = Array.isArray(object.properties) ? object.properties : [];
  const selected = properties.find(
    (value): value is Record<string, unknown> =>
      isRecord(value) && String(value.key ?? "").toLocaleLowerCase() === "tag",
  );
  if (selected) return selected;
  const type = isRecord(object.type) ? object.type : undefined;
  const definitions = type && Array.isArray(type.properties) ? type.properties : [];
  return definitions.find(
    (value): value is Record<string, unknown> =>
      isRecord(value) && String(value.key ?? "").toLocaleLowerCase() === "tag",
  );
}

function selectedTagReferences(property: Record<string, unknown>): Array<string | AnytypeTagRef> {
  if (!Array.isArray(property.multi_select)) return [];
  const selected: Array<string | AnytypeTagRef> = [];
  for (const value of property.multi_select) {
    if (typeof value === "string") {
      selected.push(value);
      continue;
    }
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string")
      continue;
    selected.push({ id: value.id, name: value.name });
  }
  return selected;
}

type AnytypeTagRef = { id: string; name: string };
type CatalogTag = AnytypeTagRef & { key?: string };

function resolvedTagNames(
  property: Record<string, unknown> | undefined,
  catalog: CatalogTag[],
): string[] {
  if (!property) return [];
  const byReference = tagCatalogByReference(catalog);
  return selectedTagReferences(property).map((value) => {
    if (typeof value !== "string") return value.name;
    const resolved = byReference.get(value);
    if (!resolved)
      throw new Error(`The Chat contains an unresolved Tag reference: ${JSON.stringify(value)}`);
    return resolved.name;
  });
}

function tagCatalogByReference(catalog: CatalogTag[]): Map<string, CatalogTag> {
  return new Map(
    catalog.flatMap((tag) => [
      [tag.id, tag] as const,
      ...(tag.key ? ([[tag.key, tag]] as const) : []),
    ]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

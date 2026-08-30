import { configuredCodexProjects, resolveConfiguredProject } from "./codex-task.js";
export async function resolveChatProjectBinding(anytype, config, conversation) {
    if (config.runtime.kind !== "codex" ||
        conversation.kind !== "chat" ||
        conversation.managementEnabled === false)
        return { kind: "none" };
    const object = await anytype.getObject(conversation.spaceId, conversation.chatId);
    const property = tagProperty(object);
    const catalog = property?.id
        ? await anytype.listPropertyTags(conversation.spaceId, String(property.id))
        : [];
    const prefix = `${config.agent.name.trim().toLocaleLowerCase()}:`;
    const matching = resolvedTagNames(property, catalog).filter((tag) => tag.trim().toLocaleLowerCase().startsWith(prefix));
    if (matching.length === 0)
        return { kind: "none" };
    if (matching.length > 1)
        return {
            kind: "invalid",
            message: `This chat has multiple ${config.agent.name}:project tags. Keep exactly one before using /new.`,
        };
    const tag = matching[0].trim();
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
    }
    catch {
        const available = (await configuredCodexProjects(config)).map((project) => project.name);
        return {
            kind: "invalid",
            message: `No configured Codex project named ${JSON.stringify(projectName)} exists for ${config.agent.name}. Available projects: ${available.join(", ") || "none"}.`,
        };
    }
}
export async function setChatProjectBindingTag(anytype, config, conversation, projectName) {
    if (conversation.kind !== "chat" || conversation.managementEnabled === false)
        throw new Error("Project tags can only be changed on an Anytype Chat object");
    const agentName = config.agent.name.trim().toLocaleLowerCase();
    let tagName;
    if (projectName) {
        await resolveConfiguredProject(config, projectName);
        tagName = `${agentName}:${projectName}`;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
        const object = await anytype.getObject(conversation.spaceId, conversation.chatId);
        const property = tagProperty(object);
        if (!property?.id)
            throw new Error("This Chat type has no writable Tag property");
        const catalog = await anytype.listPropertyTags(conversation.spaceId, String(property.id));
        const byReference = tagCatalogByReference(catalog);
        const prefix = `${agentName}:`;
        const kept = selectedTagReferences(property).filter((reference) => {
            const selected = typeof reference === "string" ? byReference.get(reference) : reference;
            return !selected?.name.trim().toLocaleLowerCase().startsWith(prefix);
        });
        let selected = kept.map((value) => (typeof value === "string" ? value : value.id));
        if (tagName) {
            let tag = catalog.find((candidate) => candidate.name.toLocaleLowerCase() === tagName.toLocaleLowerCase());
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
        const ownTags = resolvedTagNames(verifiedProperty, verifiedCatalog).filter((name) => name.trim().toLocaleLowerCase().startsWith(prefix));
        const matches = tagName
            ? ownTags.length === 1 && ownTags[0].toLocaleLowerCase() === tagName.toLocaleLowerCase()
            : ownTags.length === 0;
        if (matches)
            return tagName;
    }
    throw new Error("The Chat tags changed concurrently; retry the project command");
}
function tagProperty(object) {
    const properties = Array.isArray(object.properties) ? object.properties : [];
    const selected = properties.find((value) => isRecord(value) && String(value.key ?? "").toLocaleLowerCase() === "tag");
    if (selected)
        return selected;
    const type = isRecord(object.type) ? object.type : undefined;
    const definitions = type && Array.isArray(type.properties) ? type.properties : [];
    return definitions.find((value) => isRecord(value) && String(value.key ?? "").toLocaleLowerCase() === "tag");
}
function selectedTagReferences(property) {
    if (!Array.isArray(property.multi_select))
        return [];
    const selected = [];
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
function resolvedTagNames(property, catalog) {
    if (!property)
        return [];
    const byReference = tagCatalogByReference(catalog);
    return selectedTagReferences(property).map((value) => {
        if (typeof value !== "string")
            return value.name;
        const resolved = byReference.get(value);
        if (!resolved)
            throw new Error(`The Chat contains an unresolved Tag reference: ${JSON.stringify(value)}`);
        return resolved.name;
    });
}
function tagCatalogByReference(catalog) {
    return new Map(catalog.flatMap((tag) => [
        [tag.id, tag],
        ...(tag.key ? [[tag.key, tag]] : []),
    ]));
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

import { access, constants, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { AnytypeClient } from "./anytype-client.js";
import { createBoundCodexChat } from "./bound-chat.js";
import { createCodexTask } from "./codex-task.js";
import { loadConfig } from "./config.js";
import { setRouteAccess, setRouteWake } from "./management.js";
import { Store } from "./store.js";
import { VERSION } from "./version.js";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const propertyValueFields = [
    "text",
    "number",
    "select",
    "multi_select",
    "date",
    "files",
    "checkbox",
    "url",
    "email",
    "phone",
    "objects",
];
const reservedPropertyKeys = new Set([
    "archived",
    "id",
    "layout",
    "object",
    "space_id",
    "type",
    "type_key",
]);
export async function runMcpServer(configPath, context = {}) {
    const config = await loadConfig(configPath);
    if (!config.tools.anytype.enabled && !config.tools.codex.enabled)
        throw new Error("All AAG tools are disabled in this configuration");
    const anytype = await AnytypeClient.create(config);
    const routeId = context.routeId ?? process.env.AAG_ROUTE_ID;
    const actorId = context.actorId ?? process.env.AAG_ACTOR_ID;
    const defaultSpaceId = context.spaceId ??
        process.env.AAG_SPACE_ID ??
        spaceFromRoute(routeId) ??
        soleAllowedSpace(config);
    const tools = toolDefinitions(config);
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
        if (!line.trim())
            continue;
        let request;
        try {
            request = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (request.id === undefined || request.id === null)
            continue;
        try {
            let result;
            if (request.method === "initialize")
                result = {
                    protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: "aag-anytype", version: VERSION },
                };
            else if (request.method === "ping")
                result = {};
            else if (request.method === "tools/list")
                result = { tools };
            else if (request.method === "tools/call") {
                try {
                    const value = await callTool(anytype, config, configPath, routeId, defaultSpaceId, String(request.params?.name ?? ""), request.params?.arguments ?? {}, actorId);
                    result = { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
                }
                catch (error) {
                    result = {
                        content: [
                            { type: "text", text: error instanceof Error ? error.message : String(error) },
                        ],
                        isError: true,
                    };
                }
            }
            else
                throw rpcError(-32601, `Method not found: ${request.method ?? ""}`);
            write({ jsonrpc: "2.0", id: request.id, result });
        }
        catch (error) {
            const rpc = error;
            write({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: rpc.code ?? -32000, message: rpc.message },
            });
        }
    }
}
export function toolDefinitions(config) {
    const readTools = [
        {
            name: "aag_context",
            description: "Describe the current Anytype gateway route, permissions, formatting rules, and available capabilities.",
            inputSchema: objectSchema({
                route_id: stringSchema("Optional Anytype route when the MCP process is shared across conversations"),
                discussion_root_id: stringSchema("Current top-level comment ID for a discussion route; omit for chats"),
            }),
        },
        {
            name: "anytype_list_spaces",
            description: "List the Anytype spaces this agent identity has joined and its policy permits it to inspect.",
            inputSchema: objectSchema({}),
        },
        {
            name: "anytype_list_chats",
            description: "List chats in an allowed Anytype space before reading cross-channel context.",
            inputSchema: objectSchema({ space_id: stringSchema() }),
        },
        {
            name: "anytype_search",
            description: "Search objects in an allowed Anytype space.",
            inputSchema: objectSchema({
                space_id: stringSchema("Space ID; omit to use the current conversation space"),
                query: stringSchema("Text query"),
                types: { type: "array", items: { type: "string" } },
                limit: { type: "integer", minimum: 1, maximum: 100 },
            }),
        },
        {
            name: "anytype_get_object",
            description: "Read a complete Anytype object, including its type, Markdown body, and properties.",
            inputSchema: objectSchema({ space_id: stringSchema(), object_id: stringSchema() }, [
                "object_id",
            ]),
        },
        {
            name: "anytype_list_types",
            description: "List the available Anytype types and their keys before creating or changing objects.",
            inputSchema: objectSchema({ space_id: stringSchema() }),
        },
        {
            name: "anytype_get_type",
            description: "Get one Anytype type definition by ID, including its layout and configured properties.",
            inputSchema: objectSchema({ space_id: stringSchema(), type_id: stringSchema() }, ["type_id"]),
        },
        {
            name: "anytype_list_properties",
            description: "List the available Anytype properties, keys, and formats before writing object properties.",
            inputSchema: objectSchema({ space_id: stringSchema() }),
        },
        {
            name: "anytype_get_property",
            description: "Get one Anytype property definition by ID.",
            inputSchema: objectSchema({ space_id: stringSchema(), property_id: stringSchema() }, [
                "property_id",
            ]),
        },
        {
            name: "anytype_list_property_tags",
            description: "List valid select or multi-select tags for an Anytype property.",
            inputSchema: objectSchema({ space_id: stringSchema(), property_id: stringSchema() }, [
                "property_id",
            ]),
        },
        {
            name: "anytype_list_templates",
            description: "List templates available for an Anytype type before creating an object from a template.",
            inputSchema: objectSchema({ space_id: stringSchema(), type_id: stringSchema() }, ["type_id"]),
        },
        {
            name: "anytype_list_views",
            description: "List the views configured on an Anytype collection or query.",
            inputSchema: objectSchema({ space_id: stringSchema(), list_id: stringSchema() }, ["list_id"]),
        },
        {
            name: "anytype_list_view_objects",
            description: "List the objects currently visible in one Anytype collection or query view.",
            inputSchema: objectSchema({
                space_id: stringSchema(),
                list_id: stringSchema(),
                view_id: stringSchema(),
                offset: { type: "integer", minimum: 0 },
                limit: { type: "integer", minimum: 1, maximum: 100 },
            }, ["list_id", "view_id"]),
        },
    ];
    const managementTools = [
        ...(config.management.allowWakeChanges
            ? [
                {
                    name: "aag_set_wake",
                    description: "Change how this agent wakes in an Anytype chat or discussion. Pass route_id when the MCP process has no bound route.",
                    inputSchema: objectSchema({
                        route_id: stringSchema("chat:<space-id>:<chat-id> or discussion:<space-id>:<discussion-id>"),
                        humans: {
                            type: "string",
                            enum: ["mention", "mention-or-reply", "every-message", "prefix", "disabled"],
                        },
                        prefix: stringSchema(),
                    }, ["humans"]),
                },
            ]
            : []),
        ...(config.management.allowAccessChanges
            ? [
                {
                    name: "aag_set_access",
                    description: "Add or remove native Anytype participant IDs from this route's sender allowlist. Only a configured access admin can authorize the change.",
                    inputSchema: objectSchema({
                        route_id: stringSchema("chat:<space-id>:<chat-id> or discussion:<space-id>:<discussion-id>"),
                        actor_id: stringSchema("Native participant ID of the user requesting the change"),
                        operation: { type: "string", enum: ["add", "remove", "replace"] },
                        participant_ids: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                        },
                    }, ["actor_id", "operation", "participant_ids"]),
                },
            ]
            : []),
    ];
    const codexTools = config.tools.codex.enabled
        ? [
            {
                name: "aag_create_codex_task",
                description: "Create and start a separate persistent Codex task in the agent's default or allowed projects. Use only when the user explicitly asks for a separate task or thread; ordinary work stays in the current session.",
                inputSchema: objectSchema({
                    project: stringSchema("Configured absolute project path or its unique final directory name"),
                    prompt: stringSchema("Complete initial instructions for the new Codex task"),
                }, ["project", "prompt"]),
            },
            ...(config.tools.anytype.allowWrite
                ? [
                    {
                        name: "aag_create_bound_chat",
                        description: "Create an Anytype chat and bind it one-to-one to a new persistent Codex task in a configured project. Use only when the user explicitly asks for a new linked Anytype chat and Codex task.",
                        inputSchema: objectSchema({
                            space_id: stringSchema("Configured Anytype space ID; omit to use the current conversation space"),
                            name: stringSchema("Name for the new Anytype chat"),
                            project: stringSchema("Configured absolute project path or its unique final directory name"),
                            prompt: stringSchema("Complete initial instructions for the Codex task backing the new chat"),
                        }, ["name", "project", "prompt"]),
                    },
                ]
                : []),
        ]
        : [];
    if (!config.tools.anytype.allowWrite)
        return [...readTools, ...managementTools, ...codexTools];
    return [
        ...readTools,
        {
            name: "anytype_create_object",
            description: "Create an object in an allowed Anytype space. Collections must be created without a body; create their content separately and add it with anytype_add_to_list. Returns compact-reference and native-card tokens for chat output.",
            inputSchema: objectSchema({
                space_id: stringSchema(),
                type_key: stringSchema("Anytype type key such as page, note, task, or collection"),
                name: stringSchema(),
                body: stringSchema("Markdown body"),
                template_id: stringSchema(),
                properties: propertyValuesSchema(),
            }, ["type_key"]),
        },
        {
            name: "anytype_update_object",
            description: "Update an existing Anytype object's name, Markdown body, or properties without changing its type. Read it first and preserve unrelated values. Returns a native link and AAG object reference.",
            inputSchema: objectSchema({
                space_id: stringSchema(),
                object_id: stringSchema(),
                name: stringSchema(),
                markdown: stringSchema(),
                properties: propertyValuesSchema(),
            }, ["object_id"]),
        },
        {
            name: "anytype_add_to_list",
            description: "Add objects to an Anytype collection.",
            inputSchema: objectSchema({
                space_id: stringSchema(),
                list_id: stringSchema(),
                object_ids: { type: "array", items: { type: "string" }, minItems: 1 },
            }, ["list_id", "object_ids"]),
        },
        {
            name: "anytype_remove_from_list",
            description: "Remove one object from an Anytype collection without archiving the object.",
            inputSchema: objectSchema({ space_id: stringSchema(), list_id: stringSchema(), object_id: stringSchema() }, ["list_id", "object_id"]),
        },
        {
            name: "anytype_upload_file",
            description: "Upload a file from an allowed project/file root into Anytype.",
            inputSchema: objectSchema({ space_id: stringSchema(), path: stringSchema("Absolute local file path") }, ["path"]),
        },
        ...(config.tools.anytype.allowArchive
            ? [
                {
                    name: "anytype_archive_object",
                    description: "Archive an Anytype object.",
                    inputSchema: objectSchema({ space_id: stringSchema(), object_id: stringSchema() }, [
                        "object_id",
                    ]),
                },
            ]
            : []),
        ...managementTools,
        ...codexTools,
    ];
}
export async function callTool(anytype, config, configPath, routeId, defaultSpaceId, name, input, boundActorId) {
    const requestedRouteId = typeof input.route_id === "string" && input.route_id ? baseRoute(input.route_id) : undefined;
    const boundRouteId = routeId ? baseRoute(routeId) : undefined;
    if (boundRouteId && requestedRouteId && requestedRouteId !== boundRouteId)
        throw new Error("route_id must match the current Anytype conversation");
    const effectiveRouteId = requestedRouteId ?? boundRouteId;
    if (name === "aag_context")
        return {
            gateway: "Anytype Agent Gateway",
            route_id: effectiveRouteId,
            space_id: defaultSpaceId,
            permissions: {
                allowed_space_ids: config.tools.anytype.allowedSpaceIds.includes("*")
                    ? "all spaces joined by this Anytype identity"
                    : config.tools.anytype.allowedSpaceIds.length
                        ? config.tools.anytype.allowedSpaceIds
                        : defaultSpaceId
                            ? [defaultSpaceId]
                            : [],
                write: config.tools.anytype.allowWrite,
                archive: config.tools.anytype.allowArchive,
                wake_changes: config.management.allowWakeChanges,
                access_changes: config.management.allowAccessChanges,
                file_roots: config.tools.anytype.allowedFileRoots,
            },
            response_format: "Anytype rich text; use short paragraphs and simple lists, avoid Markdown tables and fenced code blocks",
            object_links: "Use object_ref for a compact clickable mention. Use object_card when the user asks to send, attach, or show the object itself; AAG renders it as a native Anytype card. link is the deep-link fallback",
            object_workflow: "Discover types and properties first, read the target before updating it, preserve unrelated properties, then use the returned native link in the Anytype reply",
            scheduling: schedulingContext(config, effectiveRouteId, typeof input.discussion_root_id === "string" ? input.discussion_root_id : undefined),
        };
    if (name === "aag_set_wake") {
        if (!config.management.allowWakeChanges)
            throw new Error("Wake changes are disabled");
        if (!effectiveRouteId)
            throw new Error("route_id is required because this MCP process has no bound Anytype route");
        const routeSpaceId = spaceFromRoute(effectiveRouteId);
        if (!routeSpaceId)
            throw new Error("route_id does not contain a valid Anytype space");
        assertSpaceAllowed(config, routeSpaceId, defaultSpaceId);
        await setRouteWake({
            configPath,
            routeId: effectiveRouteId,
            humans: String(input.humans),
            ...(input.prefix ? { prefix: String(input.prefix) } : {}),
        });
        return { route_id: effectiveRouteId, humans: input.humans };
    }
    if (name === "aag_set_access") {
        if (!config.management.allowAccessChanges)
            throw new Error("Access changes are disabled");
        if (!effectiveRouteId)
            throw new Error("route_id is required because this MCP process has no bound Anytype route");
        const routeSpaceId = spaceFromRoute(effectiveRouteId);
        if (!routeSpaceId)
            throw new Error("route_id does not contain a valid Anytype space");
        assertSpaceAllowed(config, routeSpaceId, defaultSpaceId);
        const requestedActorId = required(input, "actor_id");
        if (boundActorId && requestedActorId !== boundActorId)
            throw new Error("actor_id must match the current Anytype sender");
        const allowedUsers = await setRouteAccess({
            configPath,
            routeId: effectiveRouteId,
            actorId: boundActorId ?? requestedActorId,
            operation: String(input.operation),
            participantIds: requiredArray(input, "participant_ids"),
        });
        return { route_id: effectiveRouteId, allowed_users: allowedUsers };
    }
    if (name === "aag_create_codex_task")
        return await createCodexTask(config, {
            project: required(input, "project"),
            prompt: required(input, "prompt"),
        });
    if (name === "aag_create_bound_chat") {
        const spaceId = String(input.space_id ?? defaultSpaceId ?? "");
        if (!spaceId)
            throw new Error("space_id is required outside a bound Anytype conversation");
        assertSpaceAllowed(config, spaceId, defaultSpaceId);
        return await createBoundCodexChat(anytype, config, configPath, {
            spaceId,
            name: required(input, "name"),
            project: required(input, "project"),
            prompt: required(input, "prompt"),
        });
    }
    if (name === "anytype_list_spaces") {
        const spaces = await anytype.listSpaces();
        return spaces.filter((space) => spaceAllowed(config, space.id, defaultSpaceId));
    }
    const spaceId = String(input.space_id ?? defaultSpaceId ?? "");
    if (!spaceId)
        throw new Error("space_id is required outside a bound Anytype conversation");
    assertSpaceAllowed(config, spaceId, defaultSpaceId);
    if (name === "anytype_list_chats")
        return await anytype.listChats(spaceId);
    if (name === "anytype_search") {
        const requestedLimit = Number(input.limit ?? 50);
        if (!Number.isFinite(requestedLimit) || requestedLimit < 1)
            throw new Error("limit must be a positive number");
        const results = await anytype.searchSpace(spaceId, {
            query: String(input.query ?? ""),
            ...(Array.isArray(input.types) ? { types: input.types.map(String) } : {}),
            limit: Math.min(Math.trunc(requestedLimit), 100),
        });
        return results.map((object) => withLink(object, spaceId));
    }
    if (name === "anytype_get_object")
        return withLink(await anytype.getObject(spaceId, required(input, "object_id")), spaceId);
    if (name === "anytype_list_types")
        return await anytype.listTypes(spaceId);
    if (name === "anytype_get_type")
        return await anytype.getType(spaceId, required(input, "type_id"));
    if (name === "anytype_list_properties")
        return await anytype.listProperties(spaceId);
    if (name === "anytype_get_property")
        return await anytype.getProperty(spaceId, required(input, "property_id"));
    if (name === "anytype_list_property_tags")
        return await anytype.listPropertyTags(spaceId, required(input, "property_id"));
    if (name === "anytype_list_templates")
        return await anytype.listTemplates(spaceId, required(input, "type_id"));
    if (name === "anytype_list_views")
        return await anytype.listViews(spaceId, required(input, "list_id"));
    if (name === "anytype_list_view_objects")
        return (await anytype.listViewObjects(spaceId, required(input, "list_id"), required(input, "view_id"), boundedPage(input))).map((object) => withLink(object, spaceId));
    if (!config.tools.anytype.allowWrite)
        throw new Error("Anytype writes are disabled for this agent");
    if (name === "anytype_create_object") {
        const payload = pick(input, ["type_key", "name", "body", "template_id", "properties"], ["type_key"]);
        if (payload.type_key === "collection" && payload.body !== undefined)
            throw new Error("Anytype collections cannot have a body. Create the collection without body, create the content object separately, then add it with anytype_add_to_list.");
        if (payload.properties !== undefined)
            payload.properties = validatedProperties(payload.properties);
        return withLink(await anytype.createObject(spaceId, payload), spaceId);
    }
    if (name === "anytype_update_object") {
        if (input.type_key !== undefined)
            throw new Error("Changing an object's type is not allowed through anytype_update_object");
        const payload = pick(input, ["name", "markdown", "properties"]);
        if (payload.properties !== undefined)
            payload.properties = validatedProperties(payload.properties);
        if (!Object.keys(payload).length)
            throw new Error("At least one of name, markdown, or properties is required");
        return withLink(await anytype.updateObject(spaceId, required(input, "object_id"), payload), spaceId);
    }
    if (name === "anytype_add_to_list") {
        const listId = required(input, "list_id");
        await anytype.addObjectsToList(spaceId, listId, requiredArray(input, "object_ids"));
        return {
            added: input.object_ids.length,
            list: anytypeLink(spaceId, listId),
            list_ref: `[[AAG_OBJECT:${listId}|Open collection]]`,
            list_card: `[[AAG_OBJECT_CARD:${listId}|Open collection]]`,
        };
    }
    if (name === "anytype_remove_from_list") {
        const listId = required(input, "list_id");
        const objectId = required(input, "object_id");
        await anytype.removeObjectFromList(spaceId, listId, objectId);
        return {
            removed: objectId,
            list: anytypeLink(spaceId, listId),
            list_ref: `[[AAG_OBJECT:${listId}|Open collection]]`,
            list_card: `[[AAG_OBJECT_CARD:${listId}|Open collection]]`,
        };
    }
    if (name === "anytype_upload_file") {
        const path = await allowedFile(config, required(input, "path"));
        return withLink(await anytype.uploadFile(spaceId, path), spaceId);
    }
    if (name === "anytype_archive_object") {
        if (!config.tools.anytype.allowArchive)
            throw new Error("Archiving is disabled for this agent");
        return withLink(await anytype.archiveObject(spaceId, required(input, "object_id")), spaceId);
    }
    throw rpcError(-32602, `Unknown tool: ${name}`);
}
function assertSpaceAllowed(config, spaceId, defaultSpaceId) {
    const explicit = config.tools.anytype.allowedSpaceIds;
    if (explicit.length) {
        if (!explicit.includes("*") && !explicit.includes(spaceId))
            throw new Error(`Space ${spaceId} is not allowed for this agent`);
        return;
    }
    if (defaultSpaceId === spaceId)
        return;
    throw new Error("No cross-space Anytype access is configured for this agent; set allowedSpaceIds explicitly");
}
function spaceAllowed(config, spaceId, defaultSpaceId) {
    const explicit = config.tools.anytype.allowedSpaceIds;
    if (explicit.includes("*"))
        return true;
    if (explicit.length)
        return explicit.includes(spaceId);
    return defaultSpaceId === spaceId;
}
async function allowedFile(config, value) {
    if (!isAbsolute(value))
        throw new Error("File path must be absolute");
    const path = await realpath(value);
    await access(path, constants.R_OK);
    const info = await stat(path);
    if (!info.isFile())
        throw new Error("Upload path must be a regular file");
    if (info.size > MAX_UPLOAD_BYTES)
        throw new Error(`Upload exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB limit`);
    const configured = config.tools.anytype.allowedFileRoots;
    if (!configured.length)
        throw new Error("File uploads require at least one explicit allowedFileRoots entry");
    for (const candidate of configured) {
        const root = await realpath(resolve(candidate)).catch(() => resolve(candidate));
        const child = relative(root, path);
        if (child === "" || (!child.startsWith("..") && !isAbsolute(child)))
            return path;
    }
    throw new Error("File is outside this agent's allowed file roots");
}
function withLink(object, spaceId) {
    const objectId = String(object.id ?? object.object_id ?? object.object?.id ?? "");
    if (!objectId)
        throw new Error("Anytype returned an object without an ID");
    const label = String(object.name ?? object.title ?? object.object?.name ?? "Open in Anytype")
        .replace(/[\n\r|\]]/gu, " ")
        .trim() || "Open in Anytype";
    return {
        ...object,
        link: anytypeLink(spaceId, objectId),
        object_ref: `[[AAG_OBJECT:${objectId}|${label}]]`,
        object_card: `[[AAG_OBJECT_CARD:${objectId}|${label}]]`,
    };
}
function anytypeLink(spaceId, objectId) {
    return `anytype://object?objectId=${encodeURIComponent(objectId)}&spaceId=${encodeURIComponent(spaceId)}`;
}
function required(input, key) {
    const value = input[key];
    if (typeof value !== "string" || !value)
        throw new Error(`${key} is required`);
    return value;
}
function requiredArray(input, key) {
    if (!Array.isArray(input[key]) || input[key].length === 0)
        throw new Error(`${key} is required`);
    return input[key].map(String);
}
function boundedPage(input) {
    const offset = Number(input.offset ?? 0);
    const limit = Number(input.limit ?? 50);
    if (!Number.isInteger(offset) || offset < 0)
        throw new Error("offset must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1)
        throw new Error("limit must be a positive integer");
    return { offset, limit: Math.min(limit, 100) };
}
function pick(input, keys, requiredKeys = []) {
    const value = {};
    for (const key of keys)
        if (input[key] !== undefined)
            value[key] = input[key];
    for (const key of requiredKeys)
        if (value[key] === undefined)
            throw new Error(`${key} is required`);
    return value;
}
function objectSchema(properties, required = []) {
    return {
        type: "object",
        properties,
        additionalProperties: false,
        ...(required.length ? { required } : {}),
    };
}
function stringSchema(description) {
    return { type: "string", ...(description ? { description } : {}) };
}
function propertyValuesSchema() {
    const properties = {
        key: stringSchema("Property key returned by anytype_list_properties or anytype_get_type"),
        text: { type: "string" },
        number: { type: "number" },
        select: { type: "string" },
        multi_select: { type: "array", items: { type: "string" } },
        date: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        checkbox: { type: "boolean" },
        url: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        objects: { type: "array", items: { type: "string" } },
    };
    return {
        type: "array",
        items: {
            type: "object",
            properties,
            required: ["key"],
            additionalProperties: false,
            oneOf: propertyValueFields.map((field) => ({ required: [field] })),
        },
    };
}
function validatedProperties(value) {
    if (!Array.isArray(value))
        throw new Error("properties must be an array");
    return value.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item))
            throw new Error(`properties[${index}] must be an object`);
        const property = item;
        const key = typeof property.key === "string" ? property.key.trim() : "";
        if (!key)
            throw new Error(`properties[${index}].key is required`);
        if (reservedPropertyKeys.has(key.toLowerCase()))
            throw new Error(`Property key ${key} is reserved and cannot be changed through AAG`);
        const fields = propertyValueFields.filter((field) => property[field] !== undefined);
        if (fields.length !== 1)
            throw new Error(`properties[${index}] must contain exactly one typed value`);
        const allowed = new Set(["key", fields[0]]);
        const extra = Object.keys(property).find((field) => !allowed.has(field));
        if (extra)
            throw new Error(`properties[${index}] contains unsupported field ${extra}`);
        validatePropertyValue(fields[0], property[fields[0]], index);
        return { key, [fields[0]]: property[fields[0]] };
    });
}
function validatePropertyValue(field, value, index) {
    if (field === "number" && typeof value !== "number")
        throw new Error(`properties[${index}].number must be a number`);
    if (field === "checkbox" && typeof value !== "boolean")
        throw new Error(`properties[${index}].checkbox must be a boolean`);
    if (["multi_select", "files", "objects"].includes(field) &&
        (!Array.isArray(value) || value.some((item) => typeof item !== "string")))
        throw new Error(`properties[${index}].${field} must be an array of strings`);
    if (!["number", "checkbox", "multi_select", "files", "objects"].includes(field) &&
        typeof value !== "string")
        throw new Error(`properties[${index}].${field} must be a string`);
}
function rpcError(code, message) {
    return Object.assign(new Error(message), { code });
}
function write(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}
function spaceFromRoute(routeId) {
    return /^(?:aag:)?(?:chat|discussion):([^:]+)/.exec(routeId ?? "")?.[1];
}
function baseRoute(routeId) {
    return routeId
        .replace(/^aag:/, "")
        .replace(/:g\d+$/, "")
        .replace(/:root:.+$/, "");
}
function schedulingContext(config, routeId, discussionRootId) {
    if (config.runtime.kind !== "openclaw")
        return {
            provider: "codex",
            available: false,
            reason: "This Codex ACP connection has no native scheduled-task integration; AAG does not emulate a scheduler",
        };
    if (!routeId)
        return {
            provider: "openclaw",
            available: false,
            reason: "A bound Anytype route is required before native scheduled delivery can be prepared",
        };
    const route = parseRouteId(routeId);
    if (!route)
        return { provider: "openclaw", available: false, reason: "The Anytype route is invalid" };
    if (route.kind === "discussion" && !discussionRootId)
        return {
            provider: "openclaw",
            available: false,
            reason: "discussion_root_id is required to preserve one OpenClaw session per discussion",
        };
    if (route.kind === "chat" && discussionRootId)
        throw new Error("discussion_root_id is only valid for discussion routes");
    const threadKey = route.kind === "discussion" ? `${routeId}:root:${discussionRootId}` : routeId;
    const store = new Store(config.state.path);
    let nativeSessionKey;
    try {
        nativeSessionKey = store.sessionBinding(threadKey)?.nativeSessionKey;
    }
    finally {
        store.close();
    }
    if (!nativeSessionKey)
        return {
            provider: "openclaw",
            available: false,
            reason: "This Anytype conversation has not established an OpenClaw session binding yet",
        };
    const target = encodeAnytypeTarget({
        spaceId: route.spaceId,
        chatId: route.chatId,
        ...(discussionRootId ? { discussionRootId } : {}),
    });
    return {
        provider: "openclaw",
        available: true,
        scheduler: "OpenClaw cron/automations",
        session_key: nativeSessionKey,
        delivery_channel: "anytype",
        delivery_target: target,
        continuation_argv: [
            config.runtime.command,
            "agent",
            "--session-key",
            nativeSessionKey,
            "--message",
            "<scheduled prompt>",
            "--deliver",
            "--reply-channel",
            "anytype",
            "--reply-to",
            target,
        ],
        instructions: "Create a native OpenClaw command job with continuation_argv, replacing <scheduled prompt>. Do not create a plain agentTurn cron job: OpenClaw isolates those under a cron session key. The command job continues this exact conversation session and delivers its agent output to this Anytype route. AAG remains only the channel bridge and does not own the schedule.",
    };
}
function parseRouteId(routeId) {
    const match = /^(chat|discussion):([^:]+):([^:]+)$/.exec(baseRoute(routeId));
    if (!match)
        return undefined;
    return { kind: match[1], spaceId: match[2], chatId: match[3] };
}
function encodeAnytypeTarget(route) {
    const payload = route.discussionRootId
        ? [route.spaceId, route.chatId, route.discussionRootId]
        : [route.spaceId, route.chatId];
    return `route:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}
function soleAllowedSpace(config) {
    return config.tools.anytype.allowedSpaceIds.length === 1
        ? config.tools.anytype.allowedSpaceIds[0]
        : undefined;
}

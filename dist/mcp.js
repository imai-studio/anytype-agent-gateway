import { access, constants, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { AnytypeClient } from "./anytype-client.js";
import { loadConfig } from "./config.js";
import { setRouteWake } from "./management.js";
import { VERSION } from "./version.js";
export async function runMcpServer(configPath, context = {}) {
    const config = await loadConfig(configPath);
    if (!config.tools.anytype.enabled)
        throw new Error("Anytype tools are disabled in this AAG configuration");
    const anytype = await AnytypeClient.create(config);
    const routeId = context.routeId ?? process.env.AAG_ROUTE_ID;
    const defaultSpaceId = context.spaceId ?? process.env.AAG_SPACE_ID ?? spaceFromRoute(routeId);
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
                result = { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "aag-anytype", version: VERSION } };
            else if (request.method === "ping")
                result = {};
            else if (request.method === "tools/list")
                result = { tools };
            else if (request.method === "tools/call") {
                try {
                    const value = await callTool(anytype, config, configPath, routeId, defaultSpaceId, String(request.params?.name ?? ""), request.params?.arguments ?? {});
                    result = { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
                }
                catch (error) {
                    result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
                }
            }
            else
                throw rpcError(-32601, `Method not found: ${request.method ?? ""}`);
            write({ jsonrpc: "2.0", id: request.id, result });
        }
        catch (error) {
            const rpc = error;
            write({ jsonrpc: "2.0", id: request.id, error: { code: rpc.code ?? -32000, message: rpc.message } });
        }
    }
}
export function toolDefinitions(config) {
    const readTools = [
        { name: "aag_context", description: "Describe the current Anytype gateway route, permissions, formatting rules, and available capabilities.", inputSchema: objectSchema({}) },
        { name: "anytype_search", description: "Search objects in an allowed Anytype space.", inputSchema: objectSchema({ space_id: stringSchema("Space ID; omit to use the current conversation space"), query: stringSchema("Text query"), types: { type: "array", items: { type: "string" } }, limit: { type: "integer", minimum: 1, maximum: 100 } }) },
        { name: "anytype_get_object", description: "Read a complete Anytype object, including its Markdown body and properties.", inputSchema: objectSchema({ space_id: stringSchema(), object_id: stringSchema() }, ["object_id"]) }
    ];
    const managementTools = config.management.allowWakeChanges
        ? [{ name: "aag_set_wake", description: "Change how this agent wakes in the current Anytype chat or discussion.", inputSchema: objectSchema({ humans: { type: "string", enum: ["mention", "mention-or-reply", "every-message", "prefix", "disabled"] }, prefix: stringSchema() }, ["humans"]) }]
        : [];
    if (!config.tools.anytype.allowWrite)
        return [...readTools, ...managementTools];
    return [...readTools,
        { name: "anytype_create_object", description: "Create an object in an allowed Anytype space. Returns a native Anytype link.", inputSchema: objectSchema({ space_id: stringSchema(), type_key: stringSchema("Anytype type key such as page, note, task, or collection"), name: stringSchema(), body: stringSchema("Markdown body"), template_id: stringSchema(), properties: { type: "array", items: { type: "object" } } }, ["type_key"]) },
        { name: "anytype_update_object", description: "Update an existing Anytype object and return its native link.", inputSchema: objectSchema({ space_id: stringSchema(), object_id: stringSchema(), type_key: stringSchema(), name: stringSchema(), markdown: stringSchema(), properties: { type: "array", items: { type: "object" } } }, ["object_id"]) },
        { name: "anytype_add_to_list", description: "Add objects to an Anytype collection.", inputSchema: objectSchema({ space_id: stringSchema(), list_id: stringSchema(), object_ids: { type: "array", items: { type: "string" }, minItems: 1 } }, ["list_id", "object_ids"]) },
        { name: "anytype_upload_file", description: "Upload a file from an allowed project/file root into Anytype.", inputSchema: objectSchema({ space_id: stringSchema(), path: stringSchema("Absolute local file path") }, ["path"]) },
        ...(config.tools.anytype.allowArchive ? [{ name: "anytype_archive_object", description: "Archive an Anytype object.", inputSchema: objectSchema({ space_id: stringSchema(), object_id: stringSchema() }, ["object_id"]) }] : []),
        ...managementTools
    ];
}
export async function callTool(anytype, config, configPath, routeId, defaultSpaceId, name, input) {
    if (name === "aag_context")
        return {
            gateway: "Anytype Agent Gateway",
            route_id: routeId,
            space_id: defaultSpaceId,
            permissions: {
                allowed_space_ids: config.tools.anytype.allowedSpaceIds.length ? config.tools.anytype.allowedSpaceIds : defaultSpaceId ? [defaultSpaceId] : [],
                write: config.tools.anytype.allowWrite,
                archive: config.tools.anytype.allowArchive,
                wake_changes: config.management.allowWakeChanges && Boolean(routeId),
                file_roots: config.tools.anytype.allowedFileRoots.length ? config.tools.anytype.allowedFileRoots : [config.runtime.defaultProject, ...config.runtime.allowedProjects].filter(Boolean),
            },
            response_format: "Anytype rich text; use short paragraphs and simple lists, avoid Markdown tables and fenced code blocks",
            object_links: "Use the native anytype:// link returned by object tools when referring to created or found objects",
            scheduling: config.runtime.kind === "openclaw"
                ? "Use OpenClaw's native scheduler and keep delivery on the current bound session; AAG does not schedule jobs"
                : "This Codex ACP connection has no native scheduled-task integration; AAG does not schedule jobs",
        };
    if (name === "aag_set_wake") {
        if (!config.management.allowWakeChanges)
            throw new Error("Wake changes are disabled");
        if (!routeId)
            throw new Error("This tool was not launched with an Anytype route context");
        await setRouteWake({ configPath, routeId: baseRoute(routeId), humans: String(input.humans), ...(input.prefix ? { prefix: String(input.prefix) } : {}) });
        return { route_id: baseRoute(routeId), humans: input.humans };
    }
    const spaceId = String(input.space_id ?? defaultSpaceId ?? "");
    if (!spaceId)
        throw new Error("space_id is required outside a bound Anytype conversation");
    assertSpaceAllowed(config, spaceId, defaultSpaceId);
    if (name === "anytype_search") {
        const requestedLimit = Number(input.limit ?? 50);
        if (!Number.isFinite(requestedLimit) || requestedLimit < 1)
            throw new Error("limit must be a positive number");
        return await anytype.searchSpace(spaceId, { query: String(input.query ?? ""), ...(Array.isArray(input.types) ? { types: input.types.map(String) } : {}), limit: Math.min(Math.trunc(requestedLimit), 100) });
    }
    if (name === "anytype_get_object")
        return withLink(await anytype.getObject(spaceId, required(input, "object_id")), spaceId);
    if (!config.tools.anytype.allowWrite)
        throw new Error("Anytype writes are disabled for this agent");
    if (name === "anytype_create_object")
        return withLink(await anytype.createObject(spaceId, pick(input, ["type_key", "name", "body", "template_id", "properties"], ["type_key"])), spaceId);
    if (name === "anytype_update_object")
        return withLink(await anytype.updateObject(spaceId, required(input, "object_id"), pick(input, ["type_key", "name", "markdown", "properties"])), spaceId);
    if (name === "anytype_add_to_list") {
        await anytype.addObjectsToList(spaceId, required(input, "list_id"), requiredArray(input, "object_ids"));
        return { added: input.object_ids.length, list: anytypeLink(spaceId, input.list_id) };
    }
    if (name === "anytype_upload_file") {
        const path = await allowedFile(config, required(input, "path"));
        const file = await anytype.uploadFile(spaceId, path);
        return { ...file, link: anytypeLink(spaceId, String(file.object_id ?? "")) };
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
        if (!explicit.includes(spaceId))
            throw new Error(`Space ${spaceId} is not allowed for this agent`);
        return;
    }
    if (defaultSpaceId === spaceId)
        return;
    throw new Error("No cross-space Anytype access is configured for this agent; set allowedSpaceIds explicitly");
}
async function allowedFile(config, value) {
    if (!isAbsolute(value))
        throw new Error("File path must be absolute");
    const path = await realpath(value);
    await access(path, constants.R_OK);
    const configured = config.tools.anytype.allowedFileRoots.length ? config.tools.anytype.allowedFileRoots : [config.runtime.defaultProject, ...config.runtime.allowedProjects].filter(Boolean);
    for (const candidate of configured) {
        const root = await realpath(resolve(candidate)).catch(() => resolve(candidate));
        const child = relative(root, path);
        if (child === "" || (!child.startsWith("..") && !isAbsolute(child)))
            return path;
    }
    throw new Error("File is outside this agent's allowed file roots");
}
function withLink(object, spaceId) { return { ...object, link: anytypeLink(spaceId, String(object.id ?? object.object_id ?? "")) }; }
function anytypeLink(spaceId, objectId) { return `anytype://object/?objectId=${encodeURIComponent(objectId)}&spaceId=${encodeURIComponent(spaceId)}`; }
function required(input, key) { const value = input[key]; if (typeof value !== "string" || !value)
    throw new Error(`${key} is required`); return value; }
function requiredArray(input, key) { if (!Array.isArray(input[key]) || input[key].length === 0)
    throw new Error(`${key} is required`); return input[key].map(String); }
function pick(input, keys, requiredKeys = []) { const value = {}; for (const key of keys)
    if (input[key] !== undefined)
        value[key] = input[key]; for (const key of requiredKeys)
    if (value[key] === undefined)
        throw new Error(`${key} is required`); return value; }
function objectSchema(properties, required = []) { return { type: "object", properties, additionalProperties: false, ...(required.length ? { required } : {}) }; }
function stringSchema(description) { return { type: "string", ...(description ? { description } : {}) }; }
function rpcError(code, message) { return Object.assign(new Error(message), { code }); }
function write(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function spaceFromRoute(routeId) { return /^(?:aag:)?(?:chat|discussion):([^:]+)/.exec(routeId ?? "")?.[1]; }
function baseRoute(routeId) { return routeId.replace(/^aag:/, "").replace(/:g\d+$/, "").replace(/:root:.+$/, ""); }

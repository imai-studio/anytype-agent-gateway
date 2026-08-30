import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { AnytypeClient } from "./anytype-client.js";
import { createBoundCodexChat } from "./bound-chat.js";
import { createCodexTask } from "./codex-task.js";
import { loadConfig, type AgentConfig } from "./config.js";
import { setRouteAccess, setRouteWake } from "./management.js";
import { modelAllowed } from "./model-command.js";
import { Store } from "./store.js";
import { VERSION } from "./version.js";
import { resolveProductEnvironment } from "./compatibility.js";
import { principalAllowed, principalFromParticipantId } from "./principal.js";

type Request = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
};
type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

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
] as const;
const reservedPropertyKeys = new Set([
  "archived",
  "id",
  "layout",
  "object",
  "space_id",
  "type",
  "type_key",
]);

export async function runMcpServer(
  configPath: string,
  context: { routeId?: string; spaceId?: string; actorId?: string } = {},
): Promise<void> {
  const config = await loadConfig(configPath);
  if (!config.tools.anytype.enabled && !config.tools.codex.enabled)
    throw new Error("All AAG tools are disabled in this configuration");
  const anytype = await AnytypeClient.create(config);
  const routeId = context.routeId ?? resolveProductEnvironment("ROUTE_ID");
  const configuredActorId = context.actorId ?? resolveProductEnvironment("ACTOR_ID");
  const actorFile = resolveProductEnvironment("ACTOR_FILE");
  const discussionRootId = resolveProductEnvironment("DISCUSSION_ROOT_ID");
  const defaultSpaceId =
    context.spaceId ??
    resolveProductEnvironment("SPACE_ID") ??
    spaceFromRoute(routeId) ??
    soleAllowedSpace(config);
  const tools = toolDefinitions(config);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
    } catch {
      continue;
    }
    if (request.id === undefined || request.id === null) continue;
    try {
      let result: unknown;
      if (request.method === "initialize")
        result = {
          protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "aag-anytype", version: VERSION },
        };
      else if (request.method === "ping") result = {};
      else if (request.method === "tools/list") result = { tools };
      else if (request.method === "tools/call") {
        try {
          const actorId = await currentActorId(configuredActorId, actorFile);
          const value = await callTool(
            anytype,
            config,
            configPath,
            routeId,
            defaultSpaceId,
            String(request.params?.name ?? ""),
            request.params?.arguments ?? {},
            actorId,
            discussionRootId,
          );
          result = { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
        } catch (error) {
          result = {
            content: [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ],
            isError: true,
          };
        }
      } else throw rpcError(-32601, `Method not found: ${request.method ?? ""}`);
      write({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      const rpc = error as Error & { code?: number };
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: rpc.code ?? -32000, message: rpc.message },
      });
    }
  }
}

async function currentActorId(
  configuredActorId: string | undefined,
  actorFile: string | undefined,
): Promise<string | undefined> {
  if (!actorFile) return configuredActorId;
  try {
    const value = JSON.parse(await readFile(actorFile, "utf8")) as {
      actorId?: unknown;
      participantId?: unknown;
      provenance?: unknown;
    };
    if (value.provenance !== undefined && value.provenance !== "anytype-native") return undefined;
    const actorId = value.participantId ?? value.actorId;
    return typeof actorId === "string" && actorId ? actorId : undefined;
  } catch {
    return undefined;
  }
}

export function toolDefinitions(config: AgentConfig): Tool[] {
  const readTools: Tool[] = [
    {
      name: "aag_context",
      description:
        "Describe the current Anytype gateway route, permissions, formatting rules, and available capabilities.",
      inputSchema: objectSchema({
        route_id: stringSchema(
          "Optional Anytype route when the MCP process is shared across conversations",
        ),
        discussion_root_id: stringSchema(
          "Current top-level comment ID for a discussion route; omit for chats",
        ),
      }),
    },
    {
      name: "anytype_list_spaces",
      description:
        "List the Anytype spaces this agent identity has joined and its policy permits it to inspect.",
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
      description:
        "Read a complete Anytype object, including its type, Markdown body, and properties.",
      inputSchema: objectSchema({ space_id: stringSchema(), object_id: stringSchema() }, [
        "object_id",
      ]),
    },
    {
      name: "anytype_list_types",
      description:
        "List the available Anytype types and their keys before creating or changing objects.",
      inputSchema: objectSchema({ space_id: stringSchema() }),
    },
    {
      name: "anytype_get_type",
      description:
        "Get one Anytype type definition by ID, including its layout and configured properties.",
      inputSchema: objectSchema({ space_id: stringSchema(), type_id: stringSchema() }, ["type_id"]),
    },
    {
      name: "anytype_list_properties",
      description:
        "List the available Anytype properties, keys, and formats before writing object properties.",
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
      description:
        "List templates available for an Anytype type before creating an object from a template.",
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
      inputSchema: objectSchema(
        {
          space_id: stringSchema(),
          list_id: stringSchema(),
          view_id: stringSchema(),
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        ["list_id", "view_id"],
      ),
    },
  ];
  const managementTools: Tool[] = [
    ...(config.management.allowWakeChanges
      ? [
          {
            name: "aag_set_wake",
            description:
              "Change how this agent wakes in an Anytype chat or discussion. Pass route_id when the MCP process has no bound route.",
            inputSchema: objectSchema(
              {
                route_id: stringSchema(
                  "chat:<space-id>:<chat-id> or discussion:<space-id>:<discussion-id>",
                ),
                humans: {
                  type: "string",
                  enum: ["mention", "mention-or-reply", "every-message", "prefix", "disabled"],
                },
                prefix: stringSchema(),
              },
              ["humans"],
            ),
          },
        ]
      : []),
    ...(config.management.allowAccessChanges
      ? [
          {
            name: "aag_set_access",
            description:
              "Add or remove native Anytype participant IDs from this route's sender allowlist. Only a configured access admin can authorize the change.",
            inputSchema: objectSchema(
              {
                route_id: stringSchema(
                  "chat:<space-id>:<chat-id> or discussion:<space-id>:<discussion-id>",
                ),
                actor_id: stringSchema("Native participant ID of the user requesting the change"),
                operation: { type: "string", enum: ["add", "remove", "replace"] },
                participant_ids: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                },
              },
              ["actor_id", "operation", "participant_ids"],
            ),
          },
        ]
      : []),
    ...(config.models.enabled
      ? [
          {
            name: "aag_list_models",
            description:
              "List the harness models cached for this Anytype conversation and its current selection.",
            inputSchema: objectSchema({
              route_id: stringSchema(),
              discussion_root_id: stringSchema(),
            }),
          },
        ]
      : []),
    ...(config.models.enabled && config.management.allowModelChanges
      ? [
          {
            name: "aag_set_model",
            description:
              "Select a cached native harness model for this conversation. The selection applies on the next turn. Use model_id=default to restore the harness default.",
            inputSchema: objectSchema(
              {
                route_id: stringSchema(),
                discussion_root_id: stringSchema(),
                model_id: stringSchema("Exact model ID from aag_list_models, or default"),
              },
              ["model_id"],
            ),
          },
        ]
      : []),
  ];
  const codexTools: Tool[] = config.tools.codex.enabled
    ? [
        {
          name: "aag_create_codex_task",
          description:
            "Create and start a separate persistent Codex task in the agent's default or allowed projects. Use only when the user explicitly asks for a separate task or thread; ordinary work stays in the current session.",
          inputSchema: objectSchema(
            {
              project: stringSchema(
                "Configured absolute project path or its unique final directory name",
              ),
              prompt: stringSchema("Complete initial instructions for the new Codex task"),
            },
            ["project", "prompt"],
          ),
        },
        ...(config.tools.anytype.allowWrite
          ? [
              {
                name: "aag_create_bound_chat",
                description:
                  "Create an Anytype chat and bind it one-to-one to a new persistent Codex task in a configured project. Use only when the user explicitly asks for a new linked Anytype chat and Codex task.",
                inputSchema: objectSchema(
                  {
                    space_id: stringSchema(
                      "Configured Anytype space ID; omit to use the current conversation space",
                    ),
                    name: stringSchema("Name for the new Anytype chat"),
                    project: stringSchema(
                      "Configured absolute project path or its unique final directory name",
                    ),
                    prompt: stringSchema(
                      "Complete initial instructions for the Codex task backing the new chat",
                    ),
                  },
                  ["name", "project", "prompt"],
                ),
              },
            ]
          : []),
      ]
    : [];
  if (!config.tools.anytype.allowWrite) return [...readTools, ...managementTools, ...codexTools];
  return [
    ...readTools,
    {
      name: "anytype_create_object",
      description:
        "Create an object in an allowed Anytype space. Collections must be created without a body; create their content separately and add it with anytype_add_to_list. Returns compact-reference and native-card tokens for chat output.",
      inputSchema: objectSchema(
        {
          space_id: stringSchema(),
          type_key: stringSchema("Anytype type key such as page, note, task, or collection"),
          name: stringSchema(),
          body: stringSchema("Markdown body"),
          template_id: stringSchema(),
          properties: propertyValuesSchema(),
        },
        ["type_key"],
      ),
    },
    {
      name: "anytype_update_object",
      description:
        "Update an existing Anytype object's name, Markdown body, or properties without changing its type. Read it first and preserve unrelated values. Returns a native link and AAG object reference.",
      inputSchema: objectSchema(
        {
          space_id: stringSchema(),
          object_id: stringSchema(),
          name: stringSchema(),
          markdown: stringSchema(),
          properties: propertyValuesSchema(),
        },
        ["object_id"],
      ),
    },
    {
      name: "anytype_add_to_list",
      description: "Add objects to an Anytype collection.",
      inputSchema: objectSchema(
        {
          space_id: stringSchema(),
          list_id: stringSchema(),
          object_ids: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        ["list_id", "object_ids"],
      ),
    },
    {
      name: "anytype_remove_from_list",
      description: "Remove one object from an Anytype collection without archiving the object.",
      inputSchema: objectSchema(
        { space_id: stringSchema(), list_id: stringSchema(), object_id: stringSchema() },
        ["list_id", "object_id"],
      ),
    },
    {
      name: "anytype_upload_file",
      description: "Upload a file from an allowed project/file root into Anytype.",
      inputSchema: objectSchema(
        { space_id: stringSchema(), path: stringSchema("Absolute local file path") },
        ["path"],
      ),
    },
    {
      name: "aag_set_profile_image",
      description:
        "Set this agent identity's own Anytype profile image from an allowed local image file. The target identity is fixed by AAG and cannot be changed by the caller.",
      inputSchema: objectSchema(
        { space_id: stringSchema(), path: stringSchema("Absolute local image file path") },
        ["path"],
      ),
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

export async function callTool(
  anytype: AnytypeClient,
  config: AgentConfig,
  configPath: string,
  routeId: string | undefined,
  defaultSpaceId: string | undefined,
  name: string,
  input: Record<string, any>,
  boundActorId?: string,
  boundDiscussionRootId?: string,
): Promise<unknown> {
  const requestedRouteId =
    typeof input.route_id === "string" && input.route_id ? baseRoute(input.route_id) : undefined;
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
        model_changes: config.management.allowModelChanges,
        file_roots: config.tools.anytype.allowedFileRoots,
      },
      response_format:
        "Anytype rich text; use short paragraphs and simple lists, avoid Markdown tables and fenced code blocks",
      object_links:
        "Use object_ref for a compact clickable mention. Use object_card when the user asks to send, attach, or show the object itself; AAG renders it as a native Anytype card. link is the deep-link fallback",
      object_workflow:
        "Discover types and properties first, read the target before updating it, preserve unrelated properties, then use the returned native link in the Anytype reply",
      scheduling: schedulingContext(
        config,
        effectiveRouteId,
        typeof input.discussion_root_id === "string" ? input.discussion_root_id : undefined,
      ),
    };
  if (name === "aag_list_models" || name === "aag_set_model") {
    if (!config.models.enabled) throw new Error("Model selection is disabled");
    if (!effectiveRouteId)
      throw new Error("route_id is required because this MCP process has no bound Anytype route");
    const routeSpaceId = spaceFromRoute(effectiveRouteId);
    if (!routeSpaceId) throw new Error("The Anytype route does not contain a valid space ID");
    if (!boundRouteId) assertSpaceAllowed(config, routeSpaceId, defaultSpaceId);
    const requestedDiscussionRoot =
      typeof input.discussion_root_id === "string" ? input.discussion_root_id : undefined;
    if (
      boundDiscussionRootId &&
      requestedDiscussionRoot &&
      requestedDiscussionRoot !== boundDiscussionRootId
    )
      throw new Error("discussion_root_id must match the current Anytype discussion");
    const discussionRoot = boundDiscussionRootId ?? requestedDiscussionRoot;
    const threadKey = effectiveRouteId.startsWith("discussion:")
      ? discussionRoot
        ? `${effectiveRouteId}:root:${discussionRoot}`
        : undefined
      : effectiveRouteId;
    if (!threadKey) throw new Error("discussion_root_id is required for discussion model settings");
    const store = new Store(config.state.path);
    try {
      const runtime = config.runtime.kind === "openclaw" ? "openclaw" : "codex-acp";
      const current = store.conversationModel(threadKey, runtime);
      if (name === "aag_list_models")
        return {
          thread_key: threadKey,
          current_model: current?.appliedModelId ?? current?.requestedModelId ?? "harness default",
          requested_model: current?.requestedModelId ?? null,
          models: current?.catalog ?? [],
        };
      if (!config.management.allowModelChanges) throw new Error("Model changes are disabled");
      const boundPrincipal = boundActorId ? principalFromParticipantId(boundActorId) : undefined;
      if (!principalAllowed(boundPrincipal, config.management.modelAdmins))
        throw new Error("The current Anytype sender is not allowed to change models");
      const requested = required(input, "model_id");
      const reset = /^(?:default|reset)$/i.test(requested);
      const resolved = reset
        ? undefined
        : current?.catalog.find(
            (model) =>
              model.id === requested ||
              model.name.toLocaleLowerCase() === requested.toLocaleLowerCase(),
          )?.id;
      if (!reset && !resolved) throw new Error("Use an exact model from aag_list_models");
      if (resolved && !modelAllowed(resolved, config.models.allowed))
        throw new Error("That model is not allowed");
      const saved = store.saveConversationModel({
        threadKey,
        runtime: config.runtime.kind === "openclaw" ? "openclaw" : "codex-acp",
        ...(resolved ? { requestedModelId: resolved } : {}),
        useDefault: reset,
        ...(current?.appliedGeneration === undefined
          ? {}
          : { appliedGeneration: current.appliedGeneration }),
        ...(current?.appliedModelId ? { appliedModelId: current.appliedModelId } : {}),
        ...(current?.defaultModelId ? { defaultModelId: current.defaultModelId } : {}),
        catalog: current?.catalog ?? [],
        ...(boundActorId ? { updatedBy: boundActorId } : {}),
      });
      return {
        thread_key: threadKey,
        requested_model: saved.requestedModelId ?? "harness default",
        applies: "next turn",
      };
    } finally {
      store.close();
    }
  }
  if (name === "aag_set_wake") {
    if (!config.management.allowWakeChanges) throw new Error("Wake changes are disabled");
    if (!effectiveRouteId)
      throw new Error("route_id is required because this MCP process has no bound Anytype route");
    const routeSpaceId = spaceFromRoute(effectiveRouteId);
    if (!routeSpaceId) throw new Error("route_id does not contain a valid Anytype space");
    assertSpaceAllowed(config, routeSpaceId, defaultSpaceId);
    const boundPrincipal = boundActorId ? principalFromParticipantId(boundActorId) : undefined;
    if (!boundPrincipal) throw new Error("The current Anytype sender could not be verified");
    await setRouteWake({
      configPath,
      routeId: effectiveRouteId,
      humans: String(input.humans),
      actor: boundPrincipal,
      ...(input.prefix ? { prefix: String(input.prefix) } : {}),
    });
    return { route_id: effectiveRouteId, humans: input.humans };
  }
  if (name === "aag_set_access") {
    if (!config.management.allowAccessChanges) throw new Error("Access changes are disabled");
    if (!effectiveRouteId)
      throw new Error("route_id is required because this MCP process has no bound Anytype route");
    const routeSpaceId = spaceFromRoute(effectiveRouteId);
    if (!routeSpaceId) throw new Error("route_id does not contain a valid Anytype space");
    assertSpaceAllowed(config, routeSpaceId, defaultSpaceId);
    const requestedActorId = required(input, "actor_id");
    if (!boundActorId) throw new Error("The current Anytype sender could not be verified");
    if (requestedActorId !== boundActorId)
      throw new Error("actor_id must match the current Anytype sender");
    const allowedUsers = await setRouteAccess({
      configPath,
      routeId: effectiveRouteId,
      actor: principalFromParticipantId(boundActorId)!,
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
    if (!spaceId) throw new Error("space_id is required outside a bound Anytype conversation");
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
  if (!spaceId) throw new Error("space_id is required outside a bound Anytype conversation");
  assertSpaceAllowed(config, spaceId, defaultSpaceId);
  if (name === "anytype_list_chats") return await anytype.listChats(spaceId);
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
  if (name === "anytype_list_types") return await anytype.listTypes(spaceId);
  if (name === "anytype_get_type")
    return await anytype.getType(spaceId, required(input, "type_id"));
  if (name === "anytype_list_properties") return await anytype.listProperties(spaceId);
  if (name === "anytype_get_property")
    return await anytype.getProperty(spaceId, required(input, "property_id"));
  if (name === "anytype_list_property_tags")
    return await anytype.listPropertyTags(spaceId, required(input, "property_id"));
  if (name === "anytype_list_templates")
    return await anytype.listTemplates(spaceId, required(input, "type_id"));
  if (name === "anytype_list_views")
    return await anytype.listViews(spaceId, required(input, "list_id"));
  if (name === "anytype_list_view_objects")
    return (
      await anytype.listViewObjects(
        spaceId,
        required(input, "list_id"),
        required(input, "view_id"),
        boundedPage(input),
      )
    ).map((object) => withLink(object, spaceId));
  if (!config.tools.anytype.allowWrite)
    throw new Error("Anytype writes are disabled for this agent");
  if (name === "anytype_create_object") {
    const payload = pick(
      input,
      ["type_key", "name", "body", "template_id", "properties"],
      ["type_key"],
    );
    if (payload.type_key === "collection" && payload.body !== undefined)
      throw new Error(
        "Anytype collections cannot have a body. Create the collection without body, create the content object separately, then add it with anytype_add_to_list.",
      );
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
    return withLink(
      await anytype.updateObject(spaceId, required(input, "object_id"), payload),
      spaceId,
    );
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
  if (name === "aag_set_profile_image") {
    const path = await allowedFile(config, required(input, "path"));
    if (!isImagePath(path)) throw new Error("Profile image must be a PNG, JPEG, WebP, or GIF file");
    const configuredSpace = config.spaces.find((space) => space.id === spaceId);
    const memberId = configuredSpace?.participantId ?? config.agent.participantId;
    if (!memberId)
      throw new Error(
        "This space needs spaces[].participantId or agent.participantId before AAG can update its own profile",
      );
    const updated = await anytype.setProfileImage(spaceId, path);
    return { updated: true, space_id: spaceId, member_id: memberId, ...updated };
  }
  if (name === "anytype_archive_object") {
    if (!config.tools.anytype.allowArchive) throw new Error("Archiving is disabled for this agent");
    return withLink(await anytype.archiveObject(spaceId, required(input, "object_id")), spaceId);
  }
  throw rpcError(-32602, `Unknown tool: ${name}`);
}

function assertSpaceAllowed(
  config: AgentConfig,
  spaceId: string,
  defaultSpaceId: string | undefined,
): void {
  const explicit = config.tools.anytype.allowedSpaceIds;
  if (explicit.length) {
    if (!explicit.includes("*") && !explicit.includes(spaceId))
      throw new Error(`Space ${spaceId} is not allowed for this agent`);
    return;
  }
  if (defaultSpaceId === spaceId) return;
  throw new Error(
    "No cross-space Anytype access is configured for this agent; set allowedSpaceIds explicitly",
  );
}

function spaceAllowed(
  config: AgentConfig,
  spaceId: string,
  defaultSpaceId: string | undefined,
): boolean {
  const explicit = config.tools.anytype.allowedSpaceIds;
  if (explicit.includes("*")) return true;
  if (explicit.length) return explicit.includes(spaceId);
  return defaultSpaceId === spaceId;
}

async function allowedFile(config: AgentConfig, value: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error("File path must be absolute");
  const path = await realpath(value);
  await access(path, constants.R_OK);
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Upload path must be a regular file");
  if (info.size > MAX_UPLOAD_BYTES)
    throw new Error(`Upload exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB limit`);
  const configured = config.tools.anytype.allowedFileRoots;
  if (!configured.length)
    throw new Error("File uploads require at least one explicit allowedFileRoots entry");
  for (const candidate of configured) {
    const root = await realpath(resolve(candidate)).catch(() => resolve(candidate));
    const child = relative(root, path);
    if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return path;
  }
  throw new Error("File is outside this agent's allowed file roots");
}

function isImagePath(path: string): boolean {
  return /\.(?:gif|jpe?g|png|webp)$/iu.test(path);
}

function withLink<T extends Record<string, any>>(
  object: T,
  spaceId: string,
): T & { link: string; object_ref: string; object_card: string } {
  const objectId = String(object.id ?? object.object_id ?? object.object?.id ?? "");
  if (!objectId) throw new Error("Anytype returned an object without an ID");
  const label =
    String(object.name ?? object.title ?? object.object?.name ?? "Open in Anytype")
      .replace(/[\n\r|\]]/gu, " ")
      .trim() || "Open in Anytype";
  return {
    ...object,
    link: anytypeLink(spaceId, objectId),
    object_ref: `[[AAG_OBJECT:${objectId}|${label}]]`,
    object_card: `[[AAG_OBJECT_CARD:${objectId}|${label}]]`,
  };
}
function anytypeLink(spaceId: string, objectId: string): string {
  return `anytype://object?objectId=${encodeURIComponent(objectId)}&spaceId=${encodeURIComponent(spaceId)}`;
}
function required(input: Record<string, any>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} is required`);
  return value;
}
function requiredArray(input: Record<string, any>, key: string): string[] {
  if (!Array.isArray(input[key]) || input[key].length === 0) throw new Error(`${key} is required`);
  return input[key].map(String);
}
function boundedPage(input: Record<string, any>): { offset: number; limit: number } {
  const offset = Number(input.offset ?? 0);
  const limit = Number(input.limit ?? 50);
  if (!Number.isInteger(offset) || offset < 0)
    throw new Error("offset must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  return { offset, limit: Math.min(limit, 100) };
}
function pick(input: Record<string, any>, keys: string[], requiredKeys: string[] = []): any {
  const value: Record<string, any> = {};
  for (const key of keys) if (input[key] !== undefined) value[key] = input[key];
  for (const key of requiredKeys)
    if (value[key] === undefined) throw new Error(`${key} is required`);
  return value;
}
function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length ? { required } : {}),
  };
}
function stringSchema(description?: string): Record<string, unknown> {
  return { type: "string", ...(description ? { description } : {}) };
}
function propertyValuesSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {
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

function validatedProperties(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("properties must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error(`properties[${index}] must be an object`);
    const property = item as Record<string, unknown>;
    const key = typeof property.key === "string" ? property.key.trim() : "";
    if (!key) throw new Error(`properties[${index}].key is required`);
    if (reservedPropertyKeys.has(key.toLowerCase()))
      throw new Error(`Property key ${key} is reserved and cannot be changed through AAG`);
    const fields = propertyValueFields.filter((field) => property[field] !== undefined);
    if (fields.length !== 1)
      throw new Error(`properties[${index}] must contain exactly one typed value`);
    const allowed = new Set<string>(["key", fields[0]!]);
    const extra = Object.keys(property).find((field) => !allowed.has(field));
    if (extra) throw new Error(`properties[${index}] contains unsupported field ${extra}`);
    validatePropertyValue(fields[0]!, property[fields[0]!] as unknown, index);
    return { key, [fields[0]!]: property[fields[0]!] };
  });
}

function validatePropertyValue(
  field: (typeof propertyValueFields)[number],
  value: unknown,
  index: number,
): void {
  if (field === "number" && typeof value !== "number")
    throw new Error(`properties[${index}].number must be a number`);
  if (field === "checkbox" && typeof value !== "boolean")
    throw new Error(`properties[${index}].checkbox must be a boolean`);
  if (
    ["multi_select", "files", "objects"].includes(field) &&
    (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
  )
    throw new Error(`properties[${index}].${field} must be an array of strings`);
  if (
    !["number", "checkbox", "multi_select", "files", "objects"].includes(field) &&
    typeof value !== "string"
  )
    throw new Error(`properties[${index}].${field} must be a string`);
}
function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}
function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function spaceFromRoute(routeId?: string): string | undefined {
  return /^(?:aag:)?(?:chat|discussion):([^:]+)/.exec(routeId ?? "")?.[1];
}
function baseRoute(routeId: string): string {
  return routeId
    .replace(/^aag:/, "")
    .replace(/:g\d+$/, "")
    .replace(/:root:.+$/, "");
}

function schedulingContext(
  config: AgentConfig,
  routeId: string | undefined,
  discussionRootId: string | undefined,
): Record<string, unknown> {
  if (config.runtime.kind !== "openclaw")
    return {
      provider: "codex",
      available: false,
      reason:
        "This Codex ACP connection has no native scheduled-task integration; AAG does not emulate a scheduler",
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
  let nativeSessionKey: string | undefined;
  try {
    nativeSessionKey = store.sessionBinding(threadKey)?.nativeSessionKey;
  } finally {
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
    instructions:
      "Create a native OpenClaw command job with continuation_argv, replacing <scheduled prompt>. Do not create a plain agentTurn cron job: OpenClaw isolates those under a cron session key. The command job continues this exact conversation session and delivers its agent output to this Anytype route. AAG remains only the channel bridge and does not own the schedule.",
  };
}

function parseRouteId(
  routeId: string,
): { kind: "chat" | "discussion"; spaceId: string; chatId: string } | undefined {
  const match = /^(chat|discussion):([^:]+):([^:]+)$/.exec(baseRoute(routeId));
  if (!match) return undefined;
  return { kind: match[1] as "chat" | "discussion", spaceId: match[2]!, chatId: match[3]! };
}

function encodeAnytypeTarget(route: {
  spaceId: string;
  chatId: string;
  discussionRootId?: string;
}): string {
  const payload = route.discussionRootId
    ? [route.spaceId, route.chatId, route.discussionRootId]
    : [route.spaceId, route.chatId];
  return `route:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}
function soleAllowedSpace(config: AgentConfig): string | undefined {
  return config.tools.anytype.allowedSpaceIds.length === 1
    ? config.tools.anytype.allowedSpaceIds[0]
    : undefined;
}

import { appendFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers";

const input = createInterface({ input: process.stdin });
const pending = new Set();
let internalLoadFailures = 0;

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined) void request(message);
  else notification(message);
});

async function request(message) {
  log({ method: message.method, params: message.params });
  if (message.method === "initialize" && process.env.FAKE_ACP_HANG_INITIALIZE === "true") return;
  if (message.method === "initialize")
    return respond(message.id, {
      protocolVersion: message.params.protocolVersion,
      agentCapabilities: { loadSession: process.env.FAKE_ACP_LOAD_SESSION !== "false" },
      authMethods: [],
    });
  if (message.method === "session/load") {
    if (process.env.FAKE_ACP_LOAD_ERROR === "missing")
      return fail(message.id, -32002, "Resource not found: saved session");
    if (process.env.FAKE_ACP_LOAD_ERROR === "unavailable")
      return fail(message.id, -32002, "Session service temporarily unavailable");
    if (process.env.FAKE_ACP_LOAD_ERROR === "auth")
      return fail(message.id, -32000, "Authentication required");
    if (process.env.FAKE_ACP_LOAD_ERROR === "internal")
      return fail(message.id, -32603, "Internal error");
    if (process.env.FAKE_ACP_LOAD_ERROR === "internal-once" && internalLoadFailures++ === 0)
      return fail(message.id, -32603, "Internal error");
    notify("session/update", {
      sessionId: message.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "replayed history" },
      },
    });
    return respond(message.id, {});
  }
  if (message.method === "session/new")
    return respond(message.id, { sessionId: process.env.FAKE_ACP_NEW_SESSION_ID ?? "new-session" });
  if (message.method === "_session/steering")
    return fail(message.id, -32601, "Steering rejected by fake agent");
  if (message.method === "session/prompt") {
    if (process.env.FAKE_ACP_PROMPT_ERROR_SESSION === message.params.sessionId)
      return fail(message.id, -32603, "Internal error");
    pending.add(message.id);
    const delay = Number(process.env.FAKE_ACP_PROMPT_DELAY_MS ?? "0");
    setTimeout(() => {
      const updates = process.env.FAKE_ACP_UPDATES
        ? JSON.parse(process.env.FAKE_ACP_UPDATES)
        : JSON.parse(process.env.FAKE_ACP_CHUNKS ?? '["fresh reply"]').map((text) => ({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          }));
      for (const update of updates)
        notify("session/update", { sessionId: message.params.sessionId, update });
      pending.delete(message.id);
      respond(message.id, { stopReason: "end_turn" });
    }, delay);
    return;
  }
  fail(message.id, -32601, `Method not found: ${message.method}`);
}

function notification(message) {
  log({ method: message.method, params: message.params });
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function log(value) {
  if (process.env.FAKE_ACP_LOG)
    appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(value)}\n`);
}

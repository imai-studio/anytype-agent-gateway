import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentConfig } from "../config.js";
import { commandExists } from "../process.js";
import type { Store } from "../store.js";
import type { ActiveRuntime, RuntimeDriver, RuntimeEvent, RuntimeTurn } from "../types.js";
import { parseSilence } from "./openclaw.js";

type ClientCtx = Parameters<Parameters<ReturnType<typeof acp.client>["connectWith"]>[1]>[0];
type CodexSessionStore = Pick<
  Store,
  "codexAcpSession" | "saveCodexAcpSession" | "deleteCodexAcpSession"
>;
type McpServerCommand = { command: string; args: string[]; env?: Record<string, string> };
type CodexRuntimeConfig = Extract<AgentConfig["runtime"], { kind: "codex" }>;
type CodexDriverConfig = Omit<
  CodexRuntimeConfig,
  "maxRunSeconds" | "setupTimeoutSeconds" | "livenessProbeSeconds" | "terminationGraceSeconds"
> &
  Partial<
    Pick<
      CodexRuntimeConfig,
      "maxRunSeconds" | "setupTimeoutSeconds" | "livenessProbeSeconds" | "terminationGraceSeconds"
    >
  >;

const SKILL_WARNING_PREFIXES = [
  "Warning: Skill descriptions were shortened",
  "Warning: Exceeded skills context budget",
];
const LEADING_SKILL_WARNING =
  /^\s*Warning:\s*(?:Skill descriptions were shortened to fit the (?:\d+%\s+)?skills context budget\. Codex can still see every skill, but some descriptions are shorter\. Disable unused skills or plugins to leave more room for the rest\.|Exceeded skills context budget\. All skill descriptions were removed and \d+ additional skills were not included in the model-visible skills list\.)/;

export class RuntimeTurnAlreadyCompletedError extends Error {
  override readonly name = "RuntimeTurnAlreadyCompletedError";
  constructor() {
    super("Codex ACP turn already completed before the steer arrived");
  }
}

export class CodexAcpDriver implements RuntimeDriver {
  readonly name = "codex-acp";
  readonly projectEnforcement = "advisory" as const;
  readonly capabilities = {
    steering: true,
    thinking: true,
    multipleOutputParts: true,
    sessionObservation: false,
    nativeScheduling: false,
  } as const;
  private readonly repeatedInternalLoadFailures = new Map<string, number>();
  constructor(
    private readonly config: CodexDriverConfig,
    private readonly store?: CodexSessionStore,
    private readonly mcpServer?: McpServerCommand,
  ) {}

  async doctor(): Promise<string[]> {
    if (!(await commandExists(this.config.command)))
      throw new Error(`Codex ACP command not found: ${this.config.command}`);
    return [
      `Codex ACP command: ${this.config.command}`,
      `project policy: ${this.projectEnforcement} (ACP cwd + additionalDirectories)`,
    ];
  }

  async start(
    input: { sessionKey: string; prompt: string; turn?: RuntimeTurn },
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<ActiveRuntime> {
    const environment = inheritedAgentEnvironment(this.config.environment);
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.defaultProject,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let gracefulTerminationTimer: NodeJS.Timeout | undefined;
    let forceTerminationTimer: NodeJS.Timeout | undefined;
    const clearTerminationTimers = () => {
      if (gracefulTerminationTimer) clearTimeout(gracefulTerminationTimer);
      if (forceTerminationTimer) clearTimeout(forceTerminationTimer);
      gracefulTerminationTimer = undefined;
      forceTerminationTimer = undefined;
    };
    const terminateNow = () => {
      if (gracefulTerminationTimer) clearTimeout(gracefulTerminationTimer);
      gracefulTerminationTimer = undefined;
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      if (!forceTerminationTimer) {
        forceTerminationTimer = setTimeout(() => {
          forceTerminationTimer = undefined;
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 1_000);
        forceTerminationTimer.unref?.();
      }
    };
    const terminateAfterGrace = () => {
      if (child.exitCode !== null || gracefulTerminationTimer || forceTerminationTimer) return;
      const graceMs = (this.config.terminationGraceSeconds ?? 20) * 1000;
      if (graceMs === 0) {
        terminateNow();
        return;
      }
      gracefulTerminationTimer = setTimeout(terminateNow, graceMs);
      gracefulTerminationTimer.unref?.();
    };
    child.once("exit", clearTerminationTimers);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    let context: ClientCtx | undefined;
    let sessionId: string | undefined;
    let output = "";
    const messageTexts = new Map<string, string>();
    let latestMessageId: string | undefined;
    let finalMessageId: string | undefined;
    let acceptingSteers = true;
    let replayingHistory = false;
    const filteredText = new LeadingSkillWarningFilter((text, metadata) => {
      output += text;
      onEvent({ type: "text-delta", text, ...metadata });
    });
    let markReady!: () => void;
    let failReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    child.once("error", failReady);
    const app = acp
      .client({ name: "anytype-agent-gateway" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        if (this.config.permissions === "deny")
          return { outcome: { outcome: "cancelled" as const } };
        const option =
          ctx.params.options.find((item) => item.kind === "allow_once") ??
          ctx.params.options.find((item) => item.kind.startsWith("allow"));
        return option
          ? { outcome: { outcome: "selected" as const, optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" as const } };
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        if (replayingHistory) return;
        const update = ctx.params.update as any;
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
          const metadata = {
            ...(typeof update.messageId === "string" ? { partId: update.messageId } : {}),
            ...(typeof update._meta?.codex?.phase === "string"
              ? { phase: update._meta.codex.phase }
              : {}),
            ...(update._meta?.codex?.replace === true ? { replace: true as const } : {}),
          };
          if (typeof update.messageId === "string") {
            messageTexts.set(
              update.messageId,
              metadata.replace
                ? update.content.text
                : `${messageTexts.get(update.messageId) ?? ""}${update.content.text}`,
            );
            latestMessageId = update.messageId;
            if (update._meta?.codex?.phase === "final_answer") finalMessageId = update.messageId;
          }
          filteredText.push(update.content.text, metadata);
        } else if (
          update.sessionUpdate === "agent_thought_chunk" &&
          update.content?.type === "text"
        ) {
          onEvent({
            type: "thinking-delta",
            text: update.content.text,
            ...(typeof update.messageId === "string" ? { partId: update.messageId } : {}),
            ...(typeof update._meta?.codex?.phase === "string"
              ? { phase: update._meta.codex.phase }
              : {}),
            ...(update._meta?.codex?.replace === true ? { replace: true } : {}),
          });
        } else if (
          update.sessionUpdate === "tool_call" ||
          update.sessionUpdate === "tool_call_update"
        ) {
          onEvent({
            type: "tool",
            name: update.title ?? update.toolCallId ?? "tool",
            status: update.status ?? "running",
          });
        }
      });
    const result = app
      .connectWith(stream, async (ctx) => {
        context = ctx;
        try {
          const initialized = await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const sessionSetup = {
            cwd: this.config.defaultProject ?? process.cwd(),
            mcpServers: this.mcpServer
              ? [
                  {
                    name: "aag-anytype",
                    command: this.mcpServer.command,
                    args: this.mcpServer.args,
                    env: mcpEnvironment(this.mcpServer.env, input.turn),
                  },
                ]
              : [],
            ...(this.config.allowedProjects.length
              ? { additionalDirectories: this.config.allowedProjects }
              : {}),
          };
          const savedSessionId = this.store?.codexAcpSession(input.sessionKey);
          if (savedSessionId && initialized.agentCapabilities?.loadSession) {
            replayingHistory = true;
            try {
              try {
                await ctx.request(acp.methods.agent.session.load, {
                  ...sessionSetup,
                  sessionId: savedSessionId,
                });
              } catch (error) {
                if (!savedSessionInternallyBroken(error)) throw error;
                await new Promise((resolve) => setTimeout(resolve, 250));
                await ctx.request(acp.methods.agent.session.load, {
                  ...sessionSetup,
                  sessionId: savedSessionId,
                });
              }
              sessionId = savedSessionId;
              this.repeatedInternalLoadFailures.delete(input.sessionKey);
            } catch (error) {
              if (savedSessionInternallyBroken(error)) {
                const failures = (this.repeatedInternalLoadFailures.get(input.sessionKey) ?? 0) + 1;
                this.repeatedInternalLoadFailures.set(input.sessionKey, failures);
                if (failures < 2) throw error;
                this.store?.deleteCodexAcpSession(input.sessionKey);
              } else if (savedSessionUnavailable(error)) {
                this.store?.deleteCodexAcpSession(input.sessionKey);
              } else {
                throw error;
              }
            } finally {
              replayingHistory = false;
            }
          }
          if (!sessionId) {
            const session = (await ctx.request(acp.methods.agent.session.new, sessionSetup)) as {
              sessionId: string;
            };
            sessionId = session.sessionId;
            this.repeatedInternalLoadFailures.delete(input.sessionKey);
          }
          this.store?.saveCodexAcpSession(input.sessionKey, sessionId);
          markReady();
          try {
            await ctx.request(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: input.prompt }],
            });
          } finally {
            acceptingSteers = false;
            filteredText.finish();
          }
          const terminalText = messageTexts.get(finalMessageId ?? latestMessageId ?? "") ?? output;
          return parseSilence(stripLeadingSkillWarning(terminalText));
        } catch (error) {
          failReady(error);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}${stderr.trim() ? `; codex-acp stderr: ${stderr.trim()}` : ""}`,
          );
        }
      })
      .finally(terminateNow);
    void result.catch(() => undefined);
    const setupSeconds =
      this.config.setupTimeoutSeconds ??
      (this.config.timeoutSeconds > 0 ? Math.min(this.config.timeoutSeconds, 30) : 30);
    await waitForSetup(ready, setupSeconds * 1000, terminateNow);
    return {
      sessionKey: input.sessionKey,
      ...(sessionId ? { sessionId } : {}),
      result,
      steer: async (message) => {
        if (!context || !sessionId) throw new Error("Codex ACP session is not ready");
        if (!acceptingSteers) throw new RuntimeTurnAlreadyCompletedError();
        await context.request("_session/steering", {
          sessionId,
          prompt: [{ type: "text", text: message }],
        });
      },
      cancel: async () => {
        try {
          if (context && sessionId)
            await context.notify(acp.methods.agent.session.cancel, { sessionId });
        } finally {
          terminateAfterGrace();
        }
      },
    };
  }
}

function savedSessionUnavailable(error: unknown): boolean {
  const details =
    error instanceof acp.RequestError
      ? `${error.message} ${stringifyErrorData(error.data)}`
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    /\b(?:session|thread)\b[^\n]*(?:not found|does not exist|unknown|stale|invalid (?:id|identifier))/i.test(
      details,
    ) ||
    /(?:not found|does not exist|unknown|stale|invalid (?:id|identifier))[^\n]*\b(?:session|thread)\b/i.test(
      details,
    )
  );
}

function savedSessionInternallyBroken(error: unknown): boolean {
  return error instanceof acp.RequestError && error.code === -32603;
}

async function waitForSetup(
  ready: Promise<void>,
  timeoutMs: number,
  terminate: () => void,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Codex ACP setup timed out after ${Math.round(timeoutMs / 1000)} seconds`));
      terminate();
    }, timeoutMs);
  });
  try {
    await Promise.race([ready, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stringifyErrorData(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function mcpEnvironment(
  configured: Record<string, string> | undefined,
  turn: RuntimeTurn | undefined,
): Array<{ name: string; value: string }> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(configured ?? {})) {
    if (/(?:api[_-]?key|anytype[^\n]*key)/i.test(name)) continue;
    environment[name] = value;
  }
  if (turn) {
    environment.AAG_ROUTE_ID = turn.conversation.routeId;
    environment.AAG_SPACE_ID = turn.conversation.spaceId;
  }
  return Object.entries(environment).map(([name, value]) => ({ name, value }));
}

function stripLeadingSkillWarning(text: string): string {
  const warning = LEADING_SKILL_WARNING.exec(text);
  return warning ? text.slice(warning[0].length).replace(/^\s+/, "") : text;
}

function inheritedAgentEnvironment(configured: Record<string, string>): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed)
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  return { ...environment, ...configured };
}

class LeadingSkillWarningFilter {
  private pending = "";
  private decided = false;
  private metadata: { partId?: string; phase?: string; replace?: boolean } = {};

  constructor(
    private readonly emit: (
      text: string,
      metadata: { partId?: string; phase?: string; replace?: boolean },
    ) => void,
  ) {}

  push(text: string, metadata: { partId?: string; phase?: string; replace?: boolean }): void {
    if (this.decided) {
      this.emit(text, metadata);
      return;
    }
    this.metadata = metadata;
    this.pending += text;
    const warning = LEADING_SKILL_WARNING.exec(this.pending);
    if (warning) {
      const remainder = this.pending.slice(warning[0].length);
      if (/\S/.test(remainder)) this.flush(remainder.replace(/^\s+/, ""));
      return;
    }
    const candidate = this.pending.trimStart();
    if (
      !SKILL_WARNING_PREFIXES.some(
        (prefix) => prefix.startsWith(candidate) || candidate.startsWith(prefix),
      )
    )
      this.flush(this.pending);
  }

  finish(): void {
    if (this.decided) return;
    const warning = LEADING_SKILL_WARNING.exec(this.pending);
    this.flush(warning ? this.pending.slice(warning[0].length).replace(/^\s+/, "") : this.pending);
  }

  private flush(text: string): void {
    this.decided = true;
    this.pending = "";
    if (text) this.emit(text, this.metadata);
  }
}

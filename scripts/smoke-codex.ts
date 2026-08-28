import { CodexAcpDriver } from "../src/runtime/codex-acp.js";

const driver = new CodexAcpDriver({
  kind: "codex",
  command: `${process.cwd()}/node_modules/.bin/codex-acp`,
  args: [],
  defaultProject: process.cwd(),
  allowedProjects: [],
  environment: {},
  timeoutSeconds: 120,
  permissions: "allow-once"
});

const active = await driver.start({ sessionKey: "aag-smoke", prompt: "Reply with exactly AAG_CODEX_ACP_OK and nothing else." }, () => undefined);
const result = await active.result;
if (!result.text.trim().endsWith("AAG_CODEX_ACP_OK")) throw new Error(`Unexpected Codex ACP response: ${JSON.stringify(result)}`);
console.log("AAG_CODEX_ACP_OK");

const steered = await driver.start({ sessionKey: "aag-smoke-steer", prompt: "Run `sleep 4` in the terminal, then reply only FIRST_REPLY." }, () => undefined);
await new Promise(resolve => setTimeout(resolve, 500));
await steered.steer("Change the final answer. Reply only STEERED_REPLY.");
const steeredResult = await steered.result;
if (!steeredResult.text.trim().endsWith("STEERED_REPLY")) throw new Error(`Codex ACP steering failed: ${JSON.stringify(steeredResult)}`);
console.log("AAG_CODEX_ACP_STEER_OK");

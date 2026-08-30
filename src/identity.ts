import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { runProcess } from "./process.js";

export async function createIdentity(options: {
  command: string;
  name: string;
  invites: string[];
  apiKeyFile: string;
  dataPath?: string;
}): Promise<void> {
  const env = { ...process.env, ...(options.dataPath ? { DATA_PATH: options.dataPath } : {}) };
  await inherited(
    options.command,
    [
      "auth",
      "create",
      options.name,
      ...(options.dataPath ? ["--root-path", options.dataPath] : []),
    ],
    env,
  );
  for (const invite of options.invites)
    await inherited(options.command, ["space", "join", invite], env);
  const { stdout } = await runProcess(
    options.command,
    ["auth", "apikey", "create", `knot-${options.name}`],
    { env, timeoutMs: 30_000 },
  ).catch(() => {
    throw new Error(
      "Anytype CLI failed to create the revocable API key; inspect the CLI logs directly",
    );
  });
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const plain = stdout.replace(ansi, "");
  const matches = [...plain.matchAll(/(?:^|\n)\s*Key:\s*([^\s]+)\s*(?=\n|$)/gi)];
  const match = matches.at(-1);
  if (!match?.[1])
    throw new Error("Anytype CLI created an API key, but Knot could not recognize its output");
  await mkdir(dirname(options.apiKeyFile), { recursive: true, mode: 0o700 });
  await writeFile(options.apiKeyFile, `${match[1]}\n`, { mode: 0o600 });
  await chmod(options.apiKeyFile, 0o600);
}

export async function joinSpaces(
  command: string,
  invites: string[],
  dataPath?: string,
): Promise<void> {
  const env = { ...process.env, ...(dataPath ? { DATA_PATH: dataPath } : {}) };
  for (const invite of invites) await inherited(command, ["space", "join", invite], env);
}

function inherited(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

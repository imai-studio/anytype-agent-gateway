import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";

const run = promisify(execFile);
const oldUrl = "https://github.com/imai-studio/anytype-agent-gateway.git";
const newUrl = "https://github.com/imai-studio/knot.git";
const [oldHead, newHead] = await Promise.all([head(oldUrl), head(newUrl)]);
if (oldHead !== newHead)
  throw new Error("old GitHub repository URL does not redirect to the current Knot HEAD");
process.stdout.write("repository redirect: legacy and Knot URLs resolve to the same HEAD\n");

async function head(url) {
  try {
    const { stdout } = await run("git", ["ls-remote", url, "HEAD"], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "true",
        GCM_INTERACTIVE: "never",
      },
      timeout: 30_000,
    });
    return stdout.trim().split(/\s+/u)[0];
  } catch (error) {
    throw new Error(`repository URL is not reachable (${url}); has the rename happened?`, {
      cause: error,
    });
  }
}

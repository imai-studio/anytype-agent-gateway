import { spawn } from "node:child_process";
export function runProcess(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const { stdin, timeoutMs, ...spawnOptions } = options;
        const environment = spawnOptions.env ?? externalProcessEnvironment();
        const child = spawn(command, args, {
            ...spawnOptions,
            env: environment,
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = timeoutMs ? setTimeout(() => child.kill("SIGTERM"), timeoutMs) : undefined;
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (timer)
                clearTimeout(timer);
            if (code === 0)
                resolve({ stdout, stderr });
            else
                reject(new Error(`${command} exited ${code}: ${(stderr || stdout).slice(-4000)}`));
        });
        child.stdin.end(stdin ?? "");
    });
}
function externalProcessEnvironment() {
    const environment = { ...process.env };
    for (const key of ["OPENCLAW_GATEWAY_TOKEN", "ANYTYPE_API_KEY", "AAG_ANYTYPE_API_KEY"])
        delete environment[key];
    return environment;
}
export async function commandExists(command) {
    try {
        await runProcess("sh", ["-lc", 'command -v -- "$1" >/dev/null', "sh", command]);
        return true;
    }
    catch {
        return false;
    }
}

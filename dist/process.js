import { spawn } from "node:child_process";
export class ProcessTimeoutError extends Error {
    timeoutMs;
    constructor(timeoutMs) {
        super(`Subprocess timed out after ${timeoutMs} ms`);
        this.timeoutMs = timeoutMs;
        this.name = "ProcessTimeoutError";
    }
}
export function runProcess(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const { stdin, timeoutMs, ...spawnOptions } = options;
        const environment = spawnOptions.env ?? externalProcessEnvironment();
        // Give timed commands their own group so escalation reaches descendants,
        // never the caller's shell or unrelated processes.
        const ownProcessGroup = process.platform !== "win32" && Boolean(timeoutMs);
        const child = spawn(command, args, {
            ...spawnOptions,
            ...(ownProcessGroup ? { detached: true } : {}),
            env: environment,
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timeoutError;
        let escalation;
        let settled = false;
        const terminate = (signal) => {
            try {
                if (ownProcessGroup && child.pid)
                    process.kill(-child.pid, signal);
                else
                    child.kill(signal);
            }
            catch (error) {
                if (error.code !== "ESRCH")
                    finish(timeoutError ?? (error instanceof Error ? error : new Error(String(error))));
            }
        };
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            if (escalation)
                clearTimeout(escalation);
            if (error)
                reject(error);
            else
                resolve({ stdout, stderr });
        };
        const timer = timeoutMs
            ? setTimeout(() => {
                timeoutError = new ProcessTimeoutError(timeoutMs);
                escalation = setTimeout(() => {
                    terminate("SIGKILL");
                    // Descendants may have inherited the pipes. Do not let their pipe
                    // lifetime prevent settlement after the owned process group dies.
                    child.stdin.destroy();
                    child.stdout.destroy();
                    child.stderr.destroy();
                    finish(timeoutError);
                }, 500);
                terminate("SIGTERM");
            }, timeoutMs)
            : undefined;
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", (error) => finish(timeoutError ?? error));
        child.stdin.on("error", (error) => {
            if (error.code !== "EPIPE")
                finish(timeoutError ?? error);
        });
        child.on("close", (code) => {
            if (timeoutError && ownProcessGroup)
                terminate("SIGKILL");
            finish(timeoutError ??
                (code === 0
                    ? undefined
                    : new Error(`${command} exited ${code}: ${(stderr || stdout).slice(-4000)}`)));
        });
        child.stdin.end(stdin ?? "");
    });
}
function externalProcessEnvironment() {
    const environment = { ...process.env };
    for (const key of [
        "OPENCLAW_GATEWAY_TOKEN",
        "ANYTYPE_API_KEY",
        "AAG_ANYTYPE_API_KEY",
        "KNOT_ANYTYPE_API_KEY",
    ])
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

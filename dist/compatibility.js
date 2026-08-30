import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
export const PRODUCT = {
    current: {
        name: "Anytype Agent Gateway",
        shortName: "AAG",
        executable: "aag",
        packageName: "@imai/aag",
    },
    next: {
        name: "Knot",
        shortName: "Knot",
        executable: "knot",
        packageName: "@imai/knot",
    },
    executables: ["aag", "knot"],
    heartBinaries: ["aag-heart-adapter", "knot-heart-adapter"],
    services: {
        linux: ["anytype-agent-gateway.service", "knot.service"],
        darwin: ["com.anytype.anytype-agent-gateway", "com.imai.knot"],
    },
    logs: {
        current: "AnytypeAgentGateway",
        next: "Knot",
    },
};
const warnedLegacyFamilies = new Set();
export function resetCompatibilityWarningsForTests() {
    warnedLegacyFamilies.clear();
}
export function resolveProductEnvironment(suffix, options = {}) {
    const knotName = `KNOT_${suffix}`;
    const legacyName = `AAG_${suffix}`;
    return resolveEnvironmentPair(knotName, legacyName, options);
}
export function resolveEnvironmentPair(preferredName, legacyName, options = {}) {
    const environment = options.environment ?? process.env;
    const normalize = options.normalize ?? normalizeText;
    const preferred = environment[preferredName];
    const legacy = environment[legacyName];
    if (preferred !== undefined && legacy !== undefined) {
        if (normalize(preferred) !== normalize(legacy))
            throw new Error(`Conflicting compatibility variables: ${preferredName} and ${legacyName} must resolve to the same value`);
        return preferred;
    }
    if (preferred !== undefined)
        return preferred;
    if (legacy !== undefined) {
        warnLegacyOnce("environment", `${legacyName} is deprecated; configure ${preferredName} before Knot 1.0`, options.warn);
        return legacy;
    }
    return undefined;
}
export function resolveConfigPath(options = {}) {
    const configured = resolveProductEnvironment("CONFIG", {
        ...(options.environment ? { environment: options.environment } : {}),
        normalize: (value) => normalizePath(value, options.home),
        ...(options.warn ? { warn: options.warn } : {}),
    });
    if (options.explicit)
        return normalizePath(options.explicit, options.home);
    return configured
        ? normalizePath(configured, options.home)
        : join(options.home ?? homedir(), ".config", "aag", "agent.yaml");
}
export function resolveStatePath(options = {}) {
    const configured = resolveProductEnvironment("STATE_PATH", {
        ...(options.environment ? { environment: options.environment } : {}),
        normalize: (value) => normalizePath(value, options.home),
        ...(options.warn ? { warn: options.warn } : {}),
    });
    if (options.explicit)
        return normalizePath(options.explicit, options.home);
    return configured
        ? normalizePath(configured, options.home)
        : join(options.home ?? homedir(), ".local", "state", "aag", "state.sqlite");
}
export async function resolveHeartBinary(configured = PRODUCT.heartBinaries[0], exists = executableExists) {
    if (!PRODUCT.heartBinaries.includes(configured))
        return configured;
    const candidates = [configured, ...PRODUCT.heartBinaries.filter((item) => item !== configured)];
    for (const candidate of candidates)
        if (await exists(candidate))
            return candidate;
    return configured;
}
export async function detectServices(platform, exists) {
    const identities = PRODUCT.services[platform];
    return Promise.all(identities.map(async (identity, index) => ({
        generation: index === 0 ? "aag" : "knot",
        identity,
        installed: await exists(identity),
    })));
}
export function logNamespace(generation = "aag") {
    return generation === "aag" ? PRODUCT.logs.current : PRODUCT.logs.next;
}
function warnLegacyOnce(family, message, warn) {
    if (warnedLegacyFamilies.has(family))
        return;
    warnedLegacyFamilies.add(family);
    (warn ?? console.warn)(`compatibility warning: ${message}`);
}
function normalizeText(value) {
    return value.trim();
}
function normalizePath(value, home = homedir()) {
    const expanded = value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
    return resolve(expanded);
}
async function executableExists(command) {
    if (isAbsolute(command))
        return access(command, constants.X_OK)
            .then(() => true)
            .catch(() => false);
    const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    const extensions = process.platform === "win32" && !extname(command)
        ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .filter(Boolean)
            .flatMap((extension) => [extension.toLowerCase(), extension.toUpperCase()])
        : [""];
    for (const directory of paths) {
        for (const extension of extensions)
            if (await access(join(directory, `${command}${extension}`), constants.X_OK)
                .then(() => true)
                .catch(() => false))
                return true;
    }
    return false;
}

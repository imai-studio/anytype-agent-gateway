export function parseProjectCommand(text) {
    const normalized = text.trim();
    if (/^\/projects\s*$/i.test(normalized))
        return { kind: "list" };
    const match = normalized.match(/^\/project(?:\s+(.*?))?\s*$/i);
    if (!match)
        return undefined;
    const value = match[1]?.trim();
    if (!value)
        return { kind: "status" };
    if (/^(?:default|reset|none)$/i.test(value))
        return { kind: "reset" };
    return { kind: "set", project: value };
}

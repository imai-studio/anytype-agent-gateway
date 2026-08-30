export type ModelCommand =
  | { kind: "list" }
  | { kind: "status" }
  | { kind: "set"; model: string }
  | { kind: "reset" }
  | { kind: "new"; model: string };

export function parseModelCommand(text: string): ModelCommand | undefined {
  const command = text.trim();
  if (/^\/models\s*$/i.test(command)) return { kind: "list" };
  const modelMatch = /^\/model(?:\s+([^\s]+))?\s*$/i.exec(command);
  if (modelMatch) {
    const model = modelMatch[1];
    if (!model || /^(?:status|current)$/i.test(model)) return { kind: "status" };
    if (/^(?:default|reset)$/i.test(model)) return { kind: "reset" };
    return { kind: "set", model };
  }
  const fresh = /^\/new\b[^\n]*?(?:^|\s)--model(?:=|\s+)([^\s]+)/i.exec(command)?.[1];
  return fresh ? { kind: "new", model: fresh } : undefined;
}

export function modelAllowed(modelId: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    const expression = `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`;
    return new RegExp(expression, "i").test(modelId);
  });
}

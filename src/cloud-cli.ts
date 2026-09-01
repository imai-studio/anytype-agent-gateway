import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { z } from "zod";
import { CloudClient } from "./cloud-client.js";
import {
  cloudFileMode,
  forgetCloudIdentity,
  initializeCloudConfig,
  loadCloudConfig,
  loadPairingCredentials,
  normalizeCloudBaseUrl,
  removePairingCredentials,
  resolveCloudPaths,
  saveCloudConfig,
  savePairingCredentials,
  validateCloudKey,
  type CloudConfig,
  type CloudPaths,
} from "./cloud-config.js";
import {
  CLOUD_PROTOCOL_VERSION,
  cloudScopeSchema,
  pairingCredentialsSchema,
  type CloudScope,
  type PairingCredentials,
} from "./cloud-contract.js";

export const DEFAULT_CLOUD_URL = "https://knot.imai.tech";
export const DEFAULT_CLOUD_SCOPES: CloudScope[] = ["anytype.objects.read"];

interface CloudCommandContext {
  output?: (line: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  client?: (config: CloudConfig) => CloudClient;
}

export async function cloudLogin(
  input: {
    configFile?: string;
    baseUrl?: string;
    connectorName?: string;
    scopes?: string[];
    slugGrants?: string[];
  },
  context: CloudCommandContext = {},
): Promise<CloudConfig> {
  const output = context.output ?? console.log;
  const paths = resolveCloudPaths({
    ...(input.configFile ? { configFile: input.configFile } : {}),
    environment: process.env,
  });
  const scopes = parseScopes(input.scopes ?? DEFAULT_CLOUD_SCOPES);
  const config = await initializeCloudConfig({
    paths,
    baseUrl: input.baseUrl ?? DEFAULT_CLOUD_URL,
    connectorName: input.connectorName?.trim() || hostname(),
    requestedScopes: scopes,
    requestedSlugGrants: uniqueStrings(input.slugGrants ?? []),
  });
  const meta = await (context.client?.(config) ?? new CloudClient(config)).protocolStatus();
  assertProtocolCompatible(meta.minimumProtocolVersion, meta.maximumProtocolVersion);
  output(`Cloud server: ${config.baseUrl}`);
  output(`Local connector: ${config.connectorName}`);
  output(`Public key: ${config.publicKey}`);
  output(`Configuration: ${paths.configFile}`);
  output(`Sign in at ${dashboardUrl(config.baseUrl)} and start a connector pairing request.`);
  output("Paste the public key above. The private key stays on this machine.");
  output("Then copy the one-time credentials into a private file and run:");
  output(`  knot cloud pair --credentials-file <file> --config ${paths.configFile}`);
  return config;
}

export async function cloudPair(
  input: {
    configFile?: string;
    credentialsFile?: string;
    once?: boolean;
    timeoutSeconds?: number;
  },
  context: CloudCommandContext = {},
): Promise<"approved" | "pending"> {
  const output = context.output ?? console.log;
  const sleep =
    context.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const paths = resolveCloudPaths({
    ...(input.configFile ? { configFile: input.configFile } : {}),
    environment: process.env,
  });
  const config = await requiredCloudConfig(paths);
  if (config.paired) {
    output(`Already paired as connector ${config.paired.connectorId}.`);
    return "approved";
  }

  let credentials: PairingCredentials;
  if (input.credentialsFile) {
    const raw =
      input.credentialsFile === "-"
        ? await readStandardInput()
        : await readFile(input.credentialsFile, "utf8");
    credentials = pairingCredentialsSchema.parse(JSON.parse(raw));
    assertPairingOrigin(config.baseUrl, credentials);
    await savePairingCredentials(paths, credentials);
  } else {
    try {
      credentials = await loadPairingCredentials(paths);
    } catch (error) {
      output(`Public key: ${config.publicKey}`);
      output(`Start and approve the request at ${dashboardUrl(config.baseUrl)}.`);
      output(
        "Then pass the copied one-time JSON with `--credentials-file <file>` or stdin with `--credentials-file -`.",
      );
      throw error;
    }
  }

  const client = context.client?.(config) ?? new CloudClient(config);
  const started = Date.now();
  const timeoutMilliseconds = (input.timeoutSeconds ?? 600) * 1_000;
  while (true) {
    const status = await client.pollPairing(credentials);
    if (status.status === "approved") {
      const unexpectedScopes = status.grant.scopes.filter(
        (scope) => !config.requestedScopes.includes(scope),
      );
      const unexpectedSlugs = status.grant.slugGrants.filter(
        (slug) => !config.requestedSlugGrants.includes(slug),
      );
      if (unexpectedScopes.length || unexpectedSlugs.length)
        throw new Error(
          "Knot Cloud approved access that this machine did not request. Revoke the connector in the dashboard and start a new pairing",
        );
      await saveCloudConfig(paths, {
        ...config,
        paired: {
          connectorId: status.connectorId,
          tenantId: status.tenantId,
          scopes: status.grant.scopes,
          siteIds: status.grant.siteIds,
          slugGrants: status.grant.slugGrants,
          approvedAt: status.approvedAt,
        },
      });
      await removePairingCredentials(paths);
      output(`Paired connector ${status.connectorId}.`);
      output(`Granted scopes: ${status.grant.scopes.join(", ")}`);
      return "approved";
    }
    if (status.status === "denied" || status.status === "expired") {
      await removePairingCredentials(paths);
      throw new Error(`The pairing request was ${status.status}`);
    }
    if (status.status === "consumed") {
      throw new Error(
        "The one-time pairing result was already consumed before it could be saved locally. Revoke any connector created by this attempt in the dashboard, then create a new pairing request",
      );
    }
    if (status.status !== "pending")
      throw new Error("Knot Cloud returned an unknown pairing state");
    if (input.once) {
      output(`Pairing pending until ${new Date(status.expiresAt * 1_000).toISOString()}.`);
      return "pending";
    }
    if (Date.now() - started >= timeoutMilliseconds)
      throw new Error("Pairing is still pending. Re-run `knot cloud pair` to continue polling");
    const remaining = status.expiresAt * 1_000 - Date.now();
    if (remaining <= 0) throw new Error("The pairing request expired");
    await sleep(Math.min(3_000, remaining));
  }
}

export async function cloudStatus(
  input: { configFile?: string; json?: boolean },
  context: CloudCommandContext = {},
): Promise<Record<string, unknown>> {
  const output = context.output ?? console.log;
  const paths = resolveCloudPaths({
    ...(input.configFile ? { configFile: input.configFile } : {}),
    environment: process.env,
  });
  const config = await requiredCloudConfig(paths);
  let server: "online" | "offline" = "online";
  let serverError: string | undefined;
  try {
    await (context.client?.(config) ?? new CloudClient(config)).protocolStatus();
  } catch (error) {
    server = "offline";
    serverError = error instanceof Error ? error.message : String(error);
  }
  const status = {
    server,
    baseUrl: config.baseUrl,
    connectorName: config.connectorName,
    publicKey: config.publicKey,
    pairing: config.paired
      ? {
          state: "paired",
          connectorId: config.paired.connectorId,
          scopes: config.paired.scopes,
          siteIds: config.paired.siteIds,
          slugGrants: config.paired.slugGrants,
        }
      : { state: "not-paired" },
    ...(serverError ? { serverError } : {}),
  };
  if (input.json) output(JSON.stringify(status));
  else {
    output(`Server: ${status.server} (${config.baseUrl})`);
    output(`Connector: ${config.connectorName}`);
    output(
      config.paired ? `Pairing: active (${config.paired.connectorId})` : "Pairing: not configured",
    );
    if (config.paired) output(`Granted scopes: ${config.paired.scopes.join(", ")}`);
    if (serverError) output(`Server check: ${serverError}`);
  }
  return status;
}

export async function cloudDoctor(
  input: { configFile?: string },
  context: CloudCommandContext = {},
): Promise<void> {
  const output = context.output ?? console.log;
  const paths = resolveCloudPaths({
    ...(input.configFile ? { configFile: input.configFile } : {}),
    environment: process.env,
  });
  const config = await requiredCloudConfig(paths);
  await validateCloudKey(config);
  output("ok: Ed25519 private key matches the configured public key");
  if (process.platform !== "win32") {
    for (const path of [paths.configFile, config.privateKeyFile]) {
      const mode = await cloudFileMode(path);
      if ((mode & 0o077) !== 0)
        throw new Error(`${path} must not be readable or writable by group or other users`);
    }
    output("ok: cloud configuration and private key use private file permissions");
  }
  const meta = await (context.client?.(config) ?? new CloudClient(config)).protocolStatus();
  assertProtocolCompatible(meta.minimumProtocolVersion, meta.maximumProtocolVersion);
  output(`ok: ${meta.product} protocol ${CLOUD_PROTOCOL_VERSION} at ${config.baseUrl}`);
  if (config.paired) {
    output(`ok: paired connector ${config.paired.connectorId}`);
    output(`ok: ${config.paired.scopes.length} locally recorded cloud grant(s)`);
  } else {
    output("warning: connector pairing is not complete");
  }
  output("ok: no inbound network listener is used by the Cloud client");
  output("note: publication commands remain unavailable until their cloud routes are released");
}

export async function cloudRevoke(
  input: { configFile?: string; forgetLocal?: boolean },
  context: CloudCommandContext = {},
): Promise<void> {
  const output = context.output ?? console.log;
  const paths = resolveCloudPaths({
    ...(input.configFile ? { configFile: input.configFile } : {}),
    environment: process.env,
  });
  const config = await requiredCloudConfig(paths);
  if (!input.forgetLocal) {
    output(
      `Revoke connector ${config.paired?.connectorId ?? "for this machine"} at ${dashboardUrl(config.baseUrl)}.`,
    );
    output("Remote revocation requires an authenticated workspace owner or admin.");
    output(
      "After remote revocation, run `knot cloud revoke --forget-local` to remove this machine's key and cloud configuration.",
    );
    return;
  }
  await forgetCloudIdentity(paths);
  output("Removed the local Cloud configuration, pairing state, and connector private key.");
  output(
    "This does not revoke a remote connector. Confirm remote revocation in the Cloud dashboard.",
  );
}

function parseScopes(values: string[]): CloudScope[] {
  const parsed = z.array(cloudScopeSchema).min(1).parse(uniqueStrings(values));
  return parsed;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function dashboardUrl(baseUrl: string): string {
  const url = new URL("/dashboard", `${baseUrl}/`);
  url.searchParams.set("view", "connectors");
  return url.toString();
}

function assertPairingOrigin(baseUrl: string, credentials: PairingCredentials): void {
  const authorization = new URL(credentials.authorizationUrl);
  const expected = new URL(normalizeCloudBaseUrl(baseUrl));
  if (authorization.origin !== expected.origin || authorization.pathname !== "/dashboard")
    throw new Error("Pairing credentials belong to a different Knot Cloud server");
}

function assertProtocolCompatible(minimum: string, maximum: string): void {
  if (
    compareProtocolVersions(CLOUD_PROTOCOL_VERSION, minimum) < 0 ||
    compareProtocolVersions(CLOUD_PROTOCOL_VERSION, maximum) > 0
  )
    throw new Error(
      `Knot Cloud supports protocol ${minimum} through ${maximum}; this CLI supports ${CLOUD_PROTOCOL_VERSION}`,
    );
}

function compareProtocolVersions(left: string, right: string): number {
  const pattern = /^(0|[1-9][0-9]*)\.([0-9]+)$/u;
  const leftMatch = pattern.exec(left);
  const rightMatch = pattern.exec(right);
  if (!leftMatch || !rightMatch) throw new Error("Knot Cloud returned an invalid protocol range");
  const leftParts = [Number(leftMatch[1]), Number(leftMatch[2])];
  const rightParts = [Number(rightMatch[1]), Number(rightMatch[2])];
  return leftParts[0] === rightParts[0]
    ? leftParts[1]! - rightParts[1]!
    : leftParts[0]! - rightParts[0]!;
}

async function requiredCloudConfig(paths: CloudPaths): Promise<CloudConfig> {
  const config = await loadCloudConfig(paths);
  if (!config) throw new Error("Run `knot cloud login` first");
  return config;
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

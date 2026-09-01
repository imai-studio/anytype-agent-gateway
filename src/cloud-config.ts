import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  CLOUD_PROTOCOL_VERSION,
  cloudScopeSchema,
  pairingCredentialsSchema,
  type PairingCredentials,
} from "./cloud-contract.js";

const secureUrlSchema = z.url().superRefine((value, context) => {
  const parsed = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    context.addIssue({ code: "custom", message: "Cloud URL must use HTTPS or loopback HTTP" });
  }
  if (parsed.username || parsed.password) {
    context.addIssue({ code: "custom", message: "Cloud URL must not contain credentials" });
  }
});

const pairedConnectorSchema = z
  .object({
    connectorId: z.string().min(1).max(200),
    tenantId: z.string().min(1).max(200),
    scopes: z.array(cloudScopeSchema).min(1),
    siteIds: z.array(z.string().min(1).max(200)),
    slugGrants: z.array(z.string().min(1).max(200)),
    approvedAt: z.number().int().nonnegative(),
  })
  .strict();

export const cloudConfigSchema = z
  .object({
    version: z.literal(1),
    baseUrl: secureUrlSchema,
    connectorName: z.string().trim().min(1).max(100),
    protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    privateKeyFile: z.string().min(1),
    requestedScopes: z.array(cloudScopeSchema).min(1),
    requestedSlugGrants: z.array(z.string().min(1).max(200)),
    publication: z
      .object({
        allowedAssetRoots: z.array(z.string().min(1)).default([]),
        maximumAssets: z.number().int().min(0).max(100).default(20),
        maximumAssetBytes: z
          .number()
          .int()
          .min(1)
          .max(100 * 1024 * 1024)
          .default(25 * 1024 * 1024),
        maximumTotalAssetBytes: z
          .number()
          .int()
          .min(1)
          .max(500 * 1024 * 1024)
          .default(100 * 1024 * 1024),
      })
      .strict()
      .default({
        allowedAssetRoots: [],
        maximumAssets: 20,
        maximumAssetBytes: 25 * 1024 * 1024,
        maximumTotalAssetBytes: 100 * 1024 * 1024,
      }),
    paired: pairedConnectorSchema.optional(),
  })
  .strict();

export type CloudConfig = z.infer<typeof cloudConfigSchema>;

export interface CloudPaths {
  configFile: string;
  privateKeyFile: string;
  pairingFile: string;
  publicationOutboxFile: string;
}

export function resolveCloudPaths(
  options: {
    configFile?: string;
    environment?: NodeJS.ProcessEnv;
    home?: string;
  } = {},
): CloudPaths {
  const home = options.home ?? homedir();
  const configured = options.configFile ?? options.environment?.KNOT_CLOUD_CONFIG;
  const configFile = resolve(
    expandHome(configured ?? join(home, ".config", "knot", "cloud.json"), home),
  );
  const directory = dirname(configFile);
  const stem = basename(configFile, extname(configFile));
  return {
    configFile,
    privateKeyFile: join(directory, `${stem}-connector-ed25519.pem`),
    pairingFile: join(directory, `${stem}-pairing.json`),
    publicationOutboxFile: join(directory, `${stem}-publication-outbox.sqlite`),
  };
}

export function normalizeCloudBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "/";
  return secureUrlSchema.parse(parsed.toString()).replace(/\/$/u, "");
}

export async function initializeCloudConfig(input: {
  paths: CloudPaths;
  baseUrl: string;
  connectorName: string;
  requestedScopes: CloudConfig["requestedScopes"];
  requestedSlugGrants?: string[];
  allowedAssetRoots?: string[];
}): Promise<CloudConfig> {
  await ensurePrivateDirectory(dirname(input.paths.configFile));
  const existing = await loadCloudConfig(input.paths, false);
  if (existing) {
    if (normalizeCloudBaseUrl(input.baseUrl) !== existing.baseUrl)
      throw new Error("This cloud config already belongs to a different server");
    if (existing.paired) {
      if (!input.allowedAssetRoots) return existing;
      const updated = cloudConfigSchema.parse({
        ...existing,
        publication: {
          ...existing.publication,
          allowedAssetRoots: input.allowedAssetRoots.map((path) =>
            resolve(expandHome(path, homedir())),
          ),
        },
      });
      await saveCloudConfig(input.paths, updated);
      return updated;
    }
    const updated = cloudConfigSchema.parse({
      ...existing,
      connectorName: input.connectorName,
      requestedScopes: input.requestedScopes,
      requestedSlugGrants: input.requestedSlugGrants ?? [],
      publication: {
        ...existing.publication,
        allowedAssetRoots:
          input.allowedAssetRoots?.map((path) => resolve(expandHome(path, homedir()))) ??
          existing.publication.allowedAssetRoots,
      },
    });
    await saveCloudConfig(input.paths, updated);
    return updated;
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicJwk = publicKey.export({ format: "jwk" });
  if (!publicJwk.x) throw new Error("Node did not export the Ed25519 public key");
  await atomicPrivateWrite(input.paths.privateKeyFile, privatePem);
  const config = cloudConfigSchema.parse({
    version: 1,
    baseUrl: normalizeCloudBaseUrl(input.baseUrl),
    connectorName: input.connectorName,
    protocolVersion: CLOUD_PROTOCOL_VERSION,
    publicKey: publicJwk.x,
    privateKeyFile: resolve(input.paths.privateKeyFile),
    requestedScopes: input.requestedScopes,
    requestedSlugGrants: input.requestedSlugGrants ?? [],
    publication: {
      allowedAssetRoots: (input.allowedAssetRoots ?? []).map((path) =>
        resolve(expandHome(path, homedir())),
      ),
    },
  });
  await saveCloudConfig(input.paths, config);
  return config;
}

export async function loadCloudConfig(
  paths: CloudPaths,
  required = true,
): Promise<CloudConfig | undefined> {
  try {
    const configStatus = await lstat(paths.configFile);
    if (!configStatus.isFile() || configStatus.isSymbolicLink())
      throw new Error("Cloud config must be a regular file, not a symbolic link");
    assertPrivateMode(paths.configFile, configStatus.mode & 0o777);
    const raw = await readFile(paths.configFile, "utf8");
    const parsed = cloudConfigSchema.parse(JSON.parse(raw));
    const keyFile = isAbsolute(parsed.privateKeyFile)
      ? parsed.privateKeyFile
      : resolve(dirname(paths.configFile), parsed.privateKeyFile);
    if (resolve(keyFile) !== resolve(paths.privateKeyFile))
      throw new Error("Cloud private key must stay beside the selected cloud config");
    return {
      ...parsed,
      privateKeyFile: keyFile,
      publication: {
        ...parsed.publication,
        allowedAssetRoots: parsed.publication.allowedAssetRoots.map((path) =>
          resolve(expandHome(path, homedir())),
        ),
      },
    };
  } catch (error) {
    if (!required && isMissingFile(error)) return undefined;
    if (isMissingFile(error)) throw new Error("Run `knot cloud login` first");
    throw error;
  }
}

export async function saveCloudConfig(paths: CloudPaths, config: CloudConfig): Promise<void> {
  await ensurePrivateDirectory(dirname(paths.configFile));
  await atomicPrivateWrite(
    paths.configFile,
    `${JSON.stringify(cloudConfigSchema.parse(config), null, 2)}\n`,
  );
}

export async function savePairingCredentials(
  paths: CloudPaths,
  credentials: PairingCredentials,
): Promise<void> {
  await ensurePrivateDirectory(dirname(paths.pairingFile));
  await atomicPrivateWrite(
    paths.pairingFile,
    `${JSON.stringify(pairingCredentialsSchema.parse(credentials), null, 2)}\n`,
  );
}

export async function loadPairingCredentials(paths: CloudPaths): Promise<PairingCredentials> {
  const raw = await readFile(paths.pairingFile, "utf8").catch((error: unknown) => {
    if (isMissingFile(error))
      throw new Error("No pending pairing. Start one in the Cloud dashboard first");
    throw error;
  });
  return pairingCredentialsSchema.parse(JSON.parse(raw));
}

export async function removePairingCredentials(paths: CloudPaths): Promise<void> {
  await rm(paths.pairingFile, { force: true });
}

export async function forgetCloudIdentity(paths: CloudPaths): Promise<void> {
  const config = await loadCloudConfig(paths, false);
  if (config) {
    if (resolve(config.privateKeyFile) !== resolve(paths.privateKeyFile))
      throw new Error("Refusing to delete a cloud key outside the selected config directory");
  }
  await rm(paths.pairingFile, { force: true });
  if (config) await rm(config.privateKeyFile, { force: true });
  await rm(paths.configFile, { force: true });
}

export async function validateCloudKey(config: CloudConfig): Promise<void> {
  await access(config.privateKeyFile, constants.R_OK);
  const keyStatus = await lstat(config.privateKeyFile);
  if (!keyStatus.isFile() || keyStatus.isSymbolicLink())
    throw new Error("Cloud private key must be a regular file, not a symbolic link");
  assertPrivateMode(config.privateKeyFile, keyStatus.mode & 0o777);
  const pem = await readFile(config.privateKeyFile, "utf8");
  const privateKey = createPrivateKey(pem);
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (publicJwk.x !== config.publicKey)
    throw new Error("Cloud private key does not match its configured public key");
}

export async function cloudFileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function atomicPrivateWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") await chmod(temporary, 0o600);
  try {
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function assertPrivateMode(path: string, mode: number): void {
  if (process.platform !== "win32" && (mode & 0o077) !== 0)
    throw new Error(`${path} must not be readable or writable by group or other users`);
}

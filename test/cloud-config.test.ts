import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cloudFileMode,
  forgetCloudIdentity,
  initializeCloudConfig,
  loadCloudConfig,
  normalizeCloudBaseUrl,
  resolveCloudPaths,
  validateCloudKey,
} from "../src/cloud-config.js";

describe("cloud configuration", () => {
  it("stores an Ed25519 identity outside the repository with private permissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "knot-cloud-config-"));
    const paths = resolveCloudPaths({ home });
    const config = await initializeCloudConfig({
      paths,
      baseUrl: "https://knot.example/ignored?query=yes",
      connectorName: "Test Mac",
      requestedScopes: ["anytype.objects.read"],
    });

    expect(config.baseUrl).toBe("https://knot.example");
    expect(config.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(config.privateKeyFile).toBe(paths.privateKeyFile);
    await validateCloudKey(config);
    expect(await cloudFileMode(paths.configFile)).toBe(0o600);
    expect(await cloudFileMode(paths.privateKeyFile)).toBe(0o600);
    expect(await readFile(paths.configFile, "utf8")).not.toContain("PRIVATE KEY");
    expect((await loadCloudConfig(paths))?.publicKey).toBe(config.publicKey);
  });

  it("accepts loopback HTTP but rejects remote plaintext servers", () => {
    expect(normalizeCloudBaseUrl("http://127.0.0.1:3000/path")).toBe("http://127.0.0.1:3000");
    expect(() => normalizeCloudBaseUrl("http://knot.example")).toThrow("HTTPS or loopback HTTP");
  });

  it("removes only the selected cloud identity when explicitly forgotten", async () => {
    const home = await mkdtemp(join(tmpdir(), "knot-cloud-forget-"));
    const paths = resolveCloudPaths({ home });
    await initializeCloudConfig({
      paths,
      baseUrl: "https://knot.example",
      connectorName: "Test Mac",
      requestedScopes: ["anytype.objects.read"],
    });
    await forgetCloudIdentity(paths);
    await expect(loadCloudConfig(paths)).rejects.toThrow("cloud login");
  });
});

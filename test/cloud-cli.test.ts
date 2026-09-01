import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cloudPair, cloudRevoke, cloudStatus } from "../src/cloud-cli.js";
import { CloudClient } from "../src/cloud-client.js";
import { initializeCloudConfig, loadCloudConfig, resolveCloudPaths } from "../src/cloud-config.js";
import type { PairingStatus } from "../src/cloud-contract.js";

describe("cloud CLI actions", () => {
  it("stores an approved grant without persisting or printing the poll token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "knot-cloud-pair-"));
    const paths = resolveCloudPaths({ configFile: join(directory, "cloud.json") });
    const config = await initializeCloudConfig({
      paths,
      baseUrl: "https://knot.example",
      connectorName: "Test Mac",
      requestedScopes: ["anytype.objects.read"],
    });
    const credentialsFile = join(directory, "credentials.json");
    const pollToken = "p".repeat(43);
    await writeFile(
      credentialsFile,
      JSON.stringify({
        protocolVersion: "1.0",
        pairingId: "pairing-id",
        pollToken,
        authorizationUrl: "https://knot.example/dashboard?view=connectors",
      }),
    );
    const lines: string[] = [];
    const approved: PairingStatus = {
      protocolVersion: "1.0",
      pairingId: "pairing-id",
      status: "approved",
      connectorId: "connector-id",
      tenantId: "tenant-id",
      grant: {
        scopes: ["anytype.objects.read"],
        siteIds: [],
        slugGrants: [],
      },
      approvedAt: 1,
    };
    const client = {
      pollPairing: vi.fn(async () => approved),
    } as unknown as CloudClient;
    await cloudPair(
      { configFile: paths.configFile, credentialsFile, once: true },
      { output: (line) => lines.push(line), client: () => client },
    );
    expect((await loadCloudConfig(paths))?.paired?.connectorId).toBe("connector-id");
    expect(await readFile(paths.configFile, "utf8")).not.toContain(pollToken);
    expect(lines.join("\n")).not.toContain(pollToken);
    await expect(readFile(paths.pairingFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(config.publicKey).toBe((await loadCloudConfig(paths))?.publicKey);
  });

  it("refuses pairing credentials from another origin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "knot-cloud-origin-"));
    const paths = resolveCloudPaths({ configFile: join(directory, "cloud.json") });
    await initializeCloudConfig({
      paths,
      baseUrl: "https://knot.example",
      connectorName: "Test Mac",
      requestedScopes: ["anytype.objects.read"],
    });
    const credentialsFile = join(directory, "credentials.json");
    await writeFile(
      credentialsFile,
      JSON.stringify({
        protocolVersion: "1.0",
        pairingId: "pairing-id",
        pollToken: "p".repeat(43),
        authorizationUrl: "https://evil.example/dashboard",
      }),
    );
    await expect(
      cloudPair({ configFile: paths.configFile, credentialsFile, once: true }),
    ).rejects.toThrow("different Knot Cloud server");
  });

  it("reports status without exposing private-key material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "knot-cloud-status-"));
    const paths = resolveCloudPaths({ configFile: join(directory, "cloud.json") });
    await initializeCloudConfig({
      paths,
      baseUrl: "https://knot.example",
      connectorName: "Test Mac",
      requestedScopes: ["anytype.objects.read"],
    });
    const lines: string[] = [];
    const client = {
      protocolStatus: vi.fn(async () => ({
        product: "knot-cloud",
        minimumProtocolVersion: "1.0",
        maximumProtocolVersion: "1.0",
        serverUnixSeconds: 1,
      })),
    } as unknown as CloudClient;
    await cloudStatus(
      { configFile: paths.configFile },
      { output: (line) => lines.push(line), client: () => client },
    );
    expect(lines.join("\n")).not.toContain("PRIVATE KEY");
    expect(lines.join("\n")).not.toContain(paths.privateKeyFile);
  });

  it("requires an explicit flag before deleting local credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "knot-cloud-revoke-"));
    const paths = resolveCloudPaths({ configFile: join(directory, "cloud.json") });
    await initializeCloudConfig({
      paths,
      baseUrl: "https://knot.example",
      connectorName: "Test Mac",
      requestedScopes: ["anytype.objects.read"],
    });
    await cloudRevoke({ configFile: paths.configFile }, { output: () => undefined });
    expect(await loadCloudConfig(paths)).toBeDefined();
    await cloudRevoke(
      { configFile: paths.configFile, forgetLocal: true },
      { output: () => undefined },
    );
    await expect(loadCloudConfig(paths)).rejects.toThrow("cloud login");
  });
});

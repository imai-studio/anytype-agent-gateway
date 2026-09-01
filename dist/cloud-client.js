import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { validateCloudKey } from "./cloud-config.js";
import { CLOUD_PROTOCOL_VERSION, commandClaimResponseSchema, commandLeaseExtendedSchema, commandResultSchema, commandResultReceiptSchema, pairingStatusSchema, problemDetailsSchema, protocolMetaSchema, } from "./cloud-contract.js";
const maximumResponseBytes = 1024 * 1024;
export class CloudRequestError extends Error {
    options;
    constructor(message, options) {
        super(message);
        this.options = options;
        this.name = "CloudRequestError";
    }
}
export class CloudClient {
    config;
    fetchImplementation;
    now;
    random;
    sleep;
    requestTimeoutMilliseconds;
    maximumAttempts;
    clockOffsetSeconds = 0;
    constructor(config, options = {}) {
        this.config = config;
        this.fetchImplementation = options.fetch ?? fetch;
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
        this.sleep =
            options.sleep ??
                ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
        this.requestTimeoutMilliseconds = options.requestTimeoutMilliseconds ?? 15_000;
        this.maximumAttempts = options.maximumAttempts ?? 4;
    }
    async protocolStatus() {
        const response = await this.request({
            method: "GET",
            path: "/api/v1/meta",
            schema: protocolMetaSchema,
            signed: false,
        });
        this.clockOffsetSeconds = response.serverUnixSeconds - Math.floor(this.now() / 1_000);
        return response;
    }
    async pollPairing(credentials) {
        return this.request({
            method: "POST",
            path: "/api/v1/pairing/poll",
            body: {
                protocolVersion: CLOUD_PROTOCOL_VERSION,
                pairingId: credentials.pairingId,
                pollToken: credentials.pollToken,
            },
            schema: pairingStatusSchema,
            signed: false,
        });
    }
    async claimCommands(input = {}) {
        const connectorId = this.pairedConnectorId();
        return this.request({
            method: "POST",
            path: `/api/v1/connectors/${encodeURIComponent(connectorId)}/commands/claim`,
            body: {
                protocolVersion: CLOUD_PROTOCOL_VERSION,
                maximumCommands: 1,
                leaseSeconds: input.leaseSeconds ?? 60,
            },
            schema: commandClaimResponseSchema,
            signed: true,
        });
    }
    async extendLease(command, extendBySeconds = 60) {
        const connectorId = this.pairedConnectorId();
        this.assertCommandConnector(command);
        return this.request({
            method: "POST",
            path: `/api/v1/connectors/${encodeURIComponent(connectorId)}/commands/extend`,
            body: {
                protocolVersion: CLOUD_PROTOCOL_VERSION,
                commandId: command.commandId,
                attempt: command.attempt,
                leaseToken: command.leaseToken,
                extendBySeconds,
            },
            schema: commandLeaseExtendedSchema,
            signed: true,
        });
    }
    async submitResult(command, result) {
        const connectorId = this.pairedConnectorId();
        this.assertCommandConnector(command);
        return this.request({
            method: "POST",
            path: `/api/v1/connectors/${encodeURIComponent(connectorId)}/commands/result`,
            body: {
                protocolVersion: CLOUD_PROTOCOL_VERSION,
                commandId: command.commandId,
                attempt: command.attempt,
                leaseToken: command.leaseToken,
                result: commandResultSchema.parse(result),
            },
            schema: commandResultReceiptSchema,
            signed: true,
        });
    }
    async rejectByLocalPolicy(command, reasonCode) {
        return this.submitResult(command, {
            outcome: "rejected-by-local-policy",
            reasonCode,
        });
    }
    pairedConnectorId() {
        if (!this.config.paired)
            throw new Error("This machine is not paired with Knot Cloud");
        return this.config.paired.connectorId;
    }
    assertCommandConnector(command) {
        if (command.connectorId !== this.pairedConnectorId())
            throw new Error("The command belongs to a different connector");
        if (!this.config.paired?.scopes.includes(command.requiredScope))
            throw new Error("The command requires a scope that is absent from the local pairing grant");
    }
    async request(input) {
        const body = input.body === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(input.body));
        let lastError;
        for (let attempt = 0; attempt < this.maximumAttempts; attempt += 1) {
            try {
                const url = new URL(input.path, `${this.config.baseUrl}/`);
                const headers = new Headers({ Accept: "application/json" });
                if (input.body !== undefined)
                    headers.set("Content-Type", "application/json");
                if (input.signed) {
                    for (const [name, value] of Object.entries(await this.signedHeaders(url, input.method, body)))
                        headers.set(name, value);
                }
                const response = await this.fetchImplementation(url, {
                    method: input.method,
                    headers,
                    ...(input.body === undefined ? {} : { body }),
                    signal: AbortSignal.timeout(this.requestTimeoutMilliseconds),
                });
                const responseBody = await readBoundedResponse(response);
                if (!response.ok) {
                    const error = cloudError(response, responseBody);
                    if (error.options.serverUnixSeconds !== undefined) {
                        this.clockOffsetSeconds =
                            error.options.serverUnixSeconds - Math.floor(this.now() / 1_000);
                    }
                    const clockSkewRetry = error.options.code === "clock-skew";
                    if ((!error.options.retryable && !clockSkewRetry) || attempt + 1 >= this.maximumAttempts)
                        throw error;
                    if (!clockSkewRetry)
                        await this.sleep(backoffMilliseconds(attempt, this.random, error.options.retryAfterSeconds));
                    continue;
                }
                return input.schema.parse(parseJson(responseBody));
            }
            catch (error) {
                lastError = error;
                if (error instanceof z.ZodError ||
                    (error instanceof CloudRequestError && !error.options.retryable))
                    throw error;
                if (attempt + 1 >= this.maximumAttempts)
                    break;
                const retryAfter = error instanceof CloudRequestError ? error.options.retryAfterSeconds : undefined;
                await this.sleep(backoffMilliseconds(attempt, this.random, retryAfter));
            }
        }
        if (lastError instanceof Error)
            throw lastError;
        throw new CloudRequestError("Knot Cloud is unavailable", { retryable: true });
    }
    async signedHeaders(url, method, body) {
        await validateCloudKey(this.config);
        const connectorId = this.pairedConnectorId();
        const authority = normalizeAuthority(url.host);
        const timestamp = Math.floor(this.now() / 1_000) + this.clockOffsetSeconds;
        const nonce = randomBytes(24).toString("base64url");
        const bodySha256 = createHash("sha256").update(body).digest("hex");
        const canonical = [
            "knot-cloud-ed25519-v1",
            CLOUD_PROTOCOL_VERSION,
            connectorId,
            authority,
            method.toUpperCase(),
            url.pathname,
            url.search,
            String(timestamp),
            nonce,
            bodySha256,
        ].join("\n");
        const privateKey = createPrivateKey(await readFile(this.config.privateKeyFile, "utf8"));
        const signature = sign(null, Buffer.from(canonical), privateKey).toString("base64url");
        return {
            "Knot-Protocol-Version": CLOUD_PROTOCOL_VERSION,
            "Knot-Connector-Id": connectorId,
            "Knot-Timestamp": String(timestamp),
            "Knot-Nonce": nonce,
            "Knot-Signature": signature,
        };
    }
}
export function normalizeAuthority(value) {
    const parsed = new URL(`https://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash)
        throw new TypeError("Invalid authority");
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
    return `${hostname}${parsed.port && parsed.port !== "443" ? `:${parsed.port}` : ""}`;
}
export function backoffMilliseconds(attempt, random = Math.random, retryAfterSeconds) {
    if (retryAfterSeconds !== undefined)
        return retryAfterSeconds * 1_000;
    const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt));
    return Math.round(base * (0.75 + random() * 0.5));
}
async function readBoundedResponse(response) {
    const contentLength = response.headers.get("Content-Length");
    if (contentLength && Number(contentLength) > maximumResponseBytes)
        throw new CloudRequestError("Knot Cloud returned an oversized response", { retryable: false });
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maximumResponseBytes)
        throw new CloudRequestError("Knot Cloud returned an oversized response", { retryable: false });
    return body;
}
function parseJson(body) {
    try {
        return JSON.parse(new TextDecoder().decode(body));
    }
    catch {
        throw new CloudRequestError("Knot Cloud returned invalid JSON", { retryable: false });
    }
}
function cloudError(response, body) {
    let candidate;
    try {
        candidate = JSON.parse(new TextDecoder().decode(body));
    }
    catch {
        candidate = undefined;
    }
    const parsed = problemDetailsSchema.safeParse(candidate);
    if (parsed.success) {
        return new CloudRequestError(parsed.data.title, {
            status: response.status,
            code: parsed.data.code,
            retryable: parsed.data.retryable,
            ...(parsed.data.retryAfterSeconds === undefined
                ? {}
                : { retryAfterSeconds: parsed.data.retryAfterSeconds }),
            ...(parsed.data.serverUnixSeconds === undefined
                ? {}
                : { serverUnixSeconds: parsed.data.serverUnixSeconds }),
        });
    }
    return new CloudRequestError(`Knot Cloud returned HTTP ${response.status}`, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
    });
}

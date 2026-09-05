import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { validateCloudKey } from "./cloud-config.js";
import { CLOUD_PROTOCOL_VERSION, assetUploadCommitSchema, assetUploadCreatedSchema, assetUploadRequestSchema, assetUploadResultSchema, commandClaimResponseSchema, commandLeaseExtendedSchema, commandResultSchema, commandResultReceiptSchema, connectorPublicationControlRequestSchema, connectorPublicationStatusSchema, pairingStatusSchema, problemDetailsSchema, protocolMetaSchema, publicationControlResultSchema, publicationCreatedSchema, publicationMutationSchema, } from "./cloud-contract.js";
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
    assetUploadTimeoutMilliseconds;
    clockOffsetSeconds = 0;
    constructor(config, options = {}) {
        this.config = config;
        this.fetchImplementation = options.fetch ?? fetch;
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
        this.sleep =
            options.sleep ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
        this.requestTimeoutMilliseconds = options.requestTimeoutMilliseconds ?? 15_000;
        this.maximumAttempts = options.maximumAttempts ?? 4;
        this.assetUploadTimeoutMilliseconds = options.assetUploadTimeoutMilliseconds ?? 5 * 60_000;
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
    serverAdjustedNow() {
        return this.now() + this.clockOffsetSeconds * 1_000;
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
        const response = await this.request({
            method: "POST",
            path: `/api/v1/connectors/${encodeURIComponent(connectorId)}/commands/claim`,
            body: {
                protocolVersion: CLOUD_PROTOCOL_VERSION,
                maximumCommands: 1,
                leaseSeconds: input.leaseSeconds ?? 60,
            },
            schema: commandClaimResponseSchema,
            signed: true,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        for (const command of response.commands)
            this.assertCommandConnector(command);
        return response;
    }
    async extendLease(command, extendBySeconds = 60, signal) {
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
            commandScoped: true,
            ...(signal ? { signal } : {}),
        });
    }
    async submitResult(command, result, signal) {
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
            commandScoped: true,
            ...(signal ? { signal } : {}),
        });
    }
    async rejectByLocalPolicy(command, reasonCode) {
        return this.submitResult(command, {
            outcome: "rejected-by-local-policy",
            reasonCode,
        });
    }
    async publish(mutation) {
        const connectorId = this.pairedConnectorId();
        if (mutation.connectorId !== connectorId)
            throw new Error("The publication belongs to a different connector");
        this.assertGranted("publications.write");
        return this.request({
            method: "POST",
            path: `/api/v1/connectors/${encodeURIComponent(connectorId)}/publications`,
            body: publicationMutationSchema.parse(mutation),
            schema: publicationCreatedSchema,
            signed: true,
        });
    }
    async requestAssetUpload(input) {
        const connectorId = this.pairedConnectorId();
        if (input.connectorId !== connectorId)
            throw new Error("The asset upload belongs to a different connector");
        this.assertGranted("publications.write");
        return this.request({
            method: "POST",
            path: `/api/v1/connectors/${encodeURIComponent(connectorId)}/assets/request`,
            body: assetUploadRequestSchema.parse(input),
            schema: assetUploadCreatedSchema,
            signed: true,
        });
    }
    async uploadAsset(upload, bytes) {
        const target = assetUploadCreatedSchema.parse(upload);
        if (isLocalServiceUrl(target.uploadUrl) && !isLocalServiceUrl(this.config.baseUrl))
            throw new CloudRequestError("Remote Knot Cloud cannot upload to a local service", {
                retryable: false,
            });
        const response = await this.fetchImplementation(target.uploadUrl, {
            method: "PUT",
            headers: target.requiredHeaders,
            body: Buffer.from(bytes),
            redirect: "error",
            signal: AbortSignal.timeout(this.assetUploadTimeoutMilliseconds),
        });
        if (!response.ok)
            throw new CloudRequestError(`Asset storage returned HTTP ${response.status}`, {
                status: response.status,
                retryable: response.status >= 500 || response.status === 408 || response.status === 429,
            });
    }
    async commitAssetUpload(input) {
        const connectorId = this.pairedConnectorId();
        this.assertGranted("publications.write");
        return this.request({
            method: "POST",
            path: `/api/v1/connectors/${encodeURIComponent(connectorId)}/assets/commit`,
            body: assetUploadCommitSchema.parse({
                protocolVersion: CLOUD_PROTOCOL_VERSION,
                ...input,
            }),
            schema: assetUploadResultSchema,
            signed: true,
        });
    }
    async publicationStatus(publicationId) {
        const connectorId = z.uuid().parse(this.pairedConnectorId());
        this.assertGranted("publications.read");
        const parsedPublicationId = z.uuid().parse(publicationId);
        return this.request({
            method: "POST",
            path: `/api/v1/connectors/${encodeURIComponent(connectorId)}/publications/${encodeURIComponent(parsedPublicationId)}/status`,
            body: {
                protocolVersion: CLOUD_PROTOCOL_VERSION,
                connectorId,
                publicationId: parsedPublicationId,
            },
            schema: connectorPublicationStatusSchema,
            signed: true,
        });
    }
    async controlPublication(input, signal) {
        const parsed = connectorPublicationControlRequestSchema.parse(input);
        const connectorId = this.pairedConnectorId();
        if (parsed.connectorId !== connectorId)
            throw new Error("The publication control request belongs to a different connector");
        const requiredScope = parsed.operation.type === "publication.unpublish"
            ? "publications.unpublish"
            : "publications.write";
        this.assertGranted(requiredScope);
        return this.request({
            method: "POST",
            path: `/api/v1/connectors/${encodeURIComponent(connectorId)}/publications/${encodeURIComponent(parsed.operation.publicationId)}/control`,
            body: parsed,
            schema: publicationControlResultSchema,
            signed: true,
            ...(signal ? { signal } : {}),
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
    assertGranted(scope) {
        if (!this.config.paired?.scopes.includes(scope))
            throw new Error(`The local pairing grant does not include ${scope}`);
    }
    async request(input) {
        const body = input.body === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(input.body));
        let lastError;
        for (let attempt = 0; attempt < this.maximumAttempts; attempt += 1) {
            try {
                input.signal?.throwIfAborted();
                const url = new URL(input.path, `${this.config.baseUrl}/`);
                const headers = new Headers({ Accept: "application/json" });
                if (input.body !== undefined)
                    headers.set("Content-Type", "application/json");
                if (input.signed) {
                    for (const [name, value] of Object.entries(await this.signedHeaders(url, input.method, body)))
                        headers.set(name, value);
                }
                input.signal?.throwIfAborted();
                const timeout = AbortSignal.timeout(this.requestTimeoutMilliseconds);
                const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
                const response = await this.fetchImplementation(url, {
                    method: input.method,
                    headers,
                    ...(input.body === undefined ? {} : { body }),
                    signal,
                });
                const responseBody = await readBoundedResponse(response, signal);
                signal.throwIfAborted();
                if (!response.ok) {
                    let error = cloudError(response, responseBody);
                    if (input.commandScoped &&
                        [400, 401, 403, 404, 409, 410, 422].includes(response.status) &&
                        error.options.code !== "clock-skew")
                        error = new CloudRequestError(error.message, { ...error.options, retryable: false });
                    if (error.options.serverUnixSeconds !== undefined) {
                        this.clockOffsetSeconds =
                            error.options.serverUnixSeconds - Math.floor(this.now() / 1_000);
                    }
                    const clockSkewRetry = error.options.code === "clock-skew";
                    if ((!error.options.retryable && !clockSkewRetry) || attempt + 1 >= this.maximumAttempts)
                        throw error;
                    if (!clockSkewRetry)
                        await this.sleep(backoffMilliseconds(attempt, this.random, error.options.retryAfterSeconds), input.signal);
                    continue;
                }
                return input.schema.parse(parseJson(responseBody));
            }
            catch (error) {
                input.signal?.throwIfAborted();
                lastError = error;
                if (error instanceof z.ZodError ||
                    (error instanceof CloudRequestError && !error.options.retryable))
                    throw error;
                if (attempt + 1 >= this.maximumAttempts)
                    break;
                const retryAfter = error instanceof CloudRequestError ? error.options.retryAfterSeconds : undefined;
                await this.sleep(backoffMilliseconds(attempt, this.random, retryAfter), input.signal);
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
        const timestamp = Math.floor(this.serverAdjustedNow() / 1_000);
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
function isLocalServiceUrl(value) {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/u, "");
    if (hostname === "localhost" ||
        hostname === "0.0.0.0" ||
        hostname === "[::]" ||
        hostname === "[::1]" ||
        /^127\./u.test(hostname))
        return true;
    // URL parsing canonicalizes mapped IPv4 addresses to IPv6 hexadecimal words,
    // including dotted inputs such as [::ffff:127.0.0.1].
    const mapped = /^\[::ffff:([\da-f]{1,4}):([\da-f]{1,4})\]$/u.exec(hostname);
    if (!mapped)
        return false;
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return high >>> 8 === 127 || (high === 0 && low === 0);
}
async function readBoundedResponse(response, signal) {
    const oversized = () => new CloudRequestError("Knot Cloud returned an oversized response", {
        retryable: false,
        code: "response-too-large",
        status: response.status,
    });
    const contentLength = response.headers.get("Content-Length");
    if (contentLength && Number(contentLength) > maximumResponseBytes) {
        await response.body?.cancel();
        throw oversized();
    }
    if (!response.body)
        return new Uint8Array();
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    const abort = () => {
        void reader.cancel(signal.reason).catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
        signal.throwIfAborted();
        while (true) {
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done)
                break;
            length += value.byteLength;
            if (length > maximumResponseBytes) {
                await reader.cancel();
                throw oversized();
            }
            chunks.push(value);
        }
        const body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return body;
    }
    finally {
        signal.removeEventListener("abort", abort);
        reader.releaseLock();
    }
}
function parseJson(body) {
    try {
        return JSON.parse(new TextDecoder().decode(body));
    }
    catch {
        throw new CloudRequestError("Knot Cloud returned invalid JSON", {
            retryable: false,
            code: "invalid-json",
        });
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

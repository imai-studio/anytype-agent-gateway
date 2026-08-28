import { homedir } from "node:os";
import { join } from "node:path";
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution-runtime";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";
const AccountSchema = z
    .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    listenHost: z.enum(["127.0.0.1", "::1", "localhost"]).optional(),
    listenPort: z.number().int().min(1).max(65_535).optional(),
    bridgeToken: z.string().min(24),
    databasePath: z.string().min(1).optional(),
    allowFrom: z.array(z.string().min(1)).min(1),
})
    .strict();
const ConfigSchema = AccountSchema.extend({
    accounts: z.record(z.string(), AccountSchema.partial()).optional(),
    defaultAccount: z.string().optional(),
}).strict();
export const anytypePluginConfigSchema = buildChannelConfigSchema(ConfigSchema);
const helpers = createAccountListHelpers("anytype", {
    normalizeAccountId,
    implicitDefaultAccount: { channelKeys: ["bridgeToken"] },
});
export const listAnytypeAccountIds = helpers.listAccountIds;
export const resolveDefaultAnytypeAccountId = helpers.resolveDefaultAccountId;
export function resolveAnytypeAccount(cfg, accountIdValue) {
    const accountId = normalizeAccountId(accountIdValue);
    const channel = cfg.channels?.anytype;
    const merged = resolveMergedAccountConfig({
        channelConfig: channel,
        accounts: channel?.accounts,
        accountId,
        omitKeys: ["defaultAccount"],
        normalizeAccountId,
    });
    const enabled = channel?.enabled !== false && merged.enabled !== false;
    const bridgeToken = merged.bridgeToken?.trim() ?? "";
    return {
        accountId,
        enabled,
        configured: bridgeToken.length >= 24 && (merged.allowFrom?.length ?? 0) > 0,
        ...(merged.name ? { name: merged.name } : {}),
        listenHost: merged.listenHost ?? "127.0.0.1",
        listenPort: merged.listenPort ?? 18791,
        bridgeToken,
        databasePath: merged.databasePath ?? join(homedir(), ".openclaw", "anytype", `${accountId}.sqlite`),
        allowFrom: merged.allowFrom ?? [],
    };
}
export { DEFAULT_ACCOUNT_ID };
//# sourceMappingURL=config.js.map
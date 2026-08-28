import type { ChannelConfigSchema } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { z } from "zod";
declare const AccountSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    listenHost: z.ZodOptional<z.ZodEnum<{
        "127.0.0.1": "127.0.0.1";
        "::1": "::1";
        localhost: "localhost";
    }>>;
    listenPort: z.ZodOptional<z.ZodNumber>;
    bridgeToken: z.ZodString;
    databasePath: z.ZodOptional<z.ZodString>;
    allowFrom: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export declare const anytypePluginConfigSchema: ChannelConfigSchema;
export type AnytypeAccountConfig = z.infer<typeof AccountSchema>;
export type CoreConfig = {
    channels?: {
        anytype?: Partial<AnytypeAccountConfig> & {
            accounts?: Record<string, Partial<AnytypeAccountConfig>>;
            defaultAccount?: string;
        };
    };
    session?: {
        store?: string;
    };
};
export type ResolvedAnytypeAccount = {
    accountId: string;
    enabled: boolean;
    configured: boolean;
    name?: string;
    listenHost: "127.0.0.1" | "::1" | "localhost";
    listenPort: number;
    bridgeToken: string;
    databasePath: string;
    allowFrom: string[];
};
export declare const listAnytypeAccountIds: (cfg: import("openclaw/plugin-sdk").ClawdbotConfig) => string[];
export declare const resolveDefaultAnytypeAccountId: (cfg: import("openclaw/plugin-sdk").ClawdbotConfig) => string;
export declare function resolveAnytypeAccount(cfg: CoreConfig, accountIdValue?: string | null): ResolvedAnytypeAccount;
export { DEFAULT_ACCOUNT_ID };
//# sourceMappingURL=config.d.ts.map
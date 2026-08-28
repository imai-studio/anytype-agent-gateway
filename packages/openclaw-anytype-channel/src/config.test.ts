import { describe, expect, it } from "vitest";
import { resolveAnytypeAccount } from "./config.js";

describe("Anytype channel account configuration", () => {
  it("supports accounts-only configuration without top-level credentials", () => {
    const account = resolveAnytypeAccount(
      {
        channels: {
          anytype: {
            defaultAccount: "production",
            accounts: {
              production: { bridgeToken: "token-that-is-at-least-24-chars", allowFrom: ["owner"] },
            },
          },
        },
      },
      "production",
    );
    expect(account).toMatchObject({
      accountId: "production",
      configured: true,
      allowFrom: ["owner"],
    });
  });
});

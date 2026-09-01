import { describe, expect, it } from "vitest";
import {
  fmsgChannelConfigSchema,
  isFmsgSenderAllowed,
  resolveFmsgAccount,
  resolveEffectiveAllowedUsers,
  resolveFmsgConfig,
} from "../src/config.js";

describe("fmsg config", () => {
  it("uses environment values before channel config", () => {
    const config = resolveFmsgConfig(
      {
        channels: {
          fmsg: {
            apiUrl: "https://configured.example",
            apiKey: "fmsgk_configured",
            allowedUsers: ["@configured@example.com"],
          },
        },
      } as never,
      {
        FMSG_API_URL: "https://environment.example/",
        FMSG_API_KEY: "fmsgk_environment",
        FMSG_ALLOWED_USERS: "@Alice@Example.NET,@bob@example.org",
        FMSG_MAX_AGENT_TURNS_PER_THREAD: "12",
        FMSG_AGENT_TURN_WINDOW_MS: "90000",
      },
    );
    expect(config).toMatchObject({
      apiUrl: "https://environment.example",
      apiKey: "fmsgk_environment",
      allowedUsers: ["@alice@example.net", "@bob@example.org"],
      maxAgentTurnsPerThread: 12,
      agentTurnWindowMs: 90000,
    });
  });

  it("seeds an empty allowlist from homeChannel", () => {
    const config = resolveFmsgConfig(
      { channels: { fmsg: { homeChannel: "@Owner@Example.com" } } } as never,
      {},
    );
    expect(resolveEffectiveAllowedUsers(config)).toEqual({
      users: ["@owner@example.com"],
      seededFromHome: true,
    });
    expect(isFmsgSenderAllowed(config, "@OWNER@example.com")).toBe(true);
    expect(isFmsgSenderAllowed(config, "@other@example.com")).toBe(false);
  });

  it("is default deny and supports an explicit allow-all", () => {
    const denied = resolveFmsgConfig({ channels: { fmsg: {} } } as never, {});
    expect(isFmsgSenderAllowed(denied, "@alice@example.net")).toBe(false);
    const open = resolveFmsgConfig(
      { channels: { fmsg: { allowAllUsers: true } } } as never,
      {},
    );
    expect(isFmsgSenderAllowed(open, "@alice@example.net")).toBe(true);
  });

  it.each(["env", "file", "exec", "store"] as const)(
    "accepts an OpenClaw %s SecretRef",
    (source) => {
      const result = fmsgChannelConfigSchema.runtime?.safeParse({
        apiUrl: "https://fmsg-api.example.com",
        apiKey: { source, provider: "default", id: "FMSG_API_KEY" },
      });
      expect(result?.success).toBe(true);
    },
  );

  it("rejects malformed SecretRefs", () => {
    const result = fmsgChannelConfigSchema.runtime?.safeParse({
      apiUrl: "https://fmsg-api.example.com",
      apiKey: { source: "unknown", provider: "default", id: "FMSG_API_KEY" },
    });
    expect(result?.success).toBe(false);
  });

  it("uses FMSG_API_KEY ahead of an unresolved configured SecretRef", () => {
    const config = resolveFmsgConfig(
      {
        channels: {
          fmsg: {
            apiUrl: "https://fmsg-api.example.com",
            apiKey: { source: "file", provider: "mounted-json", id: "/fmsg/apiKey" },
          },
        },
      } as never,
      { FMSG_API_KEY: "fmsgk_environment" },
    );
    expect(config.apiKey).toBe("fmsgk_environment");
  });

  it("requires an explicit API URL before the account is configured", () => {
    const missing = resolveFmsgAccount({ channels: { fmsg: { apiKey: "fmsgk_test" } } } as never);
    const configured = resolveFmsgAccount({
      channels: {
        fmsg: { apiUrl: "https://fmsg-api.example.com", apiKey: "fmsgk_test" },
      },
    } as never);
    expect(missing.config.apiUrl).toBeUndefined();
    expect(missing.configured).toBe(false);
    expect(configured.configured).toBe(true);
  });
});

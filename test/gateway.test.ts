import { describe, expect, it, vi } from "vitest";
import { startFmsgGatewayAccount } from "../src/gateway.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";

describe("fmsg gateway status", () => {
  it("publishes authenticated identity, access, endpoint, and credential source", async () => {
    const server = new FakeFmsgServer();
    await server.start();
    const controller = new AbortController();
    const statuses: Array<Record<string, unknown>> = [];
    try {
      await startFmsgGatewayAccount({
        account: {
          accountId: "default",
          enabled: true,
          configured: true,
          config: {
            apiUrl: server.url,
            apiKey: "fmsgk_agent-test",
            homeChannel: "@owner@example.com",
            allowedUsers: [],
            allowAllUsers: false,
            maxAgentTurnsPerThread: 8,
            maxAgentTurnsPerRoot: 20,
            maxAgentTurnsPerSender: 20,
            agentTurnWindowMs: 60_000,
            mediaMaxBytes: 10_000_000,
          },
        },
        cfg: {
          channels: {
            fmsg: {
              apiUrl: server.url,
              apiKey: "fmsgk_agent-test",
              homeChannel: "@owner@example.com",
            },
          },
        },
        abortSignal: controller.signal,
        setStatus: (patch: Record<string, unknown>) => {
          statuses.push(patch);
          if (patch.identity === "@agent@example.com") controller.abort();
        },
        channelRuntime: {
          inbound: {
            dispatch: vi.fn(),
          },
        },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as never);
    } finally {
      controller.abort();
      await server.stop();
    }

    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        baseUrl: server.url,
        credentialSource: "channels.fmsg.apiKey",
        dmPolicy: "allowlist",
        allowFrom: ["@owner@example.com"],
      }),
      expect.objectContaining({
        identity: "@agent@example.com",
        connected: true,
        lifecycle: "ready",
      }),
    ]));
  });
});

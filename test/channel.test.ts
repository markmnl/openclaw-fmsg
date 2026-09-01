import { describe, expect, it, vi } from "vitest";
import entry from "../index.js";
import { fmsgChannelPlugin } from "../src/channel.js";

describe("OpenClaw channel registration and routing", () => {
  it("registers the channel and fmsg_send tool in full mode", () => {
    const registerChannel = vi.fn();
    const registerTool = vi.fn();
    entry.register({
      registrationMode: "full",
      registerChannel,
      registerTool,
      runtime: {},
    } as never);
    expect(registerChannel).toHaveBeenCalledWith({ plugin: fmsgChannelPlugin });
    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), { name: "fmsg_send" });
  });

  it("uses per-counterparty native thread sessions with threadId before replyToId", async () => {
    const route = await fmsgChannelPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {} as never,
      agentId: "main",
      accountId: "default",
      target: "@Alice@Example.NET",
      replyToId: "direct-parent-101",
      threadId: "100:br:102",
    });
    expect(route).toBeTruthy();
    expect(route?.baseSessionKey).toContain("fmsg:direct:@alice@example.net");
    expect(route?.sessionKey).toBe(`${route?.baseSessionKey}:thread:100:br:102`);
    expect(route?.threadId).toBe("100:br:102");
  });
});

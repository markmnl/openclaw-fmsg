import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fmsgMessageActions, handleFmsgReaction } from "../src/reactions.js";
import { resolveFmsgConfig } from "../src/config.js";
import { FmsgClient } from "../src/client.js";
import { setFmsgRuntime } from "../src/runtime.js";
import { FmsgStateStore } from "../src/state.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";

describe("fmsg reactions", () => {
  let server: FakeFmsgServer;
  let directory: string;

  beforeEach(async () => {
    server = new FakeFmsgServer();
    await server.start();
    directory = await mkdtemp(path.join(os.tmpdir(), "openclaw-fmsg-reactions-"));
  });

  afterEach(async () => {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it("exposes native message actions and implements add, list, and precise removal", async () => {
    server.seedMessage({
      id: 40,
      from: "@alice@example.net",
      to: ["@agent@example.com"],
      data: "subject",
    });
    const cfg = {
      channels: {
        fmsg: {
          apiUrl: server.url,
          apiKey: "fmsgk_agent-test",
          allowedUsers: ["@alice@example.net"],
        },
      },
    } as never;
    expect(fmsgMessageActions.describeMessageTool({ cfg })).toMatchObject({
      actions: ["send", "react", "reactions"],
    });
    await fmsgMessageActions.handleAction?.({
      channel: "fmsg",
      action: "react",
      cfg,
      params: { messageId: "40", emoji: "👍" },
    });
    expect(server.getMessage("40")?.reactions).toEqual([
      { emoji: "👍", from: ["@agent@example.com"] },
    ]);
    const listed = await fmsgMessageActions.handleAction?.({
      channel: "fmsg",
      action: "reactions",
      cfg,
      params: { messageId: "40" },
    });
    expect(JSON.stringify(listed)).toContain("@agent@example.com");

    await fmsgMessageActions.handleAction?.({
      channel: "fmsg",
      action: "react",
      cfg,
      params: { messageId: "40", emoji: "❤️", remove: true },
    });
    expect(server.getMessage("40")?.reactions).toEqual([
      { emoji: "👍", from: ["@agent@example.com"] },
    ]);
    await fmsgMessageActions.handleAction?.({
      channel: "fmsg",
      action: "react",
      cfg,
      params: { messageId: "40", emoji: "👍", remove: true },
    });
    expect(server.getMessage("40")?.reactions).toEqual([]);
  });

  it("routes allowed reaction deltas into the existing branch as low-priority system events", async () => {
    const enqueueSystemEvent = vi.fn(() => true);
    setFmsgRuntime({ system: { enqueueSystemEvent } } as never);
    const cfg = {
      channels: {
        fmsg: {
          apiUrl: server.url,
          apiKey: "fmsgk_agent-test",
          allowedUsers: ["@alice@example.net", "@bob@example.org"],
          reactionNotifications: "own",
        },
      },
    } as never;
    const state = new FmsgStateStore(path.join(directory, "state.json"));
    await state.load();
    const root = {
      id: "50",
      from: "@alice@example.net",
      to: ["@agent@example.com", "@bob@example.org"],
      data: "root",
    };
    state.assignMessage(root);
    state.assignMessage({
      id: "51",
      pid: "50",
      from: "@agent@example.com",
      to: ["@alice@example.net", "@bob@example.org"],
      reactions: [],
    });
    await state.recordReactionSnapshot({
      id: "51",
      pid: "50",
      from: "@agent@example.com",
      to: ["@alice@example.net", "@bob@example.org"],
      reactions: [],
    }, { seedIfMissing: true });
    const config = resolveFmsgConfig(cfg, {});
    const account = {
      accountId: "default",
      config,
      client: new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 }),
      state,
      log: { warn: vi.fn() },
    };
    await handleFmsgReaction({
      cfg,
      account,
      source: "websocket",
      message: {
        id: "51",
        pid: "50",
        from: "@agent@example.com",
        to: ["@alice@example.net", "@bob@example.org"],
        reactions: [{ emoji: "👍", from: ["@bob@example.org"] }],
      },
    });
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("@bob@example.org reacted"),
      expect.objectContaining({
        sessionKey: expect.stringContaining("fmsg:direct:@alice@example.net:thread:50"),
        contextKey: expect.stringContaining("fmsg:reaction:51:@bob@example.org:"),
      }),
    );
  });

  it("seeds historical reactions silently during first catch-up", async () => {
    const enqueueSystemEvent = vi.fn(() => true);
    setFmsgRuntime({ system: { enqueueSystemEvent } } as never);
    const cfg = {
      channels: {
        fmsg: {
          apiUrl: server.url,
          apiKey: "fmsgk_agent-test",
          allowedUsers: ["@alice@example.net"],
        },
      },
    } as never;
    const state = new FmsgStateStore(path.join(directory, "historical.json"));
    await state.load();
    await handleFmsgReaction({
      cfg,
      source: "catch-up",
      account: {
        accountId: "default",
        config: resolveFmsgConfig(cfg, {}),
        client: new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 }),
        state,
      },
      message: {
        id: "60",
        from: "@agent@example.com",
        to: ["@alice@example.net"],
        reactions: [{ emoji: "👍", from: ["@alice@example.net"] }],
      },
    });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(state.getReactionSnapshot("60")).toEqual({ "@alice@example.net": "👍" });
  });

  it("applies own, all, and off inbound notification modes", async () => {
    const enqueueSystemEvent = vi.fn(() => true);
    setFmsgRuntime({ system: { enqueueSystemEvent } } as never);
    const cfg = {
      channels: {
        fmsg: {
          apiUrl: server.url,
          apiKey: "fmsgk_agent-test",
          allowedUsers: ["@alice@example.net", "@bob@example.org"],
          reactionNotifications: "own",
        },
      },
    } as never;
    const state = new FmsgStateStore(path.join(directory, "modes.json"));
    await state.load();
    const subject = {
      id: "70",
      from: "@alice@example.net",
      to: ["@agent@example.com", "@bob@example.org"],
      reactions: [] as Array<{ emoji: string; from: string[] }>,
    };
    state.assignMessage(subject);
    await state.recordReactionSnapshot(subject, { seedIfMissing: true });
    const account = {
      accountId: "default",
      config: resolveFmsgConfig(cfg, {}),
      client: new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 }),
      state,
    };
    await handleFmsgReaction({
      cfg,
      account,
      source: "websocket",
      message: { ...subject, reactions: [{ emoji: "👍", from: ["@bob@example.org"] }] },
    });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    account.config.reactionNotifications = "all";
    await handleFmsgReaction({
      cfg,
      account,
      source: "websocket",
      message: { ...subject, reactions: [{ emoji: "❤️", from: ["@bob@example.org"] }] },
    });
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);

    account.config.reactionNotifications = "off";
    await handleFmsgReaction({
      cfg,
      account,
      source: "websocket",
      message: { ...subject, reactions: [{ emoji: "🔥", from: ["@bob@example.org"] }] },
    });
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
  });
});

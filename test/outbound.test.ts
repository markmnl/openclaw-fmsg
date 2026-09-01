import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FmsgClient } from "../src/client.js";
import { fmsgChannelPlugin } from "../src/channel.js";
import { sendFmsgOutbound } from "../src/outbound.js";
import { getActiveFmsgAccount, registerActiveFmsgAccount } from "../src/service.js";
import { FmsgStateStore } from "../src/state.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";

describe("fmsg outbound semantics", () => {
  let server: FakeFmsgServer;
  let directory: string;
  let state: FmsgStateStore;
  let unregister: () => void;

  beforeEach(async () => {
    server = new FakeFmsgServer();
    await server.start();
    directory = await mkdtemp(path.join(os.tmpdir(), "openclaw-fmsg-outbound-"));
    state = new FmsgStateStore(path.join(directory, "state.json"));
    await state.load();
    unregister = registerActiveFmsgAccount({
      accountId: "default",
      config: {
        apiUrl: server.url,
        apiKey: "fmsgk_agent-test",
        allowedUsers: ["@alice@example.net"],
        allowAllUsers: false,
        maxAgentTurnsPerThread: 8,
        maxAgentTurnsPerRoot: 20,
        maxAgentTurnsPerSender: 20,
        agentTurnWindowMs: 60_000,
        mediaMaxBytes: 10_000_000,
      },
      client: new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 }),
      state,
    });
  });

  afterEach(async () => {
    unregister();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it("replies to the selected parent and reply-alls to all parent participants", async () => {
    const parent = server.seedMessage({
      id: 10,
      from: "@alice@example.net",
      to: ["@agent@example.com", "@bob@example.org"],
      add_to: [{ add_to_from: "@carol@example.net", to: ["@dave@example.org"] }],
      data: "hello everyone",
    });
    state.assignMessage(parent, { inbound: true });
    const sent = await sendFmsgOutbound({
      cfg: {} as never,
      to: "@alice@example.net",
      text: "hello back",
      replyToId: "10",
      threadId: "10",
    });
    expect(sent.pid).toBe("10");
    expect(sent.recipients).toEqual([
      "@alice@example.net",
      "@bob@example.org",
      "@carol@example.net",
      "@dave@example.org",
    ]);
    const draft = server.requests.find((request) => request.method === "POST" && request.path === "/fmsg")?.body as { pid: number; to: string[] };
    expect(draft).toMatchObject({ pid: 10, to: sent.recipients });
  });

  it("falls back to stored participants and warns when the parent fetch fails", async () => {
    const parent = server.seedMessage({
      id: 11,
      from: "@alice@example.net",
      to: ["@agent@example.com", "@bob@example.org"],
      add_to: [{ add_to_from: "@carol@example.net", to: ["@dave@example.org"] }],
      data: "hello everyone",
    });
    state.assignMessage(parent, { inbound: true });
    const active = getActiveFmsgAccount();
    expect(active).toBeDefined();
    const warnings: string[] = [];
    active!.log = { warn: (message) => warnings.push(message) };
    const getMessage = vi.spyOn(active!.client, "getMessage")
      .mockRejectedValue(new Error("simulated parent lookup failure"));

    const sent = await sendFmsgOutbound({
      cfg: {} as never,
      to: "@alice@example.net",
      text: "cached reply-all",
      replyToId: "11",
      threadId: "11",
    });

    expect(getMessage).toHaveBeenCalledWith("11", undefined);
    expect(sent.recipients).toEqual([
      "@alice@example.net",
      "@bob@example.org",
      "@carol@example.net",
      "@dave@example.org",
    ]);
    expect(warnings.join("\n")).toContain(
      "parent message 11 fetch failed; using stored participant metadata",
    );
    const draft = server.requests.find(
      (request) => request.method === "POST" && request.path === "/fmsg",
    )?.body as { to: string[] };
    expect(draft.to).toEqual(sent.recipients);
  });

  it("continues only the most recent strict one-to-one thread", async () => {
    server.seedMessage({
      id: 20,
      from: "@alice@example.net",
      to: ["@agent@example.com"],
      data: "direct",
      time: 20,
    });
    server.seedMessage({
      id: 21,
      from: "@alice@example.net",
      to: ["@agent@example.com", "@bob@example.org"],
      data: "newer group",
      time: 21,
    });
    // A stale/legacy cache entry must not bypass the strict-DM check.
    await state.rememberDirect("@alice@example.net", "21");
    const sent = await sendFmsgOutbound({
      cfg: {} as never,
      to: "@alice@example.net",
      text: "proactive continuation",
    });
    expect(sent.pid).toBe("20");
    expect(sent.createdRoot).toBe(false);
  });

  it("forces a new root when requested", async () => {
    server.seedMessage({
      id: 30,
      from: "@alice@example.net",
      to: ["@agent@example.com"],
      data: "existing",
    });
    const sent = await sendFmsgOutbound({
      cfg: {} as never,
      to: "@alice@example.net",
      text: "fresh",
      newThread: true,
      topic: "Fresh topic",
    });
    expect(sent.createdRoot).toBe(true);
    expect(sent.pid).toBeUndefined();
    const draft = server.requests.find((request) => request.method === "POST" && request.path === "/fmsg")?.body as { topic: string };
    expect(draft.topic).toBe("Fresh topic");
  });

  it("reports the authenticated channel identity through directory.self", async () => {
    const identity = await fmsgChannelPlugin.directory?.self?.({
      cfg: {} as never,
      accountId: "default",
      runtime: {} as never,
    });
    expect(identity).toMatchObject({
      kind: "user",
      id: "@agent@example.com",
      handle: "@agent@example.com",
    });
  });
});

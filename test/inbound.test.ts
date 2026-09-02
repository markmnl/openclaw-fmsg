import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FmsgClient } from "../src/client.js";
import { handleFmsgInbound } from "../src/inbound.js";
import { registerActiveFmsgAccount, type ActiveFmsgAccount } from "../src/service.js";
import { FmsgStateStore } from "../src/state.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";

function successfulAutomaticDispatch() {
  return vi.fn(async (request: {
    delivery: {
      onDelivered: (payload: unknown, info: unknown, result: unknown) => Promise<void>;
    };
  }) => {
    await request.delivery.onDelivered({}, {}, {
      receipt: { primaryPlatformMessageId: "delivered" },
    });
    return {
      admission: { kind: "dispatch" },
      dispatched: true,
      dispatchResult: { settledReceipt: { counts: {}, anyVisibleDelivered: true } },
    };
  });
}

describe("fmsg inbound policy and reply delivery", () => {
  let server: FakeFmsgServer;
  let directory: string;
  let service: ActiveFmsgAccount;
  let unregister: () => void;
  let previousStateDir: string | undefined;

  beforeEach(async () => {
    server = new FakeFmsgServer();
    await server.start();
    directory = await mkdtemp(path.join(os.tmpdir(), "openclaw-fmsg-inbound-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = directory;
    const state = new FmsgStateStore(path.join(directory, "state.json"));
    await state.load();
    service = {
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
        actions: { reactions: true },
        reactionNotifications: "own",
      },
      client: new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 }),
      state,
    };
    unregister = registerActiveFmsgAccount(service);
  });

  afterEach(async () => {
    unregister();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
  });

  it("records and marks no_reply inbound without dispatching an agent turn", async () => {
    server.seedMessage({
      id: 49,
      from: "@agent@example.com",
      to: ["@alice@example.net"],
      data: "parent",
    });
    const message = server.seedMessage({
      id: 50,
      pid: "49",
      has_pid: true,
      from: "@alice@example.net",
      to: ["@agent@example.com"],
      no_reply: true,
      data: "do not answer",
    });
    const getMessage = vi.spyOn(service.client, "getMessage");
    const dispatch = vi.fn();
    await handleFmsgInbound({
      cfg: {} as never,
      account: service,
      channelRuntime: { inbound: { dispatch } } as never,
      message,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(service.state.hasProcessed("50")).toBe(true);
    expect(service.state.getMessage("50")).toBeUndefined();
    expect(getMessage).not.toHaveBeenCalled();
    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toContain("POST /fmsg/50/read");
  });

  it("bounds sibling fan-out with the root turn budget", async () => {
    service.config.maxAgentTurnsPerRoot = 3;
    const warnings: string[] = [];
    service.log = { warn: (value) => warnings.push(value) };
    server.seedMessage({
      id: 100,
      from: "@agent@example.com",
      to: ["@alice@example.net"],
      data: "shared parent",
    });
    const dispatch = successfulAutomaticDispatch();

    for (let index = 1; index <= 6; index++) {
      const message = server.seedMessage({
        id: 100 + index,
        pid: "100",
        has_pid: true,
        from: "@alice@example.net",
        to: ["@agent@example.com"],
        data: `sibling ${index}`,
      });
      await handleFmsgInbound({
        cfg: {} as never,
        account: service,
        channelRuntime: { inbound: { dispatch } } as never,
        message,
      });
    }

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(service.state.inspectRootTurnWindow("100", 3, 60_000).count).toBe(3);
    expect(warnings.filter((value) => value.includes("scope=root"))).toHaveLength(1);
    expect(warnings[0]).toContain("key=100 sender=@alice@example.net budget=3");
  });

  it("keeps a normal linear exchange within the branch budget", async () => {
    service.config.maxAgentTurnsPerThread = 3;
    const dispatch = successfulAutomaticDispatch();
    const inboundMessages = [
      server.seedMessage({
        id: 200,
        from: "@alice@example.net",
        to: ["@agent@example.com"],
        data: "turn one",
      }),
    ];
    server.seedMessage({
      id: 201,
      pid: "200",
      has_pid: true,
      from: "@agent@example.com",
      to: ["@alice@example.net"],
      data: "agent one",
    });
    inboundMessages.push(server.seedMessage({
      id: 202,
      pid: "201",
      has_pid: true,
      from: "@alice@example.net",
      to: ["@agent@example.com"],
      data: "turn two",
    }));
    server.seedMessage({
      id: 203,
      pid: "202",
      has_pid: true,
      from: "@agent@example.com",
      to: ["@alice@example.net"],
      data: "agent two",
    });
    inboundMessages.push(server.seedMessage({
      id: 204,
      pid: "203",
      has_pid: true,
      from: "@alice@example.net",
      to: ["@agent@example.com"],
      data: "turn three",
    }));

    for (const message of inboundMessages) {
      await handleFmsgInbound({
        cfg: {} as never,
        account: service,
        channelRuntime: { inbound: { dispatch } } as never,
        message,
      });
    }

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(service.state.inspectTurnWindow("200", 3, 60_000).count).toBe(3);
  });

  it("bounds one sender across distinct root threads", async () => {
    service.config.maxAgentTurnsPerSender = 3;
    const warnings: string[] = [];
    service.log = { warn: (value) => warnings.push(value) };
    const dispatch = successfulAutomaticDispatch();

    for (let index = 0; index < 6; index++) {
      const message = server.seedMessage({
        id: 300 + index,
        from: "@alice@example.net",
        to: ["@agent@example.com"],
        data: `new root ${index}`,
      });
      await handleFmsgInbound({
        cfg: {} as never,
        account: service,
        channelRuntime: { inbound: { dispatch } } as never,
        message,
      });
    }

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(service.state.inspectSenderTurnWindow("@alice@example.net", 3, 60_000).count).toBe(3);
    expect(warnings.filter((value) => value.includes("scope=sender"))).toHaveLength(1);
    expect(warnings[0]).toContain("key=@alice@example.net sender=@alice@example.net budget=3");
  });

  it("chains multiple replies and resets their direct parent from the inbound", async () => {
    const message = server.seedMessage({
      id: 60,
      from: "@alice@example.net",
      to: ["@agent@example.com", "@bob@example.org"],
      important: true,
      data: "two answers please",
    });
    let contextInput: Record<string, unknown> | undefined;
    const dispatch = vi.fn(async (request: { delivery: { deliver: (payload: unknown, info: unknown) => Promise<void> } }) => {
      expect(request.delivery).toHaveProperty("durable");
      await request.delivery.deliver({ text: "first" }, { kind: "block" });
      await request.delivery.deliver({ text: "second" }, { kind: "final" });
      return { admission: { kind: "dispatch" }, dispatched: true };
    });
    await handleFmsgInbound({
      cfg: {} as never,
      account: service,
      channelRuntime: { inbound: { dispatch } } as never,
      buildContext: ((input: Record<string, unknown> & { route: { dispatchSessionKey: string } }) => {
        contextInput = input;
        return { SessionKey: input.route.dispatchSessionKey };
      }) as never,
      message,
    });
    const drafts = server.requests
      .filter((request) => request.method === "POST" && request.path === "/fmsg")
      .map((request) => request.body as { pid: number; to: string[]; data: string });
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ pid: 60, to: ["@alice@example.net", "@bob@example.org"], data: "first" });
    expect(drafts[1]).toMatchObject({ pid: 61, to: ["@alice@example.net", "@bob@example.org"], data: "second" });
    expect(service.state.inspectTurnWindow("60", 8, 60_000).count).toBe(1);
    expect(contextInput?.conversation).toMatchObject({
      kind: "direct",
      id: "@alice@example.net",
    });
    expect(contextInput?.reply).toMatchObject({ to: "fmsg:@alice@example.net" });
    expect(contextInput?.extra).toMatchObject({
      FmsgParticipants: ["@alice@example.net", "@bob@example.org"],
      FmsgImportant: true,
    });
    const bodyForAgent = (contextInput?.message as { bodyForAgent?: string }).bodyForAgent;
    expect(bodyForAgent).toContain("important=true");
    expect(bodyForAgent).toContain(
      'participants other than this OpenClaw address: ["@alice@example.net","@bob@example.org"]',
    );
  });

  it("advances durable reply parents and marks the final allowed turn no_reply", async () => {
    service.config.maxAgentTurnsPerThread = 1;
    const message = server.seedMessage({
      id: 65,
      from: "@alice@example.net",
      to: ["@agent@example.com"],
      data: "answer once",
    });
    const dispatch = vi.fn(async (request: {
      delivery: {
        preparePayload: (payload: Record<string, unknown>) => Record<string, unknown>;
        durable: () => { replyToId?: string; replyToMode?: string; threadId?: string };
        onDelivered: (payload: unknown, info: unknown, result: unknown) => Promise<void>;
      };
    }) => {
      expect(request.delivery.preparePayload({ text: "first" })).toMatchObject({
        channelData: { fmsg: { noReply: true } },
      });
      expect(request.delivery.durable()).toMatchObject({
        replyToId: "65",
        replyToMode: "all",
        threadId: "65",
      });
      await request.delivery.onDelivered({}, {}, {
        receipt: { primaryPlatformMessageId: "66" },
      });
      expect(request.delivery.durable()).toMatchObject({ replyToId: "66" });
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        dispatchResult: {
          settledReceipt: { counts: {}, anyVisibleDelivered: true },
        },
      };
    });

    await handleFmsgInbound({
      cfg: {} as never,
      account: service,
      channelRuntime: { inbound: { dispatch } } as never,
      message,
    });
    expect(service.state.inspectTurnWindow("65", 1, 60_000).count).toBe(1);
  });

  it("does not acknowledge an inbound message when every reply delivery fails", async () => {
    const message = server.seedMessage({
      id: 70,
      from: "@alice@example.net",
      to: ["@agent@example.com"],
      data: "please answer",
    });
    const errors: string[] = [];
    service.log = { error: (value) => errors.push(value) };
    const dispatch = vi.fn(async (request: {
      delivery: { onError?: (error: unknown) => void };
    }) => {
      request.delivery.onError?.(new Error("simulated transport rejection"));
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        dispatchResult: {
          settledReceipt: { counts: {}, anyVisibleDelivered: false },
        },
      };
    });

    await expect(handleFmsgInbound({
      cfg: {} as never,
      account: service,
      channelRuntime: { inbound: { dispatch } } as never,
      message,
    })).rejects.toThrow("did not deliver");
    expect(service.state.hasProcessed("70")).toBe(false);
    expect(server.requests.map((request) => `${request.method} ${request.path}`))
      .not.toContain("POST /fmsg/70/read");
    expect(errors.join("\n")).toContain("reply not delivered for message 70 branch 70");
  });
});

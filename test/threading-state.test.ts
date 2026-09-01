import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FmsgStateStore } from "../src/state.js";
import { participantsFromMessage, replyAllRecipients } from "../src/threading.js";

describe("thread mapping and state", () => {
  let directory: string;
  let state: FmsgStateStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "openclaw-fmsg-test-"));
    state = new FmsgStateStore(path.join(directory, "state.json"));
    await state.load();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("continues the first-child line and forks later siblings", () => {
    expect(state.assignMessage({ id: "100", from: "@alice@example.net", to: ["@agent@example.com"] })).toMatchObject({
      rootId: "100",
      branchId: "100",
      isFork: false,
    });
    expect(state.assignMessage({ id: "101", pid: "100", from: "@agent@example.com", to: ["@alice@example.net"] })).toMatchObject({
      branchId: "100",
      isFork: false,
    });
    expect(state.assignMessage({ id: "102", pid: "100", from: "@alice@example.net", to: ["@agent@example.com"] })).toMatchObject({
      rootId: "100",
      branchId: "100:br:102",
      isFork: true,
    });
    expect(state.assignMessage({ id: "103", pid: "102", from: "@agent@example.com", to: ["@alice@example.net"] })).toMatchObject({
      branchId: "100:br:102",
      isFork: false,
    });
  });

  it("reply-alls to from, to, and add_to while excluding the agent", () => {
    const message = {
      id: "10",
      from: "@alice@example.net",
      to: ["@agent@example.com", "@BOB@example.org"],
      add_to: [
        { add_to_from: "@carol@example.net", to: ["@dave@example.org", "@bob@example.org"] },
      ],
    };
    expect(participantsFromMessage(message)).toEqual([
      "@alice@example.net",
      "@agent@example.com",
      "@bob@example.org",
      "@carol@example.net",
      "@dave@example.org",
    ]);
    expect(replyAllRecipients(message, "@agent@example.com")).toEqual([
      "@alice@example.net",
      "@bob@example.org",
      "@carol@example.net",
      "@dave@example.org",
    ]);
  });

  it("enforces and expires the configurable sliding turn window", async () => {
    for (let index = 0; index < 8; index++) {
      const check = state.inspectTurnWindow("100", 8, 60_000, index * 1000);
      expect(check.suppressed).toBe(false);
      expect(check.lastAllowed).toBe(index === 7);
      await state.recordAutomaticTurn("100", 60_000, index * 1000);
    }
    expect(state.inspectTurnWindow("100", 8, 60_000, 8_000).suppressed).toBe(true);
    expect(state.inspectTurnWindow("100", 8, 60_000, 61_000).suppressed).toBe(false);
    expect(state.inspectTurnWindow("100", 0, 60_000, 8_000).suppressed).toBe(false);
  });

  it("persists branch assignments and processed IDs", async () => {
    state.assignMessage({ id: "42", from: "@alice@example.net", to: ["@agent@example.com"] });
    await state.markProcessed("42");
    const reloaded = new FmsgStateStore(path.join(directory, "state.json"));
    await reloaded.load();
    expect(reloaded.hasProcessed("42")).toBe(true);
    expect(reloaded.getMessage("42")?.branchId).toBe("42");
  });
});

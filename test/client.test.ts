import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FmsgClient, normalizeFmsgMessage } from "../src/client.js";
import { compareFmsgMessageIds, parseFmsgJson } from "../src/message-id.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";

describe("FmsgClient", () => {
  let server: FakeFmsgServer;

  beforeEach(async () => {
    server = new FakeFmsgServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("exchanges the API key and takes sender identity from JWT sub", async () => {
    const client = new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 });
    const token = await client.getToken();
    expect(token.sender).toBe("@agent@example.com");
    expect(server.requests.filter((request) => request.path === "/fmsg/token")).toHaveLength(1);
  });

  it("creates a draft, uploads attachments, sends it, and redacts credentials", async () => {
    const client = new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 });
    const result = await client.sendMessage({
      to: ["@alice@example.net"],
      topic: "test",
      text: "key=fmsgk_abcdefghijk token=eyJhbGciOiJub25l.eyJzdWIiOiJ4In0.signature",
      attachments: [
        { filename: "hello.txt", data: Buffer.from("hello"), contentType: "text/plain" },
      ],
    });
    expect(result.id).toBe("1");
    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toContain("POST /fmsg/1/attach");
    const draft = server.requests.find((request) => request.method === "POST" && request.path === "/fmsg")?.body as { from: string; data: string; size: number };
    expect(draft.from).toBe("@agent@example.com");
    expect(draft.data).not.toContain("fmsgk_");
    expect(draft.data).toContain("[REDACTED_JWT]");
    expect(draft.size).toBe(Buffer.byteLength(draft.data));
  });

  it("writes reply pid as an exact JSON int64 rather than a string", async () => {
    const client = new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 });
    await client.sendMessage({
      to: ["@alice@example.net"],
      pid: "3517",
      text: "reply",
    });
    const draft = server.requests.find((request) => request.method === "POST" && request.path === "/fmsg");
    expect(draft?.body).toMatchObject({ pid: 3517 });
    expect(draft?.rawBody).toMatch(/"pid":3517(?:,|\})/u);
    expect(draft?.rawBody).not.toContain('"pid":"3517"');
  });

  it("preserves the full signed-int64 range in inbound and outbound ids", async () => {
    const maximum = "9223372036854775807";
    expect(parseFmsgJson<{ id: string; pid: string }>(
      `{"id":${maximum},"pid":9223372036854775806}`,
    )).toEqual({ id: maximum, pid: "9223372036854775806" });
    expect(normalizeFmsgMessage({ id: maximum, pid: "9223372036854775806", from: "@a@b", to: ["@c@d"] }))
      .toMatchObject({ id: maximum, pid: "9223372036854775806" });
    expect(compareFmsgMessageIds(maximum, "9223372036854775806")).toBe(1);

    const client = new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 });
    server.seedMessage({
      id: maximum,
      pid: "9223372036854775806",
      from: "@alice@example.net",
      to: ["@agent@example.com"],
      data: "maximum id",
    });
    await expect(client.listInbox()).resolves.toEqual([
      expect.objectContaining({ id: maximum, pid: "9223372036854775806" }),
    ]);
    await client.sendMessage({ to: ["@alice@example.net"], pid: maximum, text: "large reply" });
    const draft = server.requests.find((request) => request.method === "POST" && request.path === "/fmsg");
    expect(draft?.rawBody).toContain(`"pid":${maximum}`);
  });

  it("rejects malformed or out-of-range reply ids before sending", async () => {
    const client = new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 });
    await expect(client.sendMessage({
      to: ["@alice@example.net"],
      pid: "9223372036854775808",
      text: "reply",
    })).rejects.toThrow("out-of-range pid");
    expect(server.requests.some((request) => request.method === "POST" && request.path === "/fmsg")).toBe(false);
  });

  it("refreshes once after a protected request returns 401", async () => {
    const client = new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 });
    await client.getToken();
    server.rejectNextProtectedRequest = true;
    await expect(client.listInbox()).resolves.toEqual([]);
    expect(server.requests.filter((request) => request.path === "/fmsg/token")).toHaveLength(2);
  });

  it("fetches full text and bounded attachment bytes", async () => {
    const message = server.seedMessage({
      id: 7,
      from: "@alice@example.net",
      to: ["@agent@example.com"],
      short_text: "short",
      size: 20,
      data: "the complete message",
    });
    server.seedAttachment("7", "note.txt", Buffer.from("attachment"));
    const client = new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 });
    await expect(client.getMessageText(message)).resolves.toBe("the complete message");
    await expect(client.downloadAttachment("7", "note.txt", 100)).resolves.toMatchObject({
      data: new Uint8Array(Buffer.from("attachment")),
    });
    await expect(client.downloadAttachment("7", "note.txt", 2)).rejects.toThrow("exceeds");
  });
});

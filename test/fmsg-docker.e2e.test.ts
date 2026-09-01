import type WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { FmsgClient, normalizeFmsgMessage } from "../src/client.js";
import type { FmsgMessage } from "../src/types.js";

const enabled = process.env.FMSG_E2E === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when FMSG_E2E=1`);
  return value;
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function nextNewMessage(
  socket: WebSocket,
  predicate: (message: FmsgMessage) => boolean,
  timeoutMs = 30_000,
): Promise<FmsgMessage> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for fmsg WebSocket message")), timeoutMs);
    socket.on("message", function onMessage(raw) {
      try {
        const event = FmsgClient.parseWsEvent(raw);
        if (event?.type !== "new_msg") return;
        const message = normalizeFmsgMessage(event.data);
        if (!predicate(message)) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(message);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

async function waitForInboxMessage(
  client: FmsgClient,
  predicate: (message: FmsgMessage) => boolean,
  description: string,
  timeoutMs = 30_000,
): Promise<FmsgMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = (await client.listInbox(100)).find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for fmsg inbox ${description}`);
}

describe.skipIf(!enabled)("fmsg-docker e2e", () => {
  it(
    "exchanges JWTs, pushes a root and attachment, and carries pid on reply",
    async () => {
      const agent = new FmsgClient(
        required("FMSG_E2E_AGENT_API_URL"),
        required("FMSG_E2E_AGENT_API_KEY"),
        { refreshMarginMs: 0 },
      );
      const peer = new FmsgClient(
        required("FMSG_E2E_PEER_API_URL"),
        required("FMSG_E2E_PEER_API_KEY"),
        { refreshMarginMs: 0 },
      );
      const [agentToken, peerToken] = await Promise.all([agent.getToken(), peer.getToken()]);
      const peerSubscription = await peer.openWebSocket();
      await waitForOpen(peerSubscription.socket);
      try {
        const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const topic = `openclaw-fmsg-e2e-${nonce}`;
        const pushed = nextNewMessage(
          peerSubscription.socket,
          (message) => message.topic === topic,
        );
        const root = await agent.sendMessage({
          to: [peerToken.sender],
          topic,
          text: `root-${nonce}`,
          attachments: [
            {
              filename: `openclaw-fmsg-${nonce}.txt`,
              contentType: "text/plain",
              data: Buffer.from(`attachment-${nonce}`),
            },
          ],
        });
        const received = await pushed;
        expect(received.topic).toBe(topic);
        expect(await peer.getMessageText(received)).toBe(`root-${nonce}`);
        const attachment = received.attachments?.[0];
        expect(attachment).toBeTruthy();
        const downloaded = await peer.downloadAttachment(received.id, attachment!.filename, 1_000_000);
        expect(Buffer.from(downloaded.data).toString()).toBe(`attachment-${nonce}`);

        await peer.sendMessage({
          to: [agentToken.sender],
          pid: received.id,
          text: `reply-${nonce}`,
        });
        const receivedReply = await waitForInboxMessage(
          agent,
          (message) => message.pid === root.id,
          `reply to ${root.id}`,
        );
        expect(receivedReply.pid).toBe(root.id);
        expect(await agent.getMessageText(receivedReply)).toBe(`reply-${nonce}`);
      } finally {
        peerSubscription.socket.close();
      }
    },
    60_000,
  );
});

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

async function nextNewMessage(socket: WebSocket, timeoutMs = 30_000): Promise<FmsgMessage> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for fmsg WebSocket message")), timeoutMs);
    socket.on("message", function onMessage(raw) {
      try {
        const event = JSON.parse(raw.toString()) as { type?: string; data?: unknown };
        if (event.type !== "new_msg") return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(normalizeFmsgMessage(event.data));
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
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
        const pushed = nextNewMessage(peerSubscription.socket);
        const root = await agent.sendMessage({
          to: [peerToken.sender],
          topic: `openclaw-fmsg-e2e-${nonce}`,
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
        expect(received.id).toBe(root.id);
        expect(await peer.getMessageText(received)).toBe(`root-${nonce}`);
        const attachment = received.attachments?.[0];
        expect(attachment).toBeTruthy();
        const downloaded = await peer.downloadAttachment(received.id, attachment!.filename, 1_000_000);
        expect(Buffer.from(downloaded.data).toString()).toBe(`attachment-${nonce}`);

        const reply = await peer.sendMessage({
          to: [agentToken.sender],
          pid: received.id,
          text: `reply-${nonce}`,
        });
        const agentInbox = await agent.listInbox(100);
        const receivedReply = agentInbox.find((message) => message.id === reply.id);
        expect(receivedReply?.pid).toBe(received.id);
      } finally {
        peerSubscription.socket.close();
      }
    },
    60_000,
  );
});

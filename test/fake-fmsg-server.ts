import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { compareFmsgMessageIds, normalizeFmsgMessageId, parseFmsgJson } from "../src/message-id.js";
import type { FmsgMessage } from "../src/types.js";

type Stored = FmsgMessage & {
  id: string;
  data: string;
  sent: boolean;
  deleted?: boolean;
};

export type FakeRequest = {
  method: string;
  path: string;
  body?: unknown;
  rawBody?: string;
};

function jwt(subject: string, expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: subject, exp: expiresAtSeconds })).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

function decodeSubject(authorization: string | undefined): string | undefined {
  const token = authorization?.replace(/^Bearer\s+/iu, "");
  if (!token || token.startsWith("fmsgk_")) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: string };
    return payload.sub;
  } catch {
    return undefined;
  }
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  // Match Go's int64 JSON encoding without first coercing through a JS number.
  const body = JSON.stringify(value).replace(
    /"(id|pid)":"([0-9]+)"/gu,
    (_match, field: string, id: string) => `"${field}":${id}`,
  );
  response.end(body);
}

export class FakeFmsgServer {
  private readonly server = createServer((request, response) => void this.handle(request, response));
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly messages = new Map<string, Stored>();
  private readonly attachmentData = new Map<string, Buffer>();
  private readonly readBy = new Map<string, Set<string>>();
  private nextId = 1;
  private startedUrl?: string;
  readonly requests: FakeRequest[] = [];
  readonly apiKeys = new Map<string, string>([
    ["fmsgk_agent-test", "@agent@example.com"],
    ["fmsgk_alice-test", "@alice@example.net"],
    ["fmsgk_bob-test", "@bob@example.org"],
  ]);
  rejectNextProtectedRequest = false;

  constructor() {
    this.server.on("upgrade", (request, socket, head) => {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== "/fmsg/ws") {
        socket.destroy();
        return;
      }
      const subject = decodeSubject(request.headers.authorization);
      if (!subject) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wsServer.handleUpgrade(request, socket, head, (ws) => {
        const set = this.sockets.get(subject) ?? new Set<WebSocket>();
        set.add(ws);
        this.sockets.set(subject, set);
        ws.on("close", () => set.delete(ws));
        this.wsServer.emit("connection", ws, request);
      });
    });
  }

  get url(): string {
    if (!this.startedUrl) throw new Error("fake fmsg server has not started");
    return this.startedUrl;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    this.startedUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const set of this.sockets.values()) for (const socket of set) socket.close();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  seedMessage(input: Omit<FmsgMessage, "id"> & { id?: string | number; data?: string }): FmsgMessage {
    const id = String(input.id ?? this.nextId++);
    const numericId = Number(id);
    if (Number.isSafeInteger(numericId)) this.nextId = Math.max(this.nextId, numericId + 1);
    const data = input.data ?? input.short_text ?? "";
    const message: Stored = {
      ...input,
      id,
      data,
      size: input.size ?? Buffer.byteLength(data),
      short_text: input.short_text ?? data.slice(0, 20),
      sent: true,
    };
    this.messages.set(id, message);
    return this.publicMessage(message);
  }

  seedAttachment(messageId: string, filename: string, data: Buffer): void {
    this.attachmentData.set(`${messageId}/${filename}`, data);
    const message = this.messages.get(messageId);
    if (message) message.attachments = [...(message.attachments ?? []), { filename, size: data.byteLength }];
  }

  pushNewMessage(message: FmsgMessage): void {
    for (const recipient of message.to) {
      for (const socket of this.sockets.get(recipient) ?? []) {
        socket.send(JSON.stringify({ type: "new_msg", data: this.publicMessage(this.messages.get(message.id)!) }));
      }
    }
  }

  getMessage(id: string): FmsgMessage | undefined {
    const message = this.messages.get(id);
    return message ? this.publicMessage(message) : undefined;
  }

  connectedClientCount(subject: string): number {
    return this.sockets.get(subject)?.size ?? 0;
  }

  private publicMessage(message: Stored): FmsgMessage {
    const { sent: _sent, deleted: _deleted, data: _data, ...result } = message;
    return result;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (method === "POST" && path === "/fmsg/token") {
      const key = request.headers.authorization?.replace(/^Bearer\s+/iu, "");
      const subject = key ? this.apiKeys.get(key) : undefined;
      this.requests.push({ method, path });
      if (!subject) return json(response, 401, { error: "invalid API key" });
      return json(response, 200, {
        access_token: jwt(subject),
        token_type: "Bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    }

    const subject = decodeSubject(request.headers.authorization);
    if (!subject) return json(response, 401, { error: "missing JWT" });
    if (this.rejectNextProtectedRequest) {
      this.rejectNextProtectedRequest = false;
      return json(response, 401, { error: "expired JWT" });
    }

    if (method === "GET" && path === "/fmsg") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const result = [...this.messages.values()]
        .filter((message) => message.sent && !message.deleted && message.to.includes(subject))
        .sort((left, right) => compareFmsgMessageIds(right.id, left.id))
        .slice(offset, offset + limit)
        .map((message) => ({
          ...this.publicMessage(message),
          read: this.readBy.get(message.id)?.has(subject) ?? false,
        }));
      this.requests.push({ method, path });
      return json(response, 200, result);
    }

    if (method === "GET" && path === "/fmsg/sent") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const result = [...this.messages.values()]
        .filter((message) => !message.deleted && message.from === subject)
        .sort((left, right) => compareFmsgMessageIds(right.id, left.id))
        .slice(offset, offset + limit)
        .map((message) => this.publicMessage(message));
      this.requests.push({ method, path });
      return json(response, 200, result);
    }

    const parts = path.split("/").filter(Boolean);
    if (parts[0] !== "fmsg") return json(response, 404, { error: "not found" });

    if (method === "POST" && parts.length === 1) {
      const rawBody = (await requestBody(request)).toString("utf8");
      const wireBody = JSON.parse(rawBody) as Record<string, unknown>;
      const body = parseFmsgJson<FmsgMessage & { data: string }>(rawBody);
      this.requests.push({ method, path, body: wireBody, rawBody });
      if (body.pid !== undefined) {
        if (typeof wireBody.pid !== "number" || !Number.isInteger(wireBody.pid)) {
          return json(response, 400, {
            error: "json: cannot unmarshal string into Go struct field messageInput.Message.pid of type int64",
          });
        }
        try {
          body.pid = normalizeFmsgMessageId(body.pid, "pid");
        } catch (error) {
          return json(response, 400, { error: (error as Error).message });
        }
      }
      if (body.from !== subject) return json(response, 403, { error: "from does not match JWT" });
      const id = String(this.nextId++);
      this.messages.set(id, {
        ...body,
        id,
        data: body.data,
        short_text: body.data.slice(0, 20),
        sent: false,
      });
      return json(response, 201, { id: Number(id) });
    }

    const id = parts[1] ?? "";
    const message = this.messages.get(id);
    if (!message || message.deleted) return json(response, 404, { error: "message not found" });

    if (method === "GET" && parts.length === 2) {
      this.requests.push({ method, path });
      return json(response, 200, this.publicMessage(message));
    }
    if (method === "GET" && parts[2] === "data") {
      this.requests.push({ method, path });
      response.writeHead(200, { "content-type": message.type ?? "text/plain" });
      response.end(message.data);
      return;
    }
    if (method === "GET" && parts[2] === "attach" && parts[3]) {
      this.requests.push({ method, path });
      const data = this.attachmentData.get(`${id}/${decodeURIComponent(parts[3])}`);
      if (!data) return json(response, 404, { error: "attachment not found" });
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(data.byteLength),
      });
      response.end(data);
      return;
    }
    if (method === "POST" && parts[2] === "attach") {
      const body = await requestBody(request);
      this.requests.push({ method, path, body: { bytes: body.byteLength } });
      return json(response, 200, { filename: "upload.bin", size: body.byteLength });
    }
    if (method === "POST" && parts[2] === "send") {
      this.requests.push({ method, path });
      message.sent = true;
      message.time = Date.now();
      this.pushNewMessage(this.publicMessage(message));
      return json(response, 200, { id: Number(id), time: message.time });
    }
    if (method === "POST" && parts[2] === "read") {
      this.requests.push({ method, path });
      const set = this.readBy.get(id) ?? new Set<string>();
      set.add(subject);
      this.readBy.set(id, set);
      return json(response, 200, { id: Number(id), time_read: Date.now() });
    }
    if (method === "DELETE" && parts.length === 2) {
      this.requests.push({ method, path });
      message.deleted = true;
      response.writeHead(204);
      response.end();
      return;
    }
    return json(response, 404, { error: "not found" });
  }
}

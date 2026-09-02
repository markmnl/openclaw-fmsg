import WebSocket from "ws";
import { normalizeFmsgAddress } from "./config.js";
import { normalizeFmsgMessageId, parseFmsgJson, stringifyWithFmsgInt64, } from "./message-id.js";
import { formatSafeError, redactSecrets } from "./redact.js";
export function normalizeFmsgMessage(value) {
    if (!value || typeof value !== "object")
        throw new Error("fmsg returned an invalid message");
    const raw = value;
    if ((typeof raw.id !== "string" && typeof raw.id !== "number") || typeof raw.from !== "string") {
        throw new Error("fmsg returned a message without id/from");
    }
    if (!Array.isArray(raw.to) || !raw.to.every((entry) => typeof entry === "string")) {
        throw new Error("fmsg returned a message without recipients");
    }
    const reactions = Array.isArray(raw.reactions)
        ? raw.reactions.flatMap((entry) => {
            if (!entry || typeof entry !== "object")
                return [];
            const group = entry;
            if (typeof group.emoji !== "string" || !Array.isArray(group.from))
                return [];
            const from = group.from
                .map((address) => typeof address === "string" ? normalizeFmsgAddress(address) : undefined)
                .filter((address) => Boolean(address));
            return from.length > 0 ? [{ emoji: group.emoji, from }] : [];
        })
        : [];
    return {
        ...raw,
        id: normalizeFmsgMessageId(raw.id),
        ...(raw.pid !== undefined && raw.pid !== null
            ? { pid: normalizeFmsgMessageId(raw.pid, "pid") }
            : {}),
        from: raw.from,
        to: raw.to,
        terminal: raw.terminal === true,
        reaction: typeof raw.reaction === "string" ? raw.reaction : null,
        reactions,
    };
}
export class FmsgHttpError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = "FmsgHttpError";
    }
}
function decodeJwtPayload(token) {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1])
        throw new Error("fmsg token exchange returned an invalid JWT");
    try {
        return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    }
    catch {
        throw new Error("fmsg token exchange returned an unreadable JWT payload");
    }
}
async function readError(response) {
    const raw = await response.text().catch(() => "");
    if (!raw)
        return `HTTP ${response.status}`;
    try {
        const parsed = JSON.parse(raw);
        return String(parsed.error ?? parsed.message ?? `HTTP ${response.status}`);
    }
    catch {
        return raw.slice(0, 300);
    }
}
export class FmsgClient {
    apiKey;
    options;
    apiUrl;
    token;
    tokenPromise;
    constructor(apiUrl, apiKey, options = {}) {
        this.apiKey = apiKey;
        this.options = options;
        this.apiUrl = apiUrl.replace(/\/+$/u, "");
        if (!this.apiUrl)
            throw new Error("fmsg apiUrl is required");
        if (!apiKey.startsWith("fmsgk_"))
            throw new Error("FMSG_API_KEY must start with fmsgk_");
    }
    get fetchImpl() {
        return this.options.fetch ?? fetch;
    }
    async getToken(force = false) {
        const margin = this.options.refreshMarginMs ?? 300_000;
        if (!force && this.token && this.token.expiresAtMs - margin > Date.now())
            return this.token;
        if (!force && this.tokenPromise)
            return this.tokenPromise;
        this.tokenPromise = this.exchangeToken();
        try {
            this.token = await this.tokenPromise;
            return this.token;
        }
        finally {
            this.tokenPromise = undefined;
        }
    }
    async exchangeToken() {
        const response = await this.fetchImpl(`${this.apiUrl}/fmsg/token`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.apiKey}` },
        });
        if (!response.ok) {
            const detail = redactSecrets(await readError(response));
            throw new FmsgHttpError(`fmsg token exchange failed: ${detail}`, response.status);
        }
        const body = (await response.json());
        if (typeof body.access_token !== "string")
            throw new Error("fmsg token response has no access_token");
        const payload = decodeJwtPayload(body.access_token);
        const sender = typeof payload.sub === "string" ? normalizeFmsgAddress(payload.sub) : undefined;
        if (!sender)
            throw new Error("fmsg JWT sub is not a valid fmsg address");
        const expiresAtFromResponse = typeof body.expires_at === "number"
            ? body.expires_at * (body.expires_at < 10_000_000_000 ? 1000 : 1)
            : Date.parse(String(body.expires_at ?? ""));
        const expiresAtFromJwt = typeof payload.exp === "number" ? payload.exp * 1000 : Number.NaN;
        const expiresIn = typeof body.expires_in === "number" ? body.expires_in * 1000 : Number.NaN;
        const expiresAtMs = Number.isFinite(expiresAtFromResponse)
            ? expiresAtFromResponse
            : Number.isFinite(expiresAtFromJwt)
                ? expiresAtFromJwt
                : Number.isFinite(expiresIn)
                    ? Date.now() + expiresIn
                    : Date.now() + 3_600_000;
        return { accessToken: body.access_token, sender, expiresAtMs };
    }
    async request(path, init = {}, retry401 = true) {
        const token = await this.getToken();
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${token.accessToken}`);
        const response = await this.fetchImpl(`${this.apiUrl}${path}`, { ...init, headers });
        if (response.status === 401 && retry401) {
            await this.getToken(true);
            return this.request(path, init, false);
        }
        if (!response.ok) {
            const detail = redactSecrets(await readError(response));
            throw new FmsgHttpError(`fmsg ${init.method ?? "GET"} ${path} failed: ${detail}`, response.status);
        }
        return response;
    }
    async listInbox(limit = 100, offset = 0, signal) {
        const response = await this.request(`/fmsg?limit=${limit}&offset=${offset}`, { signal });
        const body = parseFmsgJson(await response.text());
        if (!Array.isArray(body))
            throw new Error("fmsg inbox response is not an array");
        return body.map(normalizeFmsgMessage);
    }
    async listSent(limit = 50, offset = 0, signal) {
        const response = await this.request(`/fmsg/sent?limit=${limit}&offset=${offset}`, { signal });
        const body = parseFmsgJson(await response.text());
        if (!Array.isArray(body))
            throw new Error("fmsg sent response is not an array");
        return body.map(normalizeFmsgMessage);
    }
    async getMessage(id, signal) {
        const response = await this.request(`/fmsg/${encodeURIComponent(id)}`, { signal });
        return normalizeFmsgMessage(parseFmsgJson(await response.text()));
    }
    async reactToMessage(id, emoji, signal) {
        const messageId = normalizeFmsgMessageId(id);
        const response = await this.request(`/fmsg/${encodeURIComponent(messageId)}/react`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ emoji }),
            signal,
        });
        const result = parseFmsgJson(await response.text());
        return {
            id: result.id === undefined || result.id === null
                ? null
                : normalizeFmsgMessageId(result.id),
            time: result.time ?? null,
        };
    }
    async getMessageData(id, signal) {
        const response = await this.request(`/fmsg/${encodeURIComponent(id)}/data`, { signal });
        return response.text();
    }
    async getMessageText(message, signal) {
        if (typeof message.data === "string")
            return message.data;
        const short = message.short_text ?? "";
        if (message.size === undefined || Buffer.byteLength(short, "utf8") >= message.size)
            return short;
        return this.getMessageData(message.id, signal);
    }
    async markRead(id, signal) {
        await this.request(`/fmsg/${encodeURIComponent(id)}/read`, { method: "POST", signal });
    }
    async downloadAttachment(messageId, filename, maxBytes, signal) {
        const response = await this.request(`/fmsg/${encodeURIComponent(messageId)}/attach/${encodeURIComponent(filename)}`, { signal });
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes)
            throw new Error(`attachment ${filename} exceeds ${maxBytes} bytes`);
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.byteLength > maxBytes)
            throw new Error(`attachment ${filename} exceeds ${maxBytes} bytes`);
        const contentType = response.headers.get("content-type") ?? undefined;
        return { data, ...(contentType ? { contentType } : {}) };
    }
    async createDraft(input, sender) {
        const text = redactSecrets(input.text);
        const body = {
            version: 1,
            from: sender,
            to: input.to,
            type: "text/plain; charset=utf-8",
            size: Buffer.byteLength(text, "utf8"),
            data: text,
            ...(input.pid ? {} : { topic: input.topic ?? "" }),
            ...(input.important ? { important: true } : {}),
            ...(input.noReply ? { no_reply: true } : {}),
        };
        const response = await this.request("/fmsg", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: input.pid ? stringifyWithFmsgInt64(body, "pid", input.pid) : JSON.stringify(body),
            signal: input.signal,
        });
        const result = parseFmsgJson(await response.text());
        if (result.id === undefined || result.id === null) {
            throw new Error("fmsg draft response has no id");
        }
        return normalizeFmsgMessageId(result.id);
    }
    async uploadAttachment(draftId, attachment, signal) {
        const form = new FormData();
        const blob = new Blob([Buffer.from(attachment.data)], {
            type: attachment.contentType ?? "application/octet-stream",
        });
        form.append("file", blob, attachment.filename);
        await this.request(`/fmsg/${encodeURIComponent(draftId)}/attach`, {
            method: "POST",
            body: form,
            signal,
        });
    }
    async sendMessage(input) {
        if ((input.pid ? 1 : 0) + (input.topic !== undefined ? 1 : 0) !== 1) {
            throw new Error("fmsg send requires exactly one of pid or topic");
        }
        const token = await this.getToken();
        const to = [...new Set(input.to.map(normalizeFmsgAddress).filter((value) => Boolean(value)))];
        if (to.length === 0 || to.length !== input.to.length)
            throw new Error("fmsg send has an invalid recipient");
        const draftId = await this.createDraft({ ...input, to }, token.sender);
        try {
            for (const attachment of input.attachments ?? []) {
                await this.uploadAttachment(draftId, attachment, input.signal);
            }
            const response = await this.request(`/fmsg/${encodeURIComponent(draftId)}/send`, {
                method: "POST",
                signal: input.signal,
            });
            const result = parseFmsgJson(await response.text());
            return {
                id: result.id === undefined || result.id === null
                    ? draftId
                    : normalizeFmsgMessageId(result.id),
                ...(result.time !== undefined ? { time: result.time } : {}),
            };
        }
        catch (error) {
            await this.request(`/fmsg/${encodeURIComponent(draftId)}`, { method: "DELETE" }).catch((cleanupError) => {
                this.options.log?.warn?.(`fmsg draft cleanup failed: ${formatSafeError(cleanupError)}`);
            });
            throw error;
        }
    }
    async openWebSocket() {
        const token = await this.getToken();
        const url = new URL(this.apiUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = `${url.pathname.replace(/\/+$/u, "")}/fmsg/ws`;
        url.search = "";
        const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token.accessToken}` } });
        return { socket, token };
    }
    static parseWsEvent(raw) {
        try {
            const parsed = parseFmsgJson(raw.toString());
            return parsed && typeof parsed.type === "string" ? parsed : undefined;
        }
        catch {
            return undefined;
        }
    }
}

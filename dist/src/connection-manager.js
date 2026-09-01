import WebSocket from "ws";
import { normalizeFmsgMessage } from "./client.js";
import { formatSafeError } from "./redact.js";
import { compareMessageIds } from "./state.js";
function waitForOpen(socket, signal) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            socket.off("open", onOpen);
            socket.off("error", onError);
            signal.removeEventListener("abort", onAbort);
        };
        const onOpen = () => {
            cleanup();
            resolve();
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const onAbort = () => {
            cleanup();
            socket.close();
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        socket.once("open", onOpen);
        socket.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
function waitForClose(socket, signal, rotateAfterMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => socket.close(1000, "token rotation"), Math.max(1000, rotateAfterMs));
        timer.unref?.();
        const cleanup = () => {
            clearTimeout(timer);
            socket.off("close", onClose);
            signal.removeEventListener("abort", onAbort);
        };
        const onClose = () => {
            cleanup();
            resolve();
        };
        const onAbort = () => {
            cleanup();
            socket.close();
            resolve();
        };
        socket.once("close", onClose);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
function waitBackoff(ms, signal) {
    return new Promise((resolve) => {
        if (signal.aborted)
            return resolve();
        const timer = setTimeout(done, ms);
        const onAbort = () => done();
        function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            resolve();
        }
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
async function catchUp(options, enqueue) {
    const collected = [];
    let offset = 0;
    const pageSize = 100;
    while (!options.signal.aborted && collected.length < 1000) {
        const page = await options.client.listInbox(pageSize, offset, options.signal);
        collected.push(...page);
        if (page.length < pageSize || page.some((message) => options.state.hasProcessed(message.id)))
            break;
        offset += page.length;
    }
    const selected = options.state.highWaterId
        ? collected.filter((message) => !options.state.hasProcessed(message.id))
        : collected.filter((message) => !message.read).slice(0, 50);
    selected.sort((left, right) => compareMessageIds(left.id, right.id));
    for (const message of selected)
        await enqueue(message);
}
export async function runFmsgConnection(options) {
    const random = options.random ?? Math.random;
    let attempt = 0;
    while (!options.signal.aborted) {
        let socket;
        const connectedAt = Date.now();
        try {
            const opened = await options.client.openWebSocket();
            socket = opened.socket;
            let queue = Promise.resolve();
            const enqueue = (message) => {
                // Keep later messages flowing even when one delivery fails. The caller
                // still receives the individual rejection for logging/retry handling.
                const delivery = queue.catch(() => undefined).then(async () => {
                    if (options.state.hasProcessed(message.id))
                        return;
                    await options.onMessage(message);
                });
                queue = delivery;
                return delivery;
            };
            socket.on("message", (raw) => {
                const event = FmsgClientEvent(raw);
                if (event?.type === "new_msg" && isMessage(event.data)) {
                    void enqueue(normalizeFmsgMessage(event.data)).catch((error) => options.log?.error?.(`fmsg inbound failed: ${formatSafeError(error)}`));
                }
            });
            socket.on("error", (error) => options.log?.warn?.(`fmsg websocket error: ${formatSafeError(error)}`));
            await waitForOpen(socket, options.signal);
            options.log?.info?.("fmsg connected");
            options.onReady?.();
            await catchUp(options, enqueue);
            const tokenTtlMs = Math.max(1000, opened.token.expiresAtMs - Date.now());
            const refreshMarginMs = Math.min(300_000, Math.floor(tokenTtlMs / 2));
            await waitForClose(socket, options.signal, tokenTtlMs - refreshMarginMs);
            await queue;
            if (Date.now() - connectedAt >= 60_000)
                attempt = 0;
        }
        catch (error) {
            if (options.signal.aborted)
                break;
            options.log?.warn?.(`fmsg connection failed: ${formatSafeError(error)}`);
        }
        finally {
            if (socket && socket.readyState === WebSocket.OPEN)
                socket.close();
        }
        if (options.signal.aborted)
            break;
        const ceiling = Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 6));
        await waitBackoff(Math.max(250, Math.floor(random() * ceiling)), options.signal);
    }
}
function FmsgClientEvent(raw) {
    try {
        return JSON.parse(raw.toString());
    }
    catch {
        return undefined;
    }
}
function isMessage(value) {
    if (!value || typeof value !== "object")
        return false;
    const message = value;
    return (typeof message.id === "string" || typeof message.id === "number") && typeof message.from === "string" && Array.isArray(message.to);
}

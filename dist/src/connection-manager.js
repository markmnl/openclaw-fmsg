import WebSocket from "ws";
import { FmsgClient, normalizeFmsgMessage } from "./client.js";
import { formatSafeError } from "./redact.js";
import { compareMessageIds } from "./state.js";
function waitForOpen(socket, signal) {
    if (signal.aborted) {
        socket.close();
        return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
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
    if (signal.aborted) {
        socket.close();
        return Promise.resolve();
    }
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
function closeAndWait(socket) {
    if (socket.readyState === WebSocket.CLOSED)
        return Promise.resolve();
    return new Promise((resolve) => {
        const forceTimer = setTimeout(() => socket.terminate(), 1000);
        forceTimer.unref?.();
        const done = () => {
            clearTimeout(forceTimer);
            socket.off("close", done);
            resolve();
        };
        socket.once("close", done);
        if (socket.readyState === WebSocket.CLOSED)
            return done();
        if (socket.readyState !== WebSocket.CLOSING)
            socket.close();
    });
}
async function catchUp(options, enqueue, enqueueReaction) {
    const highWaterIdBeforeCatchUp = options.state.highWaterId;
    const collected = new Map();
    for (const id of options.state.pendingInboundIds) {
        if (options.signal.aborted || options.state.hasProcessed(id))
            continue;
        try {
            const pending = await options.client.getMessage(id, options.signal);
            collected.set(pending.id, pending);
        }
        catch (error) {
            options.log?.warn?.(`fmsg pending inbox recovery failed for ${id}: ${formatSafeError(error)}`);
        }
    }
    let offset = 0;
    const pageSize = 100;
    while (!options.signal.aborted && offset < 1000) {
        const page = await options.client.listInbox(pageSize, offset, options.signal);
        for (const message of page)
            collected.set(message.id, message);
        if (page.length < pageSize)
            break;
        offset += page.length;
    }
    const reactionSubjects = new Map(collected);
    for (const message of collected.values()) {
        if (message.reaction === null || message.reaction === undefined)
            continue;
        if (message.pid) {
            try {
                const subject = await options.client.getMessage(message.pid, options.signal);
                reactionSubjects.set(subject.id, subject);
            }
            catch (error) {
                options.log?.warn?.(`fmsg reaction subject ${message.pid} recovery failed: ${formatSafeError(error)}`);
            }
        }
        await options.state.markProcessed(message.id);
        await options.client.markRead(message.id, options.signal).catch((error) => options.log?.warn?.(`fmsg reaction mark-read failed for ${message.id}: ${formatSafeError(error)}`));
    }
    if (options.onReaction) {
        offset = 0;
        while (!options.signal.aborted && offset < 1000) {
            const page = await options.client.listSent(pageSize, offset, options.signal);
            for (const message of page) {
                reactionSubjects.set(message.id, message);
                if (message.reaction !== null && message.reaction !== undefined && message.pid) {
                    try {
                        const subject = await options.client.getMessage(message.pid, options.signal);
                        reactionSubjects.set(subject.id, subject);
                    }
                    catch (error) {
                        options.log?.warn?.(`fmsg sent reaction subject ${message.pid} recovery failed: ${formatSafeError(error)}`);
                    }
                }
            }
            if (page.length < pageSize)
                break;
            offset += page.length;
        }
    }
    let reactionUpdates = 0;
    for (const message of reactionSubjects.values()) {
        if (options.signal.aborted)
            break;
        if ((message.reactions?.length ?? 0) === 0 && !options.state.hasReactionSnapshot(message.id))
            continue;
        await enqueueReaction(message, "catch-up");
        reactionUpdates++;
    }
    const messages = [...collected.values()];
    const selected = highWaterIdBeforeCatchUp
        ? messages.filter((message) => message.reaction == null && !options.state.hasProcessed(message.id))
        : messages.filter((message) => message.reaction == null && !message.read).slice(0, 50);
    selected.sort((left, right) => compareMessageIds(left.id, right.id));
    let delivered = 0;
    let firstDeliveryError;
    for (const message of selected) {
        if (options.signal.aborted)
            break;
        try {
            await enqueue(message);
            delivered++;
        }
        catch (error) {
            firstDeliveryError ??= error;
            options.log?.warn?.(`fmsg inbox delivery failed for ${message.id}: ${formatSafeError(error)}`);
        }
    }
    if (firstDeliveryError)
        throw firstDeliveryError;
    return { delivered, reactions: reactionUpdates };
}
export async function runFmsgConnection(options) {
    const random = options.random ?? Math.random;
    let attempt = 0;
    while (!options.signal.aborted) {
        let socket;
        let queue = Promise.resolve();
        let catchUpComplete = false;
        const bufferedLiveEvents = [];
        const connectedAt = Date.now();
        try {
            options.onReconnectAttempt?.(attempt);
            const opened = await options.client.openWebSocket();
            socket = opened.socket;
            const enqueueTask = (task) => {
                // Keep later messages flowing even when one delivery fails. The caller
                // still receives the individual rejection for logging/retry handling.
                const delivery = queue.catch(() => undefined).then(task);
                queue = delivery;
                return delivery;
            };
            const enqueue = (message) => enqueueTask(async () => {
                if (options.state.hasProcessed(message.id))
                    return;
                await options.onMessage(message);
            });
            const enqueueReaction = (message, source) => enqueueTask(async () => {
                await options.onReaction?.(message, source);
            });
            const enqueueLive = (task, label) => {
                if (!catchUpComplete) {
                    bufferedLiveEvents.push(task);
                    return;
                }
                void enqueueTask(task).catch((error) => options.log?.error?.(`fmsg ${label} failed: ${formatSafeError(error)}`));
            };
            socket.on("message", (raw) => {
                const event = FmsgClientEvent(raw);
                if (event?.type === "new_msg" && isMessage(event.data)) {
                    const message = normalizeFmsgMessage(event.data);
                    enqueueLive(async () => {
                        if (options.state.hasProcessed(message.id))
                            return;
                        await options.onMessage(message);
                    }, "inbound");
                }
                else if (event?.type === "reaction" && isMessage(event.data)) {
                    const message = normalizeFmsgMessage(event.data);
                    enqueueLive(async () => {
                        await options.onReaction?.(message, "websocket");
                    }, "reaction update");
                }
            });
            socket.on("error", (error) => options.log?.warn?.(`fmsg websocket error: ${formatSafeError(error)}`));
            await waitForOpen(socket, options.signal);
            options.log?.info?.(`fmsg connected as ${opened.token.sender}`);
            options.onReady?.(opened.token);
            const caughtUp = await catchUp(options, enqueue, enqueueReaction);
            catchUpComplete = true;
            for (const event of bufferedLiveEvents.splice(0)) {
                void enqueueTask(event).catch((error) => options.log?.error?.(`fmsg buffered event failed: ${formatSafeError(error)}`));
            }
            options.log?.info?.(`fmsg inbox catch-up complete (${caughtUp.delivered} message${caughtUp.delivered === 1 ? "" : "s"}, ` +
                `${caughtUp.reactions} reaction subject${caughtUp.reactions === 1 ? "" : "s"})`);
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
            if (socket)
                await closeAndWait(socket);
            await queue.catch(() => undefined);
        }
        if (options.signal.aborted)
            break;
        const ceiling = Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 6));
        await waitBackoff(Math.max(250, Math.floor(random() * ceiling)), options.signal);
    }
}
function FmsgClientEvent(raw) {
    return FmsgClient.parseWsEvent(raw);
}
function isMessage(value) {
    if (!value || typeof value !== "object")
        return false;
    const message = value;
    return (typeof message.id === "string" || typeof message.id === "number") && typeof message.from === "string" && Array.isArray(message.to);
}

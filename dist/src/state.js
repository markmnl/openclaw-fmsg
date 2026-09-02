import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { compareFmsgMessageIds } from "./message-id.js";
import { participantsFromMessage } from "./threading.js";
const EMPTY_STATE = {
    version: 1,
    messages: {},
    children: {},
    processed: [],
    pendingInbound: [],
    lastInboundByBranch: {},
    lastOutboundByBranch: {},
    turnTimestampsByBranch: {},
    turnTimestampsByRoot: {},
    turnTimestampsBySender: {},
    lastDirectByAddress: {},
    reactionSnapshots: {},
};
function cloneEmptyState() {
    return JSON.parse(JSON.stringify(EMPTY_STATE));
}
export class FmsgStateStore {
    filePath;
    state = cloneEmptyState();
    loaded = false;
    writeQueue = Promise.resolve();
    constructor(filePath) {
        this.filePath = filePath;
    }
    async load() {
        if (this.loaded)
            return;
        try {
            const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
            if (parsed.version === 1) {
                this.state = {
                    ...cloneEmptyState(),
                    ...parsed,
                    messages: parsed.messages ?? {},
                    children: parsed.children ?? {},
                    processed: parsed.processed ?? [],
                    pendingInbound: parsed.pendingInbound ?? [],
                    lastInboundByBranch: parsed.lastInboundByBranch ?? {},
                    lastOutboundByBranch: parsed.lastOutboundByBranch ?? {},
                    turnTimestampsByBranch: parsed.turnTimestampsByBranch ?? {},
                    turnTimestampsByRoot: parsed.turnTimestampsByRoot ?? {},
                    turnTimestampsBySender: parsed.turnTimestampsBySender ?? {},
                    lastDirectByAddress: parsed.lastDirectByAddress ?? {},
                    reactionSnapshots: parsed.reactionSnapshots ?? {},
                };
            }
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        this.loaded = true;
    }
    async persistNow() {
        await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        const temporary = `${this.filePath}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
        await rename(temporary, this.filePath);
    }
    persist() {
        this.writeQueue = this.writeQueue.then(() => this.persistNow());
        return this.writeQueue;
    }
    hasProcessed(messageId) {
        return this.state.processed.includes(messageId);
    }
    async markProcessed(messageId) {
        if (!this.state.processed.includes(messageId))
            this.state.processed.push(messageId);
        this.state.pendingInbound = this.state.pendingInbound.filter((id) => id !== messageId);
        if (this.state.processed.length > 5000)
            this.state.processed.splice(0, this.state.processed.length - 5000);
        if (!this.state.highWaterId || compareMessageIds(messageId, this.state.highWaterId) > 0) {
            this.state.highWaterId = messageId;
        }
        await this.persist();
    }
    get highWaterId() {
        return this.state.highWaterId;
    }
    get pendingInboundIds() {
        return [...this.state.pendingInbound];
    }
    getMessage(id) {
        return this.state.messages[id];
    }
    hasReactionSnapshot(messageId) {
        return this.state.reactionSnapshots[messageId] !== undefined;
    }
    getReactionSnapshot(messageId) {
        const snapshot = this.state.reactionSnapshots[messageId];
        return snapshot ? { ...snapshot.bySender } : undefined;
    }
    async recordReactionSnapshot(message, options = {}) {
        const current = {};
        for (const group of message.reactions ?? []) {
            if (!group.emoji)
                continue;
            for (const raw of group.from) {
                const sender = raw.toLowerCase();
                current[sender] = group.emoji;
            }
        }
        const previous = this.state.reactionSnapshots[message.id];
        const changes = [];
        if (previous || !options.seedIfMissing) {
            for (const sender of new Set([
                ...Object.keys(previous?.bySender ?? {}),
                ...Object.keys(current),
            ])) {
                const before = previous?.bySender[sender];
                const after = current[sender];
                if (before === after)
                    continue;
                changes.push({
                    from: sender,
                    ...(before !== undefined ? { previous: before } : {}),
                    ...(after !== undefined ? { emoji: after } : {}),
                });
            }
        }
        const generation = previous
            ? previous.generation + (changes.length > 0 ? 1 : 0)
            : 1;
        this.state.reactionSnapshots[message.id] = {
            bySender: current,
            generation,
            updatedAt: options.now ?? Date.now(),
        };
        this.pruneReactionSnapshots();
        await this.persist();
        return { initialized: previous !== undefined, generation, changes };
    }
    getLastInbound(branchId) {
        return this.state.lastInboundByBranch[branchId];
    }
    getLastOutbound(branchId) {
        return this.state.lastOutboundByBranch[branchId];
    }
    getLastDirect(address) {
        return this.state.lastDirectByAddress[address];
    }
    async rememberDirect(address, messageId) {
        this.state.lastDirectByAddress[address.toLowerCase()] = messageId;
        await this.persist();
    }
    assignMessage(message, options = {}) {
        const existing = this.state.messages[message.id];
        if (existing) {
            existing.from = message.from.toLowerCase();
            existing.to = message.to.map((address) => address.toLowerCase());
            const participants = participantsFromMessage(message);
            existing.addTo = participants.filter((address) => address !== existing.from && !existing.to.includes(address));
            if (message.time !== undefined)
                existing.time = message.time;
            if (message.topic !== undefined)
                existing.topic = message.topic;
            existing.important = message.important === true || undefined;
            existing.noReply = message.no_reply === true || undefined;
            existing.terminal = message.terminal === true || undefined;
            if (options.inbound) {
                if (!this.state.pendingInbound.includes(message.id))
                    this.state.pendingInbound.push(message.id);
                this.state.lastInboundByBranch[existing.branchId] = message.id;
                delete this.state.lastOutboundByBranch[existing.branchId];
            }
            return {
                rootId: existing.rootId,
                branchId: existing.branchId,
                isFork: Boolean(existing.pid && this.state.messages[existing.pid]?.branchId !== existing.branchId),
            };
        }
        const pid = message.pid || undefined;
        const parent = pid ? this.state.messages[pid] : undefined;
        const rootId = options.rootId ?? parent?.rootId ?? (pid || message.id);
        let branchId = options.branchId;
        let isFork = false;
        if (!branchId) {
            if (!pid) {
                branchId = message.id;
            }
            else {
                const siblings = this.state.children[pid] ?? [];
                if (siblings.length === 0) {
                    branchId = parent?.branchId ?? rootId;
                }
                else {
                    branchId = `${rootId}:br:${message.id}`;
                    isFork = true;
                }
            }
        }
        else if (pid && parent && branchId !== parent.branchId) {
            isFork = true;
        }
        if (pid) {
            const children = (this.state.children[pid] ??= []);
            if (!children.includes(message.id))
                children.push(message.id);
        }
        const participants = participantsFromMessage(message);
        const from = message.from.toLowerCase();
        this.state.messages[message.id] = {
            id: message.id,
            ...(pid ? { pid } : {}),
            rootId,
            branchId,
            from,
            to: message.to.map((address) => address.toLowerCase()),
            addTo: participants.filter((address) => address !== from && !message.to.map((entry) => entry.toLowerCase()).includes(address)),
            ...(message.time !== undefined ? { time: message.time } : {}),
            ...(message.topic ? { topic: message.topic } : {}),
            ...(message.important ? { important: true } : {}),
            ...(message.no_reply ? { noReply: true } : {}),
            ...(message.terminal ? { terminal: true } : {}),
        };
        if (options.inbound) {
            if (!this.state.pendingInbound.includes(message.id))
                this.state.pendingInbound.push(message.id);
            this.state.lastInboundByBranch[branchId] = message.id;
            delete this.state.lastOutboundByBranch[branchId];
        }
        this.pruneMessages();
        return { rootId, branchId, isFork };
    }
    async recordOutbound(params) {
        const assignment = this.assignMessage({
            id: params.id,
            from: params.from,
            to: params.to,
            ...(params.pid ? { pid: params.pid, has_pid: true } : {}),
            ...(params.topic ? { topic: params.topic } : {}),
            ...(params.noReply ? { no_reply: true } : {}),
        }, { branchId: params.branchId, rootId: params.rootId });
        this.state.lastOutboundByBranch[assignment.branchId] = params.id;
        if (params.to.length === 1)
            this.state.lastDirectByAddress[params.to[0].toLowerCase()] = params.id;
        await this.persist();
        return assignment;
    }
    inspectTimestamps(timestampsByKey, key, maxTurns, windowMs, now) {
        if (maxTurns === 0)
            return { suppressed: false, lastAllowed: false, count: 0 };
        const timestamps = (timestampsByKey[key] ?? []).filter((timestamp) => timestamp > now - windowMs && timestamp <= now);
        timestampsByKey[key] = timestamps;
        return {
            suppressed: timestamps.length >= maxTurns,
            lastAllowed: timestamps.length === maxTurns - 1,
            count: timestamps.length,
        };
    }
    inspectTurnWindow(branchId, maxTurns, windowMs, now = Date.now()) {
        return this.inspectTimestamps(this.state.turnTimestampsByBranch, branchId, maxTurns, windowMs, now);
    }
    inspectRootTurnWindow(rootId, maxTurns, windowMs, now = Date.now()) {
        return this.inspectTimestamps(this.state.turnTimestampsByRoot, rootId, maxTurns, windowMs, now);
    }
    inspectSenderTurnWindow(sender, maxTurns, windowMs, now = Date.now()) {
        return this.inspectTimestamps(this.state.turnTimestampsBySender, sender.toLowerCase(), maxTurns, windowMs, now);
    }
    recordTimestamp(timestampsByKey, key, windowMs, now) {
        const timestamps = (timestampsByKey[key] ?? []).filter((timestamp) => timestamp > now - windowMs && timestamp <= now);
        timestamps.push(now);
        timestampsByKey[key] = timestamps;
    }
    async recordAutomaticTurn(params) {
        const now = params.now ?? Date.now();
        this.recordTimestamp(this.state.turnTimestampsByBranch, params.branchId, params.windowMs, now);
        this.recordTimestamp(this.state.turnTimestampsByRoot, params.rootId, params.windowMs, now);
        this.recordTimestamp(this.state.turnTimestampsBySender, params.sender.toLowerCase(), params.windowMs, now);
        await this.persist();
    }
    pruneMessages() {
        const entries = Object.values(this.state.messages);
        if (entries.length <= 1000)
            return;
        entries.sort((left, right) => compareMessageIds(left.id, right.id));
        const remove = new Set(entries.slice(0, entries.length - 1000).map((entry) => entry.id));
        for (const id of remove)
            delete this.state.messages[id];
        for (const id of remove)
            delete this.state.reactionSnapshots[id];
        for (const [parent, children] of Object.entries(this.state.children)) {
            const kept = children.filter((id) => !remove.has(id));
            if (kept.length === 0 && remove.has(parent))
                delete this.state.children[parent];
            else
                this.state.children[parent] = kept;
        }
    }
    pruneReactionSnapshots() {
        const entries = Object.entries(this.state.reactionSnapshots);
        if (entries.length <= 2000)
            return;
        entries.sort((left, right) => left[1].updatedAt - right[1].updatedAt);
        for (const [messageId] of entries.slice(0, entries.length - 2000)) {
            delete this.state.reactionSnapshots[messageId];
        }
    }
}
export function compareMessageIds(left, right) {
    return compareFmsgMessageIds(left, right);
}

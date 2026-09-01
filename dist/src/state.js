import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { participantsFromMessage } from "./threading.js";
const EMPTY_STATE = {
    version: 1,
    messages: {},
    children: {},
    processed: [],
    lastInboundByBranch: {},
    lastOutboundByBranch: {},
    turnTimestampsByBranch: {},
    lastDirectByAddress: {},
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
                    lastInboundByBranch: parsed.lastInboundByBranch ?? {},
                    lastOutboundByBranch: parsed.lastOutboundByBranch ?? {},
                    turnTimestampsByBranch: parsed.turnTimestampsByBranch ?? {},
                    lastDirectByAddress: parsed.lastDirectByAddress ?? {},
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
    getMessage(id) {
        return this.state.messages[id];
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
            if (options.inbound) {
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
        };
        if (options.inbound) {
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
    inspectTurnWindow(branchId, maxTurns, windowMs, now = Date.now()) {
        if (maxTurns === 0)
            return { suppressed: false, lastAllowed: false, count: 0 };
        const timestamps = (this.state.turnTimestampsByBranch[branchId] ?? []).filter((timestamp) => timestamp > now - windowMs && timestamp <= now);
        this.state.turnTimestampsByBranch[branchId] = timestamps;
        return {
            suppressed: timestamps.length >= maxTurns,
            lastAllowed: timestamps.length === maxTurns - 1,
            count: timestamps.length,
        };
    }
    async recordAutomaticTurn(branchId, windowMs, now = Date.now()) {
        const timestamps = (this.state.turnTimestampsByBranch[branchId] ?? []).filter((timestamp) => timestamp > now - windowMs && timestamp <= now);
        timestamps.push(now);
        this.state.turnTimestampsByBranch[branchId] = timestamps;
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
        for (const [parent, children] of Object.entries(this.state.children)) {
            const kept = children.filter((id) => !remove.has(id));
            if (kept.length === 0 && remove.has(parent))
                delete this.state.children[parent];
            else
                this.state.children[parent] = kept;
        }
    }
}
export function compareMessageIds(left, right) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber))
        return leftNumber - rightNumber;
    return left.localeCompare(right);
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FmsgMessage } from "./types.js";
import { participantsFromMessage, type StoredMessage, type ThreadAssignment } from "./threading.js";

type PersistedState = {
  version: 1;
  messages: Record<string, StoredMessage>;
  children: Record<string, string[]>;
  processed: string[];
  lastInboundByBranch: Record<string, string>;
  lastOutboundByBranch: Record<string, string>;
  turnTimestampsByBranch: Record<string, number[]>;
  lastDirectByAddress: Record<string, string>;
  highWaterId?: string;
};

const EMPTY_STATE: PersistedState = {
  version: 1,
  messages: {},
  children: {},
  processed: [],
  lastInboundByBranch: {},
  lastOutboundByBranch: {},
  turnTimestampsByBranch: {},
  lastDirectByAddress: {},
};

function cloneEmptyState(): PersistedState {
  return JSON.parse(JSON.stringify(EMPTY_STATE)) as PersistedState;
}

export class FmsgStateStore {
  private state: PersistedState = cloneEmptyState();
  private loaded = false;
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<PersistedState>;
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async persistNow(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.persistNow());
    return this.writeQueue;
  }

  hasProcessed(messageId: string): boolean {
    return this.state.processed.includes(messageId);
  }

  async markProcessed(messageId: string): Promise<void> {
    if (!this.state.processed.includes(messageId)) this.state.processed.push(messageId);
    if (this.state.processed.length > 5000) this.state.processed.splice(0, this.state.processed.length - 5000);
    if (!this.state.highWaterId || compareMessageIds(messageId, this.state.highWaterId) > 0) {
      this.state.highWaterId = messageId;
    }
    await this.persist();
  }

  get highWaterId(): string | undefined {
    return this.state.highWaterId;
  }

  getMessage(id: string): StoredMessage | undefined {
    return this.state.messages[id];
  }

  getLastInbound(branchId: string): string | undefined {
    return this.state.lastInboundByBranch[branchId];
  }

  getLastOutbound(branchId: string): string | undefined {
    return this.state.lastOutboundByBranch[branchId];
  }

  getLastDirect(address: string): string | undefined {
    return this.state.lastDirectByAddress[address];
  }

  async rememberDirect(address: string, messageId: string): Promise<void> {
    this.state.lastDirectByAddress[address.toLowerCase()] = messageId;
    await this.persist();
  }

  assignMessage(message: FmsgMessage, options: { inbound?: boolean; branchId?: string; rootId?: string } = {}): ThreadAssignment {
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
      } else {
        const siblings = this.state.children[pid] ?? [];
        if (siblings.length === 0) {
          branchId = parent?.branchId ?? rootId;
        } else {
          branchId = `${rootId}:br:${message.id}`;
          isFork = true;
        }
      }
    } else if (pid && parent && branchId !== parent.branchId) {
      isFork = true;
    }

    if (pid) {
      const children = (this.state.children[pid] ??= []);
      if (!children.includes(message.id)) children.push(message.id);
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

  async recordOutbound(params: {
    id: string;
    pid?: string;
    topic?: string;
    from: string;
    to: string[];
    branchId?: string;
    rootId?: string;
    noReply?: boolean;
  }): Promise<ThreadAssignment> {
    const assignment = this.assignMessage(
      {
        id: params.id,
        from: params.from,
        to: params.to,
        ...(params.pid ? { pid: params.pid, has_pid: true } : {}),
        ...(params.topic ? { topic: params.topic } : {}),
        ...(params.noReply ? { no_reply: true } : {}),
      },
      { branchId: params.branchId, rootId: params.rootId },
    );
    this.state.lastOutboundByBranch[assignment.branchId] = params.id;
    if (params.to.length === 1) this.state.lastDirectByAddress[params.to[0]!.toLowerCase()] = params.id;
    await this.persist();
    return assignment;
  }

  inspectTurnWindow(branchId: string, maxTurns: number, windowMs: number, now = Date.now()): {
    suppressed: boolean;
    lastAllowed: boolean;
    count: number;
  } {
    if (maxTurns === 0) return { suppressed: false, lastAllowed: false, count: 0 };
    const timestamps = (this.state.turnTimestampsByBranch[branchId] ?? []).filter(
      (timestamp) => timestamp > now - windowMs && timestamp <= now,
    );
    this.state.turnTimestampsByBranch[branchId] = timestamps;
    return {
      suppressed: timestamps.length >= maxTurns,
      lastAllowed: timestamps.length === maxTurns - 1,
      count: timestamps.length,
    };
  }

  async recordAutomaticTurn(branchId: string, windowMs: number, now = Date.now()): Promise<void> {
    const timestamps = (this.state.turnTimestampsByBranch[branchId] ?? []).filter(
      (timestamp) => timestamp > now - windowMs && timestamp <= now,
    );
    timestamps.push(now);
    this.state.turnTimestampsByBranch[branchId] = timestamps;
    await this.persist();
  }

  private pruneMessages(): void {
    const entries = Object.values(this.state.messages);
    if (entries.length <= 1000) return;
    entries.sort((left, right) => compareMessageIds(left.id, right.id));
    const remove = new Set(entries.slice(0, entries.length - 1000).map((entry) => entry.id));
    for (const id of remove) delete this.state.messages[id];
    for (const [parent, children] of Object.entries(this.state.children)) {
      const kept = children.filter((id) => !remove.has(id));
      if (kept.length === 0 && remove.has(parent)) delete this.state.children[parent];
      else this.state.children[parent] = kept;
    }
  }
}

export function compareMessageIds(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return left.localeCompare(right);
}

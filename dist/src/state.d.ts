import type { FmsgMessage } from "./types.js";
import { type StoredMessage, type ThreadAssignment } from "./threading.js";
export declare class FmsgStateStore {
    private readonly filePath;
    private state;
    private loaded;
    private writeQueue;
    constructor(filePath: string);
    load(): Promise<void>;
    private persistNow;
    persist(): Promise<void>;
    hasProcessed(messageId: string): boolean;
    markProcessed(messageId: string): Promise<void>;
    get highWaterId(): string | undefined;
    get pendingInboundIds(): string[];
    getMessage(id: string): StoredMessage | undefined;
    getLastInbound(branchId: string): string | undefined;
    getLastOutbound(branchId: string): string | undefined;
    getLastDirect(address: string): string | undefined;
    rememberDirect(address: string, messageId: string): Promise<void>;
    assignMessage(message: FmsgMessage, options?: {
        inbound?: boolean;
        branchId?: string;
        rootId?: string;
    }): ThreadAssignment;
    recordOutbound(params: {
        id: string;
        pid?: string;
        topic?: string;
        from: string;
        to: string[];
        branchId?: string;
        rootId?: string;
        noReply?: boolean;
    }): Promise<ThreadAssignment>;
    private inspectTimestamps;
    inspectTurnWindow(branchId: string, maxTurns: number, windowMs: number, now?: number): {
        suppressed: boolean;
        lastAllowed: boolean;
        count: number;
    };
    inspectRootTurnWindow(rootId: string, maxTurns: number, windowMs: number, now?: number): {
        suppressed: boolean;
        lastAllowed: boolean;
        count: number;
    };
    inspectSenderTurnWindow(sender: string, maxTurns: number, windowMs: number, now?: number): {
        suppressed: boolean;
        lastAllowed: boolean;
        count: number;
    };
    private recordTimestamp;
    recordAutomaticTurn(params: {
        branchId: string;
        rootId: string;
        sender: string;
        windowMs: number;
        now?: number;
    }): Promise<void>;
    private pruneMessages;
}
export declare function compareMessageIds(left: string, right: string): number;

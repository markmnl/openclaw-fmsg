import type { FmsgClient } from "./client.js";
import type { FmsgMessage } from "./types.js";
export type ThreadAssignment = {
    rootId: string;
    branchId: string;
    isFork: boolean;
};
export type StoredMessage = {
    id: string;
    pid?: string;
    rootId: string;
    branchId: string;
    from: string;
    to: string[];
    addTo: string[];
    time?: string | number;
    topic?: string;
    important?: boolean;
    noReply?: boolean;
};
export declare function participantsFromMessage(message: FmsgMessage): string[];
export declare function replyAllRecipients(message: FmsgMessage | StoredMessage, ownAddress: string): string[];
export declare function isStrictDmWith(message: FmsgMessage, counterparty: string, ownAddress: string): boolean;
export declare function findMostRecentDirectMessage(client: FmsgClient, counterparty: string, signal?: AbortSignal): Promise<FmsgMessage | undefined>;
export declare function buildAncestryContext(params: {
    leaf: FmsgMessage;
    client: FmsgClient;
    maxMessages?: number;
    maxChars?: number;
    signal?: AbortSignal;
}): Promise<{
    messages: FmsgMessage[];
    context: string;
}>;

export type FmsgAttachment = {
    filename: string;
    size: number;
};
export type FmsgAddToBatch = {
    batch_id?: string;
    add_to_from?: string;
    to?: string[];
    to_delivery?: string[];
    time?: string | number;
};
export type FmsgMessage = {
    id: string;
    version?: number;
    has_pid?: boolean;
    pid?: string;
    has_add_to?: boolean;
    important?: boolean;
    no_reply?: boolean;
    terminal?: boolean;
    deflate?: boolean;
    from: string;
    to: string[];
    to_delivery?: string[];
    add_to?: FmsgAddToBatch[];
    time?: string | number;
    topic?: string;
    type?: string;
    size?: number;
    short_text?: string;
    data?: string;
    read?: boolean;
    time_read?: string | number;
    attachments?: FmsgAttachment[];
    reaction?: string | null;
    reactions?: FmsgReactionGroup[];
};
export type FmsgReactionGroup = {
    emoji: string;
    from: string[];
};
export type FmsgToken = {
    accessToken: string;
    sender: string;
    expiresAtMs: number;
};
export type OutboundAttachment = {
    filename: string;
    data: Uint8Array;
    contentType?: string;
};
export type FmsgSendInput = {
    to: string[];
    text: string;
    pid?: string;
    topic?: string;
    important?: boolean;
    noReply?: boolean;
    attachments?: OutboundAttachment[];
    signal?: AbortSignal;
};
export type FmsgSendResult = {
    id: string;
    time?: string | number;
};
export type FmsgReactResult = {
    id: string | null;
    time: string | number | null;
};
export type FmsgWsEvent = {
    type: string;
    data?: unknown;
};
export type LogSink = {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
};

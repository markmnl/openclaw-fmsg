import WebSocket from "ws";
import type { FmsgMessage, FmsgSendInput, FmsgSendResult, FmsgToken, FmsgWsEvent, LogSink } from "./types.js";
type FetchLike = typeof fetch;
export declare function normalizeFmsgMessage(value: unknown): FmsgMessage;
export declare class FmsgHttpError extends Error {
    readonly status: number;
    constructor(message: string, status: number);
}
export declare class FmsgClient {
    private readonly apiKey;
    private readonly options;
    readonly apiUrl: string;
    private token?;
    private tokenPromise?;
    constructor(apiUrl: string, apiKey: string, options?: {
        fetch?: FetchLike;
        log?: LogSink;
        refreshMarginMs?: number;
    });
    private get fetchImpl();
    getToken(force?: boolean): Promise<FmsgToken>;
    private exchangeToken;
    private request;
    listInbox(limit?: number, offset?: number, signal?: AbortSignal): Promise<FmsgMessage[]>;
    listSent(limit?: number, offset?: number, signal?: AbortSignal): Promise<FmsgMessage[]>;
    getMessage(id: string, signal?: AbortSignal): Promise<FmsgMessage>;
    getMessageData(id: string, signal?: AbortSignal): Promise<string>;
    getMessageText(message: FmsgMessage, signal?: AbortSignal): Promise<string>;
    markRead(id: string, signal?: AbortSignal): Promise<void>;
    downloadAttachment(messageId: string, filename: string, maxBytes: number, signal?: AbortSignal): Promise<{
        data: Uint8Array;
        contentType?: string;
    }>;
    private createDraft;
    private uploadAttachment;
    sendMessage(input: FmsgSendInput): Promise<FmsgSendResult>;
    openWebSocket(): Promise<{
        socket: WebSocket;
        token: FmsgToken;
    }>;
    static parseWsEvent(raw: WebSocket.RawData): FmsgWsEvent | undefined;
}
export {};

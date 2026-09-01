import { FmsgClient } from "./client.js";
import type { FmsgStateStore } from "./state.js";
import type { FmsgMessage, FmsgToken, LogSink } from "./types.js";
export type FmsgConnectionOptions = {
    client: FmsgClient;
    state: FmsgStateStore;
    signal: AbortSignal;
    log?: LogSink;
    onMessage: (message: FmsgMessage) => Promise<void>;
    onReady?: (token: FmsgToken) => void;
    onReconnectAttempt?: (attempt: number) => void;
    random?: () => number;
};
export declare function runFmsgConnection(options: FmsgConnectionOptions): Promise<void>;

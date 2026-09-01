import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { FmsgClient } from "./client.js";
import { type ResolvedFmsgConfig } from "./config.js";
import { FmsgStateStore } from "./state.js";
import type { LogSink } from "./types.js";
export type ActiveFmsgAccount = {
    accountId: string;
    config: ResolvedFmsgConfig;
    client: FmsgClient;
    state: FmsgStateStore;
    log?: LogSink;
};
export declare function fmsgStatePath(accountId: string, env?: NodeJS.ProcessEnv): string;
export declare function registerActiveFmsgAccount(account: ActiveFmsgAccount): () => void;
export declare function getActiveFmsgAccount(accountId?: string): ActiveFmsgAccount | undefined;
export declare function resolveFmsgService(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    log?: LogSink;
}): Promise<ActiveFmsgAccount>;

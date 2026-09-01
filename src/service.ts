import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { FmsgClient } from "./client.js";
import { resolveFmsgAccount, type ResolvedFmsgConfig } from "./config.js";
import { FmsgStateStore } from "./state.js";
import type { LogSink } from "./types.js";

export type ActiveFmsgAccount = {
  accountId: string;
  config: ResolvedFmsgConfig;
  client: FmsgClient;
  state: FmsgStateStore;
  log?: LogSink;
};

const activeAccounts = new Map<string, ActiveFmsgAccount>();

export function fmsgStatePath(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  const safeAccount = accountId.replace(/[^a-zA-Z0-9._-]/gu, "_");
  return path.join(resolveStateDir(env), "fmsg", `${safeAccount}.json`);
}

export function registerActiveFmsgAccount(account: ActiveFmsgAccount): () => void {
  activeAccounts.set(account.accountId, account);
  return () => {
    if (activeAccounts.get(account.accountId) === account) activeAccounts.delete(account.accountId);
  };
}

export function getActiveFmsgAccount(accountId = "default"): ActiveFmsgAccount | undefined {
  return activeAccounts.get(accountId);
}

export async function resolveFmsgService(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  log?: LogSink;
}): Promise<ActiveFmsgAccount> {
  const accountId = params.accountId?.trim() || "default";
  const active = activeAccounts.get(accountId);
  if (active) return active;
  const account = resolveFmsgAccount(params.cfg, accountId);
  if (!account.config.apiKey) throw new Error("fmsg API key is not configured");
  const state = new FmsgStateStore(fmsgStatePath(accountId));
  await state.load();
  return {
    accountId,
    config: account.config,
    client: new FmsgClient(account.config.apiUrl, account.config.apiKey, { log: params.log }),
    state,
    ...(params.log ? { log: params.log } : {}),
  };
}

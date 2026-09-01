import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { FmsgClient } from "./client.js";
import { resolveFmsgAccount } from "./config.js";
import { FmsgStateStore } from "./state.js";
const activeAccounts = new Map();
export function fmsgStatePath(accountId, env = process.env) {
    const safeAccount = accountId.replace(/[^a-zA-Z0-9._-]/gu, "_");
    return path.join(resolveStateDir(env), "fmsg", `${safeAccount}.json`);
}
export function registerActiveFmsgAccount(account) {
    activeAccounts.set(account.accountId, account);
    return () => {
        if (activeAccounts.get(account.accountId) === account)
            activeAccounts.delete(account.accountId);
    };
}
export function getActiveFmsgAccount(accountId = "default") {
    return activeAccounts.get(accountId);
}
export async function resolveFmsgService(params) {
    const accountId = params.accountId?.trim() || "default";
    const active = activeAccounts.get(accountId);
    if (active)
        return active;
    const account = resolveFmsgAccount(params.cfg, accountId);
    if (!account.config.apiUrl)
        throw new Error("fmsg API URL is not configured");
    if (!account.config.apiKey)
        throw new Error("fmsg API key is not configured");
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

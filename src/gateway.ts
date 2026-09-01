import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { FmsgClient } from "./client.js";
import { resolveEffectiveAllowedUsers, type ResolvedFmsgAccount } from "./config.js";
import { runFmsgConnection } from "./connection-manager.js";
import { handleFmsgInbound } from "./inbound.js";
import { formatSafeError } from "./redact.js";
import { fmsgStatePath, registerActiveFmsgAccount, type ActiveFmsgAccount } from "./service.js";
import { FmsgStateStore } from "./state.js";

export async function startFmsgGatewayAccount(
  ctx: ChannelGatewayContext<ResolvedFmsgAccount>,
): Promise<void> {
  const account = ctx.account;
  if (!account.configured || !account.config.apiUrl || !account.config.apiKey) {
    throw new Error(`fmsg channel is not configured for account "${account.accountId}"`);
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    lifecycle: "starting",
    configured: true,
    enabled: account.enabled,
  });
  const state = new FmsgStateStore(fmsgStatePath(account.accountId));
  await state.load();
  const log = ctx.log;
  const service: ActiveFmsgAccount = {
    accountId: account.accountId,
    config: account.config,
    client: new FmsgClient(account.config.apiUrl, account.config.apiKey, { log }),
    state,
    ...(log ? { log } : {}),
  };
  const unregister = registerActiveFmsgAccount(service);
  const allowlist = resolveEffectiveAllowedUsers(account.config);
  if (allowlist.seededFromHome) {
    log?.warn?.(`fmsg allowedUsers is empty; seeding effective allowlist from homeChannel ${allowlist.users[0]}`);
  } else if (!account.config.allowAllUsers && allowlist.users.length === 0) {
    log?.warn?.("fmsg has no allowedUsers or homeChannel; all inbound messages will be rejected");
  }
  const channelRuntime = ctx.channelRuntime as unknown as PluginRuntime["channel"];
  if (!channelRuntime?.inbound?.dispatch) throw new Error("fmsg requires the OpenClaw channel runtime");
  const buildContext = channelRuntime.inbound.buildContext ?? buildChannelInboundEventContext;
  try {
    await runFmsgConnection({
      client: service.client,
      state,
      signal: ctx.abortSignal,
      ...(log ? { log } : {}),
      onReady: () => ctx.setStatus(channelReadyPatch({ accountId: account.accountId })),
      onMessage: async (message) => {
        await handleFmsgInbound({
          cfg: ctx.cfg,
          account: service,
          channelRuntime,
          buildContext,
          message,
        });
      },
    });
  } catch (error) {
    if (!ctx.abortSignal.aborted) {
      ctx.setStatus({
        accountId: account.accountId,
        connected: false,
        lifecycle: "recovering",
        lastError: formatSafeError(error),
      });
      throw error;
    }
  } finally {
    unregister();
    ctx.setStatus(channelStoppedPatch({ accountId: account.accountId }));
  }
}

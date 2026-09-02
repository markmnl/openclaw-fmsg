import {
  buildThreadAwareOutboundSessionRoute,
} from "openclaw/plugin-sdk/channel-core";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import {
  jsonResult,
  readReactionParams,
  resolveReactionMessageId,
} from "openclaw/plugin-sdk/channel-actions";
import { resolveChannelInboundRouteEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isFmsgSenderAllowed, normalizeFmsgAddress, resolveFmsgAccount } from "./config.js";
import { normalizeFmsgMessageId } from "./message-id.js";
import { getFmsgRuntime } from "./runtime.js";
import { resolveFmsgService, type ActiveFmsgAccount } from "./service.js";
import type { FmsgReactionChange } from "./state.js";
import { loadAncestryMessages } from "./threading.js";
import type { FmsgMessage } from "./types.js";

export type FmsgReactionSource = "websocket" | "catch-up";

function resolveConfiguredAccount(cfg: OpenClawConfig, accountId?: string | null) {
  try {
    return resolveFmsgAccount(cfg, accountId);
  } catch {
    return undefined;
  }
}

function ownReaction(message: FmsgMessage, ownAddress: string): string | undefined {
  return message.reactions?.find((group) => group.from.includes(ownAddress))?.emoji;
}

export const fmsgMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const account = resolveConfiguredAccount(cfg, accountId);
    if (!account?.configured || !account.enabled) return null;
    return {
      actions: account.config.actions.reactions
        ? ["send", "react", "reactions"]
        : ["send"],
    };
  },
  supportsAction: ({ action }) => action === "react" || action === "reactions",
  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    if (action !== "react" && action !== "reactions") {
      throw new Error(`Action ${action} is not handled by fmsg`);
    }
    const service = await resolveFmsgService({ cfg, accountId });
    if (!service.config.actions.reactions) {
      throw new Error("fmsg reaction actions are disabled by channels.fmsg.actions.reactions");
    }
    const rawMessageId = resolveReactionMessageId({ args: params, toolContext });
    if (rawMessageId === undefined || rawMessageId === null) throw new Error("messageId required");
    const messageId = normalizeFmsgMessageId(rawMessageId);
    const message = await service.client.getMessage(messageId);
    const ownAddress = (await service.client.getToken()).sender;

    if (action === "reactions") {
      return jsonResult({
        ok: true,
        messageId,
        terminal: message.terminal === true,
        mine: ownReaction(message, ownAddress) ?? null,
        reactions: message.reactions ?? [],
      });
    }

    if (message.terminal) throw new Error(`fmsg message ${messageId} is terminal and cannot be reacted to`);
    const reaction = readReactionParams(params, {
      removeErrorMessage: "emoji is required when remove is true",
    });
    const mine = ownReaction(message, ownAddress);
    if (reaction.remove && mine !== reaction.emoji) {
      return jsonResult({ ok: true, messageId, removed: null, unchanged: true });
    }
    const clearing = reaction.isEmpty || reaction.remove;
    const result = await service.client.reactToMessage(messageId, clearing ? null : reaction.emoji);
    return jsonResult({
      ok: true,
      messageId,
      reactionMessageId: result.id,
      time: result.time,
      ...(clearing
        ? { removed: reaction.remove ? reaction.emoji : mine ?? null, cleared: true }
        : { added: reaction.emoji }),
    });
  },
};

function resolveSessionPeer(service: ActiveFmsgAccount, rootId: string, ownAddress: string): string | undefined {
  const root = service.state.getMessage(rootId);
  if (!root) return undefined;
  const sender = normalizeFmsgAddress(root.from);
  if (sender && sender !== ownAddress) return sender;
  const others = [...new Set([root.from, ...root.to, ...root.addTo]
    .map(normalizeFmsgAddress)
    .filter((address): address is string => Boolean(address) && address !== ownAddress))];
  return others.length === 1 ? others[0] : undefined;
}

function formatReactionEvent(change: FmsgReactionChange, messageId: string): string {
  if (change.previous !== undefined && change.emoji !== undefined) {
    return `[fmsg reaction — untrusted] ${change.from} changed their reaction on message ${messageId} ` +
      `from ${JSON.stringify(change.previous)} to ${JSON.stringify(change.emoji)}.`;
  }
  if (change.emoji !== undefined) {
    return `[fmsg reaction — untrusted] ${change.from} reacted ${JSON.stringify(change.emoji)} ` +
      `to message ${messageId}.`;
  }
  return `[fmsg reaction — untrusted] ${change.from} removed their ` +
    `${JSON.stringify(change.previous ?? "")} reaction from message ${messageId}.`;
}

export async function handleFmsgReaction(params: {
  cfg: OpenClawConfig;
  account: ActiveFmsgAccount;
  message: FmsgMessage;
  source: FmsgReactionSource;
}): Promise<void> {
  const { account: service, message } = params;
  if (service.state.getMessage(message.id)) service.state.assignMessage(message);
  const diff = await service.state.recordReactionSnapshot(message, {
    seedIfMissing: params.source === "catch-up",
  });
  if (diff.changes.length === 0 || service.config.reactionNotifications === "off") return;

  const ownAddress = (await service.client.getToken()).sender;
  if (service.config.reactionNotifications === "own" && normalizeFmsgAddress(message.from) !== ownAddress) {
    return;
  }

  let stored = service.state.getMessage(message.id);
  if (!stored) {
    const ancestry = await loadAncestryMessages({ leaf: message, client: service.client });
    for (const ancestor of ancestry) service.state.assignMessage(ancestor);
    await service.state.persist();
    stored = service.state.getMessage(message.id);
  }
  if (!stored) {
    service.log?.warn?.(`fmsg reaction update for message ${message.id} could not be assigned to a thread`);
    return;
  }
  const peer = resolveSessionPeer(service, stored.rootId, ownAddress);
  if (!peer) {
    service.log?.warn?.(`fmsg reaction update for message ${message.id} has no safe session route`);
    return;
  }
  const base = resolveChannelInboundRouteEnvelope({
    cfg: params.cfg,
    channel: "fmsg",
    accountId: service.accountId,
    peer: { kind: "direct", id: peer },
    dmScope: "per-channel-peer",
  }).route;
  const route = buildThreadAwareOutboundSessionRoute({
    route: {
      sessionKey: base.sessionKey,
      baseSessionKey: base.sessionKey,
      recipientSessionExact: true,
      peer: { kind: "direct", id: peer },
      chatType: "direct",
      from: `fmsg:${service.accountId}`,
      to: `fmsg:${peer}`,
    },
    threadId: stored.branchId,
    precedence: ["threadId", "currentSession"],
    normalizeThreadId: (threadId) => threadId,
  });
  const runtime = getFmsgRuntime();
  for (const change of diff.changes) {
    if (change.from === ownAddress || !isFmsgSenderAllowed(service.config, change.from)) continue;
    runtime.system.enqueueSystemEvent(formatReactionEvent(change, message.id), {
      sessionKey: route.sessionKey,
      contextKey: `fmsg:reaction:${message.id}:${change.from}:${diff.generation}`,
    });
  }
}

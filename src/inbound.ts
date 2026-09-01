import {
  buildThreadAwareOutboundSessionRoute,
  type PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import {
  buildChannelInboundEventContext,
  createChannelInboundEnvelopeBuilder,
  resolveChannelInboundRouteEnvelope,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { isFmsgSenderAllowed, normalizeFmsgAddress, resolveEffectiveAllowedUsers } from "./config.js";
import { formatSafeError } from "./redact.js";
import { sendFmsgOutbound } from "./outbound.js";
import type { ActiveFmsgAccount } from "./service.js";
import { buildAncestryContext, isStrictDmWith } from "./threading.js";
import type { FmsgMessage } from "./types.js";

function timestampMs(value: string | number | undefined): number {
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

async function resolveInboundMedia(service: ActiveFmsgAccount, message: FmsgMessage) {
  const inputs: Array<{ path: string; contentType?: string; fileName: string; messageId: string }> = [];
  let unavailable = 0;
  for (const attachment of message.attachments ?? []) {
    try {
      if (!attachment.filename || attachment.size < 0 || attachment.size > service.config.mediaMaxBytes) {
        throw new Error(`attachment ${attachment.filename || "(unnamed)"} exceeds the configured limit`);
      }
      const downloaded = await service.client.downloadAttachment(
        message.id,
        attachment.filename,
        service.config.mediaMaxBytes,
      );
      const saved = await saveMediaBuffer(
        Buffer.from(downloaded.data),
        downloaded.contentType,
        "inbound",
        service.config.mediaMaxBytes,
        attachment.filename,
      );
      inputs.push({
        path: saved.path,
        ...(saved.contentType ? { contentType: saved.contentType } : {}),
        fileName: attachment.filename,
        messageId: message.id,
      });
    } catch (error) {
      unavailable++;
      service.log?.warn?.(`fmsg attachment unavailable: ${formatSafeError(error)}`);
    }
  }
  return { media: toInboundMediaFacts(inputs), unavailable };
}

async function finishWithoutReply(service: ActiveFmsgAccount, message: FmsgMessage): Promise<void> {
  await service.state.markProcessed(message.id);
  await service.client.markRead(message.id).catch((error) =>
    service.log?.warn?.(`fmsg mark-read failed: ${formatSafeError(error)}`),
  );
}

export async function handleFmsgInbound(params: {
  cfg: OpenClawConfig;
  account: ActiveFmsgAccount;
  channelRuntime: PluginRuntime["channel"];
  buildContext?: typeof buildChannelInboundEventContext;
  message: FmsgMessage;
}): Promise<void> {
  const { account: service, message } = params;
  const sender = normalizeFmsgAddress(message.from);
  if (!sender || !isFmsgSenderAllowed(service.config, sender)) {
    service.log?.warn?.(
      sender
        ? `fmsg inbound rejected by default-deny access policy: ${sender}`
        : "fmsg inbound rejected: invalid sender address",
    );
    await finishWithoutReply(service, message);
    return;
  }

  const ancestry = await buildAncestryContext({ leaf: message, client: service.client });
  for (const ancestor of ancestry.messages.slice(0, -1)) service.state.assignMessage(ancestor);
  const assignment = service.state.assignMessage(message, { inbound: true });
  const ownAddress = (await service.client.getToken()).sender;
  if (isStrictDmWith(message, sender, ownAddress)) {
    await service.state.rememberDirect(sender, message.id);
  }
  await service.state.persist();

  if (message.no_reply) {
    service.log?.info?.(`fmsg no_reply honored for message ${message.id}`);
    await finishWithoutReply(service, message);
    return;
  }

  const turnWindow = service.state.inspectTurnWindow(
    assignment.branchId,
    service.config.maxAgentTurnsPerThread,
    service.config.agentTurnWindowMs,
  );
  if (turnWindow.suppressed) {
    service.log?.warn?.(
      `fmsg automatic reply suppressed for branch ${assignment.branchId}: ` +
        `${service.config.maxAgentTurnsPerThread} turns in ${service.config.agentTurnWindowMs}ms`,
    );
    await finishWithoutReply(service, message);
    return;
  }

  const base = resolveChannelInboundRouteEnvelope({
    cfg: params.cfg,
    channel: "fmsg",
    accountId: service.accountId,
    peer: { kind: "direct", id: sender },
    dmScope: "per-channel-peer",
  }).route;
  const route = buildThreadAwareOutboundSessionRoute({
    route: {
      sessionKey: base.sessionKey,
      baseSessionKey: base.sessionKey,
      recipientSessionExact: true,
      peer: { kind: "direct", id: sender },
      chatType: "direct",
      from: `fmsg:${service.accountId}`,
      to: `fmsg:${sender}`,
    },
    threadId: assignment.branchId,
    replyToId: message.pid,
    precedence: ["threadId", "replyToId", "currentSession"],
    normalizeThreadId: (threadId) => threadId,
  });
  const buildEnvelope = createChannelInboundEnvelopeBuilder({
    cfg: params.cfg,
    route: { agentId: base.agentId, sessionKey: route.sessionKey },
  });
  const allowed = resolveEffectiveAllowedUsers(service.config).users;
  const ingress = await resolveStableChannelMessageIngress({
    channelId: "fmsg",
    accountId: service.accountId,
    cfg: params.cfg,
    identity: {
      key: "fmsg-address",
      normalizeEntry: (value) => normalizeFmsgAddress(value) ?? null,
      normalizeSubject: (value) => normalizeFmsgAddress(value) ?? null,
      entryIdPrefix: "fmsg-entry",
    },
    subject: { stableId: sender },
    conversation: { kind: "direct", id: assignment.branchId },
    contextBinding: {
      agentId: base.agentId,
      sessionKey: route.sessionKey,
      messageId: message.id,
      inboundEventKind: "user_request",
    },
    dmPolicy: service.config.allowAllUsers ? "open" : "allowlist",
    allowFrom: service.config.allowAllUsers ? ["*"] : allowed,
  });
  if (ingress.ingress.admission !== "dispatch") {
    service.log?.warn?.(`fmsg inbound denied by OpenClaw ingress policy: ${sender}`);
    await finishWithoutReply(service, message);
    return;
  }

  let body = await service.client.getMessageText(message);
  const inboundMedia = await resolveInboundMedia(service, message);
  if (inboundMedia.unavailable > 0) {
    body += `\n\n[${inboundMedia.unavailable} fmsg attachment(s) were unavailable]`;
  }
  const flags = [message.important ? "important=true" : "", message.no_reply ? "no_reply=true" : ""]
    .filter(Boolean)
    .join(" ");
  const bodyForAgent = [
    ancestry.context,
    flags ? `[fmsg metadata: ${flags}]` : "",
    body,
  ].filter(Boolean).join("\n\n");
  const contextBuilder = params.buildContext ?? buildChannelInboundEventContext;
  const ctxPayload = contextBuilder({
    channel: "fmsg",
    accountId: service.accountId,
    messageId: message.id,
    messageIdFull: message.id,
    timestamp: timestampMs(message.time),
    from: `fmsg:${sender}`,
    sender: { id: sender, name: sender },
    conversation: {
      kind: "direct",
      id: sender,
      routePeer: { kind: "direct", id: sender },
      label: sender,
    },
    route: {
      agentId: base.agentId,
      dmScope: "per-channel-peer",
      accountId: service.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
    },
    reply: { to: `fmsg:${sender}`, originatingTo: `fmsg:${sender}` },
    message: {
      body: buildEnvelope({ channel: "fmsg", from: sender, timestamp: timestampMs(message.time), body }),
      bodyForAgent,
      rawBody: body,
      commandBody: body,
    },
    media: inboundMedia.media,
    channelIngress: ingress,
    access: { commands: { authorized: true } },
    extra: {
      NativeDirectUserId: sender,
      OriginatingChannel: "fmsg",
      OriginatingTo: `fmsg:${sender}`,
      MessageThreadId: assignment.branchId,
      TransportThreadId: assignment.branchId,
      ReplyToId: message.pid,
      FmsgRootId: assignment.rootId,
      FmsgBranchId: assignment.branchId,
      FmsgImportant: message.important === true,
      FmsgNoReply: false,
    },
  });

  let lastSentId: string | undefined;
  let recordedTurn = false;
  let previousText = "";
  const deliveryErrors: unknown[] = [];
  const dispatch = await params.channelRuntime.inbound.dispatch({
    cfg: params.cfg,
    channel: "fmsg",
    accountId: service.accountId,
    route: { agentId: base.agentId, dmScope: "per-channel-peer", sessionKey: route.sessionKey },
    ctxPayload,
    delivery: {
      preparePayload: (payload) => turnWindow.lastAllowed
        ? {
            ...payload,
            channelData: {
              ...payload.channelData,
              fmsg: { noReply: true },
            },
          }
        : payload,
      durable: () => ({
        to: sender,
        replyToId: lastSentId ?? message.id,
        replyToMode: "all",
        threadId: assignment.branchId,
      }),
      deliver: async (payload, info) => {
        const text = typeof payload.text === "string" ? payload.text : "";
        const mediaUrls = [...(payload.mediaUrls ?? []), ...(payload.mediaUrl ? [payload.mediaUrl] : [])];
        if (!text.trim() && mediaUrls.length === 0) return;
        if (info.kind === "final" && text === previousText && mediaUrls.length === 0) return;
        const sent = await sendFmsgOutbound({
          cfg: params.cfg,
          accountId: service.accountId,
          to: sender,
          text,
          replyToId: lastSentId ?? message.id,
          threadId: assignment.branchId,
          mediaUrls,
          noReply: turnWindow.lastAllowed,
        });
        lastSentId = sent.messageId;
        previousText = text;
        if (!recordedTurn) {
          recordedTurn = true;
          await service.state.recordAutomaticTurn(
            assignment.branchId,
            service.config.agentTurnWindowMs,
          );
        }
      },
      onDelivered: async (_payload, _info, result) => {
        lastSentId = result?.receipt?.primaryPlatformMessageId
          ?? result?.messageIds?.at(-1)
          ?? lastSentId;
        if (!recordedTurn) {
          recordedTurn = true;
          await service.state.recordAutomaticTurn(
            assignment.branchId,
            service.config.agentTurnWindowMs,
          );
        }
      },
      onError: (error) => {
        deliveryErrors.push(error);
        service.log?.error?.(
          `fmsg reply not delivered for message ${message.id} branch ${assignment.branchId}: ${formatSafeError(error)}`,
        );
      },
    },
    replyPipeline: {},
  });
  if (dispatch.admission.kind !== "dispatch" || !dispatch.dispatched) {
    throw new Error(`OpenClaw declined fmsg turn: ${dispatch.admission.kind}`);
  }
  const receipt = dispatch.dispatchResult?.settledReceipt;
  if (deliveryErrors.length > 0 && !receipt?.anyVisibleDelivered) {
    throw new Error(`fmsg produced a reply but did not deliver it`, { cause: deliveryErrors[0] });
  }
  if (deliveryErrors.length > 0) {
    service.log?.warn?.(
      `fmsg reply was only partially delivered for message ${message.id} branch ${assignment.branchId}`,
    );
  }
  await finishWithoutReply(service, message);
}

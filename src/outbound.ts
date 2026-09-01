import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  loadOutboundMediaFromUrl,
  type OutboundMediaLoadOptions,
} from "openclaw/plugin-sdk/outbound-media";
import { normalizeFmsgAddress } from "./config.js";
import { redactSecrets } from "./redact.js";
import { resolveFmsgService, type ActiveFmsgAccount } from "./service.js";
import {
  findMostRecentDirectMessage,
  isStrictDmWith,
  participantsFromMessage,
  replyAllRecipients,
} from "./threading.js";
import type { FmsgMessage, OutboundAttachment } from "./types.js";

type MediaOptions = {
  mediaUrls?: readonly string[];
  mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};

export type SendFmsgOutboundParams = MediaOptions & {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
  replyToId?: string | number | null;
  threadId?: string | number | null;
  newThread?: boolean;
  topic?: string;
  important?: boolean;
  noReply?: boolean;
  signal?: AbortSignal;
};

async function loadAttachments(
  service: ActiveFmsgAccount,
  options: MediaOptions,
): Promise<OutboundAttachment[]> {
  return Promise.all(
    (options.mediaUrls ?? []).map(async (mediaUrl) => {
      const media = await loadOutboundMediaFromUrl(mediaUrl, {
        maxBytes: service.config.mediaMaxBytes,
        mediaAccess: options.mediaAccess,
        mediaLocalRoots: options.mediaLocalRoots,
        mediaReadFile: options.mediaReadFile,
        optimizeImages: false,
      });
      return {
        filename:
          media.fileName ?? (path.basename(new URL(mediaUrl, "file:///").pathname) || "attachment"),
        data: media.buffer,
        ...(media.contentType ? { contentType: media.contentType } : {}),
      };
    }),
  );
}

async function resolveParent(
  service: ActiveFmsgAccount,
  params: SendFmsgOutboundParams,
  counterparty: string,
): Promise<{ parent?: FmsgMessage; pid?: string; branchId?: string; rootId?: string }> {
  if (params.newThread) return {};
  const explicit = params.replyToId == null ? undefined : String(params.replyToId);
  const threadId = params.threadId == null ? undefined : String(params.threadId);
  const parentId = explicit ?? (threadId ? service.state.getLastOutbound(threadId) ?? service.state.getLastInbound(threadId) : undefined);
  if (parentId) {
    const stored = service.state.getMessage(parentId);
    const parent = await service.client.getMessage(parentId, params.signal).catch(() => undefined);
    return {
      ...(parent ? { parent } : {}),
      pid: parentId,
      ...(threadId || stored?.branchId ? { branchId: threadId ?? stored?.branchId } : {}),
      ...(stored?.rootId ? { rootId: stored.rootId } : {}),
    };
  }
  const cachedId = service.state.getLastDirect(counterparty);
  const cached = cachedId
    ? await service.client.getMessage(cachedId, params.signal).catch(() => undefined)
    : undefined;
  const token = await service.client.getToken();
  const recent = cached && isStrictDmWith(cached, counterparty, token.sender)
    ? cached
    : await findMostRecentDirectMessage(service.client, counterparty, params.signal);
  return recent ? { parent: recent, pid: recent.id } : {};
}

export async function sendFmsgOutbound(params: SendFmsgOutboundParams): Promise<{
  to: string;
  recipients: string[];
  messageId: string;
  pid?: string;
  threadId: string;
  createdRoot: boolean;
}> {
  const counterparty = normalizeFmsgAddress(params.to.replace(/^fmsg:/iu, ""));
  if (!counterparty) throw new Error("fmsg target must be an @user@domain address");
  const service = await resolveFmsgService({ cfg: params.cfg, accountId: params.accountId });
  const token = await service.client.getToken();
  const parent = await resolveParent(service, params, counterparty);
  const recipients = parent.parent
    ? replyAllRecipients(parent.parent, token.sender)
    : [counterparty];
  if (recipients.length === 0) recipients.push(counterparty);
  const attachments = await loadAttachments(service, params);
  const topic = params.topic?.trim() || "OpenClaw";
  const result = await service.client.sendMessage({
    to: recipients,
    text: redactSecrets(params.text),
    ...(parent.pid ? { pid: parent.pid } : { topic }),
    ...(params.important ? { important: true } : {}),
    ...(params.noReply ? { noReply: true } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const assignment = await service.state.recordOutbound({
    id: result.id,
    ...(parent.pid ? { pid: parent.pid } : { topic }),
    from: token.sender,
    to: recipients,
    ...(parent.branchId ? { branchId: parent.branchId } : {}),
    ...(parent.rootId ? { rootId: parent.rootId } : {}),
    ...(params.noReply ? { noReply: true } : {}),
  });
  return {
    to: counterparty,
    recipients,
    messageId: result.id,
    ...(parent.pid ? { pid: parent.pid } : {}),
    threadId: assignment.branchId,
    createdRoot: !parent.pid,
  };
}

export function recipientsForParent(message: FmsgMessage, ownAddress: string): string[] {
  return participantsFromMessage(message).filter((address) => address !== normalizeFmsgAddress(ownAddress));
}

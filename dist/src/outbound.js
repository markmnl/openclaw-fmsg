import path from "node:path";
import { loadOutboundMediaFromUrl, } from "openclaw/plugin-sdk/outbound-media";
import { normalizeFmsgAddress } from "./config.js";
import { formatSafeError, redactSecrets } from "./redact.js";
import { resolveFmsgService } from "./service.js";
import { findMostRecentDirectMessage, isStrictDmWith, participantsFromMessage, replyAllRecipients, } from "./threading.js";
async function loadAttachments(service, options) {
    return Promise.all((options.mediaUrls ?? []).map(async (mediaUrl) => {
        const media = await loadOutboundMediaFromUrl(mediaUrl, {
            maxBytes: service.config.mediaMaxBytes,
            mediaAccess: options.mediaAccess,
            mediaLocalRoots: options.mediaLocalRoots,
            mediaReadFile: options.mediaReadFile,
            optimizeImages: false,
        });
        return {
            filename: media.fileName ?? (path.basename(new URL(mediaUrl, "file:///").pathname) || "attachment"),
            data: media.buffer,
            ...(media.contentType ? { contentType: media.contentType } : {}),
        };
    }));
}
async function resolveParent(service, params, counterparty) {
    if (params.newThread)
        return {};
    const explicit = params.replyToId == null ? undefined : String(params.replyToId);
    const threadId = params.threadId == null ? undefined : String(params.threadId);
    const parentId = explicit ?? (threadId ? service.state.getLastOutbound(threadId) ?? service.state.getLastInbound(threadId) : undefined);
    if (parentId) {
        const stored = service.state.getMessage(parentId);
        let parent;
        try {
            parent = await service.client.getMessage(parentId, params.signal);
        }
        catch (error) {
            if (params.signal?.aborted)
                throw error;
            service.log?.warn?.(`fmsg parent message ${parentId} fetch failed; ` +
                `${stored ? "using stored participant metadata" : "reply-all participant metadata is unavailable"}: ` +
                formatSafeError(error));
        }
        return {
            ...(parent ? { parent } : {}),
            ...(stored ? { stored } : {}),
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
export async function sendFmsgOutbound(params) {
    const counterparty = normalizeFmsgAddress(params.to.replace(/^fmsg:/iu, ""));
    if (!counterparty)
        throw new Error("fmsg target must be an @user@domain address");
    const service = await resolveFmsgService({ cfg: params.cfg, accountId: params.accountId });
    const token = await service.client.getToken();
    const parent = await resolveParent(service, params, counterparty);
    const participantSource = parent.parent ?? parent.stored;
    if (participantSource?.terminal) {
        throw new Error(`fmsg message ${participantSource.id} is terminal and cannot be replied to`);
    }
    const recipients = participantSource
        ? replyAllRecipients(participantSource, token.sender)
        : [counterparty];
    if (recipients.length === 0)
        recipients.push(counterparty);
    const attachments = await loadAttachments(service, params);
    const topic = params.topic?.trim() || "OpenClaw";
    let result;
    try {
        result = await service.client.sendMessage({
            to: recipients,
            text: redactSecrets(params.text),
            ...(parent.pid ? { pid: parent.pid } : { topic }),
            ...(params.important ? { important: true } : {}),
            ...(params.noReply ? { noReply: true } : {}),
            ...(attachments.length ? { attachments } : {}),
            ...(params.signal ? { signal: params.signal } : {}),
        });
        service.setStatus?.({ lastOutboundAt: Date.now(), lastError: null, stateReason: "ready" });
    }
    catch (error) {
        service.setStatus?.({
            lastError: formatSafeError(error),
            stateReason: "fmsg message was not delivered",
        });
        throw error;
    }
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
export function recipientsForParent(message, ownAddress) {
    return participantsFromMessage(message).filter((address) => address !== normalizeFmsgAddress(ownAddress));
}

import { buildChannelOutboundSessionRoute, buildThreadAwareOutboundSessionRoute, createChatChannelPlugin, } from "openclaw/plugin-sdk/channel-core";
import { createMessageReceiptFromOutboundResults, defineChannelMessageAdapter, } from "openclaw/plugin-sdk/channel-outbound";
import { fmsgChannelConfigSchema, listFmsgAccountIds, normalizeFmsgAddress, resolveEffectiveAllowedUsers, resolveFmsgAccount, } from "./config.js";
import { fmsgChannelSecrets } from "./secret-contract.js";
import { fmsgSetupContract, fmsgSetupWizard } from "./setup.js";
async function sendFmsgOutbound(params) {
    const outbound = await import("./outbound.js");
    return outbound.sendFmsgOutbound(params);
}
const CHANNEL_ID = "fmsg";
function normalizeTarget(raw) {
    const normalized = normalizeFmsgAddress(raw.replace(/^fmsg:/iu, ""));
    return normalized ? `fmsg:${normalized}` : undefined;
}
function scopedConfig(cfg) {
    return {
        ...cfg,
        session: { ...cfg.session, dmScope: "per-channel-peer" },
    };
}
function receipt(ctx, messageId, kind) {
    return createMessageReceiptFromOutboundResults({
        results: [{ channel: CHANNEL_ID, messageId }],
        ...(ctx.threadId != null ? { threadId: String(ctx.threadId) } : {}),
        ...(ctx.replyToId ? { replyToId: ctx.replyToId } : {}),
        kind,
    });
}
async function sendPayload(ctx) {
    const mediaUrls = Array.from(new Set([ctx.mediaUrl, ctx.payload.mediaUrl, ...(ctx.payload.mediaUrls ?? [])].filter((value) => typeof value === "string" && Boolean(value.trim()))));
    const result = await sendFmsgOutbound({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        to: ctx.to,
        text: ctx.payload.text ?? ctx.text,
        replyToId: ctx.replyToId,
        threadId: ctx.threadId,
        mediaUrls,
        mediaAccess: ctx.mediaAccess,
        mediaLocalRoots: ctx.mediaLocalRoots,
        mediaReadFile: ctx.mediaReadFile,
        noReply: ctx.payload.channelData?.fmsg?.noReply === true,
        signal: ctx.signal,
    });
    return {
        messageId: result.messageId,
        receipt: receipt(ctx, result.messageId, mediaUrls.length ? "media" : "text"),
    };
}
const messageAdapter = defineChannelMessageAdapter({
    id: CHANNEL_ID,
    durableFinal: {
        capabilities: {
            text: true,
            media: true,
            payload: true,
            replyTo: true,
            thread: true,
            messageSendingHooks: true,
        },
    },
    send: {
        payload: sendPayload,
        text: async (ctx) => {
            const result = await sendFmsgOutbound({
                cfg: ctx.cfg,
                accountId: ctx.accountId,
                to: ctx.to,
                text: ctx.text,
                replyToId: ctx.replyToId,
                threadId: ctx.threadId,
                signal: ctx.signal,
            });
            return { messageId: result.messageId, receipt: receipt(ctx, result.messageId, "text") };
        },
        media: async (ctx) => {
            const result = await sendFmsgOutbound({
                cfg: ctx.cfg,
                accountId: ctx.accountId,
                to: ctx.to,
                text: ctx.text,
                replyToId: ctx.replyToId,
                threadId: ctx.threadId,
                mediaUrls: [ctx.mediaUrl],
                mediaAccess: ctx.mediaAccess,
                mediaLocalRoots: ctx.mediaLocalRoots,
                mediaReadFile: ctx.mediaReadFile,
                signal: ctx.signal,
            });
            return { messageId: result.messageId, receipt: receipt(ctx, result.messageId, "media") };
        },
    },
});
export const fmsgChannelPlugin = createChatChannelPlugin({
    base: {
        id: CHANNEL_ID,
        meta: {
            id: CHANNEL_ID,
            label: "fmsg",
            selectionLabel: "fmsg (Federated Messaging)",
            docsPath: "https://github.com/markmnl/openclaw-fmsg#readme",
            docsLabel: "documentation",
            blurb: "Federated, threaded messaging over the fmsg Web API.",
            order: 75,
        },
        capabilities: {
            chatTypes: ["direct", "thread"],
            reply: true,
            threads: true,
            media: true,
        },
        reload: { configPrefixes: ["channels.fmsg"] },
        configSchema: fmsgChannelConfigSchema,
        setupContract: fmsgSetupContract,
        setupWizard: fmsgSetupWizard,
        secrets: fmsgChannelSecrets,
        config: {
            listAccountIds: listFmsgAccountIds,
            resolveAccount: (cfg, accountId) => resolveFmsgAccount(cfg, accountId),
            defaultAccountId: () => "default",
            isConfigured: (account) => account.configured,
            isEnabled: (account) => account.enabled,
            resolveAllowFrom: ({ cfg, accountId }) => resolveEffectiveAllowedUsers(resolveFmsgAccount(cfg, accountId).config).users,
            resolveDefaultTo: ({ cfg, accountId }) => resolveFmsgAccount(cfg, accountId).config.homeChannel,
        },
        messaging: {
            targetPrefixes: ["fmsg"],
            normalizeTarget,
            inferTargetChatType: ({ to }) => (normalizeTarget(to) ? "direct" : undefined),
            targetResolver: {
                looksLikeId: (raw) => Boolean(normalizeTarget(raw)),
                hint: "<@user@domain>",
            },
            resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target, replyToId, threadId, currentSessionKey, }) => {
                const normalized = normalizeTarget(target);
                if (!normalized)
                    return null;
                const address = normalized.slice("fmsg:".length);
                const base = buildChannelOutboundSessionRoute({
                    cfg: scopedConfig(cfg),
                    agentId,
                    channel: CHANNEL_ID,
                    accountId,
                    recipientSessionExact: true,
                    peer: { kind: "direct", id: address },
                    chatType: "direct",
                    from: `fmsg:${accountId ?? "default"}`,
                    to: normalized,
                });
                return buildThreadAwareOutboundSessionRoute({
                    route: base,
                    replyToId,
                    threadId,
                    currentSessionKey,
                    precedence: ["threadId", "replyToId", "currentSession"],
                    normalizeThreadId: (value) => value,
                    canRecoverCurrentThread: ({ currentBaseSessionKey }) => currentBaseSessionKey === base.baseSessionKey,
                });
            },
        },
        threading: {
            threadAddressing: "message",
            resolveReplyToMode: () => "all",
            buildToolContext: ({ context, hasRepliedRef }) => ({
                currentChannelId: context.NativeChannelId ?? context.From,
                currentChatType: "direct",
                currentMessagingTarget: context.To,
                currentThreadTs: context.MessageThreadId == null ? undefined : String(context.MessageThreadId),
                currentMessageId: context.CurrentMessageId,
                replyToMode: "all",
                hasRepliedRef,
            }),
        },
        directory: {
            self: async ({ cfg, accountId }) => {
                const { resolveFmsgService } = await import("./service.js");
                const service = await resolveFmsgService({ cfg, accountId });
                const identity = (await service.client.getToken()).sender;
                return { kind: "user", id: identity, name: identity, handle: identity };
            },
        },
        message: messageAdapter,
        gateway: {
            startAccount: async (ctx) => {
                const gateway = await import("./gateway.js");
                return gateway.startFmsgGatewayAccount(ctx);
            },
        },
    },
    security: {
        dm: {
            channelKey: CHANNEL_ID,
            resolvePolicy: (account) => (account.config.allowAllUsers ? "open" : "allowlist"),
            resolveAllowFrom: (account) => resolveEffectiveAllowedUsers(account.config).users,
            defaultPolicy: "allowlist",
            allowFromPathSuffix: "allowedUsers",
            normalizeEntry: (raw) => normalizeFmsgAddress(raw) ?? raw.trim().toLowerCase(),
        },
        dmRouting: { resolveDmScope: () => "per-channel-peer" },
    },
    outbound: {
        base: {
            deliveryMode: "direct",
            sendTextOnlyErrorPayloads: true,
            sendPayload: async (ctx) => {
                const result = await sendPayload(ctx);
                return { channel: CHANNEL_ID, messageId: result.messageId };
            },
        },
        attachedResults: {
            channel: CHANNEL_ID,
            sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
                const result = await sendFmsgOutbound({ cfg, to, text, accountId, replyToId, threadId });
                return { to: result.to, messageId: result.messageId };
            },
            sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId, threadId, mediaAccess, mediaLocalRoots, mediaReadFile, }) => {
                if (!mediaUrl)
                    throw new Error("fmsg media send requires mediaUrl");
                const result = await sendFmsgOutbound({
                    cfg,
                    to,
                    text,
                    accountId,
                    replyToId,
                    threadId,
                    mediaUrls: [mediaUrl],
                    mediaAccess,
                    mediaLocalRoots,
                    mediaReadFile,
                });
                return { to: result.to, messageId: result.messageId };
            },
        },
    },
});

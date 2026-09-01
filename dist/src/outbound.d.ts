import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type OutboundMediaLoadOptions } from "openclaw/plugin-sdk/outbound-media";
import type { FmsgMessage } from "./types.js";
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
export declare function sendFmsgOutbound(params: SendFmsgOutboundParams): Promise<{
    to: string;
    recipients: string[];
    messageId: string;
    pid?: string;
    threadId: string;
    createdRoot: boolean;
}>;
export declare function recipientsForParent(message: FmsgMessage, ownAddress: string): string[];
export {};

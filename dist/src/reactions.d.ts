import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type ActiveFmsgAccount } from "./service.js";
import type { FmsgMessage } from "./types.js";
export type FmsgReactionSource = "websocket" | "catch-up";
export declare const fmsgMessageActions: ChannelMessageActionAdapter;
export declare function handleFmsgReaction(params: {
    cfg: OpenClawConfig;
    account: ActiveFmsgAccount;
    message: FmsgMessage;
    source: FmsgReactionSource;
}): Promise<void>;

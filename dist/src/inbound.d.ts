import { type PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ActiveFmsgAccount } from "./service.js";
import type { FmsgMessage } from "./types.js";
export declare function handleFmsgInbound(params: {
    cfg: OpenClawConfig;
    account: ActiveFmsgAccount;
    channelRuntime: PluginRuntime["channel"];
    buildContext?: typeof buildChannelInboundEventContext;
    message: FmsgMessage;
}): Promise<void>;

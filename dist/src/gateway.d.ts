import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { type ResolvedFmsgAccount } from "./config.js";
export declare function startFmsgGatewayAccount(ctx: ChannelGatewayContext<ResolvedFmsgAccount>): Promise<void>;

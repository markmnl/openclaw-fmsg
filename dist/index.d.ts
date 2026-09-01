import { type ChannelPlugin, type OpenClawPluginApi, type PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { fmsgChannelPlugin } from "./src/channel.js";
type FmsgEntry = {
    id: string;
    name: string;
    description: string;
    configSchema: NonNullable<ChannelPlugin["configSchema"]>;
    register: (api: OpenClawPluginApi) => void;
    channelPlugin: typeof fmsgChannelPlugin;
    setChannelRuntime?: (runtime: PluginRuntime) => void;
};
declare const fmsgEntry: FmsgEntry;
export default fmsgEntry;
export { fmsgChannelPlugin } from "./src/channel.js";
export { FmsgClient, FmsgHttpError } from "./src/client.js";
export { resolveFmsgConfig } from "./src/config.js";

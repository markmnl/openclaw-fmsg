import {
  defineChannelPluginEntry,
  type ChannelPlugin,
  type OpenClawPluginApi,
  type PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import { fmsgChannelPlugin } from "./src/channel.js";
import { setFmsgRuntime } from "./src/runtime.js";
import { createFmsgSendTool } from "./src/tool.js";

type FmsgEntry = {
  id: string;
  name: string;
  description: string;
  configSchema: NonNullable<ChannelPlugin["configSchema"]>;
  register: (api: OpenClawPluginApi) => void;
  channelPlugin: typeof fmsgChannelPlugin;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

const fmsgEntry: FmsgEntry = defineChannelPluginEntry({
  id: "fmsg",
  name: "fmsg Channel",
  description: "Federated, threaded messaging through the fmsg Web API.",
  plugin: fmsgChannelPlugin,
  setRuntime: setFmsgRuntime,
  registerFull(api) {
    api.registerTool((context) => createFmsgSendTool(api, context), { name: "fmsg_send" });
  },
});

export default fmsgEntry;

export { fmsgChannelPlugin } from "./src/channel.js";
export { FmsgClient, FmsgHttpError } from "./src/client.js";
export { resolveFmsgConfig } from "./src/config.js";

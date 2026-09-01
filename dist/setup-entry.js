import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { fmsgChannelPlugin } from "./src/channel.js";
export default defineSetupPluginEntry(fmsgChannelPlugin);

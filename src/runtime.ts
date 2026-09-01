import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const runtimeStore = createPluginRuntimeStore<PluginRuntime>("fmsg runtime not initialized");

export function setFmsgRuntime(runtime: PluginRuntime): void {
  runtimeStore.setRuntime(runtime);
}

export function getFmsgRuntime(): PluginRuntime {
  return runtimeStore.getRuntime();
}

import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
const runtimeStore = createPluginRuntimeStore("fmsg runtime not initialized");
export function setFmsgRuntime(runtime) {
    runtimeStore.setRuntime(runtime);
}
export function getFmsgRuntime() {
    return runtimeStore.getRuntime();
}

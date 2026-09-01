export declare const secretTargetRegistryEntries: readonly import("openclaw/plugin-sdk/channel-secret-basic-runtime").SecretTargetRegistryEntry[] | undefined;
export declare const collectRuntimeConfigAssignments: ((params: {
    config: import("openclaw/plugin-sdk/channel-core").OpenClawConfig;
    defaults: import("openclaw/plugin-sdk/channel-secret-basic-runtime").SecretDefaults | undefined;
    context: import("openclaw/plugin-sdk/channel-secret-basic-runtime").ResolverContext;
}) => void) | undefined;

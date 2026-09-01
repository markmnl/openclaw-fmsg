import { collectSecretInputAssignment, createSimpleChannelSecretContract, getChannelRecord, } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
const baseContract = createSimpleChannelSecretContract({
    channelKey: "fmsg",
    label: "fmsg",
    accountFields: [],
    channelFields: ["apiKey"],
    mode: "channel-only",
});
export const fmsgChannelSecrets = {
    secretTargetRegistryEntries: baseContract.secretTargetRegistryEntries,
    collectRuntimeConfigAssignments(params) {
        if (!params.context.env.FMSG_API_KEY?.trim()) {
            baseContract.collectRuntimeConfigAssignments(params);
            return;
        }
        const channel = getChannelRecord(params.config, "fmsg");
        if (!channel)
            return;
        collectSecretInputAssignment({
            value: channel.apiKey,
            path: "channels.fmsg.apiKey",
            expected: "string",
            defaults: params.defaults,
            context: params.context,
            active: false,
            inactiveReason: "FMSG_API_KEY takes precedence over channels.fmsg.apiKey.",
            apply: (value) => {
                channel.apiKey = value;
            },
        });
    },
};

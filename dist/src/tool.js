import { jsonResult, } from "openclaw/plugin-sdk/core";
import { sendFmsgOutbound } from "./outbound.js";
const fmsgSendParameters = {
    type: "object",
    additionalProperties: false,
    required: ["to", "text"],
    properties: {
        to: {
            type: "string",
            pattern: "^@[^@\\s]+@[^@\\s]+$",
            description: "Destination fmsg address in @user@domain form.",
        },
        text: { type: "string", minLength: 1, description: "Message text." },
        fmsg_new_thread: {
            type: "boolean",
            description: "When true, force a new fmsg root instead of continuing the latest 1:1 thread.",
        },
        topic: { type: "string", description: "Optional topic for a new fmsg root." },
    },
};
export function createFmsgSendTool(api, context) {
    return {
        name: "fmsg_send",
        label: "Send fmsg Message",
        resultContentSource: "network",
        description: "Send an fmsg message to an @user@domain address, continuing the most recent 1:1 thread unless fmsg_new_thread is true.",
        parameters: fmsgSendParameters,
        execute: async (_toolCallId, raw, signal) => {
            const to = typeof raw.to === "string" ? raw.to : "";
            const text = typeof raw.text === "string" ? raw.text : "";
            if (!to || !text)
                throw new Error("fmsg_send requires to and text");
            const result = await sendFmsgOutbound({
                cfg: context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? api.config,
                accountId: "default",
                to,
                text,
                newThread: raw.fmsg_new_thread === true,
                ...(typeof raw.topic === "string" && raw.topic.trim() ? { topic: raw.topic.trim() } : {}),
                ...(signal ? { signal } : {}),
            });
            return jsonResult(result);
        },
    };
}

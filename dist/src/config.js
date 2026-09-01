import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { hasConfiguredSecretInput, normalizeResolvedSecretInputString, } from "openclaw/plugin-sdk/secret-input";
export const DEFAULT_MAX_AGENT_TURNS = 8;
export const DEFAULT_AGENT_TURN_WINDOW_MS = 60_000;
export const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
export const secretInputJsonSchema = {
    oneOf: [
        { type: "string", minLength: 1 },
        {
            type: "object",
            additionalProperties: false,
            required: ["source", "provider", "id"],
            properties: {
                source: { type: "string", enum: ["env", "file", "exec", "store"] },
                provider: { type: "string", minLength: 1 },
                id: { type: "string", minLength: 1 },
            },
        },
    ],
};
export const fmsgChannelJsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        enabled: { type: "boolean", default: true },
        apiUrl: {
            type: "string",
            format: "uri",
            pattern: "^https?://",
            description: "Explicit fmsg Web API base URL; no hosted endpoint is assumed.",
        },
        apiKey: {
            ...secretInputJsonSchema,
            description: "fmsg API key or OpenClaw SecretRef. FMSG_API_KEY takes precedence.",
        },
        homeChannel: { type: "string", pattern: "^@[^@\\s]+@[^@\\s]+$" },
        allowedUsers: {
            type: "array",
            items: { type: "string", pattern: "^@[^@\\s]+@[^@\\s]+$" },
            default: [],
        },
        allowAllUsers: { type: "boolean", default: false },
        maxAgentTurnsPerThread: {
            type: "integer",
            minimum: 0,
            default: DEFAULT_MAX_AGENT_TURNS,
            description: "Automatic OpenClaw turns allowed per fmsg branch/window; 0 disables the circuit breaker.",
        },
        agentTurnWindowMs: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_AGENT_TURN_WINDOW_MS,
            description: "Sliding per-branch automatic-turn window in milliseconds.",
        },
        mediaMaxBytes: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_MEDIA_MAX_BYTES,
        },
    },
};
export const fmsgChannelConfigSchema = buildJsonChannelConfigSchema(fmsgChannelJsonSchema, {
    uiHints: {
        apiKey: {
            label: "fmsg API key",
            help: "Use a plaintext fmsgk_ value or an OpenClaw SecretRef.",
            sensitive: true,
        },
        apiUrl: {
            label: "fmsg API URL",
            help: "Required base URL for your fmsg Web API deployment.",
        },
        homeChannel: {
            label: "Home fmsg address",
            help: "Owner address in @user@domain form.",
        },
    },
});
export function rawFmsgConfig(cfg) {
    return cfg.channels?.fmsg ?? {};
}
export function normalizeFmsgApiUrl(value) {
    const normalized = value.trim().replace(/\/+$/u, "");
    if (!normalized)
        return undefined;
    try {
        const url = new URL(normalized);
        if (url.protocol !== "http:" && url.protocol !== "https:")
            return undefined;
        return normalized;
    }
    catch {
        return undefined;
    }
}
function envBoolean(value) {
    if (value === undefined || value.trim() === "")
        return undefined;
    if (/^(1|true|yes|on)$/iu.test(value.trim()))
        return true;
    if (/^(0|false|no|off)$/iu.test(value.trim()))
        return false;
    throw new Error("FMSG_ALLOW_ALL_USERS must be true or false");
}
function envInteger(name, value, minimum) {
    if (value === undefined || value.trim() === "")
        return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        throw new Error(`${name} must be an integer >= ${minimum}`);
    }
    return parsed;
}
export function normalizeFmsgAddress(value) {
    const normalized = value.trim().toLowerCase();
    return /^@[^@\s]+@[^@\s]+$/u.test(normalized) ? normalized : undefined;
}
function normalizeAddressList(values) {
    const unique = new Set();
    for (const value of values) {
        const address = normalizeFmsgAddress(value);
        if (!address)
            throw new Error(`Invalid fmsg address: ${value}`);
        unique.add(address);
    }
    return [...unique];
}
export function resolveFmsgConfig(cfg, env = process.env) {
    const raw = rawFmsgConfig(cfg);
    const envAllowed = env.FMSG_ALLOWED_USERS?.split(",").map((value) => value.trim()).filter(Boolean);
    const apiUrlRaw = env.FMSG_API_URL?.trim() || raw.apiUrl?.trim();
    const apiUrl = apiUrlRaw ? normalizeFmsgApiUrl(apiUrlRaw) : undefined;
    if (apiUrlRaw && !apiUrl)
        throw new Error(`Invalid fmsg apiUrl: ${apiUrlRaw}`);
    const apiKey = env.FMSG_API_KEY?.trim() ||
        normalizeResolvedSecretInputString({
            value: raw.apiKey,
            path: "channels.fmsg.apiKey",
        });
    if (apiKey && !apiKey.startsWith("fmsgk_")) {
        throw new Error("fmsg apiKey must start with fmsgk_");
    }
    const homeRaw = env.FMSG_HOME_CHANNEL?.trim() || raw.homeChannel?.trim();
    const homeChannel = homeRaw ? normalizeFmsgAddress(homeRaw) : undefined;
    if (homeRaw && !homeChannel)
        throw new Error(`Invalid fmsg homeChannel: ${homeRaw}`);
    return {
        ...(apiUrl ? { apiUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(homeChannel ? { homeChannel } : {}),
        allowedUsers: normalizeAddressList(envAllowed ?? raw.allowedUsers ?? []),
        allowAllUsers: envBoolean(env.FMSG_ALLOW_ALL_USERS) ?? raw.allowAllUsers ?? false,
        maxAgentTurnsPerThread: envInteger("FMSG_MAX_AGENT_TURNS_PER_THREAD", env.FMSG_MAX_AGENT_TURNS_PER_THREAD, 0) ??
            raw.maxAgentTurnsPerThread ??
            DEFAULT_MAX_AGENT_TURNS,
        agentTurnWindowMs: envInteger("FMSG_AGENT_TURN_WINDOW_MS", env.FMSG_AGENT_TURN_WINDOW_MS, 1) ??
            raw.agentTurnWindowMs ??
            DEFAULT_AGENT_TURN_WINDOW_MS,
        mediaMaxBytes: raw.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES,
    };
}
export function resolveEffectiveAllowedUsers(config) {
    if (config.allowedUsers.length > 0)
        return { users: config.allowedUsers, seededFromHome: false };
    if (config.homeChannel)
        return { users: [config.homeChannel], seededFromHome: true };
    return { users: [], seededFromHome: false };
}
export function isFmsgSenderAllowed(config, sender) {
    if (config.allowAllUsers)
        return true;
    const normalized = normalizeFmsgAddress(sender);
    if (!normalized)
        return false;
    return resolveEffectiveAllowedUsers(config).users.includes(normalized);
}
export function listFmsgAccountIds(cfg) {
    const raw = rawFmsgConfig(cfg);
    return Object.keys(raw).length > 0 || process.env.FMSG_API_KEY || process.env.FMSG_API_URL
        ? ["default"]
        : [];
}
export function resolveFmsgAccount(cfg, accountId) {
    const raw = rawFmsgConfig(cfg);
    const config = resolveFmsgConfig(cfg);
    return {
        accountId: accountId?.trim() || "default",
        enabled: raw.enabled !== false,
        configured: Boolean(config.apiUrl && config.apiKey),
        config,
    };
}
export function hasConfiguredFmsgApiKey(cfg, env = process.env) {
    return Boolean(env.FMSG_API_KEY?.trim()) || hasConfiguredSecretInput(rawFmsgConfig(cfg).apiKey);
}
export function hasConfiguredFmsgApiUrl(cfg, env = process.env) {
    const value = env.FMSG_API_URL?.trim() || rawFmsgConfig(cfg).apiUrl?.trim();
    return Boolean(value && normalizeFmsgApiUrl(value));
}
export function hasConfiguredFmsgHomeChannel(cfg, env = process.env) {
    const value = env.FMSG_HOME_CHANNEL?.trim() || rawFmsgConfig(cfg).homeChannel?.trim();
    return Boolean(value && normalizeFmsgAddress(value));
}

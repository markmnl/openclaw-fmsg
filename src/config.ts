import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  type SecretInput,
} from "openclaw/plugin-sdk/secret-input";

export const DEFAULT_MAX_AGENT_TURNS = 8;
export const DEFAULT_MAX_AGENT_TURNS_PER_ROOT = 20;
export const DEFAULT_MAX_AGENT_TURNS_PER_SENDER = 20;
export const DEFAULT_AGENT_TURN_WINDOW_MS = 60_000;
export const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

export type FmsgChannelConfig = {
  enabled?: boolean;
  apiUrl?: string;
  apiKey?: SecretInput;
  homeChannel?: string;
  allowedUsers?: string[];
  allowAllUsers?: boolean;
  maxAgentTurnsPerThread?: number;
  maxAgentTurnsPerRoot?: number;
  maxAgentTurnsPerSender?: number;
  agentTurnWindowMs?: number;
  mediaMaxBytes?: number;
};

export type ResolvedFmsgAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  config: ResolvedFmsgConfig;
};

export type ResolvedFmsgConfig = {
  apiUrl?: string;
  apiKey?: string;
  homeChannel?: string;
  allowedUsers: string[];
  allowAllUsers: boolean;
  maxAgentTurnsPerThread: number;
  maxAgentTurnsPerRoot: number;
  maxAgentTurnsPerSender: number;
  agentTurnWindowMs: number;
  mediaMaxBytes: number;
};

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
} as const;

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
    maxAgentTurnsPerRoot: {
      type: "integer",
      minimum: 0,
      default: DEFAULT_MAX_AGENT_TURNS_PER_ROOT,
      description: "Automatic OpenClaw turns allowed across all branches of one fmsg root/window; 0 disables this circuit breaker.",
    },
    maxAgentTurnsPerSender: {
      type: "integer",
      minimum: 0,
      default: DEFAULT_MAX_AGENT_TURNS_PER_SENDER,
      description: "Automatic OpenClaw turns allowed for one normalized fmsg sender/window across all roots; 0 disables this circuit breaker.",
    },
    agentTurnWindowMs: {
      type: "integer",
      minimum: 1,
      default: DEFAULT_AGENT_TURN_WINDOW_MS,
      description: "Sliding automatic-turn window in milliseconds shared by branch, root, and sender circuit breakers.",
    },
    mediaMaxBytes: {
      type: "integer",
      minimum: 1,
      default: DEFAULT_MEDIA_MAX_BYTES,
    },
  },
} as const;

export const fmsgChannelConfigSchema: NonNullable<ChannelPlugin["configSchema"]> =
  buildJsonChannelConfigSchema(fmsgChannelJsonSchema, {
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
        help: "Default operator destination and fallback allowlist entry in @user@domain form; this does not grant OpenClaw owner privileges.",
      },
    },
  });

type ConfigWithFmsg = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & { fmsg?: FmsgChannelConfig };
};

export function rawFmsgConfig(cfg: OpenClawConfig): FmsgChannelConfig {
  return (cfg as ConfigWithFmsg).channels?.fmsg ?? {};
}

export function normalizeFmsgApiUrl(value: string): string | undefined {
  const normalized = value.trim().replace(/\/+$/u, "");
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return normalized;
  } catch {
    return undefined;
  }
}

function envBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (/^(1|true|yes|on)$/iu.test(value.trim())) return true;
  if (/^(0|false|no|off)$/iu.test(value.trim())) return false;
  throw new Error("FMSG_ALLOW_ALL_USERS must be true or false");
}

function envInteger(name: string, value: string | undefined, minimum: number): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

export function normalizeFmsgAddress(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return /^@[^@\s]+@[^@\s]+$/u.test(normalized) ? normalized : undefined;
}

function normalizeAddressList(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const address = normalizeFmsgAddress(value);
    if (!address) throw new Error(`Invalid fmsg address: ${value}`);
    unique.add(address);
  }
  return [...unique];
}

export function resolveFmsgConfig(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedFmsgConfig {
  const raw = rawFmsgConfig(cfg);
  const envAllowed = env.FMSG_ALLOWED_USERS?.split(",").map((value) => value.trim()).filter(Boolean);
  const apiUrlRaw = env.FMSG_API_URL?.trim() || raw.apiUrl?.trim();
  const apiUrl = apiUrlRaw ? normalizeFmsgApiUrl(apiUrlRaw) : undefined;
  if (apiUrlRaw && !apiUrl) throw new Error(`Invalid fmsg apiUrl: ${apiUrlRaw}`);
  const apiKey =
    env.FMSG_API_KEY?.trim() ||
    normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "channels.fmsg.apiKey",
    });
  if (apiKey && !apiKey.startsWith("fmsgk_")) {
    throw new Error("fmsg apiKey must start with fmsgk_");
  }
  const homeRaw = env.FMSG_HOME_CHANNEL?.trim() || raw.homeChannel?.trim();
  const homeChannel = homeRaw ? normalizeFmsgAddress(homeRaw) : undefined;
  if (homeRaw && !homeChannel) throw new Error(`Invalid fmsg homeChannel: ${homeRaw}`);

  return {
    ...(apiUrl ? { apiUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(homeChannel ? { homeChannel } : {}),
    allowedUsers: normalizeAddressList(envAllowed ?? raw.allowedUsers ?? []),
    allowAllUsers: envBoolean(env.FMSG_ALLOW_ALL_USERS) ?? raw.allowAllUsers ?? false,
    maxAgentTurnsPerThread:
      envInteger("FMSG_MAX_AGENT_TURNS_PER_THREAD", env.FMSG_MAX_AGENT_TURNS_PER_THREAD, 0) ??
      raw.maxAgentTurnsPerThread ??
      DEFAULT_MAX_AGENT_TURNS,
    maxAgentTurnsPerRoot:
      envInteger("FMSG_MAX_AGENT_TURNS_PER_ROOT", env.FMSG_MAX_AGENT_TURNS_PER_ROOT, 0) ??
      raw.maxAgentTurnsPerRoot ??
      DEFAULT_MAX_AGENT_TURNS_PER_ROOT,
    maxAgentTurnsPerSender:
      envInteger("FMSG_MAX_AGENT_TURNS_PER_SENDER", env.FMSG_MAX_AGENT_TURNS_PER_SENDER, 0) ??
      raw.maxAgentTurnsPerSender ??
      DEFAULT_MAX_AGENT_TURNS_PER_SENDER,
    agentTurnWindowMs:
      envInteger("FMSG_AGENT_TURN_WINDOW_MS", env.FMSG_AGENT_TURN_WINDOW_MS, 1) ??
      raw.agentTurnWindowMs ??
      DEFAULT_AGENT_TURN_WINDOW_MS,
    mediaMaxBytes: raw.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES,
  };
}

export function resolveEffectiveAllowedUsers(config: ResolvedFmsgConfig): {
  users: string[];
  seededFromHome: boolean;
} {
  if (config.allowedUsers.length > 0) return { users: config.allowedUsers, seededFromHome: false };
  if (config.homeChannel) return { users: [config.homeChannel], seededFromHome: true };
  return { users: [], seededFromHome: false };
}

export function isFmsgSenderAllowed(config: ResolvedFmsgConfig, sender: string): boolean {
  if (config.allowAllUsers) return true;
  const normalized = normalizeFmsgAddress(sender);
  if (!normalized) return false;
  return resolveEffectiveAllowedUsers(config).users.includes(normalized);
}

export function listFmsgAccountIds(cfg: OpenClawConfig): string[] {
  const raw = rawFmsgConfig(cfg);
  return Object.keys(raw).length > 0 || process.env.FMSG_API_KEY || process.env.FMSG_API_URL
    ? ["default"]
    : [];
}

export function resolveFmsgAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedFmsgAccount {
  const raw = rawFmsgConfig(cfg);
  const config = resolveFmsgConfig(cfg);
  return {
    accountId: accountId?.trim() || "default",
    enabled: raw.enabled !== false,
    configured: Boolean(config.apiUrl && config.apiKey),
    config,
  };
}

export function hasConfiguredFmsgApiKey(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.FMSG_API_KEY?.trim()) || hasConfiguredSecretInput(rawFmsgConfig(cfg).apiKey);
}

export function hasConfiguredFmsgApiUrl(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.FMSG_API_URL?.trim() || rawFmsgConfig(cfg).apiUrl?.trim();
  return Boolean(value && normalizeFmsgApiUrl(value));
}

export function hasConfiguredFmsgHomeChannel(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.FMSG_HOME_CHANNEL?.trim() || rawFmsgConfig(cfg).homeChannel?.trim();
  return Boolean(value && normalizeFmsgAddress(value));
}

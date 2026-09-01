import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";

export const DEFAULT_API_URL = "https://api.fmsg.io";
export const DEFAULT_MAX_AGENT_TURNS = 8;
export const DEFAULT_AGENT_TURN_WINDOW_MS = 60_000;
export const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

export type FmsgChannelConfig = {
  enabled?: boolean;
  apiUrl?: string;
  apiKey?: string;
  homeChannel?: string;
  allowedUsers?: string[];
  allowAllUsers?: boolean;
  maxAgentTurnsPerThread?: number;
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
  apiUrl: string;
  apiKey?: string;
  homeChannel?: string;
  allowedUsers: string[];
  allowAllUsers: boolean;
  maxAgentTurnsPerThread: number;
  agentTurnWindowMs: number;
  mediaMaxBytes: number;
};

export const fmsgChannelJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean", default: true },
    apiUrl: { type: "string", format: "uri", default: DEFAULT_API_URL },
    apiKey: { type: "string", pattern: "^fmsgk_" },
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
} as const;

export const fmsgChannelConfigSchema: NonNullable<ChannelPlugin["configSchema"]> =
  buildJsonChannelConfigSchema(fmsgChannelJsonSchema);

type ConfigWithFmsg = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & { fmsg?: FmsgChannelConfig };
};

function rawFmsgConfig(cfg: OpenClawConfig): FmsgChannelConfig {
  return (cfg as ConfigWithFmsg).channels?.fmsg ?? {};
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
  const apiUrl = (env.FMSG_API_URL?.trim() || raw.apiUrl?.trim() || DEFAULT_API_URL).replace(/\/+$/u, "");
  const apiKey = env.FMSG_API_KEY?.trim() || raw.apiKey?.trim() || undefined;
  const homeRaw = env.FMSG_HOME_CHANNEL?.trim() || raw.homeChannel?.trim();
  const homeChannel = homeRaw ? normalizeFmsgAddress(homeRaw) : undefined;
  if (homeRaw && !homeChannel) throw new Error(`Invalid fmsg homeChannel: ${homeRaw}`);

  return {
    apiUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(homeChannel ? { homeChannel } : {}),
    allowedUsers: normalizeAddressList(envAllowed ?? raw.allowedUsers ?? []),
    allowAllUsers: envBoolean(env.FMSG_ALLOW_ALL_USERS) ?? raw.allowAllUsers ?? false,
    maxAgentTurnsPerThread:
      envInteger("FMSG_MAX_AGENT_TURNS_PER_THREAD", env.FMSG_MAX_AGENT_TURNS_PER_THREAD, 0) ??
      raw.maxAgentTurnsPerThread ??
      DEFAULT_MAX_AGENT_TURNS,
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
  return Object.keys(raw).length > 0 || process.env.FMSG_API_KEY ? ["default"] : [];
}

export function resolveFmsgAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedFmsgAccount {
  const raw = rawFmsgConfig(cfg);
  const config = resolveFmsgConfig(cfg);
  return {
    accountId: accountId?.trim() || "default",
    enabled: raw.enabled !== false,
    configured: Boolean(config.apiKey),
    config,
  };
}

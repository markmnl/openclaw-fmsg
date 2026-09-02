import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { type SecretInput } from "openclaw/plugin-sdk/secret-input";
export declare const DEFAULT_MAX_AGENT_TURNS = 8;
export declare const DEFAULT_MAX_AGENT_TURNS_PER_ROOT = 20;
export declare const DEFAULT_MAX_AGENT_TURNS_PER_SENDER = 20;
export declare const DEFAULT_AGENT_TURN_WINDOW_MS = 60000;
export declare const DEFAULT_MEDIA_MAX_BYTES: number;
export declare const DEFAULT_REACTION_NOTIFICATIONS = "own";
export type FmsgReactionNotificationMode = "off" | "own" | "all";
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
    actions?: {
        reactions?: boolean;
    };
    reactionNotifications?: FmsgReactionNotificationMode;
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
    actions: {
        reactions: boolean;
    };
    reactionNotifications: FmsgReactionNotificationMode;
};
export declare const secretInputJsonSchema: {
    readonly oneOf: readonly [{
        readonly type: "string";
        readonly minLength: 1;
    }, {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly required: readonly ["source", "provider", "id"];
        readonly properties: {
            readonly source: {
                readonly type: "string";
                readonly enum: readonly ["env", "file", "exec", "store"];
            };
            readonly provider: {
                readonly type: "string";
                readonly minLength: 1;
            };
            readonly id: {
                readonly type: "string";
                readonly minLength: 1;
            };
        };
    }];
};
export declare const fmsgChannelJsonSchema: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly enabled: {
            readonly type: "boolean";
            readonly default: true;
        };
        readonly apiUrl: {
            readonly type: "string";
            readonly format: "uri";
            readonly pattern: "^https?://";
            readonly description: "Explicit fmsg Web API base URL; no hosted endpoint is assumed.";
        };
        readonly apiKey: {
            readonly description: "fmsg API key or OpenClaw SecretRef. FMSG_API_KEY takes precedence.";
            readonly oneOf: readonly [{
                readonly type: "string";
                readonly minLength: 1;
            }, {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["source", "provider", "id"];
                readonly properties: {
                    readonly source: {
                        readonly type: "string";
                        readonly enum: readonly ["env", "file", "exec", "store"];
                    };
                    readonly provider: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly id: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                };
            }];
        };
        readonly homeChannel: {
            readonly type: "string";
            readonly pattern: "^@[^@\\s]+@[^@\\s]+$";
        };
        readonly allowedUsers: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
                readonly pattern: "^@[^@\\s]+@[^@\\s]+$";
            };
            readonly default: readonly [];
        };
        readonly allowAllUsers: {
            readonly type: "boolean";
            readonly default: false;
        };
        readonly maxAgentTurnsPerThread: {
            readonly type: "integer";
            readonly minimum: 0;
            readonly default: 8;
            readonly description: "Automatic OpenClaw turns allowed per fmsg branch/window; 0 disables the circuit breaker.";
        };
        readonly maxAgentTurnsPerRoot: {
            readonly type: "integer";
            readonly minimum: 0;
            readonly default: 20;
            readonly description: "Automatic OpenClaw turns allowed across all branches of one fmsg root/window; 0 disables this circuit breaker.";
        };
        readonly maxAgentTurnsPerSender: {
            readonly type: "integer";
            readonly minimum: 0;
            readonly default: 20;
            readonly description: "Automatic OpenClaw turns allowed for one normalized fmsg sender/window across all roots; 0 disables this circuit breaker.";
        };
        readonly agentTurnWindowMs: {
            readonly type: "integer";
            readonly minimum: 1;
            readonly default: 60000;
            readonly description: "Sliding automatic-turn window in milliseconds shared by branch, root, and sender circuit breakers.";
        };
        readonly mediaMaxBytes: {
            readonly type: "integer";
            readonly minimum: 1;
            readonly default: number;
        };
        readonly actions: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly reactions: {
                    readonly type: "boolean";
                    readonly default: true;
                    readonly description: "Allow the shared OpenClaw message tool to add, change, clear, and list fmsg reactions.";
                };
            };
            readonly default: {
                readonly reactions: true;
            };
        };
        readonly reactionNotifications: {
            readonly type: "string";
            readonly enum: readonly ["off", "own", "all"];
            readonly default: "own";
            readonly description: "Surface no reactions, reactions to agent-authored messages, or reactions to all known messages.";
        };
    };
};
export declare const fmsgChannelConfigSchema: NonNullable<ChannelPlugin["configSchema"]>;
export declare function rawFmsgConfig(cfg: OpenClawConfig): FmsgChannelConfig;
export declare function normalizeFmsgApiUrl(value: string): string | undefined;
export declare function normalizeFmsgAddress(value: string): string | undefined;
export declare function resolveFmsgConfig(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): ResolvedFmsgConfig;
export declare function resolveEffectiveAllowedUsers(config: ResolvedFmsgConfig): {
    users: string[];
    seededFromHome: boolean;
};
export declare function isFmsgSenderAllowed(config: ResolvedFmsgConfig, sender: string): boolean;
export declare function listFmsgAccountIds(cfg: OpenClawConfig): string[];
export declare function resolveFmsgAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedFmsgAccount;
export declare function hasConfiguredFmsgApiKey(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): boolean;
export declare function hasConfiguredFmsgApiUrl(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): boolean;
export declare function hasConfiguredFmsgHomeChannel(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): boolean;

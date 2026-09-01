import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  baseUrlTextInput,
  defineChannelSetupContract,
  defineTokenCredential,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/channel-setup";
import { hasConfiguredSecretInput, normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  hasConfiguredFmsgApiKey,
  hasConfiguredFmsgApiUrl,
  hasConfiguredFmsgHomeChannel,
  normalizeFmsgAddress,
  normalizeFmsgApiUrl,
  rawFmsgConfig,
  type FmsgChannelConfig,
} from "./config.js";

type FmsgSetupInput = {
  apiUrl?: string;
  apiKey?: string;
  homeChannel?: string;
};

function patchFmsgConfig(
  cfg: OpenClawConfig,
  patch: Partial<FmsgChannelConfig>,
  clearFields: readonly (keyof FmsgChannelConfig)[] = [],
): OpenClawConfig {
  const current = { ...rawFmsgConfig(cfg) };
  for (const field of clearFields) delete current[field];
  const next = { ...current, ...patch, enabled: true };
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      fmsg: next,
    },
  } as OpenClawConfig;
}

function validateApiUrl(value: string): string | undefined {
  return normalizeFmsgApiUrl(value)
    ? undefined
    : "Enter an absolute fmsg Web API URL beginning with http:// or https://";
}

function validateHomeChannel(value: string): string | undefined {
  return normalizeFmsgAddress(value)
    ? undefined
    : "Enter an fmsg address in @user@domain form";
}

export const fmsgSetupContract: NonNullable<ChannelPlugin["setupContract"]> =
  defineChannelSetupContract({
    fields: {
      apiUrl: {
        kind: "string",
        cli: { flags: "--api-url <url>", description: "fmsg Web API base URL" },
      },
      apiKey: {
        kind: "string",
        sensitive: true,
        cli: { flags: "--api-key <key>", description: "fmsg API key" },
      },
      homeChannel: {
        kind: "string",
        cli: {
          flags: "--home-channel <address>",
          description: "Home fmsg @user@domain address",
        },
      },
    },
    adapter: {
      singleAccountKeysToMove: [],
      validateInput: ({ input }) => {
        const setup = input as FmsgSetupInput;
        if (setup.apiUrl && validateApiUrl(setup.apiUrl)) {
          return validateApiUrl(setup.apiUrl) ?? null;
        }
        if (setup.apiKey && !setup.apiKey.trim().startsWith("fmsgk_")) {
          return "fmsg API keys must start with fmsgk_";
        }
        if (setup.homeChannel && validateHomeChannel(setup.homeChannel)) {
          return validateHomeChannel(setup.homeChannel) ?? null;
        }
        return null;
      },
      applyAccountConfig: ({ cfg, input }) => {
        const setup = input as FmsgSetupInput;
        return patchFmsgConfig(cfg, {
          ...(setup.apiUrl ? { apiUrl: normalizeFmsgApiUrl(setup.apiUrl) } : {}),
          ...(setup.apiKey ? { apiKey: setup.apiKey.trim() } : {}),
          ...(setup.homeChannel ? { homeChannel: normalizeFmsgAddress(setup.homeChannel) } : {}),
        });
      },
    },
  });

type SetupAccount = {
  configured: boolean;
  config: FmsgChannelConfig;
};

function resolveSetupAccount(cfg: OpenClawConfig): SetupAccount {
  return {
    configured:
      hasConfiguredFmsgApiKey(cfg) &&
      hasConfiguredFmsgApiUrl(cfg) &&
      hasConfiguredFmsgHomeChannel(cfg),
    config: rawFmsgConfig(cfg),
  };
}

export const fmsgSetupWizard: ChannelSetupWizard = {
  channel: "fmsg",
  status: {
    configuredLabel: "fmsg configured",
    unconfiguredLabel: "fmsg needs an API URL, API key, and home address",
    resolveConfigured: ({ cfg }) =>
      hasConfiguredFmsgApiKey(cfg) &&
      hasConfiguredFmsgApiUrl(cfg) &&
      hasConfiguredFmsgHomeChannel(cfg),
    resolveStatusLines: ({ cfg }) => {
      const lines: string[] = [];
      if (!hasConfiguredFmsgApiUrl(cfg)) lines.push("fmsg API URL is required; no endpoint is assumed.");
      if (!hasConfiguredFmsgApiKey(cfg)) lines.push("fmsg API key or SecretRef is required.");
      if (!hasConfiguredFmsgHomeChannel(cfg)) {
        lines.push("Home fmsg address has not been configured.");
      }
      if (process.env.FMSG_API_KEY?.trim() && typeof rawFmsgConfig(cfg).apiKey === "object") {
        lines.push("FMSG_API_KEY is active and shadows the configured fmsg SecretRef.");
      }
      return lines;
    },
  },
  stepOrder: "text-first",
  textInputs: [
    baseUrlTextInput({
      inputKey: "apiUrl",
      configKey: "apiUrl",
      message: "Enter the fmsg Web API URL:",
      placeholder: "https://fmsg-api.example.com",
      required: true,
      confirmCurrentValue: true,
      keepPrompt: (value) => `Keep current fmsg API URL ${value}?`,
      resolveAccount: ({ cfg }) => resolveSetupAccount(cfg),
      currentValue: (account) =>
        account.config.apiUrl?.trim() || process.env.FMSG_API_URL?.trim() || undefined,
      validate: validateApiUrl,
      normalize: (value) => normalizeFmsgApiUrl(value) ?? value.trim(),
      patchAccount: ({ cfg, patch }) => patchFmsgConfig(cfg, patch),
    }),
    {
      inputKey: "homeChannel",
      message: "Enter the home fmsg address:",
      placeholder: "@owner@example.com",
      required: true,
      confirmCurrentValue: true,
      keepPrompt: (value) => `Keep current home fmsg address ${value}?`,
      currentValue: ({ cfg }) =>
        rawFmsgConfig(cfg).homeChannel?.trim() || process.env.FMSG_HOME_CHANNEL?.trim() || undefined,
      validate: ({ value }) => validateHomeChannel(value),
      normalizeValue: ({ value }) => normalizeFmsgAddress(value) ?? value.trim(),
      applySet: ({ cfg, value }) =>
        patchFmsgConfig(cfg, { homeChannel: normalizeFmsgAddress(value) ?? value.trim() }),
    },
  ],
  credentials: [
    defineTokenCredential({
      inputKey: "apiKey",
      configKey: "apiKey",
      providerHint: "fmsg",
      credentialLabel: "fmsg API key",
      preferredEnvVar: "FMSG_API_KEY",
      helpTitle: "fmsg API key",
      helpLines: [
        "Use an fmsgk_ API key or choose an OpenClaw SecretRef.",
        "The sender address is derived from the JWT returned by the configured fmsg Web API.",
      ],
      envPrompt: "Use FMSG_API_KEY from the Gateway environment?",
      keepPrompt: "Keep the currently configured fmsg API key?",
      inputPrompt: "Enter the fmsg API key:",
      allowEnv: () => Boolean(process.env.FMSG_API_KEY?.trim()),
      resolveAccount: ({ cfg }) => resolveSetupAccount(cfg),
      accountConfigured: (account) => account.configured,
      hasConfiguredValue: (account) => hasConfiguredSecretInput(account.config.apiKey),
      resolvedValue: (account) => {
        const value = normalizeSecretInputString(account.config.apiKey);
        return value?.startsWith("fmsgk_") ? value : undefined;
      },
      envValue: () => process.env.FMSG_API_KEY?.trim() || undefined,
      patchAccount: ({ cfg, mode, patch, clearFields }) =>
        patchFmsgConfig(
          cfg,
          patch,
          mode === "env" ? ["apiKey"] : (clearFields as (keyof FmsgChannelConfig)[]),
        ),
      set: { value: "input", clearFields: ["apiKey"] },
      useEnv: { clearFields: ["apiKey"] },
    }),
  ],
  finalize: async ({ cfg, prompter }) => {
    const home = rawFmsgConfig(cfg).homeChannel?.trim() || process.env.FMSG_HOME_CHANNEL?.trim();
    const normalized = home ? normalizeFmsgAddress(home) : undefined;
    if (!normalized) return;
    const ownerEntry = `fmsg:${normalized}`;
    const owners = cfg.commands?.ownerAllowFrom ?? [];
    if (owners.some((entry) => String(entry).toLowerCase() === ownerEntry)) return;
    const grantOwner = await prompter.confirm({
      message: `Allow ${normalized} to use privileged OpenClaw owner commands over fmsg?`,
      initialValue: false,
    });
    if (!grantOwner) return;
    return {
      cfg: {
        ...cfg,
        commands: {
          ...cfg.commands,
          ownerAllowFrom: [...owners, ownerEntry],
        },
      },
    };
  },
  disable: (cfg) => setSetupChannelEnabled(cfg, "fmsg", false),
};

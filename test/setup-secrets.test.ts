import { describe, expect, it } from "vitest";
import setupEntry from "../setup-entry.js";
import { fmsgChannelPlugin } from "../src/channel.js";
import { fmsgChannelSecrets } from "../src/secret-contract.js";
import { fmsgSetupContract, fmsgSetupWizard } from "../src/setup.js";
import {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "../secret-contract-api.js";

describe("fmsg setup and SecretRef integration", () => {
  it("exports the channel through the lightweight setup entry", () => {
    expect(setupEntry.plugin).toBe(fmsgChannelPlugin);
    expect(fmsgChannelPlugin.setupContract).toBe(fmsgSetupContract);
    expect(fmsgChannelPlugin.setupWizard).toBe(fmsgSetupWizard);
    expect(fmsgChannelPlugin.secrets).toBe(fmsgChannelSecrets);
  });

  it("registers channels.fmsg.apiKey for secrets commands", () => {
    expect(collectRuntimeConfigAssignments).toBe(
      fmsgChannelSecrets.collectRuntimeConfigAssignments,
    );
    expect(secretTargetRegistryEntries).toBe(
      fmsgChannelSecrets.secretTargetRegistryEntries,
    );
    expect(fmsgChannelSecrets.secretTargetRegistryEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          configFile: "openclaw.json",
          pathPattern: "channels.fmsg.apiKey",
          secretShape: "secret_input",
          expectedResolvedValue: "string",
          includeInPlan: true,
          includeInConfigure: true,
          includeInAudit: true,
        }),
      ]),
    );
  });

  it("collects an active SecretRef for runtime resolution", () => {
    const config = {
      channels: {
        fmsg: {
          enabled: true,
          apiKey: { source: "env", provider: "default", id: "FMSG_API_KEY" },
        },
      },
    };
    const context = {
      sourceConfig: config,
      env: {},
      cache: {},
      warnings: [],
      warningKeys: new Set<string>(),
      assignments: [],
    };
    fmsgChannelSecrets.collectRuntimeConfigAssignments?.({
      config: config as never,
      context: context as never,
      defaults: undefined,
    });
    expect(context.assignments).toHaveLength(1);
    expect(context.assignments[0]).toMatchObject({ path: "channels.fmsg.apiKey" });
  });

  it("marks the configured SecretRef inactive when FMSG_API_KEY wins", () => {
    const config = {
      channels: {
        fmsg: {
          enabled: true,
          apiKey: { source: "file", provider: "mounted-json", id: "/fmsg/apiKey" },
        },
      },
    };
    const context = {
      sourceConfig: config,
      env: { FMSG_API_KEY: "fmsgk_environment" },
      cache: {},
      warnings: [],
      warningKeys: new Set<string>(),
      assignments: [],
    };
    fmsgChannelSecrets.collectRuntimeConfigAssignments?.({
      config: config as never,
      context: context as never,
      defaults: undefined,
    });
    expect(context.assignments).toHaveLength(0);
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE" }),
      ]),
    );
  });

  it("prompts for and writes an explicit API URL and home address", async () => {
    const apiUrl = fmsgSetupWizard.textInputs?.find((input) => input.inputKey === "apiUrl");
    const home = fmsgSetupWizard.textInputs?.find((input) => input.inputKey === "homeChannel");
    expect(apiUrl?.required).toBe(true);
    expect(home?.required).toBe(true);
    expect(apiUrl?.validate?.({
      value: "not-a-url",
      cfg: {} as never,
      accountId: "default",
      credentialValues: {},
    })).toContain("absolute fmsg Web API URL");
    expect(home?.validate?.({
      value: "owner",
      cfg: {} as never,
      accountId: "default",
      credentialValues: {},
    })).toContain("@user@domain");

    const normalizedApiUrl = apiUrl?.normalizeValue?.({
      value: "https://fmsg-api.example.com/",
      cfg: {} as never,
      accountId: "default",
      credentialValues: {},
    });
    expect(normalizedApiUrl).toBe("https://fmsg-api.example.com");
    const withUrl = await apiUrl?.applySet?.({
      cfg: {} as never,
      accountId: "default",
      value: normalizedApiUrl ?? "",
    });
    const configured = await home?.applySet?.({
      cfg: withUrl as never,
      accountId: "default",
      value: "@Owner@Example.com",
    });
    expect((configured?.channels as never as { fmsg: Record<string, unknown> }).fmsg).toMatchObject({
      enabled: true,
      apiUrl: "https://fmsg-api.example.com",
      homeChannel: "@owner@example.com",
    });
  });

  it("stores the SecretRef rather than its resolved value", async () => {
    const credential = fmsgSetupWizard.credentials[0];
    const ref = { source: "env", provider: "default", id: "FMSG_API_KEY" };
    const configured = await credential?.applySet?.({
      cfg: {
        channels: { fmsg: { apiUrl: "https://fmsg-api.example.com" } },
      } as never,
      accountId: "default",
      credentialValues: {},
      value: ref,
      resolvedValue: "fmsgk_resolved",
    });
    expect((configured?.channels as never as { fmsg: Record<string, unknown> }).fmsg.apiKey).toEqual(ref);
  });

  it("offers owner authority as an explicit opt-in", async () => {
    const base = {
      channels: { fmsg: { homeChannel: "@owner@example.com" } },
    } as never;
    const declined = await fmsgSetupWizard.finalize?.({
      cfg: base,
      accountId: "default",
      credentialValues: {},
      runtime: {} as never,
      prompter: { confirm: async () => false } as never,
      forceAllowFrom: false,
    });
    expect(declined).toBeUndefined();

    const accepted = await fmsgSetupWizard.finalize?.({
      cfg: base,
      accountId: "default",
      credentialValues: {},
      runtime: {} as never,
      prompter: { confirm: async () => true } as never,
      forceAllowFrom: false,
    });
    expect(accepted?.cfg?.commands?.ownerAllowFrom).toContain("fmsg:@owner@example.com");
  });
});

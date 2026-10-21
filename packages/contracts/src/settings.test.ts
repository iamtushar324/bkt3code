import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_MODEL } from "./model.ts";
import * as Schema from "effect/Schema";

import { type CommandId, ProjectId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  requiredScopesForProjectMutation,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("storage cleanup settings", () => {
  it("keeps cleanup disabled for existing installations", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "uncommitted-changes" },
    });
  });

  it("decodes older custom rules with the default local-file policy", () => {
    const settings = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 8,
          worktreeOnMerge: false,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    });
    expect(settings.worktreeCleanup).toMatchObject({
      rules: { worktreeKeepWhen: "uncommitted-changes" },
    });
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } }),
    ).toEqual({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } });
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
  });
});

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
  });
});

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });
});

describe("ClientSettings phase-grouped sidebar", () => {
  it("defaults the experiment off for legacy settings", () => {
    expect(decodeClientSettings({}).phaseGroupedSidebarEnabled).toBe(false);
    expect(decodeServerSettings({}).experimental.externalMcp).toEqual({
      enabled: false,
      apiKey: "",
      publicUrl: "",
    });
  });

  it("accepts persisted values and client patches", () => {
    expect(
      decodeClientSettings({ phaseGroupedSidebarEnabled: true }).phaseGroupedSidebarEnabled,
    ).toBe(true);
    expect(
      decodeClientSettingsPatch({ phaseGroupedSidebarEnabled: true }).phaseGroupedSidebarEnabled,
    ).toBe(true);
  });
});

// T3-CUSTOM(expbkt3): BEGIN — the fork keeps plan mode as a first-class feature.
// Upstream retired it behind an off-by-default flag; these lock the fork default
// so a later upstream merge cannot silently switch plan mode off again.
describe("ClientSettings plan mode", () => {
  it("defaults plan mode on", () => {
    expect(decodeClientSettings({}).planModeAvailable).toBe(true);
  });

  it("drops upstream's retired planModeEnabled key, resetting everyone to on", () => {
    const decoded = decodeClientSettings({ planModeEnabled: false });
    expect(decoded.planModeAvailable).toBe(true);
    expect(decoded).not.toHaveProperty("planModeEnabled");
  });

  it("preserves an explicit opt-out", () => {
    expect(decodeClientSettings({ planModeAvailable: false }).planModeAvailable).toBe(false);
    expect(decodeClientSettingsPatch({ planModeAvailable: false }).planModeAvailable).toBe(false);
  });
});
// T3-CUSTOM(expbkt3): END

// T3-CUSTOM(expbkt3): settings.json on long-lived fork servers still carries
// keys for retired fork features (catch-up and work summaries). They must keep
// decoding and simply drop out.
describe("ServerSettings retired fork keys", () => {
  it("decodes and drops experimental.sessionSummary and sessionWorkSummary", () => {
    const settings = decodeServerSettings({
      experimental: {
        sessionSummary: { enabled: true, dataLimitChars: 24_000 },
        sessionWorkSummary: { enabled: true, maxWords: 60 },
      },
    });
    expect(settings.experimental).not.toHaveProperty("sessionSummary");
    expect(settings.experimental).not.toHaveProperty("sessionWorkSummary");
  });
});

describe("provider enabled defaults", () => {
  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
  });

  // T3-CUSTOM(expbkt3): the fork adds new-thread model, access, and interaction defaults.
  it("defaults start-from-origin on for legacy configs", () => {
    const settings = decodeServerSettings({});

    expect(settings.newWorktreesStartFromOrigin).toBe(true);
    expect(settings.defaultThreadModelSelection).toEqual({
      instanceId: "codex",
      // T3-CUSTOM(expbkt3): read the constant rather than a literal so an upstream
      // default-model bump stops failing this fork test on every merge.
      model: DEFAULT_MODEL,
    });
    expect(settings.defaultThreadRuntimeMode).toBe("full-access");
    expect(settings.defaultThreadInteractionMode).toBe("default");
  });

  it("accepts thread model, access, and interaction default updates", () => {
    const patch = decodeServerSettingsPatch({
      defaultThreadModelSelection: {
        instanceId: "claudeAgent",
        model: "claude-opus-5",
        options: [{ id: "effort", value: "high" }],
      },
      defaultThreadRuntimeMode: "approval-required",
      defaultThreadInteractionMode: "plan",
    });

    expect(patch.defaultThreadModelSelection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5",
      options: [{ id: "effort", value: "high" }],
    });
    expect(patch.defaultThreadRuntimeMode).toBe("approval-required");
    expect(patch.defaultThreadInteractionMode).toBe("plan");
  });
});

describe("ServerSettings source-control profiles", () => {
  it("defaults legacy installations to machine identity with no profiles", () => {
    const settings = decodeServerSettings({});

    expect(settings.sourceControlIdentityMode).toBe("machine");
    expect(settings.environmentUserIdentityMode).toBe("optional");
    expect(settings.sourceControlProfiles).toEqual({});
  });

  it("never retains credentials in profile metadata or serialized settings", () => {
    const secret = "github_pat_must_not_be_serialized";
    const settings = decodeServerSettings({
      sourceControlIdentityMode: "thread-profile",
      sourceControlProfiles: {
        alice: {
          id: "alice",
          provider: "github",
          label: "Alice",
          login: "alice",
          accountId: 42,
          avatarUrl: null,
          gitName: "Alice Example",
          gitEmail: "42+alice@users.noreply.github.com",
          archived: false,
          credential: secret,
          credentialStatus: "connected",
        },
      },
    });

    const [profile] = Object.values(settings.sourceControlProfiles);
    expect(profile?.ownerUserId).toBeNull();
    expect(profile).not.toHaveProperty("credential");
    expect(profile).not.toHaveProperty("credentialStatus");
    expect(JSON.stringify(encodeServerSettings(settings))).not.toContain(secret);
  });

  it("persists the collaborative Clerk identity mode and profile owner", () => {
    const settings = decodeServerSettings({
      environmentUserIdentityMode: "required",
      sourceControlProfiles: {
        alice: {
          id: "alice",
          provider: "github",
          label: "Alice",
          login: "alice",
          accountId: 42,
          avatarUrl: null,
          gitName: "Alice Example",
          gitEmail: "42+alice@users.noreply.github.com",
          ownerUserId: "user_clerk_alice",
          archived: false,
        },
      },
    });

    expect(settings.environmentUserIdentityMode).toBe("required");
    expect(Object.values(settings.sourceControlProfiles)[0]?.ownerUserId).toBe("user_clerk_alice");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("ServerSettings environment icon", () => {
  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });
});

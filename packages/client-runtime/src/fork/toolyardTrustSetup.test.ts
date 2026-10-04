/** T3-CUSTOM(expbkt3): Explicit browser trust setup stays public, bounded and identity scoped. */
import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { PersonalMcpSettingsError } from "@t3tools/contracts";
import {
  createToolyardSettingsContinuation,
  readToolyardSettingsContinuation,
  toolyardCommittedDraftMatches,
  toolyardSettingsFailureCode,
  toolyardSettingsFailureMessage,
} from "./toolyardTrustSetup.ts";
const now = 1_800_000_000_000;
const draft = { baseUrl: "https://toolyard.test", enabled: true, revision: 4 };
const make = () =>
  new URL(
    createToolyardSettingsContinuation("https://stage.test", "env_stage", "user_admin", draft, now),
  );
const read = (
  hash: string,
  environment = "env_stage",
  user = "user_admin",
  origin = "https://stage.test",
  existing: typeof draft | null = null,
  time = now,
) => readToolyardSettingsContinuation(hash, environment, user, origin, existing, time);
describe("Toolyard browser trust setup", () => {
  it("uses only the actual HTTPS environment with a public whitelisted fragment", () => {
    const url = new URL(
      createToolyardSettingsContinuation(
        "https://stage.test",
        "env_stage",
        "user_admin",
        { ...draft, token: "private" } as typeof draft,
        now,
      ),
    );
    expect(url.origin).toBe("https://stage.test");
    expect(url.pathname).toBe("/settings/experiments");
    expect(url.search).toBe("");
    expect(decodeURIComponent(url.hash)).not.toContain("private");
    expect(read(url.hash)?.draft).toEqual(draft);
    expect(read(url.hash)?.message).toContain("No settings changed yet");
    for (const value of ["http://stage.test", "t3code://app", "https://name:password@stage.test"])
      expect(() =>
        createToolyardSettingsContinuation(value, "env_stage", "user_admin", draft, now),
      ).toThrow();
  });
  it.each([
    ["env_other", "user_admin", "https://stage.test"],
    ["env_stage", "user_other", "https://stage.test"],
    ["env_stage", "user_admin", "https://stable.test"],
  ])("refuses another environment/user/origin %s %s %s", (env, user, origin) => {
    expect(read(make().hash, env, user, origin)?.draft).toBeNull();
  });
  it("never overwrites an existing browser draft, including a stale revision", () => {
    expect(
      read(make().hash, "env_stage", "user_admin", "https://stage.test", { ...draft, revision: 1 })
        ?.draft,
    ).toBeNull();
    expect(
      read(make().hash, "env_stage", "user_admin", "https://stage.test", draft)?.message,
    ).toContain("existing browser draft remains");
  });
  it("rejects expired, malformed and oversized links and unbounded drafts", () => {
    expect(
      read(make().hash, "env_stage", "user_admin", "https://stage.test", null, now + 600_000)
        ?.draft,
    ).toBeNull();
    expect(read("#toolyard-settings=%")?.draft).toBeNull();
    expect(read("#toolyard-settings=" + "x".repeat(8192))?.draft).toBeNull();
    expect(read("#other=abc")).toBeNull();
    for (const bad of [
      { ...draft, revision: -1 },
      { ...draft, baseUrl: "https://toolyard.test/path" },
      { ...draft, baseUrl: "https://toolyard.test/?token=abc" },
      { ...draft, baseUrl: "https://" + "a".repeat(2050) },
    ])
      expect(() =>
        createToolyardSettingsContinuation(
          "https://stage.test",
          "env_stage",
          "user_admin",
          bad,
          now,
        ),
      ).toThrow();
  });
  it("recognizes only advanced matching committed settings, preserving uncommitted and different results", () => {
    const status = { ...draft, revision: 5, removed: false };
    expect(toolyardCommittedDraftMatches(draft, status)).toBe(true);
    expect(
      toolyardCommittedDraftMatches(draft, { ...status, baseUrl: "https://toolyard.test/" }),
    ).toBe(true);
    for (const other of [
      { ...status, revision: 4 },
      { ...status, revision: 3 },
      { ...status, enabled: false },
      { ...status, removed: true },
      { ...status, baseUrl: "https://another.test" },
      { ...status, baseUrl: null },
    ])
      expect(toolyardCommittedDraftMatches(draft, other)).toBe(false);
  });
  it("gates continuation on the exact typed server refusal and never reflects unknown text", () => {
    const cause = {
      reasons: [
        {
          _tag: "Fail",
          error: { _tag: "PersonalMcpSettingsError", message: "admin_trust_registration_required" },
        },
      ],
    };
    expect(toolyardSettingsFailureCode(cause)).toBe("admin_trust_registration_required");
    expect(
      toolyardSettingsFailureCode(
        Cause.fail(
          new PersonalMcpSettingsError({
            operation: "Toolyard integration",
            message: "admin_trust_registration_required",
          }),
        ),
      ),
    ).toBe("admin_trust_registration_required");
    expect(
      toolyardSettingsFailureCode({
        reasons: [{ _tag: "Die", defect: "admin_trust_registration_required" }],
      }),
    ).toBeNull();
    expect(
      toolyardSettingsFailureCode({
        reasons: [
          { _tag: "Fail", error: { _tag: "Other", message: "admin_trust_registration_required" } },
        ],
      }),
    ).toBeNull();
    expect(toolyardSettingsFailureMessage("settings_revision_conflict")).toContain(
      "current revision",
    );
    expect(
      toolyardSettingsFailureMessage("required_instance_capabilities_missing:secret"),
    ).not.toContain("secret");
    for (const secret of ["secret bearer abc", "constructor", "toString"])
      expect(toolyardSettingsFailureMessage(secret)).toBe(
        "The settings did not save. Your draft remains. Refresh the server status before another attempt.",
      );
  });
});

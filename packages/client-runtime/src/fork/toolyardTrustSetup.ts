/** T3-CUSTOM(expbkt3): Public settings draft continuation for Clerk-free paired clients. */
export interface ToolyardSettingsDraft {
  baseUrl: string;
  enabled: boolean;
  revision: number;
}
const fragmentPrefix = "#toolyard-settings=";
const maxAge = 10 * 60_000;
interface Continuation {
  version: 1;
  environmentId: string;
  userId: string;
  origin: string;
  expiresAt: number;
  draft: ToolyardSettingsDraft;
}
export function toolyardSettingsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}
function validDraft(value: unknown): value is ToolyardSettingsDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<ToolyardSettingsDraft>;
  if (
    typeof draft.baseUrl !== "string" ||
    draft.baseUrl.length > 2048 ||
    typeof draft.enabled !== "boolean" ||
    !Number.isSafeInteger(draft.revision) ||
    (draft.revision ?? -1) < 0
  )
    return false;
  try {
    const url = new URL(draft.baseUrl);
    return (
      toolyardSettingsOrigin(draft.baseUrl) !== null &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}
export function createToolyardSettingsContinuation(
  environmentUrl: string,
  environmentId: string,
  userId: string,
  draft: ToolyardSettingsDraft,
  now: number,
): string {
  const origin = toolyardSettingsOrigin(environmentUrl);
  if (
    !origin ||
    !validDraft(draft) ||
    !environmentId ||
    environmentId.length > 256 ||
    !userId.startsWith("user_") ||
    userId.length > 256
  )
    throw new Error("The authenticated environment has no valid HTTPS settings destination.");
  const payload: Continuation = {
    version: 1,
    environmentId,
    userId,
    origin,
    expiresAt: now + maxAge,
    draft: { baseUrl: draft.baseUrl, enabled: draft.enabled, revision: draft.revision },
  };
  const fragment = fragmentPrefix + encodeURIComponent(JSON.stringify(payload));
  if (fragment.length > 8192)
    throw new Error("The settings draft is too large for a browser continuation.");
  return `${origin}/settings/experiments${fragment}`;
}
export function readToolyardSettingsContinuation(
  hash: string,
  environmentId: string,
  userId: string,
  origin: string,
  existingDraft: ToolyardSettingsDraft | null,
  now: number,
): { draft: ToolyardSettingsDraft | null; message: string } | null {
  if (!hash.startsWith(fragmentPrefix)) return null;
  if (hash.length > 8192)
    return {
      draft: null,
      message: "The browser setup link is invalid. Start again from the desktop.",
    };
  try {
    const data = JSON.parse(
      decodeURIComponent(hash.slice(fragmentPrefix.length)),
    ) as Partial<Continuation>;
    if (
      data.version !== 1 ||
      data.environmentId !== environmentId ||
      data.userId !== userId ||
      data.origin !== origin
    )
      return {
        draft: null,
        message:
          "This setup link belongs to another user or environment. Use the same account and server as the desktop.",
      };
    if (
      !Number.isFinite(data.expiresAt) ||
      (data.expiresAt ?? 0) <= now ||
      (data.expiresAt ?? Infinity) > now + maxAge ||
      !validDraft(data.draft)
    )
      return {
        draft: null,
        message: "The browser setup link expired or is invalid. Start again from the desktop.",
      };
    if (existingDraft)
      return {
        draft: null,
        message:
          "Your existing browser draft remains. Discard it before you open the desktop setup link again.",
      };
    return {
      draft: {
        baseUrl: data.draft.baseUrl,
        enabled: data.draft.enabled,
        revision: data.draft.revision,
      },
      message:
        "Review the desktop draft. Select Save and verify trust to submit it. No settings changed yet.",
    };
  } catch {
    return {
      draft: null,
      message: "The browser setup link is invalid. Start again from the desktop.",
    };
  }
}
export function toolyardCommittedDraftMatches(
  draft: ToolyardSettingsDraft,
  status: { revision: number; baseUrl: string | null; enabled: boolean; removed: boolean },
): boolean {
  return (
    !status.removed &&
    status.revision > draft.revision &&
    status.enabled === draft.enabled &&
    status.baseUrl !== null &&
    toolyardSettingsOrigin(status.baseUrl) === toolyardSettingsOrigin(draft.baseUrl)
  );
}
const errorMessages: Record<string, string> = {
  admin_trust_registration_required:
    "Complete the trust setup in the default browser. Your desktop draft remains.",
  admin_token_identity_mismatch:
    "Use the same administrator account in T3 and the browser, then save again.",
  settings_revision_conflict:
    "The server settings changed. Your draft remains. Refresh and use the current revision before you save.",
  instance_binding_change_requires_removal:
    "Remove the current instance before you replace its URL or server origin. Your draft remains.",
  administrator_required: "An active environment administrator must save these settings.",
  instance_url_must_be_https_origin:
    "Enter an HTTPS Toolyard origin without a path, query, or credentials.",
  invalid_instance_url: "Enter a valid HTTPS Toolyard URL.",
  unsupported_instance_protocol:
    "This Toolyard instance does not support the required integration protocol.",
  registration_protocol_mismatch:
    "The Toolyard registration protocol changed. No local settings changed.",
  instance_capability_unsupported:
    "This Toolyard instance lacks a required integration capability.",
  registration_instance_identity_mismatch:
    "The Toolyard instance identity changed during trust setup. No local settings changed.",
  trust_revoked:
    "The Toolyard server trust was revoked. An administrator must verify the instance again.",
  not_org_member: "Toolyard refused this account because it is not an eligible team member.",
  invalid_assertion:
    "Toolyard refused the server identity. An administrator must verify the trust setup.",
};
export function toolyardSettingsFailureCode(cause: {
  readonly reasons: readonly unknown[];
}): string | null {
  for (const value of cause.reasons) {
    if (!value || typeof value !== "object") continue;
    const reason = value as { _tag?: string; error?: { _tag?: string; message?: string } };
    if (
      reason._tag === "Fail" &&
      reason.error?._tag === "PersonalMcpSettingsError" &&
      typeof reason.error.message === "string"
    )
      return reason.error.message;
  }
  return null;
}
export function toolyardSettingsFailureMessage(code: string | null): string {
  if (code?.startsWith("required_instance_capabilities_missing:"))
    return "This Toolyard instance lacks a required integration capability.";
  return (
    (code && Object.hasOwn(errorMessages, code) && errorMessages[code]) ||
    "The settings did not save. Your draft remains. Refresh the server status before another attempt."
  );
}

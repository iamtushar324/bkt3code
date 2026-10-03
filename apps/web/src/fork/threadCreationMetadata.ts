// T3-CUSTOM(expbkt3): carry source-control identity and draft lineage into native creation.
import type {
  EnvironmentId,
  SourceControlProfileId,
  SourceControlProfilesListResult,
  ThreadId,
} from "@t3tools/contracts";

export function resolveThreadCreationProfile(
  result: SourceControlProfilesListResult | null,
  ownerUserId: string | null,
): SourceControlProfileId | null {
  return result?.identityMode === "thread-profile" && ownerUserId !== null
    ? (result.profiles.find(
        (profile) => profile.ownerUserId !== null && String(profile.ownerUserId) === ownerUserId,
      )?.id ?? null)
    : null;
}

export function threadCreationForkFields(
  sourceControlProfileId: SourceControlProfileId | null,
  draft: {
    readonly parentThreadId?: ThreadId | null;
    readonly parentEnvironmentId?: EnvironmentId | null;
  } | null,
) {
  return {
    sourceControlProfileId,
    ...(draft?.parentThreadId ? { parentThreadId: draft.parentThreadId } : {}),
    ...(draft?.parentThreadId && draft.parentEnvironmentId
      ? { parentEnvironmentId: draft.parentEnvironmentId }
      : {}),
  };
}

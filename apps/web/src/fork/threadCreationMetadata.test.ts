// T3-CUSTOM(expbkt3): protect identity selection and durable child lineage during native creation.
import {
  EnvironmentId,
  EnvironmentUserId,
  SourceControlProfileId,
  ThreadId,
  type SourceControlProfilesListResult,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { useDraftCustomGroupStore } from "./draftCustomGroupStore";
import { resolveThreadCreationProfile, threadCreationForkFields } from "./threadCreationMetadata";

const profileId = SourceControlProfileId.make("owner-profile");
const profiles: SourceControlProfilesListResult = {
  identityMode: "thread-profile",
  profiles: [
    {
      id: profileId,
      provider: "github",
      label: "Owner profile",
      login: "owner",
      accountId: 1,
      avatarUrl: null,
      gitName: "Owner",
      gitEmail: "owner@example.test",
      ownerUserId: EnvironmentUserId.make("owner-user"),
      archived: false,
      credentialStatus: "connected",
    },
  ],
};

it("selects the creator or durable owner's profile and respects machine identity", () => {
  expect(resolveThreadCreationProfile(profiles, "owner-user")).toBe(profileId);
  expect(resolveThreadCreationProfile(profiles, "another-user")).toBeNull();
  expect(resolveThreadCreationProfile(profiles, null)).toBeNull();
  expect(
    resolveThreadCreationProfile({ ...profiles, identityMode: "machine" }, "owner-user"),
  ).toBeNull();
});

it("carries both parent identifiers for a draft started on another environment", () => {
  const parentThreadId = ThreadId.make("parent-thread");
  const parentEnvironmentId = EnvironmentId.make("parent-environment");
  expect(threadCreationForkFields(profileId, { parentThreadId, parentEnvironmentId })).toEqual({
    sourceControlProfileId: profileId,
    parentThreadId,
    parentEnvironmentId,
  });
  expect(
    threadCreationForkFields(profileId, { parentThreadId, parentEnvironmentId: null }),
  ).toEqual({
    sourceControlProfileId: profileId,
    parentThreadId,
  });
  expect(threadCreationForkFields(null, { parentThreadId: null, parentEnvironmentId })).toEqual({
    sourceControlProfileId: null,
  });
});

it("creates a draft started from a group header's + in that group", () => {
  const threadId = ThreadId.make("draft-thread");
  useDraftCustomGroupStore.getState().setTarget(threadId, "Sprint 42");
  try {
    expect(threadCreationForkFields(null, { threadId })).toEqual({
      sourceControlProfileId: null,
      customGroup: "Sprint 42",
    });
    expect(threadCreationForkFields(null, { threadId: ThreadId.make("other") })).toEqual({
      sourceControlProfileId: null,
    });
  } finally {
    useDraftCustomGroupStore.getState().setTarget(threadId, null);
  }
});

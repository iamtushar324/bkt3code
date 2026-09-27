// T3-CUSTOM(expbkt3): inherited tagging on t3_create_session.
//
// The default matters more than the overrides: a session an agent spawns is
// work a human asked for, and it has to stay visible to that human plus anyone
// they tagged in. These tests pin the whole matrix, including the case that
// motivated it — a session prompted by someone other than its owner.
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ClerkDirectory } from "../../../auth/ClerkDirectory.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { T3ControlToolError } from "./tools.ts";
import { __testing } from "./handlers.ts";

const projectId = ProjectId.make("project-1");
const callerThreadId = ThreadId.make("thread-caller");
const detachedParentId = ThreadId.make("thread-detached-parent");

const parentOwner = UserId.make("user-parent-owner");
const parentTagged = UserId.make("user-parent-tagged");
const prompter = UserId.make("user-prompter");
const outsider = UserId.make("user-outsider");

const threads = [
  {
    id: callerThreadId,
    projectId,
    ownerUserId: parentOwner,
    memberUserIds: [parentOwner, parentTagged],
  },
  {
    id: detachedParentId,
    projectId,
    ownerUserId: outsider,
    memberUserIds: [outsider],
  },
];

function makeScope(
  overrides: Partial<McpInvocationContext.McpInvocationScope> = {},
): McpInvocationContext.McpInvocationScope {
  return {
    principal: "provider-session",
    actorUserId: prompter,
    environmentId: EnvironmentId.make("environment-tagging"),
    threadId: callerThreadId,
    providerSessionId: "provider-session-tagging",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["t3.read", "t3.control", "t3.session.create"]),
    issuedAt: 1,
    ...overrides,
  };
}

const resolveTags = (input: {
  readonly scope?: McpInvocationContext.McpInvocationScope;
  readonly parentThreadId?: ThreadId | null;
  readonly ownerUserId?: UserId | null;
  readonly explicitTagUserIds?: ReadonlyArray<UserId>;
  readonly inheritParentTags?: boolean;
}) =>
  __testing.resolveCreatedSessionTags({
    scope: input.scope ?? makeScope(),
    threads,
    parentThreadId: input.parentThreadId ?? null,
    ownerUserId: input.ownerUserId ?? prompter,
    explicitTagUserIds: input.explicitTagUserIds ?? [],
    inheritParentTags: input.inheritParentTags,
  });

it("tags the calling session's owner and members by default", () => {
  // The session is owned by whoever prompted it; the parent's owner and tagged
  // member come along so the work stays visible to them.
  expect(resolveTags({})).toEqual([parentOwner, parentTagged]);
});

it("keeps inheriting when the session is filed at the top level", () => {
  // createAsChild: false only detaches the sidebar tree. The people who asked
  // for the work still want to see it.
  expect(resolveTags({ parentThreadId: null })).toEqual([parentOwner, parentTagged]);
});

it("drops the new owner from the tag list", () => {
  // Ownership already implies access, and the projector tags the creator.
  expect(resolveTags({ ownerUserId: parentOwner })).toEqual([parentTagged]);
});

it("replaces the inherited audience when explicit tags are given", () => {
  expect(resolveTags({ explicitTagUserIds: [outsider] })).toEqual([outsider]);
});

it("adds explicit tags on top when inheritance is asked for by name", () => {
  expect(resolveTags({ explicitTagUserIds: [outsider], inheritParentTags: true })).toEqual([
    parentOwner,
    parentTagged,
    outsider,
  ]);
});

it("tags nobody but the owner when inheritance is refused", () => {
  expect(resolveTags({ inheritParentTags: false })).toEqual([]);
});

it("inherits from the explicit parent for a caller with no session of its own", () => {
  // An external-user token's threadId is synthetic, so the named parent is the
  // only real audience available.
  const scope = makeScope({ principal: "external-user" });
  expect(resolveTags({ scope, parentThreadId: detachedParentId })).toEqual([outsider]);
});

it("tags nobody when an external caller names no parent", () => {
  const scope = makeScope({ principal: "external-operator" });
  expect(resolveTags({ scope })).toEqual([]);
});

it("ignores a source session that is no longer visible in the snapshot", () => {
  const scope = makeScope({ threadId: ThreadId.make("thread-archived") });
  expect(resolveTags({ scope })).toEqual([]);
});

const directory = (users: ReadonlyArray<{ id: UserId; email: string | null }>) =>
  ClerkDirectory.of({
    enabled: true,
    descriptor: null,
    verifySessionToken: () => Effect.die("unused"),
    listOrgMembers: () =>
      Effect.succeed(
        users.map((user) => ({
          id: user.id,
          name: null,
          email: user.email,
          imageUrl: null,
          isAdmin: false,
        })),
      ),
    isOrgAdmin: () => Effect.succeed(false),
    findUserIdByEmail: () => Effect.succeed(null),
  });

const resolveEntries = (entries: ReadonlyArray<string>) =>
  __testing.resolveTagUserIds("create-session", entries).pipe(
    Effect.provideService(
      ClerkDirectory,
      directory([
        { id: parentTagged, email: "tagged@beknown.work" },
        { id: outsider, email: "outsider@beknown.work" },
      ]),
    ),
  );

it.effect("resolves tag targets given as emails, case-insensitively", () =>
  Effect.gen(function* () {
    expect(yield* resolveEntries(["Tagged@Beknown.work"])).toEqual([parentTagged]);
  }),
);

it.effect("accepts raw user IDs and de-duplicates them", () =>
  Effect.gen(function* () {
    expect(yield* resolveEntries([parentTagged, "tagged@beknown.work", outsider])).toEqual([
      parentTagged,
      outsider,
    ]);
  }),
);

it.effect("refuses an unknown tag target instead of silently tagging nobody", () =>
  Effect.gen(function* () {
    const error = yield* resolveEntries(["nobody@beknown.work"]).pipe(Effect.flip);
    expect(error).toBeInstanceOf(T3ControlToolError);
    expect(error.message).toContain("does not match a T3 user");
  }),
);

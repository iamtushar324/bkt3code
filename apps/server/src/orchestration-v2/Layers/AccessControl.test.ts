import { EnvironmentUserId, ProjectId, ThreadId, UserId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationAccessControl } from "../Services/AccessControl.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadAccess,
} from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationAccessControlLive } from "./AccessControl.ts";

const owner = UserId.make("user-owner");
const stranger = UserId.make("user-stranger");
const archivedThreadId = ThreadId.make("thread-archived");

const archivedAccess: ProjectionThreadAccess = {
  threadId: archivedThreadId,
  projectId: ProjectId.make("project-1"),
  ownerUserId: owner,
  memberUserIds: [],
};

// The archived thread is deliberately absent from `getThreadShellById` (that
// query is active-only, exactly as in production) so the test fails if access
// control regresses back to the shell lookup.
const snapshotQueryStub = Layer.succeed(ProjectionSnapshotQuery)({
  getThreadShellById: () => Effect.succeed(Option.none()),
  getThreadAccessById: (threadId: ThreadId) =>
    Effect.succeed(threadId === archivedThreadId ? Option.some(archivedAccess) : Option.none()),
} as unknown as typeof ProjectionSnapshotQuery.Service);

const TestLayer = OrchestrationAccessControlLive.pipe(Layer.provide(snapshotQueryStub));

it.effect("uses a session's durable user before its non-Clerk subject", () =>
  Effect.gen(function* () {
    const accessControl = yield* OrchestrationAccessControl;
    const boundUser = EnvironmentUserId.make("user-bound-browser");

    assert.deepEqual(
      accessControl.actorFor("one-time-token", boundUser),
      Option.some(UserId.make(boundUser)),
    );
    assert.deepEqual(accessControl.actorFor("one-time-token", null), Option.none());
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("authorizes the owner of an archived thread (so it can be unarchived)", () =>
  Effect.gen(function* () {
    const accessControl = yield* OrchestrationAccessControl;
    assert.equal(yield* accessControl.canAccessThread(owner, archivedThreadId), true);
    assert.equal(yield* accessControl.canTransferThreadOwnership(owner, archivedThreadId), true);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("still denies a user with no ownership or tag on the archived thread", () =>
  Effect.gen(function* () {
    const accessControl = yield* OrchestrationAccessControl;
    assert.equal(yield* accessControl.canAccessThread(stranger, archivedThreadId), false);
    assert.equal(
      yield* accessControl.canAccessThread(owner, ThreadId.make("thread-unknown")),
      false,
    );
  }).pipe(Effect.provide(TestLayer)),
);

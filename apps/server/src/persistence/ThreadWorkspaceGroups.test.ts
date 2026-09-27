/**
 * T3-CUSTOM(expbkt3): coverage for the shared child worktree reservation.
 *
 * The behaviour worth pinning is that `claim` is insert-or-read: during a
 * parallel fan-out several children call it before any worktree exists, and
 * they must all leave holding the same answer.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { MigrationsLive } from "./Migrations.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import * as ThreadWorkspaceGroups from "./ThreadWorkspaceGroups.ts";
import { ThreadWorkspaceGroupRepository } from "./ThreadWorkspaceGroups.ts";

const ownerThreadId = ThreadId.make("thread-parent");
const projectId = ProjectId.make("project-bks");
const otherProjectId = ProjectId.make("project-bkd");
const createdAt = "2026-09-22T05:00:00.000Z";

const layer = ThreadWorkspaceGroups.layer.pipe(
  Layer.provide(MigrationsLive),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

const withRepository = <A, E>(
  body: (repository: ThreadWorkspaceGroupRepository["Service"]) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const repository = yield* ThreadWorkspaceGroupRepository;
    return yield* body(repository);
  }).pipe(Effect.provide(layer));

describe("ThreadWorkspaceGroupRepository", () => {
  it.effect("hands every child of one parent the same worktree for a repository", () =>
    withRepository((repository) =>
      Effect.gen(function* () {
        const first = yield* repository.claim({
          ownerThreadId,
          projectId,
          branch: "t3code/hongkong",
          worktreePath: "/worktrees/bks/hongkong",
          createdAt,
        });
        const second = yield* repository.claim({
          ownerThreadId,
          projectId,
          branch: "t3code/cagliari",
          worktreePath: "/worktrees/bks/cagliari",
          createdAt,
        });

        expect(first.worktreePath).toBe("/worktrees/bks/hongkong");
        expect(second.worktreePath).toBe("/worktrees/bks/hongkong");
        expect(second.branch).toBe("t3code/hongkong");
      }),
    ),
  );

  it.effect("keeps one reservation per repository, not one per parent", () =>
    withRepository((repository) =>
      Effect.gen(function* () {
        yield* repository.claim({
          ownerThreadId,
          projectId,
          branch: "t3code/hongkong",
          worktreePath: "/worktrees/bks/hongkong",
          createdAt,
        });
        const other = yield* repository.claim({
          ownerThreadId,
          projectId: otherProjectId,
          branch: "t3code/miami",
          worktreePath: "/worktrees/bkd/miami",
          createdAt,
        });

        expect(other.worktreePath).toBe("/worktrees/bkd/miami");
      }),
    ),
  );

  it.effect("reports the reservation as unbuilt until the worktree exists", () =>
    withRepository((repository) =>
      Effect.gen(function* () {
        const claimed = yield* repository.claim({
          ownerThreadId,
          projectId,
          branch: "t3code/hongkong",
          worktreePath: "/worktrees/bks/hongkong",
          createdAt,
        });
        expect(claimed.isReady).toBe(false);

        yield* repository.markReady({
          ownerThreadId,
          projectId,
          worktreePath: "/worktrees/bks/hongkong",
        });
        const after = yield* repository.get({ ownerThreadId, projectId });

        expect(Option.isSome(after) && after.value.isReady).toBe(true);
      }),
    ),
  );

  // A writer holding a path from a superseded reservation must not mark the
  // current one built; the child joining it would start in an empty directory.
  it.effect("ignores a ready mark for a path this group does not own", () =>
    withRepository((repository) =>
      Effect.gen(function* () {
        yield* repository.claim({
          ownerThreadId,
          projectId,
          branch: "t3code/hongkong",
          worktreePath: "/worktrees/bks/hongkong",
          createdAt,
        });
        yield* repository.markReady({
          ownerThreadId,
          projectId,
          worktreePath: "/worktrees/bks/somewhere-else",
        });
        const after = yield* repository.get({ ownerThreadId, projectId });

        expect(Option.isSome(after) && after.value.isReady).toBe(false);
      }),
    ),
  );

  it.effect("has no reservation for a parent that never fanned out", () =>
    withRepository((repository) =>
      Effect.gen(function* () {
        const missing = yield* repository.get({ ownerThreadId, projectId });
        expect(Option.isNone(missing)).toBe(true);
      }),
    ),
  );
});

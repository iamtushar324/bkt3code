// T3-CUSTOM(expbkt3): team visibility follows the native V2 shell protocol.
import type {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ArchivedShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ArchivedShellStreamItem,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { OrchestrationAccessControl } from "./orchestration-v2/Services/AccessControl.ts";
import type { ProjectService } from "./project/ProjectService.ts";

const owns = (
  value: { readonly ownerUserId?: UserId | null; readonly memberUserIds?: ReadonlyArray<UserId> },
  actor: UserId,
) => value.ownerUserId === actor || (value.memberUserIds ?? []).includes(actor);

export function filterNativeShell<
  T extends OrchestrationV2ShellSnapshot | OrchestrationV2ArchivedShellSnapshot,
>(snapshot: T, actor: UserId | null): T {
  if (actor === null) return snapshot;
  const threads = snapshot.threads.filter((thread) => owns(thread, actor));
  const archivedThreads =
    "archivedThreads" in snapshot
      ? snapshot.archivedThreads.filter((thread) => owns(thread, actor))
      : [];
  const projectIds = new Set([...threads, ...archivedThreads].map((thread) => thread.projectId));
  return {
    ...snapshot,
    threads,
    ...("archivedThreads" in snapshot ? { archivedThreads } : {}),
    projects: snapshot.projects.filter(
      (project) => owns(project, actor) || projectIds.has(project.id),
    ),
  };
}

type NativeShellItem = OrchestrationV2ShellStreamItem | OrchestrationV2ArchivedShellStreamItem;
export function filterNativeShellStream<E, R>(
  stream: Stream.Stream<OrchestrationV2ShellStreamItem, E, R>,
  actor: UserId | null,
  access: OrchestrationAccessControl["Service"],
  projects: Pick<ProjectService["Service"], "getShell">,
): Stream.Stream<OrchestrationV2ShellStreamItem, E, R>;
export function filterNativeShellStream<E, R>(
  stream: Stream.Stream<OrchestrationV2ArchivedShellStreamItem, E, R>,
  actor: UserId | null,
  access: OrchestrationAccessControl["Service"],
  projects: Pick<ProjectService["Service"], "getShell">,
): Stream.Stream<OrchestrationV2ArchivedShellStreamItem, E, R>;
export function filterNativeShellStream<E, R>(
  stream: Stream.Stream<NativeShellItem, E, R>,
  actor: UserId | null,
  access: OrchestrationAccessControl["Service"],
  projects: Pick<ProjectService["Service"], "getShell">,
): Stream.Stream<NativeShellItem, E, R> {
  if (actor === null) return stream;
  return Stream.suspend(() => {
    const visibleProjectIds = new Set<string>();
    return stream.pipe(
      Stream.mapEffect((item): Effect.Effect<ReadonlyArray<NativeShellItem>> => {
        switch (item.kind) {
          case "snapshot": {
            const snapshot = filterNativeShell(item.snapshot, actor);
            visibleProjectIds.clear();
            for (const project of snapshot.projects) visibleProjectIds.add(project.id);
            return Effect.succeed([{ ...item, snapshot }]);
          }
          case "thread.updated": {
            if (!owns(item.thread, actor))
              return Effect.succeed([
                {
                  kind: "thread.removed",
                  sequence: item.sequence,
                  threadId: item.thread.id,
                  ...("location" in item ? { location: item.location } : {}),
                },
              ]);
            if (visibleProjectIds.has(item.thread.projectId)) return Effect.succeed([item]);
            return projects.getShell(item.thread.projectId).pipe(
              Effect.map((project): ReadonlyArray<NativeShellItem> => {
                if (Option.isNone(project)) return [item];
                visibleProjectIds.add(project.value.id);
                return [
                  { kind: "project.updated", sequence: item.sequence, project: project.value },
                  item,
                ];
              }),
              Effect.orElseSucceed(() => [item]),
            );
          }
          case "project.updated":
            return access.canAccessProject(actor, item.project.id).pipe(
              Effect.orElseSucceed(() => false),
              Effect.map((allowed) => {
                if (allowed) visibleProjectIds.add(item.project.id);
                else visibleProjectIds.delete(item.project.id);
                return allowed
                  ? [item]
                  : [
                      {
                        kind: "project.removed",
                        sequence: item.sequence,
                        projectId: item.project.id,
                      },
                    ];
              }),
            );
          case "project.removed":
            visibleProjectIds.delete(item.projectId);
            return Effect.succeed([item]);
          default:
            return Effect.succeed([item]);
        }
      }),
      Stream.flatMap(Stream.fromIterable),
    );
  });
}

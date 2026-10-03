// T3-CUSTOM(expbkt3): retained BK behavior at the native V2 boundary.
/** Native V2 runtime for retained HTTP compatibility regression tests. */
import { EventId, ProviderInstanceId, type OrchestrationProjectShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ThreadSearch from "../ThreadSearch.ts";
import * as LegacyImporter from "../legacy/LegacyV1ThreadImporter.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { ProviderAdapterRegistryV2 } from "../ProviderAdapterRegistry.ts";
import { planProjectCommand } from "../ProjectCommands.ts";
import { OrchestrationEngineLive } from "../Layers/OrchestrationEngine.ts";
import { ProjectionSnapshotQueryLive } from "../Layers/ProjectionSnapshotQuery.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";

export function makeForkCompatibilityTestLayer(name: string) {
  const registry = Layer.mock(ProviderAdapterRegistryV2)({
    get: () => Effect.die("Provider execution is outside this test."),
    list: () => Effect.succeed([ProviderInstanceId.make("codex")]),
  });
  const runtime = makeOrchestratorV2ReplayLayerWithRegistry({ name }, registry, {
    runEffectWorker: false,
    databaseLayer: SqlitePersistenceMemory,
  });
  const stores = Layer.mergeAll(
    ProjectStore.layer,
    ProjectionStore.layer,
    ThreadSearch.layer,
    OrchestrationEventStoreLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
  const infrastructure = Layer.mergeAll(runtime, stores);
  const importer = LegacyImporter.layer.pipe(Layer.provide(infrastructure));
  const projectService = Layer.effect(
    ProjectService,
    Effect.gen(function* () {
      const store = yield* ProjectStore.ProjectStoreV2;
      const sink = yield* EventSinkV2;
      const repositoryIdentity = yield* RepositoryIdentityResolver;
      const enrich = (project: OrchestrationProjectShell) =>
        repositoryIdentity
          .resolve(project.workspaceRoot)
          .pipe(Effect.map((identity) => ({ ...project, repositoryIdentity: identity })));
      return ProjectService.of({
        dispatch: (command) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const row = yield* store.get(command.projectId, { includeDeleted: true });
            const workspaceOwner =
              "workspaceRoot" in command && command.workspaceRoot !== undefined
                ? yield* store.findActiveByWorkspaceRoot(command.workspaceRoot)
                : Option.none();
            const plan = planProjectCommand({
              command,
              eventId: EventId.make(`event:${command.commandId}`),
              now,
              state: {
                project: Option.getOrUndefined(row),
                workspaceOwner: Option.getOrUndefined(workspaceOwner),
              },
            });
            if (Result.isFailure(plan)) return yield* Effect.die(plan.failure);
            yield* sink.commitProjectCommand({
              commandId: command.commandId,
              projectId: command.projectId,
              commandType: command.type,
              acceptedAt: now,
              event: plan.success,
            });
          }).pipe(Effect.orDie),
        create: () => Effect.die("unused"),
        bootstrap: () => Effect.die("unused"),
        update: () => Effect.die("unused"),
        delete: () => Effect.die("unused"),
        getById: () => Effect.die("unused"),
        getByWorkspaceRoot: () => Effect.die("unused"),
        snapshot: Effect.die("unused"),
        getShell: (projectId) =>
          store.getShell(projectId).pipe(
            Effect.flatMap((project) =>
              Option.isNone(project)
                ? Effect.succeed(Option.none())
                : enrich(project.value).pipe(Effect.map(Option.some)),
            ),
            Effect.orDie,
          ),
        listShells: (options) =>
          store.listShells(options).pipe(
            Effect.flatMap((projects) => Effect.forEach(projects, enrich, { concurrency: 2 })),
            Effect.orDie,
          ),
      });
    }),
  ).pipe(Layer.provide(infrastructure));
  const provided = Layer.mergeAll(infrastructure, importer, projectService);
  return Layer.mergeAll(OrchestrationEngineLive, ProjectionSnapshotQueryLive).pipe(
    Layer.provideMerge(provided),
  );
}

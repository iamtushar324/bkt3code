import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  // T3-CUSTOM(expbkt3): project operations bind to the authenticated operator.
  EnvironmentAuthenticatedPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
// T3-CUSTOM(expbkt3): durable actor access.
import * as Option from "effect/Option";
import { OrchestrationAccessControl } from "../orchestration-v2/Services/AccessControl.ts";
import { ClerkDirectory } from "../auth/ClerkDirectory.ts";
import { checkCommandAccess } from "../orchestration-v2/commandAccess.ts";
import { CurrentOrchestrationActorUserId } from "../orchestration-v2/forkActor.expbkt3.ts";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProjectService from "./ProjectService.ts";
import { projectMutationOperation } from "./ProjectMutation.ts";

export const failProjectMutation = Effect.fn("environment.projects.failMutation")(function* (
  cause: ProjectService.ProjectServiceError | ServerRuntimeStartup.ServerRuntimeStartupError,
) {
  if (
    cause._tag === "ProjectNotFoundError" ||
    cause._tag === "ProjectConflictError" ||
    cause._tag === "ProjectNotEmptyError"
  ) {
    return yield* failEnvironmentInvalidRequest("invalid_command");
  }
  return yield* failEnvironmentInternal("project_mutation_failed", cause);
});

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "projects",
  Effect.fnUntraced(function* (handlers) {
    const projects = yield* ProjectService.ProjectService;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    // T3-CUSTOM(expbkt3): all native project entry points retain team access.
    const access = yield* OrchestrationAccessControl;
    const directory = yield* ClerkDirectory;
    const currentActor = Effect.gen(function* () {
      const principal = yield* EnvironmentAuthenticatedPrincipal;
      return Option.getOrNull(access.actorFor(principal.subject, principal.userId));
    });

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.projects.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // T3-CUSTOM(expbkt3): list only projects accessible to this operator.
          const actor = yield* currentActor;
          return yield* projects.snapshot.pipe(
            Effect.flatMap((snapshot) =>
              actor === null
                ? Effect.succeed(snapshot)
                : Effect.forEach(snapshot.projects, (project) =>
                    access.canAccessProject(actor, project.id).pipe(
                      Effect.orElseSucceed(() => false),
                      Effect.map((allowed) => (allowed ? [project] : [])),
                    ),
                  ).pipe(Effect.map((visible) => ({ ...snapshot, projects: visible.flat() }))),
            ),
            traceLocalHandlerWork,
            Effect.catch((cause) => failEnvironmentInternal("project_snapshot_failed", cause)),
          );
        }),
      )
      .handle(
        "mutate",
        Effect.fn("environment.projects.mutate")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          // T3-CUSTOM(expbkt3): ownership, member changes and metadata use the same gate.
          const actor = yield* currentActor;
          const admin =
            actor === null ? false : yield* directory.isOrgAdmin(actor).pipe(traceLocalHandlerWork);
          const allowed = yield* checkCommandAccess(access, actor, admin, args.payload).pipe(
            traceLocalHandlerWork,
            Effect.catch((cause) => failEnvironmentInternal("project_mutation_failed", cause)),
          );
          if (!allowed) return yield* failEnvironmentInvalidRequest("invalid_command");
          const operation = projectMutationOperation(projects, args.payload).pipe(
            Effect.provideService(CurrentOrchestrationActorUserId, actor),
          );
          return yield* startup
            .enqueueCommand(operation)
            .pipe(traceLocalHandlerWork, Effect.catch(failProjectMutation));
        }),
      );
  }),
);

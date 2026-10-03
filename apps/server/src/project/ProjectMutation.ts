import { type ProjectMutation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
// T3-CUSTOM(expbkt3): access mutations reuse the native project transaction.
import * as Option from "effect/Option";
import { CurrentOrchestrationActorUserId } from "../orchestration-v2/forkActor.expbkt3.ts";

import { ProjectNotFoundError, type ProjectService } from "./ProjectService.ts";

// T3-CUSTOM(expbkt3): the access commands use the same receipt path as project metadata.
type ProjectMutations = Pick<
  ProjectService["Service"],
  "create" | "delete" | "update" | "dispatch" | "getById"
>;

export const projectMutationOperation = Effect.fn("projectMutationOperation")(function* (
  projects: ProjectMutations,
  mutation: ProjectMutation,
) {
  switch (mutation.type) {
    case "project.create":
      return yield* projects.create({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        title: mutation.title,
        workspaceRoot: mutation.workspaceRoot,
        ...(mutation.createWorkspaceRootIfMissing === undefined
          ? {}
          : { createWorkspaceRootIfMissing: mutation.createWorkspaceRootIfMissing }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });

    case "project.update":
      return yield* projects.update({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
        ...(mutation.workspaceRoot === undefined ? {} : { workspaceRoot: mutation.workspaceRoot }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.autoPull === undefined ? {} : { autoPull: mutation.autoPull }),
        ...(mutation.projectIcon === undefined ? {} : { projectIcon: mutation.projectIcon }),
        ...(mutation.faviconPath === undefined ? {} : { faviconPath: mutation.faviconPath }),
        ...(mutation.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: mutation.defaultThreadEnvMode }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });

    case "project.delete":
      return yield* projects.delete({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.force === undefined ? {} : { force: mutation.force }),
      });
    // T3-CUSTOM(expbkt3): retain team membership and ownership mutations in V2.
    case "project.member.add":
    case "project.member.remove":
    case "project.owner.transfer": {
      yield* projects.dispatch({
        ...mutation,
        actorUserId: yield* CurrentOrchestrationActorUserId,
      });
      const project = yield* projects.getById(mutation.projectId);
      if (Option.isNone(project))
        return yield* new ProjectNotFoundError({ projectId: mutation.projectId });
      return project.value;
    }
  }
});

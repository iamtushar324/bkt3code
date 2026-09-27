import { type EnvironmentId, type ProjectReadFileResult, WS_METHODS } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import {
  type CreateProjectInput,
  type DeleteProjectInput,
  type UpdateProjectInput,
  createProject,
  deleteProject,
  updateProject,
} from "../operations/commands.ts";
// T3-CUSTOM(expbkt3): BEGIN fork command creators
import {
  type AddProjectMemberInput,
  type RemoveProjectMemberInput,
  type TransferProjectOwnershipInput,
  addProjectMember,
  removeProjectMember,
  transferProjectOwnership,
} from "../operations/commandsFork.ts";
// T3-CUSTOM(expbkt3): END
import type { EnvironmentRegistry } from "../connection/registry.ts";

// T3-CUSTOM(expbkt3): acknowledgement timeout error

export type {
  CreateProjectInput,
  DeleteProjectInput,
  UpdateProjectInput,
} from "../operations/commands.ts";
// T3-CUSTOM(expbkt3): BEGIN fork command input types
export type {
  AddProjectMemberInput,
  RemoveProjectMemberInput,
  TransferProjectOwnershipInput,
} from "../operations/commandsFork.ts";
// T3-CUSTOM(expbkt3): END

export interface OptimisticProjectFile {
  readonly data: ProjectReadFileResult;
  readonly confirmedAgainst: object | null | undefined;
}

export interface OptimisticProjectFileTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

function optimisticProjectFileKey(target: OptimisticProjectFileTarget): string {
  return JSON.stringify([target.environmentId, target.cwd, target.relativePath]);
}

export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const projectScheduler = createAtomCommandScheduler();
  const fileScheduler = createAtomCommandScheduler();
  const optimisticFileFamily = Atom.family((key: string) =>
    Atom.make<OptimisticProjectFile | null>(null).pipe(
      Atom.withLabel(`environment-data:projects:optimistic-file:${key}`),
    ),
  );
  const projectConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  return {
    searchEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:search-entries",
      tag: WS_METHODS.projectsSearchEntries,
      staleTimeMs: 15_000,
    }),
    listEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-entries",
      tag: WS_METHODS.projectsListEntries,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    readFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:read-file",
      tag: WS_METHODS.projectsReadFile,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    optimisticFile: (target: OptimisticProjectFileTarget) =>
      optimisticFileFamily(optimisticProjectFileKey(target)),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:create",
      execute: (input: CreateProjectInput) => createProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update",
      execute: (input: UpdateProjectInput) => updateProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:delete",
      execute: (input: DeleteProjectInput) => deleteProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    // T3-CUSTOM(expbkt3): BEGIN — team mode: membership and ownership commands for a project.
    addMember: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:add-member",
      execute: (input: AddProjectMemberInput) => addProjectMember(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    removeMember: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:remove-member",
      execute: (input: RemoveProjectMemberInput) => removeProjectMember(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    transferOwnership: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:transfer-ownership",
      execute: (input: TransferProjectOwnershipInput) => transferProjectOwnership(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    // T3-CUSTOM(expbkt3): END
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:write-file",
      tag: WS_METHODS.projectsWriteFile,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
  };
}

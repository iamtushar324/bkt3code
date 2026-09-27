/**
 * OrchestrationAccessControl - Per-user visibility & command-access service.
 *
 * Resolves the operating user from a durable session binding or legacy Clerk
 * subject and answers per-entity access questions used by the HTTP and
 * WebSocket enforcement points. Unidentified local operators remain
 * unrestricted so single-user mode is unchanged.
 *
 * @module OrchestrationAccessControl
 */
import type { EnvironmentUserId, ProjectId, ThreadId, UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface OrchestrationAccessControlShape {
  /**
   * The durable user bound to a session, falling back to a Clerk subject for
   * legacy sessions, or `none` for an unrestricted local operator.
   */
  readonly actorFor: (
    subject: string,
    boundUserId: EnvironmentUserId | null,
  ) => Option.Option<UserId>;
  /** Whether `userId` may see/operate on the thread (owner, tag, or project). */
  readonly canAccessThread: (
    userId: UserId,
    threadId: ThreadId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /** Whether `userId` may see/operate on the project. */
  readonly canAccessProject: (
    userId: UserId,
    projectId: ProjectId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /** Whether `userId` may transfer thread ownership. */
  readonly canTransferThreadOwnership: (
    userId: UserId,
    threadId: ThreadId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /** Whether `userId` may transfer project ownership. */
  readonly canTransferProjectOwnership: (
    userId: UserId,
    projectId: ProjectId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class OrchestrationAccessControl extends Context.Service<
  OrchestrationAccessControl,
  OrchestrationAccessControlShape
>()("t3/orchestration/Services/AccessControl/OrchestrationAccessControl") {}

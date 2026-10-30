import type { ServerConfig } from "@t3tools/contracts";

/**
 * The server process a shell cursor belongs to, or null when the server does
 * not say. Event sequences are durable, but a restart or a deploy can change
 * how shells are built, so a cursor is only reused within one process.
 */
export function shellResumeServerIdentity(config: ServerConfig): string | null {
  return config.serverInstanceId ?? null;
}

/**
 * A new socket may resume the shell from the in-memory cursor, instead of a
 * full HTTP snapshot, when (TEC-1837):
 * - an earlier socket in this app run received an authoritative snapshot (the
 *   disk cache alone never qualifies: it can be incomplete),
 * - both sockets reach the same server process,
 * - no deferred pull request fill is pending, which would leave rows without links,
 * - this socket did not already try a resume. A retry after a failed resume
 *   loads the HTTP snapshot.
 *
 * A gap that is too large is not an error: the server answers the resume with
 * a full snapshot in the stream, which replaces the state.
 */
export function canResumeShellAcrossSessions(input: {
  readonly hasEarlierAuthoritativeSession: boolean;
  readonly earlierServerIdentity: string | null;
  readonly serverIdentity: string | null;
  readonly pendingLinkFill: boolean;
  readonly alreadyTriedOnThisSession: boolean;
}): boolean {
  return (
    input.hasEarlierAuthoritativeSession &&
    input.serverIdentity !== null &&
    input.serverIdentity === input.earlierServerIdentity &&
    !input.pendingLinkFill &&
    !input.alreadyTriedOnThisSession
  );
}

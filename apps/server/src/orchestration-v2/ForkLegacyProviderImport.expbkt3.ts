// T3-CUSTOM(expbkt3): preserve durable provider conversations during the V1 import.
import {
  EventId,
  ProviderDriverKind,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { deriveProviderThread } from "./IdAllocator.ts";

const cursorSchema = Schema.Struct({
  resume: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  conversationId: Schema.optional(Schema.String),
  resumeSessionAt: Schema.optional(Schema.String),
});
const decodeCursor = Schema.decodeUnknownOption(Schema.fromJsonString(cursorSchema));

export const forkLegacyProviderEvents = Effect.fn("forkLegacyProviderEvents")(function* (
  thread: OrchestrationV2AppThread,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly provider_name: string | null;
    readonly resume_cursor_json: string | null;
    readonly provider_thread_id: string | null;
    readonly provider_session_id: string | null;
  }>`
    SELECT COALESCE(runtime.provider_name, session.provider_name) AS provider_name,
      runtime.resume_cursor_json, session.provider_thread_id, session.provider_session_id
    FROM projection_threads AS thread
    LEFT JOIN provider_session_runtime AS runtime ON runtime.thread_id = thread.thread_id
    LEFT JOIN projection_thread_sessions AS session ON session.thread_id = thread.thread_id
    WHERE thread.thread_id = ${thread.id}
  `.pipe(
    Effect.mapError(
      (cause) => new PersistenceSqlError({ operation: "import-legacy-provider", cause }),
    ),
  );
  const row = rows[0];
  if (row === undefined || row.provider_name === null) return [];
  const cursor = row.resume_cursor_json === null ? undefined : decodeCursor(row.resume_cursor_json);
  const decoded = cursor?._tag === "Some" ? cursor.value : undefined;
  const nativeId =
    decoded?.resume ??
    decoded?.threadId ??
    decoded?.sessionId ??
    decoded?.conversationId ??
    row.provider_thread_id ??
    row.provider_session_id;
  if (nativeId === null || nativeId.trim().length === 0) return [];
  const driver = ProviderDriverKind.make(row.provider_name);
  // Only the saved SDK cursor is a native Claude message boundary. Legacy T3
  // turn-start IDs do not establish a valid resume point and must not replace it.
  const resumeSessionAt =
    row.provider_name === "claudeAgent" &&
    decoded?.resumeSessionAt !== undefined &&
    decoded.resumeSessionAt.trim().length > 0
      ? decoded.resumeSessionAt
      : undefined;
  const providerThreadId = deriveProviderThread({
    driver,
    providerInstanceId: thread.providerInstanceId,
    nativeThreadId: nativeId,
  });
  const base = {
    threadId: thread.id,
    providerInstanceId: thread.providerInstanceId,
    occurredAt: thread.updatedAt,
  };
  return [
    {
      ...base,
      id: EventId.make(`migration:v1:thread:${thread.id}:provider-thread`),
      type: "provider-thread.updated",
      driver,
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId: thread.providerInstanceId,
        providerSessionId: null,
        appThreadId: thread.id,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId, strength: "strong" },
        nativeConversationHeadRef:
          resumeSessionAt === undefined
            ? null
            : { driver, nativeId: resumeSessionAt, strength: "weak" },
        status: "not_loaded",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        nativeMetadata: { modelSelection: thread.modelSelection },
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      },
    },
    {
      ...base,
      id: EventId.make(`migration:v1:thread:${thread.id}:provider-reference`),
      type: "thread.metadata-updated",
      payload: { ...thread, activeProviderThreadId: providerThreadId },
    },
  ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
});

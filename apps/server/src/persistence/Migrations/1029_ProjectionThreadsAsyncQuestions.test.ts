import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("1029_ProjectionThreadsAsyncQuestions", (it) => {
  it.effect("backfills blocking and async counts from sequence-ordered lifecycle rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 1028 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at,
          settled_override, settled_at, pinned_at, latest_user_message_at,
          pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
          rolling_summary, deleted_at
        ) VALUES
          ('async-open', 'p', 'Async', '{}', 'full-access', 'default', NULL, NULL, NULL, '2026-01-01', '2026-01-01', NULL, NULL, NULL, NULL, NULL, 0, 1, 0, NULL, NULL),
          ('async-resolved', 'p', 'Resolved', '{}', 'full-access', 'default', NULL, NULL, NULL, '2026-01-01', '2026-01-01', NULL, NULL, NULL, NULL, NULL, 0, 1, 0, NULL, NULL),
          ('native-terminal', 'p', 'Terminal', '{}', 'full-access', 'default', NULL, NULL, NULL, '2026-01-01', '2026-01-01', NULL, NULL, NULL, NULL, NULL, 0, 1, 0, NULL, NULL),
          ('native-open', 'p', 'Native', '{}', 'full-access', 'default', NULL, NULL, NULL, '2026-01-01', '2026-01-01', NULL, NULL, NULL, NULL, NULL, 0, 0, 0, NULL, NULL),
          ('native-stale', 'p', 'Stale', '{}', 'full-access', 'default', NULL, NULL, NULL, '2026-01-01', '2026-01-01', NULL, NULL, NULL, NULL, NULL, 0, 1, 0, NULL, NULL)
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES
          ('async-open', 'async-open', NULL, 'info', 'user-input.requested', 'Question', '{"requestId":"open","responseMode":"message"}', 4, '2026-01-01'),
          ('z-request', 'async-resolved', NULL, 'info', 'user-input.requested', 'Question', '{"requestId":"resolved","responseMode":"message"}', 4, '2026-01-01'),
          ('a-answer', 'async-resolved', NULL, 'info', 'user-input.resolved', 'Answered', '{"requestId":"resolved"}', 5, '2026-01-01'),
          ('native-request', 'native-terminal', 'terminal-turn', 'info', 'user-input.requested', 'Question', '{"requestId":"native"}', 9, '2026-01-01'),
          ('native-open', 'native-open', NULL, 'info', 'user-input.requested', 'Question', '{"requestId":"native-open"}', 12, '2026-01-01'),
          ('native-stale-request', 'native-stale', NULL, 'info', 'user-input.requested', 'Question', '{"requestId":"native-stale"}', 16, '2026-01-01'),
          ('native-stale-failure', 'native-stale', NULL, 'error', 'provider.user-input.respond.failed', 'Stale', '{"requestId":"native-stale","detail":"Unknown pending user-input request"}', 17, '2026-01-01')
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at,
          started_at, completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
          checkpoint_files_json
        ) VALUES ('native-terminal', 'terminal-turn', NULL, NULL, 'completed', '2026-01-01', NULL, '2026-01-01', NULL, NULL, NULL, '[]')
      `;

      yield* runMigrations({ toMigrationInclusive: 1029 });
      const rows = yield* sql<{
        readonly threadId: string;
        readonly blocking: number;
        readonly async: number;
      }>`
        SELECT thread_id AS "threadId", pending_user_input_count AS "blocking",
          pending_async_user_input_count AS "async"
        FROM projection_threads ORDER BY thread_id
      `;
      assert.deepEqual(rows, [
        { threadId: "async-open", blocking: 0, async: 1 },
        { threadId: "async-resolved", blocking: 0, async: 0 },
        { threadId: "native-open", blocking: 1, async: 0 },
        { threadId: "native-stale", blocking: 0, async: 0 },
        { threadId: "native-terminal", blocking: 0, async: 0 },
      ]);
    }),
  );
});

// T3-CUSTOM(expbkt3): migration 1003 adds durable, exact execution intent and recovery audit.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_execution_intents (
      work_item_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      request_event_sequence INTEGER UNIQUE,

      message_text TEXT,
      attachments_json TEXT,
      model_selection_json TEXT,
      runtime_mode TEXT,
      interaction_mode TEXT,
      bootstrap_json TEXT,
      source_proposed_plan_json TEXT,
      acting_user_id TEXT,

      desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped')),
      phase TEXT NOT NULL CHECK (phase IN (
        'queued', 'preparing', 'starting', 'running',
        'waiting-for-approval', 'waiting-for-input', 'recovering',
        'retry-wait', 'stopping', 'recovery-exhausted'
      )),
      delivery_certainty TEXT NOT NULL CHECK (delivery_certainty IN (
        'never-delivered', 'uncertain', 'provider-acknowledged', 'completed'
      )),
      runnable INTEGER NOT NULL DEFAULT 1 CHECK (runnable IN (0, 1)),
      adopted_execution_id TEXT,
      provider_turn_id TEXT,
      provider_instance_id TEXT,

      recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0),
      maximum_recovery_attempts INTEGER NOT NULL DEFAULT 10
        CHECK (maximum_recovery_attempts = 10),
      next_attempt_at TEXT,
      claim_owner TEXT,
      claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
      claim_expires_at TEXT,
      last_failure_type TEXT,
      last_failure_detail TEXT,

      accepted_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      terminal_at TEXT,
      exhausted_at TEXT,
      dismissed_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_intents_active_thread
    ON projection_thread_execution_intents(thread_id, desired_state, request_event_sequence)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_intents_due
    ON projection_thread_execution_intents(desired_state, runnable, next_attempt_at, request_event_sequence)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_intents_attention
    ON projection_thread_execution_intents(phase, dismissed_at)
    WHERE phase = 'recovery-exhausted'
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_execution_bootstrap_operations (
      work_item_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      worktree_phase TEXT NOT NULL CHECK (worktree_phase IN (
        'pending', 'running', 'acknowledged', 'failed', 'uncertain', 'not-required'
      )),
      worktree_path TEXT,
      setup_phase TEXT NOT NULL CHECK (setup_phase IN (
        'pending', 'running', 'acknowledged', 'failed', 'uncertain', 'not-required'
      )),
      setup_terminal_id TEXT NOT NULL,
      last_failure_detail TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id)
        REFERENCES projection_thread_execution_intents(work_item_id)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_execution_recovery_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      claim_owner TEXT NOT NULL,
      claim_generation INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      outcome TEXT NOT NULL,
      failure_type TEXT,
      failure_detail TEXT,
      provider_instance_id TEXT,
      provider_turn_id TEXT,
      FOREIGN KEY (work_item_id)
        REFERENCES projection_thread_execution_intents(work_item_id)
        ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_recovery_attempts_work_item
    ON thread_execution_recovery_attempts(work_item_id, attempt)
  `;

  // Convert only legacy rows that still request work. A match requires both
  // the persisted request event and its exact projected user message. Anything
  // less is retained as stopped attention and is never guessed or replayed.
  yield* sql`
    WITH legacy AS (
      SELECT
        state.*,
        event.sequence AS request_sequence,
        event.command_id AS matched_command_id,
        event.occurred_at AS accepted_at,
        event.payload_json AS request_payload_json,
        event.metadata_json AS request_metadata_json,
        json_extract(event.payload_json, '$.messageId') AS matched_message_id,
        message.text AS matched_message_text,
        message.attachments_json AS matched_attachments_json,
        message.sent_by_user_id AS matched_user_id
      FROM session_recovery_state AS state
      LEFT JOIN orchestration_events AS event
        ON event.sequence = (
          SELECT MAX(candidate.sequence)
          FROM orchestration_events AS candidate
          WHERE candidate.stream_id = state.thread_id
            AND candidate.event_type = 'thread.turn-start-requested'
            AND (
              state.last_execution_id IS NULL
              OR candidate.command_id = state.last_execution_id
            )
        )
      LEFT JOIN projection_thread_messages AS message
        ON message.message_id = json_extract(event.payload_json, '$.messageId')
      WHERE state.desired_state = 'running' OR state.gave_up_at IS NOT NULL
    )
    INSERT INTO projection_thread_execution_intents (
      work_item_id,
      thread_id,
      message_id,
      command_id,
      request_event_sequence,
      message_text,
      attachments_json,
      model_selection_json,
      runtime_mode,
      interaction_mode,
      bootstrap_json,
      source_proposed_plan_json,
      acting_user_id,
      desired_state,
      phase,
      delivery_certainty,
      runnable,
      adopted_execution_id,
      recovery_attempts,
      maximum_recovery_attempts,
      next_attempt_at,
      claim_generation,
      last_failure_type,
      last_failure_detail,
      accepted_at,
      updated_at,
      exhausted_at
    )
    SELECT
      COALESCE(matched_command_id, 'legacy-attention:' || thread_id),
      thread_id,
      COALESCE(matched_message_id, 'legacy-attention:' || thread_id),
      COALESCE(matched_command_id, 'legacy-attention:' || thread_id),
      request_sequence,
      matched_message_text,
      matched_attachments_json,
      json_extract(request_payload_json, '$.modelSelection'),
      json_extract(request_payload_json, '$.runtimeMode'),
      json_extract(request_payload_json, '$.interactionMode'),
      json_extract(request_payload_json, '$.bootstrap'),
      json_extract(request_payload_json, '$.sourceProposedPlan'),
      COALESCE(matched_user_id, json_extract(request_metadata_json, '$.actorUserId')),
      CASE
        WHEN gave_up_at IS NOT NULL OR matched_command_id IS NULL OR matched_message_text IS NULL
          THEN 'stopped'
        ELSE desired_state
      END,
      CASE
        WHEN gave_up_at IS NOT NULL OR matched_command_id IS NULL OR matched_message_text IS NULL
          THEN 'recovery-exhausted'
        ELSE 'recovering'
      END,
      CASE WHEN last_execution_id IS NULL THEN 'never-delivered' ELSE 'provider-acknowledged' END,
      CASE
        WHEN gave_up_at IS NULL AND matched_command_id IS NOT NULL AND matched_message_text IS NOT NULL
          THEN 1
        ELSE 0
      END,
      last_execution_id,
      attempts,
      10,
      CASE WHEN gave_up_at IS NULL THEN next_attempt_at ELSE NULL END,
      0,
      CASE
        WHEN matched_command_id IS NULL OR matched_message_text IS NULL
          THEN 'legacy-payload-unresolvable'
        WHEN gave_up_at IS NOT NULL THEN 'legacy-recovery-exhausted'
        ELSE NULL
      END,
      reason,
      COALESCE(accepted_at, updated_at),
      updated_at,
      CASE
        WHEN gave_up_at IS NOT NULL OR matched_command_id IS NULL OR matched_message_text IS NULL
          THEN COALESCE(gave_up_at, updated_at)
        ELSE NULL
      END
    FROM legacy
  `;

  yield* sql`
    INSERT INTO thread_execution_bootstrap_operations (
      work_item_id, thread_id, worktree_phase, worktree_path,
      setup_phase, setup_terminal_id, updated_at
    )
    SELECT
      work_item_id,
      thread_id,
      CASE
        WHEN json_type(bootstrap_json, '$.prepareWorktree') IS NOT NULL THEN 'pending'
        ELSE 'not-required'
      END,
      json_extract(bootstrap_json, '$.createThread.worktreePath'),
      CASE
        WHEN json_extract(bootstrap_json, '$.runSetupScript') = 1 THEN 'pending'
        ELSE 'not-required'
      END,
      'setup-' || work_item_id,
      updated_at
    FROM projection_thread_execution_intents
    WHERE bootstrap_json IS NOT NULL
    ON CONFLICT(work_item_id) DO NOTHING
  `;
});

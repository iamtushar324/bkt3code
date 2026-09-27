// T3-CUSTOM(expbkt3): native plan review — versioned, attributed plan documents.
//
// A plan document is the durable lineage behind one proposed plan: version 1 is
// whatever the agent produced, every later revision (agent or human) appends a
// new immutable row. Versions are never mutated, so `revision` doubles as the
// anchor key for comments the way `checkpoint_diff_blobs` keys on turn counts.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS plan_documents (
      document_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_plan_documents_thread
      ON plan_documents(thread_id, created_at)
  `;

  // Append-only. Nothing in the application ever updates or deletes these rows.
  yield* sql`
    CREATE TABLE IF NOT EXISTS plan_document_versions (
      version_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      author_kind TEXT NOT NULL,
      author_user_id TEXT,
      origin TEXT NOT NULL,
      content_markdown TEXT NOT NULL,
      content_value_json TEXT,
      source_plan_id TEXT,
      summary TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (document_id, revision)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_plan_document_versions_document
      ON plan_document_versions(document_id, revision)
  `;

  // Source plan ids arrive from projection_thread_proposed_plans; the lookup is
  // how the ingest listener decides "already captured" without a table scan.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_plan_document_versions_source_plan
      ON plan_document_versions(source_plan_id)
  `;

  // The live working copy: exactly one per document, holding pending Plate
  // suggestions inline. `revision_token` is the optimistic-concurrency guard.
  yield* sql`
    CREATE TABLE IF NOT EXISTS plan_document_drafts (
      document_id TEXT PRIMARY KEY,
      base_version_id TEXT NOT NULL,
      content_value_json TEXT NOT NULL,
      updated_by_user_id TEXT,
      updated_at TEXT NOT NULL,
      revision_token TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS plan_discussions (
      discussion_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      anchor_version_id TEXT NOT NULL,
      quoted_text TEXT NOT NULL,
      is_resolved INTEGER NOT NULL DEFAULT 0,
      resolved_by_user_id TEXT,
      resolved_at TEXT,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_plan_discussions_document
      ON plan_discussions(document_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS plan_discussion_comments (
      comment_id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL,
      author_user_id TEXT,
      body_markdown TEXT NOT NULL,
      is_edited INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_plan_discussion_comments_discussion
      ON plan_discussion_comments(discussion_id, created_at)
  `;
});

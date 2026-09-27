/**
 * T3-CUSTOM(expbkt3): persistence for agent-rendered UI surfaces.
 *
 * Insert-only. A render is the exact document an agent produced for one
 * `t3_show_ui` call, so nothing ever rewrites one; re-running the tool appends a
 * new row. Bodies live here rather than on the activity payload because that
 * path caps strings at 32 KiB and summarizes tool results to a single line.
 */
import { AgentUiRenderRecord, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  type ProjectionRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

export type AgentUiRepositoryError = ProjectionRepositoryError;

const AgentUiRenderRawRow = Schema.Struct({
  renderId: Schema.Unknown,
  threadId: Schema.Unknown,
  title: Schema.Unknown,
  kind: Schema.Unknown,
  html: Schema.Unknown,
  url: Schema.Unknown,
  height: Schema.Unknown,
  createdAt: Schema.Unknown,
});

export class AgentUiRepository extends Context.Service<
  AgentUiRepository,
  {
    readonly insertRender: (
      input: AgentUiRenderRecord,
    ) => Effect.Effect<void, AgentUiRepositoryError>;
    readonly getRender: (input: {
      readonly threadId: ThreadId;
      readonly renderId: string;
    }) => Effect.Effect<Option.Option<AgentUiRenderRecord>, AgentUiRepositoryError>;
  }
>()("t3/persistence/AgentUiRenders/AgentUiRepository") {}

function mapError(operation: string) {
  return (cause: unknown): AgentUiRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(`${operation}:decode`, cause)
      : new PersistenceSqlError({ operation: `${operation}:query`, cause });
}

const decodeRender = Schema.decodeUnknownEffect(AgentUiRenderRecord);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const renderColumns = sql`
    render_id AS "renderId",
    thread_id AS "threadId",
    title AS "title",
    kind AS "kind",
    html AS "html",
    url AS "url",
    height AS "height",
    created_at AS "createdAt"
  `;

  const insertRenderRow = SqlSchema.void({
    Request: AgentUiRenderRecord,
    execute: (input) => sql`
      INSERT INTO agent_ui_renders (
        render_id, thread_id, title, kind, html, url, height, created_at
      ) VALUES (
        ${input.renderId}, ${input.threadId}, ${input.title}, ${input.kind},
        ${input.html}, ${input.url}, ${input.height}, ${input.createdAt}
      )
      ON CONFLICT(render_id) DO NOTHING
    `,
  });

  // Thread id is part of the lookup, not just the row: it is what lets the
  // websocket handler authorize the read against the caller's thread access
  // before it ever touches the body.
  const getRenderRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, renderId: Schema.String }),
    Result: AgentUiRenderRawRow,
    execute: ({ threadId, renderId }) => sql`
      SELECT ${renderColumns} FROM agent_ui_renders
      WHERE render_id = ${renderId} AND thread_id = ${threadId}
    `,
  });

  return AgentUiRepository.of({
    insertRender: (input) =>
      insertRenderRow(input).pipe(Effect.mapError(mapError("AgentUi.insertRender"))),

    getRender: (input) =>
      getRenderRow(input).pipe(
        Effect.mapError(mapError("AgentUi.getRender")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none()),
            onSome: (row) =>
              decodeRender(row).pipe(
                Effect.map(Option.some),
                Effect.mapError(mapError("AgentUi.getRender")),
              ),
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(AgentUiRepository, make);

/**
 * T3-CUSTOM(expbkt3): `GET /api/orchestration/events` — an ordered event feed
 * for followers such as the Linear bridge.
 *
 * The bridge used to poll the full shell (~620 KB) every 2 s and full thread
 * histories on top, about a quarter of the server's only event loop. A
 * follower instead keeps a cursor and long-polls:
 *
 *   GET /api/orchestration/events?after=<sequence>&limit=<1..1000>&wait=<0..25>
 *
 * Events come from the sequence primary key in ascending order, shaped exactly
 * as the WebSocket `replayEvents` RPC returns them (project repository identity
 * attached, team-mode visibility applied, activity payloads projected). When
 * nothing is newer than `after`, the request is held until the engine
 * publishes a newer event or `wait` seconds pass; there is no polling loop.
 *
 * `410 cursor-invalid` means the cursor is ahead of the log (the database was
 * replaced): re-read the shell and restart from its `snapshotSequence`. The
 * event log is never pruned, so an old cursor is always served.
 *
 * Contract: ~/perf-audit-bkt3/80-api-contract.md, section 1.
 */
import {
  AuthOrchestrationReadScope,
  OrchestrationEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { projectActivityEvent } from "./ActivityPayloadProjection.ts";
import { authenticateForkRoute, catchForkRouteAuthErrors } from "./forkRouteAuth.expbkt3.ts";
import { OrchestrationAccessControl } from "./Services/AccessControl.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const EVENT_FEED_PATH = "/api/orchestration/events";
export const EVENT_FEED_DEFAULT_LIMIT = 500;
export const EVENT_FEED_MAX_LIMIT = 1000;
export const EVENT_FEED_MAX_WAIT_SECONDS = 25;

export interface EventFeedQuery {
  readonly after: number;
  readonly limit: number;
  readonly waitSeconds: number;
}

const parseIntegerParam = (
  params: URLSearchParams,
  name: string,
  bounds: { readonly min: number; readonly max: number; readonly fallback?: number },
): number | string => {
  const raw = params.get(name);
  if (raw === null || raw === "") {
    return bounds.fallback ?? `${name} is required`;
  }
  if (!/^\d+$/.test(raw)) return `${name} must be a non-negative integer`;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    return `${name} must be between ${bounds.min} and ${bounds.max}`;
  }
  return value;
};

/** Parses the query string; a string result is the reason it was rejected. */
export const parseEventFeedQuery = (params: URLSearchParams): EventFeedQuery | string => {
  const after = parseIntegerParam(params, "after", { min: 0, max: Number.MAX_SAFE_INTEGER });
  if (typeof after === "string") return after;
  const limit = parseIntegerParam(params, "limit", {
    min: 1,
    max: EVENT_FEED_MAX_LIMIT,
    fallback: EVENT_FEED_DEFAULT_LIMIT,
  });
  if (typeof limit === "string") return limit;
  const waitSeconds = parseIntegerParam(params, "wait", {
    min: 0,
    max: EVENT_FEED_MAX_WAIT_SECONDS,
    fallback: 0,
  });
  if (typeof waitSeconds === "string") return waitSeconds;
  return { after, limit, waitSeconds };
};

const encodeEvents = Schema.encodeEffect(Schema.Array(OrchestrationEvent));

export type EventFeedResult =
  | {
      readonly _tag: "Page";
      readonly events: ReadonlyArray<OrchestrationEvent>;
      readonly nextAfter: number;
      readonly headSequence: number;
    }
  | { readonly _tag: "CursorInvalid"; readonly headSequence: number };

/**
 * Reads one page of the feed for `actorUserId` (null = unrestricted operator).
 * `nextAfter` advances past events the actor may not see, so a filtered
 * follower never re-reads them.
 */
export const readEventFeedPage = Effect.fn("orchestration.eventFeed.read")(function* (
  query: EventFeedQuery,
  actorUserId: Parameters<OrchestrationAccessControl["Service"]["canAccessThread"]>[0] | null,
) {
  const engine = yield* OrchestrationEngineService;
  const headBefore = yield* engine.latestSequence;
  if (query.after > headBefore) {
    return { _tag: "CursorInvalid", headSequence: headBefore } satisfies EventFeedResult;
  }

  const readPage = Stream.runCollect(engine.readEvents(query.after, query.limit)).pipe(
    Effect.map((events) => Array.from(events)),
  );
  const raw = yield* Effect.scoped(
    Effect.gen(function* () {
      // Subscribe before reading, so an event committed between the read and
      // the wait still wakes this request.
      const live = yield* engine.subscribeDomainEvents;
      const page = yield* readPage;
      if (page.length > 0 || query.waitSeconds === 0) return page;
      const woke = yield* live.pipe(
        Stream.filter((event) => event.sequence > query.after),
        Stream.runHead,
        Effect.timeoutOption(Duration.seconds(query.waitSeconds)),
      );
      return Option.isSome(woke) ? yield* readPage : page;
    }),
  );

  const visible = yield* filterVisible(raw, actorUserId);
  const events = yield* Effect.forEach(visible, attachRepositoryIdentity, { concurrency: 4 });
  return {
    _tag: "Page",
    events: events.map(projectActivityEvent),
    nextAfter: raw.at(-1)?.sequence ?? query.after,
    headSequence: Math.max(yield* engine.latestSequence, raw.at(-1)?.sequence ?? 0),
  } satisfies EventFeedResult;
});

const filterVisible = Effect.fnUntraced(function* (
  events: ReadonlyArray<OrchestrationEvent>,
  actorUserId: Parameters<OrchestrationAccessControl["Service"]["canAccessThread"]>[0] | null,
) {
  if (actorUserId === null) return events;
  const accessControl = yield* OrchestrationAccessControl;
  const allowed = new Map<string, boolean>();
  const visible: OrchestrationEvent[] = [];
  for (const event of events) {
    const key = `${event.aggregateKind}:${event.aggregateId}`;
    let canSee = allowed.get(key);
    if (canSee === undefined) {
      canSee = yield* (
        event.aggregateKind === "thread"
          ? accessControl.canAccessThread(actorUserId, ThreadId.make(event.aggregateId))
          : accessControl.canAccessProject(actorUserId, ProjectId.make(event.aggregateId))
      ).pipe(Effect.orElseSucceed(() => false));
      allowed.set(key, canSee);
    }
    if (canSee) visible.push(event);
  }
  return visible;
});

/** Mirrors the WebSocket replay: project events carry the resolved repository identity. */
const attachRepositoryIdentity = (
  event: OrchestrationEvent,
): Effect.Effect<
  OrchestrationEvent,
  never,
  RepositoryIdentityResolver.RepositoryIdentityResolver | ProjectionSnapshotQuery
> =>
  Effect.gen(function* () {
    const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
    if (event.type === "project.created") {
      const repositoryIdentity = yield* resolver.resolve(event.payload.workspaceRoot);
      return { ...event, payload: { ...event.payload, repositoryIdentity } };
    }
    if (event.type === "project.meta-updated") {
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const workspaceRoot =
        event.payload.workspaceRoot ??
        Option.match(yield* projectionSnapshotQuery.getProjectShellById(event.payload.projectId), {
          onNone: () => null,
          onSome: (project) => project.workspaceRoot,
        });
      if (workspaceRoot === null) return event;
      const repositoryIdentity = yield* resolver.resolve(workspaceRoot);
      return { ...event, payload: { ...event.payload, repositoryIdentity } };
    }
    return event;
  }).pipe(Effect.orElseSucceed(() => event));

const jsonError = (status: number, body: Record<string, unknown>) =>
  HttpServerResponse.jsonUnsafe(body, { status });

const eventFeedHandler = Effect.gen(function* () {
  const session = yield* authenticateForkRoute(AuthOrchestrationReadScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  const query = parseEventFeedQuery(
    Option.isSome(url) ? url.value.searchParams : new URLSearchParams(),
  );
  if (typeof query === "string") {
    return jsonError(400, { error: "invalid-request", detail: query });
  }
  const accessControl = yield* OrchestrationAccessControl;
  const actorUserId = Option.getOrNull(accessControl.actorFor(session.subject, session.userId));
  const result = yield* readEventFeedPage(query, actorUserId);
  if (result._tag === "CursorInvalid") {
    return jsonError(410, { error: "cursor-invalid", headSequence: result.headSequence });
  }
  return HttpServerResponse.jsonUnsafe({
    events: yield* encodeEvents(result.events),
    nextAfter: result.nextAfter,
    headSequence: result.headSequence,
  });
}).pipe(
  catchForkRouteAuthErrors,
  Effect.catch((error) =>
    Effect.logWarning("orchestration event feed failed", { error }).pipe(
      Effect.as(jsonError(500, { error: "internal-error" })),
    ),
  ),
);

/** The access-control service is captured once, when the route layer is built. */
export const eventFeedRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const accessControl = yield* OrchestrationAccessControl;
    return HttpRouter.add(
      "GET",
      EVENT_FEED_PATH,
      eventFeedHandler.pipe(Effect.provideService(OrchestrationAccessControl, accessControl)),
    );
  }),
);

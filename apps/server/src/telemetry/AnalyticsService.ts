/**
 * Events go to the T3 Code ingest endpoint, which keeps a copy and forwards
 * them to PostHog. Each event carries a uuid, so PostHog can tell a retried
 * copy from a new event.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ClientOs } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Hex from "effect/encoding/Hex"; // T3-CUSTOM(expbkt3): insert-id hashing.
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { getTelemetryIdentifier } from "./Identify.ts";
// T3-CUSTOM(expbkt3): BEGIN — property allowlist and per-user identity (TEC-1631).
import { filterAnalyticsProperties } from "./analyticsProperties.ts";
import {
  type AnalyticsPerson,
  makeAnalyticsUserDirectory,
  uuidFromSha256Hex,
} from "./analyticsIdentity.ts";
// T3-CUSTOM(expbkt3): END

interface BufferedAnalyticsEvent {
  readonly uuid: string;
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
  /** T3-CUSTOM(expbkt3): an identified person's email; unset events use the install id. */
  readonly distinctId?: string;
}

interface DeliveryState {
  readonly failedBatch: ReadonlyArray<BufferedAnalyticsEvent>;
  readonly batchAttempts: number;
  readonly failures: number;
  readonly retryAt: number;
}

// The background flush checks for work at this interval, so a retry delay
// shorter than it waits for the next check.
const FLUSH_INTERVAL_MS = 10_000;
// A hung send would hold the flush lock, and with it the shutdown flush.
const SEND_TIMEOUT = "10 seconds";
const MAX_BATCH_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 300_000;
// The endpoint answers these when the batch itself is wrong (bad body, wrong
// api_key, too large), so sending it again cannot help. 408 and 429 are not
// here because a later send can succeed.
const REJECTED_BATCH_STATUSES = new Set([400, 401, 413]);

/**
 * Release channel of this build. Release workflows set it for
 * pingdotgg/t3code builds (see apps/server/vite.config.ts); every other build
 * reports "dev". It is separate from `__T3CODE_BUILD_CHANNEL__`, which names
 * stable "latest" and preview "nightly" for the sign-in page.
 */
declare const __T3CODE_TELEMETRY_CHANNEL__: "stable" | "nightly" | "preview" | "dev" | undefined;

/** `random` is in [0, 1). */
export function retryDelayMs(failures: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failures - 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

const TelemetryEnvConfig = Config.all({
  // T3-CUSTOM(expbkt3): no default key. The fork must never send to the upstream
  // maintainers' PostHog project, so telemetry stays off until a key is set.
  posthogKey: Config.String("T3CODE_POSTHOG_KEY").pipe(Config.withDefault("")),
  // T3-CUSTOM(expbkt3): the PostHog `instance` group every event belongs to.
  instance: Config.String("T3CODE_ANALYTICS_INSTANCE").pipe(Config.withDefault("unknown")),
  posthogHost: Config.String("T3CODE_POSTHOG_HOST").pipe(
    Config.withDefault("https://ingest.t3.codes"),
  ),
  enabled: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  flushBatchSize: Config.Number("T3CODE_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(20)),
  maxBufferedEvents: Config.Number("T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
  wslDistroName: Config.String("WSL_DISTRO_NAME").pipe(Config.option),
});

// T3-CUSTOM(expbkt3): BEGIN — record options (TEC-1631).
export interface AnalyticsRecordOptions {
  /** Environment user who acted; sent as that person's email when known. */
  readonly userId?: string;
  /** ISO time the event happened, for events recorded after the fact. */
  readonly timestamp?: string;
  /** Stable id for de-duplication; the same id always maps to the same event uuid. */
  readonly insertId?: string;
}
// T3-CUSTOM(expbkt3): END

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** T3-CUSTOM(expbkt3): may identify a user. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
      options?: AnalyticsRecordOptions, // T3-CUSTOM(expbkt3): identity and backfill options.
    ) => Effect.Effect<void>;

    readonly flush: Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
      flush: Effect.void,
    }),
  );
}

function serverOsFromNodePlatform(platform: string): ClientOs {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "android":
      return "Android";
    default:
      return "other";
  }
}

/** @public */
/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const telemetryConfig = yield* TelemetryEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const identifier = yield* getTelemetryIdentifier;
  const crypto = yield* Crypto.Crypto;
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
  const deliveryRef = yield* Ref.make<DeliveryState>({
    failedBatch: [],
    batchAttempts: 0,
    failures: 0,
    retryAt: 0,
  });
  // The background flush and the shutdown flush must not send the same batch at once.
  const flushLock = yield* Semaphore.make(1);
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const telemetryChannel =
    typeof __T3CODE_TELEMETRY_CHANNEL__ === "undefined" ? "dev" : __T3CODE_TELEMETRY_CHANNEL__;
  const hostPlatform = yield* HostProcess.Platform;
  const hostArchitecture = yield* HostProcess.Architecture;
  // T3-CUSTOM(expbkt3): BEGIN — key-gated telemetry, identity and instance group.
  const telemetryEnabled = telemetryConfig.enabled && telemetryConfig.posthogKey.trim() !== "";
  const userDirectory = yield* makeAnalyticsUserDirectory;
  const identifiedUsers = yield* Ref.make<ReadonlySet<string>>(new Set());
  const droppedKeysLogged = yield* Ref.make<ReadonlySet<string>>(new Set());
  // T3-CUSTOM(expbkt3): END

  const enqueueBufferedEvent = (
    entry: Omit<BufferedAnalyticsEvent, "capturedAt">,
    timestamp?: string, // T3-CUSTOM(expbkt3): caller-supplied event time.
  ) =>
    Effect.flatMap(DateTime.now, (now) =>
      Ref.modify(bufferRef, (current) => {
        const appended = [
          ...current,
          {
            ...entry, // T3-CUSTOM(expbkt3): one entry object.
            capturedAt: timestamp ?? DateTime.formatIso(now), // T3-CUSTOM(expbkt3)
          } satisfies BufferedAnalyticsEvent,
        ];

        const next =
          appended.length > telemetryConfig.maxBufferedEvents
            ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
            : appended;

        return [
          {
            size: next.length,
            dropped: next.length !== appended.length,
          } as const,
          next,
        ] as const;
      }),
    );

  const sendBatch = Effect.fn("AnalyticsService.sendBatch")(function* (
    events: ReadonlyArray<BufferedAnalyticsEvent>,
  ) {
    if (!telemetryEnabled || !identifier) return; // T3-CUSTOM(expbkt3): key-gated.

    const payload = {
      api_key: telemetryConfig.posthogKey,
      batch: events.map((event) => ({
        uuid: event.uuid,
        event: event.event,
        distinct_id: event.distinctId ?? identifier, // T3-CUSTOM(expbkt3): identified person.
        properties: {
          ...event.properties,
          // T3-CUSTOM(expbkt3): only identified events build a person profile.
          $process_person_profile: event.distinctId !== undefined,
          $groups: { instance: telemetryConfig.instance },
          instance: telemetryConfig.instance,
          platform: hostPlatform,
          wsl: Option.getOrUndefined(telemetryConfig.wslDistroName),
          arch: hostArchitecture,
          t3CodeVersion: packageJson.version,
          telemetryChannel,
          clientType,
          serverOs: serverOsFromNodePlatform(hostPlatform),
          serverArch: hostArchitecture,
          serverWslDistro: Option.getOrUndefined(telemetryConfig.wslDistroName),
          serverAppVersion: packageJson.version,
          serverMode: serverConfig.mode,
        },
        timestamp: event.capturedAt,
      })),
    };

    yield* HttpClientRequest.post(`${telemetryConfig.posthogHost}/batch/`).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout(SEND_TIMEOUT),
    );
  });

  const takeBatch = Ref.modify(bufferRef, (current) => {
    const nextBatch = current.slice(0, telemetryConfig.flushBatchSize);
    return [nextBatch, current.slice(nextBatch.length)] as const;
  });

  // A rejected batch is dropped at once, but the next batch still waits for the
  // backoff, so a wrong api_key does not send every batch as fast as it can.
  const flush: AnalyticsService["Service"]["flush"] = Effect.gen(function* () {
    while (true) {
      const delivery = yield* Ref.get(deliveryRef);
      const batch = delivery.failedBatch.length > 0 ? delivery.failedBatch : yield* takeBatch;
      if (batch.length === 0) {
        return;
      }

      const sent = yield* Effect.result(sendBatch(batch));
      if (Result.isSuccess(sent)) {
        yield* Ref.set(deliveryRef, { failedBatch: [], batchAttempts: 0, failures: 0, retryAt: 0 });
        continue;
      }

      const failures = delivery.failures + 1;
      const batchAttempts = delivery.batchAttempts + 1;
      const retryAt = (yield* Clock.currentTimeMillis) + retryDelayMs(failures, yield* Random.next);
      const error = sent.failure;
      const rejected =
        error._tag === "HttpClientError" &&
        error.reason._tag === "StatusCodeError" &&
        REJECTED_BATCH_STATUSES.has(error.reason.response.status);
      if (!rejected && batchAttempts < MAX_BATCH_ATTEMPTS) {
        yield* Ref.set(deliveryRef, { failedBatch: batch, batchAttempts, failures, retryAt });
        yield* Effect.logDebug("Failed to send telemetry batch; will retry", {
          attempt: batchAttempts,
          cause: error,
        });
        return;
      }
      yield* Ref.set(deliveryRef, { failedBatch: [], batchAttempts: 0, failures, retryAt });
      yield* Effect.logWarning(
        rejected
          ? "Dropped telemetry batch the endpoint rejected"
          : "Dropped telemetry batch after repeated send failures",
        { events: batch.length, attempts: batchAttempts, cause: error },
      );
      return;
    }
  }).pipe(flushLock.withPermit);

  const flushWhenDue = Effect.gen(function* () {
    const { retryAt } = yield* Ref.get(deliveryRef);
    if ((yield* Clock.currentTimeMillis) >= retryAt) {
      yield* flush;
    }
  });

  // T3-CUSTOM(expbkt3): BEGIN — allowlist, identity, insert ids (TEC-1631).
  const logDroppedKeys = (event: string, dropped: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (dropped.length === 0) return;
      const fresh = yield* Ref.modify(
        droppedKeysLogged,
        (logged): readonly [ReadonlyArray<string>, ReadonlySet<string>] => {
          const unseen = dropped.filter((key) => !logged.has(key));
          return [unseen, unseen.length === 0 ? logged : new Set([...logged, ...unseen])];
        },
      );
      for (const key of fresh) {
        yield* Effect.logDebug("analytics property key not allowlisted; dropping it", {
          event,
          key,
        });
      }
    });

  const eventUuid = (insertId: string | undefined) =>
    Effect.gen(function* () {
      if (insertId !== undefined) {
        const digest = yield* Effect.exit(
          crypto.digest("SHA-256", new TextEncoder().encode(insertId)),
        );
        if (Exit.isSuccess(digest)) return uuidFromSha256Hex(Hex.encode(digest.value));
      }
      const uuid = yield* Effect.exit(crypto.randomUUIDv7());
      return Exit.isSuccess(uuid) ? uuid.value : undefined;
    });

  /** Sends the person's profile once per user per process start. */
  const identifyOnce = (userId: string, person: AnalyticsPerson) =>
    Effect.gen(function* () {
      const first = yield* Ref.modify(
        identifiedUsers,
        (seen): readonly [boolean, ReadonlySet<string>] =>
          seen.has(userId) ? [false, seen] : [true, new Set([...seen, userId])],
      );
      if (!first) return;
      const uuid = yield* eventUuid(undefined);
      if (uuid === undefined) return;
      yield* enqueueBufferedEvent({
        uuid,
        event: "$identify",
        distinctId: person.email,
        properties: {
          $set: {
            email: person.email,
            role: person.role,
            ...(person.name === undefined ? {} : { name: person.name }),
          },
        },
      });
    });

  const record: AnalyticsService["Service"]["record"] = Effect.fn("AnalyticsService.record")(
    function* (event, properties, options) {
      if (!telemetryEnabled || !identifier) return;

      const { kept, dropped } = filterAnalyticsProperties(properties);
      yield* logDroppedKeys(event, dropped);

      const person =
        options?.userId === undefined ? undefined : yield* userDirectory.resolve(options.userId);
      if (person !== undefined && options?.userId !== undefined) {
        yield* identifyOnce(options.userId, person);
      }

      // Telemetry is best effort: an event without a uuid is not sent. The
      // Node implementation throws (a defect) rather than failing, so catch both.
      // T3-CUSTOM(expbkt3): an insert id yields a stable uuid, so a backfill never duplicates.
      const uuid = yield* eventUuid(options?.insertId);
      if (uuid === undefined) return;

      const enqueueResult = yield* enqueueBufferedEvent(
        {
          uuid,
          event,
          properties: {
            ...kept,
            ...(options?.insertId === undefined ? {} : { $insert_id: options.insertId }),
          },
          ...(person === undefined ? {} : { distinctId: person.email }),
        },
        options?.timestamp,
      );
      if (enqueueResult.dropped) {
        yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
          size: enqueueResult.size,
          event,
        });
      }
    },
  );

  // One group profile per boot, named after the instance. An unnamed instance
  // has nothing worth a profile.
  if (telemetryEnabled && identifier && telemetryConfig.instance !== "unknown") {
    const uuid = yield* eventUuid(undefined);
    if (uuid !== undefined) {
      yield* enqueueBufferedEvent({
        uuid,
        event: "$groupidentify",
        properties: {
          $group_type: "instance",
          $group_key: telemetryConfig.instance,
          $group_set: { name: telemetryConfig.instance, t3CodeVersion: packageJson.version },
        },
      });
    }
  }
  // T3-CUSTOM(expbkt3): END

  yield* Effect.forever(Effect.sleep(FLUSH_INTERVAL_MS).pipe(Effect.flatMap(() => flushWhenDue)), {
    disableYield: true,
  }).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() => flush);

  return AnalyticsService.of({ record, flush });
});

export const layer = Layer.effect(AnalyticsService, make);

const layerTest = AnalyticsService.layerTest;

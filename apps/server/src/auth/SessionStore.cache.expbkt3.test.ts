import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  EnvironmentUserId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { base64UrlEncode, signPayload } from "./utils.ts";

const layerSessionStore = SessionStore.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-session-cache-test-" })),
);

const withSessionStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.merge(layerSessionStore, TestClock.layer())));

/** Same random bytes every call, so the next issued session id is known up front. */
const fixedCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

it.layer(NodeServices.layer)("SessionStore session cache", (it) => {
  it.effect("answers verify from the cache until the cache TTL passes", () =>
    withSessionStore(
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        const issued = yield* sessions.issue({ subject: "cached" });
        expect((yield* sessions.verify(issued.token)).userId).toBeNull();

        // A write from outside this process is not seen while the row is cached,
        // which proves the second verify did not read the database.
        yield* sql`
          UPDATE auth_sessions SET user_id = 'user_out_of_band'
          WHERE session_id = ${issued.sessionId}
        `;
        expect((yield* sessions.verify(issued.token)).userId).toBeNull();

        yield* TestClock.adjust(Duration.seconds(60));
        expect((yield* sessions.verify(issued.token)).userId).toBe("user_out_of_band");
      }),
    ),
  );

  it.effect.each(["revoke", "revokeAllExcept", "revokeByUserId"] as const)(
    "rejects a cached session immediately after %s",
    (operation) =>
      withSessionStore(
        Effect.gen(function* () {
          const sessions = yield* SessionStore.SessionStore;
          const userId = EnvironmentUserId.make("user_clerk_alice");
          const keeper = yield* sessions.issue({ subject: "keeper" });
          const issued = yield* sessions.issue({ subject: "cached", userId });
          const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);
          yield* sessions.verify(issued.token);
          yield* sessions.verifyWebSocketToken(websocket.token);

          if (operation === "revoke") {
            yield* sessions.revoke(issued.sessionId);
          } else if (operation === "revokeAllExcept") {
            yield* sessions.revokeAllExcept(keeper.sessionId);
          } else {
            yield* sessions.revokeByUserId(userId);
          }

          expect((yield* Effect.flip(sessions.verify(issued.token)))._tag).toBe(
            "SessionTokenRevokedError",
          );
          expect((yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token)))._tag).toBe(
            "WebSocketSessionRevokedError",
          );
          expect((yield* sessions.verify(keeper.token)).sessionId).toBe(keeper.sessionId);
        }),
      ),
  );

  it.effect("rejects a cached row once the session itself has expired", () =>
    withSessionStore(
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({
          subject: "short-lived",
          method: "bearer-access-token",
          ttl: Duration.seconds(30),
        });
        const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);
        yield* sessions.verifyWebSocketToken(websocket.token);

        // Still inside the 60 s cache TTL, past the session's own expiry.
        yield* TestClock.adjust(Duration.seconds(31));
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token)))._tag).toBe(
          "WebSocketSessionExpiredError",
        );
      }),
    ),
  );

  it.effect("verifies a session created after its id was cached as unknown", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const crypto = yield* Crypto.Crypto;
      // The id the next `issue` will draw from the fixed random source.
      const sessionId = AuthSessionId.make(yield* crypto.randomUUIDv4());
      const issuedAtMs = yield* Clock.currentTimeMillis;
      const payload = base64UrlEncode(
        JSON.stringify({
          v: 1,
          kind: "session",
          sid: sessionId,
          sub: "early",
          scopes: AuthStandardClientScopes,
          method: "browser-session-cookie",
          iat: issuedAtMs,
          exp: issuedAtMs + Duration.toMillis(Duration.hours(1)),
        }),
      );
      const secret = yield* secrets.getOrCreateRandom("server-signing-key", 32);
      const token = `${payload}.${signPayload(payload, secret)}`;

      expect((yield* Effect.flip(sessions.verify(token)))._tag).toBe("UnknownSessionTokenError");
      const issued = yield* sessions.issue({ subject: "early" });
      expect(issued.sessionId).toBe(sessionId);
      // No wait for the 10 s negative TTL: issuing cleared the cached miss.
      expect((yield* sessions.verify(token)).sessionId).toBe(sessionId);
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerSessionStore.pipe(Layer.provideMerge(Layer.succeed(Crypto.Crypto, fixedCrypto))),
          TestClock.layer(),
        ),
      ),
    ),
  );

  it.effect("writes last_connected_at at most once per 5 minutes of reconnects", () =>
    withSessionStore(
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE last_connected_writes (session_id TEXT NOT NULL)`;
        yield* sql`
          CREATE TRIGGER count_last_connected_writes
          AFTER UPDATE OF last_connected_at ON auth_sessions
          BEGIN
            INSERT INTO last_connected_writes VALUES (NEW.session_id);
          END
        `;
        const countWrites = sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count" FROM last_connected_writes
        `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));
        const issued = yield* sessions.issue({ subject: "reconnecting" });
        const reconnect = Effect.andThen(
          sessions.markConnected(issued.sessionId),
          sessions.markDisconnected(issued.sessionId),
        );
        const firstConnectAtMs = yield* Clock.currentTimeMillis;

        yield* reconnect;
        expect(yield* countWrites).toBe(1);

        yield* TestClock.adjust(Duration.minutes(4));
        yield* reconnect;
        yield* reconnect;
        expect(yield* countWrites).toBe(1);

        yield* TestClock.adjust(Duration.minutes(1));
        yield* reconnect;
        expect(yield* countWrites).toBe(2);
        const [active] = yield* sessions.listActive();
        expect(active?.lastConnectedAt?.epochMilliseconds).toBe(
          firstConnectAtMs + Duration.toMillis(Duration.minutes(5)),
        );
      }),
    ),
  );

  it.effect("writes client connection metadata only when it changes", () =>
    withSessionStore(
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE client_connection_writes (session_id TEXT NOT NULL)`;
        yield* sql`
          CREATE TRIGGER count_client_connection_writes
          AFTER UPDATE OF client_surface, client_app_version ON auth_sessions
          BEGIN
            INSERT INTO client_connection_writes VALUES (NEW.session_id);
          END
        `;
        const countWrites = sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count" FROM client_connection_writes
        `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));
        const issued = yield* sessions.issue({ subject: "client-metadata" });

        yield* sessions.recordClientConnection(issued.sessionId, {
          surface: "web",
          appVersion: "1.0.0",
        });
        expect((yield* sessions.verify(issued.token)).client.appVersion).toBe("1.0.0");
        yield* sessions.recordClientConnection(issued.sessionId, {
          surface: "web",
          appVersion: "1.0.0",
        });
        yield* sessions.recordClientConnection(issued.sessionId, { surface: "web" });
        expect(yield* countWrites).toBe(1);

        yield* sessions.recordClientConnection(issued.sessionId, {
          surface: "web",
          appVersion: "1.1.0",
        });
        expect(yield* countWrites).toBe(2);
        // The cached row follows the write.
        expect((yield* sessions.verify(issued.token)).client.appVersion).toBe("1.1.0");
      }),
    ),
  );
});

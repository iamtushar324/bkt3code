import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AuthBrowserSessionRequest,
  AuthClientSession,
  AuthTokenExchangeRequest,
  EnvironmentUserDirectoryResult,
  EnvironmentUserId,
  EnvironmentUserUpdateInput,
  SourceControlProfileId,
} from "./index.ts";

const decodeEnvironmentUserDirectory = Schema.decodeUnknownEffect(EnvironmentUserDirectoryResult);
const decodeBrowserSessionRequest = Schema.decodeUnknownEffect(AuthBrowserSessionRequest);
const decodeTokenExchangeRequest = Schema.decodeUnknownEffect(AuthTokenExchangeRequest);
const decodeClientSession = Schema.decodeUnknownEffect(AuthClientSession);
const decodeEnvironmentUserUpdate = Schema.decodeUnknownEffect(EnvironmentUserUpdateInput);

describe("environment user contracts", () => {
  it.effect("decodes a durable Clerk user with live presence and GitHub ownership", () =>
    Effect.gen(function* () {
      const result = yield* decodeEnvironmentUserDirectory({
        identityMode: "required",
        users: [
          {
            id: "user_clerk_alice",
            identity: { provider: "clerk", subject: "user_clerk_alice" },
            displayName: "Alice Example",
            primaryEmail: "alice@example.com",
            avatarUrl: "https://images.example.com/alice.png",
            role: "admin",
            status: "active",
            sourceControlProfileId: "github_alice",
            presence: "online",
            connectedSessionCount: 2,
            sessionCount: 3,
            current: true,
            firstSeenAt: DateTime.makeUnsafe("2026-08-01T10:00:00.000Z"),
            lastSeenAt: DateTime.makeUnsafe("2026-08-01T11:00:00.000Z"),
          },
        ],
        unidentifiedSessionCount: 1,
      });

      expect(result.users[0]?.id).toBe(EnvironmentUserId.make("user_clerk_alice"));
      expect(result.users[0]?.sourceControlProfileId).toBe(
        SourceControlProfileId.make("github_alice"),
      );
      expect(result.users[0]?.presence).toBe("online");
    }),
  );

  it.effect("accepts Clerk identity as a write-only bootstrap field", () =>
    Effect.gen(function* () {
      const browser = yield* decodeBrowserSessionRequest({
        credential: "pairing-token",
        identityToken: "signed-clerk-token",
      });
      const remote = yield* decodeTokenExchangeRequest({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: "pairing-token",
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        identity_token: "signed-clerk-token",
      });

      expect(browser.identityToken).toBe("signed-clerk-token");
      expect(remote.identity_token).toBe("signed-clerk-token");
    }),
  );

  it.effect("keeps older client sessions and user updates backward compatible", () =>
    Effect.gen(function* () {
      const session = yield* decodeClientSession({
        sessionId: "session-1",
        subject: "browser",
        scopes: ["orchestration:read"],
        method: "browser-session-cookie",
        client: { deviceType: "desktop" },
        issuedAt: DateTime.makeUnsafe("2026-08-01T10:00:00.000Z"),
        expiresAt: DateTime.makeUnsafe("2026-08-01T11:00:00.000Z"),
        lastConnectedAt: null,
        connected: false,
        current: false,
      });
      const update = yield* decodeEnvironmentUserUpdate({
        userId: "user_clerk_alice",
        status: "blocked",
      });

      expect(session.userId).toBeNull();
      expect(update).toEqual({ userId: "user_clerk_alice", status: "blocked" });
    }),
  );
});

/** T3-CUSTOM(expbkt3): Local API connection isolation, lifecycle, recovery, and scoped callbacks. */
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { ToolyardConnectionCore } from "./ToolyardConnectionCore.ts";

const bootstrap = "ag_fixture.bootstrap-only-secret";
const memberBootstrap = "ag_member.member-bootstrap-secret";
function fixture(environmentId = "local-env", storage = { value: null as string | null }) {
  let now = Date.parse("2026-10-05T00:00:00Z");
  let outage = false;
  let parentRevoked = false;
  let revokeOutage = false;
  let failWrite = false;
  let renewalHook = async () => {};
  let generation = 1;
  const requests: { path: string; body: Record<string, unknown>; token: string | undefined }[] = [];
  const core = new ToolyardConnectionCore({
    environmentId,
    read: async () => storage.value,
    write: async (value) => {
      if (failWrite) {
        failWrite = false;
        throw new Error("storage unavailable");
      }
      storage.value = value;
    },
    now: () => now,
    verifyUser: async (userId) => {
      if (userId !== "local-user" && !userId.startsWith("user_")) throw new Error("unknown owner");
      return { email: null, admin: userId === "local-user" || userId === "user_admin" };
    },
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const token = (init?.headers as Record<string, string>)?.authorization;
      requests.push({ path, body, token });
      if (outage) throw new Error("unavailable");
      const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
      const credential = (userId: string, version = 1) => ({
        token: `derived:${environmentId}:${userId}`,
        email: "owner@example.test",
        agent_id: `agent:${environmentId}:${userId}`,
        user_id: "real-toolyard-owner",
        expires_at: DateTime.formatIso(DateTime.makeUnsafe(now + 30 * 86400_000)),
        credential_version: version,
        instance_id: "ty-one",
        connection_generation: generation,
      });
      if (path === "/.well-known/toolyard-instance")
        return reply({
          instance_id: "ty-one",
          capabilities: [
            "connections.api-key.v1",
            "callbacks.pull.v1",
            "inbox.batch.v1",
            "callbacks.standard-webhooks.v1",
            "dashboard.handoff.v1",
          ],
        });
      if (path === "/v1/connections/api-key") {
        if (parentRevoked) return reply({ error: "parent_key_revoked" }, 401);
        if (
          token !== `Bearer ${body.local_user_id === "user_member" ? memberBootstrap : bootstrap}`
        )
          return reply({ error: "invalid_api_key" }, 401);
        return reply(credential(body.local_user_id));
      }
      if (path === "/v1/connections/renew") {
        await renewalHook();
        if (parentRevoked) return reply({ error: "parent_key_revoked" }, 401);
        return reply(credential(token!.split(":").at(-1)!, body.expected_version + 1));
      }
      if (path === "/v1/connections/handoff")
        return reply({
          url: "https://toolyard.test/v1/federation/handoff?code=single-use",
          expires_at: DateTime.formatIso(DateTime.makeUnsafe(now + 60_000)),
        });
      if (path === "/v1/connections/revoke") {
        if (revokeOutage) throw new Error("revoke unavailable");
        return reply({ revoked: true });
      }
      if (path === "/v1/callbacks/receivers")
        return reply({ callback_ref: "receiver-one", revision: 1 });
      if (path.endsWith("/events"))
        return reply({
          events: [
            {
              event_id: "evt-one",
              body: '{"event_id":"evt-one"}',
              headers: {
                "webhook-id": "evt-one",
                "webhook-timestamp": "123",
                "webhook-signature": "v1,signature",
              },
            },
          ],
        });
      if (path.endsWith("/ack")) return reply({ acknowledged: true });
      return reply({ deliveries: [] });
    },
  });
  const connect = (userId = "local-user", expectedRevision = 0, extras = {}) =>
    core.configure(userId, {
      expectedRevision,
      baseUrl: "https://toolyard.test",
      origin: "http://127.0.0.1:1234",
      enabled: true,
      mode: "api-key",
      apiKey: userId === "user_member" ? memberBootstrap : bootstrap,
      ...extras,
    });
  return {
    core,
    storage,
    requests,
    connect,
    advance: (ms: number) => {
      now += ms;
    },
    setOutage: (value: boolean) => {
      outage = value;
    },
    setRevokeOutage: (value: boolean) => {
      revokeOutage = value;
    },
    revokeParent: () => {
      parentRevoked = true;
    },
    setGeneration: (value: number) => {
      generation = value;
    },
    setRenewalHook: (hook: () => Promise<void>) => {
      renewalHook = hook;
    },
    failWrite: () => {
      failWrite = true;
    },
  };
}

describe("per-user API key connection", () => {
  it("accepts a local authenticated owner without a public origin and never persists bootstrap secrets", async () => {
    const f = fixture();
    await f.core.initialize();
    const status = await f.connect();
    expect(status).toMatchObject({
      mode: "api-key",
      callbackTransport: "pull",
      connection: "connected",
      revision: 1,
      origin: "https://toolyard.test",
    });
    expect(f.storage.value).not.toContain(bootstrap);
    expect(JSON.stringify(status)).not.toContain("derived:");
    expect(f.requests[1]).toMatchObject({
      body: {
        environment_id: "local-env",
        local_user_id: "local-user",
        instance_id: "ty-one",
        expected_version: 0,
      },
      token: `Bearer ${bootstrap}`,
    });
    expect(f.core.callbackBinding("local-user")).toMatchObject({
      transport: "pull",
      agentId: "agent:local-env:local-user",
    });
  });
  it("keeps members on the configured instance and isolates their credentials", async () => {
    const f = fixture();
    await f.core.initialize();
    await expect(f.connect("user_member")).rejects.toMatchObject({
      code: "administrator_required",
    });
    await f.connect("user_admin");
    await f.connect("user_member", 1);
    expect((await f.core.status("user_member")).revision).toBe(1);
    expect((await f.core.credential("user_member"))?.token).not.toBe(
      (await f.core.credential("user_admin"))?.token,
    );
    await expect(
      f.connect("user_member", 1, { baseUrl: "https://other.test" }),
    ).rejects.toMatchObject({ code: "administrator_required" });
    await expect(f.connect("user_member", 0)).rejects.toMatchObject({
      code: "settings_revision_conflict",
    });
  });
  it("recovers a lost response through explicit retry without retaining the key", async () => {
    const f = fixture();
    await f.core.initialize();
    f.failWrite();
    await expect(f.connect()).rejects.toThrow("storage unavailable");
    expect(f.core.binding()).toBeNull();
    await f.connect();
    const first = await f.core.credential("local-user");
    await f.connect("local-user", 1);
    expect(await f.core.credential("local-user")).toEqual(first);
  });
  it("renews after restart with compare-and-swap and the same agent identity", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.connect();
    const next = fixture("local-env", f.storage);
    await next.core.initialize();
    next.advance(30 * 86400_000);
    await Promise.all([next.core.reconcileCredentials(), next.core.credential("local-user")]);
    expect(next.requests.filter((r) => r.path.endsWith("/renew"))).toHaveLength(1);
    expect(next.requests[0]).toMatchObject({
      body: { expected_version: 1 },
      token: "Bearer derived:local-env:local-user",
    });
    expect((await next.core.credential("local-user"))?.agentId).toBe("agent:local-env:local-user");
    expect(next.requests.some((r) => r.path.endsWith("/api-key"))).toBe(false);
  });
  it("retains recovery credentials during an outage and stops after parent revocation", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.connect();
    f.advance(30 * 86400_000);
    f.setOutage(true);
    expect(await f.core.credential("local-user")).toBeNull();
    expect((await f.core.status("local-user")).connection).toBe("unavailable");
    f.advance(31_000);
    f.setOutage(false);
    expect((await f.core.credential("local-user"))?.state).toBe("connected");
    f.advance(30 * 86400_000);
    f.revokeParent();
    expect(await f.core.credential("local-user")).toBeNull();
    const count = f.requests.length;
    await f.core.reconcileCredentials();
    await f.core.credential("local-user");
    expect(f.requests).toHaveLength(count);
    expect((await f.core.status("local-user")).connection).toBe("revoked");
  });
  it("disconnects only one user and preserves its tombstone across restart", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.connect("user_admin");
    await f.connect("user_member", 1);
    await f.connect("user_member", 1, { disconnect: true, apiKey: undefined });
    expect(await f.core.credential("user_member")).toBeNull();
    expect((await f.core.credential("user_admin"))?.token).toBeTruthy();
    expect(f.requests.at(-1)?.path).toBe("/v1/connections/revoke");
    const restart = fixture("local-env", f.storage);
    await restart.core.initialize();
    expect(await restart.core.credential("user_member")).toBeNull();
    expect(restart.requests).toHaveLength(0);
  });
  it("keeps one user's failed disconnect from blocking another user's setup", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.connect("user_admin");
    f.setRevokeOutage(true);
    await f.connect("user_admin", 1, { disconnect: true, apiKey: undefined });
    expect((await f.core.status("user_admin")).revocationPending).toBe(1);
    await f.connect("user_member", 1);
    expect((await f.core.credential("user_member"))?.state).toBe("connected");
    await expect(f.connect("user_admin", 1)).rejects.toMatchObject({
      code: "revocation_cleanup_pending",
    });
    f.setRevokeOutage(false);
    f.advance(61_000);
    await f.core.reconcileRevocations();
    await f.connect("user_admin", 1);
    expect((await f.core.credential("user_member"))?.state).toBe("connected");
  });
  it("removes an instance durably and retries API revocation after an outage", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.connect();
    f.setOutage(true);
    await f.connect("local-user", 1, { mode: "team", apiKey: undefined, remove: true });
    expect((await f.core.status("local-user")).revocationPending).toBe(1);
    const restart = fixture("local-env", f.storage);
    await restart.core.initialize();
    restart.advance(61_000);
    await restart.core.reconcileRevocations();
    expect(restart.requests[0]?.path).toBe("/v1/connections/revoke");
    expect(restart.core.binding()).toBeNull();
    expect(await restart.core.credential("local-user")).toBeNull();
  });
  it("uses pull registration and durable acknowledgment with the derived credential", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.connect();
    await f.core.registerCallback("local-user", {
      transport: "pull",
      secret: "webhook-secret",
      client_receiver_id: "local-receiver",
    });
    expect(f.requests.at(-1)).toMatchObject({
      body: { transport: "pull", environment_id: "local-env" },
      token: "Bearer derived:local-env:local-user",
    });
    expect(f.requests.at(-1)?.body.destination).toBeUndefined();
    const first = await f.core.pullCallback("local-user", "receiver-one");
    expect(await f.core.pullCallback("local-user", "receiver-one")).toEqual(first);
    await f.core.ackCallback("local-user", "receiver-one", "evt-one");
    expect(f.requests.at(-1)?.body).toEqual({ event_id: "evt-one" });
    await expect(f.core.pullCallback("local-user", "../receiver")).rejects.toMatchObject({
      code: "invalid_callback_reference",
    });
  });
  it("hands off to the same Toolyard instance without any credential in the URL", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.connect();
    const handoff = await f.core.handoff("local-user");
    expect(handoff.url).toContain("https://toolyard.test/");
    expect(handoff.url).not.toContain("derived:");
    expect(f.requests.at(-1)).toMatchObject({
      path: "/v1/connections/handoff",
      body: {},
      token: "Bearer derived:local-env:local-user",
    });
  });
  it("refuses a copied environment identity without inheriting access", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.connect();
    const other = fixture("other-env", { value: f.storage.value });
    await other.core.initialize();
    expect(other.core.binding()).toBeNull();
    expect(await other.core.credential("local-user")).toBeNull();
  });
  it("keeps an in-flight renewal from overwriting a user disconnect", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.connect();
    f.advance(30 * 86400_000);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.setRenewalHook(async () => {
      entered.resolve();
      await release.promise;
    });
    const renewal = f.core.credential("local-user");
    await entered.promise;
    await f.connect("local-user", 1, { disconnect: true, apiKey: undefined });
    release.resolve();
    expect(await renewal).toBeNull();
    expect((await f.core.status("local-user")).connection).toBe("revoked");
  });
  it("changes only the owner's callback generation on deliberate reconnect", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.connect();
    const first = f.core.callbackBinding("local-user");
    await f.core.retire("local-user", (await f.core.credential("local-user"))!.token!);
    f.setGeneration(2);
    await f.connect("local-user", 1);
    expect(f.requests.findLast((r) => r.path === "/v1/connections/api-key")?.body.reconnect).toBe(
      true,
    );
    expect(f.core.callbackBinding("local-user")).toMatchObject({
      agentId: first?.agentId,
      connectionGeneration: 2,
      trustGeneration: first?.trustGeneration,
    });
    expect(first?.connectionGeneration).toBe(1);
    await expect(
      f.connect("local-user", 1, { mode: "team", apiKey: undefined }),
    ).rejects.toMatchObject({ code: "disconnect_before_mode_change" });
  });
});

/** T3-CUSTOM(expbkt3): Host possession, durable consent, ownership, and recovery. */
import * as Crypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { ToolyardConnectionCore } from "./ToolyardConnectionCore.ts";

function fixture(environmentId = "env-one", storage = { value: null as string | null }) {
  let now = Date.parse("2026-10-05T00:00:00Z");
  let decision = "pending";
  let outage = false;
  let invalidUrl = false;
  let beginOutage = false;
  let beginDecision = false;
  let failWrite = false;
  let active = true;
  const requests: { path: string; claims?: Record<string, unknown>; token?: string }[] = [];
  const ids = new Map<string, string>();
  const core = new ToolyardConnectionCore({
    environmentId,
    hostName: "Tushar Mac",
    platform: "darwin",
    read: async () => storage.value,
    write: async (value) => {
      if (failWrite) {
        failWrite = false;
        throw new Error("disk unavailable");
      }
      storage.value = value;
    },
    now: () => now,
    verifyUser: async (userId) => {
      if (!active || (userId !== "local-user" && !userId.startsWith("user_")))
        throw new Error("inactive user");
      return { email: null, admin: userId !== "user_member" };
    },
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      let claims: Record<string, unknown> | undefined;
      if (body.proof) {
        const [header, payload, signature] = body.proof.split(".");
        claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        const key = Crypto.createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(String(claims!.public_key), "base64"),
          ]),
          type: "spki",
          format: "der",
        });
        expect(
          Crypto.verify(
            null,
            Buffer.from(`${header}.${payload}`),
            key,
            Buffer.from(signature, "base64url"),
          ),
        ).toBe(true);
        expect(claims).toMatchObject({
          iss: environmentId,
          aud: "instance-one",
          action: path.split("/").at(-1),
          host_name: "Tushar Mac",
          platform: "darwin",
        });
        expect(Number(claims!.exp) - Number(claims!.iat)).toBeLessThanOrEqual(120);
        expect(storage.value).toContain(String(claims!.request_id)); // durable before dispatch
      }
      requests.push({
        path,
        ...(claims ? { claims } : {}),
        ...((init?.headers as Record<string, string>)?.authorization
          ? { token: (init!.headers as Record<string, string>).authorization }
          : {}),
      });
      if (outage || (beginOutage && path.endsWith("/begin"))) throw new Error("offline");
      const reply = (data: unknown) => new Response(JSON.stringify(data));
      const credential = (userId: string, version = 1) => ({
        token: `secret:${environmentId}:${userId}`,
        email: "owner@example.test",
        user_id: "toolyard-owner",
        agent_id: `agent:${environmentId}:${userId}`,
        expires_at: new Date(now + 30 * 86400_000).toISOString(),
        credential_version: version,
        instance_id: "instance-one",
        connection_generation: 1,
      });
      if (path.endsWith("toolyard-instance"))
        return reply({
          instance_id: "instance-one",
          capabilities: [
            "connections.host-consent.v1",
            "connections.api-key.v1",
            "callbacks.pull.v1",
            "inbox.batch.v1",
            "callbacks.standard-webhooks.v1",
            "dashboard.handoff.v1",
          ],
        });
      if (path.endsWith("/begin")) {
        ids.set(String(claims!.sub), String(claims!.request_id));
        return reply({
          status: beginDecision ? decision : "pending",
          request_id: claims!.request_id,
          authorization_url: `${invalidUrl ? "https://evil.test" : "https://toolyard.test"}/connections/host/authorize?code=opaque`,
          expires_at: new Date(now + 600_000).toISOString(),
        });
      }
      if (path.endsWith("/poll"))
        return reply({
          status: decision,
          request_id: claims!.request_id,
          ...(decision === "approved" ? credential(String(claims!.sub)) : {}),
        });
      if (path.endsWith("/renew"))
        return reply(
          credential(
            String((init!.headers as Record<string, string>).authorization)
              .split(":")
              .at(-1)!,
            body.expected_version + 1,
          ),
        );
      if (path.endsWith("/handoff"))
        return reply({
          url: "https://toolyard.test/connections/handoff?code=one-use",
          expires_at: new Date(now + 60000).toISOString(),
        });
      return reply({ cancelled: true });
    },
  });
  const configure = (extras = {}, userId = "local-user", expectedRevision = 0) =>
    core.configure(userId, {
      baseUrl: "https://toolyard.test",
      origin: "http://localhost:1000",
      enabled: true,
      expectedRevision,
      mode: "host",
      ...extras,
    });
  return {
    core,
    storage,
    requests,
    ids,
    configure,
    approve: () => {
      decision = "approved";
    },
    reject: () => {
      decision = "rejected";
    },
    outage: (value: boolean) => {
      outage = value;
    },
    beginDecision: () => {
      beginDecision = true;
    },
    beginOutage: (value: boolean) => {
      beginOutage = value;
    },
    invalidUrl: () => {
      invalidUrl = true;
    },
    failWrite: () => {
      failWrite = true;
    },
    inactive: () => {
      active = false;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("host consent connection", () => {
  it("requires browser consent and derives the profile and host from the server", async () => {
    const f = fixture();
    await f.core.initialize();
    const status = await f.configure();
    expect(status).toMatchObject({
      revision: 1,
      mode: "host",
      hostName: "Tushar Mac",
      callbackTransport: "pull",
      pendingConnection: { status: "pending" },
    });
    expect(await f.core.credential("local-user")).toBeNull();
    expect(
      f.requests.some(
        (request) => request.path.endsWith("/renew") || request.path.includes("federation/connect"),
      ),
    ).toBe(false);
    f.approve();
    await f.core.reconcileHostConnections();
    expect(await f.core.status("local-user")).toMatchObject({
      connection: "connected",
      ownerId: "toolyard-owner",
      agentId: "agent:env-one:local-user",
      pendingConnection: { status: "approved" },
    });
    expect(JSON.stringify(await f.core.status("local-user"))).not.toContain("secret:");
    expect(f.core.callbackBinding("local-user")).toMatchObject({
      transport: "pull",
      connectionGeneration: 1,
    });
  });
  it("recovers pending consent after restart and uses the same key and request", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    const restarted = fixture("env-one", f.storage);
    await restarted.core.initialize();
    restarted.approve();
    await restarted.core.reconcileHostConnections();
    expect(restarted.requests[0]!.claims!.request_id).toBe(f.ids.get("local-user"));
    expect(restarted.requests[0]!.claims!.public_key).toBe(
      f.requests.find((request) => request.claims)?.claims!.public_key,
    );
    expect((await restarted.core.credential("local-user"))?.agentId).toBe(
      "agent:env-one:local-user",
    );
  });
  it("recovers a lost approved credential response without new permission", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    f.approve();
    f.failWrite();
    await f.core.reconcileHostConnections();
    expect((await f.core.status("local-user", false)).pendingConnection?.status).toBe("pending");
    await f.core.reconcileHostConnections();
    expect((await f.core.credential("local-user"))?.token).toBe("secret:env-one:local-user");
    expect(f.requests.filter((request) => request.path.endsWith("/begin"))).toHaveLength(1);
  });
  it("retains the same durable request after a begin outage", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    f.outage(true);
    await f.configure({ hostAction: "poll" }, "local-user", 1);
    expect((await f.core.status("local-user", false)).pendingConnection?.lastError).toBe(
      "instance_unavailable",
    );
    f.outage(false);
    f.approve();
    await f.core.reconcileHostConnections();
    expect(
      f.requests
        .filter((request) => request.claims)
        .every((request) => request.claims!.request_id === f.ids.get("local-user")),
    ).toBe(true);
  });
  it("rejects cross-origin authorization URLs and keeps secrets out of the browser", async () => {
    const f = fixture();
    await f.core.initialize();
    f.invalidUrl();
    const status = await f.configure();
    expect(status.pendingConnection).toMatchObject({
      authorizationUrl: null,
      lastError: "invalid_host_authorization_destination",
    });
    expect(JSON.stringify(status)).not.toContain("evil.test");
    expect(JSON.stringify(status)).not.toContain("privateKey");
  });
  it("keeps rejected consent final until another explicit request", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    f.reject();
    await f.core.reconcileHostConnections();
    const count = f.requests.length;
    await f.core.reconcileHostConnections();
    expect(f.requests).toHaveLength(count);
    expect(await f.core.credential("local-user")).toBeNull();
    const prior = f.ids.get("local-user");
    await f.configure({}, "local-user", 1);
    expect(f.ids.get("local-user")).not.toBe(prior);
  });
  it("recovers an already approved decision after its pending deadline", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    f.approve();
    f.advance(700_000);
    await f.core.reconcileHostConnections();
    expect((await f.core.status("local-user")).connection).toBe("connected");
  });
  it("supports members only on the configured instance and isolates agents", async () => {
    const f = fixture();
    await f.core.initialize();
    await expect(f.configure({}, "user_member")).rejects.toMatchObject({
      code: "administrator_required",
    });
    await f.configure({}, "user_admin");
    await f.configure({}, "user_member", 1);
    f.approve();
    await f.core.reconcileHostConnections();
    expect((await f.core.credential("user_admin"))?.agentId).not.toBe(
      (await f.core.credential("user_member"))?.agentId,
    );
    await expect(
      f.configure({ baseUrl: "https://other.test" }, "user_member", 1),
    ).rejects.toMatchObject({ code: "administrator_required" });
    await expect(f.configure({}, "user_member", 0)).rejects.toMatchObject({
      code: "settings_revision_conflict",
    });
  });
  it("cancels durably before remote access and does not resurrect after restart", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    f.outage(true);
    await f.configure({ hostAction: "cancel" }, "local-user", 1);
    expect((await f.core.status("local-user", false)).pendingConnection?.status).toBe("cancelled");
    const restarted = fixture("env-one", f.storage);
    await restarted.core.initialize();
    restarted.advance(61000);
    await restarted.core.reconcileRevocations();
    expect(restarted.requests[0]?.path).toBe("/v1/connections/host/cancel");
    await restarted.core.reconcileHostConnections();
    expect(await restarted.core.credential("local-user")).toBeNull();
  });
  it("renews with CAS and revokes the dedicated host credential", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    f.approve();
    await f.core.reconcileHostConnections();
    f.advance(30 * 86400_000);
    await Promise.all([f.core.credential("local-user"), f.core.credential("local-user")]);
    expect(f.requests.filter((request) => request.path.endsWith("/renew"))).toHaveLength(1);
    await f.core.handoff("local-user");
    expect(f.requests.at(-1)?.path).toBe("/v1/connections/host/handoff");
    await f.configure({ disconnect: true }, "local-user", 1);
    expect(f.requests.at(-1)?.path).toBe("/v1/connections/host/revoke");
    expect(await f.core.credential("local-user")).toBeNull();
  });
  it("removes a pending instance without browser permission resurrection", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    await f.configure({ remove: true }, "local-user", 1);
    expect(f.core.binding()).toBeNull();
    expect((await f.core.status("local-user", false)).pendingConnection).toBeNull();
    expect(f.requests.at(-1)?.path).toBe("/v1/connections/host/cancel");
  });
  it("does not poll for inactive owners or inherit a copied environment", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    f.inactive();
    const count = f.requests.length;
    await f.core.reconcileHostConnections();
    expect(f.requests).toHaveLength(count);
    const other = fixture("env-two", { value: f.storage.value });
    await other.core.initialize();
    expect(other.core.binding()).toBeNull();
    await other.core.reconcileHostConnections();
    expect(other.requests).toHaveLength(0);
  });
  it("persists a request before a lost begin response and resumes it without a browser", async () => {
    const f = fixture();
    await f.core.initialize();
    f.beginOutage(true);
    await f.configure();
    const pending = (await f.core.status("local-user", false)).pendingConnection!;
    expect(pending.authorizationUrl).toBeNull();
    expect(pending.lastError).toBe("instance_unavailable");
    const restarted = fixture("env-one", f.storage);
    await restarted.core.initialize();
    await restarted.core.reconcileHostConnections();
    expect(restarted.requests[0]?.claims?.request_id).toBe(pending.requestId);
    expect(
      (await restarted.core.status("local-user", false)).pendingConnection?.authorizationUrl,
    ).toContain("https://toolyard.test/");
  });
  it("does not create duplicate agents from concurrent begin attempts", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    await Promise.all([f.configure({}, "local-user", 1), f.configure({}, "local-user", 1)]);
    expect(f.requests.filter((request) => request.path.endsWith("/begin"))).toHaveLength(1);
    f.approve();
    await f.configure({}, "local-user", 1);
    expect((await f.core.status("local-user")).connection).toBe("connected");
  });
  it("retains owner attribution after revocation and does not silently change mode after instance re-enable", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure({}, "user_admin");
    await f.configure({}, "user_member", 1);
    f.approve();
    await f.core.reconcileHostConnections();
    await f.configure({ enabled: false }, "user_admin", 1);
    expect(await f.core.status("user_member", false)).toMatchObject({
      mode: "host",
      connection: "disabled",
      ownerId: "toolyard-owner",
      agentId: "agent:env-one:user_member",
    });
    await f.configure({}, "user_admin", 2);
    expect(await f.core.status("user_member", false)).toMatchObject({
      mode: "host",
      connection: "disabled",
    });
    expect(await f.core.credential("user_member")).toBeNull();
  });
  it("recovers consent committed before the lost begin response is recovered", async () => {
    const f = fixture();
    await f.core.initialize();
    f.beginOutage(true);
    await f.configure();
    const pending = (await f.core.status("local-user", false)).pendingConnection!;
    const restarted = fixture("env-one", f.storage);
    await restarted.core.initialize();
    restarted.approve();
    restarted.beginDecision();
    await restarted.core.reconcileHostConnections();
    expect(restarted.requests.map((r) => r.path)).toEqual([
      "/v1/connections/host/begin",
      "/v1/connections/host/poll",
    ]);
    expect(restarted.requests.every((r) => r.claims?.request_id === pending.requestId)).toBe(true);
    expect((await restarted.core.status("local-user", false)).pendingConnection?.status).toBe(
      "approved",
    );
    expect((await restarted.core.credential("local-user"))?.ownerId).toBe("toolyard-owner");
  });
  it("requires cancellation before API setup can replace pending host consent", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    const count = f.requests.length;
    await expect(
      f.configure({ mode: "api-key", apiKey: "another-secret" }, "local-user", 1),
    ).rejects.toMatchObject({ code: "cancel_host_request_before_mode_change" });
    expect(f.requests).toHaveLength(count);
    f.approve();
    await f.core.reconcileHostConnections();
    expect((await f.core.status("local-user", false)).mode).toBe("host");
    expect((await f.core.credential("local-user"))?.ownerId).toBe("toolyard-owner");
  });
});

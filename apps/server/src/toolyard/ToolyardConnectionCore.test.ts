/** T3-CUSTOM(expbkt3): Trust, isolation, recovery and single-use browser handoff boundaries. */
import { describe, it, expect } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import { ToolyardConnectionCore, canonicalToolyardUrl } from "./ToolyardConnectionCore.ts";
import { toolyardManagedProfile } from "./ToolyardManagedProfile.ts";

function fixture(environmentId = "environment-one", storage = { value: null as string | null }) {
  let now = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-04T00:00:00Z"));
  let connects = 0;
  let revoke = false;
  let outage = false;
  let loseResponse = false;
  let handoffUrl = "https://toolyard.test/v1/handoff?code=single-use";
  const requests: {
    url: string;
    body: Record<string, unknown>;
    authorization?: string | undefined;
  }[] = [];
  const server = new Map<string, { token: string; version: number }>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    requests.push({
      url,
      body,
      authorization: (init?.headers as Record<string, string>)?.authorization,
    });
    if (outage) throw new Error("network failure");
    const respond = (data: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(data), { status }));
    if (url.endsWith("/.well-known/toolyard-instance"))
      return respond({
        instance_id: url.startsWith("https://second") ? "instance-two" : "instance-one",
        protocol: "toolyard-federation-v1",
      });
    if (url.endsWith("/register")) return respond({ registered: true });
    if (url.endsWith("/revoke")) return respond({ revoked: true });
    if (url.endsWith("/connect")) {
      connects++;
      if (revoke) return respond({ error: "connection_revoked" }, 403);
      const claims = JSON.parse(
        Buffer.from(String(body.assertion).split(".")[1]!, "base64url").toString(),
      );
      const key = `${claims.iss}:${claims.aud}:${claims.sub}`;
      const connection = server.get(key) ?? { token: `secret-${key}`, version: 1 };
      server.set(key, connection);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost after commit");
      }
      return respond({
        token: connection.token,
        email: `${claims.sub}@beknown.work`,
        agent_id: key,
        credential_version: connection.version,
        expires_at: DateTime.formatIso(DateTime.makeUnsafe(now + 3600_000)),
      });
    }
    if (url.endsWith("/handoff"))
      return respond({
        url: handoffUrl,
        expires_at: DateTime.formatIso(DateTime.makeUnsafe(now + 60_000)),
      });
    return respond({ callback_ref: "receiver-one", revision: 1 });
  };
  const core = new ToolyardConnectionCore({
    environmentId,
    read: async () => storage.value,
    write: async (value) => {
      storage.value = value;
    },
    now: () => now,
    fetch: fetcher,
    verifyUser: async (id) => {
      if (id === "user_blocked") throw new Error("blocked");
      return { email: `${id}@beknown.work`, admin: id === "user_admin" };
    },
  });
  const configure = (expectedRevision = 0, extras = {}) =>
    core.configure("user_admin", {
      expectedRevision,
      baseUrl: "https://toolyard.test",
      origin: "https://stage.test",
      enabled: true,
      adminToken: `x.${Buffer.from(JSON.stringify({ sub: "user_admin" })).toString("base64url")}.y`,
      ...extras,
    });
  return {
    core,
    configure,
    storage,
    requests,
    get connects() {
      return connects;
    },
    loseNextResponse: () => {
      loseResponse = true;
    },
    setHandoffUrl: (url: string) => {
      handoffUrl = url;
    },
    setRevoked: () => {
      revoke = true;
    },
    setOutage: (v: boolean) => {
      outage = v;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("server-owned Toolyard federation", () => {
  it("recovers a lost connect response without rotating the remote credential", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    f.loseNextResponse();
    expect(await f.core.credential("user_a")).toBeNull();
    const restart = fixture("environment-one", f.storage);
    await restart.core.initialize();
    restart.advance(31_000);
    const recovered = await restart.core.credential("user_a");
    expect(recovered?.version).toBe(1);
    expect(recovered?.token).toBe("secret-environment-one:instance-one:user_a");
  });
  it("queues remote revocation durably and never returns a credential for an old URL", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    await f.core.credential("user_a");
    expect(await f.core.credentialForUrl("user_a", "https://second.test/mcp")).toBeNull();
    f.setOutage(true);
    const removed = await f.configure(1, { remove: true });
    expect(removed.revocationPending).toBe(1);
    const restart = fixture("environment-one", f.storage);
    await restart.core.initialize();
    restart.advance(61_000);
    await restart.core.reconcileRevocations();
    expect((await restart.core.status("user_admin")).revocationPending).toBe(0);
    expect(restart.core.binding()).toBeNull();
  });
  it("keeps browser handoff scoped to its instance and contains no agent credential", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    const handoff = await f.core.handoff("user_a");
    expect(handoff.url).toContain("single-use");
    expect(JSON.stringify(handoff)).not.toContain("secret-");
    const request = f.requests.find((r) => r.url.endsWith("/handoff"))!;
    expect(request.body.return_url).toBe("https://stage.test");
    f.setHandoffUrl("https://other.test/steal");
    await expect(f.core.handoff("user_a")).rejects.toMatchObject({
      code: "invalid_handoff_destination",
    });
  });

  it("binds assertions to the verified user, instance and environment and signs with registered key", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    await f.core.credential("user_member");
    const registration = f.requests.find((r) => r.url.endsWith("/register"))!.body;
    const assertion = String(f.requests.find((r) => r.url.endsWith("/connect"))!.body.assertion);
    const [header, payload, signature] = assertion.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims).toMatchObject({
      iss: "environment-one",
      aud: "instance-one",
      sub: "user_member",
    });
    expect(claims.exp - claims.iat).toBe(90);
    const rawKey = Buffer.from(String(registration.public_key), "base64");
    const publicKey = NodeCrypto.createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]),
      format: "der",
      type: "spki",
    });
    expect(
      NodeCrypto.verify(
        null,
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    expect(JSON.stringify(await f.core.status("user_member"))).not.toContain("secret-");
  });
  it("isolates two users and two environments and survives restart", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    const [a, b] = await Promise.all([f.core.credential("user_a"), f.core.credential("user_b")]);
    expect(a!.token).not.toBe(b!.token);
    const restart = fixture("environment-one", f.storage);
    await restart.core.initialize();
    expect((await restart.core.credential("user_a"))!.token).toBe(a!.token);
    expect(restart.connects).toBe(0);
    const second = fixture("environment-two", { value: f.storage.value });
    await second.core.initialize();
    expect(second.core.binding()).toBeNull();
    await second.configure();
    expect((await second.core.credential("user_a"))!.token).not.toBe(a!.token);
  });
  it("serializes renewal and preserves revoked permission through restart", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    const calls = await Promise.all(Array.from({ length: 10 }, () => f.core.credential("user_a")));
    expect(f.connects).toBe(1);
    expect(new Set(calls.map((c) => c!.token)).size).toBe(1);
    expect(await f.core.retire("user_a", "wrong-token")).toBe(false);
    expect(await f.core.retire("user_a", calls[0]!.token!)).toBe(true);
    await f.core.credential("user_a");
    expect(f.connects).toBe(1);
    const restart = fixture("environment-one", f.storage);
    await restart.core.initialize();
    expect(await restart.core.credential("user_a")).toBeNull();
    expect(restart.connects).toBe(0);
  });
  it("keeps outages distinct from revocation and bounds retries", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    f.setOutage(true);
    expect(await f.core.credential("user_a")).toBeNull();
    const n = f.requests.length;
    await f.core.credential("user_a");
    expect(f.requests.length).toBe(n);
    f.advance(31_000);
    f.setOutage(false);
    expect((await f.core.credential("user_a"))!.state).toBe("connected");
    f.advance(3600_000);
    f.setRevoked();
    await f.core.credential("user_a");
    expect((await f.core.status("user_a")).connection).toBe("revoked");
  });
  it("keeps the local proxy discoverable from first outage through recovery and removes terminal access", async () => {
    const f = fixture();
    await f.core.initialize();
    expect(toolyardManagedProfile(await f.core.status("user_a"))).toBeNull();
    await f.configure();
    f.setOutage(true);
    const unavailable = toolyardManagedProfile(await f.core.status("user_a"));
    expect(unavailable).toMatchObject({
      enabled: true,
      credentialConfigured: true,
      url: "https://toolyard.test/mcp",
    });
    expect(await f.core.credentialForUrl("user_a", "https://toolyard.test/mcp")).toBeNull();
    f.advance(31_000);
    f.setOutage(false);
    expect((await f.core.credentialForUrl("user_a", "https://toolyard.test/mcp"))?.token).toContain(
      "user_a",
    );
    const recovered = toolyardManagedProfile(await f.core.status("user_a"));
    expect(recovered?.credentialConfigured).toBe(true);
    expect(recovered?.configurationKey).not.toBe(unavailable?.configurationKey);
    f.advance(3600_000);
    f.setRevoked();
    expect(toolyardManagedProfile(await f.core.status("user_a"))?.credentialConfigured).toBe(false);
    await f.configure(1, { enabled: false });
    expect(toolyardManagedProfile(await f.core.status("user_a"))?.credentialConfigured).toBe(false);
    await f.configure(2, { remove: true });
    expect(toolyardManagedProfile(await f.core.status("user_a"))).toBeNull();
  });
  it("requires admin trust, rejects stale saves and retains removal on remote failure", async () => {
    const f = fixture();
    await f.core.initialize();
    await expect(
      f.core.configure("user_member", {
        expectedRevision: 0,
        baseUrl: "https://toolyard.test",
        origin: "https://stage.test",
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "administrator_required" });
    await f.configure();
    await expect(f.configure()).rejects.toMatchObject({ code: "settings_revision_conflict" });
    f.setOutage(true);
    expect((await f.configure(1, { remove: true })).revocationPending).toBe(1);
    expect((await f.core.status("user_admin")).removed).toBe(true);
    const restart = fixture("environment-one", f.storage);
    await restart.core.initialize();
    expect(await restart.core.credential("user_a")).toBeNull();
  });
  it("never sends old credentials to a replacement instance and accepts only https origins", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    await f.core.credential("user_a");
    await f.configure(1, { baseUrl: "https://second.test" });
    await f.core.registerCallback("user_a", {
      destination: "https://stage.test/callback",
      secret: "webhook-secret",
      client_receiver_id: "receiver",
    });
    expect(f.requests.at(-1)!.authorization).toContain("instance-two");
    for (const value of [
      "http://bad.test",
      "https://u:p@bad.test",
      "https://bad.test/path",
      "https://bad.test/?x=1",
    ])
      expect(() => canonicalToolyardUrl(value)).toThrow();
    await expect(f.core.credential("anonymous")).rejects.toMatchObject({
      code: "verified_identity_required",
    });
  });
});

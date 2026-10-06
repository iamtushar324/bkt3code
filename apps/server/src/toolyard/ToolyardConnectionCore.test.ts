// @effect-diagnostics nodeBuiltinImport:off - fork code still hashes with node:crypto; moving it to Effect Crypto (#16377) is a follow-up.
/** T3-CUSTOM(expbkt3): Trust, isolation, recovery and single-use browser handoff boundaries. */
import { describe, it, expect } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import { ToolyardConnectionCore, canonicalToolyardUrl } from "./ToolyardConnectionCore.ts";
import { toolyardManagedProfile } from "./ToolyardManagedProfile.ts";

function fixture(environmentId = "environment-one", storage = { value: null as string | null }) {
  let now = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-04T00:00:00Z"));
  let connects = 0;
  let failNextWrite = false;
  let writeHook = async (_value: string) => {};
  let remoteTrustGeneration = 0;
  let capabilities: unknown = [
    "inbox.batch.v1",
    "callbacks.standard-webhooks.v1",
    "federation.ed25519.v1",
    "dashboard.handoff.v1",
  ];
  let registrationOverride: Record<string, unknown> = {};
  let inspectionStatus = 200;
  let inspectionOwner: string | undefined;
  let inspectionHook = async (_signal?: AbortSignal) => {};
  let inspection: Record<string, unknown> = {
    receiver: { callback_ref: "receiver-one" },
    deliveries: [],
  };
  let revoke = false;
  let outage = false;
  let loseResponse = false;
  let handoffUrl = "https://toolyard.test/v1/handoff?code=single-use";
  const requests: {
    url: string;
    body: Record<string, unknown>;
    authorization?: string | undefined;
    method: string | undefined;
  }[] = [];
  const server = new Map<string, { token: string; version: number }>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    requests.push({
      url,
      body,
      method: init?.method,
      authorization: (init?.headers as Record<string, string>)?.authorization,
    });
    if (outage) throw new Error("network failure");
    const respond = (data: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(data), { status }));
    if (url.endsWith("/.well-known/toolyard-instance"))
      return respond({
        instance_id: url.startsWith("https://second") ? "instance-two" : "instance-one",
        protocol: "toolyard-federation-v1",
        capabilities,
      });
    if (url.endsWith("/register"))
      return respond({
        registered: true,
        instance_id: url.startsWith("https://second") ? "instance-two" : "instance-one",
        protocol: "toolyard-federation-v1",
        ...registrationOverride,
      });
    if (url.includes("/callbacks/receivers/") && init?.method === "GET") {
      await inspectionHook(init?.signal ?? undefined);
      if (inspectionOwner && !requests.at(-1)?.authorization?.includes(inspectionOwner))
        return respond({ error: "receiver_not_owned" }, 403);
      return respond(inspection, inspectionStatus);
    }
    if (url.endsWith("/revoke")) {
      remoteTrustGeneration++;
      server.clear();
      return respond({ revoked: true });
    }
    if (url.endsWith("/connect")) {
      connects++;
      if (revoke) return respond({ error: "connection_revoked" }, 403);
      const claims = JSON.parse(
        Buffer.from(String(body.assertion).split(".")[1]!, "base64url").toString(),
      );
      const key = `${claims.iss}:${claims.aud}:${claims.sub}`;
      const connection = server.get(key) ?? {
        token: `secret-${key}${remoteTrustGeneration ? `:generation-${remoteTrustGeneration}` : ""}`,
        version: 1,
      };
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
    return respond({
      callback_ref: remoteTrustGeneration ? `receiver-${remoteTrustGeneration}` : "receiver-one",
      revision: 1,
    });
  };
  const core = new ToolyardConnectionCore({
    environmentId,
    read: async () => storage.value,
    write: async (value) => {
      await writeHook(value);
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("storage unavailable");
      }
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
    failNextWrite: () => {
      failNextWrite = true;
    },
    setWriteHook: (hook: (value: string) => Promise<void>) => {
      writeHook = hook;
    },
    storage,
    requests,
    setCapabilities: (value: unknown) => {
      capabilities = value;
    },
    setRegistration: (value: Record<string, unknown>) => {
      registrationOverride = value;
    },
    setInspectionOwner: (owner: string) => {
      inspectionOwner = owner;
    },
    setInspectionHook: (hook: (signal?: AbortSignal) => Promise<void>) => {
      inspectionHook = hook;
    },
    setInspection: (value: Record<string, unknown>, status = 200) => {
      inspection = value;
      inspectionStatus = status;
    },
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
  it("advances durable trust generations across disable/enable and same-instance remove/re-add, preserving no-op saves", async () => {
    const f = fixture();
    await f.core.initialize();
    expect((await f.core.status("user_admin")).trustGeneration).toBe(0);
    await f.configure();
    const first = f.core.binding()!;
    const firstCredential = await f.core.credential("user_a");
    const firstReceiver = await f.core.registerCallback("user_a", {
      destination: "https://stage.test/callback",
      secret: "test-secret",
      client_receiver_id: "first",
    });
    const firstProfile = toolyardManagedProfile(await f.core.status("user_a"));
    expect(first.trustGeneration).toBe(1);
    await f.configure(1);
    expect(f.core.binding()?.trustGeneration).toBe(first.trustGeneration);
    await f.configure(2, { enabled: false });
    expect(f.core.binding()).toBeNull();
    expect((await f.core.status("user_admin")).trustGeneration).toBe(2);
    await f.configure(3);
    expect(f.core.binding()?.trustGeneration).toBe(3);
    expect(toolyardManagedProfile(await f.core.status("user_a"))?.configurationKey).not.toBe(
      firstProfile?.configurationKey,
    );
    await f.configure(4, { remove: true });
    expect((await f.core.status("user_admin")).trustGeneration).toBe(4);
    await f.configure(5);
    expect((await f.core.credential("user_a"))?.token).not.toBe(firstCredential?.token);
    expect(
      (
        await f.core.registerCallback("user_a", {
          destination: "https://stage.test/callback",
          secret: "test-secret",
          client_receiver_id: "second",
        })
      ).callback_ref,
    ).not.toBe(firstReceiver.callback_ref);
    expect(f.core.binding()).toMatchObject({
      instanceId: first.instanceId,
      origin: first.origin,
      trustGeneration: 5,
    });
    const restart = fixture("environment-one", f.storage);
    await restart.core.initialize();
    expect(restart.core.binding()?.trustGeneration).toBe(5);
    await restart.configure(6);
    expect(restart.core.binding()?.trustGeneration).toBe(5);
    restart.setRegistration({ instance_id: "changed-registration" });
    await expect(restart.configure(7, { baseUrl: "https://second.test" })).rejects.toMatchObject({
      code: "registration_instance_identity_mismatch",
    });
    expect(restart.core.binding()?.trustGeneration).toBe(5);
    restart.setRegistration({});
    await restart.configure(7, { baseUrl: "https://second.test" });
    expect(restart.core.binding()?.trustGeneration).toBe(6);
  });
  it("defaults old persisted trust to zero and retains it across a restart and no-op save", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    const state = JSON.parse(f.storage.value!);
    delete state.trustGeneration;
    f.storage.value = JSON.stringify(state);
    const old = fixture("environment-one", f.storage);
    await old.core.initialize();
    expect(old.core.binding()?.trustGeneration).toBe(0);
    await old.configure(1);
    const restart = fixture("environment-one", f.storage);
    await restart.core.initialize();
    expect(restart.core.binding()?.trustGeneration).toBe(0);
    await restart.configure(2, { enabled: false });
    await restart.configure(3);
    expect(restart.core.binding()?.trustGeneration).toBe(2);
  });
  it("does not advance trust on a failed setup or failed durable transition", async () => {
    const f = fixture();
    await f.core.initialize();
    f.setRegistration({ protocol: "wrong" });
    await expect(f.configure()).rejects.toMatchObject({ code: "registration_protocol_mismatch" });
    expect((await f.core.status("user_admin")).trustGeneration).toBe(0);
    f.setRegistration({});
    await f.configure();
    const credential = await f.core.credential("user_a");
    const persisted = f.storage.value;
    const binding = f.core.binding();
    f.failNextWrite();
    await expect(f.configure(1, { remove: true })).rejects.toThrow("storage unavailable");
    expect(f.core.binding()).toEqual(binding);
    expect(f.storage.value).toBe(persisted);
    expect((await f.core.credential("user_a"))?.token).toBe(credential?.token);
    f.failNextWrite();
    await expect(f.configure(1, { enabled: false })).rejects.toThrow("storage unavailable");
    expect(f.core.binding()).toEqual(binding);
    expect(f.storage.value).toBe(persisted);
    const restart = fixture("environment-one", f.storage);
    await restart.core.initialize();
    expect(restart.core.binding()?.trustGeneration).toBe(1);
    expect((await restart.core.credential("user_a"))?.token).toBe(credential?.token);
  });
  it("keeps the committed trust visible while a gated durable transition fails", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    const credential = await f.core.credential("user_a");
    const binding = f.core.binding();
    const persisted = f.storage.value;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.setWriteHook(async () => {
      entered.resolve();
      await release.promise;
    });
    f.failNextWrite();
    const failed = expect(f.configure(1, { remove: true })).rejects.toThrow("storage unavailable");
    await entered.promise;
    expect(f.core.binding()).toEqual(binding);
    expect((await f.core.status("user_admin", false)).trustGeneration).toBe(
      binding?.trustGeneration,
    );
    expect((await f.core.credential("user_a"))?.token).toBe(credential?.token);
    expect(f.storage.value).toBe(persisted);
    release.resolve();
    await failed;
    expect(f.core.binding()).toEqual(binding);
    expect(f.storage.value).toBe(persisted);
    expect(f.requests.some((request) => request.url.endsWith("/revoke"))).toBe(false);
  });

  it.each([
    "inbox.batch.v1",
    "callbacks.standard-webhooks.v1",
    "federation.ed25519.v1",
    "dashboard.handoff.v1",
  ])(
    "refuses an instance missing %s without registering trust or persisting a connection",
    async (missing) => {
      const f = fixture();
      await f.core.initialize();
      const previous = f.storage.value;
      f.setCapabilities(
        [
          "inbox.batch.v1",
          "callbacks.standard-webhooks.v1",
          "federation.ed25519.v1",
          "dashboard.handoff.v1",
        ].filter((value) => value !== missing),
      );
      await expect(f.configure()).rejects.toMatchObject({
        code: `required_instance_capabilities_missing:${missing}`,
      });
      expect(f.storage.value).toBe(previous);
      expect(f.requests.some((request) => request.url.endsWith("/register"))).toBe(false);
      expect(await f.core.credential("user_a")).toBeNull();
      expect(f.core.binding()).toBeNull();
    },
  );
  it.each([
    [{ instance_id: "unexpected-instance" }, "registration_instance_identity_mismatch"],
    [{ protocol: "unexpected-protocol" }, "registration_protocol_mismatch"],
  ] as const)(
    "rejects changed registration metadata %j without changing the local trust binding",
    async (override, code) => {
      const f = fixture();
      await f.core.initialize();
      const initial = f.storage.value;
      f.setRegistration(override);
      await expect(f.configure()).rejects.toMatchObject({ code });
      expect(f.storage.value).toBe(initial);
      expect(f.core.binding()).toBeNull();
      expect(await f.core.credential("user_a")).toBeNull();
      f.setRegistration({});
      await f.configure();
      const original = await f.core.credential("user_a");
      const persisted = f.storage.value;
      f.setRegistration(override);
      await expect(f.configure(1, { baseUrl: "https://second.test" })).rejects.toMatchObject({
        code,
      });
      expect(f.storage.value).toBe(persisted);
      expect((await f.core.credential("user_a"))?.token).toBe(original?.token);
      const restart = fixture("environment-one", f.storage);
      await restart.core.initialize();
      expect(restart.core.binding()?.instanceId).toBe("instance-one");
    },
  );
  it("inspects only the authenticated user's receiver and supports safe read retries", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    f.setInspection({ deliveries: [{ event_id: "decision-one", history: [] }] });
    expect(await f.core.inspectCallback("user_a", "receiver-one")).toMatchObject({
      deliveries: [{ event_id: "decision-one" }],
    });
    const first = f.requests.at(-1)!;
    expect(first.method).toBe("GET");
    expect(first.authorization).toContain("user_a");
    f.setOutage(true);
    await expect(f.core.inspectCallback("user_a", "receiver-one")).rejects.toMatchObject({
      code: "instance_unavailable",
    });
    f.setOutage(false);
    await f.core.inspectCallback("user_a", "receiver-one");
    expect(f.requests.at(-1)?.authorization).toBe(first.authorization);
    f.setInspectionOwner("user_a");
    await expect(f.core.inspectCallback("user_b", "receiver-one")).rejects.toMatchObject({
      status: 403,
    });
    expect(f.requests.at(-1)?.authorization).toContain("user_b");
    await expect(f.core.inspectCallback("user_a", "../receiver")).rejects.toMatchObject({
      code: "invalid_callback_reference",
    });
    f.setInspection({ error: "connection_revoked" }, 401);
    await expect(f.core.inspectCallback("user_a", "receiver-one")).rejects.toMatchObject({
      status: 401,
    });
    const attempts = f.connects;
    await expect(f.core.inspectCallback("user_a", "receiver-one")).rejects.toMatchObject({
      code: "connection_unavailable",
    });
    expect(f.connects).toBe(attempts);
  });
  it("bounds inspection responses and never sends a prior-instance credential to a replacement", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    const old = await f.core.credential("user_a");
    f.setInspection({ large: "x".repeat(1048577) });
    await expect(f.core.inspectCallback("user_a", "receiver-one")).rejects.toMatchObject({
      code: "response_size_limit_exceeded",
    });
    f.setInspection({ deliveries: [] });
    f.setInspectionHook(async () => {
      await f.configure(1, { baseUrl: "https://second.test" });
    });
    await expect(f.core.inspectCallback("user_a", "receiver-one")).rejects.toMatchObject({
      code: "instance_changed",
    });
    f.setInspectionHook(async () => {});
    await f.core.inspectCallback("user_a", "receiver-one");
    expect(f.requests.at(-1)?.url).toBe("https://second.test/v1/callbacks/receivers/receiver-one");
    expect(f.requests.at(-1)?.authorization).not.toContain(old?.token);
    expect(f.requests.at(-1)?.authorization).toContain("instance-two");
  });
  it("cancels the physical history fetch when its caller interrupts", async () => {
    const f = fixture();
    await f.core.initialize();
    await f.configure();
    await f.core.credential("user_a");
    const controller = new AbortController();
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let transportCancelled = false;
    f.setInspectionHook(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => {
              transportCancelled = true;
              reject(signal!.reason);
            },
            { once: true },
          );
          markEntered();
        }),
    );
    const result = expect(
      f.core.inspectCallback("user_a", "receiver-one", controller.signal),
    ).rejects.toMatchObject({ code: "instance_unavailable" });
    await entered;
    controller.abort();
    await result;
    expect(transportCancelled).toBe(true);
  });
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

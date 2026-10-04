/** T3-CUSTOM(expbkt3): Environment/instance/user-isolated, server-owned federation. */
import * as NodeCrypto from "node:crypto";

const REQUIRED_INSTANCE_CAPABILITIES = [
  "inbox.batch.v1",
  "callbacks.standard-webhooks.v1",
  "federation.ed25519.v1",
  "dashboard.handoff.v1",
] as const;
export type ConnectionState = "connected" | "unavailable" | "revoked" | "disabled";
export interface ToolyardInstanceSettings {
  revision: number;
  enabled: boolean;
  removed: boolean;
  baseUrl: string | null;
  instanceId: string | null;
  origin: string | null;
}
interface Connection {
  token?: string;
  email?: string;
  agentId?: string;
  expiresAt?: string;
  version: number;
  state: ConnectionState;
  retryAfter?: number;
}
interface Persisted {
  environmentId: string;
  privateKey: string;
  kid: string;
  settings: ToolyardInstanceSettings;
  connections: Record<string, Connection>;
  pendingRevocations: {
    settings: ToolyardInstanceSettings;
    userId: string;
    attempts: number;
    retryAfter: number;
    lastError: string | null;
  }[];
}
export class ToolyardIntegrationFailure extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export interface CoreOptions {
  environmentId: string;
  read: () => Promise<string | null>;
  write: (value: string) => Promise<void>;
  verifyUser: (userId: string) => Promise<{ email: string | null; admin: boolean }>;
  fetch?: typeof fetch;
  now?: () => number;
}
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
export function canonicalToolyardUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ToolyardIntegrationFailure("invalid_instance_url");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new ToolyardIntegrationFailure("instance_url_must_be_https_origin");
  }
  return url.origin;
}
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ToolyardIntegrationFailure("invalid_response", 502);
  return value as Record<string, unknown>;
};
const string = (body: Record<string, unknown>, name: string) => {
  const value = body[name];
  if (typeof value !== "string" || !value)
    throw new ToolyardIntegrationFailure("invalid_response", 502);
  return value;
};

/** One server process owns state. Remote credential_version CAS protects renewal races. */
export class ToolyardConnectionCore {
  private state!: Persisted;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly userQueues = new Map<string, Promise<unknown>>();
  private readonly options: CoreOptions;
  constructor(options: CoreOptions) {
    this.options = options;
  }
  private get now() {
    return (this.options.now ?? Date.now)();
  }
  private async serialized<A>(action: () => Promise<A>): Promise<A> {
    const next = this.queue.then(action, action);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private userSerialized<A>(key: string, action: () => Promise<A>): Promise<A> {
    const next = (this.userQueues.get(key) ?? Promise.resolve()).then(action, action);
    this.userQueues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
  async initialize() {
    const raw = await this.options.read();
    if (raw !== null) {
      const existing = JSON.parse(raw) as Persisted;
      if (existing.environmentId === this.options.environmentId) {
        NodeCrypto.createPrivateKey(existing.privateKey);
        this.state = { ...existing, pendingRevocations: existing.pendingRevocations ?? [] };
        return;
      }
      // A database/secrets copy must not copy another environment's trust.
    }
    const pair = NodeCrypto.generateKeyPairSync("ed25519");
    this.state = {
      environmentId: this.options.environmentId,
      privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      kid: NodeCrypto.randomUUID(),
      settings: {
        revision: 0,
        enabled: false,
        removed: false,
        baseUrl: null,
        instanceId: null,
        origin: null,
      },
      connections: {},
      pendingRevocations: [],
    };
    await this.persist();
  }
  private async persist() {
    await this.options.write(JSON.stringify(this.state));
  }
  baseUrl() {
    return this.state.settings.baseUrl;
  }
  binding() {
    const settings = this.state.settings;
    return settings.enabled && !settings.removed && settings.instanceId && settings.origin
      ? {
          instanceId: settings.instanceId,
          environmentId: this.options.environmentId,
          origin: settings.origin,
          enabled: true as const,
        }
      : null;
  }
  private key(userId: string, instanceId = this.state.settings.instanceId) {
    return digest(`${this.options.environmentId}\0${instanceId}\0${userId}`);
  }
  private async assertion(userId: string, settings = this.state.settings) {
    const user = await this.options.verifyUser(userId);
    if (!userId.startsWith("user_"))
      throw new ToolyardIntegrationFailure("verified_identity_required", 403);
    const now = Math.floor(this.now / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: this.state.kid }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: this.options.environmentId,
        aud: settings.instanceId,
        sub: userId,
        jti: NodeCrypto.randomUUID(),
        iat: now,
        exp: now + 90,
        email: user.email,
      }),
    ).toString("base64url");
    const input = `${header}.${payload}`;
    return `${input}.${NodeCrypto.sign(null, Buffer.from(input), this.state.privateKey).toString("base64url")}`;
  }
  private async request(
    baseUrl: string,
    path: string,
    body?: Record<string, unknown>,
    token?: string,
    maximumResponseBytes = 65536,
    signal?: AbortSignal,
  ) {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${baseUrl}${path}`, {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ToolyardIntegrationFailure("instance_unavailable", 503);
    }
    // Bound the response before decoding it, including callback histories with many attempts.
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > maximumResponseBytes) {
            await reader.cancel();
            throw new ToolyardIntegrationFailure("response_size_limit_exceeded", 502);
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    let data: Record<string, unknown>;
    try {
      data = object(JSON.parse(text));
    } catch {
      throw new ToolyardIntegrationFailure("invalid_response", 502);
    }
    if (!response.ok) {
      const code =
        typeof data.error === "string" && /^[a-z_]{1,80}$/.test(data.error)
          ? data.error
          : "instance_refused";
      throw new ToolyardIntegrationFailure(code, response.status);
    }
    return data;
  }
  async configure(
    userId: string,
    input: {
      expectedRevision: number;
      baseUrl: string;
      origin: string;
      enabled: boolean;
      adminToken?: string | undefined;
      remove?: boolean | undefined;
    },
  ) {
    const user = await this.options.verifyUser(userId);
    if (!user.admin) throw new ToolyardIntegrationFailure("administrator_required", 403);
    return this.serialized(async () => {
      const old = this.state.settings;
      if (input.expectedRevision !== old.revision)
        throw new ToolyardIntegrationFailure("settings_revision_conflict", 409);
      if (input.remove) {
        // Persist the tombstone before a remote revoke; an outage cannot restore access.
        this.state.settings = { ...old, enabled: false, removed: true, revision: old.revision + 1 };
        this.state.connections = {};
        this.enqueueRevocation(old, userId);
        await this.persist();
        await this.flushRevocationsUnlocked();
        return this.status(userId, false);
      }
      const baseUrl = canonicalToolyardUrl(input.baseUrl);
      const origin = canonicalToolyardUrl(input.origin);
      const metadata = await this.request(baseUrl, "/.well-known/toolyard-instance");
      if (metadata.protocol !== "toolyard-federation-v1")
        throw new ToolyardIntegrationFailure("unsupported_instance_protocol");
      const advertised = Array.isArray(metadata.capabilities) ? metadata.capabilities : [];
      const missing = REQUIRED_INSTANCE_CAPABILITIES.filter(
        (capability) => !advertised.includes(capability),
      );
      if (missing.length > 0)
        throw new ToolyardIntegrationFailure(
          `required_instance_capabilities_missing:${missing.join(",")}`,
        );
      const instanceId = string(metadata, "instance_id");
      if (
        input.enabled &&
        this.state.pendingRevocations.some((job) => job.settings.instanceId === instanceId)
      ) {
        await this.flushRevocationsUnlocked();
        if (this.state.pendingRevocations.some((job) => job.settings.instanceId === instanceId))
          throw new ToolyardIntegrationFailure("revocation_cleanup_pending", 409);
      }
      if (
        !old.removed &&
        old.instanceId === instanceId &&
        (old.baseUrl !== baseUrl || old.origin !== origin)
      )
        throw new ToolyardIntegrationFailure("instance_binding_change_requires_removal", 409);
      const changed =
        baseUrl !== old.baseUrl ||
        instanceId !== old.instanceId ||
        origin !== old.origin ||
        old.removed;
      if (changed || (input.enabled && !old.enabled)) {
        if (!input.adminToken)
          throw new ToolyardIntegrationFailure("admin_trust_registration_required", 403);
        try {
          const claims = JSON.parse(
            Buffer.from(input.adminToken.split(".")[1] ?? "", "base64url").toString(),
          );
          if (claims.sub !== userId) throw new Error("identity mismatch");
        } catch {
          throw new ToolyardIntegrationFailure("admin_token_identity_mismatch", 403);
        }
        const publicDer = NodeCrypto.createPublicKey(this.state.privateKey).export({
          type: "spki",
          format: "der",
        });
        const registration = await this.request(baseUrl, "/v1/federation/register", {
          issuer: this.options.environmentId,
          kid: this.state.kid,
          public_key: publicDer.subarray(-32).toString("base64"),
          origin,
          token: input.adminToken,
        });
        if (registration.instance_id !== instanceId)
          throw new ToolyardIntegrationFailure("registration_instance_identity_mismatch", 409);
        if (registration.protocol !== metadata.protocol)
          throw new ToolyardIntegrationFailure("registration_protocol_mismatch", 409);
      }
      // Never transmit old credentials to a replacement URL or trust binding.
      if (changed || !input.enabled) this.state.connections = {};
      this.state.settings = {
        revision: old.revision + 1,
        enabled: input.enabled,
        removed: false,
        baseUrl,
        instanceId,
        origin,
      };
      if (old.enabled && (changed || !input.enabled)) this.enqueueRevocation(old, userId);
      await this.persist();
      await this.flushRevocationsUnlocked();
      return this.status(userId, false);
    });
  }
  private enqueueRevocation(settings: ToolyardInstanceSettings, userId: string) {
    if (!settings.baseUrl || !settings.instanceId) return;
    if (
      this.state.pendingRevocations.some(
        (job) =>
          job.settings.instanceId === settings.instanceId &&
          job.settings.baseUrl === settings.baseUrl,
      )
    )
      return;
    this.state.pendingRevocations.push({
      settings: { ...settings },
      userId,
      attempts: 0,
      retryAfter: 0,
      lastError: null,
    });
  }
  private async flushRevocationsUnlocked() {
    for (const job of this.state.pendingRevocations) {
      if (job.retryAfter > this.now) continue;
      try {
        await this.request(job.settings.baseUrl!, "/v1/federation/revoke", {
          assertion: await this.assertion(job.userId, job.settings),
          scope: "environment",
        });
        this.state.pendingRevocations = this.state.pendingRevocations.filter(
          (entry) => entry !== job,
        );
      } catch (cause) {
        job.attempts++;
        job.lastError =
          cause instanceof ToolyardIntegrationFailure ? cause.code : "revocation_failed";
        job.retryAfter = this.now + Math.min(3600_000, 30_000 * 2 ** Math.min(job.attempts, 7));
      }
      await this.persist();
    }
  }
  reconcileRevocations() {
    return this.serialized(() => this.flushRevocationsUnlocked());
  }
  async credential(userId: string): Promise<Connection | null> {
    if (!userId.startsWith("user_"))
      throw new ToolyardIntegrationFailure("verified_identity_required", 403);
    await this.options.verifyUser(userId);
    const settings = { ...this.state.settings };
    if (!settings.enabled || settings.removed || !settings.baseUrl || !settings.instanceId)
      return null;
    const key = this.key(userId, settings.instanceId);
    return this.userSerialized(key, async () => {
      const prior = this.state.connections[key];
      if (prior?.state === "revoked" || prior?.state === "disabled") return null;
      if (
        prior?.token &&
        prior.state === "connected" &&
        prior.expiresAt &&
        Date.parse(prior.expiresAt) > this.now + 30_000
      )
        return prior;
      if (prior?.retryAfter && prior.retryAfter > this.now) return null;
      try {
        const response = await this.request(settings.baseUrl!, "/v1/federation/connect", {
          assertion: await this.assertion(userId, settings),
          expected_version: prior?.version ?? 0,
        });
        const next: Connection = {
          token: string(response, "token"),
          email: string(response, "email"),
          agentId: string(response, "agent_id"),
          expiresAt: string(response, "expires_at"),
          version: Number(response.credential_version),
          state: "connected",
        };
        if (
          !Number.isSafeInteger(next.version) ||
          next.version < 1 ||
          !Number.isFinite(Date.parse(next.expiresAt!))
        )
          throw new ToolyardIntegrationFailure("invalid_response", 502);
        await this.serialized(async () => {
          if (this.state.settings.revision !== settings.revision)
            throw new ToolyardIntegrationFailure("instance_changed", 409);
          this.state.connections[key] = next;
          await this.persist();
        });
        return next;
      } catch (error) {
        const failure =
          error instanceof ToolyardIntegrationFailure
            ? error
            : new ToolyardIntegrationFailure("instance_unavailable", 503);
        // Explicit revocation/disabled states are terminal. Outages have bounded retries.
        const state: ConnectionState =
          failure.status === 401 ||
          /revoked|environment_removed|issuer_not_registered/.test(failure.code)
            ? "revoked"
            : /disabled|not_org_member|user_blocked/.test(failure.code)
              ? "disabled"
              : "unavailable";
        await this.serialized(async () => {
          if (this.state.settings.revision !== settings.revision) return;
          this.state.connections[key] = {
            version: prior?.version ?? 0,
            state,
            retryAfter: this.now + 30_000,
          };
          await this.persist();
        });
        return null;
      }
    });
  }
  async credentialForUrl(userId: string, url: string) {
    const settings = { ...this.state.settings };
    if (`${settings.baseUrl}/mcp` !== url) return null;
    const connection = await this.credential(userId);
    return settings.revision === this.state.settings.revision ? connection : null;
  }
  async retire(userId: string, token: string) {
    return this.serialized(async () => {
      const key = this.key(userId);
      const prior = this.state.connections[key];
      if (!prior?.token || digest(prior.token) !== digest(token)) return false;
      this.state.connections[key] = { version: prior.version, state: "revoked" };
      await this.persist();
      return true;
    });
  }
  async status(userId: string, connect = true) {
    const user = await this.options.verifyUser(userId);
    if (connect) await this.credential(userId);
    const connection = this.state.connections[this.key(userId)];
    return {
      ...this.state.settings,
      revocationPending: this.state.pendingRevocations.length,
      administrator: user.admin,
      connection: connection?.state ?? ("not_connected" as const),
      email: connection?.email ?? null,
      expiresAt: connection?.expiresAt ?? null,
    };
  }
  async handoff(userId: string) {
    if (!(await this.credential(userId)))
      throw new ToolyardIntegrationFailure("connection_unavailable", 403);
    const settings = { ...this.state.settings };
    const response = await this.request(settings.baseUrl!, "/v1/federation/handoff", {
      assertion: await this.assertion(userId),
      return_url: settings.origin,
    });
    const url = new URL(string(response, "url"));
    if (url.origin !== settings.baseUrl || url.username || url.password)
      throw new ToolyardIntegrationFailure("invalid_handoff_destination", 502);
    return { url: url.href, expiresAt: string(response, "expires_at") };
  }
  async registerCallback(
    userId: string,
    input: { destination: string; secret: string; client_receiver_id: string },
  ) {
    const settings = { ...this.state.settings };
    const connection = await this.credential(userId);
    if (!connection?.token) throw new ToolyardIntegrationFailure("connection_unavailable", 403);
    if (settings.revision !== this.state.settings.revision)
      throw new ToolyardIntegrationFailure("instance_changed", 409);
    return this.request(
      settings.baseUrl!,
      "/v1/callbacks/receivers",
      { ...input, environment_id: this.options.environmentId },
      connection.token,
    );
  }
  async inspectCallback(userId: string, ref: string, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(ref))
      throw new ToolyardIntegrationFailure("invalid_callback_reference");
    const settings = { ...this.state.settings };
    const connection = await this.credential(userId);
    if (!connection?.token) throw new ToolyardIntegrationFailure("connection_unavailable", 403);
    if (settings.revision !== this.state.settings.revision)
      throw new ToolyardIntegrationFailure("instance_changed", 409);
    try {
      const result = await this.request(
        settings.baseUrl!,
        `/v1/callbacks/receivers/${ref}`,
        undefined,
        connection.token,
        1048576,
        signal,
      );
      if (settings.revision !== this.state.settings.revision)
        throw new ToolyardIntegrationFailure("instance_changed", 409);
      return result;
    } catch (error) {
      // A rejected credential requires a new owner/admin decision, never automatic reprovisioning.
      if (error instanceof ToolyardIntegrationFailure && error.status === 401)
        await this.retire(userId, connection.token);
      throw error;
    }
  }
  async updateCallback(
    userId: string,
    ref: string,
    input: { action: "disable" | "rotate" | "remove"; secret?: string; expected_revision: number },
  ) {
    const settings = { ...this.state.settings };
    const connection = await this.credential(userId);
    if (!connection?.token) throw new ToolyardIntegrationFailure("connection_unavailable", 403);
    if (settings.revision !== this.state.settings.revision)
      throw new ToolyardIntegrationFailure("instance_changed", 409);
    if (!/^[A-Za-z0-9_-]+$/.test(ref))
      throw new ToolyardIntegrationFailure("invalid_callback_reference");
    const response = await (this.options.fetch ?? fetch)(
      `${settings.baseUrl}/v1/callbacks/receivers/${ref}`,
      {
        method: "PATCH",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${connection.token}`,
        },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok)
      throw new ToolyardIntegrationFailure("callback_update_failed", response.status);
    return object(await response.json());
  }
}

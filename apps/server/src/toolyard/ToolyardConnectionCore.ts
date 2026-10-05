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
export type ToolyardConnectionMode = "team" | "api-key";
interface Connection {
  mode?: ToolyardConnectionMode | undefined;
  userId?: string;
  connectionGeneration?: number;
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
  trustGeneration: number;
  privateKey: string;
  kid: string;
  settings: ToolyardInstanceSettings;
  connections: Record<string, Connection>;
  pendingRevocations: {
    settings: ToolyardInstanceSettings;
    token?: string;
    scope?: "user" | "environment";
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
        const trustGeneration =
          existing.trustGeneration === undefined ? 0 : existing.trustGeneration;
        if (!Number.isSafeInteger(trustGeneration) || trustGeneration < 0)
          throw new ToolyardIntegrationFailure("invalid_persisted_trust_generation", 500);
        this.state = {
          ...existing,
          trustGeneration,
          pendingRevocations: existing.pendingRevocations ?? [],
        };
        return;
      }
      // A database/secrets copy must not copy another environment's trust.
    }
    const pair = NodeCrypto.generateKeyPairSync("ed25519");
    this.state = {
      environmentId: this.options.environmentId,
      trustGeneration: 0,
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
  async assertConnectionOwner(userId: string) {
    await this.options.verifyUser(userId);
  }
  connectionMode(userId: string): ToolyardConnectionMode {
    return (
      this.state.connections[this.key(userId)]?.mode ??
      (userId === "local-user" ? "api-key" : "team")
    );
  }
  callbackBinding(userId: string) {
    const binding = this.binding();
    const connection = this.state.connections[this.key(userId)];
    if (!binding || connection?.state === "revoked" || connection?.state === "disabled")
      return null;
    const transport =
      this.connectionMode(userId) === "api-key" ? ("pull" as const) : ("push" as const);
    return {
      ...binding,
      origin: this.baseUrl()!,
      callbackOrigin: binding.origin,
      transport,
      ...(transport === "pull"
        ? {
            agentId: connection?.agentId ?? null,
            connectionGeneration: connection?.connectionGeneration ?? 0,
          }
        : {}),
    };
  }
  private advanceTrustGeneration(state: Persisted) {
    if (state.trustGeneration >= Number.MAX_SAFE_INTEGER)
      throw new ToolyardIntegrationFailure("trust_generation_exhausted", 409);
    state.trustGeneration++;
  }
  private async persistSettingsChange(change: (candidate: Persisted) => void) {
    const candidate = { ...this.state, pendingRevocations: [...this.state.pendingRevocations] };
    change(candidate);
    // Readers must not observe tentative trust while durable storage can still fail.
    await this.options.write(JSON.stringify(candidate));
    this.state = candidate;
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
          trustGeneration: this.state.trustGeneration,
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
      mode?: ToolyardConnectionMode | undefined;
      apiKey?: string | undefined;
      disconnect?: boolean | undefined;
    },
  ) {
    const user = await this.options.verifyUser(userId);
    if (input.disconnect) return this.disconnect(userId, input.expectedRevision);
    if (input.mode === "team" && !input.remove && input.enabled) {
      const prior = this.state.connections[this.key(userId)];
      if (prior?.mode === "api-key")
        throw new ToolyardIntegrationFailure(
          prior.state === "revoked" || prior.state === "disabled"
            ? "team_connection_reauthorization_required"
            : "disconnect_before_mode_change",
          409,
        );
      if (!userId.startsWith("user_"))
        throw new ToolyardIntegrationFailure("team_identity_required", 403);
    }
    if (!input.remove && input.enabled && (input.mode === "api-key" || input.apiKey !== undefined))
      return this.configureApiKey(userId, input, user.admin);
    if (!user.admin) throw new ToolyardIntegrationFailure("administrator_required", 403);
    return this.serialized(async () => {
      const old = this.state.settings;
      if (input.expectedRevision !== old.revision)
        throw new ToolyardIntegrationFailure("settings_revision_conflict", 409);
      if (input.remove) {
        // Persist the tombstone before a remote revoke; an outage cannot restore access.
        await this.persistSettingsChange((candidate) => {
          if (!old.removed) this.advanceTrustGeneration(candidate);
          candidate.settings = {
            ...old,
            enabled: false,
            removed: true,
            revision: old.revision + 1,
          };
          candidate.connections = {};
          this.enqueueRevocation(old, userId, candidate);
        });
        await this.flushRevocationsUnlocked();
        return this.status(userId, false);
      }
      if (!input.enabled && old.baseUrl) {
        await this.persistSettingsChange((candidate) => {
          if (old.enabled) this.advanceTrustGeneration(candidate);
          candidate.settings = { ...old, enabled: false, revision: old.revision + 1 };
          candidate.connections = {};
          if (old.enabled) this.enqueueRevocation(old, userId, candidate);
        });
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
      // The generation changes only with a committed trust lifecycle transition.
      await this.persistSettingsChange((candidate) => {
        if (changed || old.enabled !== input.enabled) this.advanceTrustGeneration(candidate);
        // Never transmit old credentials to a replacement URL or trust binding.
        if (changed || !input.enabled) candidate.connections = {};
        candidate.settings = {
          revision: old.revision + 1,
          enabled: input.enabled,
          removed: false,
          baseUrl,
          instanceId,
          origin,
        };
        if (old.enabled && (changed || !input.enabled))
          this.enqueueRevocation(old, userId, candidate);
      });
      await this.flushRevocationsUnlocked();
      return this.status(userId, false);
    });
  }
  private decodeConnection(
    response: Record<string, unknown>,
    userId: string,
    mode: ToolyardConnectionMode,
  ): Connection {
    const next: Connection = {
      token: string(response, "token"),
      email: string(response, "email"),
      agentId: string(response, "agent_id"),
      expiresAt: string(response, "expires_at"),
      version: Number(response.credential_version),
      state: "connected",
      userId,
      mode,
      ...(mode === "api-key"
        ? { connectionGeneration: Number(response.connection_generation) }
        : {}),
    };
    if (
      !Number.isSafeInteger(next.version) ||
      next.version < 1 ||
      (mode === "api-key" &&
        (!Number.isSafeInteger(next.connectionGeneration) || next.connectionGeneration! < 1)) ||
      !Number.isFinite(Date.parse(next.expiresAt!))
    )
      throw new ToolyardIntegrationFailure("invalid_response", 502);
    return next;
  }
  private async configureApiKey(
    userId: string,
    input: Parameters<ToolyardConnectionCore["configure"]>[1],
    administrator: boolean,
  ) {
    return this.serialized(async () => {
      const old = this.state.settings;
      if (input.expectedRevision !== old.revision)
        throw new ToolyardIntegrationFailure("settings_revision_conflict", 409);
      if (input.remove) throw new ToolyardIntegrationFailure("administrator_required", 403);
      const baseUrl = canonicalToolyardUrl(input.baseUrl);
      const changesInstance = !old.baseUrl || old.removed || old.baseUrl !== baseUrl;
      if (changesInstance && !administrator)
        throw new ToolyardIntegrationFailure("administrator_required", 403);
      if (!changesInstance && !old.enabled && !administrator)
        throw new ToolyardIntegrationFailure("integration_disabled", 403);
      if (old.baseUrl && !old.removed && old.baseUrl !== baseUrl)
        throw new ToolyardIntegrationFailure("instance_binding_change_requires_removal", 409);
      if (!input.enabled)
        throw new ToolyardIntegrationFailure("use_instance_disable_or_disconnect", 400);
      if (!input.apiKey) throw new ToolyardIntegrationFailure("api_key_required", 400);
      if (input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey))
        throw new ToolyardIntegrationFailure("invalid_api_key", 400);
      const metadata = await this.request(baseUrl, "/.well-known/toolyard-instance");
      const advertised = Array.isArray(metadata.capabilities) ? metadata.capabilities : [];
      for (const capability of [
        "connections.api-key.v1",
        "callbacks.pull.v1",
        "inbox.batch.v1",
        "callbacks.standard-webhooks.v1",
        "dashboard.handoff.v1",
      ])
        if (!advertised.includes(capability))
          throw new ToolyardIntegrationFailure("api_key_protocol_unavailable", 400);
      const instanceId = string(metadata, "instance_id");
      if (!changesInstance && old.instanceId !== instanceId)
        throw new ToolyardIntegrationFailure("instance_identity_changed", 409);
      const blocksOwner = (job: Persisted["pendingRevocations"][number]) =>
        job.settings.instanceId === instanceId &&
        ((!job.token && job.scope !== "user") || job.userId === userId);
      if (this.state.pendingRevocations.some(blocksOwner)) {
        await this.flushRevocationsUnlocked();
        if (this.state.pendingRevocations.some(blocksOwner))
          throw new ToolyardIntegrationFailure("revocation_cleanup_pending", 409);
      }
      const key = this.key(userId, instanceId);
      const prior = this.state.connections[key];
      if (prior?.mode !== "api-key" && prior?.token)
        throw new ToolyardIntegrationFailure("disconnect_before_mode_change", 409);
      const response = await this.request(
        baseUrl,
        "/v1/connections/api-key",
        {
          environment_id: this.options.environmentId,
          local_user_id: userId,
          instance_id: instanceId,
          expected_version: 0,
          reconnect: true,
        },
        input.apiKey,
      );
      if (response.instance_id !== instanceId)
        throw new ToolyardIntegrationFailure("connection_instance_identity_mismatch", 409);
      const next = this.decodeConnection(response, userId, "api-key");
      await this.persistSettingsChange((candidate) => {
        if (changesInstance || !old.enabled) {
          this.advanceTrustGeneration(candidate);
          candidate.settings = {
            revision: old.revision + 1,
            enabled: true,
            removed: false,
            baseUrl,
            instanceId,
            origin: baseUrl,
          };
          candidate.connections = {};
        } else candidate.connections = { ...candidate.connections };
        candidate.connections[key] = next;
      });
      return this.status(userId, false);
    });
  }
  private async disconnect(userId: string, expectedRevision: number) {
    return this.serialized(async () => {
      if (expectedRevision !== this.state.settings.revision)
        throw new ToolyardIntegrationFailure("settings_revision_conflict", 409);
      const key = this.key(userId);
      const prior = this.state.connections[key];
      await this.persistSettingsChange((candidate) => {
        candidate.connections = {
          ...candidate.connections,
          [key]: {
            version: prior?.version ?? 0,
            state: "revoked",
            mode: prior?.mode ?? "team",
            userId,
          },
        };
        if (prior?.token && prior.mode === "api-key")
          this.enqueueApiRevocation(this.state.settings, userId, prior.token, candidate);
        else if (prior?.token && this.state.settings.baseUrl && this.state.settings.instanceId)
          candidate.pendingRevocations.push({
            settings: { ...this.state.settings },
            userId,
            scope: "user",
            attempts: 0,
            retryAfter: 0,
            lastError: null,
          });
      });
      await this.flushRevocationsUnlocked();
      return this.status(userId, false);
    });
  }
  private enqueueApiRevocation(
    settings: ToolyardInstanceSettings,
    userId: string,
    token: string,
    state: Persisted,
  ) {
    if (!settings.baseUrl || !settings.instanceId) return;
    if (state.pendingRevocations.some((job) => job.token === token)) return;
    state.pendingRevocations.push({
      settings: { ...settings },
      userId,
      token,
      attempts: 0,
      retryAfter: 0,
      lastError: null,
    });
  }
  private enqueueRevocation(settings: ToolyardInstanceSettings, userId: string, state: Persisted) {
    if (!settings.baseUrl || !settings.instanceId) return;
    for (const connection of Object.values(this.state.connections))
      if (connection.mode === "api-key" && connection.token && connection.userId)
        this.enqueueApiRevocation(settings, connection.userId, connection.token, state);
    if (!settings.origin || settings.origin === settings.baseUrl) return;
    if (
      state.pendingRevocations.some(
        (job) =>
          !job.token &&
          job.scope !== "user" &&
          job.settings.instanceId === settings.instanceId &&
          job.settings.baseUrl === settings.baseUrl,
      )
    )
      return;
    state.pendingRevocations.push({
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
        if (job.token)
          await this.request(job.settings.baseUrl!, "/v1/connections/revoke", {}, job.token);
        else
          await this.request(job.settings.baseUrl!, "/v1/federation/revoke", {
            assertion: await this.assertion(job.userId, job.settings),
            scope: job.scope ?? "environment",
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
  async reconcileCredentials() {
    const userIds = Object.values(this.state.connections)
      .filter((c) => c.token && c.userId && c.state !== "revoked" && c.state !== "disabled")
      .map((c) => c.userId!);
    for (const userId of userIds) {
      try {
        await this.credential(userId);
      } catch {
        /* inactive owner stays denied */
      }
    }
  }
  async credential(userId: string): Promise<Connection | null> {
    await this.options.verifyUser(userId);
    if (!userId.startsWith("user_") && userId !== "local-user")
      throw new ToolyardIntegrationFailure("verified_identity_required", 403);
    const settings = { ...this.state.settings };
    if (!settings.enabled || settings.removed || !settings.baseUrl || !settings.instanceId)
      return null;
    const key = this.key(userId, settings.instanceId);
    return this.userSerialized(key, async () => {
      const prior = this.state.connections[key];
      const mode = prior?.mode ?? "team";
      if (mode === "team" && !userId.startsWith("user_")) return null;
      if (mode === "api-key" && !prior?.token) return null;
      if (prior?.state === "revoked" || prior?.state === "disabled") return null;
      if (
        prior?.token &&
        prior.state === "connected" &&
        prior.expiresAt &&
        Date.parse(prior.expiresAt) > this.now + (mode === "api-key" ? 24 * 3600_000 : 30_000)
      )
        return prior;
      if (prior?.retryAfter && prior.retryAfter > this.now) return null;
      try {
        const response =
          mode === "api-key"
            ? await this.request(
                settings.baseUrl!,
                "/v1/connections/renew",
                { expected_version: prior!.version },
                prior!.token,
              )
            : await this.request(settings.baseUrl!, "/v1/federation/connect", {
                assertion: await this.assertion(userId, settings),
                expected_version: prior?.version ?? 0,
              });
        const next: Connection = {
          mode,
          userId,
          ...(mode === "api-key"
            ? {
                connectionGeneration: Number(
                  response.connection_generation ?? prior?.connectionGeneration ?? 0,
                ),
              }
            : {}),
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
          (mode === "api-key" &&
            (!Number.isSafeInteger(next.connectionGeneration) || next.connectionGeneration! < 1)) ||
          !Number.isFinite(Date.parse(next.expiresAt!))
        )
          throw new ToolyardIntegrationFailure("invalid_response", 502);
        await this.serialized(async () => {
          if (
            this.state.settings.revision !== settings.revision ||
            this.state.connections[key] !== prior
          )
            throw new ToolyardIntegrationFailure("connection_changed", 409);
          await this.persistSettingsChange((candidate) => {
            candidate.connections = { ...candidate.connections, [key]: next };
          });
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
          if (
            this.state.settings.revision !== settings.revision ||
            this.state.connections[key] !== prior
          )
            return;
          await this.persistSettingsChange((candidate) => {
            candidate.connections = {
              ...candidate.connections,
              [key]: {
                ...(state === "unavailable" && mode === "api-key" ? prior : {}),
                mode,
                userId,
                version: prior?.version ?? 0,
                state,
                retryAfter: this.now + 30_000,
              },
            };
          });
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
      await this.persistSettingsChange((candidate) => {
        candidate.connections = {
          ...candidate.connections,
          [key]: {
            version: prior.version,
            state: "revoked",
            mode: prior.mode ?? "team",
            userId,
          },
        };
      });
      return true;
    });
  }
  async status(userId: string, connect = true) {
    const user = await this.options.verifyUser(userId);
    if (connect) await this.credential(userId);
    const connection = this.state.connections[this.key(userId)];
    return {
      ...this.state.settings,
      trustGeneration: this.state.trustGeneration,
      revocationPending: this.state.pendingRevocations.length,
      administrator: user.admin,
      mode: this.connectionMode(userId),
      teamAvailable: userId.startsWith("user_"),
      apiKeyAllowed: true,
      callbackTransport:
        this.connectionMode(userId) === "api-key" ? ("pull" as const) : ("push" as const),
      connection: connection?.state ?? ("not_connected" as const),
      email: connection?.email ?? null,
      expiresAt: connection?.expiresAt ?? null,
    };
  }
  async handoff(userId: string) {
    const connection = await this.credential(userId);
    if (!connection) throw new ToolyardIntegrationFailure("connection_unavailable", 403);
    const settings = { ...this.state.settings };
    const response =
      connection.mode === "api-key"
        ? await this.request(settings.baseUrl!, "/v1/connections/handoff", {}, connection.token)
        : await this.request(settings.baseUrl!, "/v1/federation/handoff", {
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
    input: {
      destination?: string;
      transport?: "push" | "pull";
      secret: string;
      client_receiver_id: string;
      environment_id?: string;
    },
  ) {
    const settings = { ...this.state.settings };
    const connection = await this.credential(userId);
    if (!connection?.token) throw new ToolyardIntegrationFailure("connection_unavailable", 403);
    if (settings.revision !== this.state.settings.revision)
      throw new ToolyardIntegrationFailure("instance_changed", 409);
    return this.request(
      settings.baseUrl!,
      "/v1/callbacks/receivers",
      {
        ...input,
        transport: this.connectionMode(userId) === "api-key" ? "pull" : "push",
        environment_id: this.options.environmentId,
      },
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
  private async callbackRequest(
    userId: string,
    ref: string,
    suffix: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(ref))
      throw new ToolyardIntegrationFailure("invalid_callback_reference");
    const settings = { ...this.state.settings };
    const connection = await this.credential(userId);
    if (!connection?.token) throw new ToolyardIntegrationFailure("connection_unavailable", 403);
    if (connection.mode !== "api-key")
      throw new ToolyardIntegrationFailure("pull_connection_required", 403);
    try {
      const result = await this.request(
        settings.baseUrl!,
        `/v1/callbacks/receivers/${ref}/${suffix}`,
        body,
        connection.token,
        12 * 1048576,
        signal,
      );
      if (settings.revision !== this.state.settings.revision)
        throw new ToolyardIntegrationFailure("instance_changed", 409);
      return result;
    } catch (error) {
      if (error instanceof ToolyardIntegrationFailure && error.status === 401)
        await this.retire(userId, connection.token);
      throw error;
    }
  }
  pullCallback(userId: string, ref: string, signal?: AbortSignal) {
    return this.callbackRequest(userId, ref, "events", undefined, signal);
  }
  async ackCallback(userId: string, ref: string, eventId: string) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(eventId))
      throw new ToolyardIntegrationFailure("invalid_callback_event");
    await this.callbackRequest(userId, ref, "ack", { event_id: eventId });
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

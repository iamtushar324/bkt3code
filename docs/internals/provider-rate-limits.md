# Provider Rate Limits

Provider rate limits are provider-neutral observations used by the control-center header. Server
state is transient; clients retain only the last normalized successful reading in local storage so
a temporary provider or connection outage does not erase the display. Limits do not participate in
provider selection or orchestration decisions.

## Data flow

Codex and Claude normalize their native quota shapes at the adapter boundary into
`ProviderRateLimitUpdate`. The in-memory `ProviderRateLimits` service consumes canonical provider
events, keeps one snapshot per provider instance, and exposes an authenticated, read-only WebSocket
stream. Clients subscribe through the selected environment, so local, remote, relay, and tunnel
connections use the same contract.

Updates have either replace or merge semantics. A full provider query replaces the known windows;
sparse native notifications merge windows by `windowId`. The service rejects observations older
than the last update for an instance and only publishes when normalized state changes. A refresh
failure preserves the last valid snapshot while setting `lastRefreshFailed`.

The stream starts with the current server-memory snapshot and then emits revisioned updates. A
server restart returns an unknown live state until an active runtime observes new limits; clients
may project their cached last-known reading as stale in the meantime. The environment capability
`providerRateLimits` prevents newer clients from calling the stream on older servers.

## Provider adapters

Codex performs a non-blocking `account/rateLimits/read` after app-server initialization and
normalizes primary and secondary windows from each limit bucket. It falls back to the legacy
single-bucket shape. Sparse `account/rateLimits/updated` notifications are merge updates.

Claude normalizes typed `rate_limit_event` messages and wraps the Agent SDK's experimental usage
query entirely inside `ClaudeAdapter`. It performs an initial full refresh and coalesces refreshes
after completed turns to at most one per provider instance every 60 seconds. SDK query failures do
not fail user turns.

Empty subscription quota responses and API-key sessions are represented as `not-applicable`.
Collection is always best-effort and never delays or fails a turn.

## Client projection

The header shows only the built-in default Codex and Claude instances, in that order, when those
drivers are enabled. The detailed stream remains keyed by provider instance so custom instances can
be represented later without changing the contract.

The headline percentage is `100 - usedPercent`, rounded to a whole number, and takes the minimum
remaining value across active windows. The bar track always has a low-contrast gray background and
border so its full 32 px width remains visible at either extreme.

Each web client caches successful, non-empty `available` snapshots by environment and provider
instance. Unknown and failed live readings preserve this cache; an explicit `not-applicable`
reading clears it. A cached snapshot, an observation older than ten minutes, a failed refresh, or a
window past reset retains its last-known percentage but uses the muted stale treatment. The popover
shows its observation time and why it is not live. Boundary changes use one-shot timers; there is no
polling or continuous animation.

## Privacy and telemetry

The public and locally cached snapshots contain only provider instance and driver identifiers,
normalized quota windows, observation times, and refresh status. They must never include
credentials, account email, raw SDK payloads, credit identifiers, billing amounts, or spend data.

Metrics count normalized updates and refresh failures by provider, availability, and update mode.
They never record quota percentages.

# Claude account switching on dev-server-1

Host tooling that lets every T3 Code session on `ip-10-31-39-131` run under a chosen
Claude account, switched from a terminal, without interrupting existing threads. It
also switches automatically when the active account nears its usage limits.

This is host-only: nothing here ships in the application, and none of it is installed
by a deploy. It is documented here because it changes how the Claude provider is
configured on the Beknown deployments. For the general multi-account pattern, see
[Claude](../user/providers-claude.md).

## Why the obvious approach does not work here

[Claude](../user/providers-claude.md) recommends one provider per account, each with
its own `CLAUDE_CONFIG_DIR path`, and states that switching accounts inside an
existing thread is "usually, no". That is accurate: transcripts live at
`<config-dir>/projects/<slug>/<uuid>.jsonl`, so a thread resumed under a different
config directory finds no transcript for its session id and breaks.

Two extra constraints apply on this host:

- Sessions here are long-lived, so orphaning them is not acceptable.
- T3 Code resolves `binaryPath` and the spawn environment **once per adapter**
  (`claudeSdkExecutablePath` in `apps/server/src/provider/Layers/ClaudeAdapter.ts`),
  so changing either value in Settings has no effect until the provider instance is
  rebuilt.

## Design

One provider, one config-directory string, and a symlink that moves.

```text
Binary path:             claude
CLAUDE_CONFIG_DIR path:  /home/ubuntu/.claude-active     # a symlink
```

```text
~/.claude-active                    -> ~/.claude-profiles/<elected>
~/.claude-profiles/<name>/          per-account: .credentials.json, .claude.json
~/.claude-profiles/<name>/projects  -> ~/.claude/projects        (shared transcripts)
~/.claude-profiles/<name>/{CLAUDE.md,skills,plugins,settings.json,hooks}
                                    -> ~/.claude/<same>          (shared config)
```

Three properties follow, and each solves one of the problems above:

- **Threads survive a switch.** Every profile's `projects/` is the same directory, so
  any account can resume any session.
- **The stale-adapter problem disappears.** The configured value never changes; only
  the symlink target does, and the CLI resolves it at spawn time. A provider instance
  captured long ago still lands on the currently elected account.
- **Account metadata stays intact.** Each profile owns its `.claude.json`, so the
  provider panel reports the real email and plan, and the CLI refreshes its own token.

Do not point `CLAUDE_CONFIG_DIR` at `~/.claude` itself. That directory's account
metadata lives in `~/.claude.json`, _beside_ it rather than inside it, so it resolves
to credentials without an email. `~/.claude.json` is also rewritten by atomic rename,
which replaces a symlink there with a regular file.

## Switching by hand

```bash
claude-profile list             # every profile, the account it holds, which is elected
claude-profile use <name>       # elect a profile for newly spawned sessions
claude-profile active           # which profile is elected
cs <name>                       # switch only the current shell (independent of the above)
```

`claude-profile create <name>` then `claude-profile login <name>` adds an account. Create
re-links shared items and is safe to re-run after adding a new top-level directory to
`~/.claude`.

Two caveats:

- A switch applies to **newly spawned** sessions. A thread mid-turn keeps its account
  until its process restarts. Nothing breaks, because history is shared.
- The provider panel lags a switch by up to five minutes. The account probe is cached
  (`CAPABILITIES_PROBE_TTL` in `apps/server/src/provider/Drivers/ClaudeDriver.ts`) on
  `binaryPath + homePath + cwd`, none of which change when the symlink moves.

## Automatic switching on usage limits

`claude-autoswitch` runs every 30 seconds from `claude-autoswitch.timer` and elects a
different profile when the active account is nearly spent.

It makes **no network requests and never spawns `claude`**. Usage comes from
`<profile>/.claude.json` -> `cachedUsageUtilization`, which the Claude CLI maintains as a
side effect of normal use. A run is three small file reads (~0.06 s, ~16 MB RSS). Note
this is not the source T3 Code displays; the panel uses live stream events via
`normalizeClaudeRateLimitEvent`.

```bash
claude-autoswitch --status      # all profiles, effective percentages, which is elected
claude-autoswitch --dry-run     # decide without switching
tail ~/.claude-profiles/.autoswitch.jsonl        # every decision, with its inputs
```

### Authoritative provider rejection

The timer remains the fallback, but it cannot act promptly when Claude rejects a request before
its local utilization cache catches up. T3 therefore listens for the SDK's typed
`rate_limit_event`. Only `rate_limit_info.status == "rejected"` with one of `five_hour`,
`seven_day`, `seven_day_opus`, `seven_day_sonnet`, or `overage` is authoritative. Warnings,
ordinary HTTP/provider errors, missing limit types, and every other event are ignored.

For an authoritative rejection, T3 invokes the credential-free host contract:

```bash
/home/ubuntu/.local/bin/claude-autoswitch --hard-limit <type> --json
```

The hard-limit and timer paths hold the same machine-wide lock across candidate election, atomic
symlink replacement, and autoswitch state persistence. Hard-limit mode bypasses the stale cache
for the rejected account and the normal cooldown for that decision only; it does not rewrite the
cache. The host command returns one JSON object:

- exit 0 with `status: "switched"`: the election committed;
- exit 0 with `status: "no-op"`: no eligible authorized profile was available;
- exit 1 with `status: "failure"`: election failed.

T3 validates the JSON, requested limit type, exit code, and `switched` status. Only then does it
stop the Claude provider session for the thread that emitted the rejection, so its next resume
spawns through `~/.claude-active` and reads the newly elected profile. Other Claude threads keep
running. Repeated copies of the same provider-instance, limit-type, and reset condition are
consumed once. A no-op, nonzero exit, invalid response, timeout, or command error is logged and
leaves the affected session running for the timer or an operator to recover.

Manual selection semantics remain in the host election policy. The timer only reverses its own
automatic move; the event-driven path does not inspect profiles or credentials in T3.

Config lives in `~/.claude-profiles/.autoswitch.json`:

| key                       | default                        | meaning                                        |
| ------------------------- | ------------------------------ | ---------------------------------------------- |
| `rotation`                | `["tushar","agent","default"]` | order tried; first entry is the primary        |
| `five_hour_trip_pct`      | `88`                           | trip when the 5-hour window is this **used**   |
| `weekly_trip_pct`         | `95`                           | trip when the weekly window is this **used**   |
| `count_weekly_scoped`     | `false`                        | include the model-scoped weekly window         |
| `min_switch_interval_sec` | `900`                          | anti-flap floor between switches               |
| `failback_to_primary`     | `true`                         | return to the primary once it has headroom     |
| `notify_command`          | `""`                           | optional shell command; `{from} {to} {reason}` |

The percentages are **used**, not remaining: "switch when under 12% of the 5-hour window
is left" is `five_hour_trip_pct: 88`.

Two rules in the implementation are not obvious and should not be simplified away:

1. **Reset-discounted staleness.** An exhausted account stops running sessions, so its
   cache stops refreshing; a plain freshness check would refuse to act exactly when
   action is needed. Each window's cached percentage is instead discounted against its
   own `resets_at` — past the reset it counts as zero. Stale data can then only
   understate headroom, never overstate it.
2. **Failback must not fight a manual switch.** Returning to the primary happens only
   when state records `auto_moved: true` and `last_to` equals the current profile, so
   the timer only ever reverses its own move. Without this it silently overrides an
   operator who ran `claude-profile use`.

Disable with `"enabled": false`, or:

```bash
sudo systemctl disable --now claude-autoswitch.timer
```

That disables the fallback timer. To disable only T3's immediate-rejection listener while keeping
the timer active, set `T3_CLAUDE_HARD_LIMIT_ROTATION=0` in the deployment service environment and
restart that environment.

## Staging verification

Verify on `expbkt3` before promotion:

1. Run the focused behavior test:
   `VITEST_MAX_THREADS=2 vp test run apps/server/src/provider/claudeHardLimitRotation.expbkt3.test.ts --maxWorkers=2`.
2. Keep two Claude threads active and record both thread identifiers. Inject one typed five-hour
   rejection fixture while the cached utilization is below its normal trip threshold. Confirm one
   `confirmed profile election` log followed by one `recycled affected provider session` log for
   the emitting thread.
3. Deliver the same rejection again. Confirm there is no second host command or recycle log, and
   confirm the unrelated Claude thread remains active.
4. Inject an `allowed_warning`, a generic HTTP 429/runtime error, and a rejected event without a
   supported `rateLimitType`. Confirm none invokes the host command or stops a session.
5. Exercise host no-op, nonzero, invalid-JSON, and timeout fixtures. Confirm each logs why the
   election was unconfirmed and leaves the emitting session active.

## Manual rollback

Set `T3_CLAUDE_HARD_LIMIT_ROTATION=0` and restart `t3-expbkt3.service` to roll back the application
hook without disabling the timer. If the host prerequisite itself must be rolled back, an operator
can restore `/home/ubuntu/.local/bin/claude-autoswitch.bak-20260820-tec961` to
`/home/ubuntu/.local/bin/claude-autoswitch`; the application will then treat the missing hard-limit
contract as an unconfirmed command response and will not recycle a session. Revert the bkt3 commit
before promotion for a complete rollback.

## Operational notes

The election is **machine-global**. Whichever profile is elected absorbs the usage of
every session spawned on this host, including other operators'. Keep an account out of
`rotation` if its billing must stay attributable to one person.

Anthropic's Consumer Terms, Usage Policy and Commercial Terms place no restriction on one
person holding several accounts, and do not address rate-limit rotation. What they do
prohibit is sharing credentials or making an account available to someone else — which is
why the machine-global point above matters more than the account count.

## Files

| path                                                       | role                                          |
| ---------------------------------------------------------- | --------------------------------------------- |
| `~/.local/bin/claude-profile`                              | create/login/list/use/delete profiles         |
| `~/.local/share/claude-profile/shell-init.sh`              | `cs` shell function, sourced from `~/.bashrc` |
| `~/.local/bin/claude-autoswitch`                           | usage-based switcher (python3, stdlib only)   |
| `~/.local/bin/claude-elected`                              | unused fallback wrapper; see note below       |
| `/etc/systemd/system/claude-autoswitch.{service,timer}`    | 30-second timer, `User=ubuntu`                |
| `~/.claude-profiles/.autoswitch{.json,-state.json,.jsonl}` | config, state, decision log                   |

`claude-elected` injects the elected config directory via a wrapper set as `binaryPath`.
It works standalone but is not in use: `binaryPath` is captured at adapter creation, so a
Settings change to it does not take effect until the instance is rebuilt, whereas the
symlink approach needs no rebuild after the initial setup.

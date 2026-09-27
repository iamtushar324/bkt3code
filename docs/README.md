# T3 Code docs

## Using T3 Code

- [Install T3 Code](./user/install.md)
- [Messages and context](./user/composer.md)
- [Working with threads](./user/thread-sidebar.md)
- [Permission modes](./user/permission-modes.md)
- [Terminal history](./user/terminal.md)
- [Source control](./user/source-control.md)
- [Project settings](./user/project-settings.md)
- [Appearance and themes](./user/appearance.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [SnapShots](./user/snap-shot.md)
- [Import browser sessions](./user/browser-import.md)
- [Devices](./user/devices.md)
- [Usage and limits](./user/usage.md)
- [Product usage data](./user/telemetry.md)

<!-- T3-CUSTOM(expbkt3): fork user guides. -->

- [Opening a worktree in another app](./user/open-in-app.md)
- [User management](./user/user-management.md)
- [Worktree setup and new-thread defaults](./user/worktree-setup.md)
- [T3 Code MCP control center](./user/t3-mcp-control.md)
- [Agent views in chat](./user/agent-views.md)
- [Provider usage limits](./user/provider-limits.md)
- [Remote access](./user/remote-access.md)
- [Running in the background](./user/background-service.md)
- [Updating T3 Code](./user/updating.md)
- Provider guides: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [OpenCode](./user/providers-opencode.md) · [Antigravity](./user/providers-antigravity.md)

---

## Working on T3 Code

Start with the [development runbook](./operations/development.md) and
[contribution policy](../CONTRIBUTING.md).

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)

<!-- T3-CUSTOM(expbkt3): fork architecture and operation references. -->

- [Durable thread bootstrap](./internals/thread-bootstrap.md)
- [Execution reliability](./internals/execution-reliability.md)
- [Provider rate limits](./internals/provider-rate-limits.md)
- [Thread-owned source-control identity](./internals/source-control-identity.md)
- [expbkt3 customization boundaries](./operations/expbkt3-customizations.md)
- [Personal MCP identity architecture](./internals/t3-personal-mcp-architecture.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Pull request file revisions](./internals/pull-request-file-revisions.md)
- [Model classification](./internals/model-manifest.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Product analytics](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [T3 Connect](./internals/t3-connect.md)
- [Assistant citations](./internals/assistant-citations.md)
- [Mobile navigation](./internals/mobile-navigation.md)
- [Mobile development lifecycle](./internals/mobile-development.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Devices](./internals/devices.md)
- [Voice input](./internals/voice-input.md)

### Runbooks

<!-- T3-CUSTOM(expbkt3): deployment runbook remains the CI/install authority. -->

- [Beknown deployments](./operations/deployments.md)

- [Development and local builds](./operations/development.md)
- [T3 Connect setup](./operations/connect-setup.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)

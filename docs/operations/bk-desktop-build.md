# BK desktop apps (macOS)

Fork-owned. How the two Beknown-branded macOS desktop apps are built, published and auto-updated.

The fork does not need a new app: `apps/desktop` is upstream's Electron app, and the browser client is the same `apps/web` SPA that `deploy-bkt3.yml` already deploys. What this adds is _two distinct identities_ so each fork build installs alongside upstream T3 Code and alongside each other, and a publish path with working auto-update.

| Branch      | App                | Bundle id                       | User data                                        | Updater cache                               | Orchestrates             | URL scheme  |
| ----------- | ------------------ | ------------------------------- | ------------------------------------------------ | ------------------------------------------- | ------------------------ | ----------- |
| `expbkmain` | `Stage BK T3 Code` | `work.beknown.bkt3code.staging` | `~/Library/Application Support/bkt3code-staging` | `~/Library/Caches/bkt3code-staging-updater` | expbkt3.dev.beknown.live | none        |
| `bkmain`    | `BK T3 Code`       | `work.beknown.bkt3code`         | `~/Library/Application Support/bkt3code`         | `~/Library/Caches/bkt3code-updater`         | bkt3.dev.beknown.live    | `t3code://` |
| _upstream_  | `T3 Code (Alpha)`  | `com.t3tools.t3code`            | `~/Library/Application Support/t3code`           | `~/Library/Caches/t3code-updater`           | —                        | `t3code://` |

The **updater cache is a third isolation axis**, and an easy one to miss. It lives outside `userData`, so a distinct bundle id and user-data directory are not sufficient. electron-builder derives `updaterCacheDirName` in `app-update.yml` from the staged package name, which was hard-coded `"t3code"` — meaning all three apps shared `~/Library/Caches/t3code-updater` and could overwrite each other's part-downloaded update. `resolveDesktopStagePackageName` in `scripts/build-desktop-artifact.ts` now derives it from `userDataDirName`, so the two axes cannot drift apart.

The encrypted desktop connection catalog follows the same isolation boundary. BK builds store it inside their own Application Support directory (`bkt3code` or `bkt3code-staging`) instead of the shared T3 home, because Electron safe-storage ciphertext from one app identity cannot be decrypted by the other. The older shared catalog is left untouched.

Both are Apple Silicon (`arm64`) only, code signed, **keyless**, and published as prereleases on [`beknown-work/bkt3code`](https://github.com/beknown-work/bkt3code/releases). The identity in use during the current trial is an Apple Development certificate, not the self-signed root this document otherwise describes — see [Current identity is a test certificate](#current-identity-is-a-test-certificate).

## How it runs

Both BK desktop distributions serve the packaged web assets directly and
connect their **primary** environment to the managed HTTPS server selected by
the release branch — that is where identity, the member roster and thread
tagging live. Each build also carries the **bundled T3 backend**: Electron
starts it on launch as a _secondary_ local environment (pool id `bk-local`,
the same rails a WSL backend rides). Production scans ports 3773–3872 and keeps
its existing `~/.t3` state for compatibility; staging scans 4773–4872 and stores
its bundled backend state below its own Application Support directory. Local
projects and threads run on this machine — including
fully offline: with the central server unreachable, a previously paired app
still opens and the local environment keeps working while the primary
reconnects in the background (`apps/web/src/fork/managedOfflineGate.ts`).

`T3CODE_PORT` and `T3CODE_HOME` remain explicit overrides for either channel.
They bypass the channel defaults, so an operator running both apps must choose
distinct override values. No data is copied or migrated automatically: production
continues using its existing data and staging begins with its own state.

The bundled backend is single-user and keyless — no Clerk configuration ever
reaches it, so it advertises no team capability and member surfaces stay
hidden on local threads by design. Its state follows the channel rules above.
The Connections settings intentionally do not show the
local-backend admin rows (network exposure, WSL, pairing-link management):
those manage a _primary_ local backend, which a managed build does not have.

To run agents on a teammate's Mac from elsewhere, install and launch `t3`
separately on that Mac, expose it through an appropriate HTTPS/Tailscale or
SSH route, and add it from **Settings → Connections → Add environment**. It
remains a secondary environment; `bkt3.dev` or `expbkt3.dev` stays primary.

Every push to `expbkmain` or `bkmain` triggers `.github/workflows/bk-desktop-release.yml` on a GitHub-hosted `macos-26` runner, which builds that branch's app and publishes it. Standard GitHub-hosted runners are free on public repositories, so this costs nothing and needs no machine of ours. Running apps poll every 4 minutes and download in the background, then raise a native notification when a build is ready. Clicking that notification **surfaces the update in the app; it does not restart** — see [Update behaviour](#update-behaviour).

**A push is currently the only way to trigger a build.** The workflow declares `workflow_dispatch`, but GitHub only offers that trigger for workflows present on the repository's **default branch** — and this fork's default branch is `main`, the pure upstream mirror, which by design never carries fork-owned workflows. So the "Run workflow" button will not appear. Push to `expbkmain` or `bkmain` instead, or build locally (see [Manual builds](#manual-builds)).

## Managed builds are keyless

**Never set a Clerk publishable key for a managed build.** Identity and team capability arrive through the device-bound pairing credential (`apps/web/src/fork/managedPrimaryPairing.ts`), not Clerk.

A key is not a harmless extra. `apps/web/src/main.tsx` mounts `ElectronClerkProvider` whenever one is present; that provider renders nothing until Clerk's Native API answers, so a key reproduces the black-screen/auth failure this fork already hit once.

Enforced in two places, both failing rather than warning:

- `scripts/build-bk-desktop-dmg.ts` refuses to build if any `*CLERK*` variable is set in `.env`, `.env.local` or the environment, and scrubs the Clerk aliases from the build environment so an inherited one cannot leak in.
- The workflow asserts the same before installing dependencies, so CI fails in seconds rather than at the end of a 15-minute build.

Pairing happens once per install: open the pairing screen and paste the credential.

## Update behaviour

Fork builds download updates in the background, so the payload is already on disk when you are told about it. Then:

1. A native notification says the version is ready.
2. Clicking it **focuses the app and surfaces the update** — it does not install.
3. The labelled update button in the sidebar performs the restart, after a confirmation dialog.

The click deliberately does not install. Installing quits the app: it stops every backend in the pool and calls `quitAndInstall`. Doing that on a stray notification click would kill an in-flight agent turn, a terminal session and any unsaved editor state, with no undo. One extra click is a cheap price for that.

## URL schemes

`Stage BK T3 Code` registers **no** OS-level URL scheme, so `t3code://` belongs unambiguously to `BK T3 Code` (or upstream).

Two installed apps both claiming `t3code://` is not a tie macOS breaks predictably — it routes to whichever became the handler most recently, so a staging pairing link could open production. State stays isolated either way, but to a user that is indistinguishable from channel leakage.

Staging therefore pairs by pasting the credential into the pairing screen, which already accepts one (`PairingRouteSurface`). If staging ever needs working deep links, give it its own scheme in `deepLinkScheme` and have expbkt3 generate matching links — but note that `getDesktopScheme` in `apps/desktop/src/electron/ElectronProtocol.ts` is also the origin the renderer is _served_ from, and `apps/server/src/http.ts` allowlists `t3code://app` for CORS. Registering a different OS handler is a one-line manifest change; changing the serving origin is not.

## What keeps the two apps apart

One repository holds both apps' releases, and the **updater channel** is the only thing separating them. electron-updater's `GitHubProvider` walks the releases feed and takes the first release whose `semver.prerelease(tag)[0]` equals the running app's channel, then reads `<channel>-mac.yml` from it. So the channel has to be the version's first prerelease identifier:

| App        | Version                               | Channel              | Manifest                     |
| ---------- | ------------------------------------- | -------------------- | ---------------------------- |
| Staging    | `X.Y.Z-staging-nightly.YYYYMMDD.N`    | `staging-nightly`    | `staging-nightly-mac.yml`    |
| Production | `X.Y.Z-production-nightly.YYYYMMDD.N` | `production-nightly` | `production-nightly-mac.yml` |

A staging release is therefore invisible to a production app, and vice versa.

Keeping `-nightly.YYYYMMDD.N` as the **suffix** is load-bearing, not decoration:

- Upstream's `resolveDesktopUpdateChannel` and `isNightlyDesktopVersion` both test `/-nightly\.\d{8}\.\d+$/`. Matching it is what makes these builds publish as prereleases with `allowPrerelease` on — a GitHub prerelease is invisible to the `latest` channel, so "prerelease + auto-update" only works on a nightly-style channel.
- `.github/workflows/release.yml` triggers on `v*.*.*` with `!v*-nightly.*` excluded. Both channels' tags fall inside that exclusion, so the upstream release pipeline — which publishes `t3` to npm, cuts a public GitHub Release and re-aliases app.t3.codes, with no dry-run mode — cannot fire.
- The `DesktopUpdateChannel` contract union stays `"latest" | "nightly"`. Only the string handed to `autoUpdater.channel` changes, so the settings UI and persisted setting are untouched.

`X.Y.Z` is one patch above the current `apps/desktop/package.json` version, and `N` counts that channel's builds that day. Counters are per channel, so a staging build cannot consume production's number.

## Code signing

**Auto-update does not work unsigned.** Squirrel.Mac validates an update bundle against the installed app's designated requirement; an unsigned app has no requirement to satisfy, so the download succeeds and the install silently does not.

Apple's certificates are bound to upstream's `com.t3tools.t3code` App ID, so the fork signs with a **self-signed** certificate from the build Mac's login keychain instead. The designated requirement is then `identifier + leaf certificate hash`, which is stable across builds as long as the same certificate signs every one of them.

> **Unproven until demonstrated.** Self-signed Squirrel.Mac updating is sound in theory and is _not_ to be described as working until a real signed A → B update has installed on a real Mac. Until then, treat every published build as manual-install. The gate is in [Verification gates](#verification-gates).

Consequences, all accepted:

- **The certificate is load-bearing.** Rotating or losing it breaks auto-update for every installed app and forces everyone to reinstall by hand. Back it up.
- **Not notarised.** Gatekeeper still quarantines the download, cleared once per install with the `xattr` step below. Expect first-install friction.
- **Upstream's `--signed` flag is not used.** It routes mac builds through `resolveMacPasskeySigningConfiguration`, which requires an Apple Team ID and a provisioning profile the fork does not have. `T3CODE_BK_SIGNING_IDENTITY` is the fork's own switch; it also turns the hardened runtime off, which exists to satisfy notarisation and otherwise only adds entitlement-shaped launch failures.

The signing seam takes any keychain identity by common name, so **switching to a Developer ID certificate is a secret change, not a code change**. That remains the better long-term answer: it notarises, it removes the trust-store ask below, and it survives a teammate reimaging their Mac.

### Current identity is a test certificate

As of 2026-08-14 the configured identity is a personal **Apple Development**
certificate, not the self-signed `BK Code Signing` root this document describes.
That is a deliberate choice for a two-person trial, and it works — but it is not
the end state, and the differences bite later rather than now:

- **It expires 2027-05-01.** After that no new build can be signed. Worse, the
  replacement certificate will have a _different_ designated requirement, so
  every installed app stops accepting updates and everyone reinstalls by hand.
  Plan the swap well before the date.
- **It is tied to a personal Apple ID.** If that account changes, leaves, or has
  its certificates revoked, signing stops.
- **It is a development certificate**, not intended for distribution. Nothing in
  this pipeline notarises, so Gatekeeper behaviour is the same either way — the
  `xattr` step still applies — but do not read Apple issuance as distribution
  approval.

Before this is used by anyone beyond the trial, move to either the self-signed
root below or a Developer ID certificate. The signing seam takes any keychain
identity by name, so that is a secret change, not a code change.

### Security of a self-signed certificate

Asking every teammate to mark a certificate **Always Trust** is an organisation-level decision, not a build detail: anyone holding that private key can sign _other_ software those Macs will then trust. Before doing it:

- Treat the `.p12` as a credential wherever it lives — the Mac it was created on, GitHub Secrets, and your backup. Delete the working copy from disk once it is in Secrets.
- Back it up somewhere access-controlled. Losing it means every installed app stops updating.
- Never expose it to workflow logs or to any job a pull request can reach. CI imports it into a keychain created per job in `RUNNER_TEMP`, with a random password, on a VM that is destroyed afterwards; it is never written to the workspace and never printed.
- Record its designated requirement in each release's notes (the publisher does this automatically) so a mismatch is diagnosable. That string — not the CDHash, which changes every build — is what Squirrel.Mac actually checks an update against.
- Plan rotation. Rotating requires a coordinated manual reinstall by everyone.
- Prefer Developer ID if you can justify the $99/yr — it avoids the trust-store change entirely.

### Creating the certificate (once)

On any Mac — CI imports it from a secret, so this does not have to be a dedicated machine:

1. **Keychain Access → Certificate Assistant → Create a Certificate.**
2. Name it something stable, e.g. `BK Code Signing`. Identity Type **Self Signed Root**, Certificate Type **Code Signing**. The name must not change: it signs every future build, and rotating breaks auto-update for every existing install.
3. Confirm it is usable: `security find-identity -v -p codesigning`.
4. Export the certificate **and its private key** as a `.p12` with a password, and turn it into the two secrets described in [Secrets](#secrets).
5. Separately export the public certificate (`.cer`) and send that to each teammate, who installs it in **login** and sets it to **Always Trust** for code signing. Never send the `.p12`.

## CI setup (once)

Builds run on **GitHub-hosted `macos-26`** — the standard Apple Silicon runner. Standard GitHub-hosted runners are free and unmetered on public repositories, and this repository is public, so there is nothing to install and no machine to maintain. It also means builds run when nobody's laptop is awake.

There is no runner to register. What is needed is four secrets — one of them optional — and two environments.

### Secrets

| Secret                          | Contents                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `BK_MACOS_SIGNING_IDENTITY`     | Identity name, exactly as `security find-identity -v -p codesigning` prints it   |
| `BK_MACOS_CERTIFICATE_BASE64`   | Base64 of the exported `.p12` (certificate **and** private key)                  |
| `BK_MACOS_CERTIFICATE_PASSWORD` | Password set when exporting that `.p12`                                          |
| `BK_MACOS_KEYCHAIN_PASSWORD`    | Optional. Password for the throwaway job keychain; a random one is used if unset |

To produce them, on any Mac that holds the certificate:

```sh
# Keychain Access → select the certificate AND its private key → Export…
# Save as Certificates.p12 and set an export password.
base64 -i Certificates.p12 | pbcopy   # paste into BK_MACOS_CERTIFICATE_BASE64
```

Export the **private key**, not just the certificate — a certificate alone cannot sign. Then delete the `.p12` from disk; the copy in Secrets is the one CI uses.

There is deliberately **no Clerk secret**. See [Managed builds are keyless](#managed-builds-are-keyless).

### Environments

Two are needed, and the publish job always requests exactly one of them:

| Environment             | Protection                                          | Requested by         |
| ----------------------- | --------------------------------------------------- | -------------------- |
| `bk-desktop-production` | Required reviewers; deployments limited to `bkmain` | production publishes |
| `bk-desktop-staging`    | **None** — create it and leave it unprotected       | staging publishes    |

An environment named `production` is **not** `bk-desktop-production` and will not be used.

`bk-desktop-staging` exists only so the workflow never has to resolve `environment:` to an empty string. Using an empty string to mean "no environment" is a common trick that GitHub does not document, and the first publish is not the place to discover whether it holds. It also gives each channel its own deployment history. If it is missing, staging publishes fail with an environment error — create it unprotected and re-run.

### Security model

The build job is the one that holds the signing key — electron-builder signs during packaging — and it is also the job that runs every dependency's install scripts. That is unavoidable, so the design contains it:

- **Ephemeral, isolated machines.** Each job gets a fresh VM that is destroyed afterwards. The certificate is imported into a keychain created in `RUNNER_TEMP` with a random password, and dies with the VM. Nothing is left behind for the next job, which was the main hazard of the self-hosted layout.
- **Split permissions.** The build job runs with `contents: read`. Only the publish job — which runs no build scripts and holds no signing key — gets `contents: write`. A malicious postinstall in the build job therefore cannot push a commit or cut a release.
- **Triggers.** `push` to the two branches and `workflow_dispatch` each require write access, and **neither can be fired from a fork**. Do not add `pull_request`, `pull_request_target` or `issue_comment` — that would run fork-authored code in the same job as the signing key.
- **`persist-credentials: false`**, so no token is left in `.git/config` for build scripts to find.
- **Actions pinned to commit SHAs.** A moving tag is a way for someone else's release to end up in the job that holds your private key.

Pair that with branch protection on `expbkmain` and `bkmain`, CODEOWNERS review for `.github/workflows/**`, `scripts/**` and the lockfile, and **Settings → Actions → Fork pull request workflows from outside collaborators → Require approval for all external contributors**.

The trade-off, stated plainly: the private key lives in GitHub Secrets rather than only in a Mac's keychain. For a public repository, secrets are not exposed to fork pull requests, and the triggers above are not fork-reachable. This is the standard pattern for signing any desktop app in CI, and it removes an always-on personal machine from the critical path.

### If this ever needs to move back to a self-hosted runner

Change `runs-on: macos-26` to your labels, drop the "Import signing certificate" step, and supply the identity from an unlocked login keychain instead. Then the earlier constraints return, and all of them matter:

- A **dedicated, credential-free** macOS account — one holding the signing key and nothing else. A job runs repository code as that user and inherits whatever it can read: `~/.aws/credentials`, `~/.ssh/id_*`, a signed-in browser profile, any token in a shell profile. One compromised transitive dependency is enough; nobody has to be malicious.
- That account must stay **logged in**. `codesign` needs an unlocked login keychain, and a background-only account produces the classic headless signing failure — the identity exists but is unusable, and electron-builder only says so at the end of a ~15-minute build.
- Disk hygiene, because the workspace persists: a packaged app is ~450 MB staged plus a ~158 MB DMG and ~152 MB ZIP. Prune `_work`, Rust `target/`, the pnpm store and Electron's download cache. Never "clean up" by deleting anyone's `~/Library/Application Support` entries.
- The two jobs could then share a workspace again, making the artifact hand-off below unnecessary.

## Manual builds

```sh
git checkout bkmain && git pull
pnpm install
export T3CODE_BK_SIGNING_IDENTITY="BK Code Signing"
pnpm dist:desktop:bk --channel production
```

`--channel` is required: it selects the app's bundle id, product name, user-data directory, updater channel and the central server the build orchestrates, all at once. Omitting the signing identity still builds — useful for a quick local run — but the build cannot be published.

Artifacts land in `release/`: the DMG a teammate downloads, the ZIP that auto-update actually installs, a `.blockmap` for each, and the channel manifest.

```sh
pnpm publish:desktop:bk --channel production \
  --build-version <the version just built> \
  --source-sha "$(git rev-parse HEAD)"
```

`--source-sha` is required and becomes the release's tag target. Without it `gh release create` cuts the tag from the repository's **default branch**, so the tag would point at `main` while the assets contain `expbkmain` code — a release that lies about what is inside it.

Add `--dry-run` to run every check without publishing. Do not insert a `--` separator before the flags: with pnpm 11.10.0 the separator reaches the script itself and the Effect CLI reports `Missing required flag`.

To pick a version yourself: `pnpm version:desktop:bk --channel production` prints the next one.

**Never run `gh release create` by hand, and never create a release tag manually.** Every guard below lives in the publisher; a hand-rolled release has none of them.

Six guards run before anything is published, each blocking:

1. **The tag must be nightly-form**, so `release.yml` cannot fire.
2. **The version's channel must be the channel being published**, or the other app's users get offered the build.
3. **The version must be strictly newer** than the newest published one _on that channel_, or electron-updater will never offer it.
4. **The build must be code signed**, or Squirrel.Mac cannot install it as an update.
5. **The channel manifest must be present**, or auto-update silently does nothing.
6. **The manifest's `sha512` must match the ZIP** beside it. electron-updater verifies this and discards a mismatched payload, so a stale manifest makes every client download the update and silently refuse it.

### Publication is atomic

Assets are uploaded to a **draft**, verified by name, byte size and upload state, and only then flipped to a prerelease. A draft is not in the releases feed, so no client can observe a half-uploaded release and 404 mid-update. A failed upload leaves a draft behind — delete it and re-run rather than publishing over it.

If a publish fails partway, it leaves a **draft** holding that version's tag. That is intentional — a draft is invisible to clients — but it used to wedge the channel: the build job resolves the next version with `contents: read`, and GitHub hides drafts from callers without push access, so it kept reissuing the same version while the publisher kept rejecting it as taken. The publisher now deletes a stale draft for the version it is publishing and continues. A draft left by an _unrelated_ failure can still be removed by hand with `gh release delete <tag> --yes`.

Release notes record the signing identity as a **fingerprint of the designated requirement**, never the raw string. This repository is public and an Apple-issued certificate embeds the developer's email and Team ID in its common name; publishing the raw requirement would put that on every release. The fingerprint answers "did the signing identity change between builds?", which is the operational question. For the raw value, run `codesign -dr -` against the app.

Once a version is published, **never replace its ZIP or manifest.** Clients cache by version; a mutated asset is undetectable and unfixable from their side. Publish a higher version instead.

After publishing, confirm the upstream pipeline did not fire and that npm is untouched:

```sh
gh run list --repo beknown-work/bkt3code --workflow release.yml -L 3
npm view t3 dist-tags
```

## Installing (send this to teammates)

1. Install the `BK Code Signing` certificate and set it to **Always Trust** (one-time).
2. Download the `.dmg` from the [latest prerelease](https://github.com/beknown-work/bkt3code/releases) — `BK T3 Code` for day-to-day work, `Stage BK T3 Code` to try `expbkmain`.
3. Drag it to Applications.
4. Builds are not notarised, so macOS quarantines them. Clear that once per app:
   ```sh
   xattr -dr com.apple.quarantine "/Applications/BK T3 Code.app"
   ```
5. Pair once: open the pairing screen and paste the credential.
6. Later builds arrive on their own. The app downloads in the background and notifies you; clicking the notification brings the app forward and surfaces the update. Press the update button when you are at a good stopping point — it confirms, then restarts.

Each app keeps its own settings, saved environments and sessions, and both install beside upstream T3 Code.

> **The first signed build must be installed by hand.** Auto-update from an unsigned build to a signed one cannot validate, because there was no designated requirement to match.

## What is not changed, and why

- **`getDesktopScheme`, the renderer's serving origin.** Both apps still serve their UI from `t3code://app`, which `apps/server/src/http.ts` allowlists for CORS. Only the _OS-level handler_ registration differs — see [URL schemes](#url-schemes).
- **`DesktopAppStageLabel`** in `packages/contracts` stays `"Nightly"` for these builds. Only the displayed name changes, so no upstream contract union needs a new member.

## Verification gates

Before advertising automatic updates on a channel, prove all of these. Nothing here is theoretical; each corresponds to a way this can fail silently.

1. **Keyless.** No `.env.local`, no `*CLERK*` variable in the build environment.
2. **Bundle identity.** `appId`, product name and version are the expected ones for the channel.
3. **Endpoint scan.** A staging bundle contains only `expbkt3` URLs; production only `bkt3`.
4. **Channel manifest.** The release carries exactly `<channel>-nightly-mac.yml`, and it references the ZIP that is actually attached.
5. **Tag target.** The release tag resolves to the workflow's `github.sha`, not the default branch.
6. **Cross-channel isolation.** A higher staging release is never offered to a production app.
7. **State isolation.** Launching staging leaves production's and upstream's Application Support, Preferences, Caches, Logs, Saved Application State and ShipIt directories untouched. Check `updaterCacheDirName` in each bundle's `app-update.yml` explicitly — it is the axis that was wrong first time, and nothing in the app's own behaviour reveals a shared cache until two updates collide.
8. **Signed update A → B.** Install signed version A by hand, publish signed version B, let A discover, download and install it through Squirrel, and confirm the relaunch is on B. Verify the **ZIP**, since that — not the DMG — is what auto-update consumes. Capture for both bundles:
   ```sh
   codesign -dv --verbose=4 "/Applications/BK T3 Code.app"
   codesign -dr - "/Applications/BK T3 Code.app"
   codesign --verify --deep --strict --verbose=4 "/Applications/BK T3 Code.app"
   ```
   The **designated requirement** (`codesign -dr -`) must be identical between the installed app and the update — that is the string Squirrel.Mac validates against. `CDHash` will differ; it is a hash of the code and changes every build, so it proves nothing here. The bundle id must also be stable within the channel.
9. **Failure capture.** On a failed update, keep the app log and the ShipIt log (`~/Library/Caches/<bundle-id>.ShipIt/ShipIt_stderr.log`).
10. **Release safety.** `release.yml` did not run, and `npm view t3 dist-tags` is unchanged.
11. **No asset mutation.** No published ZIP or manifest was ever replaced in place.

## Rollout order

1. Land identities, channels, keyless enforcement and safe publishing. ← _this PR_
2. Build both apps **without publishing**; verify identity and state isolation.
3. Create the certificate, add the signing secrets and the protected environment.
4. Install the first signed staging build by hand.
5. Publish two consecutive staging versions and prove A → B through Squirrel.
6. Run the cross-channel negative tests.
7. Use staging with the team for several days.
8. Promote to `bkmain`.
9. Publish the first signed production build for manual installation.
10. Only advertise automatic production updates after production A → B succeeds.

## Troubleshooting

### The app never offers an update

Check, in order:

1. The release exists and is a **prerelease** with the right manifest asset for that channel.
2. The version is strictly newer than the installed one _within the same channel_.
3. The installed app and the update are signed with the **same** certificate. Compare `codesign -dr - "/Applications/BK T3 Code.app"` against the built app and against the release notes; the designated requirements must be identical.

### Blank window, and sign-in fails with `native_api_disabled`

Symptom: the app launches, the Dock icon and About panel are correct, but the window renders nothing, and Clerk returns HTTP 400:

```json
{ "code": "native_api_disabled", "message": "Native API disabled" }
```

**Cause: a Clerk publishable key reached a managed build.** `apps/web/src/main.tsx` mounts `ElectronClerkProvider` whenever a key is present; that provider renders nothing until Clerk's Native API answers, so nothing beneath it renders — one root cause producing both symptoms.

The fix is to remove the key, not to configure Clerk. Managed builds get their identity from the pairing credential; see [Managed builds are keyless](#managed-builds-are-keyless). Both the build script and the workflow now refuse a key outright, so this should be unreachable — if you hit it, something bypassed `scripts/build-bk-desktop-dmg.ts`.

Historical note: the fork originally hit this and treated it as a missing Clerk-instance prerequisite (enable the Native API, allowlist `t3code://app/`). That is the right fix for a build that _should_ use Clerk — upstream documents it in [T3 Connect: Desktop OAuth Redirect Allowlist](../internals/t3-connect.md#desktop-oauth-redirect-allowlist) — but it is the wrong fix here. A managed BK build should have no provider mounted at all.

## Icons

`assets/bk/` is generated from upstream's production artwork by recolouring the tile, so the fork icon tracks any upstream refresh:

```sh
pnpm icons:bk         # regenerate
pnpm icons:bk:check   # verify the committed output matches
```

Replace `BK_ICON_BASE_COLOR` in `scripts/lib/bk-brand-icons.ts` to change the colour, or drop a real 1024×1024 icon at `assets/bk/bk-macos-1024.png` and stop running the generator. Both apps currently share one icon set; give staging its own by adding a variant to `BK_BRAND_ASSET_PATHS`.

## Rollout

Per [AGENTS.md](../../AGENTS.md), changes ship to `expbkmain` and are verified at expbkt3.dev.beknown.live before merging to `bkmain`. Merging to `bkmain` restarts `t3-bkmain.service` and kills the agent sessions running on it.

## Files

| Path                                                | Role                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `scripts/lib/bk-desktop-brand.ts`                   | The two brand identities — bundle id, name, icons, data dir, updater channel |
| `scripts/lib/bk-desktop-release.ts`                 | Version format, per-channel ordering, tag-safety rules                       |
| `scripts/lib/bk-desktop-signing.ts`                 | Self-signed identity resolution                                              |
| `scripts/lib/bk-managed-environment.ts`             | Which central server a build orchestrates                                    |
| `scripts/lib/bk-brand-icons.ts`                     | Icon tint and downscale helpers                                              |
| `scripts/build-bk-desktop-dmg.ts`                   | Build wrapper (`pnpm dist:desktop:bk`)                                       |
| `scripts/publish-bk-desktop-dmg.ts`                 | Publish wrapper (`pnpm publish:desktop:bk`)                                  |
| `scripts/resolve-bk-desktop-version.ts`             | Next version for a channel (`pnpm version:desktop:bk`)                       |
| `scripts/generate-bk-brand-icons.ts`                | Icon generator (`pnpm icons:bk`)                                             |
| `.github/workflows/bk-desktop-release.yml`          | GitHub-hosted macOS build and publish                                        |
| `apps/desktop/src/branding/BkBrand.ts`              | Runtime brand, baked in at build time                                        |
| `apps/desktop/src/electron/ElectronNotification.ts` | Native notifications                                                         |
| `apps/desktop/src/updates/DesktopUpdates.ts`        | Channel selection, auto-download, update-ready notification                  |

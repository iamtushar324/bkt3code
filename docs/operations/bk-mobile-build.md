# BK mobile build and sideload

The fork ships its own mobile app. It is the same React Native codebase as
upstream's, built with a different identity and distributed by sideload rather
than through the App Store or Play Store — this fork has no Expo/EAS account,
no Apple Developer team and no store listings.

|                             |                                                           |
| --------------------------- | --------------------------------------------------------- |
| App name                    | **BK T3 Code**                                            |
| Bundle id / package         | `work.beknown.bkt3code.mobile`                            |
| URL scheme                  | `t3code-bk://`                                            |
| Version reported to servers | `<MOBILE_APP_VERSION>+bk.<sha7>`                          |
| Android                     | release APK, signed with the fork keystore, sideloaded    |
| iOS                         | **unsigned** `.ipa`, re-signed on device by SideStore     |
| Expo OTA updates            | **disabled**                                              |
| iOS binary updates          | SideStore AltSource; every update is re-signed/sideloaded |

Identity lives in `apps/mobile/app.config.bk.ts`, which rewrites the finished
upstream Expo config when `T3CODE_BK_MOBILE=1`. `apps/mobile/app.config.ts`
carries a two-line seam and nothing else, so upstream merges have nothing to
reconcile here.

## Read this before installing anything

**Install the build whose SHA matches the running server.** T3 has no
client/server protocol handshake. When the server emits an orchestration event
type a client does not know, the client's subscription fails schema decoding —
and because the RPC layer raises that as an Effect _defect_ rather than a typed
failure, it does not retry. The app keeps saying "connected" while silently
receiving no further updates.

So: a deploy that changes `@t3tools/contracts` — above all
`OrchestrationEvent`, `OrchestrationShellStreamItem` or
`OrchestrationThreadStreamItem` — requires re-sideloading the mobile app from
that same commit. The workflow builds an artifact for **every** push to
`expbkmain` and `bkmain` precisely so a matching build always exists.

To check what a device is running, look at the `client_version` the server
recorded at token exchange: it reads `1.0.4+bk.a1b2c3d`, and `a1b2c3d` is the
commit the binary was built from.

## Getting a build

Releases are published by `.github/workflows/mobile-bk-release.yml` on every
push to `expbkmain` or `bkmain`, as a GitHub **prerelease** tagged
`bk-mobile-v<version>-<sha7>` with the `.apk` and `.ipa` attached. Re-running a
green workflow republishes nothing (the guard job skips an already-released
SHA).

Both platforms build on GitHub-hosted runners. Nothing is built on the shared
dev server, and nothing needs to be.

### Android

1. Open the release page **on the phone** and download the `.apk`.
2. Install it. Android will ask once for permission to install from that
   browser.
3. Later releases install straight over it — the fork keystore keeps the signing
   identity stable, so it is an upgrade, not a conflicting app.

### iOS, via SideStore

1. Download the `.ipa` from the release page on your Mac.
2. Open it with SideStore, which re-signs it using your free Apple ID.
3. Refresh it within 7 days, which is how long a free-team signature lasts.

For later builds, add the branch's update source to SideStore once:

| Channel     | SideStore source URL                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `expbkmain` | `https://github.com/beknown-work/bkt3code/releases/download/bk-mobile-source-expbkmain/bk-mobile-expbkmain.json` |
| `bkmain`    | `https://github.com/beknown-work/bkt3code/releases/download/bk-mobile-source-bkmain/bk-mobile-bkmain.json`       |

In SideStore, open **Browse → Sources → +**, paste the URL, and add the source.
The current BK T3 Code build then appears in that source, and future builds show
an **Update** button. Keep LocalDevVPN enabled while installing, updating, or
refreshing.

This is a binary update, not an Expo OTA: SideStore downloads the new IPA,
re-signs it with the same Apple Account and installs it over the existing app.
iOS does not allow BK T3 Code to replace its own executable, so the final update
action must remain in SideStore. App data is preserved because the re-signed
bundle identity stays stable.

The workflow publishes the JSON at a stable rolling-release URL only after the
matching immutable IPA release exists. Each CI IPA receives `github.run_number`
as its `CFBundleVersion`, allowing SideStore to detect a newer build even while
`MOBILE_APP_VERSION` remains unchanged.

Free Apple IDs cannot sign App Groups, extension targets, push notifications,
Associated Domains or Sign in with Apple. BK iOS builds therefore reuse
upstream's `T3CODE_IOS_PERSONAL_TEAM=1` path, which strips exactly those, and
**give up**:

- Live Activities and the home-screen widget
- the system share-sheet target
- push notifications (agent activity arrives over the live connection instead)

SideStore also limits a free Apple ID to three sideloaded apps at a time.

## Pairing

Unchanged from upstream, and no fork code was needed for it:

1. On the server — e.g. <https://bkt3.dev.beknown.live> — open
   **Settings → Connections** and create a pairing credential. It renders a QR
   code.
2. In the app: **Settings → Environments → New**, then scan the QR code. Manual
   host + code entry works too.

Pairing tokens are single-use and short-lived; mint a fresh one per device.

The pairing QR encodes a plain `https://host#token=…` URL, which the app's
scanner accepts in release builds. (Only _deep-link_ prefill —
`t3code-bk://connections/new?pairingUrl=…` — is restricted to dev builds, which
is why the dev-only helper script in the `test-t3-mobile` skill cannot be used
against a sideloaded release build.)

Identity comes from the pairing credential itself: when the grant names an
operator, the server attributes the device to that user. BK mobile carries no
Clerk key and never signs in — a Clerk publishable key in a BK build is a build
failure, enforced in both `scripts/build-bk-mobile.ts` and the workflow.

## The Android keystore

One-time setup. **Not on the shared dev server, and never committed.**

```bash
keytool -genkeypair -v -keystore bk-mobile-release.keystore -alias bk-t3code \
  -keyalg RSA -keysize 2048 -validity 10000
```

Keep `bk-mobile-release.keystore` in a password manager, then add four
repository secrets:

| Secret                         | Value                                   |
| ------------------------------ | --------------------------------------- |
| `BK_ANDROID_KEYSTORE_BASE64`   | `base64 -w0 bk-mobile-release.keystore` |
| `BK_ANDROID_KEYSTORE_PASSWORD` | the store password                      |
| `BK_ANDROID_KEY_ALIAS`         | `bk-t3code`                             |
| `BK_ANDROID_KEY_PASSWORD`      | the key password                        |

**Losing the keystore means every installed device has to uninstall before it
can take another update.** Android identifies an app by package name _and_
signature; there is no recovery path for a sideloaded app.

Until the secrets exist, the workflow still builds an APK — Expo's template
falls back to its shared debug key — but it warns loudly, and such a build must
not be handed to anyone: everyone's debug key is the same key, and it cannot
upgrade a properly signed build in place.

The keystore is decoded into `RUNNER_TEMP` and read through `System.getenv` by
the generated Gradle project (`apps/mobile/plugins/withBkAndroidReleaseSigning.cjs`),
so no password is ever written to disk.

## Building locally

CI is the supported path. If you need a local build:

```bash
# Android — needs a JDK 17 and the Android SDK.
node scripts/build-bk-mobile.ts --platform android

# iOS — macOS with Xcode only.
node scripts/build-bk-mobile.ts --platform ios
```

Also available as `vp run dist:mobile:bk -- --platform android` from the repo
root, or `android:bk` / `ios:bk` inside `apps/mobile`. Artifacts land in
`release/mobile/`.

Do not run either on the shared dev server: `expo prebuild` plus a Gradle
release build is exactly the kind of load that has OOM-crashed that box.

To inspect the resolved config without building anything:

```bash
cd apps/mobile
T3CODE_BK_MOBILE=1 T3CODE_IOS_PERSONAL_TEAM=1 \
  T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=work.beknown.bkt3code.mobile \
  APP_VARIANT=production vp exec expo config --type public
```

## Version bumps

`apps/mobile/app-version.ts` holds `MOBILE_APP_VERSION`. The fork never bumps
it: it tracks upstream's mobile version, so an upstream merge never conflicts on
it. It is the release tag and the base of the `client_version` the app reports
(`1.0.4+bk.<sha>`).

The **native marketing version** of a BK build is that base plus the workflow
run number as a fourth component — `1.0.4.12`, then `1.0.4.13` — set by
`bkMarketingVersion` in `app.config.bk.ts` and mirrored into the SideStore
source. SideStore decides "update available" on the marketing version and not
every release falls back to the build number when two builds share one, so a
version that grows with every run is what makes each build show as an update
without anyone bumping anything by hand. The Android `versionCode` and the iOS
`CFBundleVersion` are that same run number.

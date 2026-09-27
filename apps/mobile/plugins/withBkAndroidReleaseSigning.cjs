// T3-CUSTOM(expbkt3): Sign the fork's Android release APK with the BK keystore.
//
// Expo's bare template signs the `release` build type with the bundled DEBUG
// keystore. That produces an installable APK, but every machine generates the
// same well-known key, so a release built on CI and one built on a laptop are
// signed by different-but-equally-forgeable identities and Android refuses to
// upgrade one with the other. BK mobile is sideloaded and upgraded in place, so
// it needs one stable key.
//
// The keystore never touches the repository. CI decodes it from a secret into
// RUNNER_TEMP and exports the four BK_ANDROID_* variables; the generated
// build.gradle reads them through System.getenv so no password is ever written
// to disk. With BK_ANDROID_KEYSTORE_PATH unset the plugin leaves the template
// untouched, which keeps unsigned local smoke builds working.
//
// See docs/operations/bk-mobile-build.md.
const { withAppBuildGradle } = require("expo/config-plugins");

const SIGNING_CONFIG_NAME = "bkRelease";

const SIGNING_CONFIG_BLOCK = `        ${SIGNING_CONFIG_NAME} {
            // Injected by plugins/withBkAndroidReleaseSigning.cjs. Values come
            // from the environment so the keystore password is never written
            // into the generated project.
            storeFile file(System.getenv("BK_ANDROID_KEYSTORE_PATH"))
            storePassword System.getenv("BK_ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("BK_ANDROID_KEY_ALIAS")
            keyPassword System.getenv("BK_ANDROID_KEY_PASSWORD")
        }
`;

module.exports = function withBkAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    if (!process.env.BK_ANDROID_KEYSTORE_PATH) return nextConfig;
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error(
        "withBkAndroidReleaseSigning only understands the Groovy build.gradle Expo generates.",
      );
    }

    nextConfig.modResults.contents = applyBkSigning(nextConfig.modResults.contents);
    return nextConfig;
  });
};

/**
 * Exported for the unit test: the two anchors below come from Expo's template
 * and are exactly the kind of thing a template bump moves. Failing loudly here
 * is the point — a silent miss ships a debug-signed release APK that can never
 * be upgraded in place.
 */
function applyBkSigning(contents) {
  const signingConfigsAnchor = /(\n\s*signingConfigs\s*\{\n)/;
  if (!signingConfigsAnchor.test(contents)) {
    throw new Error("Could not find the `signingConfigs {` block in android/app/build.gradle.");
  }
  let next = contents.replace(signingConfigsAnchor, `$1${SIGNING_CONFIG_BLOCK}`);

  // Scoped to the release block: the debug block legitimately keeps
  // `signingConfigs.debug`, and a global replace would rewrite it too.
  const releaseBlock = /(\n\s*release\s*\{\n)([\s\S]*?)(\n\s*\})/;
  const match = releaseBlock.exec(next);
  if (match === null) {
    throw new Error("Could not find the `release {` build type in android/app/build.gradle.");
  }
  const body = match[2];
  if (!body.includes("signingConfig ")) {
    throw new Error("The `release {` build type has no signingConfig line to repoint.");
  }
  const signedBody = body.replace(
    /signingConfig\s+signingConfigs\.\w+/,
    `signingConfig signingConfigs.${SIGNING_CONFIG_NAME}`,
  );
  next = next.replace(releaseBlock, `$1${signedBody}$3`);

  if (!next.includes(`signingConfig signingConfigs.${SIGNING_CONFIG_NAME}`)) {
    throw new Error("Failed to repoint the release build type at the BK signing config.");
  }
  return next;
}

module.exports.applyBkSigning = applyBkSigning;
module.exports.BK_SIGNING_CONFIG_NAME = SIGNING_CONFIG_NAME;

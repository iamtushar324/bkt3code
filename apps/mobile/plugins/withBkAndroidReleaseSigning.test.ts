import { describe, expect, it } from "vite-plus/test";

const { applyBkSigning } = require("./withBkAndroidReleaseSigning.cjs") as {
  applyBkSigning: (contents: string) => string;
};

// The shape Expo's bare template generates. Both anchors this plugin depends on
// are template-owned, so this fixture is the early warning that a template bump
// moved one of them.
const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            shrinkResources (findProperty('android.enableShrinkResourcesInReleaseBuilds')?.toBoolean() ?: false)
            minifyEnabled enableProguardInReleaseBuilds
        }
    }
}`;

describe("withBkAndroidReleaseSigning", () => {
  it("points the release build type at the BK keystore", () => {
    const result = applyBkSigning(TEMPLATE);

    expect(result).toContain("signingConfig signingConfigs.bkRelease");
    expect(result).toContain('storeFile file(System.getenv("BK_ANDROID_KEYSTORE_PATH"))');

    // The BK password must never be materialised into the generated project.
    // (The template's own debug key keeps its literal 'android' password.)
    const bkBlock = result.slice(result.indexOf("bkRelease {"), result.indexOf("debug {"));
    expect(bkBlock).toContain('storePassword System.getenv("BK_ANDROID_KEYSTORE_PASSWORD")');
    expect(bkBlock).not.toMatch(/storePassword\s+'/);
    expect(bkBlock).toContain('keyAlias System.getenv("BK_ANDROID_KEY_ALIAS")');
    expect(bkBlock).toContain('keyPassword System.getenv("BK_ANDROID_KEY_PASSWORD")');
  });

  it("leaves the debug build type signing with the debug key", () => {
    const result = applyBkSigning(TEMPLATE);
    const debugBlock = result.slice(result.indexOf("debug {", result.indexOf("buildTypes")));
    expect(debugBlock).toContain("signingConfig signingConfigs.debug");
  });

  it("preserves the rest of the release block", () => {
    const result = applyBkSigning(TEMPLATE);
    expect(result).toContain("minifyEnabled enableProguardInReleaseBuilds");
    expect(result).toContain("shrinkResources (findProperty(");
  });

  it("fails loudly when the template anchors move", () => {
    // Silently missing here would ship a debug-signed release APK that can
    // never upgrade a properly signed one in place.
    expect(() => applyBkSigning("android {\n  buildTypes {\n  }\n}")).toThrow(/signingConfigs/);
    expect(() => applyBkSigning("android {\n    signingConfigs {\n    }\n}")).toThrow(/release/);
  });
});

// T3-CUSTOM(expbkt3): The Expo-manifest half of the fork build identity.
//
// Split from bkBuildIdentity.ts so the version-formatting logic stays testable
// without pulling react-native into the unit test environment.
//
// The import is static, like every other expo-constants consumer in the app.
// An earlier version made it a fail-soft `require` to keep expo-modules-core off
// the import graph of tests reaching `authClientMetadata` — that silently
// swallowed the real read too, so builds reported a bare `1.0.4` with no
// `+bk.<sha>` suffix and the version-skew check the fork depends on was blind.
// Tests mock this module instead, which is what the rest of the suite does.
import Constants from "expo-constants";

import { readBkGitSha } from "./bkBuildIdentity";

export function bkBuildGitSha(): string | null {
  return readBkGitSha(Constants.expoConfig?.extra);
}

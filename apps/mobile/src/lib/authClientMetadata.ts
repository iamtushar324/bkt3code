import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import * as Device from "expo-device";
import { Platform } from "react-native";
// T3-CUSTOM(expbkt3): BEGIN - attach a test-safe native build identity.
import { MOBILE_APP_VERSION } from "../../app-version";
import { bkAppVersion } from "./bkBuildIdentity";
import { bkBuildGitSha } from "./bkBuildManifest";
// T3-CUSTOM(expbkt3): END

export function authClientMetadata(appVersion?: string): AuthClientPresentationMetadata {
  const osMajorVersion = Number.parseInt(Device.osVersion?.split(".")[0] ?? "", 10);
  const deviceModel = Device.modelName?.trim();

  return {
    label: "T3 Code Mobile",
    deviceType:
      Device.deviceType === Device.DeviceType.TABLET
        ? "tablet"
        : Device.deviceType === Device.DeviceType.PHONE
          ? "mobile"
          : "unknown",
    // T3-CUSTOM(expbkt3): always expose the native version to connected servers;
    // a caller-provided version still wins. Fork builds append their source SHA
    // so a stale sideloaded binary is identifiable from the server's audit of
    // `client_version` (see bkBuildIdentity.ts).
    appVersion: appVersion ?? bkAppVersion(MOBILE_APP_VERSION, bkBuildGitSha()),
    ...(Platform.OS === "ios" ? { os: "iOS" } : Platform.OS === "android" ? { os: "Android" } : {}),
    ...(Number.isFinite(osMajorVersion) && osMajorVersion > 0 ? { osMajorVersion } : {}),
    ...(deviceModel ? { deviceModel } : {}),
    surface: "mobile",
  };
}

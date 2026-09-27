import * as Option from "effect/Option";

import type { BkRuntimeBrand } from "./BkBrand.ts";

/**
 * Keep a managed staging build's desktop state together with its Electron app
 * data. Production deliberately retains the historic T3 home. Explicit homes
 * and development retain upstream semantics.
 */
export function resolveBkDesktopBaseDir(input: {
  readonly appDataDirectory: string;
  readonly defaultBaseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: (first: string, ...segments: string[]) => string;
  readonly runtimeBrand: BkRuntimeBrand | undefined;
  readonly configuredT3Home: Option.Option<string>;
}): string {
  if (
    input.isDevelopment ||
    Option.isSome(input.configuredT3Home) ||
    input.runtimeBrand?.variant !== "staging"
  ) {
    return input.defaultBaseDir;
  }

  return input.joinPath(input.appDataDirectory, input.runtimeBrand.userDataDirName);
}

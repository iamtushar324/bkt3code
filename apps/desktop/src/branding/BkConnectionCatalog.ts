import { type BkRuntimeBrand, resolveRuntimeBrand } from "./BkBrand.ts";

type ConnectionCatalogBrand = Pick<BkRuntimeBrand, "userDataDirName">;

export interface ResolveDesktopConnectionCatalogPathInput {
  readonly stateDir: string;
  readonly appDataDirectory: string;
  readonly joinPath: (...parts: ReadonlyArray<string>) => string;
}

/** Keeps each packaged BK client's encrypted catalog beside its isolated Electron state. */
export function resolveDesktopConnectionCatalogPath(
  input: ResolveDesktopConnectionCatalogPathInput,
  brand: ConnectionCatalogBrand | undefined = resolveRuntimeBrand(),
): string {
  const directory = brand
    ? input.joinPath(input.appDataDirectory, brand.userDataDirName)
    : input.stateDir;
  return input.joinPath(directory, "connection-catalog.json");
}

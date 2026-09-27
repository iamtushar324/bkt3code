#!/usr/bin/env node

/**
 * Generates the fork's desktop icon set into `assets/bk/` from upstream's
 * production artwork.
 *
 * Run this when upstream refreshes its icons, or when the fork colour changes:
 *
 *   node scripts/generate-bk-brand-icons.ts
 *   node scripts/generate-bk-brand-icons.ts --check   # verify committed output
 *
 * Outputs are committed, so building the DMG on a Mac needs no image tooling —
 * `build-desktop-artifact.ts` converts the PNG to `.icns` with sips/iconutil.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { PNG } from "pngjs";

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { BK_BRAND_ASSET_PATHS } from "./lib/bk-desktop-brand.ts";
import { downscale, tintToBkBrand, type RgbaImage } from "./lib/bk-brand-icons.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

export class StaleBkBrandIconsError extends Schema.TaggedError<StaleBkBrandIconsError>()(
  "StaleBkBrandIconsError",
  {
    stalePaths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return (
      `Fork brand icons are out of date: ${this.stalePaths.join(", ")}. ` +
      `Run \`node scripts/generate-bk-brand-icons.ts\` and commit the result.`
    );
  }
}

interface GeneratedIcon {
  readonly relativePath: string;
  readonly contents: Buffer;
}

function decodePng(contents: Buffer): RgbaImage {
  const png = PNG.sync.read(contents);
  return { width: png.width, height: png.height, data: png.data };
}

function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return PNG.sync.write(png);
}

const readSource = Effect.fn("readSource")(function* (relativePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const contents = yield* fs.readFile(path.join(repoRoot, relativePath));
  return decodePng(Buffer.from(contents));
});

const generateIcons = Effect.fn("generateIcons")(function* () {
  const macSource = yield* readSource(BRAND_ASSET_PATHS.productionMacIconPng);
  const universalSource = yield* readSource(BRAND_ASSET_PATHS.productionLinuxIconPng);

  const macTinted = tintToBkBrand(macSource);
  const universalTinted = tintToBkBrand(universalSource);

  // The ICO renditions come from the universal artwork, matching how upstream
  // derives its Windows icon.
  const icoRenditions = WINDOWS_ICON_SIZES.map((size) => ({
    size,
    contents: encodePng(
      size === universalTinted.width ? universalTinted : downscale(universalTinted, size),
    ),
  }));

  return [
    { relativePath: BK_BRAND_ASSET_PATHS.macIconPng, contents: encodePng(macTinted) },
    { relativePath: BK_BRAND_ASSET_PATHS.universalIconPng, contents: encodePng(universalTinted) },
    { relativePath: BK_BRAND_ASSET_PATHS.windowsIconIco, contents: encodePngIco(icoRenditions) },
  ] satisfies ReadonlyArray<GeneratedIcon>;
});

const writeIcons = Effect.fn("writeIcons")(function* (icons: ReadonlyArray<GeneratedIcon>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;

  for (const icon of icons) {
    const target = path.join(repoRoot, icon.relativePath);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFile(target, icon.contents);
    yield* Console.log(`wrote ${icon.relativePath} (${icon.contents.length} bytes)`);
  }
});

const checkIcons = Effect.fn("checkIcons")(function* (icons: ReadonlyArray<GeneratedIcon>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;

  const stale: string[] = [];
  for (const icon of icons) {
    const target = path.join(repoRoot, icon.relativePath);
    const existing = yield* fs.readFile(target).pipe(Effect.option);
    if (existing._tag === "None" || !Buffer.from(existing.value).equals(icon.contents)) {
      stale.push(icon.relativePath);
    }
  }

  if (stale.length > 0) {
    return yield* new StaleBkBrandIconsError({ stalePaths: stale });
  }

  yield* Console.log(`Fork brand icons are up to date (${icons.length} files).`);
});

const command = Command.make(
  "generate-bk-brand-icons",
  {
    check: Flag.boolean("check").pipe(
      Flag.withDescription("Verify the committed icons match this generator instead of writing."),
      Flag.withDefault(false),
    ),
  },
  ({ check }) =>
    Effect.gen(function* () {
      const icons = yield* generateIcons();
      if (check) {
        yield* checkIcons(icons);
        return;
      }
      yield* writeIcons(icons);
    }),
).pipe(Command.withDescription("Derive the Beknown desktop icon set from upstream artwork."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}

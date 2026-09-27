/**
 * Fork-owned image helpers that derive the Beknown desktop icon from upstream's.
 *
 * There is no Beknown app icon in `assets/`, and the fork build needs one that is
 * distinguishable from upstream's in the Dock. These helpers recolour upstream's
 * black icon tile to a fork colour while leaving the light logo mark readable, so
 * the fork icon tracks any upstream artwork refresh for free.
 *
 * Pure functions over RGBA buffers, kept separate from the CLI in
 * `../generate-bk-brand-icons.ts` so they can be unit-tested without file IO.
 * Deliberately dependency-free beyond `pngjs`, which `@t3tools/scripts` already
 * depends on — no ImageMagick, so the icons regenerate on any platform.
 */

/** Dark end of the fork ramp: the colour a fully black source pixel becomes. */
export const BK_ICON_BASE_COLOR = { r: 13, g: 42, b: 92 } as const;

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, 8 bits per channel, row-major — the pngjs `data` layout. */
  readonly data: Buffer;
}

function clampChannel(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return Math.round(value);
}

/**
 * Recolours a source image along a ramp from {@link BK_ICON_BASE_COLOR} (where
 * the source is black) to white (where the source is white).
 *
 * Alpha is copied untouched, which is what preserves the icon's rounded-square
 * silhouette — upstream's tile is transparent outside the rounded rect, and macOS
 * relies on that shape.
 */
export function tintToBkBrand(
  image: RgbaImage,
  baseColor: { readonly r: number; readonly g: number; readonly b: number } = BK_ICON_BASE_COLOR,
): RgbaImage {
  const data = Buffer.alloc(image.data.length);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const alpha = image.data[offset + 3] ?? 0;
    if (alpha === 0) {
      // Leave fully transparent pixels at zero so no colour fringes appear when
      // the icon is downscaled for the Dock or an ICO rendition.
      data[offset + 3] = 0;
      continue;
    }

    const r = image.data[offset] ?? 0;
    const g = image.data[offset + 1] ?? 0;
    const b = image.data[offset + 2] ?? 0;
    // Rec. 601 luma, matching what the eye reads as "how light is this pixel".
    const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    data[offset] = clampChannel(baseColor.r + luma * (255 - baseColor.r));
    data[offset + 1] = clampChannel(baseColor.g + luma * (255 - baseColor.g));
    data[offset + 2] = clampChannel(baseColor.b + luma * (255 - baseColor.b));
    data[offset + 3] = alpha;
  }

  return { width: image.width, height: image.height, data };
}

/**
 * Box-filter downscale, averaging in premultiplied alpha.
 *
 * Averaging straight RGBA would pull the colour of fully transparent pixels into
 * edge pixels and halo the icon; premultiplying first is what keeps the rounded
 * edges clean at 16x16.
 */
export function downscale(image: RgbaImage, size: number): RgbaImage {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`Downscale size must be a positive integer, got ${size}.`);
  }
  if (size > image.width || size > image.height) {
    throw new Error(
      `Refusing to upscale ${image.width}x${image.height} to ${size}x${size}; supply a larger source.`,
    );
  }

  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sourceTop = Math.floor((y * image.height) / size);
    const sourceBottom = Math.max(sourceTop + 1, Math.floor(((y + 1) * image.height) / size));
    for (let x = 0; x < size; x += 1) {
      const sourceLeft = Math.floor((x * image.width) / size);
      const sourceRight = Math.max(sourceLeft + 1, Math.floor(((x + 1) * image.width) / size));

      let totalR = 0;
      let totalG = 0;
      let totalB = 0;
      let totalA = 0;
      let samples = 0;
      for (let sourceY = sourceTop; sourceY < sourceBottom; sourceY += 1) {
        for (let sourceX = sourceLeft; sourceX < sourceRight; sourceX += 1) {
          const offset = (sourceY * image.width + sourceX) * 4;
          const alpha = image.data[offset + 3] ?? 0;
          const weight = alpha / 255;
          totalR += (image.data[offset] ?? 0) * weight;
          totalG += (image.data[offset + 1] ?? 0) * weight;
          totalB += (image.data[offset + 2] ?? 0) * weight;
          totalA += alpha;
          samples += 1;
        }
      }

      const targetOffset = (y * size + x) * 4;
      if (samples === 0 || totalA === 0) {
        data[targetOffset + 3] = 0;
        continue;
      }

      const averageAlpha = totalA / samples;
      // Un-premultiply back to straight alpha for storage.
      const alphaWeight = totalA / 255;
      data[targetOffset] = clampChannel(totalR / alphaWeight);
      data[targetOffset + 1] = clampChannel(totalG / alphaWeight);
      data[targetOffset + 2] = clampChannel(totalB / alphaWeight);
      data[targetOffset + 3] = clampChannel(averageAlpha);
    }
  }

  return { width: size, height: size, data };
}

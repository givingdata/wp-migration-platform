// Responsive image URLs from config/design-specs.json.
import specs from "../../../config/design-specs.json";

export type ImageType = keyof typeof specs.contentTypes | "page";

export const BREAKPOINTS: number[] = specs.breakpoints;

export function ratioFor(type: string): number {
  const spec = (specs.contentTypes as Record<string, { aspectRatio: string }>)[type];
  const [w, h] = (spec?.aspectRatio ?? "16:9").split(":").map(Number);
  return w > 0 && h > 0 ? w / h : 16 / 9;
}

export function aspectRatioCss(type: string): string {
  const r = ratioFor(type);
  return `${Math.round(r * 1000) / 1000} / 1`;
}

/**
 * Image resizing mode:
 *  - "cloudflare": /cdn-cgi/image/… URLs. Only works on a custom domain with Image
 *                  Transformations enabled (not on *.pages.dev), so it is opt-in.
 *  - "none":       original URL, cropped with CSS (default)
 * Set PUBLIC_IMAGE_RESIZING=cloudflare at build time to enable.
 */
function resizingMode(): "cloudflare" | "none" {
  return import.meta.env.PUBLIC_IMAGE_RESIZING === "cloudflare" ? "cloudflare" : "none";
}

function cfResize(src: string, width: number, height: number, quality: number): string {
  // Source must be absolute (R2 public URL) or a path on the same zone.
  const opts = `width=${width},height=${height},fit=cover,gravity=auto,format=auto,quality=${quality}`;
  return `/cdn-cgi/image/${opts}/${src.replace(/^\//, "")}`;
}

export interface ImageSet {
  src: string;
  srcset?: string;
  width: number;
  height: number;
}

/**
 * Build src/srcset for an image at the ratio of `type`.
 * Pre-rendered variants from the Worker (imageVariants) are used directly when present.
 */
export function buildImageSet(src: string, type: string, variants?: Record<string, string>): ImageSet {
  const ratio = ratioFor(type);
  const widths = BREAKPOINTS;
  const largest = widths[widths.length - 1];
  const height = (w: number) => Math.round(w / ratio);

  const variantWidths = Object.keys(variants ?? {}).map(Number).filter(Boolean).sort((a, b) => a - b);
  if (variantWidths.length) {
    const top = variantWidths[variantWidths.length - 1];
    return {
      src: variants![String(top)],
      srcset: variantWidths.map((w) => `${variants![String(w)]} ${w}w`).join(", "),
      width: top,
      height: height(top),
    };
  }

  if (resizingMode() === "cloudflare" && !src.endsWith(".svg")) {
    const q = specs.image?.quality ?? 82;
    return {
      src: cfResize(src, largest, height(largest), q),
      srcset: widths.map((w) => `${cfResize(src, w, height(w), q)} ${w}w`).join(", "),
      width: largest,
      height: height(largest),
    };
  }

  return { src, width: largest, height: height(largest) };
}

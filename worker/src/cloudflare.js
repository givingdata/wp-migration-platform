// R2 (media) and KV (submissions) helpers, plus image optimization via the
// Cloudflare Images binding (the Workers interface to Image Resizing).

const EXT_FOR_MIME = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

export function parseRatio(ratio) {
  const [w, h] = String(ratio || "1:1").split(":").map(Number);
  return w > 0 && h > 0 ? w / h : 1;
}

export function publicUrl(env, key) {
  const base = (env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  return base ? `${base}/${key}` : `/${key}`;
}

/** Target widths for a content type: global breakpoints clamped to the type's min/max and the source width. */
export function targetWidths(specs, typeSpec, sourceWidth) {
  const min = typeSpec.minWidth ?? 0;
  const max = Math.min(typeSpec.maxWidth ?? Infinity, sourceWidth || Infinity);
  const widths = specs.breakpoints.filter((w) => w >= min && w <= max);
  // Tiny sources still get one variant at their own width.
  return widths.length ? widths : [Math.max(1, Math.min(sourceWidth || min, max))];
}

/**
 * Store the original upload and resized, cropped WebP variants in R2.
 * Returns { image, images, variants: {width: url}, original, width, height }.
 */
export async function storeImage(env, specs, typeSpec, contentId, file) {
  const bytes = await file.arrayBuffer();
  const ext = EXT_FOR_MIME[file.type] || "bin";
  const prefix = `media/uploads/${contentId}`;
  const originalKey = `${prefix}/original.${ext}`;
  const cacheControl = "public, max-age=31536000, immutable";

  await env.MEDIA.put(originalKey, bytes, { httpMetadata: { contentType: file.type, cacheControl } });

  if (!env.IMAGES) {
    // Local dev without the Images binding: serve the original only.
    const url = publicUrl(env, originalKey);
    return { image: url, images: [url], variants: {}, original: url, width: null, height: null, optimized: false };
  }

  const info = await env.IMAGES.info(new Blob([bytes]).stream());
  const ratio = parseRatio(typeSpec.aspectRatio);
  const quality = specs.image?.quality ?? 82;
  const variants = {};

  for (const width of targetWidths(specs, typeSpec, info.width)) {
    const height = Math.round(width / ratio);
    const result = await env.IMAGES.input(new Blob([bytes]).stream())
      .transform({ width, height, fit: "cover", gravity: typeSpec.crop === "center" ? "center" : "auto" })
      .output({ format: "image/webp", quality });
    const key = `${prefix}/${width}.webp`;
    await env.MEDIA.put(key, result.image(), { httpMetadata: { contentType: "image/webp", cacheControl } });
    variants[width] = publicUrl(env, key);
  }

  const sizes = Object.keys(variants).map(Number).sort((a, b) => a - b);
  return {
    image: variants[sizes[sizes.length - 1]],
    images: sizes.map((w) => variants[w]),
    variants,
    original: publicUrl(env, originalKey),
    width: info.width ?? null,
    height: info.height ?? null,
    optimized: true,
  };
}

// ---- KV --------------------------------------------------------------------

const kvKey = (id) => `content:${id}`;

export async function saveSubmission(env, record) {
  await env.CONTENT.put(kvKey(record.id), JSON.stringify(record), {
    metadata: { type: record.entry?.type, title: record.entry?.title, status: record.status, updatedAt: record.updatedAt },
  });
}

export async function getSubmission(env, id) {
  return env.CONTENT.get(kvKey(id), "json");
}

export async function listSubmissions(env, limit = 50) {
  const { keys } = await env.CONTENT.list({ prefix: "content:", limit });
  return keys.map((k) => ({ id: k.name.slice("content:".length), ...(k.metadata || {}) }));
}

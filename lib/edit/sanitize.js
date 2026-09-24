// Cleaning for text stored through the Edit module.
//
// Migrated WordPress HTML carries galleries, embeds, classes and inline styles that must
// survive an edit, so this is a blocklist of what can run code, not an allowlist of tags.
// It guards against pasted scripts and mistakes by logged-in staff; it is not meant to make
// arbitrary hostile HTML safe.

const DROP_WITH_CONTENT = /<(script|noscript|template|object|embed|applet|frameset|frame|base|meta|link)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DROP_TAG = /<\/?(script|noscript|template|object|embed|applet|frameset|frame|base|meta|link|form)\b[^>]*>/gi;
const EVENT_ATTR = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const URL_ATTR = /(\s(?:href|src|action|formaction|xlink:href|poster|srcset)\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const BAD_SCHEME = /^\s*(javascript|vbscript|data(?!:image\/(png|jpe?g|gif|webp);))\s*:/i;

/** HTML with scripts, event handlers and script URLs removed. */
export function cleanHtml(html) {
  let out = String(html ?? "");
  let prev;
  // Repeat so nested tricks like <scr<script>ipt> don't survive one pass.
  do {
    prev = out;
    out = out.replace(DROP_WITH_CONTENT, "").replace(DROP_TAG, "").replace(EVENT_ATTR, "");
  } while (out !== prev);
  return out.replace(URL_ATTR, (whole, start, _quoted, dq, sq, bare) => {
    const value = (dq ?? sq ?? bare ?? "").replace(/&#x?[0-9a-f]+;?|[\u0000- ]/gi, "");
    return BAD_SCHEME.test(value) ? `${start}"#"` : whole;
  });
}

/** Plain text: tags removed, whitespace tidied (for titles, summaries and short fields). */
export function plainText(text) {
  return String(text ?? "").replace(/<\/?[a-z!][^>]*>/gi, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
}

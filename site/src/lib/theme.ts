// Site look from config/theme.json: a named preset plus per-client overrides.
// The token names here are the contract with designers (docs/DESIGN_HANDOFF.md); rename one
// and every client's theme.json and Figma file has to follow.
import config from "../../../config/theme.json";

export const COLOR_TOKENS = [
  "bg", "surface", "surface-2", "text", "muted", "border", "accent", "accent-hover", "focus",
] as const;
export const OTHER_TOKENS = [
  "font-body", "font-heading", "heading-weight", "text-size", "radius", "wrap", "narrow",
] as const;

type ColorToken = (typeof COLOR_TOKENS)[number];
type OtherToken = (typeof OTHER_TOKENS)[number];
type Colors = Record<ColorToken, string>;
type Tokens = Record<OtherToken, string>;
interface Preset { label: string; colors: Colors; darkColors: Colors; tokens: Tokens }

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
const BASE: Tokens = {
  "font-body": SANS, "font-heading": SERIF, "heading-weight": "600", "text-size": "1.0625rem",
  radius: "10px", wrap: "72rem", narrow: "44rem",
};

export const PRESETS: Record<string, Preset> = {
  classic: {
    label: "Classic: plum accent, serif headings",
    colors: {
      bg: "#fbfaf8", surface: "#ffffff", "surface-2": "#efece7", text: "#1c1b1f", muted: "#5d5a63",
      border: "#dedad3", accent: "#6b2d5c", "accent-hover": "#4f1f44", focus: "#1a5fb4",
    },
    darkColors: {
      bg: "#141316", surface: "#1d1c20", "surface-2": "#2a282e", text: "#f1eff3", muted: "#b3afb9",
      border: "#3a3740", accent: "#e0a9d1", "accent-hover": "#f2c9e6", focus: "#8cb8ff",
    },
    tokens: BASE,
  },
  community: {
    label: "Community: warm terracotta, rounded, friendly sans headings",
    colors: {
      bg: "#fffdf9", surface: "#ffffff", "surface-2": "#f5efe6", text: "#1f1d1a", muted: "#5c564d",
      border: "#e6ded2", accent: "#a63f1c", "accent-hover": "#7f2f14", focus: "#1a5fb4",
    },
    darkColors: {
      bg: "#171513", surface: "#211e1b", "surface-2": "#2d2925", text: "#f5f1ea", muted: "#bdb4a8",
      border: "#3d3832", accent: "#f4a27f", "accent-hover": "#f8c2a8", focus: "#8cb8ff",
    },
    tokens: { ...BASE, "font-heading": SANS, "heading-weight": "700", radius: "16px" },
  },
  editorial: {
    label: "Editorial: black and white, crimson accent, square corners",
    colors: {
      bg: "#ffffff", surface: "#ffffff", "surface-2": "#f2f2f0", text: "#111111", muted: "#555555",
      border: "#d9d9d6", accent: "#a3162b", "accent-hover": "#7d1020", focus: "#1a5fb4",
    },
    darkColors: {
      bg: "#0f0f10", surface: "#18181a", "surface-2": "#242427", text: "#f2f2f2", muted: "#a9a9ad",
      border: "#333336", accent: "#ff8a95", "accent-hover": "#ffb3ba", focus: "#8cb8ff",
    },
    tokens: { ...BASE, "heading-weight": "700", radius: "0px", narrow: "40rem" },
  },
  modern: {
    label: "Modern: indigo accent, bold sans headings",
    colors: {
      bg: "#f7f8fb", surface: "#ffffff", "surface-2": "#eceff5", text: "#0f172a", muted: "#475569",
      border: "#dbe1ea", accent: "#3730a3", "accent-hover": "#272178", focus: "#0e7490",
    },
    darkColors: {
      bg: "#0b1020", surface: "#121a2e", "surface-2": "#1b2540", text: "#eef2ff", muted: "#a5b0c8",
      border: "#2a3552", accent: "#a5b4fc", "accent-hover": "#c7d2fe", focus: "#67e8f9",
    },
    tokens: { ...BASE, "font-heading": SANS, "heading-weight": "800", radius: "12px" },
  },
  minimal: {
    label: "Minimal: greyscale, small corners",
    colors: {
      bg: "#ffffff", surface: "#ffffff", "surface-2": "#f4f4f4", text: "#171717", muted: "#595959",
      border: "#e5e5e5", accent: "#171717", "accent-hover": "#404040", focus: "#1a5fb4",
    },
    darkColors: {
      bg: "#0a0a0a", surface: "#141414", "surface-2": "#1f1f1f", text: "#fafafa", muted: "#a3a3a3",
      border: "#2e2e2e", accent: "#fafafa", "accent-hover": "#d4d4d4", focus: "#8cb8ff",
    },
    tokens: { ...BASE, "font-heading": SANS, radius: "4px" },
  },
};

interface ThemeConfig {
  preset?: string;
  colors?: Record<string, string>;
  darkColors?: Record<string, string>;
  darkMode?: boolean;
  tokens?: Record<string, string>;
  googleFonts?: string[];
  logo?: { src: string; darkSrc?: string; height?: number; showName?: boolean } | null;
}

function fail(msg: string): never {
  throw new Error(`config/theme.json: ${msg}`);
}

// Values go straight into a <style> block, so refuse anything that could end the declaration.
function checkValues(group: string, values: Record<string, string>, allowed: readonly string[]) {
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.includes(key)) fail(`unknown ${group} "${key}" (allowed: ${allowed.join(", ")})`);
    if (typeof value !== "string" || !value.trim() || /[;{}<>]/.test(value)) fail(`bad value for ${group}.${key}: ${JSON.stringify(value)}`);
  }
}

function resolve(cfg: ThemeConfig) {
  const presetName = cfg.preset ?? "classic";
  const preset = PRESETS[presetName] ?? fail(`unknown preset "${presetName}" (choose ${Object.keys(PRESETS).join(", ")})`);
  const colors = cfg.colors ?? {};
  const darkColors = cfg.darkColors ?? {};
  const tokens = cfg.tokens ?? {};
  checkValues("colors", colors, COLOR_TOKENS);
  checkValues("darkColors", darkColors, COLOR_TOKENS);
  checkValues("tokens", tokens, OTHER_TOKENS);

  const fonts = cfg.googleFonts ?? [];
  for (const f of fonts) {
    if (!/^[A-Za-z0-9 ]+(:[A-Za-z0-9,.;@]+)?$/.test(f)) fail(`bad googleFonts entry ${JSON.stringify(f)} (e.g. "Inter:wght@400;700")`);
  }
  const logo = cfg.logo ?? null;
  for (const key of ["src", "darkSrc"] as const) {
    const v = logo?.[key];
    if (logo && (key === "src" || v !== undefined) && (typeof v !== "string" || !v || /["<>,\s]/.test(v))) fail(`logo.${key} must be a URL or /path`);
  }

  return {
    presetName,
    colors: { ...preset.colors, ...colors } as Colors,
    darkColors: { ...preset.darkColors, ...darkColors } as Colors,
    darkMode: cfg.darkMode !== false,
    tokens: { ...preset.tokens, ...tokens } as Tokens,
    overriddenLight: Object.keys(colors).filter((k) => !(k in darkColors)),
    fonts,
    logo,
  };
}

export const THEME = resolve(config as ThemeConfig);

const decls = (values: Record<string, string>) =>
  Object.entries(values).map(([k, v]) => `--${k}: ${v};`).join(" ");

/** The :root custom properties that global.css is written against. */
export function themeCss(t = THEME): string {
  const light = `:root { ${decls(t.colors)} ${decls(t.tokens)} }`;
  if (!t.darkMode) return light;
  const dark = decls(t.darkColors);
  return `${light}\n@media (prefers-color-scheme: dark) { :root { ${dark} } }`;
}

export function googleFontsHref(t = THEME): string | null {
  if (!t.fonts.length) return null;
  const families = t.fonts.map((f) => `family=${f.replace(/ /g, "+")}`).join("&");
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

// WCAG contrast, for build-time warnings. Only plain #rgb / #rrggbb values are checked.
function luminance(hex: string): number | null {
  let h = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, "$&$&");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number | null {
  const la = luminance(a), lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const PAIRS: [ColorToken, ColorToken][] = [
  ["text", "bg"], ["text", "surface"], ["muted", "bg"], ["muted", "surface"],
  ["accent", "bg"], ["accent", "surface"], ["accent-hover", "surface"], ["text", "surface-2"],
];

/** Readability problems worth fixing before launch (text below WCAG AA 4.5:1). */
export function themeWarnings(t = THEME): string[] {
  const out: string[] = [];
  const modes: [string, Colors][] = [["light", t.colors]];
  if (t.darkMode) modes.push(["dark", t.darkColors]);
  for (const [mode, c] of modes) {
    for (const [fg, bg] of PAIRS) {
      const ratio = contrast(c[fg], c[bg]);
      if (ratio !== null && ratio < 4.5) out.push(`${mode}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1 (needs 4.5)`);
    }
  }
  if (t.darkMode && t.overriddenLight.length) {
    out.push(`colors overrides ${t.overriddenLight.join(", ")} without matching darkColors; dark mode keeps the "${t.presetName}" preset's values`);
  }
  return out;
}

let warned = false;
export function warnOnce() {
  if (warned) return;
  warned = true;
  for (const w of themeWarnings()) console.warn(`[theme] ${w}`);
}

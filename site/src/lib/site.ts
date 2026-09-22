// Per-client site settings (override with env vars at build time).
export const SITE = {
  name: import.meta.env.PUBLIC_SITE_NAME ?? "Your Organization",
  tagline: import.meta.env.PUBLIC_SITE_TAGLINE ?? "Welcome to our website.",
  locale: "en_CA",
  lang: "en",
};

// Per-client site settings (override with env vars at build time).
export const SITE = {
  name: import.meta.env.PUBLIC_SITE_NAME ?? "The Cinderella Project",
  tagline: import.meta.env.PUBLIC_SITE_TAGLINE ?? "Helping students celebrate graduation in style.",
  locale: "en_CA",
  lang: "en",
};

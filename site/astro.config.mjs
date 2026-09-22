import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// SITE_URL is the production origin (used for canonical URLs, sitemap, Open Graph).
const site = process.env.SITE_URL || "https://thecinderellaproject.com";

export default defineConfig({
  site,
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory" },
  integrations: [sitemap()],
  vite: {
    // content.json and config/design-specs.json live one level up.
    server: { fs: { allow: [".."] } },
  },
});

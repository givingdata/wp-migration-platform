// Client configuration. Edit per deployment (scripts/deploy.sh can write it for you).
//
// NOTE: everything here is visible to anyone who can load the form. Protect the
// form with Cloudflare Access (or similar) — see form/README.md.
export default {
  siteName: "Your Organization",

  // Worker base URL, no trailing slash. For local testing use the mock:
  //   node form/mock-worker.mjs   →   http://localhost:8787
  workerUrl: "http://localhost:8787",

  // Must match the Worker's API_KEY secret.
  apiKey: "dev-api-key",

  // Optional: only if the Worker has a separate HMAC_SECRET. Defaults to apiKey.
  hmacSecret: null,

  // Fallback design specs if GET <workerUrl>/specs is unreachable.
  // Keep in sync with config/design-specs.json, or leave null to require the Worker.
  designSpecs: null,
};

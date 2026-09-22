// Local stand-in for the Worker: verifies auth exactly like the real one, validates,
// and returns a realistic response without touching R2, Claude, KV or GitHub.
//
//   node form/mock-worker.mjs            # http://localhost:8787, API key "dev-api-key"
//   API_KEY=secret PORT=9000 node form/mock-worker.mjs
//   MOCK_FAIL=commit node form/mock-worker.mjs   # simulate 202 "saved but not published"
import http from "node:http";
import { readFile } from "node:fs/promises";
import { authenticate, AuthError } from "../worker/src/auth.js";

const PORT = Number(process.env.PORT || 8787);
const env = { API_KEY: process.env.API_KEY || "dev-api-key", HMAC_SECRET: process.env.HMAC_SECRET };
const specs = JSON.parse(await readFile(new URL("../config/design-specs.json", import.meta.url), "utf8"));

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Signature, X-Timestamp",
};

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", ...cors });
  res.end(JSON.stringify(body));
}

http
  .createServer(async (req, res) => {
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    if (req.method === "GET" && req.url === "/specs") return send(res, 200, specs);
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, mock: true });
    if (req.method !== "POST" || req.url !== "/submit") return send(res, 404, { success: false, error: "Not found" });

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const body = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const request = new Request(`http://localhost${req.url}`, { method: "POST", headers: req.headers, body });

    try {
      await authenticate(request, body, env);
    } catch (e) {
      console.log(`401 ${e.message}`);
      return send(res, e instanceof AuthError ? e.status : 500, { success: false, error: e.message });
    }

    const form = await request.formData();
    const fields = {};
    const type = form.get("type");
    if (!specs.contentTypes[type]) fields.type = `Must be one of: ${Object.keys(specs.contentTypes).join(", ")}`;
    for (const name of ["title", "description", "date"]) if (!String(form.get(name) || "").trim()) fields[name] = "Required";
    if (Object.keys(fields).length) return send(res, 400, { success: false, error: "Validation failed", fields });

    const image = form.get("image");
    const id = crypto.randomUUID();
    const title = String(form.get("title"));
    const entry = {
      id,
      type,
      title,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      description: String(form.get("description")).slice(0, 200),
      date: form.get("date"),
      image: image && image.size ? `https://media.example.org/media/uploads/${id}/1200.webp` : null,
    };
    console.log(`OK ${type} "${title}"${image && image.size ? ` + image ${image.name} (${image.size} bytes)` : ""}`);

    if (process.env.MOCK_FAIL === "commit") {
      return send(res, 202, { success: true, published: false, contentId: id, url: entry.image, entry, message: "Content saved, but publishing failed." });
    }
    // Simulate Claude + image processing latency.
    await new Promise((r) => setTimeout(r, 800));
    send(res, 201, { success: true, published: true, contentId: id, url: entry.image, slug: entry.slug, entry, message: "Content submitted and scheduled for rebuild" });
  })
  .listen(PORT, () => console.log(`Mock worker on http://localhost:${PORT} (API key "${env.API_KEY}")`));

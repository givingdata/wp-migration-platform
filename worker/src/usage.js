// Claude usage and cost per client: every Claude call this Worker makes is saved as one KV key
// (env.CONTENT, "usage:<YYYY-MM>:<time>-<random>") with its numbers in the key's metadata, so
// concurrent calls never overwrite each other and a month is totalled with list() alone.
// GET /usage (form API key) returns the monthly totals; the dashboard shows them per client.
// Each call is also logged as one "claude-usage" JSON line (`npx wrangler tail`).

const PREFIX = "usage:";
const KEEP_SECONDS = 400 * 24 * 3600; // a bit over a year

// US dollars per million tokens: [input, output]. Cache reads cost 0.1x input, cache writes 1.25x.
// Check https://www.anthropic.com/pricing when adding a model.
const PRICES = {
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

/** Estimated cost in dollars of one response's usage, or null for a model not in PRICES. */
export function costOf(model, usage = {}) {
  const price = PRICES[String(model || "").replace(/-\d{8}$/, "")];
  if (!price) return null;
  const [inp, out] = price;
  const dollars =
    (usage.input_tokens || 0) * inp +
    (usage.cache_read_input_tokens || 0) * inp * 0.1 +
    (usage.cache_creation_input_tokens || 0) * inp * 1.25 +
    (usage.output_tokens || 0) * out;
  return dollars / 1e6;
}

/**
 * Save one Claude call's usage. Never throws: a logging problem must not fail the staff
 * member's request. `feature` is "slack" or "form".
 */
export async function recordUsage(env, feature, response, now = new Date()) {
  try {
    const usage = response?.usage || {};
    const model = response?.model || env.CLAUDE_MODEL || "unknown";
    const cost = costOf(model, usage);
    const record = {
      f: feature,
      m: model,
      i: usage.input_tokens || 0,
      o: usage.output_tokens || 0,
      cr: usage.cache_read_input_tokens || 0,
      cw: usage.cache_creation_input_tokens || 0,
      c: cost === null ? null : Math.round(cost * 1e6) / 1e6,
    };
    console.log(JSON.stringify({ event: "claude-usage", ...record }));
    if (!env.CONTENT) return;
    const key = `${PREFIX}${now.toISOString().slice(0, 7)}:${now.toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
    await env.CONTENT.put(key, "", { metadata: record, expirationTtl: KEEP_SECONDS });
  } catch (e) {
    console.error("usage logging failed:", e.message);
  }
}

/** Monthly totals for the last `months` months (newest first), split by feature. */
export async function usageSummary(env, months = 3, now = new Date()) {
  const out = [];
  for (let back = 0; back < months; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const month = d.toISOString().slice(0, 7);
    const total = { month, calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, unpriced: 0, byFeature: {}, byModel: {} };
    let cursor;
    do {
      const page = await env.CONTENT.list({ prefix: `${PREFIX}${month}:`, cursor });
      for (const { metadata: r } of page.keys) {
        if (!r) continue;
        total.calls++;
        total.inputTokens += r.i + r.cr + r.cw;
        total.outputTokens += r.o;
        if (r.c === null) total.unpriced++;
        else total.cost += r.c;
        const f = (total.byFeature[r.f] ??= { calls: 0, cost: 0 });
        f.calls++;
        f.cost += r.c || 0;
        total.byModel[r.m] = (total.byModel[r.m] || 0) + 1;
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    total.cost = Math.round(total.cost * 100) / 100;
    for (const f of Object.values(total.byFeature)) f.cost = Math.round(f.cost * 100) / 100;
    out.push(total);
  }
  return out;
}

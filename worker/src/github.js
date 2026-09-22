// Commits new entries into content.json via the Git Data API.
// Git Data (blob → tree → commit → ref) handles files over the 1 MB
// Contents API limit, which a full WordPress export easily exceeds.

const API = "https://api.github.com";
const COLLECTIONS = { exhibition: "exhibitions", event: "events", post: "posts", page: "pages" };

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function client(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) throw new GitHubError("Server is missing GITHUB_TOKEN / GITHUB_REPO", 500);
  const repo = env.GITHUB_REPO;
  return async (path, init = {}) => {
    const res = await fetch(`${API}/repos/${repo}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: init.accept || "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "wp-migration-platform-worker",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!res.ok && !(init.allow404 && res.status === 404)) {
      throw new GitHubError(`GitHub ${init.method || "GET"} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    }
    return res;
  };
}

function emptyContent() {
  return { exhibitions: [], events: [], posts: [], pages: [], media: [] };
}

/** Insert or replace `entry` (matched by id, then slug) in its collection, newest first. */
export function upsertEntry(content, entry) {
  const collection = COLLECTIONS[entry.type] || `${entry.type}s`;
  const list = (content[collection] ||= []);
  const idx = list.findIndex((e) => e.id === entry.id || e.slug === entry.slug);
  if (idx >= 0) list[idx] = { ...list[idx], ...entry };
  else list.unshift(entry);
  content.updatedAt = new Date().toISOString();
  return content;
}

/**
 * Add `entry` to content.json on the configured branch and push a commit.
 * Retries when the branch moved underneath us (non-fast-forward).
 * Returns { commitSha, commitUrl }.
 */
export async function commitEntry(env, entry, attempts = 3) {
  const gh = client(env);
  const branch = env.GITHUB_BRANCH || "main";
  const path = env.CONTENT_PATH || "content.json";

  for (let attempt = 1; ; attempt++) {
    const ref = await (await gh(`/git/ref/heads/${encodeURIComponent(branch)}`)).json();
    const headSha = ref.object.sha;
    const headCommit = await (await gh(`/git/commits/${headSha}`)).json();

    const fileRes = await gh(`/contents/${path}?ref=${headSha}`, { accept: "application/vnd.github.raw+json", allow404: true });
    const content = fileRes.status === 404 ? emptyContent() : await fileRes.json();
    upsertEntry(content, entry);

    const blob = await (
      await gh(`/git/blobs`, { method: "POST", body: JSON.stringify({ content: JSON.stringify(content, null, 2) + "\n", encoding: "utf-8" }) })
    ).json();
    const tree = await (
      await gh(`/git/trees`, {
        method: "POST",
        body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }] }),
      })
    ).json();
    const commit = await (
      await gh(`/git/commits`, {
        method: "POST",
        body: JSON.stringify({
          message: `content: ${entry.type} "${entry.title}" via form\n\nSubmission ${entry.id}`,
          tree: tree.sha,
          parents: [headSha],
        }),
      })
    ).json();

    try {
      await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
      return { commitSha: commit.sha, commitUrl: commit.html_url };
    } catch (e) {
      // 422 = not a fast-forward: someone pushed meanwhile. Rebuild on the new head.
      if (e.status === 422 && attempt < attempts) continue;
      throw e;
    }
  }
}

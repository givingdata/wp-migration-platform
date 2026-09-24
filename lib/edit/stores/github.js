// Store: JSON files in a GitHub repo, one commit per write (Git Data API).
// Git Data (blob → tree → commit → ref) handles files over the 1 MB Contents API limit,
// which a full WordPress export easily exceeds, and commits several files at once.
import { StaleError } from "../index.js";

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.repo    "owner/name"
 * @param {string} opts.token   token with Contents read/write on that repo
 * @param {string} [opts.branch="main"]
 * @param {Record<string,string>} [opts.paths]  logical file → path in the repo (e.g. {"content.json": "content.json"})
 * @param {string} [opts.userAgent]
 */
export function githubStore({ repo, token, branch = "main", paths = {}, userAgent = "wp-migration-platform", fetch: fetchImpl = fetch }) {
  if (!repo || !token) throw new GitHubError("Missing GitHub repo or token", 500);
  const where = (file) => paths[file] ?? file;

  async function gh(path, init = {}) {
    const res = await fetchImpl(`${API}/repos/${repo}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: init.accept || "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": userAgent,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!res.ok && !(init.allow404 && res.status === 404)) {
      throw new GitHubError(`GitHub ${init.method || "GET"} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    }
    return res;
  }

  return {
    async read(files) {
      const ref = await (await gh(`/git/ref/heads/${encodeURIComponent(branch)}`)).json();
      const head = ref.object.sha;
      const out = {};
      await Promise.all(
        files.map(async (file) => {
          const res = await gh(`/contents/${where(file)}?ref=${head}`, { accept: "application/vnd.github.raw+json", allow404: true });
          out[file] = res.status === 404 ? null : await res.json();
        }),
      );
      return { files: out, head };
    },

    async write(files, message, head) {
      const headCommit = await (await gh(`/git/commits/${head}`)).json();
      const tree = [];
      for (const [file, data] of Object.entries(files)) {
        const blob = await (await gh(`/git/blobs`, { method: "POST", body: JSON.stringify({ content: JSON.stringify(data, null, 2) + "\n", encoding: "utf-8" }) })).json();
        tree.push({ path: where(file), mode: "100644", type: "blob", sha: blob.sha });
      }
      const newTree = await (await gh(`/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }) })).json();
      const commit = await (await gh(`/git/commits`, { method: "POST", body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }) })).json();
      try {
        await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
      } catch (e) {
        // 422 = not a fast-forward: someone pushed meanwhile.
        if (e.status === 422) throw new StaleError();
        throw e;
      }
      return { commitSha: commit.sha, commitUrl: commit.html_url };
    },
  };
}

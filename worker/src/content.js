// The Worker's Edit module: content.json (and trash.json) in the client repo on GitHub.
import specs from "../../config/design-specs.json" with { type: "json" };
import { createEditor } from "../../lib/edit/index.js";
import { githubStore, GitHubError } from "../../lib/edit/stores/github.js";

export { GitHubError };

export function editorFor(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) throw new GitHubError("Server is missing GITHUB_TOKEN / GITHUB_REPO", 500);
  const store = githubStore({
    repo: env.GITHUB_REPO,
    token: env.GITHUB_TOKEN,
    branch: env.GITHUB_BRANCH || "main",
    paths: env.CONTENT_PATH ? { "content.json": env.CONTENT_PATH } : {},
    userAgent: "wp-migration-platform-worker",
  });
  return createEditor({ store, specs });
}

# Edit module

One place for every change to a client's content: list, read, add, edit, delete, restore.
The staff form's **Edit existing** mode uses it through the Worker (`worker/src/edit-routes.js`);
the dashboard, a Claude connector (MCP) and the central admin are meant to use it too
(`docs/ROADMAP.md`).

```js
import { createEditor } from "./lib/edit/index.js";
import { githubStore } from "./lib/edit/stores/github.js";

const editor = createEditor({ specs, store: githubStore({ repo: "givingdata/cinderella-site", token }) });
await editor.list();                                  // { collections: { pages: [...], posts: [...] }, trashCount }
const { entry, version } = await editor.get("pages", "103");
await editor.update("pages", "103", { title: "About us" }, { version, by: "staff@example.org" });
const { trashId } = await editor.remove("posts", "a1b2", { by, reason: "duplicate" });
await editor.restore(trashId, { by });
await editor.create("announcement", { title: "Office closed", date: "2026-10-05" });
```

## Rules it enforces

- **Every change is one commit** (GitHub store), so history has every version and `git revert`
  undoes any change.
- **No silent overwrites.** `get()` returns a `version`; `update()`/`remove()` with that version
  fail with 409 if someone changed the entry in between. A write that loses a race with another
  commit (for example a form submission) is retried on the new data.
- **Deletes are recoverable.** `remove()` moves the entry to `trash.json` (next to `content.json`)
  with who deleted it, when and why; `restore()` puts it back, with the same web address unless
  something else took it meanwhile. Images stay in R2. The homepage can't be deleted.
- **Links don't break.** Edits never change an entry's slug.
- **Only known fields change**: title, summary, body, image description, and the date/time/
  location/author/link fields the entry's content type has (`config/design-specs.json`).
- **HTML is cleaned** of scripts, event handlers and `javascript:` links (`sanitize.js`). It's a
  blocklist so WordPress galleries and embeds survive an edit; it protects against pasted
  scripts and mistakes by logged-in staff, not against arbitrary hostile HTML.

## Stores (connectors)

A store is where the content lives. The editor only needs two methods:

```js
{
  // Current data for the named files ("content.json", "trash.json"; null if missing),
  // plus an opaque `head` identifying this version of the data.
  async read(files) → { files: { [name]: object | null }, head },

  // Save these files as one change. Throw StaleError (from index.js) if the data is no
  // longer at `head`; the editor then re-reads and retries.
  async write(files, message, head) → object   // e.g. { commitSha, commitUrl }
}
```

| Store | Used by | Notes |
|---|---|---|
| `stores/github.js` | Worker, and anything with a repo token | Git Data API; one commit per write, fast-forward only |
| `stores/file.js` | tests, `form/mock-worker.mjs`, local scripts | A folder on disk; doesn't commit |

**A future content platform** (our own lightweight CMS, a database such as Cloudflare D1, or a
hosted headless CMS) plugs in as another store: implement `read`/`write` over its API and pass it
to `createEditor`. Everything built on the editor (the staff form, the dashboard, a Claude
connector) keeps working unchanged. Two things to keep when writing one: `write` must be
atomic with a version check (so `head` has to mean something), and it should keep history, since
un-delete and "undo a bad edit" rely on it.

Tests: `node --test lib/edit/` (also run by `cd worker && npm test`).

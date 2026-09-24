// "Edit existing" mode: find a page or entry, change it in a simple editor, delete it
// (it goes to Deleted items) or put a deleted item back. Talks to the Worker's /entries
// and /trash routes (worker/src/edit-routes.js); every change is signed like /submit.
import { signedJson } from "./signing.js";
import { initMenu } from "./menu.js";

const REQUEST_TIMEOUT_MS = 60_000;
const FIELDS = ["title", "description", "date", "endDate", "time", "location", "author", "linkUrl", "imageAlt"];
const PAGE_LABEL = "Pages";

const $ = (id) => document.getElementById(id);

export function initEdit({ config, specs, escapeHtml }) {
  const addForm = $("content-form");
  const panel = $("edit-mode");
  const editForm = $("edit-form");
  const area = $("e-content");
  const htmlArea = $("e-content-html");
  let listing = null; // { collections, trashCount }
  let current = null; // { collection, id, version, entry, type }
  let loadedHtml = "";
  let who = null;

  // Cloudflare Access tells the page who is logged in; used to label changes in the history.
  fetch("/cdn-cgi/access/get-identity", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((id) => { who = id?.email || null; })
    .catch(() => {});

  const labelFor = (collection) =>
    collection === "pages" ? PAGE_LABEL : Object.values(specs?.contentTypes || {}).find((t) => t.collection === collection)?.listing?.title
      || Object.values(specs?.contentTypes || {}).find((t) => t.collection === collection)?.label
      || collection.charAt(0).toUpperCase() + collection.slice(1);

  // ---- Requests ------------------------------------------------------------

  async function call(method, path, data) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const init = { method, signal: controller.signal };
      if (method === "GET") init.headers = { Authorization: `Bearer ${config.apiKey}` };
      else Object.assign(init, await signedJson({ ...data, by: who }, config));
      const res = await fetch(`${config.workerUrl}${path}`, init);
      let body = null;
      try { body = await res.json(); } catch { /* non-JSON error page */ }
      if (!res.ok || !body?.success) {
        const err = new Error(body?.error || `The server answered ${res.status}`);
        Object.assign(err, { status: res.status, fields: body?.fields });
        throw err;
      }
      return body;
    } catch (e) {
      if (e.name === "AbortError") throw new Error("The server took too long to answer. Check your connection and try again.");
      if (e instanceof TypeError) throw new Error("Couldn't reach the server. Check your internet connection and try again.");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  const entryPath = (collection, id) => `/entries/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;

  const menu = initMenu({ call, escapeHtml });

  // ---- Modes ---------------------------------------------------------------

  function setMode(mode) {
    if (mode !== "menu" && !$("menu-mode").hidden && menu.dirty && !confirm("The menu has changes that aren't saved yet. Leave them for now? (They stay here until you reload the page.)")) return;
    for (const [m, tab, el] of [["add", "tab-add", addForm], ["edit", "tab-edit", panel], ["menu", "tab-menu", $("menu-mode")]]) {
      $(tab).setAttribute("aria-selected", String(m === mode));
      el.hidden = m !== mode;
    }
    if (mode === "edit" && !listing) loadList();
    if (mode === "menu") menu.show();
  }
  $("tab-add").addEventListener("click", () => setMode("add"));
  $("tab-edit").addEventListener("click", () => setMode("edit"));
  $("tab-menu").addEventListener("click", () => setMode("menu"));

  function show(view) {
    $("edit-browse").hidden = view !== "browse";
    editForm.hidden = view !== "edit";
    $("trash-view").hidden = view !== "trash";
  }

  // ---- Browse --------------------------------------------------------------

  async function loadList() {
    $("edit-list").innerHTML = '<p class="hint">Loading…</p>';
    try {
      listing = await call("GET", "/entries");
      renderList();
    } catch (e) {
      $("edit-list").innerHTML = `<p class="status error">${escapeHtml(e.message)}</p>`;
    }
  }

  function renderList() {
    const q = $("edit-search").value.trim().toLowerCase();
    const groups = Object.entries(listing.collections)
      .map(([collection, items]) => [collection, items.filter((i) => !q || i.title.toLowerCase().includes(q) || (i.path || "").includes(q))])
      .filter(([, items]) => items.length);
    $("show-trash").textContent = `Deleted items${listing.trashCount ? ` (${listing.trashCount})` : ""}`;
    if (!groups.length) {
      $("edit-list").innerHTML = `<p class="hint">${q ? "Nothing matches that search." : "There's no content yet."}</p>`;
      return;
    }
    $("edit-list").innerHTML = groups
      .map(([collection, items]) => `
        <div class="entry-group">
          <h2>${escapeHtml(labelFor(collection))} <span class="optional">(${items.length})</span></h2>
          <ul class="entry-list">${items.map((i) => `
            <li>
              <span>
                <button type="button" class="link" data-open="${escapeHtml(collection)}" data-id="${escapeHtml(i.id)}">${escapeHtml(i.title)}</button>
                ${i.path ? `<span class="path">${escapeHtml(i.path)}</span>` : ""}
              </span>
              <span class="meta">${i.frontPage ? "Homepage" : escapeHtml(i.date || "")}</span>
            </li>`).join("")}
          </ul>
        </div>`)
      .join("");
  }

  $("edit-search").addEventListener("input", () => listing && renderList());
  $("edit-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open]");
    if (btn) openEntry(btn.dataset.open, btn.dataset.id);
  });

  // ---- Edit ----------------------------------------------------------------

  function setError(name, message) {
    const el = $(`e-${name}-error`);
    if (el) el.textContent = message || "";
    const input = editForm.elements[name];
    if (input?.setAttribute) message ? input.setAttribute("aria-invalid", "true") : input.removeAttribute("aria-invalid");
  }

  function status(el, kind, html) {
    el.innerHTML = html ? `<div class="status ${kind}">${html}</div>` : "";
    if (html) el.focus();
  }

  async function openEntry(collection, id) {
    status($("edit-status"), "", "");
    status($("browse-status"), "", "");
    FIELDS.forEach((f) => setError(f, ""));
    try {
      const data = await call("GET", entryPath(collection, id));
      current = { collection, id, version: data.version, entry: data.entry, type: data.type, frontPage: data.frontPage, inMenu: data.inMenu, path: data.path, menuBarLocked: data.inTopMenu && data.topLevelLocked };
    } catch (e) {
      status($("browse-status"), "error", escapeHtml(e.message));
      return;
    }
    const { entry, type } = current;
    const fields = new Set(collection === "pages" ? [] : type.fields || []);
    $("edit-kind").textContent = collection === "pages" ? (current.frontPage ? "Homepage" : "Page") : type.label || collection;
    // Show where this lives, so staff can check they opened the right one.
    const live = current.path && config.siteUrl ? new URL(current.path, config.siteUrl).href : null;
    $("edit-url").innerHTML = current.path
      ? `Web address: <code>${escapeHtml(current.path)}</code>${live ? ` · <a href="${escapeHtml(live)}" target="_blank" rel="noopener">View on site ↗</a>` : ""}`
      : "";
    editForm.querySelectorAll("[data-edit-field]").forEach((el) => {
      const name = el.dataset.editField;
      el.hidden = name === "imageAlt" ? !entry.image : !fields.has(name);
    });
    editForm.querySelectorAll("[data-edit-label]").forEach((el) => {
      el.textContent = type.fieldLabels?.[el.dataset.editLabel] || (el.dataset.editLabel === "endDate" ? "End date" : "Link");
    });
    $("e-date-label").textContent = type.dateLabel || "Date";
    for (const f of FIELDS) if (editForm.elements[f]) editForm.elements[f].value = entry[f] ?? "";

    const notes = [];
    if (current.frontPage) notes.push("This is the homepage. It can be changed but not deleted.");
    if (current.menuBarLocked) notes.push("This page is linked from the main menu bar, so it can be changed but not deleted here. To remove it, ask your web team to change the menu bar first.");
    else if (current.inMenu) notes.push("This page is in the site menu. If you delete it, its menu link can be taken out at the same time.");
    $("edit-notes").innerHTML = notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join("");
    $("edit-delete").hidden = !!current.frontPage || !!current.menuBarLocked;
    $("edit-save").textContent = "Save changes";

    area.innerHTML = entry.content || "";
    htmlArea.value = entry.content || "";
    setHtmlMode(false);
    // Compare against the browser's own rendering of the text, so saving a title change
    // doesn't resend (and re-serialize) a body nobody touched.
    loadedHtml = area.innerHTML;
    show("edit");
    editForm.elements.title.focus();
  }
  function openNewPage() {
    setMode("edit");
    status($("edit-status"), "", "");
    status($("browse-status"), "", "");
    FIELDS.forEach((f) => setError(f, ""));
    current = { creating: true, collection: "pages", entry: {}, type: { fields: [] } };
    $("edit-kind").textContent = "New page";
    $("edit-url").textContent = "The web address is made from the title when you save.";
    $("edit-notes").innerHTML = "";
    editForm.querySelectorAll("[data-edit-field]").forEach((el) => { el.hidden = true; });
    for (const f of FIELDS) if (editForm.elements[f]) editForm.elements[f].value = "";
    area.innerHTML = "";
    htmlArea.value = "";
    setHtmlMode(false);
    loadedHtml = area.innerHTML;
    $("edit-delete").hidden = true;
    $("edit-save").textContent = "Create page";
    show("edit");
    editForm.elements.title.focus();
  }
  $("new-page").addEventListener("click", openNewPage);

  $("edit-back").addEventListener("click", () => { status($("browse-status"), "", ""); show("browse"); loadList(); });

  // Simple editor: document.execCommand is old but is the one API every browser still
  // supports for contenteditable; the Worker cleans the HTML again before saving.
  function setHtmlMode(on) {
    if (on) htmlArea.value = area.innerHTML;
    else if (!htmlArea.hidden) area.innerHTML = htmlArea.value;
    htmlArea.hidden = !on;
    area.hidden = on;
    $("toggle-html").setAttribute("aria-pressed", String(on));
    editForm.querySelectorAll(".editor-bar button:not(#toggle-html)").forEach((b) => { b.disabled = on; });
  }

  editForm.querySelector(".editor-bar").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-cmd]");
    if (!btn) return;
    const cmd = btn.dataset.cmd;
    if (cmd === "html") return setHtmlMode(htmlArea.hidden);
    area.focus();
    if (cmd === "h2" || cmd === "h3" || cmd === "p") document.execCommand("formatBlock", false, cmd);
    else if (cmd === "link") {
      const url = prompt("Link address (https://… or /page-on-this-site/)");
      if (url && /^(https?:\/\/|\/|mailto:)/i.test(url.trim())) document.execCommand("createLink", false, url.trim());
    } else document.execCommand(cmd);
  });

  // Paste as plain paragraphs, so Word/Google Docs fonts and colours don't come along.
  area.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (text == null) return;
    e.preventDefault();
    const html = text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
    document.execCommand("insertHTML", false, html);
  });

  function contentHtml() {
    if (htmlArea.hidden) return area.innerHTML;
    // Normalize the HTML view the same way before comparing.
    const scratch = document.createElement("div");
    scratch.innerHTML = htmlArea.value;
    return scratch.innerHTML === loadedHtml ? loadedHtml : htmlArea.value;
  }

  editForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!current) return;
    FIELDS.forEach((f) => setError(f, ""));
    if (current.creating) return createPage();
    const changes = {};
    for (const f of FIELDS) {
      const input = editForm.elements[f];
      if (!input || input.closest("[data-edit-field]")?.hidden) continue;
      const value = input.value.trim();
      if (value !== String(current.entry[f] ?? "")) changes[f] = value;
    }
    const html = contentHtml();
    if (html !== loadedHtml) changes.content = html;
    if (!Object.keys(changes).length) return status($("edit-status"), "success", "No changes to save.");
    if ("title" in changes && !changes.title) return setError("title", "Please add a title.");

    const btn = $("edit-save");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>Saving…';
    try {
      const res = await call("PUT", entryPath(current.collection, current.id), { changes, version: current.version });
      current.version = res.version;
      current.entry = res.entry;
      if ("content" in changes) loadedHtml = contentHtml();
      status($("edit-status"), "success", "<strong>Saved.</strong> The website will update in a few minutes.");
    } catch (err) {
      if (err.fields) for (const [f, m] of Object.entries(err.fields)) setError(f, m);
      const reload = err.status === 409 ? ' <button type="button" class="link" id="edit-reload">Reload it</button>' : "";
      status($("edit-status"), "error", `${escapeHtml(err.message)}${reload}`);
      $("edit-reload")?.addEventListener("click", () => openEntry(current.collection, current.id));
    } finally {
      btn.disabled = false;
      btn.textContent = "Save changes";
    }
  });

  async function createPage() {
    const title = editForm.elements.title.value.trim();
    if (!title) return setError("title", "Please add a title.");
    const btn = $("edit-save");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>Creating…';
    try {
      const res = await call("POST", "/pages", { fields: { title, description: editForm.elements.description.value.trim(), content: contentHtml() } });
      listing = null;
      await openEntry("pages", res.entry.id);
      status($("edit-status"), "success",
        `<strong>Page created</strong> at <code>${escapeHtml(res.path)}</code>. It will be live in a few minutes. Visitors can only find it through links, so <button type="button" class="link" id="add-to-menu">add it to the menu</button>.`);
      $("add-to-menu").addEventListener("click", () => { setMode("menu"); menu.prefill(res.entry.title, res.path); });
    } catch (err) {
      if (err.fields) for (const [f, m] of Object.entries(err.fields)) setError(f, m);
      status($("edit-status"), "error", escapeHtml(err.message));
    } finally {
      btn.disabled = false;
      btn.textContent = current?.creating ? "Create page" : "Save changes";
    }
  }

  // ---- Delete --------------------------------------------------------------

  const dialog = $("delete-dialog");
  $("edit-delete").addEventListener("click", () => {
    $("delete-what").textContent = `“${current.entry.title}”`;
    $("delete-reason").value = "";
    $("delete-menu-row").hidden = !current.inMenu;
    $("delete-menu").checked = true;
    dialog.showModal();
  });
  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "delete" || !current) return;
    try {
      const res = await call("DELETE", entryPath(current.collection, current.id), {
        version: current.version,
        reason: $("delete-reason").value.trim() || null,
        removeFromMenu: current.inMenu && $("delete-menu").checked,
      });
      listing = null;
      show("browse");
      await loadList();
      status($("browse-status"), "success", `<strong>Deleted “${escapeHtml(current.entry.title)}”.</strong> It will be off the website in a few minutes${res.removedFromMenu ? " and out of the menu" : ""}. You can put it back from Deleted items.`);
      current = null;
    } catch (err) {
      status($("edit-status"), "error", escapeHtml(err.message));
    }
  });

  // ---- Trash ---------------------------------------------------------------

  async function loadTrash() {
    show("trash");
    status($("trash-status"), "", "");
    $("trash-list").innerHTML = '<p class="hint">Loading…</p>';
    try {
      const { items } = await call("GET", "/trash");
      $("trash-list").innerHTML = items.length
        ? `<ul class="entry-list">${items.map((d) => `
            <li>
              <span><strong>${escapeHtml(d.title || "(untitled)")}</strong><br>
                <span class="meta">${escapeHtml(labelFor(d.collection))} · deleted ${escapeHtml(new Date(d.deletedAt).toLocaleString())}${d.deletedBy ? ` by ${escapeHtml(d.deletedBy)}` : ""}${d.reason ? ` · “${escapeHtml(d.reason)}”` : ""}</span></span>
              <button type="button" class="secondary small" data-restore="${escapeHtml(d.trashId)}">Put back</button>
            </li>`).join("")}</ul>`
        : '<p class="hint">Nothing has been deleted.</p>';
    } catch (e) {
      $("trash-list").innerHTML = `<p class="status error">${escapeHtml(e.message)}</p>`;
    }
  }

  $("show-trash").addEventListener("click", loadTrash);
  $("trash-back").addEventListener("click", () => { show("browse"); loadList(); });
  $("trash-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-restore]");
    if (!btn) return;
    btn.disabled = true;
    try {
      const res = await call("POST", `/trash/${btn.dataset.restore}/restore`, {});
      await loadTrash();
      const moved = res.slugChanged ? ` Its old web address was taken meanwhile, so it is now at /${escapeHtml(res.entry.slug)}/.` : "";
      const inMenu = res.menuRestored ? " Its menu link is back too." : "";
      status($("trash-status"), "success", `<strong>“${escapeHtml(res.entry.title)}” is back.</strong> The website will update in a few minutes.${inMenu}${moved}`);
      listing = null;
    } catch (err) {
      btn.disabled = false;
      status($("trash-status"), "error", escapeHtml(err.message));
    }
  });

  return { openNewPage };
}

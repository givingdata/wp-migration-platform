// "Menu" tab: rename, reorder, nest (one level), remove and add links in the site's main
// menu, with a preview; one Save commits the whole menu (worker GET/PUT /menu).

const $ = (id) => document.getElementById(id);
const LINK = /^(https?:\/\/\S+|mailto:\S+|tel:\S+|\/\S*)$/i;

export function initMenu({ call, escapeHtml }) {
  let items = null; // [{ title, url, path, children: [...] , isNew }]
  let version = null;
  let targets = [];
  let dirty = false;
  let loading = null;

  const knownPaths = () => new Set(["/", ...targets.map((t) => t.path)]);
  const setStatus = (kind, html) => {
    $("menu-status").innerHTML = html ? `<div class="status ${kind}">${html}</div>` : "";
    if (html) $("menu-status").focus();
  };
  const touch = () => { dirty = true; render(); };

  async function load() {
    setStatus("", "");
    $("menu-list").innerHTML = '<li class="hint">Loading…</li>';
    try {
      const data = await call("GET", "/menu");
      items = data.menu.map((i) => ({ ...i, children: i.children.map((c) => ({ ...c, children: [] })) }));
      version = data.version;
      targets = data.targets;
      dirty = false;
      fillTargets();
      render();
    } catch (e) {
      $("menu-list").innerHTML = `<li class="status error">${escapeHtml(e.message)}</li>`;
    }
  }
  const ready = () => (loading ||= load());

  function fillTargets() {
    const groups = { pages: "Pages", listing: "Listing pages" };
    const byGroup = {};
    for (const t of targets) (byGroup[groups[t.collection] || "Other content"] ||= []).push(t);
    $("menu-target").innerHTML = '<option value="">Choose a page…</option>' + Object.entries(byGroup)
      .map(([g, list]) => `<optgroup label="${escapeHtml(g)}">${list.map((t) => `<option value="${escapeHtml(t.path)}" data-title="${escapeHtml(t.title)}">${escapeHtml(t.title)} — ${escapeHtml(t.path)}</option>`).join("")}</optgroup>`)
      .join("");
  }

  // ---- Rendering ---------------------------------------------------------------

  function describe(item) {
    if (!item.url) return "Dropdown heading (not a link)";
    const shown = item.path || item.url;
    if (shown.startsWith("/") && !knownPaths().has(shown.split(/[?#]/)[0])) return `${shown} — no page at this address`;
    return shown;
  }

  function row(item, pos, siblings, isChild) {
    const [i, j] = pos;
    const idx = isChild ? j : i;
    const key = isChild ? `${i}.${j}` : `${i}`;
    const tools = [
      `<button type="button" data-act="up" data-key="${key}" ${idx === 0 ? "disabled" : ""} aria-label="Move ${escapeHtml(item.title)} up">↑</button>`,
      `<button type="button" data-act="down" data-key="${key}" ${idx === siblings.length - 1 ? "disabled" : ""} aria-label="Move ${escapeHtml(item.title)} down">↓</button>`,
      isChild
        ? `<button type="button" data-act="out" data-key="${key}" title="Move out of the dropdown">⇤ Out</button>`
        : `<button type="button" data-act="in" data-key="${key}" ${i === 0 || item.children.length ? "disabled" : ""} title="Move into the dropdown of the item above">⇥ Into dropdown above</button>`,
      `<button type="button" data-act="remove" data-key="${key}">Remove</button>`,
    ].join("");
    return `<div class="menu-item${item.isNew ? " new" : ""}">
      <label class="visually-hidden" for="mi-${key}">Name</label>
      <input type="text" id="mi-${key}" data-key="${key}" value="${escapeHtml(item.title)}" maxlength="100">
      <span class="tools">${tools}</span>
      <span class="path">${escapeHtml(describe(item))}</span>
    </div>`;
  }

  function render() {
    $("menu-list").innerHTML = items.length
      ? items.map((item, i) => `<li>${row(item, [i], items, false)}${item.children.length
          ? `<ol aria-label="Under ${escapeHtml(item.title)}">${item.children.map((c, j) => `<li>${row(c, [i, j], item.children, true)}</li>`).join("")}</ol>`
          : ""}</li>`).join("")
      : '<li class="hint">The menu is empty.</li>';
    $("menu-parent").innerHTML = '<option value="">Top level</option>' + items.map((m, i) => `<option value="${i}">Under “${escapeHtml(m.title)}”</option>`).join("");
    renderPreview();
    $("menu-save").disabled = !dirty;
    $("menu-reset").disabled = !dirty;
  }

  function renderPreview() {
    const paths = knownPaths();
    const link = (m) => {
      const target = m.path || m.url;
      if (!m.url) return `<span>${escapeHtml(m.title)} ▾</span>`;
      const broken = target.startsWith("/") && !paths.has(target.split(/[?#]/)[0]);
      return `<a href="#" class="${broken ? "broken" : ""}" title="${escapeHtml(target)}">${escapeHtml(m.title)}${m.children?.length ? " ▾" : ""}</a>`;
    };
    $("menu-preview").innerHTML = `<ul>${items.map((m) => `<li>${link(m)}${m.children.length ? `<ul>${m.children.map((c) => `<li>${link(c)}</li>`).join("")}</ul>` : ""}</li>`).join("")}</ul>`;
    $("menu-preview").querySelectorAll("a").forEach((a) => a.addEventListener("click", (e) => e.preventDefault()));
  }

  // ---- Changes -------------------------------------------------------------------

  function locate(key) {
    const [i, j] = key.split(".").map(Number);
    return j === undefined ? { list: items, index: i, item: items[i] } : { list: items[i].children, index: j, item: items[i].children[j], parent: i };
  }

  $("menu-list").addEventListener("input", (e) => {
    const key = e.target.dataset.key;
    if (!key) return;
    locate(key).item.title = e.target.value;
    dirty = true;
    renderPreview();
    $("menu-save").disabled = $("menu-reset").disabled = false;
  });

  $("menu-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const { list, index, item, parent } = locate(btn.dataset.key);
    const act = btn.dataset.act;
    let focusKey = null;
    if (act === "up" || act === "down") {
      const to = act === "up" ? index - 1 : index + 1;
      [list[index], list[to]] = [list[to], list[index]];
      focusKey = parent === undefined ? `${to}` : `${parent}.${to}`;
    } else if (act === "in") {
      list.splice(index, 1);
      items[index - 1].children.push({ ...item, children: [] });
      focusKey = `${index - 1}.${items[index - 1].children.length - 1}`;
    } else if (act === "out") {
      list.splice(index, 1);
      items.splice(parent + 1, 0, item);
      focusKey = `${parent + 1}`;
    } else if (act === "remove") {
      if (item.children?.length && !confirm(`Remove “${item.title}” and the ${item.children.length} link(s) under it?`)) return;
      list.splice(index, 1);
    }
    touch();
    // Keep keyboard users on the item they moved.
    if (focusKey) $("menu-list").querySelector(`button[data-act="${act}"][data-key="${focusKey}"]:not(:disabled)`)?.focus()
      || $(`mi-${focusKey}`)?.focus();
  });

  $("menu-target").addEventListener("change", () => {
    const opt = $("menu-target").selectedOptions[0];
    if (opt?.value) {
      $("menu-url").value = "";
      if (!$("menu-title").value.trim()) $("menu-title").value = opt.dataset.title || "";
    }
  });
  $("menu-url").addEventListener("input", () => { if ($("menu-url").value) $("menu-target").value = ""; });

  $("menu-add").addEventListener("click", () => {
    const err = (m) => { $("menu-add-error").textContent = m; };
    err("");
    const path = $("menu-target").value;
    const url = $("menu-url").value.trim() || path;
    const title = $("menu-title").value.trim();
    if (!url) return err("Choose a page or type a web address.");
    if (!LINK.test(url)) return err("Web addresses start with https:// (or / for a page on this site).");
    if (!title) return err("Give it a name for the menu.");
    const item = { title, url, path: path || url, children: [], isNew: true };
    const parent = $("menu-parent").value;
    if (parent === "") items.push(item);
    else items[Number(parent)].children.push(item);
    $("menu-target").value = "";
    $("menu-url").value = "";
    $("menu-title").value = "";
    touch();
    setStatus("success", `Added “${escapeHtml(title)}”. Press <strong>Save menu</strong> to put it on the site.`);
  });

  $("menu-reset").addEventListener("click", () => {
    if (!dirty || confirm("Undo all changes since the menu was last saved?")) load();
  });

  $("menu-save").addEventListener("click", async () => {
    const btn = $("menu-save");
    btn.disabled = true;
    btn.textContent = "Saving…";
    setStatus("", "");
    try {
      const menu = items.map((m) => ({ title: m.title.trim(), url: m.url, children: m.children.map((c) => ({ title: c.title.trim(), url: c.url, children: [] })) }));
      const res = await call("PUT", "/menu", { menu, version });
      version = res.version;
      items.forEach((m) => { delete m.isNew; m.children.forEach((c) => delete c.isNew); });
      dirty = false;
      render();
      setStatus("success", "<strong>Menu saved.</strong> The website will update in a few minutes.");
    } catch (e) {
      const details = e.fields ? `<ul>${Object.values(e.fields).map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul>` : "";
      const reload = e.status === 409 ? ' <button type="button" class="link" id="menu-reload">Reload the menu</button>' : "";
      setStatus("error", `${escapeHtml(e.message)}${reload}${details}`);
      $("menu-reload")?.addEventListener("click", load);
      btn.disabled = false;
    } finally {
      btn.textContent = "Save menu";
    }
  });

  window.addEventListener("beforeunload", (e) => { if (dirty) e.preventDefault(); });

  return {
    show: ready,
    get dirty() { return dirty; },
    /** Start adding a link to a page (after creating it): fills in the Add a link form. */
    async prefill(title, path) {
      await ready();
      targets.some((t) => t.path === path) || targets.push({ title, path, collection: "pages" });
      fillTargets();
      $("menu-target").value = path;
      $("menu-url").value = "";
      $("menu-title").value = title;
      $("menu-title").focus();
      setStatus("success", `Choose where “${escapeHtml(title)}” goes, press <strong>Add to menu</strong>, then <strong>Save menu</strong>.`);
    },
  };
}

import config from "./config.js";
import { signedMultipart } from "./signing.js";

const SUBMIT_TIMEOUT_MS = 120_000; // Claude + image processing can take a while
const LABELS = { exhibition: "Exhibition", event: "Event", post: "Post" };
const DATE_LABEL = { exhibition: "Opening date", event: "Event date", post: "Publish date" };

const $ = (id) => document.getElementById(id);
const form = $("content-form");
const statusEl = $("status");
const submitBtn = $("submit-btn");
const imageInput = $("image");

let specs = null;
let imageMeta = null; // { width, height, url }

// ---- Specs ----------------------------------------------------------------

async function loadSpecs() {
  try {
    const res = await fetch(`${config.workerUrl}/specs`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (config.designSpecs) return config.designSpecs;
    throw e;
  }
}

function currentType() {
  return form.elements.type.value || "post";
}

function typeSpec() {
  return specs?.contentTypes?.[currentType()];
}

function parseRatio(ratio) {
  const [w, h] = String(ratio || "1:1").split(":").map(Number);
  return w > 0 && h > 0 ? w / h : 1;
}

function describeSpec(type, spec) {
  const mb = Math.round((specs.image?.maxUploadBytes ?? 10485760) / 1048576);
  const kinds = (specs.image?.acceptedMimeTypes ?? []).map((m) => m.split("/")[1].toUpperCase()).join(", ");
  return `${LABELS[type] || type} images: ${spec.aspectRatio} aspect ratio, at least ${spec.minWidth}px wide (up to ${spec.maxWidth}px is used). ${kinds}, max ${mb} MB.`;
}

// ---- Type switching -------------------------------------------------------

function applyType() {
  const spec = typeSpec();
  if (!spec) return;
  const type = currentType();
  document.querySelectorAll("[data-field]").forEach((el) => {
    el.hidden = !spec.fields.includes(el.dataset.field);
  });
  $("date-label").textContent = DATE_LABEL[type] || "Date";
  $("image-spec").textContent = describeSpec(type, spec);
  if (imageMeta) renderPreview();
}

// ---- Image preview + crop guidance ---------------------------------------

function clearImage() {
  if (imageMeta?.url) URL.revokeObjectURL(imageMeta.url);
  imageMeta = null;
  imageInput.value = "";
  $("preview").classList.remove("visible");
  $("image-warnings").innerHTML = "";
  setFieldError("image", "");
}

function renderPreview() {
  const spec = typeSpec();
  if (!imageMeta || !spec) return;
  const { width, height, url } = imageMeta;
  const target = parseRatio(spec.aspectRatio);
  const actual = width / height;

  // Centered crop region in % of the original.
  let boxW = 100, boxH = 100;
  if (actual > target) boxW = (target / actual) * 100;
  else boxH = (actual / target) * 100;
  Object.assign($("crop-box").style, {
    width: `${boxW}%`, height: `${boxH}%`, left: `${(100 - boxW) / 2}%`, top: `${(100 - boxH) / 2}%`,
  });

  $("preview-original").src = url;
  $("preview-result").src = url;
  $("preview-original").alt = "Your uploaded image with the crop area highlighted";
  $("preview-result").alt = `Preview of the image cropped to ${spec.aspectRatio}`;
  $("result-frame").style.aspectRatio = String(target);
  $("preview-caption").textContent = `How it will appear on the site (${spec.aspectRatio}).`;

  const warnings = [];
  if (Math.abs(actual - target) / target > 0.05) {
    const lost = Math.round(100 - (boxW * boxH) / 100);
    warnings.push(`This image is ${width}×${height}, so about ${lost}% will be trimmed to fit ${spec.aspectRatio}. If something important is near the edges, crop it yourself first.`);
  }
  if (width < spec.minWidth) {
    warnings.push(`This image is only ${width}px wide; ${spec.minWidth}px or more is recommended, so it may look blurry.`);
  }
  $("image-warnings").innerHTML = warnings.map((w) => `<p class="notice warn">${escapeHtml(w)}</p>`).join("");
  $("preview").classList.add("visible");
}

function handleFile(file) {
  setFieldError("image", "");
  if (!file) return clearImage();
  const accepted = specs?.image?.acceptedMimeTypes ?? ["image/jpeg", "image/png", "image/webp"];
  const maxBytes = specs?.image?.maxUploadBytes ?? 10485760;
  if (!accepted.includes(file.type)) {
    clearImage();
    return setFieldError("image", "Please choose a JPEG, PNG or WebP image.");
  }
  if (file.size > maxBytes) {
    clearImage();
    return setFieldError("image", `That image is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${Math.round(maxBytes / 1048576)} MB. Try exporting it smaller.`);
  }
  if (imageMeta?.url) URL.revokeObjectURL(imageMeta.url);
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    imageMeta = { width: img.naturalWidth, height: img.naturalHeight, url };
    renderPreview();
  };
  img.onerror = () => {
    clearImage();
    setFieldError("image", "That file couldn't be read as an image.");
  };
  img.src = url;
}

// ---- Validation + status --------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function setFieldError(name, message) {
  const errorEl = $(`${name}-error`);
  if (errorEl) errorEl.textContent = message;
  const input = name === "type" ? null : form.elements[name];
  if (input && input.setAttribute) {
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }
}

function clearErrors() {
  for (const name of ["type", "title", "description", "date", "endDate", "image"]) setFieldError(name, "");
}

function validate() {
  const errors = {};
  if (!form.elements.type.value) errors.type = "Choose what you're adding.";
  if (!form.elements.title.value.trim()) errors.title = "Please add a title.";
  if (!form.elements.description.value.trim()) errors.description = "Please add a description.";
  if (!form.elements.date.value) errors.date = "Please choose a date.";
  const end = form.elements.endDate;
  if (!end.closest("[data-field]").hidden && end.value && form.elements.date.value && end.value < form.elements.date.value) {
    errors.endDate = "End date can't be before the start date.";
  }
  return errors;
}

function showErrors(errors) {
  for (const [name, message] of Object.entries(errors)) setFieldError(name, message);
  const first = Object.keys(errors)[0];
  const target = first === "type" ? form.querySelector('input[name="type"]') : form.elements[first];
  target?.focus?.();
}

function showStatus(kind, html) {
  statusEl.innerHTML = `<div class="status ${kind}">${html}</div>`;
  statusEl.focus();
}

function setBusy(busy) {
  submitBtn.disabled = busy;
  submitBtn.innerHTML = busy ? '<span class="spinner" aria-hidden="true"></span>Submitting…' : "Submit";
  form.setAttribute("aria-busy", String(busy));
}

// ---- Submit ---------------------------------------------------------------

function buildFormData() {
  const fd = new FormData();
  fd.append("type", currentType());
  for (const name of ["title", "description", "date"]) fd.append(name, form.elements[name].value.trim());
  document.querySelectorAll("[data-field]").forEach((wrapper) => {
    if (wrapper.hidden) return;
    const input = wrapper.querySelector("input, textarea");
    if (input?.value.trim()) fd.append(input.name, input.value.trim());
  });
  if (imageInput.files[0] && imageMeta) fd.append("image", imageInput.files[0]);
  return fd;
}

function messageForFailure(status, data) {
  if (status === 400 && data?.fields) {
    showErrors(data.fields);
    const items = Object.entries(data.fields).map(([f, m]) => `<li><strong>${escapeHtml(f)}</strong>: ${escapeHtml(m)}</li>`).join("");
    return `<strong>Please fix the following and try again:</strong><ul>${items}</ul>`;
  }
  if (status === 401) {
    return /timestamp/i.test(data?.error || "")
      ? "Your device's clock seems to be wrong. Please check the date and time settings, then try again."
      : "This form isn't authorized to publish. Please contact your website administrator.";
  }
  if (status === 413) return escapeHtml(data?.error || "That submission is too large. Try a smaller image or shorter description.");
  if (status === 422) return escapeHtml(data?.error || "We couldn't process that submission. Please check the image and text.");
  return `Something went wrong on our side${data?.error ? ` (${escapeHtml(data.error)})` : ""}. Your text is still here — please try again in a minute.`;
}

async function onSubmit(event) {
  event.preventDefault();
  clearErrors();
  statusEl.innerHTML = "";

  const errors = validate();
  if (Object.keys(errors).length) return showErrors(errors);

  setBusy(true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
  try {
    const { body, headers } = await signedMultipart(buildFormData(), config);
    const res = await fetch(`${config.workerUrl}/submit`, { method: "POST", body, headers, signal: controller.signal });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error page */ }

    if (res.ok && data?.success) {
      const title = escapeHtml(data.entry?.title || form.elements.title.value);
      if (data.published === false) {
        showStatus("error", `<strong>Saved, but not yet published.</strong> “${title}” was received, but publishing failed. Your administrator has been notified — no need to resubmit. (Reference: ${escapeHtml(data.contentId)})`);
      } else {
        showStatus("success", `<strong>Thanks! “${title}” was submitted.</strong> The website will update in a few minutes.`);
      }
      form.reset();
      clearImage();
      applyType();
    } else {
      showStatus("error", messageForFailure(res.status, data));
    }
  } catch (e) {
    const msg = e.name === "AbortError"
      ? "The server took too long to respond. Please check the website in a few minutes before resubmitting, in case it went through."
      : "Couldn't reach the server. Check your internet connection and try again — your text is still here.";
    showStatus("error", msg);
  } finally {
    clearTimeout(timer);
    setBusy(false);
  }
}

// ---- Wire-up --------------------------------------------------------------

async function init() {
  if (config.siteName) {
    document.title = `Submit Content — ${config.siteName}`;
    $("site-name").textContent = config.siteName;
  }
  $("date").valueAsDate = new Date();

  try {
    specs = await loadSpecs();
  } catch {
    $("image-spec").textContent = "Image requirements couldn't be loaded. You can still submit.";
    submitBtn.disabled = false;
  }

  // Only offer types the specs define.
  if (specs) {
    form.querySelectorAll('input[name="type"]').forEach((radio) => {
      if (!specs.contentTypes[radio.value]) radio.closest("label").remove();
    });
  }
  applyType();

  form.addEventListener("change", (e) => { if (e.target.name === "type") applyType(); });
  imageInput.addEventListener("change", () => handleFile(imageInput.files[0]));
  $("remove-image").addEventListener("click", () => { clearImage(); imageInput.focus(); });

  const dz = $("dropzone");
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragover"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    imageInput.files = dt.files;
    handleFile(file);
  });

  form.addEventListener("submit", onSubmit);
}

init();

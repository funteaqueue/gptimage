// ---------------------------------------------------------------------------
// imgpt frontend
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const els = {
  prompt: $("prompt"),
  model: $("model"),
  size: $("size"),
  count: $("count"),
  dropzone: $("dropzone"),
  refInput: $("refInput"),
  dropPlaceholder: $("dropPlaceholder"),
  refThumbs: $("refThumbs"),
  generateBtn: $("generateBtn"),
  genError: $("genError"),
  refineBtn: $("refineBtn"),
  refinePanel: $("refinePanel"),
  refineModel: $("refineModel"),
  refineInstructions: $("refineInstructions"),
  refineRun: $("refineRun"),
  refineStatus: $("refineStatus"),
  adjustments: $("adjustments"),
  presetSelect: $("presetSelect"),
  presetScope: $("presetScope"),
  presetMode: $("presetMode"),
  presetNewBtn: $("presetNewBtn"),
  presetRenameBtn: $("presetRenameBtn"),
  presetDeleteBtn: $("presetDeleteBtn"),
  describeZone: $("describeZone"),
  describeInput: $("describeInput"),
  describePlaceholder: $("describePlaceholder"),
  describeThumbs: $("describeThumbs"),
  queueArea: $("queueArea"),
  queueList: $("queueList"),
  resultArea: $("resultArea"),
  resultGrid: $("resultGrid"),
  historyList: $("historyList"),
  historyEmpty: $("historyEmpty"),
  histCount: $("histCount"),
  detailModal: $("detailModal"),
  detailBody: $("detailBody"),
  detailClose: $("detailClose"),
  settingsBtn: $("settingsBtn"),
  settingsModal: $("settingsModal"),
  settingsClose: $("settingsClose"),
  apiKeyInput: $("apiKeyInput"),
  saveKeyBtn: $("saveKeyBtn"),
  keyStatus: $("keyStatus"),
  lightbox: $("lightbox"),
  lightboxImg: $("lightboxImg"),
  lightboxClose: $("lightboxClose"),
  lightboxPrev: $("lightboxPrev"),
  lightboxNext: $("lightboxNext"),
};

// Active reference images (data URLs). Multiple → combined as an edit.
let referenceDataUrls = [];

// ---------------------------------------------------------------------------
// Reference image handling
// ---------------------------------------------------------------------------

els.dropzone.addEventListener("click", (e) => {
  if (e.target.closest(".ref-remove")) return; // removing a thumb, not adding
  els.refInput.click();
});

els.refInput.addEventListener("change", () => {
  for (const file of els.refInput.files) loadReference(file);
  els.refInput.value = ""; // allow re-picking the same file later
});

["dragover", "dragenter"].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("drag");
  })
);
els.dropzone.addEventListener("drop", (e) => {
  for (const file of e.dataTransfer.files) loadReference(file);
});

function loadReference(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => addReference(reader.result);
  reader.readAsDataURL(file);
}

function addReference(dataUrl) {
  referenceDataUrls.push(dataUrl);
  renderReferences();
}

function removeReference(idx) {
  referenceDataUrls.splice(idx, 1);
  renderReferences();
}

function clearReferences() {
  referenceDataUrls = [];
  renderReferences();
}

// Replace the active references with stored files from a past generation.
async function reuseReferences(fileNames) {
  const urls = [];
  for (const f of fileNames) {
    const resp = await fetch(`/generations/${f}`);
    const blob = await resp.blob();
    urls.push(
      await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.readAsDataURL(blob);
      })
    );
  }
  referenceDataUrls = urls;
  renderReferences();
}

function renderReferences() {
  const has = referenceDataUrls.length > 0;
  els.refThumbs.hidden = !has;
  els.dropPlaceholder.hidden = has;
  els.refThumbs.innerHTML = "";

  referenceDataUrls.forEach((url, i) => {
    const wrap = document.createElement("div");
    wrap.className = "ref-thumb";
    const img = document.createElement("img");
    img.src = url;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ref-remove";
    btn.textContent = "✕";
    btn.title = "Remove";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeReference(i);
    });
    wrap.appendChild(img);
    wrap.appendChild(btn);
    els.refThumbs.appendChild(wrap);
  });

  if (has) {
    const add = document.createElement("div");
    add.className = "ref-add";
    add.textContent = "+";
    add.title = "Add another";
    els.refThumbs.appendChild(add);
  }
}

// ---------------------------------------------------------------------------
// Generate — parallel job queue with retries
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const jobs = new Map(); // id -> job
let jobSeq = 0;

els.generateBtn.addEventListener("click", enqueue);
// Ctrl/Cmd+Enter from the prompt box also queues.
els.prompt.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    enqueue();
  }
});

function enqueue() {
  const prompt = els.prompt.value.trim();
  els.genError.hidden = true;
  if (!prompt) {
    showError("Please enter a prompt.");
    return;
  }
  const job = {
    id: ++jobSeq,
    prompt,
    model: els.model.value,
    size: els.size.value,
    n: Number(els.count.value) || 1,
    images: referenceDataUrls.slice(),
    refCount: referenceDataUrls.length,
    status: "running",
    attempt: 1,
    error: null,
  };
  jobs.set(job.id, job);
  renderQueue();

  // Keep the prompt so the user can tweak it for the next iteration.
  // Select it all so typing over replaces it, but editing a few words is easy too.
  els.prompt.focus();
  els.prompt.select();

  runJob(job);
}

// ---------------------------------------------------------------------------
// Prompt builder (magic wand) — describe an image and/or refine a prompt,
// applying adjustments, with the result written back into the prompt box.
// ---------------------------------------------------------------------------

// Built-in presets, seeded the first time (and used to re-seed if all are
// deleted). Each preset has a `scope` controlling when it's offered:
//   "image" — only when an image is attached
//   "text"  — only when no image is attached
//   "both"  — always
const DEFAULT_PRESETS = [
  {
    id: "json-image",
    name: "JSON style (image)",
    scope: "image",
    instructions:
      "You are a vision assistant for AI image generation. Study the provided image and produce a single structured JSON object describing it. Use these keys: subject, setting, composition, lighting, color_palette, style, mood, details (an array of concrete visual elements), camera. Be vivid and specific. If adjustments are provided, apply them to the description. Output ONLY valid JSON — no markdown code fences, preamble, or explanation.",
  },
  {
    id: "prose-image",
    name: "Natural language (image)",
    scope: "image",
    instructions:
      "You are an art director. Study the provided image and describe it as a single natural-sounding paragraph: the subject and what it's doing, the setting, the lighting and mood, the colors, and the overall style. If adjustments are provided, apply them. Output ONLY the description as plain prose — no lists, headings, quotes, or explanation.",
  },
  {
    id: "json-text",
    name: "JSON style (prompt)",
    scope: "text",
    instructions:
      "You are a prompt engineer for AI image generation. Turn the source prompt into a single structured JSON object describing the intended image. Use these keys: subject, setting, composition, lighting, color_palette, style, mood, details (an array of concrete visual elements), camera. If adjustments are provided, apply them. Preserve the original intent. Output ONLY valid JSON — no markdown code fences, preamble, or explanation.",
  },
  {
    id: "prose-text",
    name: "Natural language (prompt)",
    scope: "text",
    instructions:
      "You are an art director. Rewrite the source prompt as a single natural-sounding paragraph that vividly describes the intended image: subject, setting, lighting, mood, colors, and overall style. If adjustments are provided, apply them. Keep the original intent. Output ONLY the description as plain prose — no lists, headings, quotes, or explanation.",
  },
];

const LS_PRESETS = "imgpt_refine_presets";
const LS_ACTIVE = "imgpt_refine_active_preset";
const LS_MODEL = "imgpt_refine_model";

let modelsLoaded = false;
// Optional reference image fed to the builder (separate from generation refs).
let describeDataUrl = null;

let presets = loadPresets();
let activePresetId =
  localStorage.getItem(LS_ACTIVE) &&
  presets.some((p) => p.id === localStorage.getItem(LS_ACTIVE))
    ? localStorage.getItem(LS_ACTIVE)
    : null;

function loadPresets() {
  try {
    const stored = JSON.parse(localStorage.getItem(LS_PRESETS));
    if (Array.isArray(stored) && stored.length) {
      // Backfill scope for presets saved before scoping existed.
      return stored.map((p) => ({ scope: "both", ...p }));
    }
  } catch {
    /* fall through to seed */
  }
  const seed = DEFAULT_PRESETS.map((p) => ({ ...p }));
  localStorage.setItem(LS_PRESETS, JSON.stringify(seed));
  return seed;
}

function savePresets() {
  localStorage.setItem(LS_PRESETS, JSON.stringify(presets));
}

// "image" when a reference image is attached, otherwise "text".
function currentMode() {
  return describeDataUrl ? "image" : "text";
}

// Presets offered for the current mode (scope matches, or "both").
function visiblePresets() {
  const mode = currentMode();
  return presets.filter((p) => p.scope === mode || p.scope === "both");
}

function getActivePreset() {
  const visible = visiblePresets();
  return (
    visible.find((p) => p.id === activePresetId) || visible[0] || null
  );
}

function newPresetId() {
  return "p" + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
}

// Rebuild the preset dropdown for the current mode, keeping the active preset
// valid for that mode, and sync the instructions box + scope selector.
function renderPresetSelect() {
  const mode = currentMode();
  els.presetMode.textContent = mode === "image" ? "image mode" : "text mode";

  const visible = visiblePresets();
  const active = getActivePreset();
  activePresetId = active ? active.id : null;

  els.presetSelect.innerHTML = "";
  if (!visible.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No preset for this mode — create one";
    els.presetSelect.appendChild(opt);
  } else {
    for (const p of visible) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      els.presetSelect.appendChild(opt);
    }
    els.presetSelect.value = activePresetId;
  }

  els.refineInstructions.value = active ? active.instructions : "";
  els.refineInstructions.disabled = !active;
  if (active) els.presetScope.value = active.scope;
  els.presetScope.disabled = !active;
  els.presetRenameBtn.disabled = !active;
  // Keep at least one preset in existence.
  els.presetDeleteBtn.disabled = !active || presets.length <= 1;
}

function setActivePreset(id) {
  activePresetId = id;
  localStorage.setItem(LS_ACTIVE, id || "");
  renderPresetSelect();
}

els.presetSelect.addEventListener("change", () => {
  if (els.presetSelect.value) setActivePreset(els.presetSelect.value);
});

// Editing the instructions box edits the selected preset in place.
els.refineInstructions.addEventListener("input", () => {
  const active = getActivePreset();
  if (!active) return;
  active.instructions = els.refineInstructions.value;
  savePresets();
});

// Changing scope re-files the preset; it may leave the current mode's view.
els.presetScope.addEventListener("change", () => {
  const active = getActivePreset();
  if (!active) return;
  active.scope = els.presetScope.value;
  savePresets();
  renderPresetSelect();
});

els.presetNewBtn.addEventListener("click", () => {
  const name = (prompt("Name for the new preset:", "My preset") || "").trim();
  if (!name) return;
  const preset = {
    id: newPresetId(),
    name,
    scope: currentMode(), // scoped to the case you're working in
    instructions: getActivePreset()?.instructions || "",
  };
  presets.push(preset);
  savePresets();
  setActivePreset(preset.id);
});

els.presetRenameBtn.addEventListener("click", () => {
  const current = getActivePreset();
  if (!current) return;
  const name = (prompt("Rename preset:", current.name) || "").trim();
  if (!name) return;
  current.name = name;
  savePresets();
  renderPresetSelect();
});

els.presetDeleteBtn.addEventListener("click", () => {
  const current = getActivePreset();
  if (!current || presets.length <= 1) return;
  if (!confirm(`Delete preset "${current.name}"?`)) return;
  presets = presets.filter((p) => p.id !== current.id);
  savePresets();
  setActivePreset(null); // renderPresetSelect picks the first visible
});

els.refineModel.addEventListener("change", () => {
  localStorage.setItem(LS_MODEL, els.refineModel.value);
});

renderPresetSelect();

els.refineBtn.addEventListener("click", () => {
  const show = els.refinePanel.hidden;
  els.refinePanel.hidden = !show;
  els.refineBtn.classList.toggle("open", show);
  if (show) loadModels();
});

async function loadModels() {
  if (modelsLoaded) return;
  try {
    const res = await fetch("/api/models");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load models");
    const saved = localStorage.getItem(LS_MODEL);
    els.refineModel.innerHTML = "";
    for (const id of data.models) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id;
      els.refineModel.appendChild(opt);
    }
    if (saved && data.models.includes(saved)) {
      els.refineModel.value = saved;
    }
    modelsLoaded = true;
  } catch (err) {
    els.refineModel.innerHTML = `<option value="">${escapeHtml(
      err.message
    )}</option>`;
  }
}

// --- Optional reference image for the builder ------------------------------
// Adding/removing it flips the mode, which re-filters the preset dropdown.

els.describeZone.addEventListener("click", (e) => {
  if (e.target.closest(".ref-remove")) return;
  els.describeInput.click();
});
els.describeInput.addEventListener("change", () => {
  const file = els.describeInput.files[0];
  if (file) loadDescribeImage(file);
  els.describeInput.value = "";
});
["dragover", "dragenter"].forEach((evt) =>
  els.describeZone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.describeZone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((evt) =>
  els.describeZone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.describeZone.classList.remove("drag");
  })
);
els.describeZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) loadDescribeImage(file);
});

function loadDescribeImage(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    describeDataUrl = reader.result;
    renderDescribeThumb();
    renderPresetSelect(); // mode → image
  };
  reader.readAsDataURL(file);
}

function renderDescribeThumb() {
  const has = Boolean(describeDataUrl);
  els.describeThumbs.hidden = !has;
  els.describePlaceholder.hidden = has;
  els.describeThumbs.innerHTML = "";
  if (!has) return;
  const wrap = document.createElement("div");
  wrap.className = "ref-thumb";
  const img = document.createElement("img");
  img.src = describeDataUrl;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ref-remove";
  btn.textContent = "✕";
  btn.title = "Remove";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    describeDataUrl = null;
    renderDescribeThumb();
    renderPresetSelect(); // mode → text
  });
  wrap.appendChild(img);
  wrap.appendChild(btn);
  els.describeThumbs.appendChild(wrap);
}

// --- Unified Run: image and/or prompt and/or adjustments → new prompt ------
els.refineRun.addEventListener("click", async () => {
  const model = els.refineModel.value;
  if (!model) {
    setRefineStatus("Pick a model first (use a vision model with an image).", true);
    return;
  }
  const hasImage = Boolean(describeDataUrl);
  const promptText = els.prompt.value.trim();
  const adjustments = els.adjustments.value.trim();
  if (!hasImage && !promptText && !adjustments) {
    setRefineStatus("Add an image, a prompt, or some adjustments first.", true);
    return;
  }

  els.refineRun.disabled = true;
  setRefineStatus(
    `<span class="spinner"></span>${hasImage ? "Reading image…" : "Working…"}`,
    false
  );
  try {
    const res = await fetch("/api/transform", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        instructions: els.refineInstructions.value,
        prompt: promptText,
        adjustments,
        image: hasImage ? describeDataUrl : null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    els.prompt.value = data.prompt;
    els.prompt.focus();
    setRefineStatus("✓ Result written to the prompt. Edit it, then generate.", false);
  } catch (err) {
    setRefineStatus(err.message, true);
  } finally {
    els.refineRun.disabled = false;
  }
});

function setRefineStatus(html, isError) {
  els.refineStatus.innerHTML = html;
  els.refineStatus.classList.toggle("error", Boolean(isError));
  els.refineStatus.hidden = false;
}

async function runJob(job) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    job.attempt = attempt;
    job.status = "running";
    job.error = null;
    renderQueue();
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: job.prompt,
          model: job.model,
          size: job.size,
          n: job.n,
          images: job.images,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status})`);
        // 4xx (bad prompt / model / auth) won't get better by retrying, and a
        // 429 cooldown lasts minutes — don't burn quick retries on either.
        err.permanent = [400, 401, 403, 404, 429].includes(res.status);
        throw err;
      }
      // Success.
      jobs.delete(job.id);
      renderQueue();
      prependResult(data);
      await loadHistory();
      return;
    } catch (err) {
      job.error = err.message;
      if (err.permanent || attempt === MAX_ATTEMPTS) {
        job.status = "failed";
        renderQueue();
        return;
      }
      job.status = "retrying";
      renderQueue();
      await sleep(700 * attempt);
    }
  }
}

function renderQueue() {
  const list = [...jobs.values()].sort((a, b) => b.id - a.id);
  els.queueArea.hidden = list.length === 0;
  els.queueList.innerHTML = "";

  for (const job of list) {
    const row = document.createElement("div");
    row.className = `queue-item ${job.status}`;

    let statusHtml;
    if (job.status === "running") {
      statusHtml = `<span class="spinner"></span>Generating… <span class="q-attempt">attempt ${job.attempt}/${MAX_ATTEMPTS}</span>`;
    } else if (job.status === "retrying") {
      statusHtml = `<span class="spinner"></span>Retrying… <span class="q-attempt">${job.attempt}/${MAX_ATTEMPTS}</span><div class="q-err">${escapeHtml(
        job.error || ""
      )}</div>`;
    } else {
      const tries = job.attempt === 1 ? "1 attempt" : `${job.attempt} attempts`;
      statusHtml = `<span class="q-failed">✕ Failed after ${tries}</span><div class="q-err">${escapeHtml(
        job.error || ""
      )}</div>`;
    }

    row.innerHTML = `
      <div class="q-main">
        <div class="q-prompt">${escapeHtml(job.prompt)}</div>
        <div class="q-sub">
          <span class="chip">${escapeHtml(job.model)}</span>
          <span class="chip">${escapeHtml(job.size)}</span>
          ${
            job.refCount
              ? `<span class="chip">${job.refCount} ref${
                  job.refCount > 1 ? "s" : ""
                }</span>`
              : ""
          }
        </div>
        <div class="q-status">${statusHtml}</div>
      </div>`;

    if (job.status === "failed") {
      const actions = document.createElement("div");
      actions.className = "q-actions";
      const retry = document.createElement("button");
      retry.className = "ghost-btn small";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => runJob(job));
      const dismiss = document.createElement("button");
      dismiss.className = "ghost-btn small";
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", () => {
        jobs.delete(job.id);
        renderQueue();
      });
      actions.appendChild(retry);
      actions.appendChild(dismiss);
      row.appendChild(actions);
    }

    els.queueList.appendChild(row);
  }
}

function showError(msg) {
  els.genError.textContent = msg;
  els.genError.hidden = false;
}

// Newest results first; accumulate as parallel jobs finish.
function prependResult(rec) {
  els.resultArea.hidden = false;
  for (const f of rec.images) {
    const img = document.createElement("img");
    img.src = `/generations/${f}`;
    img.alt = rec.prompt;
    img.title = rec.prompt;
    img.addEventListener("click", () => openDetail(rec.id));
    els.resultGrid.prepend(img);
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

async function loadHistory() {
  const res = await fetch("/api/generations");
  const list = await res.json();
  els.histCount.textContent = list.length;
  els.historyEmpty.hidden = list.length > 0;
  els.historyList.innerHTML = "";

  for (const rec of list) {
    const item = document.createElement("div");
    item.className = "hist-item";
    item.addEventListener("click", () => openDetail(rec.id));

    const thumb = document.createElement("img");
    thumb.className = "hist-thumb";
    thumb.src = `/generations/${rec.images[0]}`;
    thumb.alt = "";

    const meta = document.createElement("div");
    meta.className = "hist-meta";
    meta.innerHTML = `
      <div class="hist-prompt">${escapeHtml(rec.prompt)}</div>
      <div class="hist-sub">
        <span class="chip">${escapeHtml(rec.model)}</span>
        <span class="chip">${escapeHtml(rec.size)}</span>
        ${(() => {
          const c = rec.referenceFiles?.length || (rec.referenceFile ? 1 : 0);
          return c
            ? `<span class="chip">${c} ref${c > 1 ? "s" : ""}</span>`
            : "";
        })()}
        <span>${formatDate(rec.createdAt)}</span>
      </div>`;

    item.appendChild(thumb);
    item.appendChild(meta);
    els.historyList.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Detail modal
// ---------------------------------------------------------------------------

async function openDetail(id) {
  const res = await fetch(`/api/generations/${id}`);
  if (!res.ok) return;
  const rec = await res.json();

  const imgs = rec.images
    .map(
      (f) => `<img class="zoomable" src="/generations/${f}" alt="">`
    )
    .join("");

  // Normalize references: new records use referenceFiles[], old ones referenceFile.
  const refFiles = rec.referenceFiles?.length
    ? rec.referenceFiles
    : rec.referenceFile
    ? [rec.referenceFile]
    : [];

  const refBlock = refFiles.length
    ? `<div class="detail-ref">
         <div class="detail-ref-imgs">
           ${refFiles
             .map(
               (f) =>
                 `<img class="zoomable" src="/generations/${f}" alt="reference">`
             )
             .join("")}
         </div>
         <div class="detail-ref-meta">
           <div class="muted">${refFiles.length} reference image${
        refFiles.length > 1 ? "s" : ""
      } used for this generation</div>
           <button class="ghost-btn small" id="useRefBtn">↻ Use ${
             refFiles.length > 1 ? "these references" : "this reference"
           }</button>
         </div>
       </div>`
    : "";

  els.detailBody.innerHTML = `
    <h3>Generation detail</h3>
    ${refBlock}
    <div class="detail-images">${imgs}</div>
    <div class="detail-row"><div class="k">Prompt</div><div class="v">${escapeHtml(
      rec.prompt
    )}</div></div>
    <div class="detail-row"><div class="k">Model</div><div class="v">${escapeHtml(
      rec.model
    )}</div></div>
    <div class="detail-row"><div class="k">Size</div><div class="v">${escapeHtml(
      rec.size
    )}</div></div>
    <div class="detail-row"><div class="k">Count</div><div class="v">${rec.n}</div></div>
    <div class="detail-row"><div class="k">References</div><div class="v">${
      refFiles.length
        ? `${refFiles.length} (edit mode)`
        : "None"
    }</div></div>
    <div class="detail-row"><div class="k">Created</div><div class="v">${formatDate(
      rec.createdAt
    )}</div></div>
    <div class="detail-row"><div class="k">ID</div><div class="v">${rec.id}</div></div>
    <div class="detail-actions">
      <button class="ghost-btn" id="reuseBtn">${
        refFiles.length ? "Reuse prompt + references" : "Reuse prompt"
      }</button>
      <button class="danger-btn" id="deleteBtn">Delete</button>
    </div>
  `;

  $("reuseBtn").addEventListener("click", async () => {
    els.prompt.value = rec.prompt;
    els.model.value = rec.model;
    els.size.value = rec.size;
    els.count.value = rec.n;
    if (refFiles.length) await reuseReferences(refFiles);
    closeDetail();
    els.prompt.focus();
  });

  if (refFiles.length) {
    $("useRefBtn").addEventListener("click", async () => {
      await reuseReferences(refFiles);
      closeDetail();
      els.prompt.focus();
    });
  }
  $("deleteBtn").addEventListener("click", async () => {
    if (!confirm("Delete this generation and its files?")) return;
    await fetch(`/api/generations/${id}`, { method: "DELETE" });
    closeDetail();
    await loadHistory();
  });

  // Clicking any image in the detail opens the lightbox; arrows cycle through
  // all images shown (results + references).
  const zoomables = [...els.detailBody.querySelectorAll("img.zoomable")];
  const srcs = zoomables.map((img) => img.src);
  zoomables.forEach((img, i) => {
    img.addEventListener("click", () => openLightbox(srcs, i));
  });

  els.detailModal.hidden = false;
}

function closeDetail() {
  els.detailModal.hidden = true;
}
els.detailClose.addEventListener("click", closeDetail);
els.detailModal.addEventListener("click", (e) => {
  if (e.target === els.detailModal) closeDetail();
});

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

let lightboxSrcs = [];
let lightboxIdx = 0;

function openLightbox(srcs, idx) {
  lightboxSrcs = srcs;
  lightboxIdx = idx;
  els.lightboxImg.src = srcs[idx];
  const multi = srcs.length > 1;
  els.lightboxPrev.hidden = !multi;
  els.lightboxNext.hidden = !multi;
  els.lightbox.hidden = false;
}

function closeLightbox() {
  els.lightbox.hidden = true;
  els.lightboxImg.src = "";
}

function lightboxStep(delta) {
  if (lightboxSrcs.length < 2) return;
  lightboxIdx =
    (lightboxIdx + delta + lightboxSrcs.length) % lightboxSrcs.length;
  els.lightboxImg.src = lightboxSrcs[lightboxIdx];
}

function lightboxOpen() {
  return !els.lightbox.hidden;
}

// Close on backdrop click; image and buttons stop propagation.
els.lightbox.addEventListener("click", (e) => {
  if (e.target === els.lightbox) closeLightbox();
});
els.lightboxImg.addEventListener("click", (e) => e.stopPropagation());
els.lightboxClose.addEventListener("click", (e) => {
  e.stopPropagation();
  closeLightbox();
});
els.lightboxPrev.addEventListener("click", (e) => {
  e.stopPropagation();
  lightboxStep(-1);
});
els.lightboxNext.addEventListener("click", (e) => {
  e.stopPropagation();
  lightboxStep(1);
});

// ---------------------------------------------------------------------------
// Settings / API key
// ---------------------------------------------------------------------------

els.settingsBtn.addEventListener("click", () => {
  els.settingsModal.hidden = false;
});
els.settingsClose.addEventListener("click", () => {
  els.settingsModal.hidden = true;
});
els.settingsModal.addEventListener("click", (e) => {
  if (e.target === els.settingsModal) els.settingsModal.hidden = true;
});

els.saveKeyBtn.addEventListener("click", async () => {
  const apiKey = els.apiKeyInput.value.trim();
  if (!apiKey) return;
  const res = await fetch("/api/key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (res.ok) {
    els.keyStatus.textContent = "✓ Key saved";
    els.keyStatus.style.color = "var(--accent)";
    els.apiKeyInput.value = "";
    setTimeout(() => (els.settingsModal.hidden = true), 800);
  } else {
    els.keyStatus.textContent = "Failed to save key";
    els.keyStatus.style.color = "var(--danger)";
  }
});

async function checkStatus() {
  try {
    const res = await fetch("/api/status");
    const { hasKey } = await res.json();
    if (!hasKey) {
      els.settingsModal.hidden = false;
      els.keyStatus.textContent = "No API key yet — add one to start.";
      els.keyStatus.style.color = "var(--muted)";
    }
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c])
  );
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

document.addEventListener("keydown", (e) => {
  // Lightbox takes priority: Esc closes it, arrows navigate.
  if (lightboxOpen()) {
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") lightboxStep(-1);
    else if (e.key === "ArrowRight") lightboxStep(1);
    return;
  }
  if (e.key === "Escape") {
    closeDetail();
    els.settingsModal.hidden = true;
  }
});

// Init
checkStatus();
loadHistory();

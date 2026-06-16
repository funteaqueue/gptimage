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

  // Clear the prompt so the user can immediately type & queue the next one.
  els.prompt.value = "";
  els.prompt.focus();

  runJob(job);
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
        // 4xx (bad prompt / model / auth) won't get better by retrying.
        err.permanent = [400, 401, 403, 404].includes(res.status);
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
      (f) =>
        `<a href="/generations/${f}" target="_blank"><img src="/generations/${f}" alt=""></a>`
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
                 `<a href="/generations/${f}" target="_blank"><img src="/generations/${f}" alt="reference"></a>`
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
  if (e.key === "Escape") {
    closeDetail();
    els.settingsModal.hidden = true;
  }
});

// Init
checkStatus();
loadHistory();

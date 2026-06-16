import express from "express";
import { promises as fs } from "fs";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4317;
const API_BASE = "https://api.g0i.ai/v1";
// Returned image URLs are relative (e.g. /api/generated/x.png) and served from
// this host, behind the same Bearer auth as the API.
const IMAGE_HOST = "https://g0i.ai";
const GEN_DIR = path.join(__dirname, "generations");
const DB_FILE = path.join(__dirname, "db.json");
const CONFIG_FILE = path.join(__dirname, "config.json");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function ensureDirs() {
  await fs.mkdir(GEN_DIR, { recursive: true });
  if (!existsSync(DB_FILE)) await fs.writeFile(DB_FILE, "[]", "utf8");
}

async function readDb() {
  try {
    return JSON.parse(await fs.readFile(DB_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function writeDb(records) {
  await fs.writeFile(DB_FILE, JSON.stringify(records, null, 2), "utf8");
}

// Serialize read-modify-write on db.json so parallel generations don't clobber
// each other's appends.
let dbChain = Promise.resolve();
function withDbLock(fn) {
  const run = dbChain.then(fn, fn);
  dbChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with a few retries for transient network/5xx blips.
async function fetchWithRetry(url, opts, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function getApiKey() {
  if (process.env.G0I_API_KEY) return process.env.G0I_API_KEY;
  const cfg = await readConfig();
  return cfg.apiKey || null;
}

function extFromContentType(ct) {
  if (!ct) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  return "png";
}

// Parse a data URL into a Buffer + mime/ext. Returns null if it isn't one.
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return null;
  return {
    mime: m[1],
    ext: extFromContentType(m[1]),
    buffer: Buffer.from(m[2], "base64"),
  };
}

// Persist one returned image (url or b64) to the generations folder.
async function saveImage(item, idBase, index, apiKey) {
  if (item.b64_json) {
    const buf = Buffer.from(item.b64_json, "base64");
    const file = `${idBase}_${index}.png`;
    await fs.writeFile(path.join(GEN_DIR, file), buf);
    return file;
  }
  if (item.url) {
    // Resolve relative URLs against the image host; absolute URLs pass through.
    const url = /^https?:\/\//i.test(item.url)
      ? item.url
      : IMAGE_HOST + (item.url.startsWith("/") ? item.url : "/" + item.url);
    const { buf, ct } = await downloadImage(url, apiKey);
    const ext = extFromContentType(ct);
    const file = `${idBase}_${index}.${ext}`;
    await fs.writeFile(path.join(GEN_DIR, file), buf);
    return file;
  }
  throw new Error("Image item had neither url nor b64_json");
}

// Freshly-generated image URLs can briefly return "Image not found" (200 or 404
// with a tiny JSON body) before the file is ready. Poll until real image bytes
// arrive.
async function downloadImage(url, apiKey, attempts = 6) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  let lastInfo = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers });
      const ct = res.headers.get("content-type") || "";
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.ok && ct.startsWith("image/") && buf.length > 1000) {
        return { buf, ct };
      }
      lastInfo = `status ${res.status}, type ${ct}, ${buf.length}b`;
    } catch (err) {
      lastInfo = err.message;
    }
    if (i < attempts - 1) await sleep(1200 * (i + 1));
  }
  throw new Error(`Image not ready after ${attempts} tries (${lastInfo})`);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "25mb" })); // reference images can be large
app.use(express.static(path.join(__dirname, "public")));
app.use("/generations", express.static(GEN_DIR));

// Whether an API key is configured (frontend uses this to nudge setup).
app.get("/api/status", async (_req, res) => {
  res.json({ hasKey: Boolean(await getApiKey()) });
});

// Save the API key into config.json (gitignored).
app.post("/api/key", async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey || typeof apiKey !== "string") {
    return res.status(400).json({ error: "apiKey is required" });
  }
  const cfg = await readConfig();
  cfg.apiKey = apiKey.trim();
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
  res.json({ ok: true });
});

// List previous generations (newest first).
app.get("/api/generations", async (_req, res) => {
  const db = await readDb();
  res.json(db.slice().reverse());
});

// One generation's full detail.
app.get("/api/generations/:id", async (req, res) => {
  const db = await readDb();
  const rec = db.find((r) => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: "Not found" });
  res.json(rec);
});

// Delete a generation (record + its files).
app.delete("/api/generations/:id", async (req, res) => {
  const rec = await withDbLock(async () => {
    const db = await readDb();
    const idx = db.findIndex((r) => r.id === req.params.id);
    if (idx === -1) return null;
    const [removed] = db.splice(idx, 1);
    await writeDb(db);
    return removed;
  });
  if (!rec) return res.status(404).json({ error: "Not found" });
  for (const f of rec.images || []) {
    try {
      await fs.unlink(path.join(GEN_DIR, f));
    } catch {
      /* already gone */
    }
  }
  res.json({ ok: true });
});

// Generate images.
app.post("/api/generate", async (req, res) => {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return res
      .status(400)
      .json({ error: "No API key configured. Add one in Settings." });
  }

  const {
    prompt,
    model = "gpt-image-2",
    size = "1024x1024",
    n = 1,
    image, // single data URL reference (back-compat)
    images, // array of data URL references for multi-reference edit mode
  } = req.body || {};

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: "prompt is required" });
  }

  // Normalize references into a list, then parse each data URL.
  const refDataUrls = Array.isArray(images)
    ? images
    : image
    ? [image]
    : [];
  const refs = refDataUrls.map(parseDataUrl).filter(Boolean);

  // Reference image(s) present → use the OpenAI-style edit endpoint with
  // multipart form data. Putting `image` in the JSON body of /images/generations
  // is silently ignored upstream, so edit mode must go through /edits. A single
  // reference uses the `image` field; multiple use repeated `image[]` fields.
  let endpoint;
  let fetchOpts;
  if (refs.length) {
    const fd = new FormData();
    fd.append("model", model);
    fd.append("prompt", prompt);
    fd.append("size", size);
    fd.append("n", String(Number(n) || 1));
    const field = refs.length > 1 ? "image[]" : "image";
    refs.forEach((r, i) => {
      fd.append(field, new Blob([r.buffer], { type: r.mime }), `ref${i}.${r.ext}`);
    });
    endpoint = `${API_BASE}/images/edits`;
    fetchOpts = {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` }, // let fetch set multipart boundary
      body: fd,
    };
  } else {
    endpoint = `${API_BASE}/images/generations`;
    fetchOpts = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, prompt, size, n: Number(n) || 1 }),
    };
  }

  let apiJson;
  try {
    const apiRes = await fetch(endpoint, fetchOpts);
    const text = await apiRes.text();
    try {
      apiJson = JSON.parse(text);
    } catch {
      return res
        .status(502)
        .json({ error: `Unexpected API response: ${text.slice(0, 300)}` });
    }
    if (!apiRes.ok) {
      const msg =
        apiJson?.error?.message || apiJson?.error || `API error ${apiRes.status}`;
      return res.status(apiRes.status).json({ error: msg });
    }
  } catch (err) {
    return res.status(502).json({ error: `Request failed: ${err.message}` });
  }

  const data = apiJson.data || [];
  if (!data.length) {
    return res.status(502).json({ error: "API returned no images" });
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const idBase = `${createdAt.replace(/[:.]/g, "-")}_${id.slice(0, 8)}`;

  let savedFiles;
  try {
    savedFiles = [];
    for (let i = 0; i < data.length; i++) {
      savedFiles.push(await saveImage(data[i], idBase, i, apiKey));
    }
  } catch (err) {
    return res.status(500).json({ error: `Saving images failed: ${err.message}` });
  }

  // Persist copies of the reference image(s) too, so the detail view can show
  // them and they can be reused later.
  const referenceFiles = [];
  for (let i = 0; i < refs.length; i++) {
    try {
      const f = `${idBase}_ref${i}.${refs[i].ext}`;
      await fs.writeFile(path.join(GEN_DIR, f), refs[i].buffer);
      referenceFiles.push(f);
    } catch {
      /* skip this reference copy */
    }
  }

  const record = {
    id,
    createdAt,
    prompt,
    model,
    size,
    n: Number(n) || 1,
    images: savedFiles,
    referenceFiles,
    // Back-compat single-reference field (first reference).
    referenceFile: referenceFiles[0] || null,
    hasReference: refs.length > 0,
  };

  await withDbLock(async () => {
    const db = await readDb();
    db.push(record);
    await writeDb(db);
  });

  res.json(record);
});

await ensureDirs();
app.listen(PORT, () => {
  console.log(`\n  imgpt running →  http://localhost:${PORT}\n`);
});

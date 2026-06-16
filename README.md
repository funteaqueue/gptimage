# imgpt

A simple image-generator interface for the [g0i.ai](https://api.g0i.ai) image
API (`gpt-image-2`, `sdxl-turbo-v3`). Generate from a prompt and optional
reference image(s), store every result to disk, and browse past generations.

## Features

- Prompt, model, size and count controls
- Optional **reference image(s)** (edit mode) via click or drag-and-drop — add
  several to combine them
- **Parallel queue**: submit many prompts at once; each runs concurrently and
  auto-retries up to 3× on failure
- Generated images saved to `generations/` with metadata in `db.json`
- **History** sidebar of every past generation
- Click any generation for its full prompt/settings, its reference image(s),
  reuse (prompt + references), or delete
- API key kept server-side (env var or `config.json`), never exposed to the browser

## Run locally

```bash
npm install
npm start
```

Open <http://localhost:4317>. On first run, paste your g0i.ai API key into the
Settings dialog (or set `G0I_API_KEY` in the environment).

## Run with Docker (production)

The image runs as a non-root user, stores all data under `/data`, and exposes a
health check on `/api/status`.

### docker compose (recommended)

```bash
cp .env.example .env        # then put your real key in .env (G0I_API_KEY=sk-...)
docker compose up -d --build
```

App is on <http://localhost:4317>. History and images persist in the named
volume `imgpt-data` across restarts and redeploys. To change the public port,
edit the `ports:` mapping (e.g. `"80:4317"`).

### plain docker

```bash
docker build -t imgpt:latest .
docker run -d --name imgpt --restart unless-stopped \
  -p 4317:4317 \
  -e G0I_API_KEY=sk-your-api-key \
  -v imgpt-data:/data \
  imgpt:latest
```

## Configuration

| Variable       | Default            | Description                                        |
| -------------- | ------------------ | -------------------------------------------------- |
| `G0I_API_KEY`  | _(none)_           | g0i.ai API key. Takes precedence over `config.json`. |
| `PORT`         | `4317`             | Port the server listens on.                        |
| `DATA_DIR`     | app dir (`/data` in Docker) | Where `generations/`, `db.json`, `config.json` are stored. |

## Notes

- For production, prefer `G0I_API_KEY` over the Settings UI so the key isn't
  written into the data volume.
- `generations/`, `db.json`, `config.json` and `.env` are gitignored.
- If you use a **bind mount** instead of a named volume, ensure the host
  directory is writable by uid 1000 (the `node` user), e.g.
  `mkdir -p ./data && sudo chown -R 1000:1000 ./data`.

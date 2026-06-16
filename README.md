# imgpt

A simple local image-generator interface for the [g0i.ai](https://api.g0i.ai)
image API (NanoBanana, Imagen 4, Flux Pro). Generate from a prompt + optional
reference image, store every result to disk, and browse past generations.

## Features

- Prompt, model, size and count controls
- Optional **reference image** (edit mode) via click or drag-and-drop
- Generated images saved to `generations/` with metadata in `db.json`
- Live result preview
- **History** sidebar of every past generation
- Click any generation to see its full prompt/settings, reuse it, or delete it
- API key kept server-side in `config.json` (never exposed to the browser)

## Setup

```bash
npm install
npm start
```

Then open <http://localhost:4317>. On first run, paste your g0i.ai API key into
the Settings dialog (or set `G0I_API_KEY` in the environment).

## Notes

- Default port is `4317`. Set another with `PORT=4000 npm start`.
- `generations/`, `db.json` and `config.json` are gitignored.

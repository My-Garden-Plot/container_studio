# The Container Studio

Generates **two illustrations per plant** from a plant catalogue and writes them
as transparent PNGs ready to drop into the studio UI.

| Style | What it is | Output | Size |
| --- | --- | --- | --- |
| **Catalogue** | The "seed packet" — flat, painterly, iconic. A single hero bloom (or one characterful sprig for foliage plants) on a transparent background. | `catalog/<id>.png` | ~1024×1024 |
| **Container** | The plant *in the pot* — a naturalistic botanical field-guide illustration of the whole plant in its growth habit (thriller / filler / spiller). | `plants/<id>.png` | ~1024×1536 |

Each plant in [`data/plantcatalogue.json`](data/plantcatalogue.json) already
carries its own `catalogPrompt` and `containerPrompt`, so the generator simply
feeds those prompts to an OpenAI image model, trims the result to its content
bounds (with a ~10px transparent pad), and records the trimmed design
dimensions in `data/art-manifest.json`.

## Layout

```
container_studio/
├── data/
│   ├── plantcatalogue.json   # 61 plants × 2 prompts each (source of truth)
│   └── art-manifest.json     # written by the generator: {id: {catalog, container}}
├── tools/
│   └── generate-art.mjs      # the art generator
├── catalog/                  # generated seed-packet icons  (<id>.png)
├── plants/                   # generated in-pot growth-habit art (<id>.png)
├── .env.example
└── package.json
```

## Setup

```bash
npm install
cp .env.example .env        # then add your OPENAI_API_KEY
```

`tools/generate-art.mjs` needs **`OPENAI_API_KEY`** (read from the environment
or from `.env`). It depends on [`openai`](https://www.npmjs.com/package/openai)
for image generation and [`sharp`](https://www.npmjs.com/package/sharp) for
trimming.

## Usage

```bash
# Named plants
node tools/generate-art.mjs canna petunia coleus

# A quick sample at medium quality (npm script)
npm run generate:sample

# Everything (61 plants × 2 = 122 images)
node tools/generate-art.mjs --all

# Just one style, higher quality, overwrite existing
node tools/generate-art.mjs --all --kind catalog --quality high --force

# See the plan without spending anything
node tools/generate-art.mjs canna --dry-run
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--all` | – | Generate every plant in the catalogue |
| `--quality <q>` | `medium` | `low` \| `medium` \| `high` |
| `--kind <k>` | `both` | `both` \| `catalog` \| `container` |
| `--force` | off | Regenerate even if the PNG already exists |
| `--no-trim` | off | Keep the full canvas (skip trim-to-content) |
| `--concurrency <n>` | `2` | Images generated in parallel |
| `--model <name>` | `gpt-image-1` | Image model |
| `--out <dir>` | repo root | Output root for `catalog/` and `plants/` |
| `--dry-run` | off | Print the plan, make no API calls, write nothing |

By default existing PNGs are **skipped**, so re-running only fills in what's
missing. Use `--force` to redo them.

## The manifest

After a run, `data/art-manifest.json` maps each plant id to the two images and
their **design dimensions** (which preserve the trimmed aspect ratio). Container
heights follow the plant's role — thriller ≈ 200, filler ≈ 150, spiller ≈ 175
units — so they can be registered with `GardenArt.setContainerImage(id, …)` /
`GardenArt.setCatalogImage(id, …)`:

```json
{
  "canna": {
    "catalog":   { "href": "catalog/canna.png", "w": 118, "h": 120, "px": { "w": 1004, "h": 1020 } },
    "container": { "href": "plants/canna.png",  "w": 132, "h": 200, "px": { "w": 676,  "h": 1024 } }
  }
}
```

## Running on Claude Code on the web

The generator makes outbound calls to `api.openai.com`. In a hosted/remote
environment you must:

1. Provide `OPENAI_API_KEY` as an environment variable for the session, and
2. Add `api.openai.com` to the environment's **network egress allowlist**.

See the [network access docs](https://code.claude.com/docs/en/claude-code-on-the-web)
for how to configure egress for your environment.

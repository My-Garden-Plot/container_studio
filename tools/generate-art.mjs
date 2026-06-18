#!/usr/bin/env node
/**
 * The Container Studio — art generator
 * ====================================
 *
 * Generates TWO illustrations per plant from data/plantcatalogue.json:
 *
 *   1. CATALOGUE  (the "seed packet" icon) — flat, painterly, a single hero
 *      bloom on a transparent background.   -> catalog/<id>.png   (~1024x1024)
 *   2. CONTAINER  (the in-pot growth habit) — naturalistic botanical
 *      field-guide illustration of the whole plant, role-shaped, on a
 *      transparent background.              -> plants/<id>.png    (~1024x1536)
 *
 * Each plant already carries its own `catalogPrompt` and `containerPrompt`
 * in the catalogue, so this tool just feeds those prompts to OpenAI's image
 * model, trims the result to its content bounds (with a small transparent
 * pad), writes the PNGs, and records the trimmed design dimensions in
 * data/art-manifest.json (so they can later be registered with
 * GardenArt.setCatalogImage / GardenArt.setContainerImage).
 *
 * Usage:
 *   node tools/generate-art.mjs canna petunia coleus            # named plants
 *   node tools/generate-art.mjs --all                           # every plant
 *   node tools/generate-art.mjs canna --kind catalog            # one style only
 *   node tools/generate-art.mjs --all --quality high --force
 *   node tools/generate-art.mjs canna --dry-run                 # no API calls
 *
 * Flags:
 *   --all                generate every plant in the catalogue
 *   --quality <q>        low | medium | high   (default: medium)
 *   --kind <k>           both | catalog | container   (default: both)
 *   --force              regenerate even if the PNG already exists
 *   --no-trim            skip trim-to-content (keep full canvas)
 *   --concurrency <n>    images generated in parallel   (default: 2)
 *   --model <name>       image model            (default: gpt-image-1)
 *   --out <dir>          output root            (default: repo root)
 *   --dry-run            print the plan, make no API calls, write nothing
 *
 * Requires the OPENAI_API_KEY environment variable (see .env / .env.example).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import OpenAI from 'openai';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// --- image / role configuration -------------------------------------------

const SIZE = {
  catalog: '1024x1024',   // square iconic seed-packet card
  container: '1024x1536',  // portrait whole-plant growth habit
};

// Container "design unit" height per role (see catalogue meta.pipeline).
// Width is derived from the trimmed aspect ratio so the silhouette is kept.
const ROLE_HEIGHT = { thrill: 200, fill: 150, spill: 175 };
const CATALOG_HEIGHT = 120;   // design-unit height for the catalogue card

const TRIM_THRESHOLD = 10;    // alpha trim sensitivity
const TRIM_PAD = 10;          // transparent padding kept around content (px)

// --- tiny argv parser -------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    ids: [],
    all: false,
    quality: process.env.ART_QUALITY || 'medium',
    kind: 'both',
    force: false,
    trim: true,
    concurrency: 2,
    model: process.env.ART_MODEL || 'gpt-image-1',
    out: ROOT,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--all': opts.all = true; break;
      case '--force': opts.force = true; break;
      case '--no-trim': opts.trim = false; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--quality': opts.quality = argv[++i]; break;
      case '--kind': opts.kind = argv[++i]; break;
      case '--concurrency': opts.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1); break;
      case '--model': opts.model = argv[++i]; break;
      case '--out': opts.out = path.resolve(argv[++i]); break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
        opts.ids.push(a);
    }
  }
  return opts;
}

const VALID_QUALITY = new Set(['low', 'medium', 'high']);
const VALID_KIND = new Set(['both', 'catalog', 'container']);

// --- helpers ----------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Trim a transparent PNG to its content bounds and re-pad with `TRIM_PAD`. */
async function trimToContent(buffer) {
  let trimmed;
  try {
    trimmed = await sharp(buffer)
      .ensureAlpha()
      .trim({ threshold: TRIM_THRESHOLD })
      .toBuffer();
  } catch {
    // Uniform/blank image — nothing to trim; fall back to the original.
    trimmed = buffer;
  }
  return sharp(trimmed)
    .extend({
      top: TRIM_PAD, bottom: TRIM_PAD, left: TRIM_PAD, right: TRIM_PAD,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

/** Design dimensions that preserve the trimmed aspect ratio. */
function designDimensions(kind, role, pxW, pxH) {
  const aspect = pxW / pxH;
  const h = kind === 'container' ? (ROLE_HEIGHT[role] ?? 175) : CATALOG_HEIGHT;
  return { w: Math.round(h * aspect), h };
}

/** Generate a single image with a couple of retries on transient errors. */
async function generateImage(client, { prompt, size, quality, model }) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await client.images.generate({
        model,
        prompt,
        size,
        quality,
        n: 1,
        background: 'transparent',
        output_format: 'png',
      });
      const b64 = res.data?.[0]?.b64_json;
      if (!b64) throw new Error('No image data returned by the API');
      return Buffer.from(b64, 'base64');
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (attempt < 3 && retryable) {
        const wait = 2000 * attempt;
        console.warn(`   ! attempt ${attempt} failed (${status ?? err.message}); retrying in ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

// --- main -------------------------------------------------------------------

const HELP = `The Container Studio — art generator

  node tools/generate-art.mjs <plantId...> [flags]
  node tools/generate-art.mjs --all [flags]

Flags:
  --all                every plant in the catalogue
  --quality <q>        low | medium | high            (default: medium)
  --kind <k>           both | catalog | container      (default: both)
  --force              regenerate even if the PNG exists
  --no-trim            keep the full canvas (skip trim)
  --concurrency <n>    parallel images                 (default: 2)
  --model <name>       image model                     (default: gpt-image-1)
  --out <dir>          output root                     (default: repo root)
  --dry-run            print the plan, no API calls
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }

  if (!VALID_QUALITY.has(opts.quality)) throw new Error(`--quality must be one of: ${[...VALID_QUALITY].join(', ')}`);
  if (!VALID_KIND.has(opts.kind)) throw new Error(`--kind must be one of: ${[...VALID_KIND].join(', ')}`);

  const catalogue = JSON.parse(await readFile(path.join(ROOT, 'data', 'plantcatalogue.json'), 'utf8'));
  const byId = new Map(catalogue.plants.map((p) => [p.id, p]));

  let plants;
  if (opts.all) {
    plants = catalogue.plants;
  } else {
    if (opts.ids.length === 0) { console.log(HELP); throw new Error('No plants given. Pass plant ids or --all.'); }
    plants = opts.ids.map((id) => {
      const p = byId.get(id);
      if (!p) throw new Error(`Unknown plant id: "${id}"`);
      return p;
    });
  }

  const kinds = opts.kind === 'both' ? ['catalog', 'container'] : [opts.kind];

  // Build the work list (one item per image), respecting --force.
  const jobs = [];
  for (const plant of plants) {
    for (const kind of kinds) {
      const dir = kind === 'catalog' ? 'catalog' : 'plants';
      const rel = `${dir}/${plant.id}.png`;
      const abs = path.join(opts.out, rel);
      if (!opts.force && existsSync(abs)) {
        console.log(`= skip  ${rel} (exists; use --force to redo)`);
        continue;
      }
      jobs.push({
        plant,
        kind,
        rel,
        abs,
        prompt: kind === 'catalog' ? plant.catalogPrompt : plant.containerPrompt,
        size: SIZE[kind],
      });
    }
  }

  console.log(`\nThe Container Studio · ${plants.length} plant(s) · kinds: ${kinds.join('+')} · quality: ${opts.quality} · model: ${opts.model}`);
  console.log(`${jobs.length} image(s) to generate${opts.dryRun ? ' (dry run)' : ''}.\n`);

  if (opts.dryRun) {
    for (const j of jobs) console.log(`~ would generate ${j.rel}  [${j.size}]`);
    return;
  }
  if (jobs.length === 0) { console.log('Nothing to do.'); return; }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. Add it to your environment or .env (see .env.example).');
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  await mkdir(path.join(opts.out, 'catalog'), { recursive: true });
  await mkdir(path.join(opts.out, 'plants'), { recursive: true });

  // Load (or start) the manifest.
  const manifestPath = path.join(opts.out, 'data', 'art-manifest.json');
  const manifest = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, 'utf8'))
    : {};

  let done = 0;
  let failed = 0;

  // Simple fixed-size worker pool over the job list.
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const label = `${job.plant.id} ${job.kind}`;
      try {
        console.log(`> ${label} …`);
        let buf = await generateImage(client, {
          prompt: job.prompt, size: job.size, quality: opts.quality, model: opts.model,
        });
        if (opts.trim) buf = await trimToContent(buf);
        await writeFile(job.abs, buf);

        const meta = await sharp(buf).metadata();
        const { w, h } = designDimensions(job.kind, job.plant.role, meta.width, meta.height);
        manifest[job.plant.id] ??= {};
        manifest[job.plant.id][job.kind] = {
          href: job.rel, w, h, px: { w: meta.width, h: meta.height },
        };
        done++;
        console.log(`  ✓ ${job.rel}  ${meta.width}x${meta.height}px  ->  ${w}x${h} units`);
      } catch (err) {
        failed++;
        console.error(`  ✗ ${label}: ${err?.message ?? err}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, jobs.length) }, worker));

  // Persist the manifest (sorted for stable diffs).
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(manifestPath, JSON.stringify(sorted, null, 2) + '\n');

  console.log(`\nDone. ${done} generated, ${failed} failed. Manifest: data/art-manifest.json`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nError: ${err?.message ?? err}`);
  process.exit(1);
});

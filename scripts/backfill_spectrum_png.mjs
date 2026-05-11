#!/usr/bin/env node
/**
 * Backfill missing <prefix>_spectrum.png by calling IPKISS API
 *   POST /ipkiss/spectrum/render_from_snp
 * for every .s2p/.s3p/.s4p/.s8p file in the results directories that
 * doesn't already have a sibling _spectrum.png.
 *
 * Usage:
 *   node scripts/backfill_spectrum_png.mjs                  # process all
 *   node scripts/backfill_spectrum_png.mjs --limit 10       # only first 10
 *   node scripts/backfill_spectrum_png.mjs --dry-run        # plan only, no calls
 *   node scripts/backfill_spectrum_png.mjs --spacing 200    # ms delay between calls
 *   node scripts/backfill_spectrum_png.mjs --ipkiss URL     # override base URL
 *   node scripts/backfill_spectrum_png.mjs --dirs A,B       # override results dirs
 *
 * Default IPKISS URL: http://localhost:8000
 * Default dirs: D:/photonic-platform/ipkiss-api/results, results_test_dc
 */

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
function arg(flag, def) {
  const i = argv.indexOf(flag);
  if (i === -1) return def;
  return argv[i + 1];
}
function flag(name) {
  return argv.includes(name);
}

const IPKISS_URL = arg("--ipkiss", "http://localhost:8000");
const LIMIT      = Number(arg("--limit", "0"));
const SPACING_MS = Number(arg("--spacing", "150"));
const TIMEOUT_MS = Number(arg("--timeout", "60000"));
const DRY_RUN    = flag("--dry-run");
const VERBOSE    = flag("--verbose");

const DEFAULT_DIRS = [
  "D:/photonic-platform/ipkiss-api/results",
  "D:/photonic-platform/ipkiss-api/results_test_dc",
];
const RESULTS_DIRS = (arg("--dirs", DEFAULT_DIRS.join(","))).split(",").map((s) => s.trim()).filter(Boolean);

const SNP_RE = /\.s\d+p$/i;

function listSnpFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => SNP_RE.test(f))
    .map((name) => ({ dir, name, full: path.join(dir, name) }));
}

function spectrumPngFor(snpFull) {
  // strip .sNp suffix, append _spectrum.png
  const stem = snpFull.replace(/\.s\d+p$/i, "");
  return `${stem}_spectrum.png`;
}

async function renderOne(snpAbs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${IPKISS_URL}/ipkiss/spectrum/render_from_snp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snp_path: snpAbs }),
      signal: ctrl.signal,
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch { /* keep raw */ }
    return { status: r.status, body: j ?? txt };
  } catch (e) {
    return { status: 0, body: { error: String(e) } };
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Scanning ${RESULTS_DIRS.length} dirs for .sNp files…`);
  const allSnps = RESULTS_DIRS.flatMap(listSnpFiles);
  console.log(`  found ${allSnps.length} sNp files total`);

  const todo = [];
  let alreadyHave = 0;
  for (const it of allSnps) {
    const pngPath = spectrumPngFor(it.full);
    if (fs.existsSync(pngPath)) { alreadyHave += 1; continue; }
    todo.push({ snp: it.full, png: pngPath });
  }
  console.log(`  ${alreadyHave} already have _spectrum.png (skip)`);
  console.log(`  ${todo.length} need backfill`);

  const work = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;
  if (work.length < todo.length) {
    console.log(`  --limit ${LIMIT} → only doing first ${work.length}`);
  }

  if (DRY_RUN) {
    console.log("\n(dry-run, listing first 10 targets)\n");
    for (const w of work.slice(0, 10)) console.log("  ", path.basename(w.snp));
    if (work.length > 10) console.log(`  …and ${work.length - 10} more`);
    return;
  }

  if (work.length === 0) { console.log("Nothing to do."); return; }

  console.log(`\nIPKISS: ${IPKISS_URL}`);
  console.log(`Spacing: ${SPACING_MS}ms between calls\n`);

  let ok = 0, fail = 0;
  const t0 = Date.now();
  for (let i = 0; i < work.length; i++) {
    const { snp } = work[i];
    const base = path.basename(snp);
    const r = await renderOne(snp);
    const okFlag = r.status === 200 && r.body?.status === "ok";
    if (okFlag) ok += 1; else fail += 1;
    const elapsed = (Date.now() - t0) / 1000;
    const rate = (i + 1) / elapsed;
    const eta = Math.round((work.length - i - 1) / Math.max(rate, 0.01));
    const tag = okFlag ? "✓" : "✗";
    const detail = okFlag
      ? `n_traces=${r.body?.n_traces ?? "?"}${r.body?.cached ? " cached" : ""}`
      : `http=${r.status} err=${JSON.stringify(r.body)?.slice(0, 120)}`;
    console.log(
      `[${String(i + 1).padStart(4)}/${work.length}] ${tag} ${base.slice(0, 80)}  ` +
      `(${rate.toFixed(1)}/s, eta ${eta}s)${VERBOSE ? `  ${detail}` : ""}`,
    );
    if (!okFlag && VERBOSE) console.log("     detail:", detail);
    if (i + 1 < work.length) await sleep(SPACING_MS);
  }
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\nDone in ${elapsed.toFixed(1)}s — ok=${ok} fail=${fail}`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });

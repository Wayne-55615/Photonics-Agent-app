import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// RESULTS_DIRS: comma-separated absolute paths. Override via env on cloud
// deploys (Vercel can't read D:/ from the local Windows host — set this
// to a mounted/synced location or use IPKISS_RESULTS_URL as HTTP fallback).
const RESULTS_DIRS = (process.env.RESULTS_DIRS
  ?? "D:/photonic-platform/ipkiss-api/results,D:/photonic-platform/ipkiss-api/results_test_dc")
  .split(",").map((d) => path.resolve(d.trim())).filter(Boolean);

// IPKISS backend — used to backfill missing <prefix>_spectrum.png by reading
// the sibling .sNp via i3.SMatrix1DSweep.from_touchstone and plotting it.
const IPKISS_URL = process.env.IPKISS_URL ?? "http://localhost:8000";

const MIME: Record<string, string> = {
  ".s2p":  "text/plain",
  ".s4p":  "text/plain",
  ".s8p":  "text/plain",
  ".snp":  "text/plain",
  ".gds":  "application/octet-stream",
  ".gdsii":"application/octet-stream",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".html": "text/html",
  ".json": "application/json",
};

// Resolve filename to first existing absolute path under any RESULTS_DIRS.
function resolveResultsPath(filename: string): string | null {
  const safe = path.basename(filename);
  return RESULTS_DIRS
    .map((dir) => path.join(dir, safe))
    .find((candidate, index) => candidate.startsWith(RESULTS_DIRS[index]) && fs.existsSync(candidate)) ?? null;
}

// If filename matches "<prefix>_spectrum.png" and the file is missing, look
// for a sibling .sNp under the same prefix and ask IPKISS to render the PNG.
// Returns the path after successful render, else null.
async function tryBackfillSpectrumPng(filename: string): Promise<string | null> {
  const safe = path.basename(filename);
  const m = safe.match(/^(.+)_spectrum\.png$/i);
  if (!m) return null;
  const prefix = m[1];

  // Look for sibling sNp (.s2p / .s3p / .s4p / .s8p) in any results dir.
  let snpAbs: string | null = null;
  for (const dir of RESULTS_DIRS) {
    for (const ext of ["s2p", "s3p", "s4p", "s8p"]) {
      const candidate = path.join(dir, `${prefix}.${ext}`);
      if (fs.existsSync(candidate)) { snpAbs = candidate; break; }
    }
    if (snpAbs) break;
  }
  if (!snpAbs) return null;

  // Ask IPKISS API to render. It will save next to the sNp as <prefix>_spectrum.png.
  try {
    const res = await fetch(`${IPKISS_URL}/ipkiss/spectrum/render_from_snp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snp_path: snpAbs }),
      // i3.SpectrumAnalyzer + matplotlib is fast (< 1s for a single trace).
      // 30s ceiling is generous so we don't kill long renders on big sweeps.
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (j?.status !== "ok" || !j?.png_path) return null;
    // Re-resolve from local filesystem so we serve the canonical path.
    return resolveResultsPath(safe);
  } catch {
    return null;
  }
}

// Cheap fs check: does sibling .s2p/.s3p/.s4p/.s8p exist for a given
// "<prefix>_spectrum.png" request? Used by HEAD so a probe returns 200
// when GET would self-heal via the IPKISS render endpoint.
function siblingSnpExists(filename: string): boolean {
  const m = filename.match(/^(.+)_spectrum\.png$/i);
  if (!m) return false;
  const prefix = m[1];
  for (const dir of RESULTS_DIRS) {
    for (const ext of ["s2p", "s3p", "s4p", "s8p"]) {
      if (fs.existsSync(path.join(dir, `${prefix}.${ext}`))) return true;
    }
  }
  return false;
}

// HEAD: lightweight existence probe. Lets the frontend decide whether a
// derived sibling artifact (e.g. <prefix>_layout.html) exists before pointing
// an <iframe> at it (avoids rendering a 404 JSON body inside the layout pane).
// For "_spectrum.png" requests we ALSO report 200 when a sibling sNp exists
// (GET will self-heal by asking IPKISS to render it).
export async function HEAD(
  _req: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  const safe = path.basename(filename);
  if (resolveResultsPath(safe)) return new NextResponse(null, { status: 200 });
  if (siblingSnpExists(safe)) return new NextResponse(null, { status: 200 });
  return new NextResponse(null, { status: 404 });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  const safe = path.basename(filename);
  let full = resolveResultsPath(filename);

  // If a "_spectrum.png" is requested but doesn't exist on disk, try to
  // generate it from a sibling sNp via the IPKISS backend. Skip on HEAD —
  // HEAD is used for cheap probes and shouldn't trigger expensive renders.
  if (!full && /_spectrum\.png$/i.test(safe)) {
    full = await tryBackfillSpectrumPng(safe);
  }

  const ext = path.extname(safe).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  const isText = ["text/plain", "application/json", "image/svg+xml", "text/html"].includes(mime);

  try {
    if (!full) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    // Inline-displayable: text + images (PNG/SVG). Force-download only for true
    // binaries (.gds, octet-stream) so derived PNG previews render in <img> tags
    // when the GDS Layout panel falls back to siblings of a case-hit's gds_filename.
    const isInlineImage = mime.startsWith("image/");
    const headers: Record<string, string> = { "Content-Type": mime };
    if (!isText && !isInlineImage) {
      headers["Content-Disposition"] = `attachment; filename="${safe}"`;
    }
    if (isText) {
      const content = fs.readFileSync(full, "utf-8");
      return new NextResponse(content, { headers });
    } else {
      const content = fs.readFileSync(full);
      return new NextResponse(content as unknown as BodyInit, { headers });
    }
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}

import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const RESULTS_DIRS = [
  path.resolve("D:/photonic-platform/ipkiss-api/results"),
  path.resolve("D:/photonic-platform/ipkiss-api/results_test_dc"),
];

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

// HEAD: lightweight existence probe. Lets the frontend decide whether a
// derived sibling artifact (e.g. <prefix>_layout.html) exists before pointing
// an <iframe> at it (avoids rendering a 404 JSON body inside the layout pane).
export async function HEAD(
  _req: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  const full = resolveResultsPath(filename);
  return new NextResponse(null, { status: full ? 200 : 404 });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  const safe = path.basename(filename);
  const full = resolveResultsPath(filename);

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

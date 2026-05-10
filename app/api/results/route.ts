import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// RESULTS_DIRS: comma-separated absolute paths to IPKISS results dirs.
// Default targets the local Windows install; override on Vercel/cloud
// deploys where the host filesystem differs (or use IPKISS_RESULTS_URL
// to fetch over HTTP from a tunneled IPKISS API instead).
const RESULTS_DIRS = (process.env.RESULTS_DIRS
  ?? "D:/photonic-platform/ipkiss-api/results,D:/photonic-platform/ipkiss-api/results_test_dc")
  .split(",").map((d) => path.resolve(d.trim())).filter(Boolean);

export async function GET() {
  try {
    const files = RESULTS_DIRS.flatMap((dir) => {
      if (!fs.existsSync(dir)) return [];

      return fs.readdirSync(dir)
        .filter((f) => /\.s\d+p$/i.test(f))
        .map((name) => {
          const full = path.join(dir, name);
          const stat = fs.statSync(full);
          return {
            name,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          };
        });
    })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 200)
      .map(({ name, size }) => ({ name, size }));

    return NextResponse.json({ files });
  } catch {
    return NextResponse.json({ files: [], error: "Cannot read results directories" });
  }
}

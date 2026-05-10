import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const RESULTS_DIRS = [
  path.resolve("D:/photonic-platform/ipkiss-api/results"),
  path.resolve("D:/photonic-platform/ipkiss-api/results_test_dc"),
];

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

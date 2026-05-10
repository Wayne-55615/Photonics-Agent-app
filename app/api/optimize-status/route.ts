import { NextResponse } from "next/server";

const N8N_URL = process.env.N8N_URL ?? "http://localhost:5678";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const runId = url.searchParams.get("run_id");
  if (!runId) {
    return NextResponse.json({ found: false, error: "run_id is required" }, { status: 400 });
  }

  try {
    const res = await fetch(`${N8N_URL}/webhook/optimize-status?run_id=${encodeURIComponent(runId)}`);
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (e) {
    return NextResponse.json({ found: false, error: String(e) }, { status: 502 });
  }
}

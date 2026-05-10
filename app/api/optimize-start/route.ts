import { NextResponse } from "next/server";

const N8N_URL = process.env.N8N_URL ?? "http://localhost:5678";

export async function POST(req: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ status: "error", message: "invalid JSON body" }, { status: 400 });
  }

  if (!payload?.netlist_json) {
    return NextResponse.json({ status: "error", message: "netlist_json is required" }, { status: 400 });
  }

  try {
    const res = await fetch(`${N8N_URL}/webhook/optimize-wdm-mzi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (e) {
    return NextResponse.json({ status: "error", message: String(e) }, { status: 502 });
  }
}

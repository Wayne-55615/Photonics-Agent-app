import { NextResponse } from "next/server";

const IPKISS_URL = process.env.IPKISS_URL ?? "http://localhost:8000";

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
    // Tier-1 closed-loop gate: judge = run_project_replay + 4-check evaluation in one call.
    // Result carries artifacts (same keys as project/replay) plus {status, evaluation, spectrum},
    // so downstream code (sendReplay / renderBot) continues to work while gaining the judge.
    const res = await fetch(`${IPKISS_URL}/ipkiss/judge/wdm_mzi`, {
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

import { NextResponse } from "next/server";

// Pure design-point query — no GDS / Touchstone / spectrum produced.
// Forwards to /ipkiss/component/wdm_transmitter_mzi/halfband_recommend.
// On 404 (older server without the route), client side falls back to the
// linear approximation, so do not surface the upstream error.
const IPKISS_URL = process.env.IPKISS_URL ?? "http://localhost:8000";

export async function POST(req: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ status: "error", message: "invalid JSON body" }, { status: 400 });
  }

  try {
    const res = await fetch(`${IPKISS_URL}/ipkiss/component/wdm_transmitter_mzi/halfband_recommend`, {
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

import { NextResponse } from "next/server";

// Calibration loop step 1 proxy: forwards to
// /ipkiss/calibrate/lattice_inverse_fit. Body shape mirrors that endpoint:
//   { design: {...}, touchstone_path?: str, measured?: {...}, fit_options?: {...} }
// On 404 (older IPKISS server without the route) the client side renders a
// friendly "endpoint not deployed" message — we forward whatever upstream says.

const IPKISS_URL = process.env.IPKISS_URL ?? "http://localhost:8000";

export async function POST(req: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ status: "error", message: "invalid JSON body" }, { status: 400 });
  }

  try {
    const res = await fetch(`${IPKISS_URL}/ipkiss/calibrate/lattice_inverse_fit`, {
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

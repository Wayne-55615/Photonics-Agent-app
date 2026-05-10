import { NextResponse } from "next/server";

// Proxy: browser → /api/chat → n8n B flow webhook (Chat Query Router 0418 cc).
// Lets the public deployment expose ONLY the frontend host while n8n stays on
// a docker-internal network. N8N_WEBHOOK_URL is server-side only — it never
// reaches the browser.
const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL ??
  "http://localhost:5678/webhook/invoke_n8n_agent";

// IPKISS sims can take 30s+. Default fetch timeout in some runtimes is short.
export const maxDuration = 120;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const upstream = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type") ?? "application/json";
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": contentType },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "n8n webhook unreachable", detail: String(e) },
      { status: 502 },
    );
  }
}

import { NextResponse } from "next/server";

// Proxy: browser → /api/a-chat → n8n A flow webhook (A_flow_llm_agent_tools_compare).
// Used by /abstats "Run a test query" button. Server-side env var keeps n8n
// off the public internet.
const N8N_A_FLOW_URL =
  process.env.N8N_A_FLOW_URL ??
  "http://localhost:5678/webhook/a/agent-chat";

export const maxDuration = 120;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const upstream = await fetch(N8N_A_FLOW_URL, {
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
      { error: "n8n A flow webhook unreachable", detail: String(e) },
      { status: 502 },
    );
  }
}

import { NextResponse } from "next/server";

const GDS_API = process.env.GDS_API_URL ?? "http://localhost:8200";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const filePath = path.map(encodeURIComponent).join("/");
  const upstream = `${GDS_API}/fig/${filePath}`;

  try {
    const res = await fetch(upstream, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json({ error: "Not found" }, { status: res.status });
    }
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const buffer = await res.arrayBuffer();
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: { "Content-Type": contentType },
    });
  } catch {
    return NextResponse.json({ error: "GDS API unreachable" }, { status: 502 });
  }
}

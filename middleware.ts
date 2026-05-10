import { NextRequest, NextResponse } from "next/server";
import { verifySessionCookie, SESSION_COOKIE_NAME } from "@/utils/auth";

// Run in Node runtime so utils/auth (uses node:crypto HMAC) works.
export const config = {
  // Match everything except Next internals, static assets, and the login page.
  // The matcher excludes paths that must always be reachable (so the login
  // page itself, its static chunks, and favicon never 401-loop).
  matcher: [
    "/((?!_next/static|_next/image|_next/data|favicon\\.ico|file\\.svg|globe\\.svg|next\\.svg|vercel\\.svg|window\\.svg|login).*)",
  ],
  runtime: "nodejs",
};

const PUBLIC_API_PATHS = new Set<string>([
  "/api/auth/login",
  "/api/auth/logout",
]);

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Allow auth endpoints to pass through.
  if (PUBLIC_API_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionCookie(cookie);
  if (session) return NextResponse.next();

  // Unauthenticated. API → 401 JSON; pages → redirect to /login.
  if (pathname.startsWith("/api/")) {
    return new NextResponse(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

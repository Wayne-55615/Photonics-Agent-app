import { NextResponse } from "next/server";
import { checkCredentials, createSessionCookie } from "@/utils/auth";

export async function POST(req: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { username, password } = body ?? {};
  if (typeof username !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "username and password required" }, { status: 400 });
  }
  if (!checkCredentials(username, password)) {
    // Don't leak which field was wrong; sleep a bit to soften timing/brute force.
    await new Promise((r) => setTimeout(r, 250));
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }

  const cookie = createSessionCookie(username);
  const res = NextResponse.json({ ok: true, user: username });
  res.cookies.set({
    name: cookie.name,
    value: cookie.value,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: cookie.maxAge,
  });
  return res;
}

// Minimal HMAC-signed session cookie. No external deps.
// Cookie format: <base64url(payload_json)>.<hex(hmac_sha256(payload_b64))>
// Payload: { u: string, exp: number /* unix seconds */ }
//
// AUTH_SECRET (env, server-only) signs the cookie. AUTH_USER + AUTH_PASSWORD
// (env, server-only) are the credentials checked at login time.

import { createHmac, timingSafeEqual } from "crypto";

const COOKIE_NAME = "phsession";
const DEFAULT_TTL_DAYS = 7;

function getSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    // In dev we'd rather warn loud than silently use a weak key.
    throw new Error(
      "AUTH_SECRET env var must be set to a random string (>= 16 chars). " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return s;
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf-8") : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Buffer.from(padded, "base64").toString("utf-8");
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("hex");
}

export interface SessionPayload {
  u: string;
  exp: number;
}

export function createSessionCookie(
  username: string,
  ttlDays: number = DEFAULT_TTL_DAYS,
): { name: string; value: string; maxAge: number } {
  const exp = Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;
  const payload: SessionPayload = { u: username, exp };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = sign(payloadB64, getSecret());
  return {
    name: COOKIE_NAME,
    value: `${payloadB64}.${sig}`,
    maxAge: ttlDays * 24 * 60 * 60,
  };
}

export function verifySessionCookie(value: string | undefined): SessionPayload | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return null;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  let secret: string;
  try {
    secret = getSecret();
  } catch {
    return null;
  }

  const expected = sign(payloadB64, secret);
  // Constant-time compare to avoid signature timing leaks.
  let sigOk = false;
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    sigOk = a.length === b.length && timingSafeEqual(a, b);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return null;

  try {
    const payload = JSON.parse(fromB64url(payloadB64)) as SessionPayload;
    if (typeof payload.u !== "string" || typeof payload.exp !== "number") return null;
    if (Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function checkCredentials(username: string, password: string): boolean {
  const u = process.env.AUTH_USER;
  const p = process.env.AUTH_PASSWORD;
  if (!u || !p) return false;
  // Constant-time compare on UTF-8 bytes; pad shorter side so equal length.
  const a = Buffer.from(`${username}:${password}`);
  const b = Buffer.from(`${u}:${p}`);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;

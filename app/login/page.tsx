"use client";

import { useState, FormEvent, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  // Read ?next= from window.location to avoid useSearchParams Suspense
  // requirement that breaks the static prerender pass.
  const [next, setNext] = useState("/");
  useEffect(() => {
    if (typeof window !== "undefined") {
      const u = new URL(window.location.href);
      const n = u.searchParams.get("next");
      if (n) setNext(n);
    }
  }, []);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `Login failed (HTTP ${r.status})`);
      }
      router.replace(next);
      // Force a refresh so middleware re-evaluates with the new cookie.
      router.refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(circle at top, rgba(37,99,235,0.08), transparent 50%), linear-gradient(180deg, #f8fbff, #eef2f8)",
        padding: 16,
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          width: "100%",
          maxWidth: 380,
          background: "#fff",
          padding: 28,
          borderRadius: 14,
          boxShadow: "0 12px 32px rgba(37,99,235,0.12)",
          border: "1px solid rgba(37,99,235,0.12)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          fontFamily: "ui-sans-serif, system-ui",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: 4 }}>
          <div
            style={{
              fontSize: 11,
              letterSpacing: "0.2em",
              color: "#2563eb",
              fontWeight: 700,
              textTransform: "uppercase",
            }}
          >
            Photonics Agent
          </div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 800,
              margin: "6px 0 4px",
              color: "#0d1f3c",
              letterSpacing: "0.02em",
            }}
          >
            登入 / Sign in
          </h1>
          <div style={{ fontSize: 12, color: "#6b80a8" }}>
            請輸入帳號密碼 / Enter your credentials
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "#6b80a8", fontWeight: 600 }}>
            帳號 / Username
          </span>
          <input
            type="text"
            autoComplete="username"
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={inputStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "#6b80a8", fontWeight: 600 }}>
            密碼 / Password
          </span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
        </label>

        {error && (
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              background: "rgba(220,38,38,0.08)",
              border: "1px solid rgba(220,38,38,0.25)",
              color: "#b91c1c",
              fontSize: 13,
            }}
          >
            ⚠ {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !username || !password}
          style={{
            padding: "10px 14px",
            background: loading || !username || !password ? "#94a3b8" : "#2563eb",
            color: "#fff",
            fontWeight: 700,
            fontSize: 15,
            border: "none",
            borderRadius: 8,
            cursor: loading || !username || !password ? "not-allowed" : "pointer",
            letterSpacing: "0.04em",
            boxShadow: "0 2px 8px rgba(37,99,235,0.3)",
            transition: "background 0.15s",
          }}
        >
          {loading ? "登入中 / Signing in…" : "登入 / Sign in"}
        </button>

        <div style={{ fontSize: 11, color: "#9ca3af", textAlign: "center" }}>
          會話有效 7 天 / Session valid for 7 days
        </div>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "9px 12px",
  fontSize: 14,
  border: "1px solid #d8e2f0",
  borderRadius: 8,
  background: "#f5f8fe",
  color: "#0d1f3c",
  outline: "none",
  fontFamily: "inherit",
};

"use client";

import { useEffect, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
  LineChart, Line, CartesianGrid,
} from "recharts";
import Link from "next/link";

interface Overall {
  total: number;
  pass_n: number;
  partial_n: number;
  fail_n: number;
  avg_overall: number | null;
  avg_sem: number | null;
  avg_param: number | null;
}
interface TagRow {
  tag: string;
  n: number;
  pass_n: number;
  partial_n: number;
  fail_n: number;
  avg_overall: number | null;
}
interface DayRow {
  day: string;
  n: number;
  pass_n: number;
  partial_n: number;
  fail_n: number;
}
interface FailedRow { key: string; n: number; }
interface RecentRow {
  gds_filename: string | null;
  review_updated_at: string;
  verdict: string | null;
  overall_score: number | null;
  semantic_score: number | null;
  semantic_tag: string | null;
  failed_keys: string[] | null;
}

interface StatsData {
  overall: Overall;
  by_tag: TagRow[];
  by_day: DayRow[];
  by_failed: FailedRow[];
  recent: RecentRow[];
}

const VERDICT_COLORS: Record<string, string> = {
  pass:    "#16a34a",
  partial: "#d97706",
  fail:    "#dc2626",
};

function pct(n: number | null | undefined, d: number | null | undefined): string {
  if (!n || !d) return "0%";
  return `${Math.round((n / d) * 100)}%`;
}

function formatScore(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

export default function StatsPage() {
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/stats", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) { setData(json); setError(null); }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (loading) return <div style={{ padding: 40, color: "#64748b" }}>Loading…</div>;
  if (error)   return <div style={{ padding: 40, color: "#dc2626" }}>Error: {error}</div>;
  if (!data)   return <div style={{ padding: 40 }}>No data</div>;

  const o = data.overall;
  const verdictPie = [
    { name: "pass",    value: o.pass_n    ?? 0, fill: VERDICT_COLORS.pass },
    { name: "partial", value: o.partial_n ?? 0, fill: VERDICT_COLORS.partial },
    { name: "fail",    value: o.fail_n    ?? 0, fill: VERDICT_COLORS.fail },
  ];
  const tagRows = (data.by_tag ?? []).map(r => ({
    ...r,
    pass_pct:    r.n ? Math.round((r.pass_n    / r.n) * 100) : 0,
    partial_pct: r.n ? Math.round((r.partial_n / r.n) * 100) : 0,
    fail_pct:    r.n ? Math.round((r.fail_n    / r.n) * 100) : 0,
  }));

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1200, margin: "0 auto", background: "#f5f8fe", minHeight: "100vh" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "#0d1f3c", flex: 1 }}>
          Review Statistics
        </h1>
        <Link href="/" style={{ fontSize: 13, color: "#2563eb", textDecoration: "none" }}>
          ← Back to chat
        </Link>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 18 }}>
        <StatCard label="Total reviewed"   value={String(o.total ?? 0)} />
        <StatCard label="Pass rate"        value={pct(o.pass_n, o.total)} color="#16a34a" />
        <StatCard label="Avg overall"      value={formatScore(o.avg_overall)} />
        <StatCard label="Avg semantic"     value={formatScore(o.avg_sem)} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
        <Card title="Verdict distribution">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={verdictPie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                {verdictPie.map((e) => <Cell key={e.name} fill={e.fill} />)}
              </Pie>
              <Legend />
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Per semantic_tag — verdict counts">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={tagRows}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="tag" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="pass_n"    stackId="v" fill={VERDICT_COLORS.pass}    name="pass" />
              <Bar dataKey="partial_n" stackId="v" fill={VERDICT_COLORS.partial} name="partial" />
              <Bar dataKey="fail_n"    stackId="v" fill={VERDICT_COLORS.fail}    name="fail" />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
        <Card title="Reviews per day (30d)">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data.by_day}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="pass_n"    stroke={VERDICT_COLORS.pass}    name="pass" />
              <Line type="monotone" dataKey="partial_n" stroke={VERDICT_COLORS.partial} name="partial" />
              <Line type="monotone" dataKey="fail_n"    stroke={VERDICT_COLORS.fail}    name="fail" />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Top failed parameters">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.by_failed} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
              <YAxis type="category" dataKey="key" tick={{ fontSize: 10 }} width={140} />
              <Tooltip />
              <Bar dataKey="n" fill="#dc2626" />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card title="Recent 20 reviews">
        <div style={{ overflow: "auto", maxHeight: 360 }}>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead style={{ position: "sticky", top: 0, background: "#f1f5f9", zIndex: 1 }}>
              <tr>
                <Th>Time</Th><Th>Verdict</Th><Th>Tag</Th>
                <Th align="right">Overall</Th><Th align="right">Semantic</Th>
                <Th>Failed keys</Th><Th>GDS</Th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((r, i) => (
                <tr key={i} style={{ borderTop: "1px solid #e2e8f0" }}>
                  <Td>{new Date(r.review_updated_at).toLocaleString()}</Td>
                  <Td>
                    <span style={{
                      padding: "1px 6px", borderRadius: 4,
                      background: r.verdict ? `${VERDICT_COLORS[r.verdict]}22` : "#e2e8f0",
                      color:      r.verdict ? VERDICT_COLORS[r.verdict] : "#64748b",
                      fontWeight: 700,
                    }}>
                      {r.verdict ?? "—"}
                    </span>
                  </Td>
                  <Td>{r.semantic_tag ?? "—"}</Td>
                  <Td align="right">{formatScore(r.overall_score)}</Td>
                  <Td align="right">{formatScore(r.semantic_score)}</Td>
                  <Td style={{ fontFamily: "monospace", color: "#991b1b", fontSize: 11 }}>
                    {(r.failed_keys ?? []).join(", ") || "—"}
                  </Td>
                  <Td style={{ fontFamily: "monospace", fontSize: 11, color: "#475569" }}>
                    {r.gds_filename ?? "—"}
                  </Td>
                </tr>
              ))}
              {data.recent.length === 0 && (
                <tr><Td colSpan={7} style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>No reviews yet</Td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{
      padding: 14, borderRadius: 10, background: "#fff", border: "1px solid #d8e2f0",
      boxShadow: "0 1px 4px rgba(37,99,235,0.06)",
    }}>
      <div style={{ fontSize: 11, color: "#6b80a8", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: color ?? "#0d1f3c", marginTop: 4, fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      padding: 14, borderRadius: 10, background: "#fff", border: "1px solid #d8e2f0",
      boxShadow: "0 1px 4px rgba(37,99,235,0.06)",
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#6b80a8", marginBottom: 8, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th style={{ textAlign: align ?? "left", padding: "6px 8px", fontWeight: 700, color: "#475569" }}>
      {children}
    </th>
  );
}
function Td({ children, align, style, colSpan }: { children: React.ReactNode; align?: "left" | "right"; style?: React.CSSProperties; colSpan?: number }) {
  return (
    <td colSpan={colSpan} style={{ textAlign: align ?? "left", padding: "6px 8px", ...style }}>
      {children}
    </td>
  );
}

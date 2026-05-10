"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface FlowStats {
  total: number;
  success_ok: number;
  success_fail: number;
  success_rate: number | null;
  endpoint_match_total: number;
  endpoint_match_ok: number;
  endpoint_match_rate: number | null;
  spectrum_evaluated: number;
  spectrum_score_sum: number;
  spectrum_total_sum: number;
  spectrum_avg_rate: number | null;
  netlist_evaluated: number;
  netlist_score_sum: number;
  netlist_total_sum: number;
  netlist_avg_rate: number | null;
  io_spectrum_ok: number;
  io_spectrum_total: number;
  io_spectrum_rate: number | null;
  io_netlist_ok: number;
  io_netlist_total: number;
  io_netlist_rate: number | null;
  // PRIMARY truth metrics
  tool_hit_ok: number;
  tool_hit_total: number;
  tool_hit_rate: number | null;
  input_hit_ok: number;
  input_hit_total: number;
  input_hit_rate: number | null;
  param_drift: { param: string; requested_n: number; passed_n: number; hit_rate: number | null }[];
  param_drift_by_intent: Record<string, { param: string; requested_n: number; passed_n: number; hit_rate: number | null }[]>;
  latency_ms_avg: number | null;
  latency_ms_max: number | null;
  latency_count: number;
  tok_count: number;
  tok_prompt_sum: number;
  tok_completion_sum: number;
  tok_total_sum: number;
  tok_total_avg: number | null;
  tok_estimated_count: number;
  // Component evaluation 5-score averages
  evaluated: number;
  avg_input: number | null;
  avg_parameter_match: number | null;
  avg_output: number | null;
  avg_semantic: number | null;
  avg_execution: number | null;
  avg_overall: number | null;
  verdict_counts: Record<string, number>;
  by_intent: { intent: string; n: number; ok: number; rate: number | null }[];
}

interface RecentA {
  sim_id: string;
  created_at: string;
  user_message: string | null;
  tool: string | null;
  endpoint_called: string | null;
  expected_endpoint: string | null;
  endpoint_match: boolean | null;
  http_status: string | null;
  guided: boolean;
}

interface RecentB {
  sim_id: string;
  created_at: string;
  gds_filename: string | null;
  inferred_endpoint: string | null;
  status: string | null;
}

interface BatchInfo {
  batch_id: string;
  started_at: string;
  ended_at: string;
  rows: number;
}

interface AbStatsResp {
  A_unguided: FlowStats;
  A_guided:   FlowStats;
  B:          FlowStats;
  untagged:   FlowStats;
  recent_A:   RecentA[];
  recent_B:   RecentB[];
  batch_id_filter: string | null;
  available_batches: BatchInfo[];
  generated_at: string;
}

// Uniform "force simulate <Component> ..." format — prefix triggers
// features.force_simulate=true so B flow's router reaches sim sub-workflow
// (bypasses LLM classifier ambiguity).
const TEST_PROMPTS = [
  {
    label: "force simulate Mux4Configurable center_wavelength 1.55 FSR 50nm spacing_x 50 spacing_y 80 bend_radius 5 wl_start 1.48 wl_stop 1.64 n_points 1001",
    endpoint: "/ipkiss/component/wdm_transmitter_mzi",
  },
  {
    label: "force simulate MZILatticeFilter center_wavelength 1.55 FSR 20nm wl_start 1.50 wl_stop 1.60 n_points 1001",
    endpoint: "/ipkiss/component/wdm_transmitter_mzi",
  },
  {
    label: "force simulate Mux2 center_wavelength 1.55 FSR 50nm wl_start 1.50 wl_stop 1.60 n_points 1001",
    endpoint: "/ipkiss/component/wdm_transmitter_mzi",
  },
  {
    label: "force simulate wg_straight wg_family si_wire core_width_um 0.47 length_um 100 wl_start 1.50 wl_stop 1.60 n_points 1001",
    endpoint: "/ipkiss/waveguide/wg_straight",
  },
  {
    label: "force simulate MMI wl_start 1.50 wl_stop 1.60 n_points 1001",
    endpoint: "/ipkiss/component/mmi",
  },
  {
    label: "force simulate racetrack_resonator bend_radius 10 wl_start 1.50 wl_stop 1.60 n_points 1001",
    endpoint: "/ipkiss/component/racetrack_resonator",
  },
];

const A_FLOW_URL =
  process.env.NEXT_PUBLIC_A_FLOW_URL ?? "http://localhost:5678/webhook/a/agent-chat";

function pct(n: number | null): string {
  if (n == null) return "—";
  return (n * 100).toFixed(1) + "%";
}

function StatBlock({ title, stats, color }: { title: string; stats: FlowStats; color: string }) {
  return (
    <div style={{
      flex: 1,
      border: `2px solid ${color}`,
      borderRadius: 8,
      padding: 16,
      background: "#fafafa",
    }}>
      <h3 style={{ margin: 0, color, fontSize: 18 }}>{title}</h3>
      <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.7 }}>
        <div><strong>Total runs:</strong> {stats.total}</div>

        {/* PRIMARY METRICS — surface first */}
        <div style={{
          marginTop: 8,
          padding: 8,
          background: "#fff",
          border: `1px solid ${color}`,
          borderRadius: 4,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color, marginBottom: 4 }}>
            Tool hit · Input hit
          </div>
          <div>
            <strong>Tool hit:</strong>{" "}
            {stats.tool_hit_total > 0
              ? `${stats.tool_hit_ok}/${stats.tool_hit_total} (${pct(stats.tool_hit_rate)})`
              : "—"}
            <span style={{ fontSize: 11, color: "#999", marginLeft: 4 }}>
              (LLM/router actually called sim tool)
            </span>
          </div>
          <div>
            <strong>Input param hit:</strong>{" "}
            {stats.input_hit_total > 0
              ? `${stats.input_hit_ok}/${stats.input_hit_total} (${pct(stats.input_hit_rate)})`
              : "—"}
            <span style={{ fontSize: 11, color: "#999", marginLeft: 4 }}>
              (per-param hit, conditional on tool_hit pass)
            </span>
          </div>
          <div style={{
            marginTop: 6,
            paddingTop: 6,
            borderTop: "1px dashed #ddd",
            fontSize: 12,
            color: "#444",
            lineHeight: 1.5,
          }}>
            <div>
              <strong>⏱ Latency:</strong>{" "}
              {stats.latency_count > 0
                ? `avg ${((stats.latency_ms_avg ?? 0) / 1000).toFixed(2)}s · max ${((stats.latency_ms_max ?? 0) / 1000).toFixed(2)}s`
                : "—"}
              <span style={{ fontSize: 11, color: "#999", marginLeft: 4 }}>
                ({stats.latency_count} calls, from JSONL)
              </span>
            </div>
            <div>
              <strong>🪙 LLM tokens:</strong>{" "}
              {stats.tok_total_sum > 0
                ? `${stats.tok_total_sum.toLocaleString()} total · ${stats.tok_total_avg}/run`
                : "—"}
              {stats.tok_total_sum > 0 && (
                <span style={{ fontSize: 11, color: "#999", marginLeft: 4 }}>
                  (prompt {stats.tok_prompt_sum.toLocaleString()} / completion {stats.tok_completion_sum.toLocaleString()}
                  {stats.tok_estimated_count > 0 && ` · all estimated`})
                </span>
              )}
            </div>
          </div>
          {stats.param_drift && stats.param_drift.length > 0 && (
            <details style={{ marginTop: 4, fontSize: 12 }}>
              <summary style={{ cursor: "pointer", color: "#666" }}>
                Per-param drift — aggregate ({stats.param_drift.filter(p => p.hit_rate !== 1).length} of {stats.param_drift.length} drifting)
              </summary>
              <table style={{ width: "100%", marginTop: 4, fontSize: 11 }}>
                <thead>
                  <tr style={{ background: "#eee" }}>
                    <th style={{ textAlign: "left", padding: "1px 4px" }}>param</th>
                    <th style={{ textAlign: "right", padding: "1px 4px" }}>req</th>
                    <th style={{ textAlign: "right", padding: "1px 4px" }}>pass</th>
                    <th style={{ textAlign: "right", padding: "1px 4px" }}>rate</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.param_drift.map((p) => (
                    <tr key={p.param}>
                      <td style={{ padding: "1px 4px" }}>{p.param}</td>
                      <td style={{ padding: "1px 4px", textAlign: "right" }}>{p.requested_n}</td>
                      <td style={{ padding: "1px 4px", textAlign: "right" }}>{p.passed_n}</td>
                      <td style={{
                        padding: "1px 4px",
                        textAlign: "right",
                        color: (p.hit_rate ?? 1) < 0.9 ? "#a01525" : "#444",
                        fontWeight: (p.hit_rate ?? 1) < 0.9 ? 600 : 400,
                      }}>
                        {pct(p.hit_rate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          {stats.param_drift_by_intent && Object.keys(stats.param_drift_by_intent).length > 0 && (
            <details style={{ marginTop: 4, fontSize: 12 }}>
              <summary style={{ cursor: "pointer", color: "#666", fontWeight: 600 }}>
                Per-intent drift breakdown ({Object.keys(stats.param_drift_by_intent).length} intents)
              </summary>
              <div style={{ paddingLeft: 4, marginTop: 4 }}>
                {Object.entries(stats.param_drift_by_intent)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([intent, drifts]) => {
                    const failing = drifts.filter(p => (p.hit_rate ?? 1) < 1);
                    const totalReq = drifts.reduce((s, p) => s + p.requested_n, 0);
                    const totalPass = drifts.reduce((s, p) => s + p.passed_n, 0);
                    const intentRate = totalReq > 0 ? totalPass / totalReq : null;
                    return (
                      <details
                        key={intent}
                        open={failing.length > 0}
                        style={{
                          marginTop: 4,
                          padding: 4,
                          background: "#fafafa",
                          border: "1px solid #ddd",
                          borderRadius: 3,
                        }}
                      >
                        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                          {intent}{" "}
                          <span style={{ fontWeight: 400, color: "#666" }}>
                            — {totalPass}/{totalReq} ({pct(intentRate)})
                            {failing.length > 0 && (
                              <span style={{ color: "#a01525", marginLeft: 6 }}>
                                {failing.length} drifting
                              </span>
                            )}
                          </span>
                        </summary>
                        <table style={{ width: "100%", marginTop: 2, fontSize: 11 }}>
                          <thead>
                            <tr style={{ background: "#eee" }}>
                              <th style={{ textAlign: "left", padding: "1px 4px" }}>param</th>
                              <th style={{ textAlign: "right", padding: "1px 4px" }}>req</th>
                              <th style={{ textAlign: "right", padding: "1px 4px" }}>pass</th>
                              <th style={{ textAlign: "right", padding: "1px 4px" }}>rate</th>
                            </tr>
                          </thead>
                          <tbody>
                            {drifts.map((p) => (
                              <tr key={p.param}>
                                <td style={{ padding: "1px 4px" }}>{p.param}</td>
                                <td style={{ padding: "1px 4px", textAlign: "right" }}>{p.requested_n}</td>
                                <td style={{ padding: "1px 4px", textAlign: "right" }}>{p.passed_n}</td>
                                <td style={{
                                  padding: "1px 4px",
                                  textAlign: "right",
                                  color: (p.hit_rate ?? 1) < 0.9 ? "#a01525" : "#444",
                                  fontWeight: (p.hit_rate ?? 1) < 0.9 ? 600 : 400,
                                }}>
                                  {pct(p.hit_rate)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </details>
                    );
                  })}
              </div>
            </details>
          )}
        </div>

        {/* Component evaluation 5-score averages (parity with B's review pipeline) */}
        {stats.evaluated > 0 && (
          <details
            open
            style={{ marginTop: 10, paddingTop: 8, borderTop: "1px dashed #ccc" }}
          >
            <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
              Component Evaluation ({stats.evaluated} evaluated)
              <span style={{ fontSize: 10, fontWeight: 400, color: "#999", marginLeft: 6 }}>
                · all-rows average (NOT conditional on tool_hit)
              </span>
            </summary>
            <div style={{ fontSize: 12, lineHeight: 1.5, marginTop: 4 }}>
              <div><strong>Overall:</strong> {pct(stats.avg_overall)}</div>
              <div style={{ paddingLeft: 8, color: "#444" }}>
                <div>Semantic match (25%): {pct(stats.avg_semantic)}</div>
                <div>Input completeness (18.75%): {pct(stats.avg_input)}</div>
                <div>Parameter match (22.5%): {pct(stats.avg_parameter_match)}</div>
                <div>Output completeness (18.75%): {pct(stats.avg_output)}</div>
                <div>Execution success (15%): {pct(stats.avg_execution)}</div>
              </div>
              <div style={{ marginTop: 4 }}>
                <strong>Verdict:</strong>{" "}
                {Object.entries(stats.verdict_counts || {})
                  .filter(([, n]) => n > 0)
                  .map(([k, n]) => (
                    <span
                      key={k}
                      style={{
                        marginRight: 6,
                        padding: "1px 6px",
                        borderRadius: 3,
                        background:
                          k === "pass" ? "#cfe9d6" :
                          k === "partial" ? "#fff3cd" :
                          k === "fail" ? "#f5c6cb" : "#e0e0e0",
                        color:
                          k === "pass" ? "#0a7a2a" :
                          k === "partial" ? "#856400" :
                          k === "fail" ? "#a01525" : "#444",
                        fontSize: 11,
                      }}
                    >
                      {k}: {n}
                    </span>
                  ))}
              </div>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

export default function ABStatsPage() {
  const [data, setData] = useState<AbStatsResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [batchFilter, setBatchFilter] = useState<string>("");

  // For triggering test queries
  const [testPrompt, setTestPrompt] = useState(TEST_PROMPTS[0].label);
  const [testExpected, setTestExpected] = useState(TEST_PROMPTS[0].endpoint);
  const [testIncludeExpected, setTestIncludeExpected] = useState(true);
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function load(bid?: string) {
    setLoading(true);
    setError(null);
    try {
      const useBid = bid !== undefined ? bid : batchFilter;
      const url = useBid
        ? `/api/abstats?batch_id=${encodeURIComponent(useBid)}`
        : "/api/abstats";
      const r = await fetch(url, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "fetch failed");
      setData(j);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const i = setInterval(() => load(), 15000);
    return () => clearInterval(i);
  }, [batchFilter]);

  async function runATest() {
    setTestRunning(true);
    setTestResult(null);
    try {
      const r = await fetch(A_FLOW_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: testPrompt,
          // include expected_endpoint only when toggle is on — otherwise the
          // run is "unguided" (system prompt + tool descriptions only) and
          // counts in the A_unguided bucket.
          ...(testIncludeExpected && testExpected
            ? { expected_endpoint: testExpected }
            : {}),
        }),
      });
      const text = await r.text();
      let pretty = text;
      try {
        const j = JSON.parse(text);
        pretty = JSON.stringify(j, null, 2);
      } catch {/* keep raw */}
      setTestResult(`HTTP ${r.status}\n\n${pretty}`);
      // Refresh stats after a moment
      setTimeout(load, 1500);
    } catch (e: unknown) {
      setTestResult("ERROR: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setTestRunning(false);
    }
  }

  return (
    <div style={{ height: "100vh", overflowY: "auto", overflowX: "hidden" }}>
    <div style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>A/B flow comparison</h1>
        <Link href="/" style={{ fontSize: 14 }}>← Home</Link>
        <Link href="/stats" style={{ fontSize: 14 }}>Other stats</Link>
        <label style={{ fontSize: 13, color: "#444", display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 12 }}>
          Batch:
          <select
            value={batchFilter}
            onChange={(e) => setBatchFilter(e.target.value)}
            style={{ padding: "3px 8px", fontSize: 12, fontFamily: "ui-monospace, monospace" }}
          >
            <option value="">All (last 30d)</option>
            {data?.available_batches?.map((b) => {
              const t = b.started_at?.slice(11, 16) ?? "";
              const d = b.started_at?.slice(0, 10) ?? "";
              return (
                <option key={b.batch_id} value={b.batch_id}>
                  {b.batch_id} · {d} {t} · n={b.rows}
                </option>
              );
            })}
          </select>
        </label>
        <button
          onClick={() => load()}
          disabled={loading}
          style={{ padding: "4px 12px", marginLeft: "auto", cursor: "pointer" }}
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      <p style={{ color: "#666", fontSize: 13, marginTop: 8 }}>
        <strong>A flow</strong> = LLM langchain agent with HTTP tools (calls IPKISS via tool selection).{" "}
        <strong>B flow</strong> = current Chat Query Router (regex-based intent extraction).{" "}
        Stats aggregated from <code>sim_run.run_meta.flow_tag</code>.
        {data?.generated_at && (
          <span style={{ marginLeft: 8 }}>Generated {data.generated_at.slice(11, 19)} UTC</span>
        )}
      </p>

      {error && (
        <div style={{
          padding: 12, background: "#fee", border: "1px solid #c00",
          borderRadius: 4, marginTop: 12, fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {data && (
        <>
          <div style={{
            marginTop: 12,
            padding: 10,
            background: "#fff3cd",
            border: "1px solid #d4b400",
            borderRadius: 4,
            fontSize: 12,
            lineHeight: 1.5,
          }}>
            <strong>⚠ A flow caveat (2026-05-02)</strong>: the n8n toolHttpRequest{" "}
            <code>{"{placeholder}"}</code> substitution is unreliable in this version —
            LLM agent extracts args correctly (visible in{" "}
            <code>run_meta.intermediate_steps_summary</code>) but only 2 of 4 args reach
            IPKISS; the other 2 are silently dropped and IPKISS falls back to defaults
            (e.g. <code>wdm_type=Mux4</code>, <code>fsr=0.02</code>). HTTP 200 +
            file-existence checks pass but the simulation parameters are wrong. The{" "}
            <strong>parameter_match_score</strong> below is the only metric that catches
            this — A&apos;s low param-match vs B&apos;s high is the real signal. See
            memory <code>feedback_n8n_tool_http_placeholder_bug.md</code>.
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
            <StatBlock
              title="A flow (LLM agent + tools)"
              stats={data.A_unguided}
              color="#0a7"
            />
            <StatBlock
              title="B flow (current router)"
              stats={data.B}
              color="#06a"
            />
            {data.A_guided.total > 0 && (
              <StatBlock
                title="A guided (legacy, with expected_endpoint)"
                stats={data.A_guided}
                color="#0a3"
              />
            )}
          </div>
          <p style={{ color: "#666", fontSize: 12, marginTop: 4, marginBottom: 0 }}>
            Same prompts run through both flows. <strong>I/O — S-matrix</strong> = did the call
            produce a Touchstone (.sNp) file? <strong>I/O — Netlist</strong> = was a netlist JSON
            written? Stability = same prompt repeated N times → all-success means deterministic.
          </p>

          {data.untagged.total > 0 && (
            <div style={{
              marginTop: 16, padding: 12, background: "#fff3cd",
              border: "1px solid #d4b400", borderRadius: 4, fontSize: 13,
            }}>
              <strong>{data.untagged.total} untagged rows</strong> (legacy B-flow runs from before
              the flow_tag patch was applied). HTTP success {data.untagged.success_ok}/{data.untagged.total}{" "}
              ({pct(data.untagged.success_rate)}).
            </div>
          )}

          {/* Trigger test */}
          <div style={{
            marginTop: 24, padding: 16, border: "1px solid #ccc",
            borderRadius: 8, background: "#fafafa",
          }}>
            <h3 style={{ margin: "0 0 8px" }}>Trigger A flow test query</h3>
            <p style={{ fontSize: 13, color: "#666", margin: "0 0 12px" }}>
              Sends the prompt to the A flow webhook with an{" "}
              <code>expected_endpoint</code> label so endpoint-match can be scored. To test B flow,
              use the existing chat router (rows already inserted automatically with{" "}
              <code>flow_tag=&quot;B&quot;</code>).
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <select
                value={testPrompt}
                onChange={(e) => {
                  const choice = TEST_PROMPTS.find((p) => p.label === e.target.value);
                  setTestPrompt(e.target.value);
                  if (choice) setTestExpected(choice.endpoint);
                }}
                style={{ padding: 6, minWidth: 320 }}
              >
                {TEST_PROMPTS.map((p) => (
                  <option key={p.label} value={p.label}>{p.label}</option>
                ))}
              </select>
              <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  type="checkbox"
                  checked={testIncludeExpected}
                  onChange={(e) => setTestIncludeExpected(e.target.checked)}
                />
                guided
              </label>
              <input
                value={testExpected}
                onChange={(e) => setTestExpected(e.target.value)}
                placeholder="expected_endpoint (for scoring)"
                disabled={!testIncludeExpected}
                style={{ flex: 1, padding: 6, minWidth: 280, fontSize: 13, opacity: testIncludeExpected ? 1 : 0.5 }}
              />
              <button
                onClick={runATest}
                disabled={testRunning}
                style={{ padding: "6px 16px", cursor: "pointer" }}
              >
                {testRunning ? "Running..." : (testIncludeExpected ? "Send to A (guided)" : "Send to A (unguided)")}
              </button>
            </div>
            {testResult && (
              <pre style={{
                marginTop: 12, padding: 8, background: "#fff",
                border: "1px solid #ddd", fontSize: 12,
                maxHeight: 240, overflow: "auto",
              }}>
                {testResult}
              </pre>
            )}
          </div>

          {/* Recent rows */}
          <div style={{ display: "flex", gap: 16, marginTop: 24 }}>
            <div style={{ flex: 1, fontSize: 13 }}>
              <h3 style={{ marginTop: 0 }}>Recent A flow runs</h3>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#eee" }}>
                    <th style={{ textAlign: "left", padding: 4 }}>Time</th>
                    <th style={{ textAlign: "center", padding: 4 }}>Mode</th>
                    <th style={{ textAlign: "left", padding: 4 }}>Tool</th>
                    <th style={{ textAlign: "left", padding: 4 }}>Endpoint</th>
                    <th style={{ textAlign: "center", padding: 4 }}>Match</th>
                    <th style={{ textAlign: "right", padding: 4 }}>HTTP</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent_A.map((r) => (
                    <tr key={r.sim_id} style={{ borderBottom: "1px solid #eee" }}>
                      <td style={{ padding: 4, color: "#666" }}>
                        {r.created_at.slice(11, 19)}
                      </td>
                      <td style={{ padding: 4, textAlign: "center", fontSize: 11 }}>
                        {r.guided ? (
                          <span style={{ background: "#0a3", color: "#fff", padding: "0 4px", borderRadius: 3 }}>G</span>
                        ) : (
                          <span style={{ background: "#0a7", color: "#fff", padding: "0 4px", borderRadius: 3 }}>U</span>
                        )}
                      </td>
                      <td style={{ padding: 4 }}>{r.tool ?? "—"}</td>
                      <td style={{ padding: 4, fontSize: 11 }}>
                        {r.endpoint_called?.replace("/ipkiss/", "") ?? "—"}
                      </td>
                      <td style={{ padding: 4, textAlign: "center" }}>
                        {r.guided
                          ? (r.endpoint_match === true ? "✓" : r.endpoint_match === false ? "✗" : "—")
                          : <span style={{ color: "#999" }}>n/a</span>}
                      </td>
                      <td style={{ padding: 4, textAlign: "right" }}>{r.http_status ?? "—"}</td>
                    </tr>
                  ))}
                  {data.recent_A.length === 0 && (
                    <tr><td colSpan={6} style={{ padding: 8, color: "#999" }}>No A flow runs yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ flex: 1, fontSize: 13 }}>
              <h3 style={{ marginTop: 0 }}>Recent B flow runs</h3>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#eee" }}>
                    <th style={{ textAlign: "left", padding: 4 }}>Time</th>
                    <th style={{ textAlign: "left", padding: 4 }}>GDS</th>
                    <th style={{ textAlign: "left", padding: 4 }}>Inferred</th>
                    <th style={{ textAlign: "right", padding: 4 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent_B.map((r) => (
                    <tr key={r.sim_id} style={{ borderBottom: "1px solid #eee" }}>
                      <td style={{ padding: 4, color: "#666" }}>
                        {r.created_at.slice(11, 19)}
                      </td>
                      <td style={{ padding: 4, fontSize: 11, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.gds_filename ?? "—"}
                      </td>
                      <td style={{ padding: 4, fontSize: 11 }}>
                        {r.inferred_endpoint?.replace("/ipkiss/", "") ?? "—"}
                      </td>
                      <td style={{ padding: 4, textAlign: "right" }}>{r.status ?? "—"}</td>
                    </tr>
                  ))}
                  {data.recent_B.length === 0 && (
                    <tr><td colSpan={4} style={{ padding: 8, color: "#999" }}>No B flow runs (post-tag) yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
    </div>
  );
}

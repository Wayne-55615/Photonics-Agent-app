import { NextResponse } from "next/server";
import { getPool } from "@/utils/db";
import * as fs from "node:fs";
import * as path from "node:path";

export const dynamic = "force-dynamic";

// Read latency stats per flow from the batch JSONL log (if present).
// The script writes one line per call with `flow` ('A' or 'B') and `dt_ms`.
// Returns map: { A: {avg, max, count}, B: {avg, max, count} }.
function readBatchLatency(): Record<string, { avg: number | null; max: number | null; count: number }> {
  const out: Record<string, { sum: number; max: number; count: number }> = {};
  try {
    // Project root → scripts/ab_batch.jsonl
    const candidates = [
      path.resolve(process.cwd(), "..", "scripts", "ab_batch.jsonl"),
      path.resolve(process.cwd(), "scripts", "ab_batch.jsonl"),
      "D:/photonic-platform/scripts/ab_batch.jsonl",
    ];
    let logPath: string | null = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) { logPath = c; break; }
    }
    if (!logPath) return {};
    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        const flow = String(j.flow ?? "").toUpperCase();
        const dt = Number(j.dt_ms);
        if (!flow || !Number.isFinite(dt)) continue;
        if (!out[flow]) out[flow] = { sum: 0, max: 0, count: 0 };
        out[flow].sum += dt;
        out[flow].count += 1;
        if (dt > out[flow].max) out[flow].max = dt;
      } catch { /* skip malformed */ }
    }
  } catch { /* file missing — fine */ }
  const result: Record<string, { avg: number | null; max: number | null; count: number }> = {};
  for (const [k, v] of Object.entries(out)) {
    result[k] = { avg: v.count > 0 ? Math.round(v.sum / v.count) : null, max: v.max || null, count: v.count };
  }
  return result;
}

// Aggregate sim_run rows by run_meta.flow_tag = 'A' | 'B' to compare:
//   - HTTP success rate
//   - Endpoint correctness (when expected_endpoint is recorded — A flow only)
//   - Per-intent breakdown (derived from gds_filename prefix for B,
//     run_meta.endpoint_called for A)
// B flow's `run_meta.status` is 'ok'/'error' (legacy convention).
// A flow's `run_meta.http_status` is 200/500 (set by Code node).

// gds_filename prefix → IPKISS endpoint. Order matters: longer/more-specific
// prefixes must come BEFORE shorter ones so e.g. `gsgsg_*` and `gsg_*` aren't
// accidentally swallowed by a `g_*` rule. All 24 distinct prefixes observed
// in `sim_run` are covered here; new endpoints should append a row.
const INTENT_FROM_GDS_PREFIX: Array<[RegExp, string]> = [
  // 2-letter / specific / disambiguators first
  [/^wgpath[_-]/i,            "/ipkiss/waveguide/wg_path"],
  [/^wgstraight[_-]/i,        "/ipkiss/waveguide/wg_straight"],
  [/^fullawg[_-]/i,           "/ipkiss/component/si_fab_awg"],
  [/^gsgsg[_-]/i,             "/ipkiss/metal/rf_pad"],
  [/^bondpad[_-]/i,           "/ipkiss/metal/bondpad"],
  [/^spiral[_-]/i,            "/ipkiss/component/spiral"],
  [/^heater[_-]/i,            "/ipkiss/component/heater"],
  [/^cross[_-]/i,             "/ipkiss/circuit/crossing"],
  [/^racetrack[_-]/i,         "/ipkiss/component/racetrack_resonator"],
  [/^ring[_-]/i,              "/ipkiss/component/racetrack_resonator"],
  // 3-letter
  [/^wdm[_-]/i,               "/ipkiss/component/wdm_transmitter_mzi"],
  [/^mzi[_-]/i,               "/ipkiss/component/wdm_transmitter_mzi"],
  [/^mux[_-]/i,               "/ipkiss/component/wdm_transmitter_mzi"],
  [/^mmi[_-]/i,               "/ipkiss/component/mmi"],
  [/^mzm[_-]/i,               "/ipkiss/component/mzm"],
  [/^wire[_-]/i,              "/ipkiss/metal/wire"],
  [/^awg[_-]/i,               "/ipkiss/component/si_fab_awg"],
  [/^gsg[_-]/i,               "/ipkiss/metal/rf_pad"],
  [/^res[_-]/i,               "/ipkiss/component/resistor"],
  [/^sin[_-]/i,               "/ipkiss/component/sin_inverted_taper"],
  [/^via[_-]/i,               "/ipkiss/metal/via"],
  [/^metal[_-]/i,             "/ipkiss/metal/via"],   // generic "metal_*" → via fallback
  // 2-letter (must NOT collide with above 3+ prefixes)
  [/^wg[_-]/i,                "/ipkiss/waveguide/wg_straight"],
  [/^dc[_-]/i,                "/ipkiss/circuit/dir_coupler"],
  [/^rr[_-]/i,                "/ipkiss/component/racetrack_resonator"],
  [/^ps[_-]/i,                "/ipkiss/component/phase_shifter"],
  [/^fb[_-]/i,                "/ipkiss/component/fixed_bend"],
  [/^yb[_-]/i,                "/ipkiss/component/y_branch"],
  [/^gc[_-]|^grating/i,       "/ipkiss/component/grating_coupler"],
];

function inferEndpointFromGds(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const base = String(filename).toLowerCase();
  for (const [re, ep] of INTENT_FROM_GDS_PREFIX) {
    if (re.test(base)) return ep;
  }
  return null;
}

// Compact intent labels for the by-intent breakdown table. One label per
// endpoint URL — keep these short (≤ 12 chars) for table readability.
const ENDPOINT_TO_INTENT_LABEL: Array<[string, string]> = [
  ["/ipkiss/component/wdm_transmitter_mzi",    "wdm_mzi"],
  ["/ipkiss/waveguide/wg_straight",            "wg_straight"],
  ["/ipkiss/waveguide/wg_path",                "wg_path"],
  ["/ipkiss/circuit/dir_coupler",              "dir_coupler"],
  ["/ipkiss/circuit/crossing",                 "crossing"],
  ["/ipkiss/component/mmi",                    "mmi"],
  ["/ipkiss/component/racetrack_resonator",    "ring"],
  ["/ipkiss/component/si_fab_awg",             "awg"],
  ["/ipkiss/component/grating_coupler",        "gc"],
  ["/ipkiss/component/heater",                 "heater"],
  ["/ipkiss/component/mzm",                    "mzm"],
  ["/ipkiss/component/phase_shifter",          "phase_shift"],
  ["/ipkiss/component/fixed_bend",             "fixed_bend"],
  ["/ipkiss/component/y_branch",               "y_branch"],
  ["/ipkiss/component/spiral",                 "spiral"],
  ["/ipkiss/component/resistor",               "resistor"],
  ["/ipkiss/component/sin_inverted_taper",     "sin_taper"],
  ["/ipkiss/metal/bondpad",                    "bondpad"],
  ["/ipkiss/metal/rf_pad",                     "rf_pad"],
  ["/ipkiss/metal/via",                        "via/metal"],
  ["/ipkiss/metal/wire",                       "wire"],
];

function intentLabelFromEndpoint(ep: string | null): string {
  if (!ep) return "unknown";
  for (const [url, label] of ENDPOINT_TO_INTENT_LABEL) {
    if (ep === url) return label;
  }
  // Substring fallback for partial matches (e.g. legacy `/run_xxx` paths)
  for (const [url, label] of ENDPOINT_TO_INTENT_LABEL) {
    if (ep.includes(url.split("/").pop() ?? "")) return label;
  }
  return "other";
}

export async function GET(request: Request) {
  const pool = getPool();
  // Optional ?batch_id=YYYYMMDD_HHMMSS — narrows aggregation to one batch.
  // Without it, we keep the previous 30-day window for backward compatibility.
  const url = new URL(request.url);
  const batchIdFilter = url.searchParams.get("batch_id");
  try {
    const sql = `
      SELECT
        sim_id,
        gds_filename,
        created_at,
        ports_json,
        settings_json,
        run_meta,
        COALESCE(run_meta->>'flow_tag', '<untagged>') AS flow_tag,
        run_meta->>'status'           AS b_status,
        run_meta->>'http_status'      AS a_http_status,
        run_meta->>'last_tool'        AS a_tool,
        run_meta->>'endpoint_called'  AS a_endpoint_called,
        run_meta->>'expected_endpoint' AS a_expected_endpoint,
        (run_meta->>'endpoint_match')::boolean AS a_endpoint_match,
        run_meta->>'user_message'     AS user_message,
        (run_meta->'spectrum_correctness'->>'score')::int AS a_spectrum_score,
        (run_meta->'spectrum_correctness'->>'total')::int AS a_spectrum_total,
        (run_meta->'netlist_correctness'->>'score')::int  AS a_netlist_score,
        (run_meta->'netlist_correctness'->>'total')::int  AS a_netlist_total,
        (run_meta->'component_io'->>'spectrum')::int      AS io_spectrum,
        (run_meta->'component_io'->>'netlist')::int       AS io_netlist,
        -- Component evaluation scores: A flow stores under run_meta.component_evaluation,
        -- B flow stores at top of review_metadata. COALESCE picks whichever exists.
        (COALESCE(
          run_meta->'component_evaluation'->'scores'->>'input_score',
          review_metadata->>'input_score'
        ))::float AS s_input,
        (COALESCE(
          run_meta->'component_evaluation'->'scores'->>'parameter_match_score',
          review_metadata->>'parameter_match_score'
        ))::float AS s_param_match,
        (COALESCE(
          run_meta->'component_evaluation'->'scores'->>'output_score',
          review_metadata->>'output_score'
        ))::float AS s_output,
        (COALESCE(
          run_meta->'component_evaluation'->'scores'->>'semantic_match_score',
          review_metadata->>'semantic_match_score'
        ))::float AS s_semantic,
        (COALESCE(
          run_meta->'component_evaluation'->'scores'->>'execution_score',
          review_metadata->>'execution_score'
        ))::float AS s_execution,
        (COALESCE(
          run_meta->'component_evaluation'->'scores'->>'overall_score',
          review_metadata->>'overall_score'
        ))::float AS s_overall,
        COALESCE(
          run_meta->'component_evaluation'->>'verdict',
          review_metadata->>'verdict'
        ) AS verdict,
        -- Per-param input_checks: A under run_meta, B under review_metadata.
        -- Returned as JSONB so we can iterate keys client-side.
        COALESCE(
          run_meta->'component_evaluation'->'input_checks',
          review_metadata->'input_checks'
        ) AS input_checks_json,
        COALESCE(
          run_meta->'component_evaluation'->'output_checks',
          review_metadata->'output_checks'
        ) AS output_checks_json,
        -- Tool-hit signal: tool_calls_count from A's run_meta.
        -- B doesn't expose a direct count; fall back to "row exists" = 1.
        COALESCE(
          (run_meta->>'tool_calls_count')::int,
          1
        ) AS tool_calls_count,
        (run_meta->>'latency_ms')::int                          AS latency_ms,
        (run_meta->'llm_tokens'->>'prompt')::int                AS tok_prompt,
        (run_meta->'llm_tokens'->>'completion')::int            AS tok_completion,
        (run_meta->'llm_tokens'->>'total')::int                 AS tok_total,
        (run_meta->'llm_tokens'->>'estimated')::boolean         AS tok_estimated,
        run_meta->>'batch_id'                                   AS batch_id
      FROM sim_run
      WHERE run_meta IS NOT NULL
        ${batchIdFilter ? "AND run_meta->>'batch_id' = $1" : "AND created_at > now() - interval '30 days'"}
      ORDER BY created_at DESC
      LIMIT 5000
    `;
    const { rows } = await pool.query(
      sql,
      batchIdFilter ? [batchIdFilter] : [],
    );

    // Distinct batch_ids list (for selector). Always returns recent ones
    // independent of the filter so the dropdown stays populated.
    const batchListSql = `
      SELECT
        run_meta->>'batch_id' AS batch_id,
        MIN(created_at) AS started_at,
        MAX(created_at) AS ended_at,
        COUNT(*) AS rows
      FROM sim_run
      WHERE run_meta->>'batch_id' IS NOT NULL
        AND created_at > now() - interval '30 days'
      GROUP BY 1
      ORDER BY MIN(created_at) DESC
      LIMIT 50
    `;
    const { rows: batchRows } = await pool.query(batchListSql);

    type Row = {
      sim_id: string;
      gds_filename: string | null;
      created_at: string;
      ports_json: Record<string, unknown> | null;
      settings_json: Record<string, unknown> | null;
      run_meta: Record<string, unknown> | null;
      flow_tag: string;
      b_status: string | null;
      a_http_status: string | null;
      a_tool: string | null;
      a_endpoint_called: string | null;
      a_expected_endpoint: string | null;
      a_endpoint_match: boolean | null;
      user_message: string | null;
      a_spectrum_score: number | null;
      a_spectrum_total: number | null;
      a_netlist_score: number | null;
      a_netlist_total: number | null;
      io_spectrum: number | null;
      io_netlist: number | null;
      s_input: number | null;
      s_param_match: number | null;
      s_output: number | null;
      s_semantic: number | null;
      s_execution: number | null;
      s_overall: number | null;
      verdict: string | null;
      input_checks_json: Record<string, { requested?: unknown; actual?: unknown; pass?: boolean; status?: string }> | null;
      output_checks_json: Record<string, { requested?: unknown; actual?: unknown; pass?: boolean; status?: string }> | null;
      tool_calls_count: number | null;
      latency_ms: number | null;
      tok_prompt: number | null;
      tok_completion: number | null;
      tok_total: number | null;
      tok_estimated: boolean | null;
    };

    // For B flow rows, the legacy `Insert to PG sim_run` doesn't store
    // explicit correctness checks. Compute them on-the-fly from the same
    // sim_run columns that B already populates (ports_json, settings_json,
    // run_meta.files / center). 5-check parity with A flow's checks.
    function computeBSpectrumScore(r: Row): { score: number; total: number } {
      const meta = r.run_meta || {};
      const settings = (r.settings_json as Record<string, unknown>) || {};
      const center = (meta as { center?: unknown }).center;
      const files = (meta as { files?: unknown }).files;
      const checks = [
        // has_spectrum: any spectral metadata in settings_json or run_meta
        !!(settings.spectrum || settings.spectral_feature || (meta as { spectrum?: unknown }).spectrum),
        // has_peaks: gds_filename indicates a successful sim that would have peaks
        !!r.gds_filename,
        // has_fsr: settings or sweep range inferred from gds filename pattern
        !!r.gds_filename && /wl\d+-\d+/i.test(r.gds_filename),
        // has_engine: solver_type is set (always 'CAPHE' for sim runs)
        true,
        // has_review_thresholds: only Mux4Configurable populates this
        !!((meta as { review_thresholds?: unknown }).review_thresholds || (settings as { review_thresholds?: unknown }).review_thresholds),
      ];
      void center; void files; // silence unused warnings; left for future expansion
      return { score: checks.filter(Boolean).length, total: checks.length };
    }
    function computeBNetlistScore(r: Row): { score: number; total: number } {
      const ports = (r.ports_json as Record<string, unknown>) || {};
      const meta = r.run_meta || {};
      const portsLayoutPorts = ports.layout_ports as unknown[] | undefined;
      const portMap = ports.port_map as Record<string, unknown> | undefined;
      const nports = (ports.nports as number | undefined) ?? null;
      const filesObj = (meta as { files?: Record<string, unknown> }).files || {};
      const checks = [
        typeof nports === "number" && nports > 0,
        !!(portMap && Object.keys(portMap).length > 0),
        Array.isArray(portsLayoutPorts) && portsLayoutPorts.length > 0,
        !!(filesObj.netlist_json_path),
        // has_netlist_obj — B doesn't store the netlist body inline; treat
        // the presence of a netlist_json_path as proxy
        !!(filesObj.netlist_json_path),
      ];
      return { score: checks.filter(Boolean).length, total: checks.length };
    }

    const A_guided: Row[] = [];   // A runs that included an expected_endpoint label
    const A_unguided: Row[] = []; // A runs with no expected_endpoint (system prompt drives entirely)
    const B: Row[] = [];
    const Untagged: Row[] = [];
    for (const r of rows as Row[]) {
      if (r.flow_tag === "A") {
        if (r.a_expected_endpoint && r.a_expected_endpoint.length > 0) A_guided.push(r);
        else A_unguided.push(r);
      } else if (r.flow_tag === "B") {
        B.push(r);
      } else {
        Untagged.push(r);
      }
    }
    const A_all: Row[] = [...A_guided, ...A_unguided];

    function summarize(list: Row[], opts: { scoreEndpointMatch: boolean; flowKind: "A" | "B" }) {
      const total = list.length;
      let ok = 0;
      let fail = 0;
      let endpointMatchTotal = 0;
      let endpointMatchOk = 0;
      let spectrumScoreSum = 0;
      let spectrumTotalSum = 0;
      let spectrumEvaluated = 0;
      let netlistScoreSum = 0;
      let netlistTotalSum = 0;
      let netlistEvaluated = 0;
      // Component I/O Quality (1-check, file-existence based)
      let ioSpectrumOk = 0;
      let ioSpectrumTotal = 0;
      let ioNetlistOk = 0;
      let ioNetlistTotal = 0;
      // Component evaluation scores (rule-based, parity with B's review pipeline)
      const scoreSums = { input: 0, param: 0, output: 0, semantic: 0, execution: 0, overall: 0 };
      const scoreCounts = { input: 0, param: 0, output: 0, semantic: 0, execution: 0, overall: 0 };
      const verdictCounts: Record<string, number> = { pass: 0, partial: 0, fail: 0 };
      let evaluated = 0;
      // Latency + tokens
      let latencySum = 0;
      let latencyCount = 0;
      let latencyMax = 0;
      let tokPromptSum = 0;
      let tokCompletionSum = 0;
      let tokTotalSum = 0;
      let tokCount = 0;
      let tokEstimated = 0;  // count of rows where tokens were estimated (not real)
      // PRIMARY METRICS (A vs B truth indicators):
      //   tool_hit = LLM agent / router actually called a sim tool (vs text-only response)
      //   input_hit = per-param: requested value reached IPKISS (caught silent fallback)
      let toolHitOk = 0;
      let toolHitTotal = 0;
      let inputHitOk = 0;
      let inputHitTotal = 0;
      // Per-key drill-down: which params drift most often (aggregate)
      const paramDrift: Map<string, { req_count: number; pass_count: number }> = new Map();
      // Per-intent × per-param drill-down: same data sliced by component intent
      const paramDriftByIntent: Map<string, Map<string, { req_count: number; pass_count: number }>> = new Map();
      const byIntent = new Map<string, { n: number; ok: number }>();

      for (const r of list) {
        const isOk =
          (r.a_http_status != null && Number(r.a_http_status) === 200) ||
          r.b_status === "ok";
        const isFail =
          r.b_status === "error" ||
          (r.a_http_status != null && Number(r.a_http_status) >= 400);
        if (isOk) ok += 1;
        else if (isFail) fail += 1;

        if (opts.scoreEndpointMatch && r.a_expected_endpoint != null) {
          endpointMatchTotal += 1;
          if (r.a_endpoint_match === true) endpointMatchOk += 1;
        }

        // Spectrum / netlist correctness:
        //   A flow rows: read pre-computed score/total from run_meta
        //   B flow rows: compute on the fly from existing sim_run columns
        let spec: { score: number; total: number } | null = null;
        let net: { score: number; total: number } | null = null;
        if (opts.flowKind === "A" && r.a_spectrum_score != null && r.a_spectrum_total != null) {
          spec = { score: r.a_spectrum_score, total: r.a_spectrum_total };
        } else if (opts.flowKind === "B" && isOk) {
          spec = computeBSpectrumScore(r);
        }
        if (opts.flowKind === "A" && r.a_netlist_score != null && r.a_netlist_total != null) {
          net = { score: r.a_netlist_score, total: r.a_netlist_total };
        } else if (opts.flowKind === "B" && isOk) {
          net = computeBNetlistScore(r);
        }
        if (spec) {
          spectrumScoreSum += spec.score;
          spectrumTotalSum += spec.total;
          spectrumEvaluated += 1;
        }
        if (net) {
          netlistScoreSum += net.score;
          netlistTotalSum += net.total;
          netlistEvaluated += 1;
        }

        // Component I/O Quality
        // Prefer the explicit run_meta.component_io flat field (both A and B
        // populate it once their Code-node patches are live). Fall back to
        // file-presence heuristic on the sim_run row for legacy rows.
        if (r.io_spectrum != null) {
          ioSpectrumOk += r.io_spectrum;
          ioSpectrumTotal += 1;
        } else if (isOk) {
          // Legacy / pre-patch row: infer from gds_filename or files.*
          const meta = r.run_meta || {};
          const files = (meta as { files?: Record<string, unknown> }).files || {};
          const hasSnp = !!(
            files.s2p_path || files.s4p_path || files.s8p_path ||
            files.sNp_path || files.touchstone_path
          );
          ioSpectrumOk += hasSnp ? 1 : 0;
          ioSpectrumTotal += 1;
        }
        if (r.io_netlist != null) {
          ioNetlistOk += r.io_netlist;
          ioNetlistTotal += 1;
        } else if (isOk) {
          const meta = r.run_meta || {};
          const files = (meta as { files?: Record<string, unknown> }).files || {};
          const hasNet = !!files.netlist_json_path;
          ioNetlistOk += hasNet ? 1 : 0;
          ioNetlistTotal += 1;
        }

        // Component evaluation scores (5-score + verdict)
        if (r.s_overall != null) evaluated += 1;
        if (r.s_input != null)     { scoreSums.input += r.s_input;       scoreCounts.input += 1; }
        if (r.s_param_match != null){ scoreSums.param += r.s_param_match; scoreCounts.param += 1; }
        if (r.s_output != null)    { scoreSums.output += r.s_output;     scoreCounts.output += 1; }
        if (r.s_semantic != null)  { scoreSums.semantic += r.s_semantic; scoreCounts.semantic += 1; }
        if (r.s_execution != null) { scoreSums.execution += r.s_execution; scoreCounts.execution += 1; }
        if (r.s_overall != null)   { scoreSums.overall += r.s_overall;   scoreCounts.overall += 1; }
        if (r.verdict && r.verdict in verdictCounts) verdictCounts[r.verdict] += 1;
        else if (r.verdict) verdictCounts[r.verdict] = (verdictCounts[r.verdict] ?? 0) + 1;

        // Latency + token aggregation
        if (r.latency_ms != null) {
          latencySum += r.latency_ms;
          latencyCount += 1;
          if (r.latency_ms > latencyMax) latencyMax = r.latency_ms;
        }
        if (r.tok_total != null) {
          tokPromptSum += r.tok_prompt ?? 0;
          tokCompletionSum += r.tok_completion ?? 0;
          tokTotalSum += r.tok_total;
          tokCount += 1;
          if (r.tok_estimated) tokEstimated += 1;
        }

        // Tool hit (strict) — TWO conditions both required:
        //   1. Tool was actually called (tool_calls_count > 0)
        //   2. The tool's semantic intent EXACTLY matched user's request
        //      (semantic_match_score === 1.0, NOT canonical_partial 0.5)
        // This is the truth signal: "right tool name + right semantic class".
        toolHitTotal += 1;
        const calledTool = (r.tool_calls_count ?? 0) > 0;
        const semExact = r.s_semantic != null && Number(r.s_semantic) >= 0.999;
        const toolHitPassed = calledTool && semExact;
        if (toolHitPassed) toolHitOk += 1;

        // Per-parameter input hit + drill-down by intent
        // CONDITIONAL: only counts param checks from rows where tool_hit
        // (strict) PASSED — i.e., the right tool was called with correct
        // semantic class. If the wrong tool fired, input-param checks are
        // meaningless because we'd be comparing apples-to-oranges (params
        // expected for tool X vs values from tool Y's response). Skipping
        // those rows isolates "given right tool, did params transit?"
        const ep = r.a_endpoint_called ?? inferEndpointFromGds(r.gds_filename);
        const rowIntent = intentLabelFromEndpoint(ep);
        if (toolHitPassed) {
          const inputChecks = r.input_checks_json || {};
          for (const [paramName, ck] of Object.entries(inputChecks)) {
            if (ck == null || typeof ck !== "object") continue;
            if (ck.requested == null) continue;          // skip "not_requested"
            inputHitTotal += 1;
            if (ck.pass === true) inputHitOk += 1;
            // Aggregate drift
            const cur = paramDrift.get(paramName) ?? { req_count: 0, pass_count: 0 };
            cur.req_count += 1;
            if (ck.pass === true) cur.pass_count += 1;
            paramDrift.set(paramName, cur);
            // Per-intent drift slice
            let intentMap = paramDriftByIntent.get(rowIntent);
            if (!intentMap) {
              intentMap = new Map();
              paramDriftByIntent.set(rowIntent, intentMap);
            }
            const ic = intentMap.get(paramName) ?? { req_count: 0, pass_count: 0 };
            ic.req_count += 1;
            if (ck.pass === true) ic.pass_count += 1;
            intentMap.set(paramName, ic);
          }
        }
        const cur = byIntent.get(rowIntent) ?? { n: 0, ok: 0 };
        cur.n += 1;
        if (isOk) cur.ok += 1;
        byIntent.set(rowIntent, cur);
      }

      return {
        total,
        success_ok: ok,
        success_fail: fail,
        success_rate: total > 0 ? ok / total : null,
        endpoint_match_total: endpointMatchTotal,
        endpoint_match_ok: endpointMatchOk,
        endpoint_match_rate: endpointMatchTotal > 0 ? endpointMatchOk / endpointMatchTotal : null,
        spectrum_evaluated: spectrumEvaluated,
        spectrum_score_sum: spectrumScoreSum,
        spectrum_total_sum: spectrumTotalSum,
        spectrum_avg_rate: spectrumTotalSum > 0 ? spectrumScoreSum / spectrumTotalSum : null,
        netlist_evaluated: netlistEvaluated,
        netlist_score_sum: netlistScoreSum,
        netlist_total_sum: netlistTotalSum,
        netlist_avg_rate: netlistTotalSum > 0 ? netlistScoreSum / netlistTotalSum : null,
        // Component I/O Quality (1-check per row)
        io_spectrum_ok: ioSpectrumOk,
        io_spectrum_total: ioSpectrumTotal,
        io_spectrum_rate: ioSpectrumTotal > 0 ? ioSpectrumOk / ioSpectrumTotal : null,
        io_netlist_ok: ioNetlistOk,
        io_netlist_total: ioNetlistTotal,
        io_netlist_rate: ioNetlistTotal > 0 ? ioNetlistOk / ioNetlistTotal : null,
        // Component evaluation 5-score averages (parity with B's review pipeline)
        evaluated,
        avg_input: scoreCounts.input > 0 ? scoreSums.input / scoreCounts.input : null,
        avg_parameter_match: scoreCounts.param > 0 ? scoreSums.param / scoreCounts.param : null,
        avg_output: scoreCounts.output > 0 ? scoreSums.output / scoreCounts.output : null,
        avg_semantic: scoreCounts.semantic > 0 ? scoreSums.semantic / scoreCounts.semantic : null,
        avg_execution: scoreCounts.execution > 0 ? scoreSums.execution / scoreCounts.execution : null,
        avg_overall: scoreCounts.overall > 0 ? scoreSums.overall / scoreCounts.overall : null,
        verdict_counts: verdictCounts,
        // Latency + tokens
        latency_ms_avg: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
        latency_ms_max: latencyMax || null,
        latency_count: latencyCount,
        tok_count: tokCount,
        tok_prompt_sum: tokPromptSum,
        tok_completion_sum: tokCompletionSum,
        tok_total_sum: tokTotalSum,
        tok_total_avg: tokCount > 0 ? Math.round(tokTotalSum / tokCount) : null,
        tok_estimated_count: tokEstimated,
        // PRIMARY metrics — these are the truth signals
        tool_hit_ok: toolHitOk,
        tool_hit_total: toolHitTotal,
        tool_hit_rate: toolHitTotal > 0 ? toolHitOk / toolHitTotal : null,
        input_hit_ok: inputHitOk,
        input_hit_total: inputHitTotal,
        input_hit_rate: inputHitTotal > 0 ? inputHitOk / inputHitTotal : null,
        param_drift: Array.from(paramDrift.entries())
          .map(([name, v]) => ({
            param: name,
            requested_n: v.req_count,
            passed_n: v.pass_count,
            hit_rate: v.req_count > 0 ? v.pass_count / v.req_count : null,
          }))
          .sort((a, b) => a.param.localeCompare(b.param)), // alphabetical by param name
        param_drift_by_intent: Object.fromEntries(
          Array.from(paramDriftByIntent.entries()).map(([intent, m]) => [
            intent,
            Array.from(m.entries())
              .map(([name, v]) => ({
                param: name,
                requested_n: v.req_count,
                passed_n: v.pass_count,
                hit_rate: v.req_count > 0 ? v.pass_count / v.req_count : null,
              }))
              .sort((a, b) => a.param.localeCompare(b.param)),
          ]),
        ),
        by_intent: Array.from(byIntent.entries())
          .map(([intent, v]) => ({ intent, n: v.n, ok: v.ok, rate: v.n > 0 ? v.ok / v.n : null }))
          .sort((a, b) => b.n - a.n),
      };
    }

    const A_unguided_stats = summarize(A_unguided, { scoreEndpointMatch: false, flowKind: "A" });
    const A_guided_stats   = summarize(A_guided,   { scoreEndpointMatch: true,  flowKind: "A" });
    const B_stats          = summarize(B,          { scoreEndpointMatch: false, flowKind: "B" });
    const U_stats          = summarize(Untagged,   { scoreEndpointMatch: false, flowKind: "B" });

    // Override latency from JSONL batch log (more reliable than run_meta.latency_ms
    // which depends on $execution.startedAt being available in Code nodes).
    const batchLatency = readBatchLatency();
    if (batchLatency.A) {
      A_unguided_stats.latency_ms_avg = batchLatency.A.avg;
      A_unguided_stats.latency_ms_max = batchLatency.A.max;
      A_unguided_stats.latency_count = batchLatency.A.count;
    }
    if (batchLatency.B) {
      B_stats.latency_ms_avg = batchLatency.B.avg;
      B_stats.latency_ms_max = batchLatency.B.max;
      B_stats.latency_count = batchLatency.B.count;
    }

    // Recent samples (last 10 of each)
    const recent_A = A_all.slice(0, 10).map((r) => ({
      sim_id: r.sim_id,
      created_at: r.created_at,
      user_message: r.user_message,
      tool: r.a_tool,
      endpoint_called: r.a_endpoint_called,
      expected_endpoint: r.a_expected_endpoint,
      endpoint_match: r.a_endpoint_match,
      http_status: r.a_http_status,
      guided: r.a_expected_endpoint != null && r.a_expected_endpoint.length > 0,
    }));
    const recent_B = B.slice(0, 10).map((r) => ({
      sim_id: r.sim_id,
      created_at: r.created_at,
      gds_filename: r.gds_filename,
      inferred_endpoint: inferEndpointFromGds(r.gds_filename),
      status: r.b_status,
    }));

    return NextResponse.json({
      A_unguided: A_unguided_stats,
      A_guided:   A_guided_stats,
      B:          B_stats,
      untagged:   U_stats,
      recent_A,
      recent_B,
      batch_id_filter: batchIdFilter,
      available_batches: batchRows.map((b) => ({
        batch_id: b.batch_id,
        started_at: b.started_at,
        ended_at: b.ended_at,
        rows: Number(b.rows),
      })),
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

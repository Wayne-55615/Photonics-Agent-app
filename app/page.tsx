"use client";

import Image from "next/image";
import { useState, useRef, useEffect, useMemo, useCallback, Fragment } from "react";
import GdsViewer from "@/components/GdsViewer";
import SParamPlot from "@/components/SParamPlot";
import { parseSnp, getNPortsFromFilename, SnpData } from "@/utils/snpParser";

// ── Types ────────────────────────────────────────────────────────────────────

interface SimFiles {
  gds_filename?: string;
  preview_svg?: string;
  preview_png?: string;
  [key: string]: string | undefined;
}

interface ValidationWarning {
  code?: string;
  severity?: string;
  message?: string;
  evidence?: Record<string, unknown>;
}

interface OpticalFunctionSummary {
  device?: string;
  dc_type?: string;
  ports?: string[];
  input_port?: string;
  through_port?: string;
  cross_port?: string;
  dc_meta?: Record<string, unknown>;
}

interface SpectrumSummary {
  engine?: string;
  input_port?: string;
  output_ports?: string[];
  warnings?: string[];
  fsr?: Record<string, number>;
  fsr_warning_ports?: string[];
  peaks?: Record<string, unknown[]>;
  bands_width?: Record<string, unknown[]>;
  min_insertion_losses_db?: Record<string, unknown[]>;
  max_insertion_losses_db?: Record<string, unknown[]>;
  near_crosstalk_db?: Record<string, number | null>;
  far_crosstalk_db?: Record<string, number | null>;
  cutoff_passbands?: Record<string, unknown[]>;
  center_wavelength_um?: number;
  neff_center?: number | null;
  ng_center?: number | null;
  loss_db_per_m_center?: number | null;
}

interface LlmSummary {
  semantic_tag?: string;
  optical_function?: string | OpticalFunctionSummary;
  spectral_feature?: string | SpectrumSummary;
  explanation?: string;
  validation_warnings?: ValidationWarning[];
}

interface S21Trace {
  wavelength_um: number[];
  power_db: number[];
  power_lin: number[];
  group_delay_ps: number[];
}

interface CenterResult {
  center_wavelength_um?: number;
  neff_center?: number;
  ng_center?: number;
  loss_db_per_m_center?: number;
}

type EvalVerdict = "pass" | "partial" | "fail";

interface ComponentEvalCheck {
  key: string;
  requested: unknown;
  actual: unknown;
  status: string;
  pass: boolean;
  score: number;
  weight: number;
  required: boolean;
  compare_type?: string;
  abs_diff?: number;
  pct_diff?: number;
}

interface ComponentEvaluation {
  semantic_tag?: string;
  semantic_like?: string;
  component_type?: string;
  component_name?: string;
  rule_version?: string;
  key_variables?: string[];
  weights?: {
    input_completeness?: number;
    parameter_match?: number;
    output_completeness?: number;
    execution_success?: number;
  };
  scores?: {
    input_score?: number;
    parameter_match_score?: number;
    output_score?: number;
    execution_score?: number;
    semantic_match_score?: number;
    overall_score?: number;
  };
  success_checks?: {
    has_success_status?: boolean;
    has_artifact?: boolean;
    has_spectrum_or_spectral_feature?: boolean;
  };
  input_checks?: Record<string, ComponentEvalCheck>;
  output_checks?: Record<string, ComponentEvalCheck>;
  missing_input_keys?: string[];
  missing_output_keys?: string[];
  failed_parameter_keys?: string[];
  required_failed_keys?: string[];
  verdict?: EvalVerdict;
  llm_review?: {
    llm_score?: number | null;
    llm_verdict?: EvalVerdict | null;
    llm_reasoning?: string | null;
    improvement_suggestions?: string[];
    model?: string | null;
    error?: unknown;
  } | null;
}

interface SimOutput {
  success: boolean;
  files?: SimFiles;
  spectral_feature?: SpectrumSummary & { s21_trace?: S21Trace };
  simulation_request?: Record<string, unknown>;
  llm_summary?: LlmSummary;
  center_result?: CenterResult;
  explanation?: string;
  component_evaluation?: ComponentEvaluation;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

type RouteMode = "simulation" | "recommend" | "case_lookup" | "general" | "document";

interface ApiResponse {
  ok: boolean;
  route_mode: RouteMode;
  intent_name: string;
  classification: { reason: string };
  data: {
    output?: string | SimOutput;
    suggested_query?: string;
    message?: string;
    source?: string;
    recommendations?: unknown[];
    answer?: string;
    // simulation route puts SimOutput fields directly here (no output wrapper)
    success?: boolean;
    files?: SimFiles;
    [key: string]: unknown;
  };
}

interface ChatMessage {
  id: number;
  role: "user" | "bot";
  text: string;
  response?: ApiResponse;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseOutput(raw?: string | SimOutput): SimOutput | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Slim a SpectrumAnalyzer-like object for inline rendering: keep all keys + scalar
 * values, but elide long arrays (>16 items) to a count placeholder so the output
 * stays under ~10 KB. Used by the "🔍 Inspect raw spectrum" panel.
 */
function slimSpectrumForInspect(node: unknown, depth = 0): unknown {
  if (depth > 5) return "[…depth limit]";
  if (Array.isArray(node)) {
    if (node.length > 16) return `[Array(${node.length})]`;
    return node.map((v) => slimSpectrumForInspect(v, depth + 1));
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (Array.isArray(v) && v.length > 16) {
        out[k] = `[Array(${v.length})]`;
      } else {
        out[k] = slimSpectrumForInspect(v, depth + 1);
      }
    }
    return out;
  }
  return node;
}

/**
 * Project a case_lookup `selected_case` row onto a SimOutput shape so case-hit
 * renders through the same sim-result pipeline (cards, ReplayPanel, file
 * downloads). Missing fields are dropped; downstream UI is null-safe.
 */
function synthesizeSimOutputFromCase(sel: Record<string, unknown> | null | undefined): SimOutput | null {
  if (!sel || typeof sel !== "object") return null;
  // Coerce a value to a finite number, returning undefined when not numeric.
  const toNum = (v: unknown): number | undefined => {
    if (v == null || v === "") return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  // Probe a list of (object, key) candidates and return the first finite number.
  // gds_structures stores center metrics nested under propagation_metrics.{center_metrics,spectrum};
  // older sim_run rows put them at top level. Scanning both keeps either origin working.
  const numFromPaths = (...paths: Array<[Record<string, unknown> | undefined | null, string]>): number | undefined => {
    for (const [obj, key] of paths) {
      if (!obj || typeof obj !== "object") continue;
      const got = toNum(obj[key]);
      if (got !== undefined) return got;
    }
    return undefined;
  };
  const num = (k: string): number | undefined => toNum(sel[k]);
  const str = (k: string): string | undefined => {
    const v = sel[k];
    return typeof v === "string" && v ? v : undefined;
  };
  const arr = <T = unknown>(k: string): T[] | undefined => {
    const v = sel[k];
    return Array.isArray(v) ? (v as T[]) : undefined;
  };
  const obj = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

  // Nested JSONB containers commonly carrying spectrum / center metrics.
  const propMetrics = obj(sel.propagation_metrics);
  const centerMetrics = obj(propMetrics?.center_metrics);
  const spectrumNested = obj(propMetrics?.spectrum);
  const wgProps = obj(sel.waveguide_properties);
  const runMetaCenter = obj(obj(sel.run_meta)?.center);

  const opticalRaw = sel.optical_function;
  const opticalSummary: OpticalFunctionSummary | undefined =
    opticalRaw && typeof opticalRaw === "object" ? (opticalRaw as OpticalFunctionSummary) : undefined;
  const opticalText = typeof opticalRaw === "string" ? opticalRaw : undefined;

  // Center metrics — scan top-level + nested JSONBs in priority order.
  const centerWavelengthUm = numFromPaths(
    [sel, "center_wavelength_um"],
    [centerMetrics, "center_wavelength_um"],
    [centerMetrics, "center_wl_um"],
    [centerMetrics, "wavelength_um"],
    [spectrumNested, "center_wavelength_um"],
    [runMetaCenter, "wavelength_um"],
  );
  const neffCenter = numFromPaths(
    [sel, "neff_center"],
    [centerMetrics, "neff"],
    [centerMetrics, "neff_center"],
    [spectrumNested, "neff_center"],
    [runMetaCenter, "neff"],
  );
  const ngCenter = numFromPaths(
    [sel, "ng_center"],
    [centerMetrics, "ng"],
    [centerMetrics, "ng_center"],
    [spectrumNested, "ng_center"],
    [runMetaCenter, "ng"],
  );
  const lossDbPerMCenter = numFromPaths(
    [sel, "loss_db_per_m_center"],
    [centerMetrics, "loss_db_per_m"],
    [centerMetrics, "loss"],
    [spectrumNested, "loss_db_per_m_center"],
    [runMetaCenter, "loss_db_per_m"],
  );

  const specRaw = sel.spectral_feature;
  let spectralSummary: SpectrumSummary | undefined =
    specRaw && typeof specRaw === "object" ? (specRaw as SpectrumSummary) : undefined;
  if (!spectralSummary) {
    const fsr_um = numFromPaths([sel, "fsr_um"], [centerMetrics, "fsr_um"], [spectrumNested, "fsr_um"]);
    const ports = (arr<string>("output_ports")
      ?? (Array.isArray(opticalSummary?.ports) ? opticalSummary!.ports : undefined)
      ?? (Array.isArray((wgProps as Record<string, unknown> | undefined)?.ports)
            ? (wgProps as Record<string, unknown>).ports as string[]
            : undefined)
      ?? []).filter((p) => typeof p === "string") as string[];
    const synth: SpectrumSummary = {};
    const engNested = spectrumNested?.engine;
    const eng = str("engine") ?? str("solver_type")
      ?? (typeof engNested === "string" && engNested ? engNested : undefined);
    if (eng) synth.engine = eng;
    if (ports.length) synth.output_ports = ports;
    if (fsr_um != null) {
      synth.fsr = ports.length
        ? Object.fromEntries(ports.map((p) => [p, fsr_um]))
        : { ch1: fsr_um };
    }
    if (centerWavelengthUm != null) synth.center_wavelength_um = centerWavelengthUm;
    if (neffCenter != null) synth.neff_center = neffCenter;
    if (ngCenter != null) synth.ng_center = ngCenter;
    if (lossDbPerMCenter != null) synth.loss_db_per_m_center = lossDbPerMCenter;
    if (Object.keys(synth).length > 0) spectralSummary = synth;
  }
  const spectralText = typeof specRaw === "string" ? specRaw : undefined;

  const simReqKeys = [
    "semantic_tag", "core_width_um", "length_um", "center_wavelength_um", "fsr_um",
    "wl_start_um", "wl_stop_um", "n_points", "wg_family", "bend_radius",
    "input_port", "output_ports",
  ];
  const simReq: Record<string, unknown> = {};
  for (const k of simReqKeys) {
    if (sel[k] != null && sel[k] !== "") simReq[k] = sel[k];
    else if (wgProps?.[k] != null && wgProps[k] !== "") simReq[k] = wgProps[k];
  }

  const gdsName = (() => {
    const g = sel.gds_filename;
    return typeof g === "string" ? g.replace(/.*[/\\]/, "") : undefined;
  })();
  const baseStem = gdsName && /\.gds$/i.test(gdsName) ? gdsName.replace(/\.gds$/i, "") : undefined;
  const layout_html_path = baseStem ? `${baseStem}_layout.html` : undefined;
  // Backend opens netlist_json_path as a real file via _read_json(open(path)).
  // The basename alone won't resolve because IPKISS server CWD is ipkiss-api/
  // (one level above results/). Prefix with "results/" so the relative path
  // resolves; fresh sims emit absolute Windows paths and either form is fine
  // for project_netlist_runner.
  const netlist_json_path = baseStem ? `results/${baseStem}_netlist.json` : undefined;

  // Derive wdm_type from semantic_tag suffix for ReplayPanel preset gating.
  const semTag = str("semantic_tag") ?? "";
  const tagSuffix = semTag.toUpperCase().split(":").pop() ?? "";
  const wdmTypeMap: Record<string, string> = {
    MZILATTICEFILTER: "MZILatticeFilter",
    MUX2: "Mux2", MUX4: "Mux4", MUX8: "Mux8", MUXPARAMETRIC: "MuxParametric",
  };
  const wdmType = wdmTypeMap[tagSuffix];

  const params_used: Record<string, unknown> = { ...simReq };
  if (wdmType) params_used.wdm_type = wdmType;
  // Map fsr_um -> fsr so ReplayPanel.seedMeta picks it up.
  if (params_used.fsr_um != null && params_used.fsr == null) {
    params_used.fsr = params_used.fsr_um;
  }

  // Sibling-artifact derivation. layout_html_path is left as the *candidate* —
  // send() probes it via HEAD before wiring it to an <iframe>, falling back to
  // a PNG when the .html doesn't exist (older runs only wrote PNGs).
  const spectrum_png_path = baseStem ? `${baseStem}_spectrum.png` : undefined;
  const smatrix_png_path = baseStem ? `${baseStem}_smatrix.png` : undefined;

  const out: SimOutput = {
    success: true,
    case_match: { is_case_hit: true },  // marker for the RAG-source chip
    files: gdsName ? { gds_filename: gdsName } : undefined,
    layout_html_path,
    layout_smatrix_png_fallback: smatrix_png_path,  // consumed by send() probe-fallback
    layout_spectrum_png_fallback: spectrum_png_path,
    spectrum_png_path,                              // renderSimPanel right-pane PNG
    netlist_json_path,
    simulation_request: Object.keys(simReq).length ? simReq : undefined,
    params_used,
    llm_summary: {
      semantic_tag: str("semantic_tag"),
      optical_function: opticalSummary ?? opticalText,
      spectral_feature: spectralSummary ?? spectralText,
      explanation: str("explanation_final"),
    },
    spectral_feature: spectralSummary,
    center_result: {
      center_wavelength_um: centerWavelengthUm,
      neff_center: neffCenter,
      ng_center: ngCenter,
      loss_db_per_m_center: lossDbPerMCenter,
    },
  };
  return out;
}

function badgeClass(mode: RouteMode) {
  return `route-badge badge-${mode}`;
}

/** Extract a .sNp filename from the simulation output (flexible field scan). */
function findSnpFilename(out: SimOutput | null): string | null {
  if (!out) return null;
  // Top-level s2p_path (from subwf_IPKISS sim)
  if (typeof out.s2p_path === "string" && /\.s\d+p$/i.test(out.s2p_path)) {
    return out.s2p_path.replace(/.*[/\\]/, "");
  }
  // s_params_refs array (strings or objects with path/filename)
  if (Array.isArray(out.s_params_refs)) {
    for (const ref of out.s_params_refs) {
      const candidate = typeof ref === "string" ? ref : (ref?.path ?? ref?.filename ?? "");
      if (typeof candidate === "string" && /\.s\d+p$/i.test(candidate)) {
        return candidate.replace(/.*[/\\]/, "");
      }
    }
  }
  // Scan files object values
  if (out.files && typeof out.files === "object") {
    for (const val of Object.values(out.files)) {
      if (typeof val === "string" && /\.s\d+p$/i.test(val)) {
        return val.replace(/.*[/\\]/, ""); // basename only
      }
    }
  }
  // Scan any array-like field at output root
  for (const key of ["files_list", "file_list", "output_files"]) {
    const arr = out[key];
    if (Array.isArray(arr)) {
      for (const f of arr) {
        if (typeof f === "string" && /\.s\d+p$/i.test(f)) {
          return f.replace(/.*[/\\]/, "");
        }
      }
    }
  }
  // Derive from GDS filename as last resort
  const gds = out.files?.gds_filename ?? (typeof out.gds_filename === "string" ? out.gds_filename : null);
  if (gds) {
    const base = gds.replace(/\.gds$/i, "");
    return base + ".s2p"; // optimistic guess — will 404 silently if wrong
  }
  return null;
}

/** Derive .sNp basename from a case_hit selected_case (port count via optical_function). */
function findSnpFromCase(sel: Record<string, unknown> | null | undefined): string | null {
  const gds = typeof sel?.gds_filename === "string" ? sel.gds_filename : null;
  if (!gds) return null;
  const base = gds.replace(/.*[/\\]/, "").replace(/\.gds$/i, "");
  let ports = 2;
  const opt = sel?.optical_function;
  try {
    const parsed = typeof opt === "string" ? JSON.parse(opt) : opt;
    if (parsed && Array.isArray((parsed as { ports?: unknown[] }).ports)) {
      ports = (parsed as { ports: unknown[] }).ports.length || 2;
    }
  } catch { /* fall through */ }
  return `${base}.s${ports}p`;
}

/** Extract GDS basename from output. */
function findGdsFilename(out: SimOutput | null): string | null {
  const raw = out?.files?.gds_filename ?? (typeof out?.gds_filename === "string" ? out.gds_filename : null);
  if (!raw) return null;
  return raw.replace(/.*[/\\]/, "");
}

function findSpectrumPngFilename(out: SimOutput | null): string | null {
  const raw = out?.spectrum_png_path ?? out?.files?.spectrum_png_path;
  if (typeof raw !== "string" || !raw) return null;
  return raw.replace(/.*[/\\]/, "");
}

// B flow webhook — proxied through our own /api/chat so the browser never
// talks to n8n directly. The actual upstream URL is configured server-side
// via N8N_WEBHOOK_URL (see app/api/chat/route.ts), which lets n8n stay on a
// docker-internal network and not be exposed publicly.
const WEBHOOK = "/api/chat";

// ── Example command library (grouped, collapsible) ───────────────────────────
const EXAMPLE_GROUPS: { label: string; items: { value: string; label: string; section?: string }[] }[] = [
  {
    label: "WDM transmitter MZI",
    items: [
      { value: "find similar MZI center wavelength 1.55 FSR 20nm n_points 101 wl_start_um: 1.51 wl_stop_um: 1.59", label: "FSR 20 nm · 101 pts · 1.51–1.59" },
      { section: "Replay (last MZI netlist)", value: "replay last MZI result, center wavelength 1.56 FSR 25nm n_points 161 wl_start_um 1.52 wl_stop_um 1.60 bend_radius 8", label: "FSR 25 nm · center 1.56 · wl 1.52–1.60" },
      { section: "Force simulate · MZILatticeFilter variants", value: "force simulate MZILatticeFilter center_wavelength 1.55 FSR 20nm power_couplings [0.5,0.13,0.12,0.5,0.25] delay_lengths_um [28.349,56.697,-57.027,-56.697] dc_type SiDirectionalCouplerSPower wl_start 1.50 wl_stop 1.60 n_points 501", label: "baseline · FSR 20 · 4-stage · κ²=[0.5,0.13,0.12,0.5,0.25] · ΔL aligned to _default_lattice_parameters (channel @1550)" },
      { section: "Force simulate · MZILatticeFilter variants", value: "force simulate MZILatticeFilter center_wavelength 1.55 FSR 50nm dc_type SiDirectionalCouplerSPower wl_start 1.45 wl_stop 1.65 n_points 501", label: "FSR 50 · auto delay (no override)" },
      { section: "Force simulate · MZILatticeFilter variants", value: "force simulate MZILatticeFilter center_wavelength 1.55 FSR 20nm power_couplings [0.5,0.13,0.12,0.5,0.25] delay_lengths_um [60,120,-200,-120] dc_type SiDirectionalCouplerSPower wl_start 1.50 wl_stop 1.60 n_points 501", label: "delay variant · ΔL=[60,120,-200,-120] (longer)" },
      { section: "Force simulate · MZILatticeFilter variants", value: "force simulate MZILatticeFilter center_wavelength 1.55 FSR 20nm power_couplings [0.5,0.2,0.18,0.5,0.35] delay_lengths_um [28.349,56.697,-57.027,-56.697] dc_type SiDirectionalCouplerSPower wl_start 1.50 wl_stop 1.60 n_points 501", label: "coupling variant · κ²=[0.5,0.2,0.18,0.5,0.35] · ΔL aligned (channel @1550)" },
      { section: "Force simulate · negative control", value: "force simulate Mux4 center_wavelength 1.55 FSR 50nm spacing_x 50 spacing_y 80 bend_radius 5 power_couplings [0.5,0.2,0.18,0.5,0.35] delay_lengths_um [60,120,-200,-120] wl_start 1.48 wl_stop 1.64 n_points 501", label: "Mux4 · delay/κ should be ignored (silent-failure test)" },
      { section: "Force simulate · Mux4Configurable (per-stage seed)", value: "force simulate Mux4Configurable center_wavelength 1.55 FSR 50nm spacing_x 50 spacing_y 80 bend_radius 5 wl_start 1.48 wl_stop 1.64 n_points 1001", label: "Mux4Configurable · default seed · stage2 ganged · auto-derive Mux4 review baseline" },
      { section: "Force simulate · Mux4Configurable (per-stage seed)", value: "force simulate Mux4Configurable center_wavelength 1.55 FSR 50nm spacing_x 50 spacing_y 80 bend_radius 5 stage2_link_mode independent power_couplings_stage2_up [0.5,0.18,0.18,0.5,0.32] wl_start 1.48 wl_stop 1.64 n_points 1001", label: "Mux4Configurable · stage2 INDEPENDENT · stage2_up has separate κ²" },
    ],
  },
  {
    label: "MMI",
    items: [
      { value: "find similar MMI 1x2 width 12 length 30 wl_start 1.5 wl_stop 1.6 n_points 51", label: "MMI 1×2 · 12×30 µm" },
      { value: "find similar MMI 2x2 width 12 length 60 wl_start 1.5 wl_stop 1.6 n_points 51", label: "MMI 2×2 · 12×60 µm" },
    ],
  },
  {
    label: "AWG (si_fab_awg)",
    items: [
      { value: "force simulate FullAWG center wavelength 1.55 channels 8 channel_spacing 100GHz fsr 1300GHz wg_width 0.45 wl_start 1.5 wl_stop 1.6 n_points 201", label: "FullAWG · 1550 nm · 8ch · 100 GHz · FSR 1300 GHz" },
      { value: "force simulate FullAWG center wavelength 1.55 channels 4 channel_spacing 200GHz fsr 1000GHz wg_width 0.45 wl_start 1.54 wl_stop 1.56 n_points 101", label: "FullAWG · 1550 nm · 4ch · 200 GHz (coarse)" },
      { value: "force simulate FullAWG center_frequency 232200GHz channels 9 channel_spacing 800GHz fsr 10400GHz wg_width 0.45 n_arms auto output_aperture_spacing 7.0 fpr_alpha_factor 1.6 n_points 101", label: "FullAWG · si_fab default (O-band · 9ch · 800 GHz)" },
      { value: "force simulate FullAWG center wavelength 1.55 channels 16 channel_spacing 50GHz fsr 1600GHz n_arms 60 wg_width 0.45 wl_start 1.53 wl_stop 1.57 n_points 401", label: "FullAWG · 1550 nm · 16ch · 50 GHz · N_arms 60" },
      { value: "find similar FullAWG center wavelength 1.55 channels 8 channel_spacing 100GHz n_points 201", label: "FullAWG · 1550 nm · 8ch · lookup similar" },
      { value: "force simulate AWG SiRibAperture wire_width 0.45 aperture_core_width 2.0 taper_length 30 wire_only_length 5 wl_start 1.5 wl_stop 1.6 n_points 101 plot_smatrix true", label: "Aperture · SiRib · w=2.0 · taper 30 µm" },
      { value: "force simulate AWG SiRibMMIAperture mmi_core_width 3.0 mmi_length 9.0 taper_core_width 1.5 taper_cladding_width 7.5 taper_length 30 wl_start 1.5 wl_stop 1.6 n_points 101 plot_smatrix true", label: "Aperture · SiRib MMI · 3.0 × 9.0 µm" },
      { value: "force simulate AWG SiSlabTemplate export_cross_section_png true export_mode_plot true wl_start 1.25 wl_stop 1.35 n_points 101", label: "Slab template · cross-section + modes" },
    ],
  },
  {
    label: "Ring / Racetrack",
    items: [
      { value: "find similar racetrack resonator radius 10 coupling_length 5 wl_start 1.54 wl_stop 1.56 n_points 101", label: "Racetrack · r=10 µm" },
      { value: "find similar ring resonator radius 5 wl_start 1.54 wl_stop 1.56 n_points 101", label: "Ring · r=5 µm" },
    ],
  },
  {
    label: "Grating Coupler",
    items: [
      { value: "find similar grating coupler center wavelength 1.55 n_points 51", label: "Grating Coupler · 1550 nm" },
    ],
  },
  {
    label: "Directional Coupler (straight_length)",
    items: [
      { value: "find similar directional coupler dc_type SiDirectionalCouplerS straight_length 10 wl_start 1.51 wl_stop 1.60 n_points 51", label: "Si S-type · L=10 µm" },
      { value: "find similar directional coupler dc_type SiDirectionalCouplerU straight_length 8 wl_start 1.51 wl_stop 1.60 n_points 51", label: "Si U-type · L=8 µm" },
      { value: "find similar directional coupler dc_type SiNDirectionalCouplerS straight_length 10 wl_start 1.51 wl_stop 1.60 n_points 51", label: "SiN S-type · L=10 µm" },
    ],
  },
  {
    label: "Directional Coupler (power_fraction)",
    items: [
      { value: "find similar directional coupler dc_type SiDirectionalCouplerSPower power_fraction 0.5 target_wavelength 1.55 wl_start 1.51 wl_stop 1.60 n_points 51", label: "Si S-Power · 50:50 @ 1.55 µm" },
      { value: "find similar directional coupler dc_type SiDirectionalCouplerUPower power_fraction 0.5 target_wavelength 1.55 wl_start 1.51 wl_stop 1.60 n_points 51", label: "Si U-Power · 50:50 @ 1.55 µm" },
      { value: "find similar directional coupler dc_type SiNDirectionalCouplerSPower power_fraction 0.3 target_wavelength 1.55 wl_start 1.51 wl_stop 1.60 n_points 51", label: "SiN S-Power · 30:70 @ 1.55 µm" },
    ],
  },
  {
    label: "Waveguide",
    items: [
      { value: "find similar silicon wire waveguide width 0.45 length 10 wl_start 1.5 wl_stop 1.6 n_points 51", label: "Si Wire · w=450 nm · L=10 µm" },
      { value: "find similar silicon nitride waveguide width 0.8 length 10 wl_start 1.5 wl_stop 1.6 n_points 51", label: "SiN Wire · w=800 nm · L=10 µm" },
      { value: "find similar silicon rib waveguide width 0.47 length 10 wl_start 1.5 wl_stop 1.6 n_points 51", label: "Si Rib · w=470 nm · L=10 µm" },
      { value: "find similar waveguide path bend_radius 10 wl_start 1.5 wl_stop 1.6 n_points 51", label: "WG Path · r=10 µm" },
    ],
  },
  {
    label: "Y-Branch / Crossing / Fixed Bend",
    items: [
      { value: "find similar y_branch wl_start 1.5 wl_stop 1.6 n_points 51", label: "Y-Branch · 1.5–1.6 µm" },
      { value: "find similar crossing wl_start 1.5 wl_stop 1.6 n_points 51", label: "Crossing · 1.5–1.6 µm" },
      { value: "find similar fixed_bend bend_radius 10 wl_start 1.5 wl_stop 1.6 n_points 51", label: "Fixed Bend · r=10 µm" },
    ],
  },
  {
    label: "Heater / Phase Shifter / Modulator",
    items: [
      { value: "find similar heater length 100 voltage 1.5 wl_start 1.5 wl_stop 1.6 n_points 51", label: "Heater · L=100 µm · V=1.5" },
      { value: "find similar phase_shifter length 100 wl_start 1.5 wl_stop 1.6 n_points 51", label: "Phase Shifter · L=100 µm" },
      { value: "find similar mzm arm_length 500 wl_start 1.5 wl_stop 1.6 n_points 101", label: "MZM · L=500 µm" },
    ],
  },
  {
    label: "Spiral / Taper",
    items: [
      { value: "find similar spiral length 1000 bend_radius 10", label: "Spiral · L=1000 µm" },
      { value: "find similar sin_inverted_taper length 50 wl_start 1.5 wl_stop 1.6 n_points 51", label: "SiN Inverted Taper · L=50 µm" },
    ],
  },
  {
    label: "Passive / Electrical",
    items: [
      { value: "find similar resistor length 50 width 2", label: "Resistor · 50×2 µm" },
      { value: "find similar u_bend gc_type FC_TE_1550 bend_radius 10", label: "U-Bend Circuit · FC_TE_1550" },
    ],
  },
  {
    label: "Metal Layout",
    items: [
      { value: "force simulate metal bondpad size 100", label: "Metal Bondpad · 100 µm" },
      { value: "force simulate metal rf_pad", label: "Metal RF Pad" },
      { value: "force simulate metal via", label: "Metal Via" },
      { value: "force simulate metal wire width 10 length 100", label: "Metal Wire · 10×100 µm" },
    ],
  },
];

// ── Param filter: skip noisy IPKISS internals ────────────────────────────────
const SKIP_PARAM_VALUES = new Set(["CAPHE", "waveguide_straight", "si_fab", null, undefined, ""]);
const SKIP_PARAM_KEYS = new Set(["out_dir", "export_gds", "export_touchstone", "export_json"]);

function formatParamValue(v: unknown): string {
  if (typeof v === "number") return v % 1 === 0 ? String(v) : v.toFixed(4).replace(/\.?0+$/, "");
  return String(v);
}

function formatDisplayValue(v: unknown): string {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v);
    return v % 1 === 0 ? String(v) : v.toFixed(4).replace(/\.?0+$/, "");
  }
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(", ");
  if (v == null) return "null";
  return JSON.stringify(v);
}

function getObjectValue<T>(value: string | T | undefined): T | null {
  if (!value || typeof value === "string") return null;
  return value;
}

interface NullReviewItem {
  path: string;
  kind: "null" | "empty_array" | "zero_fsr";
  reason: string;
}

function buildSpectrumNullReview(spectrum: SpectrumSummary | null, out: SimOutput | null): NullReviewItem[] {
  const items: NullReviewItem[] = [];
  if (!out) return items;

  if (out.png_path == null) {
    items.push({
      path: "png_path",
      kind: "null",
      reason: "Layout PNG 未輸出 / Layout PNG not exported. Usually export_layout_png=false; configuration result, not necessarily an error.",
    });
  }

  if (out.spectrum_png_path == null) {
    items.push({
      path: "spectrum_png_path",
      kind: "null",
      reason: "頻譜圖片未輸出 / Spectrum image not exported. Usually sa_plot=false or plot_smatrix=false.",
    });
  }

  if (!spectrum) return items;

  const arrayGroups: Array<[keyof SpectrumSummary, string]> = [
    ["peaks", "掃描範圍內沒有偵測到符合條件的峰值 / No matching peaks within sweep range. Common for non-resonant components like directional couplers."],
    ["bands_width", "沒有可用峰值時，bandwidth 也無法估算 / Without usable peaks, bandwidth can't be estimated."],
    ["min_insertion_losses_db", "缺少 passband/peak 定義 / Missing passband/peak definition; can't compute minimum insertion loss."],
    ["max_insertion_losses_db", "缺少 passband/peak 定義 / Missing passband/peak definition; can't compute maximum insertion loss."],
    ["cutoff_passbands", "未形成可辨識的通帶區間 / No identifiable passband region; cutoff passband is empty."],
  ];

  for (const [field, reason] of arrayGroups) {
    const value = spectrum[field];
    if (value && typeof value === "object") {
      for (const [port, arr] of Object.entries(value)) {
        if (Array.isArray(arr) && arr.length === 0) {
          items.push({
            path: `${String(field)}.${port}`,
            kind: "empty_array",
            reason,
          });
        }
      }
    }
  }

  for (const field of ["near_crosstalk_db", "far_crosstalk_db"] as const) {
    const value = spectrum[field];
    if (value && typeof value === "object") {
      for (const [port, scalar] of Object.entries(value)) {
        if (scalar == null) {
          items.push({
            path: `${field}.${port}`,
            kind: "null",
            reason: "沒有足夠 peak / passband 資訊 / Insufficient peak/passband info; analyzer can't derive crosstalk metric.",
          });
        }
      }
    }
  }

  if (spectrum.fsr) {
    for (const [port, fsr] of Object.entries(spectrum.fsr)) {
      if (fsr === 0) {
        items.push({
          path: `fsr.${port}`,
          kind: "zero_fsr",
          reason: "FSR=0 代表掃描窗內峰值不足兩個 / FSR=0 means fewer than 2 peaks within sweep window; can't compute FSR from peak spacing.",
        });
      }
    }
  }

  return items;
}

// ── Component Evaluation Card ─────────────────────────────────────────────────

const VERDICT_STYLES: Record<EvalVerdict, { bg: string; fg: string; label: string }> = {
  pass:    { bg: "#dcfce7", fg: "#166534", label: "PASS" },
  partial: { bg: "#fef3c7", fg: "#92400e", label: "PARTIAL" },
  fail:    { bg: "#fee2e2", fg: "#991b1b", label: "FAIL" },
};

function scoreColor(score: number | undefined): string {
  if (score == null || !Number.isFinite(score)) return "#94a3b8";
  if (score >= 0.85) return "#16a34a";
  if (score >= 0.6)  return "#d97706";
  return "#dc2626";
}

function formatPct(score: number | undefined): string {
  if (score == null || !Number.isFinite(score)) return "—";
  return `${Math.round(score * 100)}%`;
}

function ComponentEvaluationCard({ evaluation }: { evaluation: ComponentEvaluation }) {
  const [expanded, setExpanded] = useState(false);
  const s = evaluation.scores ?? {};
  const w = evaluation.weights ?? {};

  // Ignore deductions for items the user didn't request. A check counts as
  // "user-requested" only when its `requested` field is non-empty. If no
  // checks in a category were requested, that category gets a full score;
  // otherwise the score is the weighted average across requested checks only.
  const wasRequested = (c: ComponentEvalCheck | undefined) => {
    const v = c?.requested;
    return v !== null && v !== undefined && v !== "";
  };
  const recompute = (
    checks: Record<string, ComponentEvalCheck> | undefined,
    fallback: number | undefined,
  ): number | undefined => {
    const all = Object.values(checks ?? {});
    if (all.length === 0) return fallback;
    const requested = all.filter(wasRequested);
    if (requested.length === 0) return 1;
    let sumW = 0, sumSW = 0;
    for (const c of requested) {
      const cw = c.weight ?? 1;
      sumW += cw;
      sumSW += (c.score ?? 0) * cw;
    }
    return sumW > 0 ? sumSW / sumW : fallback;
  };
  const requestedKeys = (
    checks: Record<string, ComponentEvalCheck> | undefined,
    keys: string[],
  ): string[] => {
    const c = checks ?? {};
    return keys.filter(k => wasRequested(c[k]));
  };

  const inputScore  = recompute(evaluation.input_checks,  s.input_score);
  const paramScore  = recompute(evaluation.input_checks,  s.parameter_match_score);
  const outputScore = recompute(evaluation.output_checks, s.output_score);
  const execScore   = s.execution_score;
  const semanticScore = s.semantic_match_score;
  const hasSemantic = semanticScore != null && Number.isFinite(semanticScore);
  // Semantic match dominates at 80% of the overall quality score; the other 20%
  // is split by the existing sub-weights among input / param / output / execution.
  const SEMANTIC_WEIGHT = 0.8;

  const overallScore = (() => {
    const wi = w.input_completeness ?? 0;
    const wp = w.parameter_match ?? 0;
    const wo = w.output_completeness ?? 0;
    const we = w.execution_success ?? 0;
    const subTotal = wi + wp + wo + we;
    const subAvg = subTotal > 0
      ? ((inputScore  ?? 0) * wi
       + (paramScore  ?? 0) * wp
       + (outputScore ?? 0) * wo
       + (execScore   ?? 0) * we) / subTotal
      : (execScore ?? 0);
    if (hasSemantic) {
      return SEMANTIC_WEIGHT * (semanticScore ?? 0) + (1 - SEMANTIC_WEIGHT) * subAvg;
    }
    return subTotal > 0 ? subAvg : s.overall_score;
  })();

  const subRowWeight = (raw?: number) => raw == null ? undefined : raw * (1 - SEMANTIC_WEIGHT);
  const scoreRows: { key: string; label: string; value?: number; weight?: number }[] = [
    ...(hasSemantic
      ? [{ key: "semantic", label: "Semantic Match", value: semanticScore, weight: SEMANTIC_WEIGHT }]
      : []),
    { key: "input",     label: "Input Completeness", value: inputScore,  weight: subRowWeight(w.input_completeness) },
    { key: "param",     label: "Parameter Match",    value: paramScore,  weight: subRowWeight(w.parameter_match) },
    { key: "output",    label: "Output Completeness",value: outputScore, weight: subRowWeight(w.output_completeness) },
    { key: "execution", label: "Execution Success",  value: execScore,   weight: subRowWeight(w.execution_success) },
  ];

  const missingIn  = requestedKeys(evaluation.input_checks,  evaluation.missing_input_keys ?? []);
  const missingOut = requestedKeys(evaluation.output_checks, evaluation.missing_output_keys ?? []);
  const failedKeys = requestedKeys(evaluation.input_checks,  evaluation.failed_parameter_keys ?? []);
  const reqFailed  = requestedKeys(evaluation.input_checks,  evaluation.required_failed_keys ?? []);

  // Re-derive verdict from the adjusted overall score so the badge stays
  // consistent with the displayed number after ignoring unrequested items.
  const verdict: EvalVerdict = (() => {
    if (reqFailed.length > 0) return "fail";
    if (overallScore == null || !Number.isFinite(overallScore)) {
      return evaluation.verdict ?? "partial";
    }
    // Any user-requested param that is out of tolerance → cap verdict at partial,
    // even if the numeric_tolerance score formula produces a near-perfect overall.
    if (failedKeys.length > 0 && overallScore >= 0.85) return "partial";
    if (overallScore >= 0.85) return "pass";
    if (overallScore >= 0.6)  return "partial";
    return "fail";
  })();
  const vstyle = VERDICT_STYLES[verdict];

  return (
    <div style={{
      marginTop: 10, padding: 10, borderRadius: 8,
      background: "#f8fafc", border: "1px solid var(--border)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{
          display: "inline-block", padding: "2px 8px", borderRadius: 4,
          fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
          background: vstyle.bg, color: vstyle.fg,
        }}>{vstyle.label}</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
          Component IO Quality
        </span>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {evaluation.component_name ?? evaluation.component_type ?? "—"}
          {evaluation.semantic_tag ? ` · ${evaluation.semantic_tag}` : ""}
          {evaluation.rule_version ? ` · ${evaluation.rule_version}` : ""}
        </span>
        <span style={{
          marginLeft: "auto", fontSize: 20, fontWeight: 700,
          color: scoreColor(overallScore), fontFamily: "monospace",
        }}>
          {formatPct(overallScore)}
        </span>
      </div>

      <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr", gap: 4 }}>
        {scoreRows.map(row => (
          <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span style={{ width: 150, color: "var(--text-muted)" }}>
              {row.label}
              {row.weight != null ? <span style={{ opacity: 0.6 }}> ({Math.round(row.weight * 100)}%)</span> : null}
            </span>
            <div style={{ flex: 1, height: 6, background: "#e2e8f0", borderRadius: 3, overflow: "hidden" }}>
              <div style={{
                width: `${Math.max(0, Math.min(1, row.value ?? 0)) * 100}%`,
                height: "100%",
                background: scoreColor(row.value),
                transition: "width 0.2s",
              }} />
            </div>
            <span style={{
              width: 42, textAlign: "right", fontFamily: "monospace",
              color: scoreColor(row.value),
            }}>
              {formatPct(row.value)}
            </span>
          </div>
        ))}
      </div>

      {evaluation.llm_review && (
        <div style={{
          marginTop: 10, padding: "8px 10px", borderRadius: 6,
          background: "#f0f9ff", border: "1px solid #bae6fd",
          display: "flex", flexDirection: "column", gap: 4,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span style={{ fontWeight: 700, color: "#0369a1" }}>LLM Review</span>
            {evaluation.llm_review.llm_verdict && (
              <span style={{
                padding: "1px 6px", borderRadius: 3, fontSize: 11, fontWeight: 700,
                background: VERDICT_STYLES[evaluation.llm_review.llm_verdict].bg,
                color: VERDICT_STYLES[evaluation.llm_review.llm_verdict].fg,
              }}>
                {VERDICT_STYLES[evaluation.llm_review.llm_verdict].label}
              </span>
            )}
            {evaluation.llm_review.model && (
              <span style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "monospace" }}>
                {evaluation.llm_review.model}
              </span>
            )}
            <span style={{
              marginLeft: "auto", fontFamily: "monospace", fontWeight: 700,
              color: scoreColor(evaluation.llm_review.llm_score ?? undefined),
            }}>
              {formatPct(evaluation.llm_review.llm_score ?? undefined)}
            </span>
          </div>
          {evaluation.llm_review.llm_reasoning && (
            <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {evaluation.llm_review.llm_reasoning}
            </div>
          )}
          {(evaluation.llm_review.improvement_suggestions?.length ?? 0) > 0 && (
            <ul style={{ margin: "4px 0 0 18px", padding: 0, fontSize: 12, color: "#334155", lineHeight: 1.5 }}>
              {evaluation.llm_review.improvement_suggestions!.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          )}
          {!evaluation.llm_review.llm_reasoning && !evaluation.llm_review.llm_score && (
            <div style={{ fontSize: 11, color: "#dc2626" }}>
              LLM 評分失敗 / LLM evaluation failed (model returned no valid JSON{evaluation.llm_review.error ? ` · ${String(evaluation.llm_review.error).slice(0, 120)}` : ""})
            </div>
          )}
        </div>
      )}

      {(missingIn.length || missingOut.length || failedKeys.length || reqFailed.length) ? (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3, fontSize: 12 }}>
          {reqFailed.length > 0 && (
            <div>
              <span style={{ color: "#991b1b", fontWeight: 600 }}>Required failed: </span>
              <span style={{ fontFamily: "monospace" }}>{reqFailed.join(", ")}</span>
            </div>
          )}
          {failedKeys.length > 0 && (
            <div>
              <span style={{ color: "#b45309", fontWeight: 600 }}>Mismatched: </span>
              <span style={{ fontFamily: "monospace" }}>{failedKeys.join(", ")}</span>
            </div>
          )}
          {missingIn.length > 0 && (
            <div>
              <span style={{ color: "var(--text-muted)" }}>Missing input: </span>
              <span style={{ fontFamily: "monospace" }}>{missingIn.join(", ")}</span>
            </div>
          )}
          {missingOut.length > 0 && (
            <div>
              <span style={{ color: "var(--text-muted)" }}>Missing output: </span>
              <span style={{ fontFamily: "monospace" }}>{missingOut.join(", ")}</span>
            </div>
          )}
        </div>
      ) : null}

      {(Object.keys(evaluation.input_checks ?? {}).length + Object.keys(evaluation.output_checks ?? {}).length) > 0 && (
        <>
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            style={{
              marginTop: 8, background: "transparent", border: "none",
              color: "var(--accent)", cursor: "pointer", fontSize: 12,
              padding: 0, textAlign: "left",
            }}
          >
            {expanded ? "▾ Hide details" : "▸ Show per-parameter details"}
          </button>
          {expanded && (
            <div style={{ marginTop: 6, fontSize: 11, fontFamily: "monospace", color: "var(--text)" }}>
              {(["input_checks", "output_checks"] as const).map(role => {
                const checks = evaluation[role] ?? {};
                const entries = Object.entries(checks);
                if (!entries.length) return null;
                return (
                  <div key={role} style={{ marginTop: 4 }}>
                    <div style={{ color: "var(--text-muted)", fontWeight: 600 }}>
                      {role === "input_checks" ? "Inputs" : "Outputs"}
                    </div>
                    {entries.map(([k, c]) => (
                      <div key={k} style={{
                        display: "grid",
                        gridTemplateColumns: "140px 140px minmax(0, 1fr)",
                        gap: 8, padding: "1px 0",
                        alignItems: "start",
                      }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {k}{c.required ? "*" : ""}
                        </span>
                        <span style={{ color: c.pass ? "#16a34a" : "#dc2626", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {c.status}
                        </span>
                        <span style={{ color: "var(--text-muted)", minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" }}>
                          req={formatDisplayValue(c.requested)} · act={formatDisplayValue(c.actual)}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Layout slot (renders one half of the Previous | Current GDS split) ────────

/**
 * SpectrumPngSlot — renders a single saved spectrum PNG with its own zoom +
 * pan-by-drag affordance. Used inside the SIMULATION OUTPUT pane to host either
 * a single Current PNG or a Previous | Current pair after replay/optimize iter.
 *
 * Mirrors LayoutSlot's pattern but for static images (no iframe / svg variants),
 * served from /api/results so the Current and Previous come from the same place.
 */
function SpectrumPngSlot({
  pngBasename, title, isPrev, flexBasis, zoom, onZoomChange, onClose,
}: {
  pngBasename: string;
  title: string | null;
  isPrev: boolean;
  flexBasis: string;
  zoom: number;
  onZoomChange: (z: number) => void;
  onClose?: () => void;
}) {
  const zoomBtn: React.CSSProperties = {
    padding: "1px 6px", fontSize: 11, lineHeight: 1,
    background: "#fff", border: "1px solid #d6d3d1", borderRadius: 3,
    cursor: "pointer", color: "#374151",
  };
  return (
    <div style={{
      flex: `0 0 ${flexBasis}`, minWidth: 0, height: "100%",
      display: "flex", flexDirection: "column", overflow: "hidden",
      opacity: isPrev ? 0.88 : 1,
    }}>
      {/* Title bar always shown so zoom controls are reachable in single-slot mode too. */}
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
        color: isPrev ? "#a8a29e" : "#0f766e",
        padding: "2px 6px", background: isPrev ? "#fafaf9" : "#f0fdfa",
        borderBottom: "1px solid #e7e5e4",
        display: "flex", alignItems: "center", gap: 6,
      }}>
        {title && <span>{title}</span>}
        <span style={{ fontWeight: 400, color: "#a8a29e", fontFamily: "monospace", fontSize: 10,
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
          {pngBasename}
        </span>
        <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
          <button type="button" style={zoomBtn}
            onClick={() => onZoomChange(Math.max(0.25, Math.round((zoom - 0.25) * 100) / 100))}
            title="Zoom out"
          >−</button>
          <button type="button" style={zoomBtn}
            onClick={() => onZoomChange(1)}
            title="Reset zoom · drag image when zoom>1 to pan"
          >{Math.round(zoom * 100)}%</button>
          <button type="button" style={zoomBtn}
            onClick={() => onZoomChange(Math.min(4, Math.round((zoom + 0.25) * 100) / 100))}
            title="Zoom in"
          >+</button>
          <a
            href={`/api/results/${encodeURIComponent(pngBasename)}`}
            download
            style={{ ...zoomBtn, textDecoration: "none", color: "#0f766e" }}
            title="Download PNG"
          >⬇</a>
          {onClose && (
            <button type="button"
              style={{ ...zoomBtn, color: "#9f1239", borderColor: "#fecdd3" }}
              onClick={onClose}
              title="Close previous spectrum"
            >✕</button>
          )}
        </div>
      </div>
      <div
        className="spectrum-png-viewer"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const el = e.currentTarget;
          const startX = e.clientX, startY = e.clientY;
          const startScrollLeft = el.scrollLeft, startScrollTop = el.scrollTop;
          el.setPointerCapture(e.pointerId);
          el.style.cursor = "grabbing";
          const onMove = (ev: PointerEvent) => {
            el.scrollLeft = startScrollLeft - (ev.clientX - startX);
            el.scrollTop  = startScrollTop  - (ev.clientY - startY);
          };
          const onUp = (ev: PointerEvent) => {
            el.releasePointerCapture(ev.pointerId);
            el.style.cursor = "";
            el.removeEventListener("pointermove", onMove);
            el.removeEventListener("pointerup",   onUp);
            el.removeEventListener("pointercancel", onUp);
          };
          el.addEventListener("pointermove", onMove);
          el.addEventListener("pointerup",   onUp);
          el.addEventListener("pointercancel", onUp);
        }}
        style={{ flex: 1, minHeight: 0, cursor: zoom > 1 ? "grab" : "default" }}
      >
        <div className="spectrum-png-frame"
          style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%`, pointerEvents: "none" }}>
          <Image
            src={`/api/results/${encodeURIComponent(pngBasename)}`}
            alt={pngBasename}
            fill
            unoptimized
            className="spectrum-png-image"
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}

function LayoutSlot({
  refs,
  title,
  isPrev,
  flexBasis,
  zoom,
  onZoomChange,
  onClose,
}: {
  refs: { htmlUrl: string | null; svgUrl: string | null; pngUrl: string | null };
  title?: string;
  isPrev: boolean;
  flexBasis?: string;
  zoom: number;
  onZoomChange: (z: number) => void;
  onClose?: () => void;   // only Previous slot provides this (to dismiss the prior layout)
}) {
  const { htmlUrl, svgUrl, pngUrl } = refs;
  const basename = (() => {
    const u = htmlUrl || svgUrl || pngUrl;
    if (!u) return null;
    try { return decodeURIComponent(u).replace(/^.*\//, ""); }
    catch { return u.replace(/^.*\//, ""); }
  })();
  const hasContent = !!(htmlUrl || svgUrl || pngUrl);
  const zoomBtnStyle: React.CSSProperties = {
    padding: "1px 6px", fontSize: 11, lineHeight: 1,
    background: "#fff", border: "1px solid #d6d3d1", borderRadius: 3,
    cursor: "pointer", color: "#374151",
  };
  return (
    <div style={{
      // flex-basis governs the main-axis size in both row and column parent
      // orientations; align-items: stretch on the parent stretches the cross
      // axis. Explicit `height: 100%` would fight column mode (it'd override
      // flex-basis when main axis is vertical), so we omit it.
      flex: flexBasis ? `0 0 ${flexBasis}` : "1 1 0",
      minWidth: 0, minHeight: 0,
      display: "flex", flexDirection: "column", overflow: "hidden",
      opacity: isPrev ? 0.88 : 1,
    }}>
      {title && (
        <div style={{
          fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
          color: isPrev ? "#a8a29e" : "#0f766e",
          padding: "2px 6px", background: isPrev ? "#fafaf9" : "#f0fdfa",
          borderBottom: "1px solid #e7e5e4",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <span>{title}</span>
          {basename && (
            <span style={{ fontWeight: 400, color: "#a8a29e", fontFamily: "monospace", fontSize: 10,
                           overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
              {basename}
            </span>
          )}
          {/* zoom controls (always available when there is content) */}
          {hasContent && (
            <div style={{ display: "flex", gap: 2, alignItems: "center", marginLeft: basename ? 0 : "auto" }}>
              <button type="button" style={zoomBtnStyle}
                onClick={() => onZoomChange(Math.max(0.25, Math.round((zoom - 0.25) * 100) / 100))}
                title="Zoom out" aria-label="Zoom out"
              >−</button>
              <button type="button" style={zoomBtnStyle}
                onClick={() => onZoomChange(1)}
                title="Reset zoom" aria-label="Reset zoom"
              >{Math.round(zoom * 100)}%</button>
              <button type="button" style={zoomBtnStyle}
                onClick={() => onZoomChange(Math.min(4, Math.round((zoom + 0.25) * 100) / 100))}
                title="Zoom in" aria-label="Zoom in"
              >+</button>
            </div>
          )}
          {/* close button only on Previous slot */}
          {onClose && (
            <button type="button"
              style={{ ...zoomBtnStyle, color: "#9f1239", borderColor: "#fecdd3" }}
              onClick={onClose}
              title="Close previous layout" aria-label="Close previous layout"
            >✕</button>
          )}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "#fff" }}>
        {hasContent ? (
          <div style={{
            transform: `scale(${zoom})`,
            transformOrigin: "0 0",
            width: `${100 / zoom}%`,
            height: `${100 / zoom}%`,
          }}>
            {htmlUrl
              ? <iframe src={htmlUrl} title="Layout preview"
                  style={{ width: "100%", height: "100%", border: "none", background: "#fff" }} />
              : svgUrl
              ? <GdsViewer url={svgUrl} />
              : pngUrl
              ? <img src={pngUrl} alt="Layout preview"
                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
              : null}
          </div>
        ) : (
          <div className="gds-placeholder">
            {isPrev ? "no previous run yet" : "模擬完成後，版圖預覽將顯示於此 / Layout preview will appear here after simulation"}
            {!isPrev && <><br /><span style={{ fontSize: 10 }}>（HTML / SVG / PNG）</span></>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Replay Panel ──────────────────────────────────────────────────────────────

const REPLAY_FIELDS: { key: string; label: string; placeholder?: string; step?: string }[] = [
  { key: "center_wavelength_um", label: "center_wavelength_um", placeholder: "1.56", step: "0.001" },
  { key: "fsr_nm",               label: "fsr_nm",               placeholder: "25",    step: "0.1"   },
  { key: "wl_start_um",          label: "wl_start_um",          placeholder: "1.52",  step: "0.001" },
  { key: "wl_stop_um",           label: "wl_stop_um",           placeholder: "1.60",  step: "0.001" },
  { key: "n_points",             label: "n_points",             placeholder: "161",   step: "1"     },
  { key: "bend_radius",          label: "bend_radius",          placeholder: "8",     step: "0.1"   },
];

type SeedMeta = {
  wdm_type: string | null;
  fsr_um: number | null;
  fsr_nm: number | null;
  center_wavelength_um: number | null;
  bend_radius: number | null;
  delay_lengths_um: number[] | null;
  power_couplings: number[] | null;
  dc_type: string | null;
  wl_start_um: number | null;
  wl_stop_um: number | null;
  n_points: number | null;
  // Mux4 / Mux4Configurable / Mux8 layout placement (μm). Null on
  // MZILatticeFilter / Mux2 seeds (no inter-stage spacing concept there).
  spacing_x: number | null;
  spacing_y: number | null;
  // Mux4Configurable per-stage seed values (populated by Mux4StagedReplayWrapper
  // when in STAGE INDEPENDENT view so lattice presets can pre-fill stage1 /
  // stage2 (ganged) or stage1 / stage2_up / stage2_down (independent) all at
  // once. `stage2_ganged` tells the preset which key family to emit.
  delay_lengths_stage1?: number[] | null;
  delay_lengths_stage2?: number[] | null;
  delay_lengths_stage2_up?: number[] | null;
  delay_lengths_stage2_down?: number[] | null;
  power_couplings_stage1?: number[] | null;
  power_couplings_stage2?: number[] | null;
  power_couplings_stage2_up?: number[] | null;
  power_couplings_stage2_down?: number[] | null;
  stage2_ganged?: boolean;
};

type ReplayOverrideValue = number | string | number[];
type ReplayOverrides = Record<string, ReplayOverrideValue>;

/**
 * Canonical 4-stage MZI lattice delay sequence from the Luceda Mux2 / Bogaerts 2015
 * half-band FIR design. Returns [L, 2L, -(2L+Lπ), -2L] in µm.
 *   L  = λ_c² / (n_g · FSR)
 *   Lπ = λ_c / (2 · n_eff)
 * Used as a seed-side default when a case-hit row carries no delay_lengths_um —
 * the netlist still has its own delays at replay time, but the editor needs a
 * sensible numeric to show users.
 */
function canonicalLatticeDelaysUm(centerUm: number | null, fsrUm: number | null): number[] {
  const lambda = centerUm ?? 1.55;
  const fsr = fsrUm && fsrUm > 0 ? fsrUm : 0.020;
  const n_g = 4.18;     // si_wire @ 1550 nm typical
  const n_eff = 2.40;
  const L = (lambda * lambda) / (n_g * fsr);
  const Lpi = lambda / (2 * n_eff);
  const r = (x: number) => Math.round(x * 100) / 100;
  return [r(L), r(2 * L), r(-(2 * L + Lpi)), r(-2 * L)];
}

/**
 * Rescale delays when shifting the center wavelength while keeping FSR constant.
 *
 * Physics (Bogaerts 2015 / Luceda Mux2):
 *   ΔL = λ² / (n_g · FSR)         → ΔL ∝ λ²
 *   Lπ = λ  / (2 · n_eff)         → Lπ ∝ λ
 *
 * For a small shift (e.g. 1.555 → 1.551 µm, |Δλ/λ| ≈ 0.3%), the (λ²) scalar
 * captures > 99% of the correction; we apply it to all four entries verbatim
 * because the Lπ correction term is < 1% of L. For larger shifts re-derive
 * canonical from scratch instead.
 *
 * If seed delays aren't available, fall back to canonical at the new λ — that's
 * the recipe Bogaerts followed for stage-2 of the cascaded CWDM design.
 */
function rescaleDelaysForCenterShift(
  baseDelays: number[] | null,
  baseLambda: number | null,
  newLambda: number,
  fsrUm: number | null,
): number[] {
  if (
    baseDelays && baseDelays.length === 4 &&
    baseLambda && baseLambda > 0 && newLambda > 0
  ) {
    const k = (newLambda * newLambda) / (baseLambda * baseLambda);
    return baseDelays.map((d) => Math.round(d * k * 100) / 100);
  }
  return canonicalLatticeDelaysUm(newLambda, fsrUm);
}

/**
 * Rescale halfband delays when EITHER center wavelength OR FSR changes.
 *
 *   ΔL = λ² / (n_g · FSR)
 *
 * So a (λ, FSR) → (λ', FSR') change scales every delay by:
 *
 *   k = (λ'/λ)² · (FSR/FSR')
 *
 * The Lπ correction (∝ λ) is < 1% for the small shifts the editor exposes,
 * so we apply k uniformly to all four entries — same approximation as
 * rescaleDelaysForCenterShift, just generalised to also cover FSR edits.
 *
 * Returns null when inputs are missing or non-positive (caller should
 * treat null as "do not auto-rescale").
 */
function rescaleDelaysForParams(
  baseDelays: number[] | null,
  baseLambda: number | null,
  baseFsrUm: number | null,
  newLambda: number | null,
  newFsrUm: number | null,
): number[] | null {
  if (!baseDelays || baseDelays.length === 0) return null;
  const lo = baseLambda ?? 1.55;
  const fo = baseFsrUm  ?? 0.02;
  const ln = newLambda ?? lo;
  const fn = newFsrUm  ?? fo;
  if (lo <= 0 || fo <= 0 || ln <= 0 || fn <= 0) return null;
  if (Math.abs(ln - lo) < 1e-9 && Math.abs(fn - fo) < 1e-12) return null;  // no change
  const k = (ln * ln) / (lo * lo) * (fo / fn);
  return baseDelays.map((d) => Math.round(d * k * 1000) / 1000);
}

const CANONICAL_POWER_COUPLINGS: number[] = [0.5, 0.13, 0.12, 0.5, 0.25];

// appliesTo: which seed wdm_type this preset is designed for.
//   "all"         → shown on any seed (high-level overrides work everywhere)
//   "mzilattice"  → shown only on MZILatticeFilter seed (low-level arrays)
//   "mux"         → shown only on Mux2/Mux4/Mux8/MuxParametric seed
//
// Preset MUST provide either `overrides` (absolute) OR `overridesFn` (relative,
// computed from current seed meta). Relative presets re-evaluate every iteration
// so "delay × 0.8" always means "0.8 × whatever the latest seed has".
const REPLAY_PRESETS: {
  label: string;
  overrides?: ReplayOverrides;
  overridesFn?: (meta: SeedMeta) => ReplayOverrides;
  appliesTo?: "all" | "mzilattice" | "mux";
}[] = [
  // ── Always applicable (all seed types accept these high-level params) ──
  // ── Edit current: pre-fill editable fields with current seed values, then user tweaks freely ──
  { label: "✎ Edit scalar params (fsr / center / sweep / bend_radius)",
    overridesFn: (m) => {
      const o: ReplayOverrides = {};
      if (m.fsr_nm != null)              o.fsr_nm              = m.fsr_nm;
      if (m.center_wavelength_um != null) o.center_wavelength_um = m.center_wavelength_um;
      if (m.wl_start_um != null)         o.wl_start_um         = m.wl_start_um;
      if (m.wl_stop_um != null)          o.wl_stop_um          = m.wl_stop_um;
      if (m.n_points != null)            o.n_points            = m.n_points;
      if (m.bend_radius != null)         o.bend_radius         = m.bend_radius;
      // spacing_x/y — only Mux4 / Mux4Configurable / Mux8 use these. seedMeta
      // sets them null on MZILatticeFilter / Mux2 stage views, so this branch
      // naturally skips them when irrelevant.
      if (m.spacing_x != null)           o.spacing_x           = m.spacing_x;
      if (m.spacing_y != null)           o.spacing_y           = m.spacing_y;
      return o;
    },
    appliesTo: "all" },

  // ── Lattice-aware presets ──
  // For Mux4Configurable TOP view, expose stage_1 + stage_2 fields side-by-side
  // (stage_1 runs at FSR/2, stage_2 at FSR — different canonical delays). For
  // MZILatticeFilter (or stage view), expose the single-stage fields.
  { label: "✎ Edit delay_lengths_um + power_couplings",
    overridesFn: (m): ReplayOverrides => {
      const center = m.center_wavelength_um ?? 1.55;
      const topFsr = m.fsr_um ?? 0.05;
      if (m.wdm_type === "Mux4Configurable") {
        const out: ReplayOverrides = {};
        // Stage 1 — always one set (FSR/2 halfband).
        out.delay_lengths_stage1 = m.delay_lengths_stage1
          ? [...m.delay_lengths_stage1]
          : canonicalLatticeDelaysUm(center, topFsr / 2);
        out.power_couplings_stage1 = m.power_couplings_stage1
          ? [...m.power_couplings_stage1]
          : [...CANONICAL_POWER_COUPLINGS];
        if (m.stage2_ganged === false) {
          // Independent: emit separate up/down sets so user can tune each.
          out.delay_lengths_stage2_down = m.delay_lengths_stage2_down
            ? [...m.delay_lengths_stage2_down]
            : canonicalLatticeDelaysUm(center, topFsr);
          out.power_couplings_stage2_down = m.power_couplings_stage2_down
            ? [...m.power_couplings_stage2_down]
            : [...CANONICAL_POWER_COUPLINGS];
          out.delay_lengths_stage2_up = m.delay_lengths_stage2_up
            ? [...m.delay_lengths_stage2_up]
            : canonicalLatticeDelaysUm(center + topFsr / 4, topFsr);
          out.power_couplings_stage2_up = m.power_couplings_stage2_up
            ? [...m.power_couplings_stage2_up]
            : [...CANONICAL_POWER_COUPLINGS];
        } else {
          // Ganged: one set for both stage_2 cells.
          out.delay_lengths_stage2 = m.delay_lengths_stage2
            ? [...m.delay_lengths_stage2]
            : canonicalLatticeDelaysUm(center, topFsr);
          out.power_couplings_stage2 = m.power_couplings_stage2
            ? [...m.power_couplings_stage2]
            : [...CANONICAL_POWER_COUPLINGS];
        }
        return out;
      }
      // MZILatticeFilter / non-configurable fallback.
      const out: ReplayOverrides = {};
      out.delay_lengths_um = m.delay_lengths_um
        ? [...m.delay_lengths_um]
        : canonicalLatticeDelaysUm(center, topFsr);
      out.power_couplings = m.power_couplings
        ? [...m.power_couplings]
        : [...CANONICAL_POWER_COUPLINGS];
      return out;
    },
    appliesTo: "mzilattice" },

  // ── Coupling variant: same wdm_type / ganged-aware split ──
  { label: "coupling variant · κ²=[0.5,0.2,0.18,0.5,0.35]",
    overridesFn: (m): ReplayOverrides => {
      const variant = [0.5, 0.2, 0.18, 0.5, 0.35];
      if (m.wdm_type === "Mux4Configurable") {
        const out: ReplayOverrides = {};
        out.power_couplings_stage1 = [...variant];
        if (m.stage2_ganged === false) {
          out.power_couplings_stage2_down = [...variant];
          out.power_couplings_stage2_up = [...variant];
        } else {
          out.power_couplings_stage2 = [...variant];
        }
        return out;
      }
      const out: ReplayOverrides = {};
      out.power_couplings = [...variant];
      return out;
    },
    appliesTo: "mzilattice" },

  { label: "dc_type → SiNDirectionalCouplerSPower",
    overrides: { dc_type: "SiNDirectionalCouplerSPower" },
    appliesTo: "mzilattice" },
];

function isPresetForSeed(appliesTo: "all" | "mzilattice" | "mux" | undefined, wdmType: string | null): boolean {
  const scope = appliesTo ?? "all";
  if (scope === "all") return true;
  if (!wdmType) return false;  // unknown seed → hide type-specific presets
  // Mux4Configurable wraps 3 raw MZILatticeFilter children (no LockedProperty),
  // so it accepts the same top-level lattice overrides as a bare
  // MZILatticeFilter seed (they propagate to every stage).
  if (scope === "mzilattice") return wdmType === "MZILatticeFilter" || wdmType === "Mux4Configurable";
  if (scope === "mux") return ["Mux2", "Mux4", "Mux4Configurable", "Mux8", "MuxParametric"].includes(wdmType);
  return false;
}

// Keys that Mux4/Mux8/Mux2 actually read as API body overrides.
// Inner Mux2.delay_lengths is locked (auto-computed from fsr+center_wavelength),
// so delay_lengths_um / power_couplings / dc_type etc. are reference-only for those seeds.
const MUX_PASSTHRU_KEYS = new Set([
  "fsr", "fsr_nm",
  "center_wavelength", "center_wavelength_um",
  "bend_radius", "bend_radius_um",
  "spacing_x", "spacing_y",
  "wl_start_um", "wl_stop_um", "n_points",
  "core_width_um", "wg_family",
  "phase_error_width_deviation", "phase_error_correlation_length",
]);

function isPresetApplicable(
  overrides: Record<string, unknown>,
  wdmType: string | null,
): { ok: boolean; reason?: string } {
  if (!wdmType) return { ok: true };  // unknown seed → keep current (open) behavior
  const t = wdmType;
  if (t === "MZILatticeFilter") return { ok: true };
  if (t === "Mux4" || t === "Mux8" || t === "Mux2") {
    const bad = Object.keys(overrides).filter(k => !MUX_PASSTHRU_KEYS.has(k));
    if (bad.length) return { ok: false, reason: `${t} 內部 Mux2 locked / internal Mux2 locked: ${bad.join(", ")} won't take effect (for reference only)` };
    return { ok: true };
  }
  if (t === "MuxParametric") {
    const disallow = new Set(["delay_lengths_um", "delay_lengths", "power_couplings"]);
    const bad = Object.keys(overrides).filter(k => disallow.has(k));
    if (bad.length) return { ok: false, reason: `MuxParametric 內部自動 / handles internally: ${bad.join(", ")} won't take effect` };
    return { ok: true };
  }
  return { ok: true };
}

/**
 * CalibrateLauncher — post-fab inverse-fit + LLM diagnose + apply-and-verify.
 *
 * Orchestrates the 3-step calibration chain:
 *   1. POST /api/calibrate-fit       → drift = measured S vs design (κ_fab, ΔL_fab)
 *   2. POST /api/calibrate-diagnose  → recipe (per-arm Δφ + per-DC Δκ trim)
 *   3. (optional) POST /api/replay   → judge with recipe applied to design
 *
 * Inputs assumed from this card:
 *   - design = seedMeta (what we tried to fab)
 *   - measurement = touchstone .s4p (drifted real chip OR fake from another sim)
 *
 * Recipe → ΔL_apply = ΔL_design + Δφ · λ_c / (2π · n_eff)
 * Recipe → κ_apply  = clamp(κ_design + Δκ_trim, 0, 1)
 *
 * Designed to fail-soft: if /ipkiss server lacks the inverse_fit endpoint
 * (older deploy) or Ollama is down, errors render inline without crashing.
 *
 * See memory: project_calibration_loop.md
 */
type CalibrationResult = {
  error?: string;
  detail?: string;
  fit?: { data?: { drift?: Record<string, unknown>; fit?: Record<string, unknown>; model?: Record<string, unknown> }; status?: string; message?: string };
  diagnose?: { decision?: { drift_mode?: string; diagnosis?: string; recipe?: { phase_compensation_rad?: number[]; kappa_trim?: number[]; expected_peak_um_after?: number | null }; feasibility?: { phase_within_2pi?: boolean; max_phase_rad?: number | null; max_kappa_trim?: number | null; warnings?: string[] }; confidence?: number }; invariant_ok?: boolean; invariant_reasons?: string[] };
  verify?: { evaluation?: { verdict?: string; score?: number; checks?: Record<string, unknown> }; spectrum_png_path?: string };
  applied?: { delay_lengths_um?: number[]; power_couplings?: number[] };
};

function CalibrateLauncher({
  busy, seedMeta, netlistPath, hardSpec,
}: {
  busy: boolean;
  seedMeta: SeedMeta;
  netlistPath: string;
  // Shared HARD-SPEC GATES (lifted to ReplayPanel). Used in the apply+verify
  // step so the calibration verdict matches Replay/Optimize verdicts.
  hardSpec: {
    maxIlDb: string;
    maxRippleDb: string;
    xtBaselineDb: string;
    xtTolDb: string;
    minBwUm: string;
    fsrErrPct: string;
    budget: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const [touchstonePath, setTouchstonePath] = useState<string>("");
  const [applyAndVerify, setApplyAndVerify] = useState(true);
  const [phaseMaxRad, setPhaseMaxRad] = useState<string>((2 * Math.PI).toFixed(4));
  const [kappaMaxTrim, setKappaMaxTrim] = useState<string>("0.05");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CalibrationResult | null>(null);

  // Default touchstone to this card's own sNp output if the user doesn't override —
  // a sanity baseline (measurement == design's own sim → drift ≈ 0).
  const defaultTouchstone = useMemo(() => {
    const m = seedMeta as unknown as { sNp_path?: string };
    return typeof m.sNp_path === "string" ? m.sNp_path : "";
  }, [seedMeta]);
  const tsPath = touchstonePath.trim() || defaultTouchstone;

  const designReady = !!seedMeta.delay_lengths_um?.length && !!seedMeta.power_couplings?.length
    && seedMeta.power_couplings.length === seedMeta.delay_lengths_um.length + 1
    && Number.isFinite(seedMeta.center_wavelength_um);

  async function runCalibrate() {
    if (!designReady || !tsPath) return;
    setRunning(true);
    setResult(null);
    try {
      const designBlock: Record<string, unknown> = {
        power_couplings:      seedMeta.power_couplings,
        delay_lengths_um:     seedMeta.delay_lengths_um,
        center_wavelength_um: seedMeta.center_wavelength_um,
        wg_family:            "si_wire",
        core_width_um:        0.47,
      };
      // ── Step 1: inverse fit ──
      const fitResp = await fetch("/api/calibrate-fit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ design: designBlock, touchstone_path: tsPath }),
      });
      const fitJson = await fitResp.json();
      if (!fitResp.ok || fitJson?.status !== "success") {
        setResult({
          error: "inverse fit failed",
          detail: fitJson?.message ?? `HTTP ${fitResp.status}`,
          fit: fitJson,
        });
        return;
      }

      // ── Step 2: diagnose ──
      const diagResp = await fetch("/api/calibrate-diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inverse_fit_response: fitJson,
          thresholds: {
            phase_max_rad:  Number(phaseMaxRad)  || 2 * Math.PI,
            kappa_max_trim: Number(kappaMaxTrim) || 0.05,
          },
        }),
      });
      const diagJson = await diagResp.json();
      if (!diagResp.ok) {
        setResult({
          error: "diagnose failed",
          detail: diagJson?.error ?? `HTTP ${diagResp.status}`,
          fit: fitJson,
        });
        return;
      }

      // ── Step 3 (optional): apply recipe + judge ──
      let verifyJson: CalibrationResult["verify"] | undefined;
      let appliedDelays: number[] | undefined;
      let appliedKappa: number[] | undefined;
      if (applyAndVerify && diagJson?.decision?.recipe) {
        const recipe = diagJson.decision.recipe as { phase_compensation_rad?: number[]; kappa_trim?: number[] };
        const lambdaC = Number(seedMeta.center_wavelength_um) || 1.55;
        const neff = Number((fitJson?.data?.model as { n_eff_at_center?: number } | undefined)?.n_eff_at_center) || 2.4;
        const designedDelays = seedMeta.delay_lengths_um!;
        const designedKappa  = seedMeta.power_couplings!;
        const phaseToLength = lambdaC / (2 * Math.PI * neff);
        appliedDelays = designedDelays.map((d, i) =>
          d + (recipe.phase_compensation_rad?.[i] ?? 0) * phaseToLength,
        );
        appliedKappa = designedKappa.map((k, i) =>
          Math.max(0, Math.min(1, k + (recipe.kappa_trim?.[i] ?? 0))),
        );
        // Inject the shared HARD-SPEC GATES so the calibration verdict uses
        // the same thresholds as Replay/Optimize. Empty fields fall through
        // to backend defaults via numOr().
        const numOr = (s: string, fb: number | null): number | null => {
          const n = Number(s);
          return Number.isFinite(n) ? n : fb;
        };
        const gateInjects: Record<string, number> = {};
        const minBw = numOr(hardSpec.minBwUm, null);     if (minBw != null) gateInjects.target_3db_bw_um = minBw;
        const il    = numOr(hardSpec.maxIlDb, null);     if (il != null)    gateInjects.il_limit_db = il;
        const rip   = numOr(hardSpec.maxRippleDb, null); if (rip != null)   gateInjects.ripple_limit_db = rip;
        const xtB   = numOr(hardSpec.xtBaselineDb, null);if (xtB != null)   gateInjects.crosstalk_baseline_db = xtB;
        const xtT   = numOr(hardSpec.xtTolDb, null);     if (xtT != null)   gateInjects.crosstalk_tolerance_db = xtT;
        const fsrE  = numOr(hardSpec.fsrErrPct, null);   if (fsrE != null)  gateInjects.fsr_error_tol_pct = fsrE;
        if (seedMeta.fsr_um != null) gateInjects.target_min_fsr_um = seedMeta.fsr_um;
        const verifyResp = await fetch("/api/replay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            netlist_json: netlistPath,
            center_wavelength_um: lambdaC,
            delay_lengths_um:     appliedDelays,
            power_couplings:      appliedKappa,
            ...gateInjects,
          }),
        });
        verifyJson = await verifyResp.json();
      }

      setResult({
        fit: fitJson,
        diagnose: diagJson,
        verify: verifyJson,
        applied: appliedDelays && appliedKappa
          ? { delay_lengths_um: appliedDelays, power_couplings: appliedKappa }
          : undefined,
      });
    } catch (e) {
      setResult({ error: "client exception", detail: String(e) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          type="button"
          onClick={runCalibrate}
          disabled={busy || running || !designReady || !tsPath}
          title="Inverse-fit measured S(λ) → LLM diagnose → apply recipe + judge against design target."
          style={{
            padding: "4px 10px", fontSize: 12, fontWeight: 700,
            background: (busy || running) ? "#d6d3d1" : "#0891b2",
            color: "#fff", border: "none", borderRadius: 4,
            cursor: (busy || running) ? "not-allowed" : "pointer",
          }}
        >
          {running ? "Calibrating…" : "🔬 Calibrate"}
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={busy}
          style={{
            padding: "4px 8px", fontSize: 11,
            background: "#fff", color: "#0891b2",
            border: "1px solid #a5f3fc", borderRadius: 4,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {open ? "▾" : "▸"} settings
        </button>
      </div>
      {open && (
        <div style={{
          padding: 8, borderRadius: 6,
          background: "#ecfeff", border: "1px solid #a5f3fc",
          display: "flex", flexDirection: "column", gap: 6, fontSize: 11, color: "#0e7490",
        }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span>touchstone .s4p path (measured spectrum)</span>
            <input type="text" value={touchstonePath}
              placeholder={defaultTouchstone || "results/your_chip.s4p"}
              onChange={(e) => setTouchstonePath(e.target.value)}
              style={{ padding: "3px 6px", fontSize: 11, fontFamily: "monospace",
                       border: "1px solid #67e8f9", borderRadius: 3, background: "#fff" }} />
            {!touchstonePath.trim() && defaultTouchstone && (
              <span style={{ fontSize: 9, color: "#0891b2" }}>
                using card's own .s4p as baseline (drift will be ≈ 0 unless externally perturbed).
              </span>
            )}
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span>phase max (rad)</span>
              <input type="number" step="0.1" min="0.1" value={phaseMaxRad}
                onChange={(e) => setPhaseMaxRad(e.target.value)}
                style={{ padding: "3px 6px", fontSize: 11, fontFamily: "monospace",
                         border: "1px solid #67e8f9", borderRadius: 3, background: "#fff" }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span>κ trim max</span>
              <input type="number" step="0.005" min="0" value={kappaMaxTrim}
                onChange={(e) => setKappaMaxTrim(e.target.value)}
                style={{ padding: "3px 6px", fontSize: 11, fontFamily: "monospace",
                         border: "1px solid #67e8f9", borderRadius: 3, background: "#fff" }} />
            </label>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 10 }}>
            <input type="checkbox" checked={applyAndVerify}
              onChange={(e) => setApplyAndVerify(e.target.checked)} />
            apply recipe + judge against design target (verifies recovery)
          </label>
        </div>
      )}
      {result && <CalibrateResultPanel result={result} />}
    </div>
  );
}

function CalibrateResultPanel({ result }: { result: CalibrationResult }) {
  if (result.error) {
    return (
      <div style={{
        padding: 6, borderRadius: 4, fontSize: 11,
        background: "#fef2f2", border: "1px solid #fca5a5", color: "#991b1b",
      }}>
        <b>{result.error}</b>{result.detail ? ` — ${result.detail}` : ""}
      </div>
    );
  }
  const drift  = (result.fit?.data?.drift ?? {}) as Record<string, unknown>;
  const fitOk  = result.fit?.status === "success";
  const dec    = result.diagnose?.decision;
  const feas   = dec?.feasibility;
  const vEval  = result.verify?.evaluation;
  const num    = (v: unknown, d = 3) => typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—";
  const arr    = (v: unknown, d = 3) => Array.isArray(v) ? "[" + v.map((x) => typeof x === "number" ? x.toFixed(d) : "?").join(", ") + "]" : "—";
  return (
    <div style={{
      padding: 8, borderRadius: 4, fontSize: 11,
      background: "#f0fdfa", border: "1px solid #67e8f9", color: "#0e7490",
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      <div>
        <b>1. Inverse fit</b> {fitOk ? "✓" : "✗"}
        <span style={{ marginLeft: 8, fontFamily: "monospace", color: "#0f172a" }}>
          residual_rms_db = {num((result.fit?.data?.fit as { residual_rms_db?: number })?.residual_rms_db, 3)}
        </span>
      </div>
      <div style={{ fontFamily: "monospace", fontSize: 10, color: "#0f172a", marginLeft: 12 }}>
        Δκ:  {arr(drift.dkappa, 4)}<br />
        ΔL:  {arr(drift.ddelay_um, 4)} µm<br />
        Δφ:  {arr(drift.dphi_rad_per_arm_at_center, 3)} rad
      </div>
      {dec && (
        <>
          <div>
            <b>2. LLM diagnose</b>{" "}
            <span style={{ background: "#cffafe", padding: "0 4px", borderRadius: 2, fontFamily: "monospace" }}>
              {dec.drift_mode}
            </span>{" "}
            <span style={{ color: "#64748b" }}>conf={num(dec.confidence, 2)}</span>
            {result.diagnose?.invariant_ok === false && (
              <span style={{ color: "#dc2626", marginLeft: 6 }}>
                ⚠ invariant_failed: {result.diagnose?.invariant_reasons?.join("; ")}
              </span>
            )}
          </div>
          {dec.diagnosis && <div style={{ marginLeft: 12, color: "#475569" }}>{dec.diagnosis}</div>}
          <div style={{ marginLeft: 12, fontFamily: "monospace", fontSize: 10, color: "#0f172a" }}>
            recipe Δφ:    {arr(dec.recipe?.phase_compensation_rad, 3)} rad<br />
            recipe Δκ:    {arr(dec.recipe?.kappa_trim, 4)}<br />
            feasibility: phase_in_2π={String(feas?.phase_within_2pi)}, max_phase={num(feas?.max_phase_rad, 3)} rad
            {feas?.warnings && feas.warnings.length > 0 && (
              <div style={{ color: "#dc2626" }}>⚠ {feas.warnings.join(" · ")}</div>
            )}
          </div>
        </>
      )}
      {vEval && (
        <div>
          <b>3. Apply + judge</b>{" "}
          <span style={{
            background: vEval.verdict === "pass" ? "#dcfce7" : "#fee2e2",
            color: vEval.verdict === "pass" ? "#166534" : "#991b1b",
            padding: "0 4px", borderRadius: 2, fontFamily: "monospace",
          }}>
            {vEval.verdict} · score={num(vEval.score, 2)}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * OptimizeLauncher — collapsible settings panel + launch button for the BO loop.
 *
 * Two modes (closed-loop input scenarios):
 *   • wavelength_drift  — simulate λ_c shifting (e.g. process variation).
 *                         seed_overrides = { center_wavelength_um: λ_target }
 *                         BO then optimizes power_couplings to recover specs.
 *   • process_delay     — simulate delay_lengths × k (process makes arms longer/shorter).
 *                         seed_overrides = { delay_lengths_um: seed × k }
 *                         BO then optimizes power_couplings to compensate.
 *
 * Hard-spec gates flow into target_params and reach both judge endpoint and BO.
 * Math-convergence (ε relative loss-change, δ max var-change) flow into BO.
 */
function OptimizeLauncher({
  busy, seedMeta, hardSpec, onLaunch,
}: {
  busy: boolean;
  seedMeta: SeedMeta;
  // Lifted up to ReplayPanel so all three flows (Replay/Optimize/Calibrate) share one
  // adjustable verdict standard. See: HARD-SPEC GATES panel in ReplayPanel.
  hardSpec: {
    maxIlDb: string;
    maxRippleDb: string;
    xtBaselineDb: string;
    xtTolDb: string;
    minBwUm: string;
    fsrErrPct: string;
    budget: string;
  };
  onLaunch: (
    seedOverrides: Record<string, number | string | number[]>,
    cfg: { budget?: number; target_params?: Record<string, number | boolean> },
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  // Five seed-construction strategies. The first two perturb the existing seed
  // (drift modes); the next three are new construction recipes for exploring
  // the design space without an existing seed:
  //   • auto_from_fsr      — vary (center, FSR), let API _default_lattice_parameters
  //                          derive Δ + κ. Best for fresh design exploration.
  //   • manual_seed        — user types Δ + κ text; BO refines κ from there.
  //   • manhattan_corrected — auto recipe + scale Δ by factor (≈0.9858 for
  //                          si_wire 5 µm bend) to compensate ConnectManhattan
  //                          bend overhead so the channel grid lands on target.
  const [mode, setMode] = useState<
    "wavelength_drift" | "process_delay" | "auto_from_fsr" | "manual_seed" | "manhattan_corrected"
  >("wavelength_drift");
  // Drift defaults: nudge center λ a bit; user can override.
  const seedCenter = seedMeta.center_wavelength_um ?? 1.55;
  const [driftCenterUm, setDriftCenterUm] = useState<string>((seedCenter + 0.005).toFixed(4));
  // Process-delay scaling factor (1.05 = +5% longer arms typical SOI variation).
  const [delayK, setDelayK] = useState<string>("1.05");
  // FSR target (nm) — used by auto_from_fsr and manhattan_corrected modes.
  const [autoFsrNm, setAutoFsrNm] = useState<string>(((seedMeta.fsr_um ?? 0.02) * 1000).toFixed(2));
  // Manual seed text — pre-filled from current seed meta if available.
  const [manualDelaysText, setManualDelaysText] = useState<string>(
    seedMeta.delay_lengths_um?.length
      ? seedMeta.delay_lengths_um.join(", ")
      : "28.349, 56.697, -57.027, -56.697",
  );
  const [manualKappaText, setManualKappaText] = useState<string>(
    seedMeta.power_couplings?.length
      ? seedMeta.power_couplings.join(", ")
      : "0.5, 0.13, 0.12, 0.5, 0.25",
  );
  // Manhattan correction factor — empirically 0.9858 for si_wire bend_radius=5
  // (gives FSR=20.0 instead of 19.7). See memory: reference_mzi_lattice_seed_delays.md
  const [manhattanFactor, setManhattanFactor] = useState<string>("0.9858");
  // Hard-spec thresholds are now lifted to ReplayPanel so Replay/Optimize/Calibrate
  // all read from the SAME adjustable HARD-SPEC GATES panel. Read via props.
  const { maxIlDb, maxRippleDb, xtBaselineDb, xtTolDb, minBwUm, fsrErrPct } = hardSpec;
  // Sweep window — narrow window around target λ avoids spurious "5 FSR-period"
  // peaks the SA would otherwise report when sweeping the full 100 nm. Default
  // is ±15 nm around 1.55 µm (covers ≈1.5 FSR around the canonical center,
  // so SA sees ONE clean peak per port without periodic repeats polluting
  // crosstalk/ripple extraction).
  const [wlStartUm, setWlStartUm] = useState<string>("1.51");
  const [wlStopUm,  setWlStopUm]  = useState<string>("1.61");
  const [nPoints,   setNPoints]   = useState<string>("301");      // 301 over 30 nm = 0.1 nm/pt
  // Math convergence
  const [epsilonPct, setEpsilonPct] = useState<string>("1.0");    // 1% of initial loss
  const [deltaVal,   setDeltaVal]   = useState<string>("0.002");
  // Budget is part of HARD-SPEC GATES (shared) — read from props
  const { budget } = hardSpec;
  // Robust BO evaluation — when active, each BO candidate is evaluated against
  // M perturbed samples instead of the ideal nominal point. This is the
  // publication-grade mode (variation-aware optimization). Defaults to "off"
  // so existing nominal flows aren't disrupted.
  //   - off:        single ideal sim per candidate (legacy)
  //   - worst_case: 5 deterministic corners (nominal +/- delay/coupling 1σ)
  //   - stochastic: M Monte Carlo samples ~ N(0, σ)
  // See memory: project_robust_bo_design.md
  const [robustMode,    setRobustMode]    = useState<"off" | "worst_case" | "stochastic">("off");
  const [sigmaDelayPct, setSigmaDelayPct] = useState<string>("1.0");   // % of nominal ΔL
  const [sigmaCoupling, setSigmaCoupling] = useState<string>("0.01");  // absolute κ shift
  const [mSamples,      setMSamples]      = useState<string>("5");
  const [lambdaRisk,    setLambdaRisk]    = useState<string>("1.0");   // mean + λ·std

  function buildAndLaunch() {
    const seedOv: Record<string, number | string | number[]> = {};
    const parseArr = (s: string): number[] =>
      s.split(/[,，\s]+/).map(x => x.trim()).filter(x => x !== "")
       .map(x => Number(x)).filter(n => Number.isFinite(n));
    if (mode === "wavelength_drift") {
      const cNew = Number(driftCenterUm);
      if (Number.isFinite(cNew)) {
        // Bogaerts protocol — Step 1: recompute ΔL for the new λ (scalar k=(λ_new/λ_old)²).
        // Step 2: lock κ to canonical half-band [0.5, 0.13, 0.12, 0.5, 0.25] so iter 1
        // is on a known physics anchor; BO can then refine κ from there. Without this,
        // iter 1 reuses old delays computed for the seed's λ, leaving a mis-aligned
        // center that no κ tweak in iter 2+ can rescue.
        seedOv.center_wavelength_um = cNew;
        seedOv.delay_lengths_um = rescaleDelaysForCenterShift(
          seedMeta.delay_lengths_um, seedMeta.center_wavelength_um, cNew, seedMeta.fsr_um,
        );
        seedOv.power_couplings = [...CANONICAL_POWER_COUPLINGS];
      }
    } else if (mode === "process_delay") {
      const k = Number(delayK);
      const baseDelays = seedMeta.delay_lengths_um
        ?? canonicalLatticeDelaysUm(seedMeta.center_wavelength_um, seedMeta.fsr_um);
      if (Number.isFinite(k) && Array.isArray(baseDelays)) {
        seedOv.delay_lengths_um = baseDelays.map((d) => Math.round(d * k * 100) / 100);
      }
    } else if (mode === "auto_from_fsr") {
      // Vary (center, FSR); omit Δ + κ so backend _default_lattice_parameters
      // computes them using the actual PDK trace template.
      const cNew = Number(driftCenterUm);
      const fsrNew = Number(autoFsrNm) / 1000;  // nm → µm
      if (Number.isFinite(cNew))   seedOv.center_wavelength_um = cNew;
      if (Number.isFinite(fsrNew)) seedOv.fsr = fsrNew;
    } else if (mode === "manual_seed") {
      const delays = parseArr(manualDelaysText);
      const kappa  = parseArr(manualKappaText);
      const cNew   = Number(driftCenterUm);
      if (Number.isFinite(cNew)) seedOv.center_wavelength_um = cNew;
      if (delays.length >= 2) seedOv.delay_lengths_um = delays;
      if (kappa.length === delays.length + 1) seedOv.power_couplings = kappa;
      // else: silently skip κ; backend will fill from default — user sees the mismatch via the constraint hint.
    } else if (mode === "manhattan_corrected") {
      // Auto recipe + uniform Δ scale to compensate ConnectManhattan bend overhead.
      const cNew = Number(driftCenterUm);
      const fsrNew = Number(autoFsrNm) / 1000;
      const factor = Number(manhattanFactor);
      if (Number.isFinite(cNew))   seedOv.center_wavelength_um = cNew;
      if (Number.isFinite(fsrNew)) seedOv.fsr = fsrNew;
      if (Number.isFinite(cNew) && Number.isFinite(fsrNew) && Number.isFinite(factor)) {
        const base = canonicalLatticeDelaysUm(cNew, fsrNew);
        seedOv.delay_lengths_um = base.map(d => Math.round(d * factor * 10000) / 10000);
        seedOv.power_couplings = [...CANONICAL_POWER_COUPLINGS];
      }
    }
    const num = (s: string, fb: number) => {
      const n = Number(s);
      return Number.isFinite(n) ? n : fb;
    };
    // Sweep window — pass through whatever the user has in the form, no auto-
    // recentering. Default 1.51-1.61 µm (100 nm = 5× target FSR) is wide enough
    // to expose ≥2 same-port peaks → SpectrumAnalyzer can extract real FSR. If
    // the user wants to chase a drifted λ they edit the fields directly.
    const wlStart = num(wlStartUm, 1.51);
    const wlStop  = num(wlStopUm,  1.61);
    if (Number.isFinite(wlStart) && Number.isFinite(wlStop) && wlStop > wlStart) {
      seedOv.wl_start_um = Math.round(wlStart * 1000) / 1000;
      seedOv.wl_stop_um  = Math.round(wlStop  * 1000) / 1000;
    }
    const npts = Math.max(11, Math.min(2001, Math.round(num(nPoints, 301))));
    seedOv.n_points = npts;
    // Robust evaluation knobs flow into target_params so the n8n workflow / BO
    // suggester can pick them up. n8n is expected to read robust_mode and route
    // each candidate to /ipkiss/judge/robust_lattice instead of judge/wdm_mzi
    // when robust_mode is set; bo_couplings.suggest_next_couplings consumes
    // lambda_risk directly. Fields are only emitted when robust_mode != "off"
    // so legacy nominal flows stay untouched.
    const robustExtras: Record<string, number | string | boolean> = {};
    if (robustMode !== "off") {
      robustExtras.robust_mode         = robustMode;
      robustExtras.sigma_delay_pct     = num(sigmaDelayPct, 1.0);
      robustExtras.sigma_coupling_abs  = num(sigmaCoupling, 0.01);
      robustExtras.M_samples           = Math.max(2, Math.min(20, Math.round(num(mSamples, 5))));
      robustExtras.lambda_risk         = Math.max(0, num(lambdaRisk, 1.0));
    }
    const cfg = {
      budget: Math.max(1, Math.min(20, Math.round(num(budget, 5)))),
      target_params: {
        target_min_fsr_um:    seedMeta.fsr_um ?? 0.02,
        target_3db_bw_um:     num(minBwUm, 0.010),
        crosstalk_baseline_db:  num(xtBaselineDb, -2.7),
        crosstalk_tolerance_db: num(xtTolDb, 1.5),
        il_limit_db:          num(maxIlDb, 2.5),
        ripple_limit_db:      num(maxRippleDb, 1.0),
        fsr_error_tol_pct:    num(fsrErrPct, 3.0),
        epsilon:              num(epsilonPct, 1.0) / 100,
        delta:                num(deltaVal, 0.002),
        require_measured_fsr: false,
        ...robustExtras,
      },
    };
    onLaunch(seedOv, cfg);
  }

  const fieldStyle: React.CSSProperties = {
    padding: "3px 6px", fontSize: 11, fontFamily: "monospace",
    border: "1px solid #e7e5e4", borderRadius: 3, background: "#fff",
    width: "100%", boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: "#78716c",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          type="button"
          onClick={buildAndLaunch}
          disabled={busy}
          title="Closed-loop BO + LLM iteration (replay → judge → BO suggest → LLM decide → loop)."
          style={{
            padding: "4px 10px", fontSize: 12, fontWeight: 700,
            background: busy ? "#d6d3d1" : "#7c3aed", color: "#fff",
            border: "none", borderRadius: 4,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          🤖 Optimize ({
            mode === "wavelength_drift"   ? "λ-drift"   :
            mode === "process_delay"      ? "δL×k"      :
            mode === "auto_from_fsr"      ? "auto"      :
            mode === "manual_seed"        ? "manual"    :
            "manhattan"
          }{robustMode !== "off" ? `·robust-${robustMode === "worst_case" ? "WC" : "MC"}` : ""})
        </button>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          disabled={busy}
          style={{
            padding: "4px 8px", fontSize: 11,
            background: "#fff", color: "#7c3aed",
            border: "1px solid #ddd6fe", borderRadius: 4,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {open ? "▾" : "▸"} settings
        </button>
      </div>
      {open && (
        <div style={{
          padding: 8, borderRadius: 6,
          background: "rgba(124,58,237,0.04)", border: "1px solid #ddd6fe",
          display: "flex", flexDirection: "column", gap: 6,
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#5b21b6", letterSpacing: "0.04em" }}>
            CLOSED-LOOP MODE
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                <input type="radio" checked={mode === "wavelength_drift"}
                  onChange={() => setMode("wavelength_drift")} />
                Wavelength drift (λ shift)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                <input type="radio" checked={mode === "process_delay"}
                  onChange={() => setMode("process_delay")} />
                Process delay (ΔL × k)
              </label>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}
                title="Vary (center λ, FSR); API _default_lattice_parameters auto-derives Δ + κ.">
                <input type="radio" checked={mode === "auto_from_fsr"}
                  onChange={() => setMode("auto_from_fsr")} />
                Auto (center × FSR)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}
                title="Manually type seed Δ + κ as text; BO refines κ from there.">
                <input type="radio" checked={mode === "manual_seed"}
                  onChange={() => setMode("manual_seed")} />
                Manual seed (Δ + κ)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}
                title="Auto recipe + uniform Δ scale by factor (≈0.9858) to compensate ConnectManhattan bend overhead.">
                <input type="radio" checked={mode === "manhattan_corrected"}
                  onChange={() => setMode("manhattan_corrected")} />
                Manhattan corrected
              </label>
            </div>
          </div>
          {mode === "wavelength_drift" ? (
            <>
              <label style={labelStyle}>
                <span>target center λ (µm) · seed: {seedCenter.toFixed(4)}</span>
                <input style={fieldStyle} type="number" step="0.001" value={driftCenterUm}
                  onChange={(e) => setDriftCenterUm(e.target.value)} />
              </label>
              {(() => {
                // Iteration-base preview: confirms the rescale starts from THIS card's
                // seed (e.g. 1.5400 from the previous replay's result) toward the new
                // target — not from the original DB seed. Mirrors the rescale numerics
                // the replay banner shows; same linear k=(λ'/λ)² approximation.
                const cNew = Number(driftCenterUm);
                if (!Number.isFinite(cNew) || cNew <= 0) return null;
                if (Math.abs(cNew - seedCenter) < 1e-6) return (
                  <div style={{ fontSize: 9, color: "#7c3aed", opacity: 0.85, lineHeight: 1.5 }}>
                    target = seed (no shift) — rescale skipped, κ still resets to canonical.
                  </div>
                );
                const baseDelays = seedMeta.delay_lengths_um;
                const k = (cNew * cNew) / (seedCenter * seedCenter);
                const rescaled = baseDelays
                  ? baseDelays.map((d) => Math.round(d * k * 1000) / 1000)
                  : null;
                return (
                  <div style={{
                    padding: "6px 8px", borderRadius: 4,
                    background: "#f5f3ff", border: "1px solid #c4b5fd",
                    display: "flex", flexDirection: "column", gap: 3,
                    fontSize: 10, color: "#5b21b6", lineHeight: 1.5,
                  }}>
                    <div>
                      <span style={{ fontWeight: 700 }}>iter 1 base</span>
                      <span style={{ fontFamily: "monospace", marginLeft: 6 }}>
                        {seedCenter.toFixed(4)} µm → {cNew.toFixed(4)} µm
                      </span>
                      <span style={{ fontFamily: "monospace", marginLeft: 8, color: "#7c3aed" }}>
                        k = {k.toFixed(5)}
                      </span>
                    </div>
                    {rescaled && baseDelays && (
                      <div style={{ fontFamily: "monospace", fontSize: 9, color: "#1e1b4b" }}>
                        ΔL: [{baseDelays.join(", ")}] → <span style={{ color: "#7c3aed", fontWeight: 600 }}>[{rescaled.join(", ")}]</span>
                      </div>
                    )}
                    <div style={{ fontSize: 9, opacity: 0.85 }}>
                      κ resets to canonical [0.5, 0.13, 0.12, 0.5, 0.25] for a clean physics anchor; BO refines κ from there.
                    </div>
                  </div>
                );
              })()}
            </>
          ) : mode === "process_delay" ? (
            <label style={labelStyle}>
              <span>delay scale factor k · &gt;1 = longer arms</span>
              <input style={fieldStyle} type="number" step="0.01" value={delayK}
                onChange={(e) => setDelayK(e.target.value)} />
            </label>
          ) : mode === "auto_from_fsr" ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <label style={labelStyle}>
                  <span>target center λ (µm)</span>
                  <input style={fieldStyle} type="number" step="0.001" value={driftCenterUm}
                    onChange={(e) => setDriftCenterUm(e.target.value)} />
                </label>
                <label style={labelStyle}>
                  <span>target FSR (nm)</span>
                  <input style={fieldStyle} type="number" step="0.5" value={autoFsrNm}
                    onChange={(e) => setAutoFsrNm(e.target.value)} />
                </label>
              </div>
              <div style={{ fontSize: 9, color: "#7c3aed", opacity: 0.85, lineHeight: 1.5 }}>
                seed delays/κ omitted from request → IPKISS API runs <code>_default_lattice_parameters(center, fsr)</code>
                using the actual PDK trace template. BO refines κ from the canonical 5-tuple. Best for fresh design exploration.
              </div>
            </>
          ) : mode === "manual_seed" ? (
            <>
              <label style={labelStyle}>
                <span>delay_lengths_um · 4 values · L, 2L, -(2L+Lπ), -2L</span>
                <input style={fieldStyle} type="text" value={manualDelaysText}
                  onChange={(e) => setManualDelaysText(e.target.value)}
                  placeholder="28.349, 56.697, -57.027, -56.697" />
              </label>
              <label style={labelStyle}>
                <span>power_couplings · 5 values · κ² ∈ [0,1]</span>
                <input style={fieldStyle} type="text" value={manualKappaText}
                  onChange={(e) => setManualKappaText(e.target.value)}
                  placeholder="0.5, 0.13, 0.12, 0.5, 0.25" />
              </label>
              <label style={labelStyle}>
                <span>target center λ (µm) · sets judge target only</span>
                <input style={fieldStyle} type="number" step="0.001" value={driftCenterUm}
                  onChange={(e) => setDriftCenterUm(e.target.value)} />
              </label>
              <div style={{ fontSize: 9, color: "#7c3aed", opacity: 0.85, lineHeight: 1.5 }}>
                Constraint: <code>len(power_couplings) = len(delay_lengths_um) + 1</code>.
                BO refines κ; Δ stays at the values you typed unless ablation flags are set.
              </div>
            </>
          ) : (
            // manhattan_corrected
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                <label style={labelStyle}>
                  <span>target center λ (µm)</span>
                  <input style={fieldStyle} type="number" step="0.001" value={driftCenterUm}
                    onChange={(e) => setDriftCenterUm(e.target.value)} />
                </label>
                <label style={labelStyle}>
                  <span>target FSR (nm)</span>
                  <input style={fieldStyle} type="number" step="0.5" value={autoFsrNm}
                    onChange={(e) => setAutoFsrNm(e.target.value)} />
                </label>
                <label style={labelStyle} title="Δ × factor compensates ConnectManhattan bend overhead. Empirically 0.9858 for si_wire bend_radius=5 (gives measured FSR=20.0 instead of 19.7).">
                  <span>bend factor (× Δ)</span>
                  <input style={fieldStyle} type="number" step="0.001" value={manhattanFactor}
                    onChange={(e) => setManhattanFactor(e.target.value)} />
                </label>
              </div>
              {(() => {
                const cNew = Number(driftCenterUm);
                const fsrNew = Number(autoFsrNm) / 1000;
                const factor = Number(manhattanFactor);
                if (!Number.isFinite(cNew) || !Number.isFinite(fsrNew) || !Number.isFinite(factor)) return null;
                const base = canonicalLatticeDelaysUm(cNew, fsrNew);
                const corrected = base.map(d => Math.round(d * factor * 10000) / 10000);
                return (
                  <div style={{
                    padding: "6px 8px", borderRadius: 4,
                    background: "#f5f3ff", border: "1px solid #c4b5fd",
                    fontSize: 9, color: "#1e1b4b", lineHeight: 1.5, fontFamily: "monospace",
                  }}>
                    <div>canonical Δ @ ({cNew.toFixed(3)}, {(fsrNew*1000).toFixed(1)} nm): [{base.join(", ")}]</div>
                    <div style={{ color: "#7c3aed", fontWeight: 600 }}>corrected (×{factor}): [{corrected.join(", ")}]</div>
                  </div>
                );
              })()}
            </>
          )}

          <div style={{ fontSize: 10, fontWeight: 700, color: "#5b21b6", letterSpacing: "0.04em", marginTop: 4 }}>
            SWEEP WINDOW (narrow band → cleaner SA extraction)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
            <label style={labelStyle}>
              <span>wl_start_um</span>
              <input style={fieldStyle} type="number" step="0.001" value={wlStartUm}
                onChange={(e) => setWlStartUm(e.target.value)} />
            </label>
            <label style={labelStyle}>
              <span>wl_stop_um</span>
              <input style={fieldStyle} type="number" step="0.001" value={wlStopUm}
                onChange={(e) => setWlStopUm(e.target.value)} />
            </label>
            <label style={labelStyle}>
              <span>n_points</span>
              <input style={fieldStyle} type="number" step="10" value={nPoints}
                onChange={(e) => setNPoints(e.target.value)} />
            </label>
          </div>
          <div style={{ fontSize: 9, color: "#7c3aed", opacity: 0.85, lineHeight: 1.5 }}>
            Default 1.51-1.61 µm (100 nm ≈ 5× target FSR) — wide enough for SA to
            extract real FSR. Window is passed through as-is; no auto-recenter.
          </div>

          {/* ── ROBUST EVALUATION ──
              When active, each BO candidate is evaluated against M perturbed
              samples (delay/coupling/loss drift) instead of the ideal nominal
              point. Cost scales by M; verdict via mean+λ·std (stochastic) or
              all-corners-pass (worst_case). See memory: project_robust_bo_design. */}
          <div style={{ fontSize: 10, fontWeight: 700, color: "#5b21b6", letterSpacing: "0.04em", marginTop: 4 }}>
            ROBUST EVALUATION (variation-aware optimization)
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 11, color: "#475569" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input type="radio" checked={robustMode === "off"}
                onChange={() => setRobustMode("off")} />
              off (nominal)
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }} title="5 deterministic corners: nominal, ±delay 1σ, ±coupling 1σ. All must pass.">
              <input type="radio" checked={robustMode === "worst_case"}
                onChange={() => setRobustMode("worst_case")} />
              worst-case
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }} title="M Monte-Carlo samples ~ N(0, σ). Score = mean - λ·std.">
              <input type="radio" checked={robustMode === "stochastic"}
                onChange={() => setRobustMode("stochastic")} />
              stochastic (Monte Carlo)
            </label>
          </div>
          {robustMode !== "off" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6 }}>
                <label style={labelStyle} title="Per-arm delay variation (% of nominal ΔL). 1.0% ≈ typical SOI etch + thermal.">
                  <span>σ delay (%)</span>
                  <input style={fieldStyle} type="number" step="0.1" min="0" value={sigmaDelayPct}
                    onChange={(e) => setSigmaDelayPct(e.target.value)} />
                </label>
                <label style={labelStyle} title="Per-DC absolute κ shift. 0.01 ≈ ±2% gap-induced coupling drift.">
                  <span>σ coupling</span>
                  <input style={fieldStyle} type="number" step="0.005" min="0" value={sigmaCoupling}
                    onChange={(e) => setSigmaCoupling(e.target.value)} />
                </label>
                <label style={labelStyle} title="Number of MC samples per BO candidate. Cost scales linearly. M=5 gives reasonable mean/std estimates.">
                  <span>M samples</span>
                  <input style={fieldStyle} type="number" step="1" min="2" max="20"
                    value={mSamples} disabled={robustMode === "worst_case"}
                    onChange={(e) => setMSamples(e.target.value)} />
                </label>
                <label style={labelStyle} title="Risk-aversion: loss = mean + λ·std. 0=mean only; 1=balanced; 2-3=strongly risk-averse.">
                  <span>λ risk</span>
                  <input style={fieldStyle} type="number" step="0.1" min="0" value={lambdaRisk}
                    onChange={(e) => setLambdaRisk(e.target.value)} />
                </label>
              </div>
              {(() => {
                const mEff = robustMode === "worst_case" ? 5 : Math.max(2, Math.min(20, Math.round(Number(mSamples) || 5)));
                const npts = Math.max(11, Math.min(2001, Math.round(Number(nPoints) || 301)));
                // Empirical: ~10s/iter @ n_points=301, scales linearly
                const secPerSim = (npts / 301) * 10;
                const totalSec = mEff * secPerSim * Math.max(1, Math.round(Number(budget) || 5));
                return (
                  <div style={{ fontSize: 9, color: "#7c3aed", opacity: 0.85, lineHeight: 1.5 }}>
                    M={mEff} samples × {npts}-pt sweep × {budget} BO iter ≈ <b>{Math.round(totalSec)}s</b> total wall time.
                    BO loss = mean + λ·std of per-sample losses; n8n routes via{" "}
                    <code style={{ background: "#ede9fe", padding: "0 3px", borderRadius: 2 }}>/ipkiss/judge/robust_lattice</code>.
                  </div>
                );
              })()}
            </>
          )}

          <div style={{ fontSize: 9, color: "#a8a29e", marginTop: 4, fontStyle: "italic" }}>
            HARD-SPEC GATES (max IL / ripple / XT / BW / FSR err / budget) are configured
            from the shared panel above — same values apply to Replay, Optimize, Calibrate.
          </div>

          <div style={{ fontSize: 10, fontWeight: 700, color: "#5b21b6", letterSpacing: "0.04em", marginTop: 4 }}>
            MATH CONVERGENCE (early-stop before budget)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <label style={labelStyle}>
              <span>ε relative loss-change (%)</span>
              <input style={fieldStyle} type="number" step="0.1" value={epsilonPct}
                onChange={(e) => setEpsilonPct(e.target.value)} />
            </label>
            <label style={labelStyle}>
              <span>δ max var-change |Δk_i|</span>
              <input style={fieldStyle} type="number" step="0.0005" value={deltaVal}
                onChange={(e) => setDeltaVal(e.target.value)} />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Mux4StagedReplayWrapper ────────────────────────────────────────────────
// When a Mux4Configurable response arrives, the backend exposes 3 child
// stages each with their own .s4p / _netlist.json. This wrapper lets the user
// pick which level (top / stage_1 / stage_2_down / stage_2_up) feeds the
// ReplayPanel below. Stage-2 is ganged by default — one click drives both
// stage_2_down and stage_2_up; toggle "🔓 independent" to break the link.
//
// When stage-1 thresholds (derived from its SA output) are present in the
// response, they're surfaced as a badge so the user sees the auto-derived
// review baseline without having to inspect raw JSON.
type Mux4StageRecord = {
  stage_id: string;
  role?: string;
  center_wavelength_um?: number;
  fsr_um?: number;
  fsr_nm?: number;
  power_couplings?: number[];
  delay_lengths_um?: number[];
  files?: { sNp_path?: string | null; netlist_json_path?: string | null; spectrum_png_path?: string | null };
  spectrum?: Record<string, unknown>;
  review_baseline?: boolean;
  thresholds?: Record<string, number | string>;
  thresholds_json_path?: string | null;
};

function Mux4StagedReplayWrapper({
  topNetlistPath,
  topSeedMeta,
  stages,
  stage1Thresholds,
  reviewThresholds,
  busy,
  onReplay,
  onOptimize,
  seedWdmType,
}: {
  topNetlistPath: string;
  topSeedMeta: SeedMeta;
  stages: Mux4StageRecord[];
  stage1Thresholds: Record<string, number | string> | null;
  reviewThresholds: Record<string, number | string> | null;
  busy: boolean;
  onReplay: (path: string, overrides: Record<string, number | string | number[]>) => void;
  onOptimize?: (
    path: string,
    seedOverrides: Record<string, number | string | number[]>,
    cfg?: { budget?: number; target_params?: Record<string, number | boolean> },
  ) => void;
  seedWdmType: string | null;
}) {
  // Two-mode UI:
  //   "top"    → high-level scalar params only (center / FSR / sweep / spacing
  //              / bend). Lattice arrays are hidden here because they belong
  //              to individual stages.
  //   "stages" → all stages expose simultaneously: stage_1 always, plus
  //              stage_2 (ganged) OR stage_2_down + stage_2_up (independent).
  //              The Replay panel renders all per-stage textboxes in one go;
  //              one submit applies all overrides via the top netlist.
  type ViewMode = "top" | "stages";
  const [viewMode, setViewMode] = useState<ViewMode>("top");
  const [stage2Ganged, setStage2Ganged] = useState(true);

  const stageById = (id: string) => stages.find(s => s.stage_id === id) ?? null;

  // Aggregate per-stage seed values for STAGE INDEPENDENT view. The lattice
  // presets read these to pre-fill stage1 / stage2 / stage2_up / stage2_down
  // textboxes. Each comes from its corresponding stage record's actual delays
  // & couplings (backend backfills canonical when user didn't override).
  const stageSeed = (id: string, field: "delay_lengths_um" | "power_couplings") => {
    const s = stageById(id);
    const v = s?.[field];
    return Array.isArray(v) ? v : null;
  };
  const stagedSeedMeta: SeedMeta = {
    ...topSeedMeta,
    wdm_type: "Mux4Configurable",
    delay_lengths_stage1: stageSeed("stage_1", "delay_lengths_um"),
    delay_lengths_stage2: stageSeed("stage_2_down", "delay_lengths_um"),
    delay_lengths_stage2_down: stageSeed("stage_2_down", "delay_lengths_um"),
    delay_lengths_stage2_up: stageSeed("stage_2_up", "delay_lengths_um"),
    power_couplings_stage1: stageSeed("stage_1", "power_couplings"),
    power_couplings_stage2: stageSeed("stage_2_down", "power_couplings"),
    power_couplings_stage2_down: stageSeed("stage_2_down", "power_couplings"),
    power_couplings_stage2_up: stageSeed("stage_2_up", "power_couplings"),
    stage2_ganged: stage2Ganged,
  };

  const { effectiveNetlistPath, effectiveSeedMeta, effectiveWdmType } = (() => {
    if (viewMode === "top") {
      return {
        effectiveNetlistPath: topNetlistPath,
        effectiveSeedMeta: topSeedMeta,
        effectiveWdmType: seedWdmType,
      };
    }
    // STAGE INDEPENDENT: still use top netlist (Replay → judge replays the
    // top Mux4Configurable with per-stage overrides). Seed carries all
    // stages' values so the lattice preset can render every textbox.
    return {
      effectiveNetlistPath: topNetlistPath,
      effectiveSeedMeta: stagedSeedMeta,
      effectiveWdmType: "Mux4Configurable",
    };
  })();

  // Single dispatch — both modes go through the top netlist; backend's
  // Mux4Configurable branch reads per-stage override keys (stage1 /
  // stage2(_up/_down)) and routes them into the matching stage cell.
  const dispatchReplay = (path: string, overrides: Record<string, number | string | number[]>) => {
    onReplay(path, overrides);
  };
  const dispatchOptimize = onOptimize
    ? (
        path: string,
        seedOverrides: Record<string, number | string | number[]>,
        cfg?: { budget?: number; target_params?: Record<string, number | boolean> },
      ) => onOptimize(path, seedOverrides, cfg)
    : undefined;

  const modeBtnStyle = (sel: boolean): React.CSSProperties => ({
    padding: "8px 16px", fontSize: 13,
    background: sel ? "#dbeafe" : "#fff",
    border: "1.5px solid " + (sel ? "#2563eb" : "#cbd5e1"),
    borderRadius: 8,
    color: sel ? "#1e3a8a" : "#475569",
    cursor: "pointer",
    fontWeight: sel ? 700 : 500,
    letterSpacing: "0.02em",
  });
  const stageBtnStyle = (sel: boolean): React.CSSProperties => ({
    padding: "4px 10px", fontSize: 12,
    background: sel ? "#dbeafe" : "#fff",
    border: "1px solid " + (sel ? "#2563eb" : "#cbd5e1"),
    borderRadius: 6,
    color: sel ? "#1e3a8a" : "#475569",
    cursor: "pointer",
    fontWeight: sel ? 600 : 400,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* ── Top-level mode selector ── */}
      <div style={{
        display: "flex", gap: 8, alignItems: "center",
        padding: "10px 12px", border: "1px solid #e2e8f0", borderRadius: 10,
        background: "#f8fafc",
      }}>
        <button type="button" style={modeBtnStyle(viewMode === "top")}
          onClick={() => setViewMode("top")}>
          🔼 TOP (MUX4)
        </button>
        <button type="button" style={modeBtnStyle(viewMode === "stages")}
          onClick={() => setViewMode("stages")}>
          🪜 STAGE INDEPENDENT
        </button>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#78716c", maxWidth: 360, lineHeight: 1.4 }}>
          {viewMode === "top"
            ? "Top-level Mux4: only fsr / center / sweep / spacing / bend are editable. Lattice arrays belong to individual stages — switch to STAGE INDEPENDENT to edit them."
            : "Edit each stage as a standalone MZILatticeFilter. Stage 2 up/down ganged by default; click 🔓 to control them separately."
          }
        </span>
      </div>

      {/* STAGE INDEPENDENT mode: lattice presets expose ALL stages' fields
          simultaneously (stage_1 always; stage_2 ganged → 1 set; unlocked →
          stage_2_down + stage_2_up = 2 sets). The unlock toggle below
          flips which key family the lattice preset emits next time it's
          re-selected. Existing arrayTexts state survives because viewMode
          / ganged isn't part of ReplayPanel's `key`. */}
      {viewMode === "stages" && (
        <div style={{
          display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center",
          padding: "6px 10px", border: "1px solid #e2e8f0", borderRadius: 8,
          background: "#fff", fontSize: 11, color: "#64748b",
        }}>
          <span style={{ fontWeight: 600, color: "#475569" }}>Editing all stages simultaneously:</span>
          <span>① Stage 1</span>
          <span>+</span>
          {stage2Ganged ? (
            <span>②🔗 Stage 2 (ganged)</span>
          ) : (
            <>
              <span>②↓ Stage 2 down</span>
              <span>+</span>
              <span>②↑ Stage 2 up</span>
            </>
          )}
          <span style={{ marginLeft: "auto" }}>
            <button type="button"
              onClick={() => setStage2Ganged(g => !g)}
              title={stage2Ganged ? "解開 Stage 2 ganged / Unganged Stage 2 — stage_2_up / stage_2_down editable independently" : "重新綁定 Stage 2 / Re-gang Stage 2 — one set of params applied to both"}
              style={{
                padding: "3px 8px", fontSize: 11, cursor: "pointer",
                background: stage2Ganged ? "#fef3c7" : "#dcfce7",
                border: "1px solid " + (stage2Ganged ? "#a16207" : "#16a34a"),
                borderRadius: 5,
                color: stage2Ganged ? "#a16207" : "#166534",
              }}
            >
              {stage2Ganged ? "🔗 ganged · 解開 / unganged" : "🔓 independent · 重綁 / reganged"}
            </button>
          </span>
        </div>
      )}

      {/* Mux4 review baseline — JUDGE actually grades against THIS (derived
          from the top-level Mux4 spectrum, not stage_1). Shown as the
          authoritative green baseline whenever it's available. */}
      {reviewThresholds && (
        <div style={{
          padding: "6px 10px", border: "2px solid #16a34a", borderRadius: 6,
          background: "#f0fdf4", fontSize: 11, color: "#166534",
          display: "flex", flexWrap: "wrap", gap: 12,
        }}>
          <span style={{ fontWeight: 700 }}>✅ Mux4 review baseline (judge uses this):</span>
          {(["target_min_fsr_um","target_3db_bw_um","il_limit_db","ripple_limit_db","crosstalk_baseline_db","crosstalk_tolerance_db","fsr_error_tol_pct"] as const).map(k => (
            reviewThresholds[k] != null && (
              <span key={k} style={{ fontFamily: "monospace" }}>
                {k}={String(reviewThresholds[k])}
              </span>
            )
          ))}
        </div>
      )}

      {/* Stage-1 reference — INFORMATIONAL only; what an isolated FSR/2
          halfband would look like. Not used by the judge. Render slimmer /
          dashed so the visual hierarchy says "reference, not authoritative". */}
      {/* Stage_1 reference always visible in TOP and STAGE INDEPENDENT modes —
          informational reference, not what judge uses. */}
      {stage1Thresholds && (

        <div style={{
          padding: "5px 10px", border: "1px dashed #94a3b8", borderRadius: 6,
          background: "#f8fafc", fontSize: 10, color: "#64748b",
          display: "flex", flexWrap: "wrap", gap: 10,
        }}>
          <span style={{ fontWeight: 600 }}>📐 Stage-1 reference (informational):</span>
          {(["target_min_fsr_um","target_3db_bw_um","il_limit_db","ripple_limit_db","crosstalk_baseline_db","crosstalk_tolerance_db","fsr_error_tol_pct"] as const).map(k => (
            stage1Thresholds[k] != null && (
              <span key={k} style={{ fontFamily: "monospace" }}>
                {k}={String(stage1Thresholds[k])}
              </span>
            )
          ))}
        </div>
      )}

      {/* Seed lattice values pill — visible in STAGE INDEPENDENT mode showing
          all stages' actual seed values (stage_1 + stage_2 ganged or
          stage_2_down + stage_2_up split). Click any value to copy to
          clipboard. The pre-fill of edit textboxes uses the same data. */}
      {viewMode === "stages" && (
        <div style={{
          padding: "6px 10px", border: "1px dashed #2563eb", borderRadius: 6,
          background: "#eff6ff", fontSize: 11, color: "#1e3a8a",
          display: "flex", flexDirection: "column", gap: 6,
        }}>
          <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
            <span>📌 Seed values per stage</span>
            <span style={{ fontWeight: 400, color: "#64748b", fontSize: 10 }}>
              · click value to copy · {stage2Ganged ? "ganged" : "independent"}
            </span>
          </div>
          {/* Stage 1 row */}
          {effectiveSeedMeta.delay_lengths_stage1 && effectiveSeedMeta.delay_lengths_stage1.length > 0 && (
            <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ color: "#475569", fontWeight: 600, minWidth: 64 }}>① Stage 1:</span>
              <code
                onClick={() => navigator.clipboard?.writeText(effectiveSeedMeta.delay_lengths_stage1!.join(", "))}
                style={{ fontFamily: "monospace", background: "#fff", padding: "1px 6px", borderRadius: 3, border: "1px solid #cbd5e1", cursor: "copy", color: "#1e3a8a" }}
                title="Click to copy"
              >
                Δ=[{effectiveSeedMeta.delay_lengths_stage1.map(v => v.toFixed(2)).join(", ")}]
              </code>
              {effectiveSeedMeta.power_couplings_stage1 && (
                <code
                  onClick={() => navigator.clipboard?.writeText(effectiveSeedMeta.power_couplings_stage1!.join(", "))}
                  style={{ fontFamily: "monospace", background: "#fff", padding: "1px 6px", borderRadius: 3, border: "1px solid #cbd5e1", cursor: "copy", color: "#1e3a8a" }}
                  title="Click to copy"
                >
                  κ²=[{effectiveSeedMeta.power_couplings_stage1.map(v => v.toFixed(3)).join(", ")}]
                </code>
              )}
            </div>
          )}
          {/* Stage 2 ganged row */}
          {stage2Ganged && effectiveSeedMeta.delay_lengths_stage2 && effectiveSeedMeta.delay_lengths_stage2.length > 0 && (
            <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ color: "#475569", fontWeight: 600, minWidth: 64 }}>②🔗 Stage 2:</span>
              <code
                onClick={() => navigator.clipboard?.writeText(effectiveSeedMeta.delay_lengths_stage2!.join(", "))}
                style={{ fontFamily: "monospace", background: "#fff", padding: "1px 6px", borderRadius: 3, border: "1px solid #cbd5e1", cursor: "copy", color: "#1e3a8a" }}
                title="Click to copy"
              >
                Δ=[{effectiveSeedMeta.delay_lengths_stage2.map(v => v.toFixed(2)).join(", ")}]
              </code>
              {effectiveSeedMeta.power_couplings_stage2 && (
                <code
                  onClick={() => navigator.clipboard?.writeText(effectiveSeedMeta.power_couplings_stage2!.join(", "))}
                  style={{ fontFamily: "monospace", background: "#fff", padding: "1px 6px", borderRadius: 3, border: "1px solid #cbd5e1", cursor: "copy", color: "#1e3a8a" }}
                  title="Click to copy"
                >
                  κ²=[{effectiveSeedMeta.power_couplings_stage2.map(v => v.toFixed(3)).join(", ")}]
                </code>
              )}
            </div>
          )}
          {/* Stage 2 split rows (when unlocked) */}
          {!stage2Ganged && effectiveSeedMeta.delay_lengths_stage2_down && (
            <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ color: "#475569", fontWeight: 600, minWidth: 64 }}>②↓ S2 down:</span>
              <code
                onClick={() => navigator.clipboard?.writeText(effectiveSeedMeta.delay_lengths_stage2_down!.join(", "))}
                style={{ fontFamily: "monospace", background: "#fff", padding: "1px 6px", borderRadius: 3, border: "1px solid #cbd5e1", cursor: "copy", color: "#1e3a8a" }}
                title="Click to copy"
              >
                Δ=[{effectiveSeedMeta.delay_lengths_stage2_down.map(v => v.toFixed(2)).join(", ")}]
              </code>
              {effectiveSeedMeta.power_couplings_stage2_down && (
                <code
                  onClick={() => navigator.clipboard?.writeText(effectiveSeedMeta.power_couplings_stage2_down!.join(", "))}
                  style={{ fontFamily: "monospace", background: "#fff", padding: "1px 6px", borderRadius: 3, border: "1px solid #cbd5e1", cursor: "copy", color: "#1e3a8a" }}
                  title="Click to copy"
                >
                  κ²=[{effectiveSeedMeta.power_couplings_stage2_down.map(v => v.toFixed(3)).join(", ")}]
                </code>
              )}
            </div>
          )}
          {!stage2Ganged && effectiveSeedMeta.delay_lengths_stage2_up && (
            <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ color: "#475569", fontWeight: 600, minWidth: 64 }}>②↑ S2 up:</span>
              <code
                onClick={() => navigator.clipboard?.writeText(effectiveSeedMeta.delay_lengths_stage2_up!.join(", "))}
                style={{ fontFamily: "monospace", background: "#fff", padding: "1px 6px", borderRadius: 3, border: "1px solid #cbd5e1", cursor: "copy", color: "#1e3a8a" }}
                title="Click to copy"
              >
                Δ=[{effectiveSeedMeta.delay_lengths_stage2_up.map(v => v.toFixed(2)).join(", ")}]
              </code>
              {effectiveSeedMeta.power_couplings_stage2_up && (
                <code
                  onClick={() => navigator.clipboard?.writeText(effectiveSeedMeta.power_couplings_stage2_up!.join(", "))}
                  style={{ fontFamily: "monospace", background: "#fff", padding: "1px 6px", borderRadius: 3, border: "1px solid #cbd5e1", cursor: "copy", color: "#1e3a8a" }}
                  title="Click to copy"
                >
                  κ²=[{effectiveSeedMeta.power_couplings_stage2_up.map(v => v.toFixed(3)).join(", ")}]
                </code>
              )}
            </div>
          )}
        </div>
      )}
      {/*
       * key forces React to unmount the previous ReplayPanel and mount a
       * fresh instance whenever the user switches view-mode or active stage.
       * Without this, ReplayPanel's internal `arrayTexts` / `values` /
       * `selectedIdx` state survives the seedMeta swap → the textbox shows
       * the PREVIOUS stage's preset-resolved values while the right-side
       * "seed: [...]" hint reads the NEW seedMeta directly. That's the bug
       * users see when switching to Stage 1 with the Edit-delays preset
       * pre-selected: textbox shows top-FSR canonical (11.2, 22.4, ...) but
       * the hint shows stage_1's actual (22.4, 44.8, ...).
       */}
      <ReplayPanel
        // Re-mount on viewMode change OR ganged toggle so internal arrayTexts
        // / values / selectedIdx don't carry stale state from the previous
        // configuration. Without this the textbox shows e.g. stage_2 keys
        // after the user un-ganged but the seed hint shows stage_2_up/down.
        key={`${viewMode}|ganged=${stage2Ganged}`}
        netlistPath={effectiveNetlistPath}
        busy={busy}
        onReplay={dispatchReplay}
        onOptimize={dispatchOptimize}
        seedWdmType={effectiveWdmType}
        seedMeta={effectiveSeedMeta}
        // TOP mode = high-level scalar only (lattice arrays are per-stage
        // and editable from STAGE INDEPENDENT instead).
        restrictToHighLevel={viewMode === "top"}
        // Seed HARD-SPEC GATES from the Mux4 top spectrum's review_thresholds
        // (judge baseline). User can override per-field after mount.
        defaultHardSpecGates={reviewThresholds ?? undefined}
      />
    </div>
  );
}

function ReplayPanel({
  netlistPath,
  busy,
  onReplay,
  onOptimize,
  seedWdmType,
  seedMeta,
  restrictToHighLevel = false,
  defaultHardSpecGates,
}: {
  netlistPath: string;
  busy: boolean;
  onReplay: (path: string, overrides: Record<string, number | string | number[]>) => void;
  onOptimize?: (
    path: string,
    seedOverrides: Record<string, number | string | number[]>,
    cfg?: { budget?: number; target_params?: Record<string, number | boolean> },
  ) => void;
  seedWdmType: string | null;
  seedMeta: SeedMeta;
  /**
   * When true, only "appliesTo: all" presets are listed — used by the top-level
   * Mux4Configurable view where lattice arrays (delays/couplings) belong to
   * individual stages and editing them on the parent is meaningless. Defaults
   * to false (full preset list).
   */
  restrictToHighLevel?: boolean;
  /**
   * Auto-populate HARD-SPEC GATES inputs from this object on mount. Keys
   * mirror judge endpoint thresholds:
   * `il_limit_db / ripple_limit_db / crosstalk_baseline_db /
   *  crosstalk_tolerance_db / target_3db_bw_um / fsr_error_tol_pct`.
   * For Mux4Configurable runs, callers should pass `review_thresholds`
   * (derived from the seed's top Mux4 spectrum) so the verdict standard is
   * baselined against the actual seed performance, not arbitrary canonical
   * defaults. When undefined, falls back to hard-coded canonical Bogaerts
   * 4-stage strings.
   */
  defaultHardSpecGates?: Record<string, number | string | null | undefined>;
}) {
  // Resolve preset overrides against current seed meta (for relative presets).
  const resolveOverrides = (preset: typeof REPLAY_PRESETS[number]): ReplayOverrides => {
    if (preset.overridesFn) return preset.overridesFn(seedMeta);
    return preset.overrides ?? {};
  };
  const [open, setOpen]                   = useState(false);
  const [selectedIdx, setSelectedIdx]     = useState<number | null>(null);
  const [values, setValues]               = useState<Record<string, string>>({});
  const [arrayTexts, setArrayTexts]       = useState<Record<string, string>>({});
  // When true, scalar edits to center/FSR do NOT auto-rescale delay_lengths_um.
  // Default off (i.e. auto-rescale) because changing center/FSR while keeping
  // old delays produces a misaligned filter (FSR error, ripple penalty) — see
  // halfband helper analysis. Power user can override for ablation studies.
  const [keepDelaysFixed, setKeepDelaysFixed] = useState(false);

  // ── HARD-SPEC GATES (shared by Replay / Optimize / Calibrate) ─────────────
  // Lifted from OptimizeLauncher so all three flows judge against the same
  // verdict standard. Defaults: prefer `defaultHardSpecGates` (e.g. seed's
  // review_thresholds for Mux4Configurable), then fall back to canonical
  // Bogaerts 4-stage @ FSR=20 nm strings.
  const _gateInit = (gateKey: string, fallback: string): string => {
    const v = defaultHardSpecGates?.[gateKey];
    if (v == null || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : fallback;
  };
  const [maxIlDb,      setMaxIlDb]      = useState<string>(_gateInit("il_limit_db", "2.5"));
  const [maxRippleDb,  setMaxRippleDb]  = useState<string>(_gateInit("ripple_limit_db", "4.5"));
  const [xtBaselineDb, setXtBaselineDb] = useState<string>(_gateInit("crosstalk_baseline_db", "-2.7"));
  const [xtTolDb,      setXtTolDb]      = useState<string>(_gateInit("crosstalk_tolerance_db", "1.5"));
  const [minBwUm,      setMinBwUm]      = useState<string>(_gateInit("target_3db_bw_um", "0.008"));
  const [fsrErrPct,    setFsrErrPct]    = useState<string>(_gateInit("fsr_error_tol_pct", "5.0"));
  const [budget,       setBudget]       = useState<string>("5");
  // Track whether GATES were seeded from review_thresholds so we can label
  // them. When the user manually edits, the badge stays for transparency
  // (we don't try to detect "user diverged" — that's too noisy).
  const _gatesSeededFromReview = !!defaultHardSpecGates && Object.keys(defaultHardSpecGates).length > 0;

  // ── PDK-exact rescale via /api/halfband-recommend ──
  // The JS approximation in rescaleDelaysForParams uses fixed n_g/n_eff
  // constants (4.18 / 2.40), which is < 1% off for small shifts but drifts
  // up to ~1.5% over a full PDK range. The IPKISS server uses the actual
  // PDK trace template, so this asynchronously refines the displayed delays.
  //
  // Cache key = (center, FSR, dc_type) so repeat queries are instant; if
  // the upstream endpoint isn't deployed (404) or unreachable, the JS
  // approx is kept and no error is surfaced.
  type ApiResult = {
    delays: number[];
    powerCouplings: number[];
    designPoint: { length_um: number; length_pi_um: number };
  };
  const apiCacheRef = useRef<Map<string, ApiResult>>(new Map());
  const [apiResult, setApiResult] = useState<{ key: string; data: ApiResult } | null>(null);
  const [apiLoading, setApiLoading] = useState(false);
  const shortName = netlistPath.replace(/.*[/\\]/, "");

  const parseArrayText = (s: string): number[] =>
    s.split(/[,，\s]+/)
     .map(x => x.trim())
     .filter(x => x !== "")
     .map(x => Number(x))
     .filter(n => Number.isFinite(n));

  const selectPreset = (idx: number) => {
    if (selectedIdx === idx) {
      setSelectedIdx(null);
      setValues({});
      setArrayTexts({});
      return;
    }
    const resolved = resolveOverrides(REPLAY_PRESETS[idx]);
    // Guard: don't allow selecting an inapplicable preset (e.g. delay_lengths on Mux4 seed).
    if (!isPresetApplicable(resolved, seedWdmType).ok) return;

    // Preset only decides WHICH fields to expose; VALUES come from the current
    // seed so every iteration starts from the latest state. Preset's own value
    // is used only as fallback when the seed doesn't have that field.
    const seedScalarLookup: Record<string, number | null> = {
      center_wavelength_um: seedMeta.center_wavelength_um,
      center_wavelength:    seedMeta.center_wavelength_um,
      fsr_nm:               seedMeta.fsr_nm,
      fsr:                  seedMeta.fsr_um,
      bend_radius:          seedMeta.bend_radius,
      bend_radius_um:       seedMeta.bend_radius,
      wl_start_um:          seedMeta.wl_start_um,
      wl_stop_um:           seedMeta.wl_stop_um,
      n_points:             seedMeta.n_points,
    };
    const newValues: Record<string, string> = {};
    const newArrayTexts: Record<string, string> = {};
    for (const [k, v] of Object.entries(resolved)) {
      if (k.startsWith("_")) continue;  // skip hint / meta keys
      if (Array.isArray(v)) {
        const seedArr =
            (k === "delay_lengths_um" || k === "delay_lengths") ? seedMeta.delay_lengths_um
          : (k === "power_couplings") ? seedMeta.power_couplings
          : (k === "delay_lengths_stage1") ? seedMeta.delay_lengths_stage1 ?? null
          : (k === "delay_lengths_stage2") ? seedMeta.delay_lengths_stage2 ?? null
          : (k === "delay_lengths_stage2_up") ? seedMeta.delay_lengths_stage2_up ?? null
          : (k === "delay_lengths_stage2_down") ? seedMeta.delay_lengths_stage2_down ?? null
          : (k === "power_couplings_stage1") ? seedMeta.power_couplings_stage1 ?? null
          : (k === "power_couplings_stage2") ? seedMeta.power_couplings_stage2 ?? null
          : (k === "power_couplings_stage2_up") ? seedMeta.power_couplings_stage2_up ?? null
          : (k === "power_couplings_stage2_down") ? seedMeta.power_couplings_stage2_down ?? null
          : null;
        newArrayTexts[k] = seedArr ? seedArr.join(", ") : v.join(", ");
      } else {
        let seedVal: string | number | null = null;
        if (k === "dc_type") seedVal = seedMeta.dc_type;
        else {
          const n = seedScalarLookup[k];
          if (Number.isFinite(n as number) && n != null) seedVal = n;
        }
        newValues[k] = seedVal != null ? String(seedVal) : String(v);
      }
    }
    setSelectedIdx(idx);
    setValues(newValues);
    setArrayTexts(newArrayTexts);
  };

  const clearAll = () => {
    setSelectedIdx(null);
    setValues({});
    setArrayTexts({});
  };

  const submit = () => {
    const overrides: Record<string, number | string | number[]> = {};
    for (const [k, text] of Object.entries(arrayTexts)) {
      const parsed = parseArrayText(text);
      if (parsed.length) overrides[k] = parsed;
    }
    for (const [k, v] of Object.entries(values)) {
      if (v.trim() === "") continue;
      const n = Number(v);
      overrides[k] = Number.isFinite(n) ? n : v;
    }
    // Auto-rescale delays when scalar edits drift center or FSR away from seed.
    // Halfband-filter physics: ΔL ∝ λ²/FSR, so changing either of these without
    // updating delays leaves the lattice mis-aligned (FSR error 4% vs <2%, plus
    // ripple penalty ~0.5 dB — measured against the canonical N=5 Chebychev).
    // User can disable via the "keep delays unchanged" checkbox for ablations.
    if (
      seedWdmType === "MZILatticeFilter"
      && !keepDelaysFixed
      && !("delay_lengths_um" in overrides)
      && seedMeta.delay_lengths_um
      && seedMeta.center_wavelength_um != null
      && seedMeta.fsr_um != null
    ) {
      const newCenter = typeof overrides.center_wavelength_um === "number"
        ? overrides.center_wavelength_um as number
        : (typeof overrides.center_wavelength === "number" ? overrides.center_wavelength as number : null);
      let newFsrUm: number | null = null;
      if (typeof overrides.fsr_nm === "number") newFsrUm = (overrides.fsr_nm as number) / 1000;
      else if (typeof overrides.fsr === "number") {
        const f = overrides.fsr as number;
        newFsrUm = f > 1.0 ? f / 1000 : f;
      }
      // Prefer the PDK-exact API result if it matches the current proposal;
      // otherwise fall back to the JS linear approximation.
      let chosen: number[] | null = null;
      if (apiResult && apiResult.key === proposedApiKey) {
        chosen = apiResult.data.delays;
      } else {
        chosen = rescaleDelaysForParams(
          seedMeta.delay_lengths_um,
          seedMeta.center_wavelength_um,
          seedMeta.fsr_um,
          newCenter ?? seedMeta.center_wavelength_um,
          newFsrUm ?? seedMeta.fsr_um,
        );
      }
      if (chosen) overrides.delay_lengths_um = chosen;
    }
    // Pair-completion for MZILatticeFilter: if only one of delay/coupling arrays is
    // overridden, backfill the other from current seed so the API doesn't fall back
    // to _default_lattice_parameters and silently clobber the other axis.
    if (seedWdmType === "MZILatticeFilter") {
      if ("delay_lengths_um" in overrides && !("power_couplings" in overrides) && seedMeta.power_couplings) {
        overrides.power_couplings = [...seedMeta.power_couplings];
      }
      if ("power_couplings" in overrides && !("delay_lengths_um" in overrides) && seedMeta.delay_lengths_um) {
        overrides.delay_lengths_um = [...seedMeta.delay_lengths_um];
      }
    }
    // Sweep auto-widen: Luceda's SpectrumAnalyzer throws IndexError when a peak
    // lands at the sweep window's edge. When the user changes delays (which shifts
    // peak positions) but didn't explicitly set the window, expand to ≥5·FSR on
    // each side of the center so peaks stay inside with margin.
    if ("delay_lengths_um" in overrides
        && !("wl_start_um" in overrides)
        && !("wl_stop_um" in overrides)
        && seedMeta.center_wavelength_um != null) {
      const c = seedMeta.center_wavelength_um;
      const fsrUm = seedMeta.fsr_um ?? 0.02;
      const halfWin = Math.max(5 * fsrUm, 0.05);  // at least ±50 nm
      overrides.wl_start_um = +(c - halfWin).toFixed(4);
      overrides.wl_stop_um  = +(c + halfWin).toFixed(4);
    }
    // Inject HARD-SPEC GATES into the payload so /ipkiss/judge/wdm_mzi uses
    // the same verdict standard as Optimize/Calibrate. Field names match the
    // judge endpoint contract (see ipkiss-api/md/decide_skill.md). Empty/NaN
    // values are skipped so the backend defaults still apply.
    const numOr = (s: string, fallback: number | null): number | null => {
      const n = Number(s);
      return Number.isFinite(n) ? n : fallback;
    };
    const gateInjects: Record<string, number> = {};
    const minBw = numOr(minBwUm, null);     if (minBw != null) gateInjects.target_3db_bw_um = minBw;
    const il    = numOr(maxIlDb, null);     if (il != null)    gateInjects.il_limit_db = il;
    const rip   = numOr(maxRippleDb, null); if (rip != null)   gateInjects.ripple_limit_db = rip;
    const xtB   = numOr(xtBaselineDb, null);if (xtB != null)   gateInjects.crosstalk_baseline_db = xtB;
    const xtT   = numOr(xtTolDb, null);     if (xtT != null)   gateInjects.crosstalk_tolerance_db = xtT;
    const fsrE  = numOr(fsrErrPct, null);   if (fsrE != null)  gateInjects.fsr_error_tol_pct = fsrE;
    if (seedMeta.fsr_um != null) gateInjects.target_min_fsr_um = seedMeta.fsr_um;
    Object.assign(overrides, gateInjects);
    onReplay(netlistPath, overrides);
  };

  const selectedOverrides: ReplayOverrides | null =
    selectedIdx != null ? resolveOverrides(REPLAY_PRESETS[selectedIdx]) : null;
  const scalarKeys = selectedOverrides
    ? Object.entries(selectedOverrides).filter(([k, v]) => !k.startsWith("_") && !Array.isArray(v)).map(([k]) => k)
    : [];
  const arrayKeys = selectedOverrides
    ? Object.entries(selectedOverrides).filter(([k, v]) => !k.startsWith("_") && Array.isArray(v)).map(([k]) => k)
    : [];

  // Map scalar override keys to current seed values (for placeholder hints).
  const seedScalarValue = (key: string): string | null => {
    const m = seedMeta;
    const lookup: Record<string, number | null> = {
      center_wavelength_um: m.center_wavelength_um,
      center_wavelength: m.center_wavelength_um,
      fsr_nm: m.fsr_nm,
      fsr: m.fsr_um,
      bend_radius: m.bend_radius,
      bend_radius_um: m.bend_radius,
      wl_start_um: m.wl_start_um,
      wl_stop_um: m.wl_stop_um,
      n_points: m.n_points,
    };
    const v = lookup[key];
    return Number.isFinite(v as number) && v != null ? String(v) : null;
  };
  const seedArrayValue = (key: string): string | null => {
    const m = seedMeta;
    if ((key === "delay_lengths_um" || key === "delay_lengths") && m.delay_lengths_um) {
      return m.delay_lengths_um.join(", ");
    }
    if (key === "power_couplings" && m.power_couplings) {
      return m.power_couplings.join(", ");
    }
    // Mux4Configurable per-stage seed hints (ganged + independent variants).
    if (key === "delay_lengths_stage1" && m.delay_lengths_stage1) {
      return m.delay_lengths_stage1.join(", ");
    }
    if (key === "delay_lengths_stage2" && m.delay_lengths_stage2) {
      return m.delay_lengths_stage2.join(", ");
    }
    if (key === "delay_lengths_stage2_up" && m.delay_lengths_stage2_up) {
      return m.delay_lengths_stage2_up.join(", ");
    }
    if (key === "delay_lengths_stage2_down" && m.delay_lengths_stage2_down) {
      return m.delay_lengths_stage2_down.join(", ");
    }
    if (key === "power_couplings_stage1" && m.power_couplings_stage1) {
      return m.power_couplings_stage1.join(", ");
    }
    if (key === "power_couplings_stage2" && m.power_couplings_stage2) {
      return m.power_couplings_stage2.join(", ");
    }
    if (key === "power_couplings_stage2_up" && m.power_couplings_stage2_up) {
      return m.power_couplings_stage2_up.join(", ");
    }
    if (key === "power_couplings_stage2_down" && m.power_couplings_stage2_down) {
      return m.power_couplings_stage2_down.join(", ");
    }
    return null;
  };

  // ─── Auto-rescale preview ───
  // Mirrors the logic in submit(): when the user changes center or FSR in the
  // scalar editor on an MZILatticeFilter seed, delays must rescale by
  // k = (λ'/λ)² · (FSR/FSR') to keep the halfband filter aligned. We surface
  // this inline so the user can see the new delays before they hit Run replay.
  const rescaleProposal: {
    active: boolean;
    newCenter: number | null;
    newFsrUm: number | null;
    rescaled: number[] | null;
    factor: number | null;
  } = (() => {
    if (
      seedWdmType !== "MZILatticeFilter"
      || !seedMeta.delay_lengths_um
      || seedMeta.center_wavelength_um == null
      || seedMeta.fsr_um == null
    ) {
      return { active: false, newCenter: null, newFsrUm: null, rescaled: null, factor: null };
    }
    // User explicitly typed delays → rescale isn't applied (their numbers win).
    const delaysExplicit = parseArrayText(arrayTexts.delay_lengths_um ?? arrayTexts.delay_lengths ?? "").length > 0;
    if (delaysExplicit) {
      return { active: false, newCenter: null, newFsrUm: null, rescaled: null, factor: null };
    }
    const numFromValues = (k: string): number | null => {
      const v = values[k];
      if (v == null || v.trim() === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const newCenter = numFromValues("center_wavelength_um") ?? numFromValues("center_wavelength");
    const fsrNm = numFromValues("fsr_nm");
    let newFsrUm: number | null = null;
    if (fsrNm != null) newFsrUm = fsrNm / 1000;
    else {
      const fsrRaw = numFromValues("fsr");
      if (fsrRaw != null) newFsrUm = fsrRaw > 1.0 ? fsrRaw / 1000 : fsrRaw;
    }
    const rescaled = rescaleDelaysForParams(
      seedMeta.delay_lengths_um,
      seedMeta.center_wavelength_um,
      seedMeta.fsr_um,
      newCenter ?? seedMeta.center_wavelength_um,
      newFsrUm ?? seedMeta.fsr_um,
    );
    if (!rescaled) {
      return { active: false, newCenter, newFsrUm, rescaled: null, factor: null };
    }
    const lo = seedMeta.center_wavelength_um;
    const fo = seedMeta.fsr_um;
    const ln = newCenter ?? lo;
    const fn = newFsrUm ?? fo;
    const factor = (ln * ln) / (lo * lo) * (fo / fn);
    return { active: true, newCenter, newFsrUm, rescaled, factor };
  })();

  // Stable cache key for the API call — only depends on the values that
  // actually influence the PDK computation. Stays null when no rescale is
  // applicable so the effect bails out early.
  const proposedApiKey: string | null = (() => {
    if (!rescaleProposal.active) return null;
    const center = rescaleProposal.newCenter ?? seedMeta.center_wavelength_um;
    const fsrUm = rescaleProposal.newFsrUm ?? seedMeta.fsr_um;
    if (center == null || fsrUm == null) return null;
    const dcType = seedMeta.dc_type ?? "SiDirectionalCouplerSPower";
    return `${center.toFixed(6)}|${fsrUm.toFixed(6)}|si_wire|${dcType}`;
  })();

  // Debounced fetch (400ms) of the PDK-exact recommendation. Cache hits
  // return synchronously; misses fire after the user stops typing.
  useEffect(() => {
    if (!proposedApiKey) {
      setApiResult(null);
      return;
    }
    const cached = apiCacheRef.current.get(proposedApiKey);
    if (cached) {
      setApiResult({ key: proposedApiKey, data: cached });
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      const [centerStr, fsrStr, wgFamily, dcType] = proposedApiKey.split("|");
      const center = Number(centerStr);
      const fsrUm = Number(fsrStr);
      setApiLoading(true);
      try {
        const res = await fetch("/api/halfband-recommend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            center_wavelength_um: center,
            fsr_um: fsrUm,
            wg_family: wgFamily,
            dc_type: dcType,
            variant: "N5_chebychev_flipped_canonical",
          }),
        });
        if (cancelled) return;
        if (!res.ok) { setApiResult(null); return; }  // 404 / 502 → silent fallback
        const j = await res.json();
        if (cancelled) return;
        const data = j?.data;
        if (j?.status === "success" && Array.isArray(data?.delay_lengths_um)) {
          const result: ApiResult = {
            delays: data.delay_lengths_um as number[],
            powerCouplings: (data.power_couplings as number[]) ?? [],
            designPoint: data.design_point ?? { length_um: 0, length_pi_um: 0 },
          };
          apiCacheRef.current.set(proposedApiKey, result);
          setApiResult({ key: proposedApiKey, data: result });
        } else {
          setApiResult(null);
        }
      } catch {
        if (!cancelled) setApiResult(null);
      } finally {
        if (!cancelled) setApiLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [proposedApiKey]);

  // Effective delays for the banner + submit:
  //   - PDK-exact when API result matches the current proposal key
  //   - JS linear approximation otherwise (instantaneous, < 1% error)
  const effectiveRescaledDelays: number[] | null = (() => {
    if (!rescaleProposal.active) return null;
    if (apiResult && apiResult.key === proposedApiKey) return apiResult.data.delays;
    return rescaleProposal.rescaled;
  })();
  const effectiveSource: "pdk" | "approx" | null =
    rescaleProposal.active
      ? (apiResult && apiResult.key === proposedApiKey ? "pdk" : "approx")
      : null;

  return (
    <div style={{
      marginTop: 10, padding: 10, borderRadius: 8,
      background: "#fefce8", border: "1px solid #fde68a",
    }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        disabled={busy}
        style={{
          background: "transparent", border: "none", padding: 0,
          color: "#92400e", fontSize: 13, fontWeight: 600,
          cursor: busy ? "not-allowed" : "pointer", textAlign: "left",
        }}
      >
        {open ? "▾" : "▸"} 🔁 Replay with changes
        <span style={{ marginLeft: 6, fontWeight: 400, color: "#78716c", fontSize: 11 }}>
          · {shortName}
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {REPLAY_PRESETS.map((preset, idx) => {
              // Primary filter: hide presets not designed for this seed type
              if (!isPresetForSeed(preset.appliesTo, seedWdmType)) return null;
              // Secondary filter: in top-level Mux4Configurable mode, lattice
              // arrays must be edited per-stage, so hide everything except the
              // high-level "all"-scoped scalar presets.
              if (restrictToHighLevel && preset.appliesTo !== "all" && preset.appliesTo !== undefined) return null;
              const isSelected = selectedIdx === idx;
              const dim = selectedIdx != null && !isSelected;
              // Resolve overrides against current seed (for relative presets)
              const resolved = resolveOverrides(preset);
              // Secondary safety: lock preset if override keys aren't valid for this seed
              const applicability = isPresetApplicable(resolved, seedWdmType);
              const locked = !applicability.ok || resolved._hint !== undefined;
              const presetSummary = Object.entries(resolved)
                .filter(([k]) => !k.startsWith("_"))
                .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(',')}]` : v}`).join(", ");
              const title = locked
                ? `🔒 ${applicability.reason ?? "not applicable for this seed"}  ·  ${presetSummary}`
                : presetSummary;
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => selectPreset(idx)}
                  disabled={busy || locked}
                  title={title}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "4px 10px", fontSize: 12, textAlign: "left",
                    background: isSelected ? "#f59e0b" : (locked ? "#f5f5f4" : "#fff"),
                    color: isSelected ? "#fff" : (locked ? "#a8a29e" : "#92400e"),
                    fontWeight: isSelected ? 700 : 500,
                    border: `1px solid ${isSelected ? "#f59e0b" : (locked ? "#e7e5e4" : "#fcd34d")}`,
                    borderRadius: 6,
                    cursor: (busy || locked) ? "not-allowed" : "pointer",
                    opacity: busy ? 0.5 : (locked ? 0.55 : (dim ? 0.35 : 1)),
                    textDecoration: locked ? "line-through" : "none",
                    transition: "all 0.15s",
                  }}
                >
                  <span style={{ width: 14, textAlign: "center" }}>
                    {locked ? "🔒" : (isSelected ? "●" : "○")}
                  </span>
                  {preset.label}
                </button>
              );
            })}
            {seedWdmType === "MZILatticeFilter" && (
              <div style={{ fontSize: 10, color: "#78716c", padding: "2px 4px" }}>
                Seed type <code style={{ background: "#dcfce7", padding: "0 3px", borderRadius: 2 }}>MZILatticeFilter</code> — all overrides (incl. <code>delay_lengths_um</code> / <code>power_couplings</code> / <code>dc_type</code>) will be honored.
              </div>
            )}
            {seedWdmType === "Mux4Configurable" && (
              <div style={{ fontSize: 10, color: "#78716c", padding: "2px 4px" }}>
                Seed type <code style={{ background: "#dcfce7", padding: "0 3px", borderRadius: 2 }}>Mux4Configurable</code> — top-level <code>power_couplings</code> / <code>delay_lengths_um</code> propagate to all 3 stages. Per-stage seeds (<code>power_couplings_stage1</code>, <code>_stage2_up</code>, <code>_stage2_down</code>) and <code>stage2_link_mode</code> are also accepted; switch to a stage view above to edit the picked stage as a standalone MZILatticeFilter.
              </div>
            )}
            {seedWdmType && seedWdmType !== "MZILatticeFilter" && seedWdmType !== "Mux4Configurable" && (
              <div style={{ fontSize: 10, color: "#78716c", padding: "2px 4px" }}>
                Seed type <code style={{ background: "#fef3c7", padding: "0 3px", borderRadius: 2 }}>{seedWdmType}</code> — only high-level params (fsr / center / sweep / bend) are API-overridable. Low-level delays/couplings are locked inside Mux2; use an <code>MZILatticeFilter</code> or <code>Mux4Configurable</code> seed to optimize those.
              </div>
            )}
          </div>

          {selectedOverrides && (
            <div style={{
              padding: 8, borderRadius: 6,
              background: "#fff", border: "1px dashed #fcd34d",
              display: "flex", flexDirection: "column", gap: 6,
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#92400e", letterSpacing: "0.04em" }}>
                EDIT OVERRIDES
              </div>
              {scalarKeys.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  {scalarKeys.map(key => {
                    const fieldMeta = REPLAY_FIELDS.find(f => f.key === key);
                    const currentSeed = seedScalarValue(key);
                    return (
                      <label key={key} style={{ display: "flex", flexDirection: "column", fontSize: 11, color: "#78716c" }}>
                        <span>
                          {key}
                          {currentSeed != null && (
                            <span style={{ color: "#a8a29e", marginLeft: 4 }}>· seed: {currentSeed}</span>
                          )}
                        </span>
                        <input
                          type="number"
                          step={fieldMeta?.step ?? "any"}
                          value={values[key] ?? ""}
                          placeholder={currentSeed ?? fieldMeta?.placeholder ?? ""}
                          onChange={(e) => setValues(v => ({ ...v, [key]: e.target.value }))}
                          style={{
                            padding: "4px 6px", fontSize: 12, fontFamily: "monospace",
                            border: "1px solid #e7e5e4", borderRadius: 4, background: "#fff",
                          }}
                        />
                      </label>
                    );
                  })}
                </div>
              )}
              {rescaleProposal.active && effectiveRescaledDelays && (
                <div style={{
                  padding: "6px 8px", borderRadius: 4,
                  background: keepDelaysFixed ? "#fef3c7" : "#ecfeff",
                  border: `1px solid ${keepDelaysFixed ? "#fcd34d" : "#67e8f9"}`,
                  display: "flex", flexDirection: "column", gap: 4,
                  fontSize: 11, color: "#0e7490",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600 }}>
                      {keepDelaysFixed ? "⚠ delays unchanged" : "↻ delays will rescale"}
                    </span>
                    {!keepDelaysFixed && (
                      <span
                        title={effectiveSource === "pdk"
                          ? "PDK-exact (IPKISS get_mzi_delta_length_from_fsr on actual SiDirectionalCouplerSPower trace template)"
                          : "linear k=(λ'/λ)²·(FSR/FSR') with n_g=4.18 / n_eff=2.40 — < 1% off, refines to PDK-exact when /halfband_recommend responds"}
                        style={{
                          fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 3,
                          background: effectiveSource === "pdk" ? "#bbf7d0" : "#e0f2fe",
                          color: effectiveSource === "pdk" ? "#166534" : "#075985",
                          border: `1px solid ${effectiveSource === "pdk" ? "#86efac" : "#bae6fd"}`,
                        }}>
                        {apiLoading ? "fetching…" : (effectiveSource === "pdk" ? "✓ PDK-exact" : "linear approx")}
                      </span>
                    )}
                    <span style={{ color: "#0891b2", fontFamily: "monospace" }}>
                      k = {rescaleProposal.factor != null ? rescaleProposal.factor.toFixed(4) : "—"}
                    </span>
                    <span style={{ color: "#64748b" }}>
                      ({(seedMeta.center_wavelength_um ?? 0).toFixed(3)} µm
                      {rescaleProposal.newCenter != null && rescaleProposal.newCenter !== seedMeta.center_wavelength_um
                        ? ` → ${rescaleProposal.newCenter.toFixed(3)}` : ""}
                      , FSR {((seedMeta.fsr_um ?? 0) * 1000).toFixed(2)} nm
                      {rescaleProposal.newFsrUm != null && rescaleProposal.newFsrUm !== seedMeta.fsr_um
                        ? ` → ${(rescaleProposal.newFsrUm * 1000).toFixed(2)}` : ""}
                      )
                    </span>
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 10, color: "#0f172a" }}>
                    {keepDelaysFixed
                      ? <>seed delays kept: [{(seedMeta.delay_lengths_um ?? []).join(", ")}]</>
                      : <>[{(seedMeta.delay_lengths_um ?? []).join(", ")}] → <span style={{ color: "#0891b2", fontWeight: 600 }}>[{effectiveRescaledDelays.join(", ")}]</span></>}
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", color: "#475569", fontSize: 10 }}>
                    <input
                      type="checkbox"
                      checked={keepDelaysFixed}
                      onChange={(e) => setKeepDelaysFixed(e.target.checked)}
                      style={{ margin: 0 }}
                    />
                    keep delays unchanged (ablation: deliberately mis-aligned filter — expect higher FSR error & ripple)
                  </label>
                </div>
              )}
              {arrayKeys.map(key => {
                const text = arrayTexts[key] ?? "";
                const previewCount = parseArrayText(text).length;
                const currentSeedArr = seedArrayValue(key);
                return (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 11, color: "#78716c", fontFamily: "monospace" }}>{key}</span>
                      <span style={{ fontSize: 11, color: "#a8a29e" }}>({previewCount} values)</span>
                      {currentSeedArr != null && (
                        <span style={{ fontSize: 10, color: "#a8a29e", marginLeft: "auto" }}>
                          seed: [{currentSeedArr}]
                        </span>
                      )}
                    </div>
                    <input
                      type="text"
                      value={text}
                      onChange={(e) => setArrayTexts(prev => ({ ...prev, [key]: e.target.value }))}
                      placeholder={currentSeedArr ?? "comma-separated numbers"}
                      style={{
                        padding: "4px 6px", fontSize: 12, fontFamily: "monospace",
                        border: "1px solid #fcd34d", borderRadius: 4, background: "#fff",
                        color: "#92400e",
                      }}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* ── HARD-SPEC GATES (shared verdict standard for Replay / Optimize / Calibrate) ── */}
          <div style={{
            padding: 8, borderRadius: 6,
            background: "#faf5ff", border: "1px solid #e9d5ff",
            display: "flex", flexDirection: "column", gap: 6,
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#5b21b6", letterSpacing: "0.04em", display: "flex", alignItems: "center", gap: 8 }}>
              <span>HARD-SPEC GATES (verdict=pass when all met) — applies to Replay / Optimize / Calibrate</span>
              {_gatesSeededFromReview && (
                <span style={{
                  marginLeft: "auto",
                  padding: "1px 6px", borderRadius: 3,
                  background: "#dcfce7", color: "#166534",
                  fontSize: 9, fontWeight: 600,
                  border: "1px solid #16a34a",
                }} title="Initial values auto-populated from the seed Mux4 spectrum's review_thresholds. Edit any field to override.">
                  ✓ seeded from Mux4 baseline
                </span>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: "#78716c" }}>
                <span>max IL (dB) ≤</span>
                <input type="number" step="0.1" value={maxIlDb}
                  onChange={(e) => setMaxIlDb(e.target.value)}
                  style={{ padding: "3px 6px", fontSize: 11, fontFamily: "monospace", border: "1px solid #e7e5e4", borderRadius: 3, background: "#fff", width: "100%", boxSizing: "border-box" }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: "#78716c" }}>
                <span>max ripple (dB) ≤</span>
                <input type="number" step="0.1" value={maxRippleDb}
                  onChange={(e) => setMaxRippleDb(e.target.value)}
                  style={{ padding: "3px 6px", fontSize: 11, fontFamily: "monospace", border: "1px solid #e7e5e4", borderRadius: 3, background: "#fff", width: "100%", boxSizing: "border-box" }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: "#78716c" }}
                title="Halfband band-edge cross-over baseline. Default -2.7 dB ≈ canonical N=5 Chebychev with cutoff_db=-3 dB.">
                <span>XT baseline (dB)</span>
                <input type="number" step="0.1" value={xtBaselineDb}
                  onChange={(e) => setXtBaselineDb(e.target.value)}
                  style={{ padding: "3px 6px", fontSize: 11, fontFamily: "monospace", border: "1px solid #e7e5e4", borderRadius: 3, background: "#fff", width: "100%", boxSizing: "border-box" }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: "#78716c" }}
                title="Pass when |worst_xt - baseline| <= tolerance. Catches structural drift (cross-over moved, ripple inflated) regardless of direction.">
                <span>XT tol (±dB)</span>
                <input type="number" step="0.1" min="0" value={xtTolDb}
                  onChange={(e) => setXtTolDb(e.target.value)}
                  style={{ padding: "3px 6px", fontSize: 11, fontFamily: "monospace", border: "1px solid #e7e5e4", borderRadius: 3, background: "#fff", width: "100%", boxSizing: "border-box" }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: "#78716c" }}>
                <span>min 3dB BW (µm) ≥</span>
                <input type="number" step="0.001" value={minBwUm}
                  onChange={(e) => setMinBwUm(e.target.value)}
                  style={{ padding: "3px 6px", fontSize: 11, fontFamily: "monospace", border: "1px solid #e7e5e4", borderRadius: 3, background: "#fff", width: "100%", boxSizing: "border-box" }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: "#78716c" }}>
                <span>FSR err tol (%)</span>
                <input type="number" step="0.5" value={fsrErrPct}
                  onChange={(e) => setFsrErrPct(e.target.value)}
                  style={{ padding: "3px 6px", fontSize: 11, fontFamily: "monospace", border: "1px solid #e7e5e4", borderRadius: 3, background: "#fff", width: "100%", boxSizing: "border-box" }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: "#78716c" }}>
                <span>budget (max iters)</span>
                <input type="number" step="1" value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  style={{ padding: "3px 6px", fontSize: 11, fontFamily: "monospace", border: "1px solid #e7e5e4", borderRadius: 3, background: "#fff", width: "100%", boxSizing: "border-box" }} />
              </label>
            </div>
          </div>

          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={submit}
              disabled={busy || selectedIdx == null}
              style={{
                padding: "4px 10px", fontSize: 12, fontWeight: 600,
                background: (busy || selectedIdx == null) ? "#d6d3d1" : "#f59e0b",
                color: "#fff", border: "none", borderRadius: 4,
                cursor: (busy || selectedIdx == null) ? "not-allowed" : "pointer",
              }}
            >
              {busy ? "Running…" : "Run replay"}
            </button>
            {onOptimize && seedWdmType === "MZILatticeFilter" && (
              <OptimizeLauncher
                busy={busy}
                seedMeta={seedMeta}
                hardSpec={{ maxIlDb, maxRippleDb, xtBaselineDb, xtTolDb, minBwUm, fsrErrPct, budget }}
                onLaunch={(seedOv, cfg) => {
                  // Merge order matters: optimizer-driven keys (e.g. center_wavelength_um
                  // = the BO target) MUST win over the editor's scalar pre-fills.
                  // Otherwise an "Edit scalar params" preset that pre-loaded
                  // {center_wavelength_um: <seed>} would silently overwrite the
                  // launcher's target — i.e. clicking "Optimize → 1.541" with the
                  // editor showing seed 1.5400 would actually run BO with center=1.5400.
                  // We build editorExtras first, then spread seedOv last so its keys win.
                  const editorExtras: Record<string, number | string | number[]> = {};
                  for (const [k, text] of Object.entries(arrayTexts)) {
                    const parsed = parseArrayText(text);
                    if (parsed.length) editorExtras[k] = parsed;
                  }
                  for (const [k, v] of Object.entries(values)) {
                    if (v.trim() === "") continue;
                    const n = Number(v);
                    editorExtras[k] = Number.isFinite(n) ? n : v;
                  }
                  const seed: Record<string, number | string | number[]> = { ...editorExtras, ...seedOv };
                  onOptimize(netlistPath, seed, cfg);
                }}
              />
            )}
            {seedWdmType === "MZILatticeFilter" && (
              <CalibrateLauncher
                busy={busy}
                seedMeta={seedMeta}
                netlistPath={netlistPath}
                hardSpec={{ maxIlDb, maxRippleDb, xtBaselineDb, xtTolDb, minBwUm, fsrErrPct, budget }}
              />
            )}
            <button
              type="button"
              onClick={clearAll}
              disabled={busy}
              style={{
                padding: "4px 10px", fontSize: 12,
                background: "transparent", color: "#78716c",
                border: "1px solid #e7e5e4", borderRadius: 4, cursor: "pointer",
              }}
            >
              Clear
            </button>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "#a8a29e", alignSelf: "center" }}>
              {selectedIdx == null ? "Pick a preset to edit" : "Edit values, then Run replay"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Home() {
  const [messages, setMessages]         = useState<ChatMessage[]>([]);
  const [input, setInput]               = useState("");
  const [loading, setLoading]           = useState(false);
  const [forceSimulate, setForceSimulate] = useState(false);
  const [simulateDone, setSimulateDone]   = useState(false);
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [svgUrl, setSvgUrl]             = useState<string | null>(null);
  // Last simulation output (for inline s21_trace display)
  const [lastSimOut, setLastSimOut]     = useState<SimOutput | null>(null);

  const [pngUrl, setPngUrl]             = useState<string | null>(null);
  const [htmlUrl, setHtmlUrl]           = useState<string | null>(null);

  // Previous sim's GDS refs, snapshotted each time a new sim/replay is accepted.
  // Lets the layout panel split into Previous | Current for before/after comparison.
  type GdsRefs = { htmlUrl: string | null; svgUrl: string | null; pngUrl: string | null };
  const [prevGdsRefs, setPrevGdsRefs] = useState<GdsRefs | null>(null);
  const [gdsSplitPct, setGdsSplitPct] = useState<number>(50);  // width % for Previous pane
  const [prevGdsZoom, setPrevGdsZoom] = useState<number>(1);
  const [currentGdsZoom, setCurrentGdsZoom] = useState<number>(1);
  // When the GDS pane is too narrow for side-by-side comparison, stack
  // Previous / Current vertically. Threshold ≈ 700 px is the rough point at
  // which each side-by-side slot becomes too cramped to read the IPKISS
  // layout iframe (the inner diagram is fixed-size and ends up tiny).
  const [gdsStacked, setGdsStacked] = useState<boolean>(false);
  // Previous spectrum PNG basename, snapshotted on replay/optimize iter so the
  // sNp pane can split into Previous | Current for spectrum before/after comparison
  // — same protocol as prevGdsRefs but for the saved spectrum image.
  const [prevSpectrumPng, setPrevSpectrumPng] = useState<string | null>(null);
  const [prevSpectrumPngZoom, setPrevSpectrumPngZoom] = useState<number>(1);
  const [spectrumSplitPct, setSpectrumSplitPct] = useState<number>(50);  // % for Previous
  // Per-message toggle: 🔍 Inspect raw spectrum panel inside chat bubble.
  const [expandedSpectrumIds, setExpandedSpectrumIds] = useState<Set<number>>(new Set());
  const toggleSpectrumInspect = (id: number) => {
    setExpandedSpectrumIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const gdsPanelRef = useRef<HTMLDivElement | null>(null);

  // Auto-loaded SNP from simulation response
  const [snpData, setSnpData]           = useState<SnpData | null>(null);
  const [snpFilename, setSnpFilename]   = useState<string | null>(null);
  const [snpLoading, setSnpLoading]     = useState(false);
  // Seed (baseline) sNp filename — sticky across a replay/optimize session for
  // before/after comparison. Captured at session start; cleared when a fresh
  // simulation runs from scratch (sendQuery's normal path) or the user dismisses
  // the seed badge. The latest snpFilename is shown side-by-side with seed in
  // the standalone HTML viewer (overlay) via /spectrum/<latest>?seed=<seed>.
  const [seedSnpFilename, setSeedSnpFilename] = useState<string | null>(null);
  // Seed (baseline) design-intent center wavelength in µm — captured alongside
  // seedSnpFilename so the standalone viewer can draw a gray vertical line at
  // the SEED's design center plus a black line at the CURRENT center.
  const [seedCenterUm, setSeedCenterUm] = useState<number | null>(null);
  const [exampleMenuOpen, setExampleMenuOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(EXAMPLE_GROUPS.map(g => g.label))
  );
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number; width: number } | null>(null);

  const exampleMenuRef    = useRef<HTMLDivElement>(null);
  const exampleTriggerRef = useRef<HTMLButtonElement>(null);
  const inputRef      = useRef<HTMLTextAreaElement>(null);
  const bottomRef     = useRef<HTMLDivElement>(null);
  const idRef         = useRef(0);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const appShellRef   = useRef<HTMLDivElement>(null);
  const dragging      = useRef(false);
  const userResizedChat = useRef(false);
  const [splitPct,       setSplitPct]       = useState(50);   // vertical split %
  const [chatWidthPx,    setChatWidthPx]    = useState(320);  // horizontal chat width px
  const [inputHeightPx,  setInputHeightPx]  = useState(180);  // chat input area height px
  const [isNarrow,       setIsNarrow]       = useState(false); // narrow mode (≤900px)
  const [chatHeightPx,   setChatHeightPx]   = useState<number | null>(null); // narrow-mode chat panel height
  const [htmlPaneCollapsed, setHtmlPaneCollapsed] = useState(false);
  const [pngPaneCollapsed,  setPngPaneCollapsed]  = useState(false);
  const [sparamSplitPct,    setSparamSplitPct]    = useState(55);
  const [maximizedPane,     setMaximizedPane]     = useState<"html" | "png" | null>(null);
  const [spectrumPngZoom,   setSpectrumPngZoom]   = useState(1);
  const [spectrumHtmlZoom,  setSpectrumHtmlZoom]  = useState(1);
  const sparamSplitRef = useRef<HTMLDivElement>(null);
  const chatPanelRef = useRef<HTMLDivElement>(null);

  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !rightPanelRef.current) return;
      const rect = rightPanelRef.current.getBoundingClientRect();
      const pct  = ((ev.clientY - rect.top) / rect.height) * 100;
      setSplitPct(Math.max(15, Math.min(85, pct)));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const onInputDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !chatPanelRef.current) return;
      const rect = chatPanelRef.current.getBoundingClientRect();
      const fromBottom = rect.bottom - ev.clientY;
      setInputHeightPx(Math.max(100, Math.min(rect.height * 0.7, fromBottom)));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const onSparamSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !sparamSplitRef.current) return;
      const rect = sparamSplitRef.current.getBoundingClientRect();
      const pct  = ((ev.clientX - rect.left) / rect.width) * 100;
      // The sparam split divider now sits between Previous | Current spectrum PNG slots
      // (not HTML | PNG as before), so it drives spectrumSplitPct.
      setSpectrumSplitPct(Math.max(15, Math.min(85, pct)));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // Drag handler for the Previous | Current split inside the GDS Layout panel.
  const onGdsSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !gdsPanelRef.current) return;
      const rect = gdsPanelRef.current.getBoundingClientRect();
      // Use Y axis when panes are stacked vertically, X otherwise. The single
      // `gdsSplitPct` semantically means "Previous slot's share of the main
      // axis", so it works for both orientations.
      const pct = gdsStacked
        ? ((ev.clientY - rect.top)  / rect.height) * 100
        : ((ev.clientX - rect.left) / rect.width)  * 100;
      setGdsSplitPct(Math.max(15, Math.min(85, pct)));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [gdsStacked]);

  const onChatDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    if (isNarrow) {
      // Narrow layout: divider is horizontal, drag adjusts chat panel height
      const onMove = (ev: MouseEvent) => {
        if (!dragging.current || !chatPanelRef.current) return;
        const rect = chatPanelRef.current.getBoundingClientRect();
        const newH = ev.clientY - rect.top;
        const maxH = Math.floor(window.innerHeight * 0.9);
        setChatHeightPx(Math.max(180, Math.min(maxH, newH)));
      };
      const onUp = () => {
        dragging.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return;
    }
    userResizedChat.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !appShellRef.current) return;
      const rect = appShellRef.current.getBoundingClientRect();
      const px   = ev.clientX - rect.left;
      const maxPx = Math.max(600, Math.floor(rect.width * 0.75));
      setChatWidthPx(Math.max(200, Math.min(maxPx, px)));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [isNarrow]);

  useEffect(() => {
    const el = bottomRef.current;
    const container = el?.closest(".chat-messages") as HTMLElement | null;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  // Responsive chat width: when viewport is narrow (≲ half of a 1080p screen)
  // default to a 6:4 chat:results split; on wider screens keep the compact
  // 320px default. Skips adjustment once the user has dragged the divider.
  useEffect(() => {
    const update = () => {
      if (userResizedChat.current) return;
      const vw = window.innerWidth;
      const target = vw <= 1100 ? Math.floor(vw * 0.6) : 320;
      setChatWidthPx(target);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Track narrow viewport (matches @media max-width: 900px) so the chat ↔ right
  // divider can switch between col-resize (width) and row-resize (height).
  useEffect(() => {
    const update = () => setIsNarrow(window.innerWidth <= 900);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Auto-stack Previous / Current GDS panes when the container is too narrow
  // for side-by-side comparison. ResizeObserver watches the gds-content div
  // and toggles `gdsStacked` at 700 px. Below that, the side-by-side slots
  // (~half of half-screen each) are too narrow to read the IPKISS layout
  // iframe — vertical stacking gives each slot full pane width instead.
  useEffect(() => {
    const el = gdsPanelRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        setGdsStacked(prev => {
          // 32 px hysteresis avoids flapping when the user resizes near the boundary.
          if (prev && w >= 732) return false;
          if (!prev && w < 700) return true;
          return prev;
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!exampleMenuOpen) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (exampleMenuRef.current?.contains(t)) return;
      if (exampleTriggerRef.current?.contains(t)) return;
      setExampleMenuOpen(false);
    }
    function updatePos() {
      const r = exampleTriggerRef.current?.getBoundingClientRect();
      if (!r) return;
      setMenuPos({ left: r.left, bottom: window.innerHeight - r.top + 2, width: r.width });
    }
    updatePos();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", updatePos);
    window.addEventListener("scroll", updatePos, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", updatePos);
      window.removeEventListener("scroll", updatePos, true);
    };
  }, [exampleMenuOpen]);

  async function loadSnpFile(name: string): Promise<boolean> {
    setSnpLoading(true);
    try {
      const res = await fetch(`/api/results/${encodeURIComponent(name)}`);
      if (!res.ok) return false;
      const text = await res.text();
      const n    = getNPortsFromFilename(name);
      const data = parseSnp(text, n);
      setSnpData(data);
      setSnpFilename(name);
      return true;
    } catch {
      return false;
    } finally { setSnpLoading(false); }
  }

  async function send(overrideText?: string, forceOverride?: boolean) {
    const q = (overrideText ?? input).trim();
    if (!q || loading) return;
    const useForce = forceOverride ?? forceSimulate;
    const chatInput = useForce ? `${q} 強制模擬 / force simulate` : q;
    setInput("");
    setMessages((m) => [...m, {
      id: ++idRef.current, role: "user",
      text: useForce ? `⚡ ${q}` : q,
    }]);
    setLoading(true);

    try {
      const res  = await fetch(WEBHOOK, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ chatInput }),
      });
      // Read raw text first so we can show meaningful errors when the body
      // is empty or non-JSON (n8n webhook returns "" when an upstream node
      // throws before "Respond to Webhook"; bare res.json() then throws
      // SyntaxError: Unexpected end of JSON input — useless to the user).
      const rawText = await res.text();
      if (!res.ok) {
        const detail = rawText.trim().slice(0, 600) || `(empty body, status ${res.status})`;
        throw new Error(`HTTP ${res.status} from n8n webhook — ${detail}`);
      }
      if (!rawText.trim()) {
        throw new Error(
          "n8n webhook returned an empty response body. An upstream node likely " +
          "errored before reaching 'Respond to Webhook'. Check n8n executions log " +
          "(last execution → red node) for the failing SQL / HTTP / Code node.",
        );
      }
      let data: ApiResponse;
      try {
        data = JSON.parse(rawText) as ApiResponse;
      } catch (parseErr) {
        throw new Error(
          `n8n webhook returned non-JSON (${String(parseErr)}). First 400 chars: ${rawText.slice(0, 400)}`,
        );
      }
      const d = data.data as Record<string, unknown>;
      // Match renderBot parseOutput: sim route uses data directly; case_lookup uses data when success=true
      const out = parseOutput((
        data.data?.output ??
        (data.route_mode === "simulation" ? data.data : null) ??
        (data.route_mode === "case_lookup" && d?.success ? data.data : null)
      ) as string | SimOutput | undefined);

      // Layout priority: HTML > SVG > PNG
      // HTML: ipkiss_layout.layout_html_path / layout_html_path (served via /api/results)
      // SVG:  files.preview_svg / preview_path_svg / selected_case.preview_svg (via /api/fig)
      // PNG:  files.preview_png / preview_path / selected_case.preview_png (via /api/fig)
      const sel = (d?.mode === "case_hit" ? d?.selected_case : null) as Record<string, unknown> | null;
      const ipkLayout = out?.ipkiss_layout as Record<string, unknown> | undefined;
      // For case-hit rows that lack layout_html_path explicitly, derive sibling
      // artifact names from gds_filename — IPKISS writes <prefix>.gds alongside
      // <prefix>_layout.html / <prefix>_smatrix.png / <prefix>_spectrum.png.
      const selGds = typeof sel?.gds_filename === "string" ? sel.gds_filename.replace(/.*[/\\]/, "") : null;
      const selBase = selGds && /\.gds$/i.test(selGds) ? selGds.replace(/\.gds$/i, "") : null;
      const derivedHtml = selBase ? `${selBase}_layout.html` : null;
      const derivedSmatrix = selBase ? `${selBase}_smatrix.png` : null;
      const derivedSpectrum = selBase ? `${selBase}_spectrum.png` : null;
      // Explicit (server-asserted) html path takes precedence; derivedHtml is a
      // best-guess sibling of gds_filename and may not exist on disk for older
      // runs that didn't write _layout.html — we probe it before committing.
      const explicitHtmlRaw =
        (typeof ipkLayout?.layout_html_path === "string" ? ipkLayout.layout_html_path : null) ??
        (typeof out?.layout_html_path === "string" ? out.layout_html_path : null) ??
        (typeof sel?.layout_html_path === "string" ? sel.layout_html_path : null);
      // Initial chat send always shows a single fresh layout pane; Previous slot
      // is reserved for replay/optimize iterations where before/after matters.
      // Same applies to seedSnpFilename — fresh sim resets the comparison
      // baseline so the next replay/optimize session captures from scratch.
      setPrevGdsRefs(null);
      setPrevSpectrumPng(null);
      setSeedSnpFilename(null);
      setSeedCenterUm(null);

      const probeResults = async (file: string): Promise<boolean> => {
        try {
          const r = await fetch(`/api/results/${encodeURIComponent(file)}`, { method: "HEAD" });
          return r.ok;
        } catch { return false; }
      };

      // Resolve html/svg/png with the explicit-first, derived-with-probe rules.
      let htmlPicked: string | null = null;
      let pngPicked: string | null = null;
      let pngIsFig = false;  // /api/fig vs /api/results

      if (explicitHtmlRaw) {
        htmlPicked = explicitHtmlRaw.replace(/.*[/\\]/, "");
      } else if (derivedHtml) {
        // Probe sibling _layout.html; fall through to PNG fallback on 404.
        const exists = await probeResults(derivedHtml);
        if (exists) htmlPicked = derivedHtml;
      }

      if (!htmlPicked) {
        const svgRaw =
          out?.files?.preview_svg ??
          (typeof out?.preview_path_svg === "string" ? out.preview_path_svg : null) ??
          (typeof sel?.preview_svg === "string" ? sel.preview_svg : null);
        if (svgRaw) {
          const p = svgRaw.replace(/^\/fig\//, "");
          setHtmlUrl(null);
          setSvgUrl(`/api/fig/${encodeURIComponent(p)}`);
          setPngUrl(null);
        } else {
          const pngRaw =
            out?.files?.preview_png ??
            (typeof out?.preview_path === "string" ? out.preview_path : null) ??
            (typeof sel?.preview_png === "string" ? sel.preview_png : null);
          if (pngRaw) {
            pngPicked = pngRaw.replace(/^\/fig\//, "");
            pngIsFig = true;
          } else if (derivedSmatrix && await probeResults(derivedSmatrix)) {
            pngPicked = derivedSmatrix;
          } else if (derivedSpectrum && await probeResults(derivedSpectrum)) {
            pngPicked = derivedSpectrum;
          }
          setHtmlUrl(null);
          setSvgUrl(null);
          setPngUrl(pngPicked
            ? (pngIsFig
                ? `/api/fig/${encodeURIComponent(pngPicked)}`
                : `/api/results/${encodeURIComponent(pngPicked)}`)
            : null);
        }
      } else {
        setHtmlUrl(`/api/results/${encodeURIComponent(htmlPicked)}`);
        setSvgUrl(null);
        setPngUrl(null);
      }

      // Auto-load spectral data from simulation result
      if (out?.success) {
        setLastSimOut(out);
        const snpFile = findSnpFilename(out);
        if (snpFile) void loadSnpFile(snpFile);
      } else if (data.route_mode === "case_lookup" && d?.mode === "case_hit") {
        // Case-hit: synthesize a full SimOutput so downstream UI (cards, ReplayPanel,
        // file links, sNp viewer) renders identically to a simulation result.
        const selCase = d.selected_case as Record<string, unknown> | undefined;
        const synth = synthesizeSimOutputFromCase(selCase ?? null);
        // synth always sets spectrum_png_path / files based on the gds basename
        // even when those sibling files weren't actually written to disk (older
        // runs only wrote .gds + .s3p, no _spectrum.png). Probe before setting
        // so SpectrumPngSlot doesn't render a broken-image placeholder.
        if (synth) {
          if (synth.spectrum_png_path) {
            const png = String(synth.spectrum_png_path).replace(/.*[/\\]/, "");
            const ok = await probeResults(png);
            if (!ok) synth.spectrum_png_path = undefined;
          }
          setLastSimOut(synth);
        }
        // findSnpFromCase derives one filename from optical_function.ports.length;
        // when that's wrong (or missing) we'd silently 404. Probe the other
        // port counts sequentially so the spectrum still shows up.
        const primarySnp = findSnpFromCase(selCase);
        const gdsName = typeof selCase?.gds_filename === "string"
          ? selCase.gds_filename.replace(/.*[/\\]/, "").replace(/\.gds$/i, "")
          : null;
        const candidates = [
          primarySnp,
          ...(gdsName ? [`${gdsName}.s2p`, `${gdsName}.s3p`, `${gdsName}.s4p`, `${gdsName}.s8p`] : []),
        ].filter((x): x is string => !!x);
        const seen = new Set<string>();
        void (async () => {
          for (const c of candidates) {
            if (seen.has(c)) continue;
            seen.add(c);
            const ok = await loadSnpFile(c);
            if (ok) return;
          }
        })();
      }

      setMessages((m) => [...m, { id: ++idRef.current, role: "bot", text: q, response: data }]);
    } catch (e) {
      // Surface the diagnostic message we built above (includes raw body /
      // status / n8n hint) instead of the JS-runtime stringification of the
      // original SyntaxError, which used to render as just "Error: SyntaxError:
      // Failed to execute 'json' on 'Response': Unexpected end of JSON input"
      // and gave the user no way to understand what actually failed.
      const msg = e instanceof Error ? e.message : String(e);
      setMessages((m) => [...m, { id: ++idRef.current, role: "bot", text: `❌ ${msg}` }]);
    } finally {
      setLoading(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  async function sendReplay(netlistPath: string, overrides: Record<string, number | string | number[]>) {
    if (loading) return;
    const overrideEntries = Object.entries(overrides).filter(([, v]) => v !== "" && v != null);
    const summary = overrideEntries.length > 0
      ? overrideEntries.map(([k, v]) => `${k}=${v}`).join(", ")
      : "(no overrides)";
    setMessages((m) => [...m, {
      id: ++idRef.current, role: "user",
      text: `🔁 Replay netlist · ${summary}`,
    }]);
    setLoading(true);
    try {
      const payload: Record<string, unknown> = { netlist_json: netlistPath };
      for (const [k, v] of overrideEntries) payload[k] = v;
      const res = await fetch("/api/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      // /ipkiss/project/replay returns top-level { status: "ok", sNp_path, gds_path, netlist_json_path, ... }
      // Normalize into SimOutput shape expected by renderBot.
      const raw = (body?.data ?? body) as Record<string, unknown>;
      const ok = raw?.status === "ok" || raw?.status === "success" || raw?.success === true;
      const gdsFull = typeof raw?.gds_path === "string" ? raw.gds_path as string : null;
      const snpFull = typeof raw?.sNp_path === "string" ? raw.sNp_path as string
                      : (typeof raw?.touchstone_path === "string" ? raw.touchstone_path as string : null);
      const pngFull = typeof raw?.spectrum_png_path === "string" ? raw.spectrum_png_path as string : null;
      const base = (p: string | null) => p ? p.replace(/.*[/\\]/, "") : undefined;
      // Map replay's `center` → `center_result` / `spectral_feature` so existing
      // renderBot widgets (CENTER Λ, N_EFF, N_G / LOSS, spectrum) populate.
      const centerRaw = (raw?.center && typeof raw.center === "object") ? raw.center as Record<string, unknown> : null;
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v)) ? v : undefined;
      const centerResult = centerRaw ? {
        center_wavelength_um: num(centerRaw.center_wavelength_um) ?? num(centerRaw.wavelength_um),
        neff_center:          num(centerRaw.neff_center)          ?? num(centerRaw.neff),
        ng_center:            num(centerRaw.ng_center)            ?? num(centerRaw.ng),
        loss_db_per_m_center: num(centerRaw.loss_db_per_m_center) ?? num(centerRaw.loss_db_per_m),
      } : undefined;
      const freqDomain = (raw?.frequency_domain && typeof raw.frequency_domain === "object")
        ? raw.frequency_domain as Record<string, unknown> : null;
      const spectrumRaw = (raw?.spectrum && typeof raw.spectrum === "object")
        ? raw.spectrum as Record<string, unknown>
        : (freqDomain?.spectrum && typeof freqDomain.spectrum === "object" ? freqDomain.spectrum as Record<string, unknown> : null);
      const simOut: SimOutput = {
        ...(raw as object),
        success: Boolean(ok),
        ...(centerResult ? { center_result: centerResult } : {}),
        ...(spectrumRaw ? { spectral_feature: { ...spectrumRaw, ...(centerResult ?? {}) } } : {}),
        files: {
          gds_filename: base(gdsFull),
          snp_filename: base(snpFull),
          spectrum_png: base(pngFull),
          ...(typeof raw?.files === "object" && raw.files !== null ? raw.files as Record<string, string | undefined> : {}),
        },
      } as SimOutput;
      if (simOut?.success) {
        // Snapshot current spectrum PNG before lastSimOut is overwritten — must
        // happen BEFORE setLastSimOut() since findSpectrumPngFilename reads from it.
        const prevSpec = findSpectrumPngFilename(lastSimOut);
        if (prevSpec) setPrevSpectrumPng(prevSpec);
        setLastSimOut(simOut);
        // Capture seed sNp on first replay of a session: whatever was loaded
        // before this replay IS the baseline. Sticky — subsequent replays in
        // the same session keep comparing against the original seed.
        // IMPORTANT: only capture seed AFTER the new snp load succeeds. If the
        // replay returned a non-existent path or no path at all, loadSnpFile
        // 404s silently and leaves snpFilename unchanged — capturing seed in
        // that case would point seed at the same file as latest, suppressing
        // the compare button.
        const newSnpFile = findSnpFilename(simOut);
        const priorSnp = snpFilename;
        // Eager seed capture: as soon as we have a *candidate* new snp basename
        // that differs from priorSnp, set seed = priorSnp. This way even if the
        // subsequent loadSnpFile races, fails, or runs out-of-order, the seed
        // is preserved. The "compare" button is still gated on
        // `seed !== snpFilename`, so if load fails and snpFilename stays as
        // priorSnp, the button correctly hides (seed === snpFilename === sim).
        // If load succeeds and snpFilename becomes newSnpFile, seed=priorSnp
        // differs and the button reveals "Open HTML (compare)".
        if (newSnpFile && priorSnp && priorSnp !== newSnpFile) {
          setSeedSnpFilename((prev) => prev ?? priorSnp);
          // Capture seed's design center alongside seed filename. lastSimOut
          // (state) still holds the PREVIOUS sim at this point — setLastSimOut
          // hasn't been awaited and React batches synchronously here. Reading
          // it now gives us the seed's center_wavelength_um. Sticky like seed
          // filename: only set on first session capture.
          const priorCenterUm = lastSimOut?.center_result?.center_wavelength_um;
          if (typeof priorCenterUm === "number" && Number.isFinite(priorCenterUm)) {
            setSeedCenterUm((prev) => prev ?? priorCenterUm);
          }
        }
        if (newSnpFile) {
          void loadSnpFile(newSnpFile);
        }
        const htmlRaw =
          (typeof (simOut.ipkiss_layout as Record<string, unknown> | undefined)?.layout_html_path === "string"
            ? (simOut.ipkiss_layout as Record<string, unknown>).layout_html_path as string
            : null) ??
          (typeof simOut.layout_html_path === "string" ? simOut.layout_html_path : null);
        if (htmlRaw) {
          // Snapshot current layout as Previous before swapping (for before/after view).
          if (htmlUrl || svgUrl || pngUrl) {
            setPrevGdsRefs({ htmlUrl, svgUrl, pngUrl });
          }
          setHtmlUrl(`/api/results/${encodeURIComponent(htmlRaw.replace(/.*[/\\]/, ""))}`);
          setSvgUrl(null);
          setPngUrl(null);
        }
      }
      const fakeResp: ApiResponse = {
        ok: Boolean(simOut?.success),
        route_mode: "simulation",
        intent_name: "project_replay",
        classification: { reason: "frontend replay button" },
        data: simOut as ApiResponse["data"],
      };
      const botId = ++idRef.current;
      setMessages((m) => [...m, {
        id: botId, role: "bot",
        text: `Replay · ${summary}`, response: fakeResp,
      }]);

      // Tier-2 LLM review after Tier-1 judge. /api/replay now returns a judge-
      // shaped body (evaluation + artifacts). Thread the evaluation into the
      // review so the LLM can cite concrete check outcomes. If judge already
      // says pass, the LLM review is still useful for the natural-language explanation.
      if (simOut?.success) {
        const judgeEval = (raw?.evaluation && typeof raw.evaluation === "object")
          ? raw.evaluation as Record<string, unknown>
          : null;
        void (async () => {
          try {
            const reviewRes = await fetch("/api/replay-review", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                sim_result: raw,
                judge: judgeEval,
                request: {
                  question: `Replay · ${summary}`,
                  route_mode: "simulation",
                },
              }),
            });
            if (!reviewRes.ok) return;
            const reviewBody = await reviewRes.json() as { review?: Record<string, unknown> };
            if (!reviewBody?.review) return;
            // Merge review into the bot message so renderBot can pick it up.
            setMessages((m) => m.map((msg) => {
              if (msg.id !== botId || !msg.response) return msg;
              const prevData = (msg.response.data ?? {}) as Record<string, unknown>;
              return {
                ...msg,
                response: {
                  ...msg.response,
                  data: { ...prevData, llm_review: reviewBody.review } as ApiResponse["data"],
                },
              };
            }));
          } catch {
            // swallow — review failure shouldn't break the replay result.
          }
        })();
      }
    } catch (e) {
      setMessages((m) => [...m, {
        id: ++idRef.current, role: "bot", text: `Replay error: ${e}`,
      }]);
    } finally {
      setLoading(false);
    }
  }

  // ── Auto-optimize loop (Tier-3 Decide Agent) ────────────────────────────────
  // Chain: replay → review → decide → replay → ... (budget-bound)
  // Logs timing + tokens per tier for apples-to-apples comparison.
  async function sendOptimizeLoop(
    netlistPath: string,
    seedOverrides: Record<string, number | string | number[]>,
    cfg?: {
      budget?: number;
      target_params?: Record<string, number | boolean>;
    },
  ) {
    if (loading) return;
    const BUDGET = cfg?.budget && cfg.budget > 0 ? cfg.budget : 5;
    type BORec = {
      acquisition?: string | null;
      acquisition_value?: number | null;
      predicted_mean?: number | null;
      predicted_std?: number | null;
      n_observations?: number | null;
      ms?: number | null;
      candidate_power_couplings?: number[] | null;
      x_next?: number[] | null;
      best_so_far?: { x?: number[]; y?: number } | null;
    };
    type AttemptRec = {
      iter: number;
      params: Record<string, unknown>;
      judge:  { verdict?: string; score?: number; checks?: Record<string, unknown>; suggestions?: string[] };
      review: { llm_verdict?: string; llm_score?: number; llm_reasoning?: string };
      decide: { strategy?: string; reason?: string; confidence?: number; invariant_ok?: boolean };
      bo:     BORec | null;
      timing_ms: { replay: number; review: number; decide: number; bo?: number | null };
      tokens:    { review: { prompt: number | null; completion: number | null }; decide: { prompt: number | null; completion: number | null } };
    };
    type N8nAttempt = {
      iter_n: number;
      params_used?: Record<string, unknown>;
      judge?: AttemptRec["judge"];
      review?: { verdict?: string; score?: number; reasoning?: string };
      decide?: AttemptRec["decide"];
      bo?: BORec | null;
      timing_ms?: AttemptRec["timing_ms"];
      tokens?: AttemptRec["tokens"];
      artifacts?: { layout_html_path?: string };
    };
    type StatusBody = {
      found?: boolean;
      run_id?: string;
      status?: string;
      stop_reason?: string | null;
      total_iters?: number | null;
      attempts?: N8nAttempt[];
    };

    const adapt = (a: N8nAttempt): AttemptRec => ({
      iter: a.iter_n,
      params: a.params_used ?? {},
      judge:  a.judge ?? {},
      review: {
        llm_verdict:   a.review?.verdict,
        llm_score:     a.review?.score,
        llm_reasoning: a.review?.reasoning,
      },
      decide: a.decide ?? {},
      bo:     a.bo ?? null,
      timing_ms: a.timing_ms ?? { replay: 0, review: 0, decide: 0 },
      tokens:    a.tokens    ?? { review: { prompt: null, completion: null }, decide: { prompt: null, completion: null } },
    });

    const botId = ++idRef.current;
    // Build a human-readable physics breakdown of what the seed_overrides actually
    // *do* — so the user can verify Bogaerts protocol execution at a glance instead
    // of having to inspect the network payload. Shows λ shift, ΔL rescale, and κ
    // reset when wavelength_drift mode is in play.
    const seedPhysicsLines: string[] = [];
    const fmt2 = (n: unknown, p = 4) =>
      (typeof n === "number" && Number.isFinite(n)) ? n.toFixed(p) : String(n);
    const fmtArr2 = (a: unknown, p = 2) =>
      Array.isArray(a) ? `[${(a as number[]).map((v) => Number(v).toFixed(p)).join(", ")}]` : "—";
    if ("center_wavelength_um" in seedOverrides) {
      seedPhysicsLines.push(`λ_c = ${fmt2(seedOverrides.center_wavelength_um, 4)} µm`);
    }
    if ("delay_lengths_um" in seedOverrides) {
      seedPhysicsLines.push(`ΔL = ${fmtArr2(seedOverrides.delay_lengths_um)} µm`);
    }
    if ("power_couplings" in seedOverrides) {
      const pc = seedOverrides.power_couplings as number[] | undefined;
      const isCanonical = Array.isArray(pc) && pc.length === 5
        && Math.abs(pc[0] - 0.5) < 1e-3 && Math.abs(pc[1] - 0.13) < 1e-3
        && Math.abs(pc[2] - 0.12) < 1e-3 && Math.abs(pc[3] - 0.5) < 1e-3
        && Math.abs(pc[4] - 0.25) < 1e-3;
      const tag = isCanonical ? " ← canonical Bogaerts half-band" : "";
      seedPhysicsLines.push(`κ = ${fmtArr2(seedOverrides.power_couplings, 3)}${tag}`);
    }
    const physicsAnnotation = seedPhysicsLines.length
      ? `\n  ${seedPhysicsLines.join("\n  ")}`
      : "";
    setMessages(m => [...m, {
      id: ++idRef.current, role: "user",
      text: `🤖 Auto-optimize · budget=${BUDGET}\nseed overrides: ${Object.keys(seedOverrides).join(", ") || "(none)"}${physicsAnnotation}`,
    }]);
    setMessages(m => [...m, {
      id: botId, role: "bot",
      text: `Starting optimize run…`,
      response: {
        ok: true, route_mode: "simulation", intent_name: "project_optimize",
        classification: { reason: "n8n optimize-wdm-mzi" },
        data: { success: true, optimize_history: [], status: "running" } as ApiResponse["data"],
      },
    }]);
    setLoading(true);

    let runId: string | null = null;
    let lastSeenAttempts = 0;

    try {
      // ---- 1) Kick off (n8n outer responds immediately with run_id)
      const defaultTargets = {
        target_min_fsr_um: 0.02,
        target_3db_bw_um:  0.01,
        // Crosstalk: baseline-relative gate (halfband cross-over physics).
        // Old absolute gate (crosstalk_limit_db) is still honored if explicitly
        // sent by the caller, but defaults are baseline ±1.5 dB so a canonical
        // halfband seed PASSES out of the box.
        crosstalk_baseline_db:  -2.7,
        crosstalk_tolerance_db: 1.5,
        il_limit_db:        2.5,
        ripple_limit_db:    1.0,
        fsr_error_tol_pct:  3.0,
        epsilon: 0.01,        // ε: |L_k − L_{k-1}| < ε · L_0
        delta:   0.002,       // δ: max|Δx_i| < δ
        require_measured_fsr: false,
      };
      const startRes = await fetch("/api/optimize-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          netlist_json: netlistPath,
          budget: BUDGET,
          overrides: seedOverrides,
          target_params: { ...defaultTargets, ...(cfg?.target_params ?? {}) },
        }),
      });
      const startBody = await startRes.json() as { run_id?: string; status?: string };
      if (!startBody?.run_id) throw new Error("optimize-start returned no run_id");
      runId = startBody.run_id;

      // ---- 2) Poll status until terminal (with wall-clock + stagnation safety)
      const POLL_MS = 3000;
      const MAX_WALL_MS = 10 * 60 * 1000; // 10 min total
      const STALL_MS    = 4 * 60 * 1000;  // bail if no new attempt in 4 min
      const startedAt   = Date.now();
      let lastProgressAt = Date.now();
      let consecutiveErrors = 0;
      while (true) {
        await new Promise(r => setTimeout(r, POLL_MS));
        if (Date.now() - startedAt > MAX_WALL_MS) {
          throw new Error(`optimize timed out after ${Math.round(MAX_WALL_MS/1000)}s · run_id=${runId}`);
        }
        if (Date.now() - lastProgressAt > STALL_MS) {
          throw new Error(`optimize stalled · no new attempt in ${Math.round(STALL_MS/1000)}s · run_id=${runId}`);
        }
        let status: StatusBody;
        try {
          const statusRes = await fetch(`/api/optimize-status?run_id=${encodeURIComponent(runId)}`);
          status = await statusRes.json() as StatusBody;
          consecutiveErrors = 0;
        } catch {
          if (++consecutiveErrors >= 5) throw new Error(`optimize-status fetch failed 5x in a row · run_id=${runId}`);
          continue;
        }
        if (!status.found) continue;

        const attempts = Array.isArray(status.attempts) ? status.attempts : [];
        const history = attempts.map(adapt);

        // Refresh layout preview when a new attempt arrives
        if (attempts.length > lastSeenAttempts) {
          const latest = attempts[attempts.length - 1];
          const htmlRaw = latest?.artifacts?.layout_html_path;
          if (typeof htmlRaw === "string" && htmlRaw) {
            if (htmlUrl || svgUrl || pngUrl) setPrevGdsRefs({ htmlUrl, svgUrl, pngUrl });
            setHtmlUrl(`/api/results/${encodeURIComponent(htmlRaw.replace(/.*[/\\]/, ""))}`);
            setSvgUrl(null); setPngUrl(null);
          }
          // Snapshot + swap the spectrum PNG too so the sNp pane mirrors the layout
          // pane's before/after view across optimize iterations.
          const specRaw = (latest?.artifacts as Record<string, unknown> | undefined)?.spectrum_png_path;
          if (typeof specRaw === "string" && specRaw) {
            const newSpec = specRaw.replace(/.*[/\\]/, "");
            const prevSpec = findSpectrumPngFilename(lastSimOut);
            if (prevSpec && prevSpec !== newSpec) setPrevSpectrumPng(prevSpec);
            // Update lastSimOut.spectrum_png_path so renderSimPanel picks up the new PNG.
            setLastSimOut((cur) => cur
              ? ({ ...cur, spectrum_png_path: newSpec } as SimOutput)
              : ({ success: true, spectrum_png_path: newSpec } as SimOutput)
            );
          }
          // Refresh sNp viewer per attempt and capture iter-1 sNp as seed so
          // the standalone HTML viewer can overlay seed-vs-latest. Optimize
          // sessions ALWAYS use iter 1 as the baseline (canonical κ at the new
          // λ), regardless of any pre-session snp loaded in the chat.
          //
          // IMPORTANT: when polling catches multiple new attempts in one tick
          // (common at the start of a fast run), `latest` is e.g. iter 2 — so
          // an `isIter1 = latest.iter_n === 1` check would skip seed capture
          // entirely and we'd lose the baseline. Look up iter 1 explicitly
          // from the full attempts list instead.
          const snpRawLatest = (latest?.artifacts as Record<string, unknown> | undefined)?.sNp_path;
          if (typeof snpRawLatest === "string" && snpRawLatest) {
            const newSnp = snpRawLatest.replace(/.*[/\\]/, "");
            void loadSnpFile(newSnp);
          }
          const iter1 = attempts.find((a) => a.iter_n === 1);
          const snpRawIter1 = (iter1?.artifacts as Record<string, unknown> | undefined)?.sNp_path;
          if (typeof snpRawIter1 === "string" && snpRawIter1) {
            const seedName = snpRawIter1.replace(/.*[/\\]/, "");
            // Sticky: only set on first sighting of iter 1; later polls leave
            // the seed unchanged. Done eagerly (no wait for load) so the
            // compare button can light up the moment iter 2's snp finishes
            // loading. If the seed file 404s when the standalone viewer tries
            // to open it, the viewer simply renders without an overlay —
            // strictly better than failing to mark the session as comparable.
            setSeedSnpFilename((prev) => prev ?? seedName);
          }
          // Capture iter 1's design center wavelength as the seed center
          // (gray vertical line in the standalone viewer). Read from
          // params_used.center_wavelength_um with a fallback to the seed
          // overrides we sent at start.
          const iter1Params = iter1?.params_used as Record<string, unknown> | undefined;
          const iter1CenterUm = iter1Params?.center_wavelength_um ?? iter1Params?.center_wavelength;
          if (typeof iter1CenterUm === "number" && Number.isFinite(iter1CenterUm)) {
            setSeedCenterUm((prev) => prev ?? iter1CenterUm);
          }
          lastSeenAttempts = attempts.length;
          lastProgressAt = Date.now();
        }

        const runStatus = status.status ?? "running";
        const isTerminal = runStatus !== "running";
        const lastVerdict = history[history.length - 1]?.judge.verdict ?? "—";
        const text = isTerminal
          ? `Auto-optimize done · ${runStatus}${status.stop_reason ? ` · ${status.stop_reason}` : ""} · ${history.length} iter`
          : `Optimizing (iter ${history.length}/${BUDGET} · ${lastVerdict})…`;

        setMessages(m => m.map(msg => {
          if (msg.id !== botId || !msg.response) return msg;
          return {
            ...msg,
            text,
            response: {
              ...msg.response,
              data: { success: true, optimize_history: history, status: isTerminal ? runStatus : "running" } as ApiResponse["data"],
            },
          };
        }));

        if (isTerminal) break;
      }
    } catch (e) {
      console.error("optimize loop error", e);
      setMessages(m => m.map(msg => {
        if (msg.id !== botId || !msg.response) return msg;
        return {
          ...msg,
          text: `Auto-optimize error · ${String(e)}${runId ? ` · run_id=${runId}` : ""}`,
          response: { ...msg.response, data: { ...msg.response.data, status: "error" } as ApiResponse["data"] },
        };
      }));
    } finally {
      setLoading(false);
    }
  }

  // ── Render chat bot message ─────────────────────────────────────────────────

  function renderBot(msg: ChatMessage) {
    const r = msg.response;
    if (!r) return <div className="msg bot">{msg.text}</div>;
    // case_lookup can also carry a sim result in r.data (when lookup missed → sim ran)
    // case_hit (RAG match) gets synthesized into a SimOutput shape so it renders
    // through the same pipeline as simulation results (cards / ReplayPanel / files).
    const caseHitData = (
      r.route_mode === "case_lookup" &&
      (r.data as Record<string,unknown>)?.mode === "case_hit"
    ) ? (r.data as Record<string,unknown>) : null;
    const out  = parseOutput((
      r.data?.output ??
      (r.route_mode === "simulation" ? r.data : null) ??
      ((r.route_mode === "case_lookup") && (r.data as Record<string,unknown>)?.success ? r.data : null) ??
      (caseHitData
        ? synthesizeSimOutputFromCase(caseHitData.selected_case as Record<string, unknown> | null | undefined)
        : null)
    ) as string | SimOutput | undefined);
    const mode = r.route_mode;

    const gdsFile = findGdsFilename(out);
    const snpFile = findSnpFilename(out);
    const opticalSummary = getObjectValue<OpticalFunctionSummary>(out?.llm_summary?.optical_function);
    const spectralSummary = getObjectValue<SpectrumSummary>(out?.llm_summary?.spectral_feature)
      ?? getObjectValue<SpectrumSummary>(out?.spectral_feature)
      ?? getObjectValue<SpectrumSummary>(out?.spectrum);
    const validationWarnings = out?.llm_summary?.validation_warnings ?? [];
    const nullReview = buildSpectrumNullReview(spectralSummary, out);
    const rawCenter = out?.center_result;
    const centerInfo = {
      wavelength_um: rawCenter?.center_wavelength_um || spectralSummary?.center_wavelength_um || null,
      neff:          rawCenter?.neff_center          || spectralSummary?.neff_center          || null,
      ng:            rawCenter?.ng_center            || spectralSummary?.ng_center            || null,
      loss_db_per_m: rawCenter?.loss_db_per_m_center || spectralSummary?.loss_db_per_m_center || null,
    };

    return (
      <div className="msg bot">
        <span className={badgeClass(mode)}>{mode}</span>

        {/* ⚠ IGNORED-PARAMS WARNING — placed RIGHT AFTER the route badge so the
            user sees "this command had X params silently dropped" before any
            sim result cards. Fires when user-supplied lattice params
            (power_couplings / delay_lengths_um / bend_radius) target a
            wdm_type that LockedProperty discards (Mux2/Mux4/Mux8). Backend
            _detect_ignored_params populates `out.ignored_params`; empty list =
            no warning. */}
        {(() => {
          const ignored = (out as any)?.ignored_params;
          if (!Array.isArray(ignored) || ignored.length === 0) return null;
          const wdmType = String(
            (out as any)?.netlist?.wdm_meta?.wdm_type
            ?? (out as any)?.params_used?.wdm_type
            ?? "this cell"
          );
          return (
            <div style={{
              marginTop: 8, marginBottom: 4,
              padding: "12px 14px",
              borderRadius: 10,
              background: "linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)",
              border: "2px solid #f59e0b",
              boxShadow: "0 2px 8px rgba(245, 158, 11, 0.15)",
            }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 10, marginBottom: 8,
              }}>
                <span style={{ fontSize: 22, lineHeight: 1 }}>⚠️</span>
                <span style={{
                  fontSize: 15, fontWeight: 700, color: "#92400e",
                  letterSpacing: "0.02em",
                }}>
                  指令中有 {ignored.length} 個參數被靜默忽略 / {ignored.length} parameter(s) silently ignored
                </span>
                <span style={{
                  marginLeft: "auto",
                  padding: "2px 8px", borderRadius: 4,
                  background: "rgba(146, 64, 14, 0.15)",
                  color: "#92400e", fontSize: 11, fontFamily: "monospace",
                }}>
                  wdm_type = {wdmType}
                </span>
              </div>
              <div style={{ fontSize: 12, color: "#78350f", marginBottom: 10, lineHeight: 1.5 }}>
                這些參數在 IPKISS 端被 LockedProperty 或 ctor 簽名擋掉，<b>沒有進入模擬</b> / These parameters were blocked by LockedProperty or ctor signature on the IPKISS side and did <b>not</b> enter the simulation.
                模擬實際使用的是 {wdmType} 的內建預設值 / Simulation actually used {wdmType}'s built-in defaults. 如要實際生效，請改用建議的 wdm_type / To actually take effect, switch to the suggested wdm_type.
              </div>
              <ul style={{
                margin: 0, padding: 0, listStyle: "none",
                display: "flex", flexDirection: "column", gap: 8,
              }}>
                {ignored.map((entry: any, idx: number) => (
                  <li key={idx} style={{
                    padding: "8px 10px",
                    background: "rgba(255,255,255,0.6)",
                    border: "1px solid rgba(146, 64, 14, 0.25)",
                    borderRadius: 6,
                  }}>
                    <div style={{
                      display: "flex", alignItems: "baseline", gap: 8,
                      marginBottom: 4, flexWrap: "wrap",
                    }}>
                      <span style={{
                        fontFamily: "monospace", fontWeight: 700,
                        color: "#7c2d12", fontSize: 12,
                      }}>
                        {entry.key}
                      </span>
                      <span style={{
                        fontFamily: "monospace", fontSize: 11,
                        color: "#a16207",
                        textDecoration: "line-through",
                      }}>
                        = {entry.value}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "#78350f", lineHeight: 1.5 }}>
                      {entry.reason}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}

        {/* ── Simulation result (simulation route OR case_lookup fallback-to-sim) ── */}
        {out?.success && (
          <>
            {/* RAG-source chip: visible only when this card was synthesized from a case-hit row. */}
            {caseHitData && (() => {
              const ret = caseHitData.retrieval as Record<string, unknown> | undefined;
              const conf = typeof ret?.retrieval_confidence === "number" ? ret.retrieval_confidence : null;
              const matchType = typeof ret?.match_type === "string" ? ret.match_type : "match";
              return (
                <div style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  marginTop: 6, padding: "2px 8px", borderRadius: 4,
                  background: "rgba(37,99,235,0.08)", border: "1px solid rgba(37,99,235,0.25)",
                  color: "#2563eb", fontSize: 11, fontWeight: 600,
                }}>
                  <span>✓ 找到相似案例 / Similar case found</span>
                  <span style={{ fontWeight: 400, opacity: 0.85 }}>{matchType}</span>
                  {conf != null && (
                    <span style={{ fontFamily: "monospace", fontWeight: 400, opacity: 0.85 }}>
                      · confidence {(conf * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
              );
            })()}
            {/* LLM summary */}
            {typeof out.llm_summary?.optical_function === "string" && (
              <div style={{ fontSize: 16, color: "var(--accent)", marginTop: 6, letterSpacing: "0.03em" }}>
                {out.llm_summary.optical_function}
              </div>
            )}
            {typeof out.llm_summary?.spectral_feature === "string" && (
              <div style={{ fontSize: 16, color: "#0891b2", marginTop: 3 }}>
                {out.llm_summary.spectral_feature}
              </div>
            )}

            {(opticalSummary || spectralSummary || centerInfo) && (
              <div className="sim-inspector">
                {opticalSummary && (
                  <div className="sim-inspector-grid">
                    <div className="sim-inspector-card">
                      <span>Device</span>
                      <strong>{opticalSummary.device ?? opticalSummary.dc_type ?? "unknown"}</strong>
                    </div>
                    <div className="sim-inspector-card">
                      <span>Ports</span>
                      <strong>{opticalSummary.ports?.join(", ") ?? "—"}</strong>
                    </div>
                    <div className="sim-inspector-card">
                      <span>Route</span>
                      <strong>
                        {opticalSummary.input_port ?? "?"} → {opticalSummary.through_port ?? "?"}
                        {opticalSummary.cross_port ? ` / ${opticalSummary.cross_port}` : ""}
                      </strong>
                    </div>
                  </div>
                )}

                {centerInfo && (
                  <div className="sim-inspector-grid">
                    <div className="sim-inspector-card">
                      <span>Center λ</span>
                      <strong>{centerInfo.wavelength_um != null ? `${formatDisplayValue(centerInfo.wavelength_um)} um` : "—"}</strong>
                    </div>
                    <div className="sim-inspector-card">
                      <span>n_eff</span>
                      <strong>{centerInfo.neff != null ? formatDisplayValue(centerInfo.neff) : "—"}</strong>
                    </div>
                    <div className="sim-inspector-card">
                      <span>n_g / loss</span>
                      <strong>
                        {centerInfo.ng != null ? formatDisplayValue(centerInfo.ng) : "—"}
                        {centerInfo.loss_db_per_m != null ? ` / ${formatDisplayValue(centerInfo.loss_db_per_m)} dB/m` : ""}
                      </strong>
                    </div>
                  </div>
                )}

                {spectralSummary && (
                  <div className="sim-inspector-grid">
                    <div className="sim-inspector-card">
                      <span>Engine</span>
                      <strong>{spectralSummary.engine ?? "—"}</strong>
                    </div>
                    <div className="sim-inspector-card">
                      <span>Output Ports</span>
                      <strong>{spectralSummary.output_ports?.join(", ") ?? "—"}</strong>
                    </div>
                    <div className="sim-inspector-card">
                      <span>FSR</span>
                      <strong>
                        {spectralSummary.fsr
                          ? Object.entries(spectralSummary.fsr).map(([port, fsr]) => `${port}:${formatDisplayValue(fsr)}`).join(" · ")
                          : "—"}
                      </strong>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Compact sim params */}
            {out.simulation_request && (() => {
              const entries = Object.entries(out.simulation_request).filter(
                ([k, v]) => !SKIP_PARAM_KEYS.has(k) && !SKIP_PARAM_VALUES.has(v as string | null | undefined)
              );
              return entries.length > 0 ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 10px", marginTop: 6 }}>
                  {entries.map(([k, v]) => (
                    <span key={k} style={{ fontSize: 15, color: "var(--text-muted)" }}>
                      {k}: <span style={{ color: "var(--text)", fontFamily: "monospace" }}>{formatParamValue(v)}</span>
                    </span>
                  ))}
                </div>
              ) : null;
            })()}

            {/* Validation warnings */}
            {validationWarnings.length ? (
              <div className="sim-warning-block">
                <div className="sim-section-title">Validation Warnings</div>
                {validationWarnings.map((warning, idx) => (
                  <div key={`${warning.code ?? "warn"}-${idx}`} className="sim-warning-item">
                    <strong>{warning.code ?? "WARN"}</strong>
                    <span>{warning.message ?? "Unknown warning"}</span>
                  </div>
                ))}
              </div>
            ) : null}


            {out.component_evaluation && (
              <ComponentEvaluationCard evaluation={out.component_evaluation} />
            )}

            {Array.isArray(out.optimize_history) && (() => {
              const hist = out.optimize_history as Array<{
                iter: number;
                params: Record<string, unknown>;
                judge:  { verdict?: string; score?: number; checks?: Record<string, unknown> };
                review: { llm_verdict?: string; llm_score?: number };
                decide: { strategy?: string; confidence?: number; invariant_ok?: boolean };
                bo?: {
                  acquisition?: string | null;
                  acquisition_value?: number | null;
                  predicted_mean?: number | null;
                  predicted_std?: number | null;
                  n_observations?: number | null;
                  candidate_power_couplings?: number[] | null;
                  best_so_far?: { x?: number[]; y?: number } | null;
                } | null;
                timing_ms: { replay: number; review: number; decide: number; bo?: number | null };
                tokens:    { review: { prompt: number | null; completion: number | null }; decide: { prompt: number | null; completion: number | null } };
              }>;
              const status = (out.status as string) ?? "running";
              // aggregates
              const sum = (f: (h: typeof hist[number]) => number) => hist.reduce((a, h) => a + f(h), 0);
              const totalReplayMs = sum(h => h.timing_ms.replay);
              const totalReviewMs = sum(h => h.timing_ms.review);
              const totalDecideMs = sum(h => h.timing_ms.decide);
              const totalReviewTok  = sum(h => (h.tokens.review.prompt ?? 0) + (h.tokens.review.completion ?? 0));
              const totalDecideTok  = sum(h => (h.tokens.decide.prompt ?? 0) + (h.tokens.decide.completion ?? 0));
              const statusColor =
                status === "converged" ? { bg: "#dcfce7", fg: "#14532d", border: "#86efac" }
              : status === "running"   ? { bg: "#dbeafe", fg: "#1e3a8a", border: "#93c5fd" }
              : status === "diverged" || status === "abort" ? { bg: "#fee2e2", fg: "#7f1d1d", border: "#fca5a5" }
              : status === "budget"    ? { bg: "#fef3c7", fg: "#713f12", border: "#fde047" }
              :                          { bg: "#f3f4f6", fg: "#374151", border: "#d1d5db" };
              return (
                <div style={{
                  marginTop: 10, padding: "8px 10px", borderRadius: 6,
                  background: statusColor.bg, border: `1px solid ${statusColor.border}`, color: statusColor.fg, fontSize: 11,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 11, letterSpacing: "0.04em" }}>🤖 AUTO-OPTIMIZE LOOP</strong>
                    <span style={{ padding: "1px 6px", borderRadius: 3, fontWeight: 700,
                      background: statusColor.fg, color: statusColor.bg, fontSize: 10 }}>
                      {status.toUpperCase()}
                    </span>
                    <span style={{ fontFamily: "monospace", fontSize: 10, opacity: 0.75 }}>
                      {hist.length} iter · {((totalReplayMs + totalReviewMs + totalDecideMs) / 1000).toFixed(1)}s total · {(totalReviewTok + totalDecideTok)} LLM tokens
                    </span>
                  </div>
                  {/* Progress/status line — also shows when history is still empty (iter 1 in flight). */}
                  {msg.text && (
                    <div style={{ fontSize: 11, marginBottom: 6, fontStyle: "italic", opacity: 0.85 }}>{msg.text}</div>
                  )}
                  {hist.length === 0 && status === "running" && (
                    <div style={{ fontSize: 10, opacity: 0.7 }}>
                      Waiting for iter 1 result… (replay ~4 s → review ~20 s → decide ~10 s, total ~35 s per iter)
                    </div>
                  )}
                  {hist.length > 0 && (() => {
                    const latest = hist[hist.length - 1];
                    const checks = (latest.judge.checks ?? {}) as Record<string, Record<string, unknown>>;
                    const c3db = checks.center_3db_bandwidth ?? {};
                    const fsrM = checks.fsr_measured_enough ?? {};
                    const cx   = checks.crosstalk ?? {};
                    const p = latest.params as Record<string, unknown>;
                    const fmtArr = (v: unknown, d = 0) =>
                      Array.isArray(v) ? `[${(v as unknown[]).map(x => Number(x).toFixed(d)).join(",")}]` : null;
                    const fmtNum = (v: unknown, d = 4) =>
                      (typeof v === "number" && Number.isFinite(v)) ? v.toFixed(d) : "—";
                    const seedBits: string[] = [];
                    const dl = fmtArr(p.delay_lengths_um, 0);  if (dl) seedBits.push(`Δ=${dl}`);
                    const pc = fmtArr(p.power_couplings, 2);   if (pc) seedBits.push(`κ=${pc}`);
                    if (typeof p.fsr === "number") seedBits.push(`fsr=${(p.fsr as number).toFixed(3)}`);
                    const cards = [
                      { label: "1. seed (latest input)", value: seedBits.join(" · ") || "—", mono: true },
                      { label: "2. center λ",            value: `${fmtNum(c3db.center_wavelength_um)} µm` },
                      { label: "3. 3dB BW @ center",     value: `${fmtNum(c3db.measured_3db_bw_um)} µm` },
                      { label: "4. FSR (measured)",      value: `${fmtNum(fsrM.measured_fsr_um)} µm` },
                      { label: "5. worst crosstalk",     value: `${fmtNum(cx.worst_crosstalk_db, 1)} dB` },
                    ];
                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: "2.2fr 1fr 1fr 1fr 1fr",
                        gap: 4, margin: "4px 0 8px",
                      }}>
                        {cards.map(c => (
                          <div key={c.label} style={{
                            padding: "4px 6px", borderRadius: 3,
                            background: "rgba(255,255,255,0.55)",
                            border: `1px solid ${statusColor.border}`,
                          }}>
                            <div style={{ fontSize: 9, opacity: 0.7, letterSpacing: "0.04em" }}>{c.label}</div>
                            <div style={{ fontFamily: "monospace", fontSize: 10, fontWeight: 600, wordBreak: "break-all" }}>
                              {c.value}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  {hist.length > 0 && (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", fontSize: 10, fontFamily: "monospace", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid " + statusColor.border, textAlign: "left" }}>
                          <th style={{ padding: "2px 6px" }}>iter</th>
                          <th style={{ padding: "2px 6px" }}>judge</th>
                          <th style={{ padding: "2px 6px" }}>review</th>
                          <th style={{ padding: "2px 6px" }}>strategy</th>
                          <th style={{ padding: "2px 6px" }}>BO acq · GP μ±σ</th>
                          <th style={{ padding: "2px 6px" }}>replay ms</th>
                          <th style={{ padding: "2px 6px" }}>review ms / tok</th>
                          <th style={{ padding: "2px 6px" }}>decide ms / tok</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hist.map((h) => {
                          const revTok = (h.tokens.review.prompt ?? 0) + (h.tokens.review.completion ?? 0);
                          const decTok = (h.tokens.decide.prompt ?? 0) + (h.tokens.decide.completion ?? 0);
                          const jScore = h.judge.score != null ? h.judge.score.toFixed(2) : "?";
                          const rScore = h.review.llm_score != null ? h.review.llm_score.toFixed(2) : "?";
                          const bo = h.bo;
                          const fmt = (v: number | null | undefined, d: number) =>
                            (typeof v === "number" && Number.isFinite(v)) ? v.toFixed(d) : "—";
                          const boCell = bo
                            ? `${(bo.acquisition ?? "?").toUpperCase()} ${fmt(bo.acquisition_value, 3)} · ${fmt(bo.predicted_mean, 3)}±${fmt(bo.predicted_std, 3)}`
                            : "—";
                          return (
                            <tr key={h.iter} style={{ borderBottom: "1px dotted " + statusColor.border }}>
                              <td style={{ padding: "2px 6px" }}>{h.iter}</td>
                              <td style={{ padding: "2px 6px" }}>{h.judge.verdict}·{jScore}</td>
                              <td style={{ padding: "2px 6px" }}>{h.review.llm_verdict ?? "?"}·{rScore}</td>
                              <td style={{ padding: "2px 6px" }}>
                                {h.decide.strategy ?? "?"}
                                {h.decide.invariant_ok === false && <span style={{ color: "#dc2626" }}> ⚠</span>}
                              </td>
                              <td style={{ padding: "2px 6px", whiteSpace: "nowrap" }}
                                  title={bo && bo.candidate_power_couplings ? `cand pc=${JSON.stringify(bo.candidate_power_couplings)}` : ""}>
                                {boCell}
                              </td>
                              <td style={{ padding: "2px 6px" }}>{h.timing_ms.replay}</td>
                              <td style={{ padding: "2px 6px" }}>{h.timing_ms.review} / {revTok}</td>
                              <td style={{ padding: "2px 6px" }}>{h.timing_ms.decide} / {decTok}</td>
                            </tr>
                          );
                        })}
                        <tr style={{ fontWeight: 700, borderTop: "2px solid " + statusColor.border }}>
                          <td style={{ padding: "4px 6px" }}>Σ</td>
                          <td colSpan={4} style={{ padding: "4px 6px" }}></td>
                          <td style={{ padding: "4px 6px" }}>{totalReplayMs}</td>
                          <td style={{ padding: "4px 6px" }}>{totalReviewMs} / {totalReviewTok}</td>
                          <td style={{ padding: "4px 6px" }}>{totalDecideMs} / {totalDecideTok}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  )}
                </div>
              );
            })()}

            {out.evaluation && typeof out.evaluation === "object" && (() => {
              const ev = out.evaluation as Record<string, unknown>;
              const verdict = String(ev.verdict ?? "").toLowerCase();
              const score = typeof ev.score === "number" ? ev.score : null;
              const checks = (ev.checks ?? {}) as Record<string, { pass?: boolean } & Record<string, unknown>>;
              const suggestions = Array.isArray(ev.suggestions)
                ? (ev.suggestions as unknown[]).filter(x => typeof x === "string") as string[]
                : [];
              const color =
                verdict === "pass" ? { bg: "#dcfce7", fg: "#14532d", border: "#86efac" }
              : verdict === "fail" ? { bg: "#fee2e2", fg: "#7f1d1d", border: "#fca5a5" }
              :                       { bg: "#f3f4f6", fg: "#374151", border: "#d1d5db" };
              return (
                <div style={{
                  marginTop: 10, padding: "8px 10px", borderRadius: 6,
                  background: color.bg, border: `1px solid ${color.border}`, color: color.fg, fontSize: 12,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <strong style={{ fontSize: 11, letterSpacing: "0.04em" }}>⚖ JUDGE (Tier-1 rule-based)</strong>
                    <span style={{
                      padding: "1px 6px", borderRadius: 3, fontWeight: 700,
                      background: color.fg, color: color.bg, fontSize: 10,
                    }}>
                      {verdict.toUpperCase() || "?"}
                    </span>
                    {score != null && (
                      <span style={{ fontFamily: "monospace", fontSize: 11, opacity: 0.8 }}>
                        {Math.round(score * 4)}/4 ({(score * 100).toFixed(0)}%)
                      </span>
                    )}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 11 }}>
                    {Object.entries(checks).map(([name, c]) => {
                      const ok = c && typeof c.pass === "boolean" && c.pass;
                      const detail = (() => {
                        if (name === "fsr_requested_enough")
                          return `req=${c?.requested_fsr_um} min=${c?.required_min_fsr_um}`;
                        if (name === "fsr_measured_enough")
                          return `meas=${(c?.measured_fsr_um as number | null)?.toFixed?.(4) ?? "n/a"}`;
                        if (name === "center_3db_bandwidth")
                          return `bw=${(c?.measured_3db_bw_um as number | null)?.toFixed?.(4) ?? "n/a"} req=${c?.required_3db_bw_um}`;
                        if (name === "crosstalk")
                          return `worst=${(c?.worst_crosstalk_db as number | null)?.toFixed?.(1) ?? "n/a"} dB`;
                        return "";
                      })();
                      return (
                        <div key={name} style={{ display: "flex", gap: 4, alignItems: "baseline" }}>
                          <span style={{ color: ok ? "#059669" : "#dc2626", fontWeight: 700, minWidth: 10 }}>
                            {ok ? "✓" : "✗"}
                          </span>
                          <span style={{ fontFamily: "monospace", fontSize: 10, opacity: 0.9 }}>{name}</span>
                          <span style={{ fontSize: 10, opacity: 0.6 }}>{detail}</span>
                        </div>
                      );
                    })}
                  </div>
                  {suggestions.length > 0 && (
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 11 }}>
                      {suggestions.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  )}
                </div>
              );
            })()}

            {out.llm_review && (() => {
              const r = out.llm_review as Record<string, unknown>;
              const verdict = String(r.llm_verdict ?? "").toLowerCase();
              const score = typeof r.llm_score === "number" ? r.llm_score : null;
              const reasoning = typeof r.llm_reasoning === "string" ? r.llm_reasoning : "";
              const suggestions = Array.isArray(r.improvement_suggestions)
                ? (r.improvement_suggestions as unknown[]).filter(x => typeof x === "string") as string[]
                : [];
              const verdictColor =
                verdict === "pass"    ? { bg: "#dcfce7", fg: "#14532d", border: "#86efac" }
              : verdict === "partial" ? { bg: "#fef9c3", fg: "#713f12", border: "#fde047" }
              : verdict === "fail"    ? { bg: "#fee2e2", fg: "#7f1d1d", border: "#fca5a5" }
              :                          { bg: "#f3f4f6", fg: "#374151", border: "#d1d5db" };
              return (
                <div style={{
                  marginTop: 10, padding: "8px 10px", borderRadius: 6,
                  background: verdictColor.bg, border: `1px solid ${verdictColor.border}`,
                  color: verdictColor.fg, fontSize: 12,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <strong style={{ fontSize: 11, letterSpacing: "0.04em" }}>🤖 LLM REVIEW</strong>
                    <span style={{
                      padding: "1px 6px", borderRadius: 3, fontWeight: 700,
                      background: verdictColor.fg, color: verdictColor.bg, fontSize: 10,
                    }}>
                      {verdict.toUpperCase() || "?"}
                    </span>
                    {score != null && (
                      <span style={{ fontFamily: "monospace", fontSize: 11, opacity: 0.8 }}>
                        score: {score.toFixed(2)}
                      </span>
                    )}
                  </div>
                  {reasoning && <div style={{ lineHeight: 1.5 }}>{reasoning}</div>}
                  {suggestions.length > 0 && (
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 11 }}>
                      {suggestions.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  )}
                </div>
              );
            })()}

            {(() => {
              const netlistPath = (typeof out.netlist_json_path === "string" ? out.netlist_json_path : null)
                ?? (typeof out.files?.netlist_json_path === "string" ? out.files.netlist_json_path : null);
              const tag = String(out.component_evaluation?.semantic_tag ?? out.llm_summary?.semantic_tag ?? "").toUpperCase();
              const pathLooksMzi = netlistPath ? /mzi|wdm/i.test(netlistPath) : false;
              const replayable = netlistPath && (/MZI|WDM/.test(tag) || pathLooksMzi || out.replay_mode === true);
              // Seed wdm_type gates which replay presets are API-overridable.
              const wdmTypeRaw =
                (out as any)?.netlist?.wdm_meta?.wdm_type
                ?? (out as any)?.llm_summary?.netlist?.wdm_meta?.wdm_type
                ?? (out as any)?.wdm_meta?.wdm_type
                ?? (out as any)?.params_used?.wdm_type
                ?? null;
              const seedWdmType = typeof wdmTypeRaw === "string" ? wdmTypeRaw : null;
              // Extract current seed state from params_used so relative presets +
              // manual field placeholders reflect the LATEST netlist, not a stale one.
              const pu = (out as any)?.params_used ?? {};
              const numOrNull = (v: unknown): number | null => {
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
              };
              const arrOrNull = (v: unknown): number[] | null => {
                if (!Array.isArray(v)) return null;
                const nums = v.map((x) => Number(x)).filter((x) => Number.isFinite(x));
                return nums.length === v.length ? nums : null;
              };
              // Mux4Configurable: surface per-stage seed values from the stages
              // array so the lattice presets can pre-fill stage1/stage2 textboxes
              // in TOP view. params_used carries them as power_couplings_stage1
              // / delay_lengths_stage1 etc directly.
              const stage1Delays = arrOrNull(pu.delay_lengths_stage1)
                ?? (() => {
                  const stagesArr = Array.isArray((out as any)?.stages) ? (out as any).stages : [];
                  const s1 = stagesArr.find((s: Record<string, unknown>) => s?.stage_id === "stage_1");
                  return arrOrNull(s1?.delay_lengths_um);
                })();
              const stage2Delays = arrOrNull(pu.delay_lengths_stage2_down ?? pu.delay_lengths_stage2)
                ?? (() => {
                  const stagesArr = Array.isArray((out as any)?.stages) ? (out as any).stages : [];
                  const s2 = stagesArr.find((s: Record<string, unknown>) => s?.stage_id === "stage_2_down");
                  return arrOrNull(s2?.delay_lengths_um);
                })();
              const stage1Coup = arrOrNull(pu.power_couplings_stage1)
                ?? (() => {
                  const stagesArr = Array.isArray((out as any)?.stages) ? (out as any).stages : [];
                  const s1 = stagesArr.find((s: Record<string, unknown>) => s?.stage_id === "stage_1");
                  return arrOrNull(s1?.power_couplings);
                })();
              const stage2Coup = arrOrNull(pu.power_couplings_stage2_down ?? pu.power_couplings_stage2)
                ?? (() => {
                  const stagesArr = Array.isArray((out as any)?.stages) ? (out as any).stages : [];
                  const s2 = stagesArr.find((s: Record<string, unknown>) => s?.stage_id === "stage_2_down");
                  return arrOrNull(s2?.power_couplings);
                })();
              const seedMeta: SeedMeta = {
                wdm_type: seedWdmType,
                fsr_um: numOrNull(pu.fsr ?? pu.fsr_um),
                fsr_nm: numOrNull(pu.fsr_nm),
                center_wavelength_um: numOrNull(pu.center_wavelength_um ?? pu.center_wavelength),
                bend_radius: numOrNull(pu.bend_radius ?? pu.bend_radius_um),
                delay_lengths_um: arrOrNull(pu.delay_lengths_um ?? pu.delay_lengths),
                power_couplings: arrOrNull(pu.power_couplings),
                dc_type: typeof pu.dc_type === "string" ? pu.dc_type : null,
                wl_start_um: numOrNull(pu.wl_start_um ?? pu.start_um),
                wl_stop_um: numOrNull(pu.wl_stop_um ?? pu.stop_um),
                n_points: numOrNull(pu.n_points),
                spacing_x: numOrNull(pu.spacing_x),
                spacing_y: numOrNull(pu.spacing_y),
                delay_lengths_stage1: stage1Delays,
                delay_lengths_stage2: stage2Delays,
                power_couplings_stage1: stage1Coup,
                power_couplings_stage2: stage2Coup,
              };
              // Mux4Configurable response carries stages[] + stage1_thresholds.
              // When present, route through Mux4StagedReplayWrapper so the user
              // can pick a stage (top/stage1/stage2) and the panel below
              // operates on that stage's netlist.
              const stagesRaw = (out as any)?.stages;
              const stages: Mux4StageRecord[] | null =
                Array.isArray(stagesRaw) && stagesRaw.length > 0 ? (stagesRaw as Mux4StageRecord[]) : null;
              const stage1Thresholds = (out as any)?.stage1_thresholds ?? null;
              // Mux4-top derived review baseline (added 2026-05-01) — judge
              // grades against this; stage_1 is informational.
              const reviewThresholds = (out as any)?.review_thresholds ?? null;
              if (!replayable) return null;
              if (stages) {
                return (
                  <Mux4StagedReplayWrapper
                    topNetlistPath={netlistPath!}
                    topSeedMeta={seedMeta}
                    stages={stages}
                    stage1Thresholds={stage1Thresholds}
                    reviewThresholds={reviewThresholds}
                    busy={loading}
                    onReplay={sendReplay}
                    onOptimize={sendOptimizeLoop}
                    seedWdmType={seedWdmType}
                  />
                );
              }
              return (
                <ReplayPanel
                  netlistPath={netlistPath!}
                  busy={loading}
                  onReplay={sendReplay}
                  onOptimize={sendOptimizeLoop}
                  seedWdmType={seedWdmType}
                  seedMeta={seedMeta}
                />
              );
            })()}

            {(out.llm_summary?.explanation || out.explanation) && (
              <div className="sim-explanation">
                <div className="sim-section-title">Interpretation</div>
                <div>{out.llm_summary?.explanation ?? out.explanation}</div>
              </div>
            )}

            {/* 🔍 Inspect raw spectrum — diagnostic dump of SpectrumAnalyzer output.
                Shows quick-summary (peaks count / FSR / IL / XT range) + slimmed JSON. */}
            {(() => {
              const spec = (out.spectral_feature ?? out.spectrum) as Record<string, unknown> | undefined;
              if (!spec || typeof spec !== "object") return null;
              const expanded = expandedSpectrumIds.has(msg.id);
              return (
                <div style={{ marginTop: 8, fontSize: 11 }}>
                  <button
                    type="button"
                    onClick={() => toggleSpectrumInspect(msg.id)}
                    style={{
                      padding: "3px 8px", fontSize: 11,
                      background: expanded ? "#fef3c7" : "#fff",
                      color: "#92400e",
                      border: "1px solid #fcd34d", borderRadius: 4, cursor: "pointer",
                    }}
                  >
                    {expanded ? "▾" : "▸"} 🔍 Inspect raw spectrum
                  </button>
                  {expanded && (() => {
                    const peaks = spec.peaks as Record<string, unknown[]> | undefined;
                    const fsr = spec.fsr as Record<string, number> | undefined;
                    const cb = spec.cutoff_passbands as Record<string, unknown[]> | undefined;
                    const minIl = spec.min_insertion_losses_db as Record<string, number> | undefined;
                    const maxIl = spec.max_insertion_losses_db as Record<string, number> | undefined;
                    const nearXt = spec.near_crosstalk_db as Record<string, number> | undefined;
                    const farXt = spec.far_crosstalk_db as Record<string, number> | undefined;
                    const warns = (spec.warnings as string[]) ?? [];
                    const peakSummary = peaks && typeof peaks === "object"
                      ? Object.entries(peaks).map(([p, v]) => `${p}:${Array.isArray(v) ? v.length : "?"}`).join(", ")
                      : "—";
                    const summaryRow = (label: string, value: string) => (
                      <div style={{ display: "flex", gap: 8, padding: "2px 0", borderBottom: "1px dotted #fde68a" }}>
                        <span style={{ width: 130, color: "#78716c", fontFamily: "monospace" }}>{label}</span>
                        <span style={{ fontFamily: "monospace", color: "#451a03", flex: 1, wordBreak: "break-all" }}>{value}</span>
                      </div>
                    );
                    return (
                      <div style={{ marginTop: 6, padding: 8, background: "#fffbeb",
                        border: "1px solid #fcd34d", borderRadius: 4, fontSize: 11 }}>
                        <div style={{ fontWeight: 700, color: "#92400e", letterSpacing: "0.04em", fontSize: 10 }}>
                          QUICK SUMMARY
                        </div>
                        {summaryRow("engine",         String(spec.engine ?? "—"))}
                        {summaryRow("input_port",     String(spec.input_port ?? "—"))}
                        {summaryRow("output_ports",   JSON.stringify(spec.output_ports ?? "—"))}
                        {summaryRow("peaks count",    peakSummary)}
                        {summaryRow("FSR per port",   fsr ? JSON.stringify(fsr) : "∅ none")}
                        {summaryRow("cutoff bands",   cb ? Object.entries(cb).map(([p, v]) => `${p}:${Array.isArray(v) ? v.length : "?"}`).join(", ") : "∅")}
                        {summaryRow("min IL (dB)",    minIl ? JSON.stringify(minIl) : "—")}
                        {summaryRow("max IL (dB)",    maxIl ? JSON.stringify(maxIl) : "—")}
                        {summaryRow("near XT (dB)",   nearXt ? JSON.stringify(nearXt) : "—")}
                        {summaryRow("far XT (dB)",    farXt ? JSON.stringify(farXt) : "—")}
                        {warns.length > 0 && (
                          <div style={{ marginTop: 4, padding: 4, background: "#fef2f2", borderRadius: 3 }}>
                            <strong style={{ color: "#991b1b", fontSize: 10 }}>⚠ {warns.length} warning(s)</strong>
                            <ul style={{ margin: "2px 0 0 16px", padding: 0, fontSize: 10, color: "#7f1d1d" }}>
                              {warns.slice(0, 5).map((w, i) => <li key={i}>{w}</li>)}
                            </ul>
                          </div>
                        )}
                        <details style={{ marginTop: 6 }}>
                          <summary style={{ cursor: "pointer", fontSize: 10, color: "#78716c", letterSpacing: "0.04em", fontWeight: 700 }}>
                            RAW JSON (slimmed)
                          </summary>
                          <pre style={{
                            margin: "4px 0 0", padding: 6, fontSize: 10, lineHeight: 1.4,
                            background: "#fafaf9", border: "1px solid #e7e5e4", borderRadius: 3,
                            maxHeight: 320, overflow: "auto", color: "#451a03",
                          }}>
                            {JSON.stringify(slimSpectrumForInspect(spec), null, 2)}
                          </pre>
                        </details>
                      </div>
                    );
                  })()}
                </div>
              );
            })()}

            {/* File downloads */}
            {(gdsFile || snpFile) && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
                {gdsFile && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={fileRowLabelStyle}>Layout GDS</span>
                    <a href={`/api/results/${encodeURIComponent(gdsFile)}`} download
                      style={fileLinkStyle}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                      {gdsFile}
                    </a>
                  </div>
                )}
                {snpFile && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={fileRowLabelStyle}>Spectrum sNp</span>
                    <a href={`/api/results/${encodeURIComponent(snpFile)}`} download
                      style={{ ...fileLinkStyle, borderColor: "rgba(155,111,255,0.3)", color: "#a880ff" }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                      {snpFile}
                    </a>
                    <button onClick={() => loadSnpFile(snpFile)} style={viewBtnStyle}>
                      ◈ View
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ── Recommend ── */}
        {mode === "recommend" && (
          <>
            <div className="label">{r.data?.message ?? "建議輸入句 / Suggested query"}</div>
            {r.data?.suggested_query && (
              <div className="suggested-query" title="點擊使用此輸入句 / Click to use this query"
                onClick={() => send(r.data.suggested_query)}
                style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, wordBreak: "break-word" }}>{r.data.suggested_query}</span>
                <button
                  type="button"
                  title="複製到輸入框 / Copy to input (edit before submit)"
                  onClick={(e) => {
                    e.stopPropagation();
                    setInput(r.data.suggested_query ?? "");
                    inputRef.current?.focus();
                  }}
                  style={{
                    flexShrink: 0,
                    padding: "2px 8px",
                    fontSize: 12,
                    background: "rgba(255,255,255,0.8)",
                    border: "1px solid var(--accent)",
                    borderRadius: 4,
                    color: "var(--accent)",
                    cursor: "pointer",
                    lineHeight: 1.4,
                  }}
                >
                  → 輸入框 / Input
                </button>
              </div>
            )}
            <div className="label" style={{ marginTop: 4 }}>
              來源 / Source: {r.data?.source ?? "—"}
              {r.data?.recommendations ? `  ·  ${(r.data.recommendations as unknown[]).length} 筆記錄 / records` : ""}
            </div>
          </>
        )}

        {/* ── General fallback (no sim, no case hit) ── */}
        {(mode === "general" || mode === "document" || (mode === "case_lookup" && !out?.success && (r.data as Record<string,unknown>)?.mode !== "case_hit")) && (
          <div className="value" style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{(r.data as Record<string,unknown>)?.answer as string ?? r.classification?.reason ?? mode}</div>
        )}

        {/* ── Design case (from RAG top match) ── */}
        {(() => {
          const dc = (r.data as Record<string, unknown>)?.design_case as {
            semantic_tag?: string | null;
            cell_name?: string | null;
            explanation?: string | null;
            optical_function?: string | null;
          } | null | undefined;
          if (!dc || (!dc.explanation && !dc.optical_function && !dc.cell_name)) return null;
          return (
            <div style={{ marginTop: 12, padding: "10px 12px", borderLeft: "3px solid var(--accent)", background: "rgba(0,0,0,0.03)", borderRadius: 4 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--accent)", marginBottom: 4 }}>
                設計案例 / Design case · {dc.semantic_tag ?? "—"}{dc.cell_name ? ` / ${dc.cell_name}` : ""}
              </div>
              {dc.optical_function && (
                <div style={{ fontSize: 13, color: "#0891b2", marginBottom: 4 }}>{dc.optical_function}</div>
              )}
              {dc.explanation && (
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{dc.explanation}</div>
              )}
            </div>
          );
        })()}

        {/* ── Suggested command (document/general mode) ── */}
        {(mode === "document" || mode === "general") && typeof (r.data as Record<string, unknown>)?.suggested_query === "string" && (
          <>
            <div className="label" style={{ marginTop: 10 }}>建議指令（點擊送出）/ Suggested command (click to send)</div>
            <div
              className="suggested-query"
              title="點擊使用此輸入句 / Click to use this query"
              onClick={() => send((r.data as Record<string, unknown>).suggested_query as string)}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <span style={{ flex: 1, wordBreak: "break-word" }}>
                {(r.data as Record<string, unknown>).suggested_query as string}
              </span>
              <button
                type="button"
                title="複製到輸入框（可編輯後再送出）"
                onClick={(e) => {
                  e.stopPropagation();
                  setInput((r.data as Record<string, unknown>).suggested_query as string);
                  inputRef.current?.focus();
                }}
                style={{
                  flexShrink: 0,
                  padding: "2px 8px",
                  fontSize: 12,
                  background: "rgba(255,255,255,0.8)",
                  border: "1px solid var(--accent)",
                  borderRadius: 4,
                  color: "var(--accent)",
                  cursor: "pointer",
                  lineHeight: 1.4,
                }}
              >
                → 輸入框
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Bottom panel content ────────────────────────────────────────────────────

  function renderSimPanel() {
    const spectrumPngFile = findSpectrumPngFilename(lastSimOut);

    if (snpLoading) {
      return (
        <div className="sparam-placeholder">
          <span className="spinning">⟳</span> 載入頻譜 / Loading spectrum…
        </div>
      );
    }

    // Priority 1 — SNP file loaded (multi-port, full S-matrix)
    if (snpData && snpFilename) {
      const showPrev = !!prevSpectrumPng && prevSpectrumPng !== spectrumPngFile;
      return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          {/* Header — sNp file + Open HTML link (no inline iframe; user opens viewer in new tab). */}
          <div style={{
            padding: "6px 12px", borderBottom: "1px solid var(--border)",
            display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
            background: "#f5f8fe",
          }}>
            <span style={{ fontSize: 14, color: "var(--text-muted)", letterSpacing: "0.04em" }}>
              sNp · {snpData.nPorts}P · {snpData.wavelengths_nm.length} pts
            </span>
            <span style={{ fontSize: 13, color: "var(--text-muted)", fontFamily: "monospace" }}>{snpFilename}</span>
            {seedSnpFilename && seedSnpFilename !== snpFilename && (
              <span
                style={{
                  fontSize: 11, padding: "2px 8px", borderRadius: 4,
                  background: "#fef3c7", color: "#a16207",
                  border: "1px solid #fcd34d",
                  fontFamily: "monospace", display: "inline-flex", alignItems: "center", gap: 6,
                }}
                title={`Seed (baseline): ${seedSnpFilename}`}
              >
                seed: {seedSnpFilename.length > 28 ? seedSnpFilename.slice(0, 12) + "…" + seedSnpFilename.slice(-12) : seedSnpFilename}
                <button
                  type="button"
                  onClick={() => { setSeedSnpFilename(null); setSeedCenterUm(null); }}
                  style={{
                    border: "none", background: "transparent", cursor: "pointer",
                    color: "#a16207", padding: 0, lineHeight: 1, fontSize: 13,
                  }}
                  title="Clear seed (no comparison)"
                  aria-label="Clear seed"
                >×</button>
              </span>
            )}
            {showPrev && (
              <span style={{ fontSize: 11, marginLeft: "auto", color: "#a8a29e" }}>
                Previous · Current
              </span>
            )}
            <a
              href={(() => {
                // Build /spectrum/<file> URL with optional query params:
                //   ?seed=<seed_filename>   → load seed sNp for trace overlay
                //   ?center=<nm>            → black vertical line at LATEST design center
                //   ?seed_center=<nm>       → gray vertical line at SEED design center
                // All four are wavelengths in nm, sourced from the µm fields on
                // simOut / iter-1 params and converted here (µm × 1000 = nm).
                const params = new URLSearchParams();
                if (seedSnpFilename && seedSnpFilename !== snpFilename) {
                  params.set("seed", seedSnpFilename);
                }
                const centerUm = lastSimOut?.center_result?.center_wavelength_um;
                if (typeof centerUm === "number" && Number.isFinite(centerUm) && centerUm > 0) {
                  params.set("center", String(Math.round(centerUm * 10000) / 10));
                }
                if (typeof seedCenterUm === "number" && Number.isFinite(seedCenterUm) && seedCenterUm > 0) {
                  // Only meaningful when seed is set AND seed center actually
                  // differs from current — otherwise the two lines overlap and
                  // the gray one is hidden behind black. Send anyway; the
                  // viewer just renders both, overlapping is not a bug.
                  params.set("seed_center", String(Math.round(seedCenterUm * 10000) / 10));
                }
                const qs = params.toString();
                const base = `/spectrum/${encodeURIComponent(snpFilename)}`;
                return qs ? `${base}?${qs}` : base;
              })()}
              target="_blank"
              rel="noreferrer"
              style={{ ...viewBtnStyle, textDecoration: "none", marginLeft: showPrev ? 8 : "auto" }}
            >
              {seedSnpFilename && seedSnpFilename !== snpFilename ? "Open HTML (compare)" : "Open HTML"}
            </a>
          </div>
          {/* Body — Saved Spectrum PNG, optionally split Previous | Current. */}
          {!spectrumPngFile && !showPrev && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, color: "var(--text-muted)" }}>
              No spectrum PNG produced for this run.
            </div>
          )}
          {(spectrumPngFile || showPrev) && (
            <div ref={sparamSplitRef} style={{
              flex: 1, minHeight: 0, display: "flex", flexDirection: "row",
              alignItems: "stretch", overflow: "hidden",
            }}>
              {showPrev && (
                <SpectrumPngSlot
                  pngBasename={prevSpectrumPng}
                  title="Previous"
                  isPrev={true}
                  flexBasis={spectrumPngFile ? `${spectrumSplitPct}%` : "100%"}
                  zoom={prevSpectrumPngZoom}
                  onZoomChange={setPrevSpectrumPngZoom}
                  onClose={() => { setPrevSpectrumPng(null); setPrevSpectrumPngZoom(1); }}
                />
              )}
              {showPrev && spectrumPngFile && (
                <div
                  style={{ width: 4, background: "#e5e7eb", cursor: "col-resize", flex: "0 0 auto" }}
                  onMouseDown={onSparamSplitMouseDown}
                  title="Drag to resize"
                />
              )}
              {spectrumPngFile && (
                <SpectrumPngSlot
                  pngBasename={spectrumPngFile}
                  title={showPrev ? "Current" : null}
                  isPrev={false}
                  flexBasis={showPrev ? `${100 - spectrumSplitPct}%` : "100%"}
                  zoom={spectrumPngZoom}
                  onZoomChange={setSpectrumPngZoom}
                />
              )}
            </div>
          )}
        </div>
      );
    }

    // Priority 2 — inline s21_trace from API response (no file needed)
    const s21 = lastSimOut?.spectral_feature?.s21_trace;
    if (s21 && s21.wavelength_um.length > 0) {
      return <SParamPlot s21={s21} />;
    }

    return (
      <div className="sparam-placeholder">
        S 參數頻域輸出將顯示於此 / S-parameter frequency-domain output will appear here<br />
        <span style={{ fontSize: 16 }}>（模擬完成後自動載入）/ (auto-loaded after simulation)</span>
      </div>
    );
  }

  // ── JSX ─────────────────────────────────────────────────────────────────────

  return (
    <div className="app-root">

      {/* ── Header ── */}
      {headerCollapsed ? (
        <div style={{
          height: 22, background: "#ffffff", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          padding: "0 12px", position: "relative", zIndex: 10,
          boxShadow: "0 1px 4px rgba(37, 99, 235, 0.06)",
        }}>
          <button
            type="button"
            onClick={() => setHeaderCollapsed(false)}
            title="展開標題列 / Expand header"
            style={{
              background: "transparent", border: "none", padding: "0 6px",
              fontSize: 13, lineHeight: 1, color: "#475569", cursor: "pointer",
            }}
          >
            ▾ AI AGENT
          </button>
        </div>
      ) : (
        <header className="app-header">
          <div className="header-logo">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.4">
              <polygon points="12,2 22,7 22,17 12,22 2,17 2,7" />
              <circle cx="12" cy="12" r="3" fill="currentColor" fillOpacity="0.4" />
              <line x1="12" y1="2" x2="12" y2="9" />
              <line x1="12" y1="15" x2="12" y2="22" />
              <line x1="2" y1="7" x2="7.5" y2="10.5" />
              <line x1="16.5" y1="13.5" x2="22" y2="17" />
            </svg>
          </div>
          <div className="header-title">
            <h1>Photonics <strong>EDA</strong> Agent</h1>
            <p>TAMKANG UNIVERSITY · EE · <strong>OPTICAL NETWORK LAB</strong> · POWERED</p>
          </div>
          <nav className="header-nav">
            <a href="/stats" className="header-nav-item" style={{ textDecoration: "none", color: "inherit" }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 15l4-4 4 2 5-6"/></svg>
              <span>Stats</span>
            </a>
            <span className="header-nav-sep" />
            <a href="/abstats" className="header-nav-item" style={{ textDecoration: "none", color: "inherit" }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 3v18"/><path d="M3 9h6"/><path d="M3 15h6"/><path d="M15 3l6 18"/></svg>
              <span>A/B</span>
            </a>
            <span className="header-nav-sep" />
            <div className="header-nav-item">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
              <span>Notifications</span>
            </div>
            <span className="header-nav-sep" />
            <div className="header-nav-item">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              <span>Settings</span>
            </div>
            <span className="header-nav-sep" />
            <button
              type="button"
              className="header-nav-item"
              title="登出 / Sign out"
              onClick={async () => {
                try {
                  await fetch("/api/auth/logout", { method: "POST" });
                } catch { /* ignore */ }
                window.location.href = "/login";
              }}
              style={{
                background: "transparent", border: "none", color: "inherit",
                cursor: "pointer", font: "inherit",
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              <span>登出 / Sign out</span>
            </button>
            <span className="header-nav-sep" />
            <button
              type="button"
              onClick={() => setHeaderCollapsed(true)}
              title="收起標題列 / Collapse header"
              style={{
                background: "transparent", border: "none", padding: "4px 8px",
                fontSize: 13, color: "#64748b", cursor: "pointer",
                display: "flex", alignItems: "center", gap: 4,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <polyline points="18 15 12 9 6 15"/>
              </svg>
              <span>Hide</span>
            </button>
          </nav>
        </header>
      )}

      <div className="app-shell" ref={appShellRef}>

        {/* ── Left: Chat ── */}
        <div
          className="chat-panel"
          ref={chatPanelRef}
          style={{
            width: chatWidthPx,
            minWidth: chatWidthPx,
            flexShrink: 0,
            ...(isNarrow && chatHeightPx
              ? { height: chatHeightPx, maxHeight: chatHeightPx, minHeight: chatHeightPx }
              : {}),
          }}
        >
          <div className="chat-header">
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--accent)", display: "inline-block", flexShrink: 0 }} />
            Photonic Sim Chat
          </div>

          <div className="chat-messages">
            {messages.length === 0 && (
              <div style={{ color: "var(--text-muted)", fontSize: 16, textAlign: "center", marginTop: 40, lineHeight: 1.8 }}>
                輸入模擬指令，例如 / Enter a simulation command, e.g.:<br />
                <em style={{ color: "#4ab8e8", display: "block", marginTop: 8, fontSize: 15 }}>
                  force simulate MZI center wavelength 1.55 FSR 20nm n_points 101 wl_start_um: 1.51 wl_stop_um: 1.59
                </em>
              </div>
            )}
            {messages.map((m) =>
              m.role === "user"
                ? (
                  <div
                    key={m.id}
                    className="msg user"
                    style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
                  >
                    <span style={{ flex: 1, wordBreak: "break-word", whiteSpace: "pre-wrap" }}>{m.text}</span>
                    <button
                      type="button"
                      title="複製到輸入框 / Copy to input (edit before submit)"
                      onClick={() => {
                        setInput(m.text.replace(/^⚡\s*/, ""));
                        inputRef.current?.focus();
                      }}
                      style={{
                        flexShrink: 0,
                        padding: "2px 8px",
                        fontSize: 12,
                        background: "rgba(255,255,255,0.7)",
                        border: "1px solid rgba(37,99,235,0.35)",
                        borderRadius: 4,
                        color: "#1e3a8a",
                        cursor: "pointer",
                        lineHeight: 1.4,
                      }}
                    >
                      → 輸入框 / Input
                    </button>
                  </div>
                )
                : <div key={m.id}>{renderBot(m)}</div>
            )}
            {loading && (
              <div className="msg bot">
                <span className="spinning">⟳</span> 思考中 / Thinking…
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* ── Input resize divider ── */}
          <div className="resize-divider" onMouseDown={onInputDividerMouseDown} />

          <div className="chat-input-area" style={{ height: inputHeightPx, minHeight: inputHeightPx, flexShrink: 0, overflowY: "auto" }}>
            <div style={{ marginBottom: 6 }}>
              <button
                ref={exampleTriggerRef}
                type="button"
                onClick={() => setExampleMenuOpen(o => !o)}
                disabled={loading}
                style={{
                  width: "100%", background: "#f5f8fe",
                  border: "1px solid var(--border)", borderRadius: 6,
                  color: "var(--text-muted)", padding: "6px 10px",
                  fontSize: 15, fontFamily: "inherit", outline: "none",
                  cursor: loading ? "not-allowed" : "pointer",
                  textAlign: "left", display: "flex",
                  alignItems: "center", justifyContent: "space-between",
                }}
              >
                <span>— 選擇範例指令 / Choose example command —</span>
                <span style={{
                  display: "inline-block", transition: "transform 0.15s",
                  transform: exampleMenuOpen ? "rotate(180deg)" : "rotate(0deg)",
                }}>▾</span>
              </button>
              {exampleMenuOpen && menuPos && (
                <div
                  ref={exampleMenuRef}
                  style={{
                    position: "fixed",
                    left: menuPos.left, bottom: menuPos.bottom, width: menuPos.width,
                    zIndex: 1000, background: "#fff",
                    border: "1px solid var(--border)", borderRadius: 6,
                    boxShadow: "0 -4px 16px rgba(0,0,0,0.18)",
                    maxHeight: "min(60vh, 480px)", overflowY: "auto", padding: 2,
                  }}
                >
                  {EXAMPLE_GROUPS.map(group => {
                    const collapsed = collapsedGroups.has(group.label);
                    return (
                      <div key={group.label} style={{ borderBottom: "1px solid #eef1f6" }}>
                        <button
                          type="button"
                          onClick={() => setCollapsedGroups(prev => {
                            const next = new Set(prev);
                            if (next.has(group.label)) next.delete(group.label);
                            else next.add(group.label);
                            return next;
                          })}
                          style={{
                            width: "100%", display: "flex", alignItems: "center", gap: 8,
                            padding: "8px 10px", fontSize: 15, fontWeight: 700,
                            background: "#eaf1ff", border: "none",
                            color: "#1e3a8a", cursor: "pointer", textAlign: "left",
                            letterSpacing: "0.2px",
                          }}
                        >
                          <span style={{
                            display: "inline-block", transition: "transform 0.15s",
                            transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
                          }}>▸</span>
                          {group.label}
                          <span style={{ marginLeft: "auto", fontWeight: 500, fontSize: 12, opacity: 0.7 }}>
                            {group.items.length}
                          </span>
                        </button>
                        {!collapsed && group.items.map((it, idx) => {
                          const prev = idx > 0 ? group.items[idx - 1] : null;
                          const showSectionHeader = it.section && it.section !== prev?.section;
                          return (
                            <Fragment key={it.value}>
                              {showSectionHeader && (
                                <div style={{
                                  padding: "4px 10px 4px 24px",
                                  fontSize: 11, fontWeight: 700,
                                  color: "#92400e", background: "#fef3c7",
                                  letterSpacing: "0.04em",
                                }}>
                                  {it.section}
                                </div>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setInput(it.value);
                                  setExampleMenuOpen(false);
                                }}
                                style={{
                                  width: "100%",
                                  padding: it.section ? "6px 10px 6px 42px" : "6px 10px 6px 30px",
                                  fontSize: 13, background: "transparent", border: "none",
                                  color: "#334155", cursor: "pointer", textAlign: "left",
                                }}
                                onMouseEnter={e => (e.currentTarget.style.background = "#f0f5ff")}
                                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                              >
                                {it.label}
                              </button>
                            </Fragment>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <textarea rows={3}
              ref={inputRef}
              placeholder="輸入模擬指令 / Enter command (Enter to send, Shift+Enter for newline)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              disabled={loading}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  onClick={async () => {
                    const replaced = input
                      .replace(/\bfind\s+similar\b/i, "force simulate")
                      .replace(/\bfind\b/i, "force simulate");
                    setInput(replaced);
                    setSimulateDone(false);
                    await send(replaced);
                    setSimulateDone(true);
                  }}
                  disabled={loading || !/\bfind\b/i.test(input)}
                  title="將 find / find similar 替換為 force simulate 並送出 / Replace 'find' or 'find similar' with 'force simulate' and send; button highlights when done"
                  style={{
                    flex: 1, minWidth: 0,
                    background: simulateDone ? "#e37400" : "#f9ab00",
                    color: "#fff",
                    fontWeight: simulateDone ? 700 : 600,
                    transition: "all 0.15s",
                    opacity: (loading || !/\bfind\b/i.test(input)) ? 0.5 : 1,
                  }}
                >
                  Simulate ↵
                </button>
                <button
                  onClick={() => send()}
                  disabled={loading || !input.trim()}
                  style={{ flex: 1, minWidth: 0, background: "#4285f4", color: "#fff", fontWeight: 600 }}
                >
                  {loading ? "…" : "Send ↵"}
                </button>
              </div>
              <button
                onClick={() => {
                  setMessages([]);
                  setInput("");
                  setSvgUrl(null);
                  setPngUrl(null);
                  setHtmlUrl(null);
                  setPrevGdsRefs(null);
                  setPrevGdsZoom(1);
                  setCurrentGdsZoom(1);
                  setSnpData(null);
                  setSnpFilename(null);
                  setSeedSnpFilename(null);
                  setSeedCenterUm(null);
                  setLastSimOut(null);
                  setForceSimulate(false);
                  setSimulateDone(false);
                }}
                title="清除對話與所有面板 / Clear chat and all panels"
                style={{
                  width: "100%",
                  background: "rgba(148,163,184,0.35)",
                  color: "#1e293b",
                  fontWeight: 600,
                }}
              >
                ↺ Reset
              </button>
            </div>
          </div>
        </div>

        {/* ── Horizontal resize divider ── */}
        <div className="resize-divider-h" onMouseDown={onChatDividerMouseDown} />

        {/* ── Right panels ── */}
        <div className="right-panels" ref={rightPanelRef}>

          {/* GDS layout · split Previous | Current when a prior sim exists */}
          <div className="gds-panel" style={{ flex: `0 0 ${splitPct}%` }}>
            <div className="panel-header">
              <span className="panel-header-dot" />GDS Layout
              {htmlUrl && <span style={{ marginLeft: 6, fontSize: 12, opacity: 0.6 }}>HTML</span>}
              {svgUrl && !htmlUrl && <span style={{ marginLeft: 6, fontSize: 12, opacity: 0.6 }}>SVG</span>}
              {pngUrl && !svgUrl && !htmlUrl && <span style={{ marginLeft: 6, fontSize: 12, opacity: 0.6 }}>PNG</span>}
              {prevGdsRefs && (
                <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}>
                  Previous · Current
                </span>
              )}
            </div>
            <div ref={gdsPanelRef} className="gds-content" style={{
              display: "flex", flexDirection: gdsStacked ? "column" : "row",
              alignItems: "stretch", justifyContent: "flex-start",  // override CSS default (center)
              height: "100%", padding: 0, overflow: "hidden",
            }}>
              {prevGdsRefs && (
                <>
                  <LayoutSlot
                    refs={prevGdsRefs}
                    title="Previous"
                    isPrev
                    flexBasis={`${gdsSplitPct}%`}
                    zoom={prevGdsZoom}
                    onZoomChange={setPrevGdsZoom}
                    onClose={() => { setPrevGdsRefs(null); setPrevGdsZoom(1); }}
                  />
                  <div
                    style={gdsStacked
                      ? { height: 4, background: "#e5e7eb", cursor: "row-resize", flex: "0 0 auto" }
                      : { width:  4, background: "#e5e7eb", cursor: "col-resize", flex: "0 0 auto" }}
                    onMouseDown={onGdsSplitMouseDown}
                    title="Drag to resize"
                  />
                </>
              )}
              <LayoutSlot
                refs={{ htmlUrl, svgUrl, pngUrl }}
                title={prevGdsRefs ? "Current" : "Layout"}
                isPrev={false}
                flexBasis={prevGdsRefs ? `${100 - gdsSplitPct}%` : "100%"}
                zoom={currentGdsZoom}
                onZoomChange={setCurrentGdsZoom}
              />
            </div>
          </div>

          {/* Resizable divider */}
          <div className="resize-divider" onMouseDown={onDividerMouseDown} />

          {/* S-param panel */}
          <div className="sparam-panel">
            <div className="panel-header">
              <span className="panel-header-dot" />
              Simulation Output
              {snpData && (
                <span style={{ marginLeft: 8, fontSize: 13, opacity: 0.6, fontFamily: "monospace", fontWeight: 400 }}>
                  sNp · {snpData.nPorts}P · {snpData.wavelengths_nm.length} pts
                </span>
              )}
              {!snpData && lastSimOut?.spectral_feature?.s21_trace?.wavelength_um.length ? (
                <span style={{ marginLeft: 8, fontSize: 13, opacity: 0.6, fontFamily: "monospace", fontWeight: 400 }}>
                  s21_trace · {lastSimOut.spectral_feature.s21_trace.wavelength_um.length} pts
                </span>
              ) : null}
            </div>
            <div className="sparam-content">
              {renderSimPanel()}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

// ── Inline styles for file link elements ─────────────────────────────────────

const fileLinkStyle: React.CSSProperties = {
  display:        "inline-flex",
  alignItems:     "center",
  gap:            5,
  padding:        "3px 10px",
  background:     "rgba(37,99,235,0.06)",
  border:         "1px solid rgba(37,99,235,0.2)",
  borderRadius:   5,
  color:          "#2563eb",
  fontSize:       14,
  fontFamily:     "monospace",
  textDecoration: "none",
  cursor:         "pointer",
  transition:     "background 0.15s",
  whiteSpace:     "nowrap",
  maxWidth:       "260px",
  overflow:       "hidden",
  textOverflow:   "ellipsis",
};

const fileRowLabelStyle: React.CSSProperties = {
  fontSize:    13,
  color:       "var(--text-muted)",
  minWidth:    90,
  flexShrink:  0,
};

const viewBtnStyle: React.CSSProperties = {
  display:     "inline-flex",
  alignItems:  "center",
  gap:         4,
  padding:     "3px 10px",
  background:  "rgba(37,99,235,0.08)",
  border:      "1px solid rgba(37,99,235,0.25)",
  borderRadius: 5,
  color:       "var(--accent)",
  fontSize:    14,
  cursor:      "pointer",
};

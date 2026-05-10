import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// Calibration Diagnose Agent: given inverse_fit drift + design, recommend
// per-arm heater Δφ + per-DC κ trim recipe. Same Ollama-backed pattern as
// /api/decide-params (Tier-3 Decide Agent), with a different schema.
//
// Reads ipkiss-api/md/calibrate_skill.md for system + user templates.
// Mirrors the parser in /api/decide-params so prompts stay portable.

const OLLAMA_URL      = process.env.OLLAMA_URL ?? "http://localhost:11434";
const CALIBRATE_MODEL = process.env.CALIBRATE_MODEL ?? "llama3.1:8b";
const SKILL_PATH      = process.env.CALIBRATE_SKILL_PATH
  ?? path.resolve("D:/photonic-platform/ipkiss-api/md/calibrate_skill.md");

function parseSkill(md: string): { system: string; template: string } {
  const sysHeader = "## System Message";
  const usrHeader = "## User Text Template";
  const sysIdx = md.indexOf(sysHeader);
  const usrIdx = md.indexOf(usrHeader);
  if (sysIdx < 0 || usrIdx < 0) return { system: "", template: "" };
  const system = md.slice(sysIdx + sysHeader.length, usrIdx).trim();
  const template = md.slice(usrIdx + usrHeader.length).trim();
  return { system, template };
}

function fillTemplate(tpl: string, vars: Record<string, unknown>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    const val = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    out = out.split(`{{${k}}}`).join(val);
  }
  return out;
}

type DriftBlock = {
  dkappa?: number[];
  ddelay_um?: number[];
  dphi_rad_per_arm_at_center?: number[];
  design_kappa?: number[];
  design_delays_um?: number[];
};

type CalibrateBody = {
  design?: Record<string, unknown>;
  drift?: DriftBlock;
  // Convenience: caller can pass the *entire* /ipkiss/calibrate/lattice_inverse_fit
  // response under `inverse_fit_response` and we pull `data.drift` + `data.model` from it.
  inverse_fit_response?: { data?: { drift?: DriftBlock; model?: Record<string, unknown> } };
  measured_metrics?: Record<string, unknown>;
  tunable_actuators?: { heaters_per_arm?: boolean[]; tunable_dcs?: boolean[] };
  thresholds?: { phase_max_rad?: number; phase_warn_rad?: number; kappa_max_trim?: number };
};

const calibrateSchema = {
  type: "object",
  required: ["drift_mode", "diagnosis", "recipe", "feasibility", "confidence"],
  additionalProperties: false,
  properties: {
    drift_mode: {
      type: "string",
      enum: ["uniform_phase", "differential_phase", "kappa", "loss", "mixed"],
    },
    diagnosis: { type: "string" },
    recipe: {
      type: "object",
      required: ["phase_compensation_rad", "kappa_trim"],
      additionalProperties: false,
      properties: {
        phase_compensation_rad:    { type: "array", items: { type: "number" }, minItems: 1 },
        kappa_trim:                { type: "array", items: { type: "number" }, minItems: 2 },
        expected_peak_um_after:    { type: ["number", "null"] },
        expected_ripple_db_after:  { type: ["number", "null"] },
      },
    },
    feasibility: {
      type: "object",
      required: ["phase_within_2pi", "kappa_trim_required"],
      additionalProperties: false,
      properties: {
        phase_within_2pi:    { type: "boolean" },
        kappa_trim_required: { type: "boolean" },
        max_phase_rad:       { type: ["number", "null"] },
        max_kappa_trim:      { type: ["number", "null"] },
        warnings:            { type: "array", items: { type: "string" } },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

const TWO_PI = 2 * Math.PI;
const DEFAULT_THRESHOLDS = { phase_max_rad: TWO_PI, phase_warn_rad: Math.PI, kappa_max_trim: 0.05 };

function resolveDrift(payload: CalibrateBody): DriftBlock | null {
  if (payload.drift && typeof payload.drift === "object") return payload.drift;
  const ifr = payload.inverse_fit_response;
  if (ifr?.data?.drift && typeof ifr.data.drift === "object") return ifr.data.drift;
  return null;
}

function resolveDesign(payload: CalibrateBody): Record<string, unknown> | null {
  if (payload.design && typeof payload.design === "object") return payload.design;
  // If only inverse_fit_response was provided, synthesize a partial design from
  // its drift + model blocks (design_kappa, design_delays_um are stored on drift;
  // center wavelength on model).
  const ifr = payload.inverse_fit_response;
  const drift = ifr?.data?.drift;
  const model = ifr?.data?.model as Record<string, unknown> | undefined;
  if (drift?.design_kappa && drift?.design_delays_um) {
    return {
      power_couplings:      drift.design_kappa,
      delay_lengths_um:     drift.design_delays_um,
      center_wavelength_um: (model?.center_wavelength_um as number | undefined) ?? null,
      wg_family:            model?.wg_family ?? null,
      core_width_um:        model?.core_width_um ?? null,
    };
  }
  return null;
}

function defaultActuatorsFor(design: Record<string, unknown>): { heaters_per_arm: boolean[]; tunable_dcs: boolean[] } {
  const dl = Array.isArray(design.delay_lengths_um) ? (design.delay_lengths_um as number[]) : [];
  const pc = Array.isArray(design.power_couplings)  ? (design.power_couplings  as number[]) : [];
  return {
    heaters_per_arm: Array(dl.length).fill(true),
    tunable_dcs:     Array(pc.length).fill(false),  // conservative: assume DCs are NOT tunable
  };
}

type Recipe = {
  phase_compensation_rad?: number[];
  kappa_trim?: number[];
  expected_peak_um_after?: number | null;
  expected_ripple_db_after?: number | null;
};
type Feasibility = {
  phase_within_2pi?: boolean;
  kappa_trim_required?: boolean;
  max_phase_rad?: number | null;
  max_kappa_trim?: number | null;
  warnings?: string[];
};
type Decision = {
  drift_mode?: string;
  diagnosis?: string;
  recipe?: Recipe;
  feasibility?: Feasibility;
  confidence?: number;
};

type Invariants = {
  ok: boolean;
  reasons: string[];
  derived: { max_phase_rad: number | null; max_kappa_trim: number | null };
};

function validateInvariants(
  decision: Decision,
  design: Record<string, unknown>,
  thresholds: { phase_max_rad: number; phase_warn_rad: number; kappa_max_trim: number },
): Invariants {
  const reasons: string[] = [];
  const recipe = decision.recipe ?? {};
  const phaseArr = Array.isArray(recipe.phase_compensation_rad) ? recipe.phase_compensation_rad : [];
  const kappaArr = Array.isArray(recipe.kappa_trim)             ? recipe.kappa_trim             : [];
  const dl = Array.isArray(design.delay_lengths_um) ? (design.delay_lengths_um as number[]) : [];
  const pc = Array.isArray(design.power_couplings)  ? (design.power_couplings  as number[]) : [];

  if (phaseArr.length !== dl.length) {
    reasons.push(`recipe.phase_compensation_rad length ${phaseArr.length} != design arms ${dl.length}`);
  }
  if (kappaArr.length !== pc.length) {
    reasons.push(`recipe.kappa_trim length ${kappaArr.length} != design DCs ${pc.length}`);
  }
  for (const v of phaseArr) {
    if (!Number.isFinite(v)) reasons.push(`phase_compensation_rad has non-finite value: ${v}`);
  }
  for (const v of kappaArr) {
    if (!Number.isFinite(v)) reasons.push(`kappa_trim has non-finite value: ${v}`);
  }
  const max_phase_rad = phaseArr.length ? Math.max(...phaseArr.map((v) => Math.abs(v))) : null;
  const max_kappa_trim = kappaArr.length ? Math.max(...kappaArr.map((v) => Math.abs(v))) : null;
  if (max_phase_rad !== null && max_phase_rad > thresholds.phase_max_rad) {
    reasons.push(
      `max_phase_rad ${max_phase_rad.toFixed(4)} > phase_max_rad ${thresholds.phase_max_rad.toFixed(4)} (heater range exceeded)`,
    );
  }
  if (max_kappa_trim !== null && max_kappa_trim > Math.max(thresholds.kappa_max_trim, 0.10)) {
    reasons.push(
      `max_kappa_trim ${max_kappa_trim.toFixed(4)} > 0.10 absolute limit (unphysical for tunable DCs)`,
    );
  }
  return { ok: reasons.length === 0, reasons, derived: { max_phase_rad, max_kappa_trim } };
}

export async function POST(req: Request) {
  const t0 = Date.now();
  let payload: CalibrateBody;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const drift = resolveDrift(payload);
  const design = resolveDesign(payload);
  if (!drift) {
    return NextResponse.json({ error: "missing `drift` (or `inverse_fit_response.data.drift`)" }, { status: 400 });
  }
  if (!design) {
    return NextResponse.json({ error: "missing `design` (or inverse_fit_response with design_* in drift)" }, { status: 400 });
  }
  const dl = Array.isArray(design.delay_lengths_um) ? (design.delay_lengths_um as number[]) : null;
  const pc = Array.isArray(design.power_couplings)  ? (design.power_couplings  as number[]) : null;
  if (!dl || !pc || pc.length !== dl.length + 1) {
    return NextResponse.json(
      { error: "design.power_couplings/delay_lengths_um malformed (geometry: len(pc) == len(dl)+1)" },
      { status: 400 },
    );
  }

  let skill: { system: string; template: string };
  try {
    skill = parseSkill(fs.readFileSync(SKILL_PATH, "utf8"));
  } catch (e) {
    return NextResponse.json(
      { error: `calibrate_skill.md not readable at ${SKILL_PATH}: ${String(e)}` },
      { status: 500 },
    );
  }
  if (!skill.system || !skill.template) {
    return NextResponse.json({ error: "calibrate_skill.md missing required sections" }, { status: 500 });
  }

  const tunable_actuators = payload.tunable_actuators ?? defaultActuatorsFor(design);
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(payload.thresholds ?? {}) };

  const user_text = fillTemplate(skill.template, {
    design,
    drift,
    measured_metrics:  payload.measured_metrics ?? {},
    tunable_actuators,
    thresholds,
  });

  let ollamaResp: Response;
  try {
    ollamaResp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CALIBRATE_MODEL,
        stream: false,
        format: calibrateSchema,
        messages: [
          { role: "system", content: skill.system },
          { role: "user",   content: user_text },
        ],
        options: { temperature: 0.2 },
      }),
    });
  } catch (e) {
    return NextResponse.json({ error: `ollama unreachable: ${String(e)}` }, { status: 502 });
  }
  if (!ollamaResp.ok) {
    const text = await ollamaResp.text().catch(() => "");
    return NextResponse.json(
      { error: `ollama http ${ollamaResp.status}`, detail: text.slice(0, 400) },
      { status: ollamaResp.status },
    );
  }

  type OllamaChat = {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
    total_duration?: number;
  };
  const ollamaBody = (await ollamaResp.json()) as OllamaChat;
  const content = ollamaBody?.message?.content ?? "";
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();

  let decision: Decision;
  try {
    decision = JSON.parse(cleaned) as Decision;
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) {
      return NextResponse.json(
        { error: "LLM returned non-JSON", raw: content.slice(0, 500) },
        { status: 500 },
      );
    }
    try {
      decision = JSON.parse(m[0]) as Decision;
    } catch {
      return NextResponse.json(
        { error: "LLM returned malformed JSON", raw: content.slice(0, 500) },
        { status: 500 },
      );
    }
  }

  const inv = validateInvariants(decision, design, thresholds);
  const durationMs = Date.now() - t0;

  return NextResponse.json({
    decision,
    model: CALIBRATE_MODEL,
    invariant_ok: inv.ok,
    invariant_reasons: inv.reasons,
    derived: inv.derived,
    metrics: {
      duration_ms: durationMs,
      prompt_tokens:   ollamaBody?.prompt_eval_count ?? null,
      completion_tokens: ollamaBody?.eval_count ?? null,
      total_tokens:
        (ollamaBody?.prompt_eval_count ?? 0) + (ollamaBody?.eval_count ?? 0) || null,
      ollama_total_duration_ms:
        typeof ollamaBody?.total_duration === "number"
          ? Math.round(ollamaBody.total_duration / 1e6)
          : null,
    },
  });
}

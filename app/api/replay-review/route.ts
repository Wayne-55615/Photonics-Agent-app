import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// Ollama endpoint + review skill source. These mirror what n8n's LLM Review Agent
// uses so chat-sim review and replay review stay consistent.
const OLLAMA_URL  = process.env.OLLAMA_URL  ?? "http://localhost:11434";
const REVIEW_MODEL = process.env.REVIEW_MODEL ?? "llama3.1:8b";
const SKILL_PATH = process.env.REVIEW_SKILL_PATH
  ?? path.resolve("D:/photonic-platform/ipkiss-api/md/review_skill.md");

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

type ReplayReviewBody = {
  sim_result?: Record<string, unknown>;
  // Tier-1 judge result (evaluation + checks + suggestions). When provided,
  // it's injected into the prompt's {{rule_evaluation}} slot so the LLM
  // reviewer can cite concrete check outcomes instead of re-deriving them.
  judge?: Record<string, unknown>;
  request?: { question?: string; route_mode?: string };
};

export async function POST(req: Request) {
  const t0 = Date.now();
  let payload: ReplayReviewBody;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const sim = (payload.sim_result ?? {}) as Record<string, unknown>;
  const rq  = payload.request ?? {};

  let skill: { system: string; template: string };
  try {
    skill = parseSkill(fs.readFileSync(SKILL_PATH, "utf8"));
  } catch (e) {
    return NextResponse.json(
      { error: `review_skill.md not readable at ${SKILL_PATH}: ${String(e)}` },
      { status: 500 },
    );
  }
  if (!skill.system || !skill.template) {
    return NextResponse.json({ error: "review_skill.md missing required sections" }, { status: 500 });
  }

  const user_text = fillTemplate(skill.template, {
    question: rq.question ?? "(frontend replay)",
    route_mode: rq.route_mode ?? "simulation",
    context_notes: "This is a replay of a previous MZI simulation. Evaluate the replayed result on its own merit. Note the FSR warning when the sweep window holds fewer than two peaks is a verification limitation, not a simulation failure.",
    simulation_request: sim.params_used ?? sim.simulation_request ?? {},
    requested_vs_used: { requested: rq, used: sim.params_used ?? {} },
    artifacts: sim.files ?? {
      gds_path: sim.gds_path, sNp_path: sim.sNp_path,
      netlist_json_path: sim.netlist_json_path, spectrum_png_path: sim.spectrum_png_path,
      smatrix_plot_path: sim.smatrix_plot_path, layout_html_path: sim.layout_html_path,
    },
    spectral_summary: sim.spectrum ?? sim.spectral_feature ?? {},
    rule_evaluation: payload.judge
      ? payload.judge
      : "(rule-based evaluator not run; this is a pre-judge replay)",
  });

  // Strict JSON schema — Ollama 0.5+ will constrain sampling to exactly this shape.
  // Without this, the model happily invents its own keys even though the skill
  // prompt spells out the expected schema.
  const reviewSchema = {
    type: "object",
    required: ["llm_score", "llm_verdict", "llm_reasoning", "improvement_suggestions"],
    additionalProperties: false,
    properties: {
      llm_score:              { type: "number", minimum: 0, maximum: 1 },
      llm_verdict:            { type: "string", enum: ["pass", "partial", "fail"] },
      llm_reasoning:          { type: "string" },
      improvement_suggestions:{ type: "array", items: { type: "string" } },
    },
  };

  let ollamaResp: Response;
  try {
    ollamaResp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: REVIEW_MODEL,
        stream: false,
        format: reviewSchema,  // structured output — forces exact schema
        messages: [
          { role: "system", content: skill.system },
          { role: "user",   content: user_text },
        ],
        options: { temperature: 0.1 },
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
    total_duration?: number;     // ns
  };
  const ollamaBody = (await ollamaResp.json()) as OllamaChat;
  const content = ollamaBody?.message?.content ?? "";

  // Strict JSON parse (skill asks for raw JSON, no code fences; strip if present).
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  let review: Record<string, unknown>;
  try {
    review = JSON.parse(cleaned);
  } catch {
    // Fallback: try to extract the first {...} block.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) {
      return NextResponse.json(
        { error: "LLM returned non-JSON", raw: content.slice(0, 500) },
        { status: 500 },
      );
    }
    try {
      review = JSON.parse(m[0]);
    } catch {
      return NextResponse.json(
        { error: "LLM returned malformed JSON", raw: content.slice(0, 500) },
        { status: 500 },
      );
    }
  }

  const durationMs = Date.now() - t0;
  return NextResponse.json({
    review,
    model: REVIEW_MODEL,
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

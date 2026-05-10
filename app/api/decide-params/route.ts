import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// Tier-3 Decide Agent: given Tier-1 judge + Tier-2 review + history, pick next params.
// Same Ollama endpoint/model as the reviewer so total costs are comparable.

const OLLAMA_URL   = process.env.OLLAMA_URL    ?? "http://localhost:11434";
const DECIDE_MODEL = process.env.DECIDE_MODEL  ?? "llama3.1:8b";
const SKILL_PATH   = process.env.DECIDE_SKILL_PATH
  ?? path.resolve("D:/photonic-platform/ipkiss-api/md/decide_skill.md");

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

type DecideBody = {
  current_params?: Record<string, unknown>;
  judge?: Record<string, unknown>;
  review?: Record<string, unknown>;
  attempt_history?: unknown[];
  budget_remaining?: number;
};

export async function POST(req: Request) {
  const t0 = Date.now();
  let payload: DecideBody;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  let skill: { system: string; template: string };
  try {
    skill = parseSkill(fs.readFileSync(SKILL_PATH, "utf8"));
  } catch (e) {
    return NextResponse.json(
      { error: `decide_skill.md not readable at ${SKILL_PATH}: ${String(e)}` },
      { status: 500 },
    );
  }
  if (!skill.system || !skill.template) {
    return NextResponse.json({ error: "decide_skill.md missing required sections" }, { status: 500 });
  }

  const user_text = fillTemplate(skill.template, {
    current_params: payload.current_params ?? {},
    judge: payload.judge ?? {},
    review: payload.review ?? {},
    attempt_history: payload.attempt_history ?? [],
    budget_remaining: payload.budget_remaining ?? 5,
  });

  // Structured JSON schema — forces Ollama sampling into the expected shape.
  const decideSchema = {
    type: "object",
    required: ["next_params", "strategy", "reason", "confidence"],
    additionalProperties: false,
    properties: {
      next_params: {
        type: "object",
        required: ["delay_lengths_um", "power_couplings"],
        additionalProperties: false,
        properties: {
          delay_lengths_um:  { type: "array", items: { type: "number" }, minItems: 2 },
          power_couplings:   { type: "array", items: { type: "number" }, minItems: 3 },
          fsr_nm:            { type: ["number", "null"] },
          wl_start_um:       { type: ["number", "null"] },
          wl_stop_um:        { type: ["number", "null"] },
        },
      },
      strategy:   { type: "string", enum: ["scalar_k", "coupling_flatten", "delay_shift", "widen_window", "abort"] },
      reason:     { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };

  let ollamaResp: Response;
  try {
    ollamaResp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DECIDE_MODEL,
        stream: false,
        format: decideSchema,
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
    total_duration?: number;     // ns
    load_duration?: number;      // ns
    prompt_eval_duration?: number;
    eval_duration?: number;
  };
  const ollamaBody = (await ollamaResp.json()) as OllamaChat;
  const content = ollamaBody?.message?.content ?? "";
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();

  let decision: Record<string, unknown>;
  try {
    decision = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) {
      return NextResponse.json(
        { error: "LLM returned non-JSON", raw: content.slice(0, 500) },
        { status: 500 },
      );
    }
    try {
      decision = JSON.parse(m[0]);
    } catch {
      return NextResponse.json(
        { error: "LLM returned malformed JSON", raw: content.slice(0, 500) },
        { status: 500 },
      );
    }
  }

  // Enforce the N+1 invariant server-side (reject at API boundary rather than
  // letting a broken decision reach the judge → silent IPKISS runtime error).
  const nextParams = (decision.next_params ?? {}) as Record<string, unknown>;
  const dl = Array.isArray(nextParams.delay_lengths_um) ? nextParams.delay_lengths_um as number[] : null;
  const pc = Array.isArray(nextParams.power_couplings)  ? nextParams.power_couplings  as number[] : null;
  const invariantOk = !!(dl && pc && pc.length === dl.length + 1);

  const durationMs = Date.now() - t0;

  return NextResponse.json({
    decision,
    model: DECIDE_MODEL,
    invariant_ok: invariantOk,
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

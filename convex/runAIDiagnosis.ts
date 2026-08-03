/**
 * convex/runAIDiagnosis.ts
 *
 * Adds ONE new Convex action: runAIDiagnosis
 * ─────────────────────────────────────────
 * • Calls Google Gemini 1.5 Flash to generate a structured diagnosis from the tech's
 *   Q&A answers + issue type info fetched from existing Supabase tables.
 * • Uses ONLY existing tables:
 *     issue_types        (id, name, sla_hours, priority)
 *     issue_sub_types    (id, name, issue_type_id)
 *     diagnostic_sessions (write back the AI result)
 *     maintenance_tickets (read issue context)
 *   — NO new tables created.
 * • Returns a DiagnosisResult shape identical to what the web DiagnosticFlow
 *   already expects, so the mobile DiagnosticFlow component is a 1-to-1 port.
 *
 * ENV VARS required in Convex dashboard (set at least one):
 *   GEMINI_API_KEY          ← preferred (Gemini 1.5 Flash)
 *   GROQ_API_KEY            ← fallback  (Llama 3.3 70B via Groq)
 *   SUPABASE_URL            (already set)
 *   SUPABASE_SERVICE_ROLE_KEY (already set)
 */

"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID } from "./lib/supabaseAdmin";

// ─── Types (mirrors web DiagnosticFlow) ──────────────────────────────────────

interface DiagnosticCause {
  cause: string;
  probability: number;
  severity: "low" | "medium" | "high";
  solution: string;
  estimatedCost: string;
  requiredParts?: { name: string; estimatedPrice: string }[];
}

interface DiagnosisResult {
  causes: DiagnosticCause[];
  summary: string;
  urgency: string;
  recommendedAction: string;
}

// ─── Helper: call AI (Gemini preferred, Groq fallback) ───────────────────────

async function callAI(prompt: string): Promise<string> {
  const groqKey   = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  // ── Groq path (preferred) ─────────────────────────────────────────────────
  if (groqKey) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You are a property maintenance expert AI. Always respond with valid JSON only.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Groq error: ${await res.text()}`);
    const json = await res.json();
    return json.choices?.[0]?.message?.content || "{}";
  }

  // ── Gemini fallback ───────────────────────────────────────────────────────
  if (geminiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
      }),
    });
    if (!res.ok) throw new Error(`Gemini error: ${await res.text()}`);
    const json = await res.json();
    return json.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  }

  throw new Error(
    "No AI API key configured. Set GROQ_API_KEY (preferred) or GEMINI_API_KEY in the Convex environment dashboard."
  );
}
// ─── Action ──────────────────────────────────────────────────────────────────

export const runAIDiagnosis = action({
  args: {
    ticketId:    v.string(),
    issueTypeId: v.string(),
    issueSubType: v.optional(v.string()),
    answers: v.array(
      v.object({ question: v.string(), answer: v.string() })
    ),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();

    // ── 1. Fetch issue type name from existing table ──────────────────────
    const { data: issueType } = await sb
      .from("issue_types")
      .select("name, priority, sla_hours")
      .eq("id", args.issueTypeId)
      .maybeSingle();

    const issueTypeName = issueType?.name || "Maintenance Issue";
    const subType = args.issueSubType || "";

    // ── 2. Build Q&A string ───────────────────────────────────────────────
    const qaSummary = args.answers
      .map((a, i) => `${i + 1}. Q: ${a.question}\n   A: ${a.answer}`)
      .join("\n");

    // ── 3. Build prompt ───────────────────────────────────────────────────
    const prompt = `
You are diagnosing a property maintenance issue.

Issue Category: ${issueTypeName}
${subType ? `Specific Issue: ${subType}` : ""}

Technician's Observations (Q&A):
${qaSummary}

Respond with a JSON object matching EXACTLY this schema:
{
  "summary": "Brief 1–2 sentence overview of the situation",
  "urgency": "low | medium | high | critical",
  "recommendedAction": "Top-level recommended action",
  "causes": [
    {
      "cause": "Name of root cause",
      "probability": <integer 0–100>,
      "severity": "low | medium | high",
      "solution": "Step-by-step fix description",
      "estimatedCost": "e.g. ₹500–₹1500",
      "requiredParts": [
        { "name": "Part name", "estimatedPrice": "e.g. ₹200–₹400" }
      ]
    }
  ]
}

Rules:
- Provide 2–4 causes ordered by probability (highest first).
- All cost estimates must be in Indian Rupees (₹).
- requiredParts may be an empty array if no parts needed.
- Be specific and practical for the Indian property maintenance context.
- Return ONLY the JSON object, no markdown.
`.trim();

    // ── 4. Call AI ────────────────────────────────────────────────────────
    const raw = await callAI(prompt);
    let result: DiagnosisResult;
    try {
      result = JSON.parse(raw) as DiagnosisResult;
    } catch {
      throw new Error("AI returned invalid JSON: " + raw.slice(0, 200));
    }

    // ── 5. Persist AI result into diagnostic_sessions (existing table) ────
    // Upsert so re-running diagnosis overwrites the previous AI result.
    const { data: existing } = await sb
      .from("diagnostic_sessions")
      .select("id")
      .eq("ticket_id", args.ticketId)
      .maybeSingle();

    const sessionData = {
      ticket_id:        args.ticketId,
      organization_id:  ORG_ID,
      issue_type_id:    args.issueTypeId,
      questions_answers: Object.fromEntries(
        args.answers.map((a) => [a.question, a.answer])
      ),
      ai_diagnosis:     JSON.stringify(result),
      status:           "ai_complete",
      completed_at:     new Date().toISOString(),
    };

    if (existing?.id) {
      await sb.from("diagnostic_sessions").update(sessionData).eq("id", existing.id);
    } else {
      await sb.from("diagnostic_sessions").insert(sessionData as any);
    }

    return result;
  },
});
"use node";

import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";
import { getSupabase, ORG_ID, safeList, normaliseStatus } from "./lib/supabaseAdmin";

// ─── AI ASSISTANT ────────────────────────────────────────────────────────────
// The mobile Floating AI assistant calls api.aiAssistant.askAssistant({ question,
// history }) and expects { answer }. This routes to Claude (Anthropic) server-side
// with the key held in the Convex env var ANTHROPIC_API_KEY — the key never
// touches the client. Set it in the Convex dashboard → Settings → Environment
// Variables, then `npx convex deploy`.
//
// SCOPE: read-only Q&A assistant (help, how-to, drafting) PLUS an organization-wide
// LIVE DATA SNAPSHOT injected into the system prompt on every turn. The snapshot
// (tenants by status, occupancy, tickets, current-FY financials, properties) is
// built from Supabase via the same authoritative source as the Reports screen
// (reports.getReportsSummary) so the numbers reconcile 1:1 with the app. It is
// AGGREGATE data only — it does NOT include per-record lists (e.g. "who exactly
// hasn't paid") or transactional command execution (create invoice / record
// payment); the prompt tells the model to point the user at the relevant screen
// for record-level detail and to never invent figures outside the snapshot.

// ─── LIVE DATA SNAPSHOT ───────────────────────────────────────────────────────

// Compact INR formatter for the snapshot (e.g. 15956000 → "₹1.60 Cr" / "₹3.35 L").
function inr(n: number): string {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (Math.abs(v) >= 100000) return `₹${(v / 100000).toFixed(2)} L`;
  return `₹${v.toLocaleString("en-IN")}`;
}

// Build the organization-wide snapshot as a plain text block for the system prompt.
// Returns null if the data layer is unreachable, so the caller can degrade to
// generic help instead of hard-failing.
async function buildLiveSnapshot(ctx: any): Promise<string | null> {
  try {
    const sb = getSupabase();

    // Authoritative KPIs (occupancy + current-FY financials + tickets + active/booked
    // tenant counts) — reuse the exact source the Reports screen renders so figures match.
    const summary: any = await ctx.runAction(api.reports.getReportsSummary, { period: "current_fy" });

    // Tenant status buckets straight from the tenants table (per-tenant staying_status),
    // matching the Tenants screen's tab counts. Plus the property roster.
    const [tenants, properties] = await Promise.all([
      safeList(sb.from("tenants").select("staying_status").eq("organization_id", ORG_ID)),
      safeList(sb.from("properties").select("property_name,name,code,status").eq("organization_id", ORG_ID)),
    ]);

    const bucket = { New: 0, Booked: 0, Staying: 0, "On-Notice": 0, Exited: 0 } as Record<string, number>;
    for (const t of tenants) {
      const s = normaliseStatus(t.staying_status);
      if (bucket[s] === undefined) bucket[s] = 0;
      bucket[s]++;
    }

    const liveProps = properties.filter((p: any) =>
      !p.status || ["live", "Live"].includes(String(p.status)),
    );
    const propNames = properties.map((p: any) => p.property_name || p.name || p.code || "Unnamed");

    const a = summary?.accounting || {};
    const occ = summary?.propertyStatus || {};
    const tk = summary?.tickets || {};

    return [
      `LIVE DATA SNAPSHOT — organization-wide. Money figures are current financial year (FY). Occupancy/tenant counts are as of now. All amounts in INR.`,
      ``,
      `TENANTS: ${tenants.length} total — ${bucket.Staying} Staying, ${bucket["On-Notice"]} On-Notice, ${bucket.Booked} Booked, ${bucket.New} New, ${bucket.Exited} Exited.`,
      `OCCUPANCY: ${occ.total ?? 0} live beds — ${occ.occupied ?? 0} occupied, ${occ.notice ?? 0} on-notice, ${occ.booked ?? 0} booked, ${occ.vacant ?? 0} vacant. Occupancy rate ${occ.occupancyPct ?? 0}% (occupied + on-notice).`,
      `PROPERTIES: ${properties.length} total (${liveProps.length} live)${propNames.length ? ` — ${propNames.join(", ")}` : ""}.`,
      `TICKETS: ${tk.total ?? 0} this FY — ${tk.open ?? 0} open, ${tk.closed ?? 0} closed, ${tk.needsTenantApproval ?? 0} awaiting tenant approval.`,
      `FINANCIALS (current FY): Total invoiced ${inr(a.totalInvoiced)}, Rental revenue ${inr(a.totalRentalRevenue)}, EB charged ${inr(a.totalEbCharged)}, Collections ${inr(a.totalCollections)}, Pending collection ${inr(a.totalPendingCollection)}, Deposits collected ${inr(a.depositCollections)}, Refunds given ${inr(a.totalRefundsGiven)}, Expenses ${inr(a.totalExpenses)}, Profit ${inr(a.totalProfit)}.`,
    ].join("\n");
  } catch (e: any) {
    console.warn("[aiAssistant] snapshot build failed:", e?.message);
    return null;
  }
}

function buildSystemPrompt(snapshot: string | null): string {
  const base = `You are the AI assistant inside "Vishful Spaces", a property-management app for co-living / PG operators (properties, apartments, beds, tenants, maintenance tickets, accounting, and team management).

Help staff with how-to guidance, explanations, drafting (announcements, messages, summaries), and answering questions about their organization's live data using the snapshot below.

Answer concisely and practically. When you cite a number, use the snapshot values verbatim (you may reformat currency, e.g. lakhs/crores). Do not include any internal or system XML tags in your response.`;

  if (!snapshot) {
    return `${base}

Note: the live-data snapshot is temporarily unavailable this turn. If asked for specific figures, say the data couldn't be loaded right now and point the user to the relevant screen (Tenants, Reports, Tickets, Accounting).`;
  }

  return `${base}

Use the following snapshot as your source of truth for live figures. It is AGGREGATE data only — it does not contain per-record lists. If asked for record-level detail the snapshot can't answer (e.g. "which tenants haven't paid", "list overdue invoices", a specific tenant's balance), give what the snapshot supports and point the user to the relevant screen (Tenants, Reports, Tickets, Accounting, EB). Never invent figures that aren't in the snapshot.

${snapshot}`;
}

export const askAssistant = action({
  args: {
    question: v.string(),
    history: v.optional(v.array(v.object({ role: v.string(), content: v.string() }))),
    organizationId: v.optional(v.string()),
    userId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, { question, history }) => {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    if (!anthropicKey && !groqKey) {
      return { answer: "The AI assistant isn't configured yet — set ANTHROPIC_API_KEY (or GROQ_API_KEY) in the Convex environment (Settings → Environment Variables) and redeploy." };
    }

    // Build the message list from history (which ends with the user's question),
    // dropping any leading non-user turns — the first message must be a user turn.
    // Fall back to just the question if history is unusable.
    const msgs = (history || [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") {
      msgs.push({ role: "user", content: question });
    }

    // Inject the live organization snapshot into the system prompt so the model can
    // answer data questions ("how many tenants are staying", "what's my pending
    // collection") with real figures instead of refusing.
    const snapshot = await buildLiveSnapshot(ctx);
    const SYSTEM_PROMPT = buildSystemPrompt(snapshot);

    try {
      // Prefer Anthropic when configured; otherwise use Groq (OpenAI-compatible).
      if (anthropicKey) {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-5",
            max_tokens: 1024,
            thinking: { type: "disabled" },
            system: SYSTEM_PROMPT,
            messages: msgs,
          }),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          console.warn("[aiAssistant] Anthropic error", resp.status, body.slice(0, 300));
          return { answer: `Sorry — the AI service returned an error (${resp.status}). Please try again in a moment.` };
        }
        const data: any = await resp.json();
        const answer = Array.isArray(data?.content)
          ? data.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim()
          : "";
        return { answer: answer || "No response." };
      }

      // Groq (OpenAI-compatible chat completions).
      const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          max_tokens: 1024,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...msgs],
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        console.warn("[aiAssistant] Groq error", resp.status, body.slice(0, 300));
        return { answer: `Sorry — the AI service returned an error (${resp.status}). Please try again in a moment.` };
      }
      const data: any = await resp.json();
      const answer = (data?.choices?.[0]?.message?.content || "").trim();
      return { answer: answer || "No response." };
    } catch (e: any) {
      console.warn("[aiAssistant] request failed:", e?.message);
      return { answer: "Sorry — I couldn't reach the AI service. Please try again." };
    }
  },
});

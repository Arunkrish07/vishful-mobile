"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";

// ─── AI ASSISTANT ────────────────────────────────────────────────────────────
// The mobile Floating AI assistant calls api.aiAssistant.askAssistant({ question,
// history }) and expects { answer }. This routes to Claude (Anthropic) server-side
// with the key held in the Convex env var ANTHROPIC_API_KEY — the key never
// touches the client. Set it in the Convex dashboard → Settings → Environment
// Variables, then `npx convex deploy`.
//
// SCOPE: this is a read-only Q&A assistant (help, how-to, drafting). It does NOT
// yet have live database access or the web app's transactional command execution
// (create invoice / record payment / etc.) — that is a much larger follow-up.
// The system prompt tells the model to NOT invent live figures and to point the
// user at the relevant screen instead.

const SYSTEM_PROMPT = `You are the AI assistant inside "Vishful Spaces", a mobile property-management app for co-living / PG operators (properties, apartments, beds, tenants, maintenance tickets, accounting, and team management).

Help staff with how-to guidance, explanations, and drafting (announcements, messages, summaries).

Important: you do NOT have direct access to the live database. If the user asks for specific live numbers or records (e.g. "how many tenants do I have", "list overdue invoices", "who hasn't paid"), do not invent them — briefly say you can't read live data yet and point them to the relevant screen (Tenants, Tickets, Accounting, etc.).

Answer concisely and practically. Do not include any internal or system XML tags in your response.`;

export const askAssistant = action({
  args: {
    question: v.string(),
    history: v.optional(v.array(v.object({ role: v.string(), content: v.string() }))),
    organizationId: v.optional(v.string()),
    userId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, { question, history }) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { answer: "The AI assistant isn't configured yet — set ANTHROPIC_API_KEY in the Convex environment (Settings → Environment Variables) and redeploy." };
    }

    // Build the message list from history (which ends with the user's question),
    // dropping any leading non-user turns — Anthropic requires the first message
    // to be a user turn. Fall back to just the question if history is unusable.
    const msgs = (history || [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") {
      msgs.push({ role: "user", content: question });
    }

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 1024,
          thinking: { type: "disabled" }, // snappy Q&A; no tools, so no leakage risk
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
    } catch (e: any) {
      console.warn("[aiAssistant] request failed:", e?.message);
      return { answer: "Sorry — I couldn't reach the AI service. Please try again." };
    }
  },
});

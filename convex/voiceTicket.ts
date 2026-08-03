"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID, safeList } from "./lib/supabaseAdmin";
import { createTicketHelper } from "./tickets";

/**
 * Process a voice complaint transcript and create a Supabase ticket.
 * Called by:
 *   - Frontend (web voice recorder)
 *   - HTTP /api/voice-ticket endpoint (WhatsApp, mobile, external)
 */
export const processVoiceTicket = action({
  args: {
    transcription: v.string(),
    source: v.string(),
    tenantId: v.optional(v.string()),
    propertyId: v.optional(v.string()),
    apartmentId: v.optional(v.string()),
    bedId: v.optional(v.string()),
    tenantName: v.optional(v.string()),
    tenantPhone: v.optional(v.string()),
    apartmentCode: v.optional(v.string()),
    createdBy: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();

    // 1. Fetch available issue types for AI matching
    const issueTypes = await safeList(
      sb
        .from("issue_types")
        .select("id, name")
        .eq("organization_id", ORG_ID)
        .order("name", { ascending: true })
    );
    const issueTypeNames = issueTypes.map((it: any) => it.name);

    if (issueTypeNames.length === 0) {
      throw new Error(
        "No issue types configured. Please add issue types in Settings before using voice tickets."
      );
    }

    // 2. Call a0 LLM API to extract structured ticket data
    const llmResponse = await fetch("https://api.a0.dev/ai/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: `You are a property management ticket classifier for a co-living / PG accommodation company.
Given a voice complaint from a tenant, extract structured ticket data.

Available issue types: ${issueTypeNames.join(", ")}

Rules:
- summary: Write a clear, professional 1-2 sentence description of the maintenance issue.
- priority: Assess urgency:
    low = minor cosmetic / convenience issue
    medium = functional issue affecting daily use
    high = health or safety risk, or affecting multiple residents
    critical = emergency (fire, flood, gas leak, structural)
- issue_type: Choose the BEST match from the available issue types list above. Must be an exact name from the list.`,
          },
          {
            role: "user",
            content: `Voice complaint transcript:\n"${args.transcription}"`,
          },
        ],
        schema: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description: "Clear professional 1-2 sentence description of the issue",
            },
            priority: {
              type: "string",
              enum: ["low", "medium", "high", "critical"],
            },
            issue_type: {
              type: "string",
              description: "Best matching issue type from the available list",
            },
          },
          required: ["summary", "priority", "issue_type"],
        },
      }),
    });

    if (!llmResponse.ok) {
      console.error("[voiceTicket] LLM API error:", llmResponse.status);
      throw new Error("AI processing failed. Please try again.");
    }

    const llmResult = await llmResponse.json();
    const extracted = llmResult.schema_data || {};

    console.log("[voiceTicket] AI extracted:", JSON.stringify(extracted));

    // 3. Match extracted issue_type to a DB record
    const normalize = (s: string) => (s || "").toLowerCase().trim();
    const matchedType =
      issueTypes.find(
        (it: any) => normalize(it.name) === normalize(extracted.issue_type)
      ) ||
      issueTypes.find((it: any) =>
        normalize(it.name).includes(normalize(extracted.issue_type))
      ) ||
      issueTypes.find((it: any) =>
        normalize(extracted.issue_type).includes(normalize(it.name))
      ) ||
      issueTypes[0];

    // 4. Create ticket using shared helper (same flow as manual tickets)
    const ticket = await createTicketHelper({
      issue_type_id: matchedType.id,
      issue_type: matchedType.name,
      description: extracted.summary || args.transcription,
      priority: extracted.priority || "medium",
      tenant_id: args.tenantId || null,
      property_id: args.propertyId || null,
      apartment_id: args.apartmentId || null,
      bed_id: args.bedId || null,
      tenant_name: args.tenantName || null,
      tenant_phone: args.tenantPhone || null,
      apartment_code: args.apartmentCode || null,
      created_by: args.createdBy || null,
      source: args.source,
      voice_transcription: args.transcription,
    });

    return ticket;
  },
});

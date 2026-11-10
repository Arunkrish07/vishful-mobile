"use node";

/**
 * voiceProcessor.ts
 *
 * Reusable server-side voice ticket processor.
 * Handles: audio transcription (OpenAI), structured extraction (GPT-4.1),
 * and direct Supabase insert into maintenance_tickets.
 *
 * Used by: WhatsApp webhook, mobile voice, web voice — all via HTTP endpoints.
 * Convex is ONLY the compute runtime here. All data goes to Supabase.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID, safeList } from "./lib/supabaseAdmin";
import { createTicketHelper } from "./tickets";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VoiceProcessorInput {
  /** Raw audio as base64 string */
  audioBase64?: string;
  /** URL to download audio from (e.g. Meta/WhatsApp media URL) */
  audioUrl?: string;
  /** Pre-transcribed text (skip transcription step) */
  transcription?: string;
  /** Audio MIME type for transcription */
  mimeType?: string;
  /** Source channel */
  source: "whatsapp" | "mobile_voice" | "web_voice";
  /** Optional context */
  tenantId?: string;
  propertyId?: string;
  apartmentId?: string;
  bedId?: string;
  tenantName?: string;
  tenantPhone?: string;
  apartmentCode?: string;
  createdBy?: string;
  /** Caller-selected issue type (e.g. tenant picked a category). When set,
   *  this overrides AI issue-type classification. */
  issueTypeId?: string;
  issueType?: string;
}

export interface VoiceProcessorResult {
  ticketId: string;
  ticketNumber: string;
  transcription: string;
  extracted: {
    summary: string;
    priority: string;
    issue_type: string;
    department: string;
  };
}

// ─── Audio Transcription (OpenAI gpt-4o-mini-transcribe) ────────────────────

async function transcribeAudio(
  audioBase64: string,
  mimeType: string = "audio/webm"
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY not configured. Add it in Convex dashboard → Settings → Environment Variables."
    );
  }

  // Convert base64 to buffer
  const audioBuffer = Buffer.from(audioBase64, "base64");

  // Determine file extension from MIME
  const extMap: Record<string, string> = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "mp4",
    "audio/m4a": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/amr": "amr",
    "audio/ogg; codecs=opus": "ogg",
  };
  const ext = extMap[mimeType.toLowerCase()] || "webm";

  // Build multipart form data manually (no FormData in Node action context)
  const boundary = "----VoiceTicket" + Date.now();
  const fileName = `voice.${ext}`;

  const parts: Buffer[] = [];

  // model field
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-mini-transcribe\r\n`
    )
  );

  // language hint
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`
    )
  );

  // file field
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    )
  );
  parts.push(audioBuffer);
  parts.push(Buffer.from("\r\n"));

  // closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error("[voiceProcessor] Transcription failed:", response.status, errText);
    throw new Error(`Transcription failed (${response.status}): ${errText}`);
  }

  const result = await response.json();
  const text = result.text?.trim();

  if (!text) {
    throw new Error("Transcription returned empty text. Audio may be too short or silent.");
  }

  console.log("[voiceProcessor] Transcribed:", text.substring(0, 100));
  return text;
}

// ─── Download Audio from URL ────────────────────────────────────────────────

async function downloadAudioAsBase64(
  url: string,
  authToken?: string
): Promise<{ base64: string; mimeType: string }> {
  const headers: Record<string, string> = {};
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to download audio from URL (${response.status})`);
  }

  const contentType = response.headers.get("content-type") || "audio/ogg";
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");

  return { base64, mimeType: contentType };
}

// ─── GPT-4.1 Structured Extraction ─────────────────────────────────────────

async function extractTicketData(
  transcription: string,
  issueTypeNames: string[]
): Promise<{
  summary: string;
  priority: string;
  issue_type: string;
  department: string;
}> {
  // Use a0 LLM API for extraction (no API key needed)
  const llmResponse = await fetch("https://api.a0.dev/ai/llm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: `You are a property management ticket classifier for a co-living / PG accommodation company.
Given a voice complaint transcript from a tenant, extract structured ticket data.

Available issue types: ${issueTypeNames.join(", ")}

Rules:
- summary: Write a clear, professional 1-2 sentence description of the maintenance issue.
- priority: Assess urgency:
    low = minor cosmetic / convenience issue
    medium = functional issue affecting daily use
    high = health or safety risk, or affecting multiple residents
    critical = emergency (fire, flood, gas leak, structural)
- issue_type: Choose the BEST match from the available issue types list above. Must be an exact name from the list.
- department: Classify which department should handle this: "maintenance", "housekeeping", "plumbing", "electrical", "carpentry", "pest_control", "security", "admin", "other"`,
        },
        {
          role: "user",
          content: `Voice complaint transcript:\n"${transcription}"`,
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
          department: {
            type: "string",
            enum: [
              "maintenance",
              "housekeeping",
              "plumbing",
              "electrical",
              "carpentry",
              "pest_control",
              "security",
              "admin",
              "other",
            ],
          },
        },
        required: ["summary", "priority", "issue_type", "department"],
      },
    }),
  });

  if (!llmResponse.ok) {
    console.error("[voiceProcessor] LLM API error:", llmResponse.status);
    throw new Error("AI extraction failed. Please try again.");
  }

  const llmResult = await llmResponse.json();
  const extracted = llmResult.schema_data || {};

  console.log("[voiceProcessor] Extracted:", JSON.stringify(extracted));

  return {
    summary: extracted.summary || transcription,
    priority: extracted.priority || "medium",
    issue_type: extracted.issue_type || "",
    department: extracted.department || "maintenance",
  };
}

// ─── Main Processor (reusable by all sources) ───────────────────────────────

export async function processVoiceTicketDirect(
  input: VoiceProcessorInput
): Promise<VoiceProcessorResult> {
  const sb = getSupabase();

  // Step 1: Get transcription
  let transcription = input.transcription || "";

  if (!transcription) {
    // Need to transcribe audio
    let audioBase64 = input.audioBase64 || "";
    let mimeType = input.mimeType || "audio/webm";

    if (!audioBase64 && input.audioUrl) {
      // Download audio from URL (used by WhatsApp)
      const whatsappToken = process.env.WHATSAPP_TOKEN;
      const downloaded = await downloadAudioAsBase64(
        input.audioUrl,
        whatsappToken || undefined
      );
      audioBase64 = downloaded.base64;
      mimeType = downloaded.mimeType;
    }

    if (!audioBase64) {
      throw new Error(
        "No audio provided. Send audioBase64, audioUrl, or transcription."
      );
    }

    transcription = await transcribeAudio(audioBase64, mimeType);
  }

  // Step 2: Fetch available issue types for AI matching
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

  // Step 3: Extract structured data via GPT
  const extracted = await extractTicketData(transcription, issueTypeNames);

  // Step 4: Match issue_type to a DB record.
  // If the caller explicitly picked an issue type (e.g. the tenant chose a
  // category), honor that selection and skip AI classification.
  const normalize = (s: string) => (s || "").toLowerCase().trim();
  const callerSelected =
    (input.issueTypeId && issueTypes.find((it: any) => it.id === input.issueTypeId)) ||
    (input.issueType && issueTypes.find((it: any) => normalize(it.name) === normalize(input.issueType!)));
  const matchedType =
    callerSelected ||
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

  // Step 5: Create ticket directly in Supabase via shared helper
  const ticket = await createTicketHelper({
    issue_type_id: matchedType.id,
    issue_type: matchedType.name,
    description: extracted.summary || transcription,
    priority: extracted.priority || "medium",
    tenant_id: input.tenantId || null,
    property_id: input.propertyId || null,
    apartment_id: input.apartmentId || null,
    bed_id: input.bedId || null,
    tenant_name: input.tenantName || null,
    tenant_phone: input.tenantPhone || null,
    apartment_code: input.apartmentCode || null,
    created_by: input.createdBy || null,
    source: input.source,
    voice_transcription: transcription,
  });

  return {
    ticketId: ticket.id,
    ticketNumber: ticket.ticket_number,
    transcription,
    extracted: {
      summary: extracted.summary,
      priority: extracted.priority,
      issue_type: matchedType.name,
      department: extracted.department,
    },
  };
}

// ─── Convex Internal Action (callable from HTTP handlers) ───────────────────

export const processVoice = internalAction({
  args: {
    audioBase64: v.optional(v.string()),
    audioUrl: v.optional(v.string()),
    transcription: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    source: v.string(),
    tenantId: v.optional(v.string()),
    propertyId: v.optional(v.string()),
    apartmentId: v.optional(v.string()),
    bedId: v.optional(v.string()),
    tenantName: v.optional(v.string()),
    tenantPhone: v.optional(v.string()),
    apartmentCode: v.optional(v.string()),
    createdBy: v.optional(v.string()),
    issueTypeId: v.optional(v.string()),
    issueType: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    return processVoiceTicketDirect({
      audioBase64: args.audioBase64,
      audioUrl: args.audioUrl,
      transcription: args.transcription,
      mimeType: args.mimeType,
      source: args.source as VoiceProcessorInput["source"],
      tenantId: args.tenantId,
      propertyId: args.propertyId,
      apartmentId: args.apartmentId,
      bedId: args.bedId,
      tenantName: args.tenantName,
      tenantPhone: args.tenantPhone,
      apartmentCode: args.apartmentCode,
      createdBy: args.createdBy,
      issueTypeId: args.issueTypeId,
      issueType: args.issueType,
    });
  },
});

// ─── Transcription-Only Action (used by mobile RaiseTicketScreen) ───────────

export const transcribeOnly = internalAction({
  args: {
    audioBase64: v.string(),
    mimeType: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (_ctx, args) => {
    return transcribeAudio(args.audioBase64, args.mimeType || "audio/m4a");
  },
});

// ─── WhatsApp Audio Handler (downloads media, then processes) ───────────────

export const processWhatsAppAudio = internalAction({
  args: {
    mediaId: v.string(),
    mimeType: v.optional(v.string()),
    senderPhone: v.string(),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const whatsappToken = process.env.WHATSAPP_TOKEN;
    if (!whatsappToken) {
      throw new Error(
        "WHATSAPP_TOKEN not configured. Add it in Convex dashboard → Settings → Environment Variables."
      );
    }

    // Step 1: Get media download URL from Meta Graph API
    const mediaResp = await fetch(
      `https://graph.facebook.com/v19.0/${args.mediaId}`,
      { headers: { Authorization: `Bearer ${whatsappToken}` } }
    );

    if (!mediaResp.ok) {
      const errText = await mediaResp.text();
      throw new Error(`Failed to get WhatsApp media URL (${mediaResp.status}): ${errText}`);
    }

    const mediaData = await mediaResp.json();
    const audioUrl = mediaData.url;
    const mimeType = args.mimeType || mediaData.mime_type || "audio/ogg";

    // Step 2: Download audio
    const audioResp = await fetch(audioUrl, {
      headers: { Authorization: `Bearer ${whatsappToken}` },
    });

    if (!audioResp.ok) {
      throw new Error(`Failed to download WhatsApp audio (${audioResp.status})`);
    }

    const arrayBuffer = await audioResp.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuffer).toString("base64");

    console.log(`[whatsapp] Downloaded audio for ${args.senderPhone}, size: ${arrayBuffer.byteLength} bytes`);

    // Step 3: Process through unified pipeline
    return processVoiceTicketDirect({
      audioBase64,
      mimeType,
      source: "whatsapp",
      tenantPhone: args.senderPhone,
    });
  },
});
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const http = httpRouter();

// ─── CORS headers helper ──────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ─── OTP: Send ───────────────────────────────────────────────────────────────
// POST /api/send-otp
// Body: { phone: string }
// Bypasses Convex action registry — callable from client without `npx convex dev`.

http.route({
  path: "/api/send-otp",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const { phone } = await req.json();
      if (!phone) return jsonResponse({ success: false, message: "phone is required" }, 400);
      const result = await ctx.runAction(api.otpAuth.sendOtp, { phone });
      return jsonResponse(result);
    } catch (e: any) {
      return jsonResponse({ success: false, message: e?.message || "Failed to send OTP" }, 500);
    }
  }),
});

http.route({
  path: "/api/send-otp",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS })),
});

// ─── OTP: Verify ─────────────────────────────────────────────────────────────
// POST /api/verify-otp
// Body: { phone: string, otp: string }

http.route({
  path: "/api/verify-otp",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const { phone, otp } = await req.json();
      if (!phone || !otp) return jsonResponse({ success: false, message: "phone and otp are required" }, 400);
      const result = await ctx.runAction(api.otpAuth.verifyOtpAndLogin, { phone, otp });
      return jsonResponse(result);
    } catch (e: any) {
      return jsonResponse({ success: false, message: e?.message || "Verification failed" }, 500);
    }
  }),
});

http.route({
  path: "/api/verify-otp",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS })),
});

// ─── Session: Validate ────────────────────────────────────────────────────────
// POST /api/get-session
// Body: { token: string }

http.route({
  path: "/api/get-session",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const { token } = await req.json();
      if (!token) return jsonResponse({ valid: false }, 400);
      const result = await ctx.runAction(api.otpAuth.getSession, { token });
      return jsonResponse(result);
    } catch (e: any) {
      return jsonResponse({ valid: false }, 500);
    }
  }),
});

http.route({
  path: "/api/get-session",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS })),
});

// ─── Voice Ticket (text-only, existing) ───────────────────────────────────────
// POST /api/voice-ticket
// Accepts: { transcription, source?, tenant_id?, ... }

http.route({
  path: "/api/voice-ticket",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const body = await req.json();

      if (!body.transcription) {
        return jsonResponse({ error: "transcription field is required" }, 400);
      }

      const ticket = await ctx.runAction(api.voiceTicket.processVoiceTicket, {
        transcription: body.transcription,
        source: body.source || "api",
        tenantId: body.tenant_id || body.tenantId,
        propertyId: body.property_id || body.propertyId,
        apartmentId: body.apartment_id || body.apartmentId,
        bedId: body.bed_id || body.bedId,
        tenantName: body.tenant_name || body.tenantName,
        tenantPhone: body.tenant_phone || body.tenantPhone,
        apartmentCode: body.apartment_code || body.apartmentCode,
        createdBy: body.created_by || body.createdBy,
      });

      return jsonResponse({ success: true, ticket });
    } catch (error: any) {
      return jsonResponse({ error: error?.message || "Internal server error" }, 500);
    }
  }),
});

http.route({
  path: "/api/voice-ticket",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS })),
});

// ─── Voice Ticket Direct (audio + text, NEW) ─────────────────────────────────
// POST /api/voice-ticket-direct
// Accepts:
//   { audioBase64, mimeType?, source, ... }  — audio as base64
//   { audioUrl, source, ... }                — audio URL to download
//   { transcription, source, ... }           — pre-transcribed text
// All insert directly into Supabase maintenance_tickets.

http.route({
  path: "/api/voice-ticket-direct",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const body = await req.json();

      if (!body.audioBase64 && !body.audioUrl && !body.transcription) {
        return jsonResponse(
          { error: "Provide one of: audioBase64, audioUrl, or transcription" },
          400
        );
      }

      const validSources = ["whatsapp", "mobile_voice", "web_voice"];
      const source = body.source || "mobile_voice";
      if (!validSources.includes(source)) {
        return jsonResponse(
          { error: `Invalid source. Must be one of: ${validSources.join(", ")}` },
          400
        );
      }

      const result = await ctx.runAction(internal.voiceProcessor.processVoice, {
        audioBase64: body.audioBase64 || body.audio_base64,
        audioUrl: body.audioUrl || body.audio_url,
        transcription: body.transcription,
        mimeType: body.mimeType || body.mime_type || "audio/webm",
        source,
        tenantId: body.tenantId || body.tenant_id,
        propertyId: body.propertyId || body.property_id,
        apartmentId: body.apartmentId || body.apartment_id,
        bedId: body.bedId || body.bed_id,
        tenantName: body.tenantName || body.tenant_name,
        tenantPhone: body.tenantPhone || body.tenant_phone,
        apartmentCode: body.apartmentCode || body.apartment_code,
        createdBy: body.createdBy || body.created_by,
        issueTypeId: body.issueTypeId || body.issue_type_id,
        issueType: body.issueType || body.issue_type,
      });

      return jsonResponse({
        success: true,
        ticketId: result.ticketId,
        ticketNumber: result.ticketNumber,
        transcription: result.transcription,
        extracted: result.extracted,
      });
    } catch (error: any) {
      console.error("[voice-ticket-direct]", error?.message);
      return jsonResponse({ error: error?.message || "Internal server error" }, 500);
    }
  }),
});

http.route({
  path: "/api/voice-ticket-direct",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS })),
});

// ─── Transcription Only (returns text, no ticket creation) ────────────────────
// POST /api/transcribe
// Accepts: { audioBase64, mimeType? }
// Returns: { success: true, transcription: "..." }

http.route({
  path: "/api/transcribe",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const body = await req.json();

      if (!body.audioBase64) {
        return jsonResponse({ error: "audioBase64 is required" }, 400);
      }

      const transcription = await ctx.runAction(
        internal.voiceProcessor.transcribeOnly,
        {
          audioBase64: body.audioBase64,
          mimeType: body.mimeType || "audio/m4a",
        }
      );

      return jsonResponse({ success: true, transcription });
    } catch (error: any) {
      console.error("[transcribe]", error?.message);
      return jsonResponse(
        { error: error?.message || "Transcription failed" },
        500
      );
    }
  }),
});

http.route({
  path: "/api/transcribe",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS })),
});

// ─── WhatsApp Webhook ─────────────────────────────────────────────────────────
// GET  /api/whatsapp/webhook — Meta verification challenge
// POST /api/whatsapp/webhook — Incoming messages

http.route({
  path: "/api/whatsapp/webhook",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    // Verify token must match env var WHATSAPP_VERIFY_TOKEN
    const verifyToken = "vishful_whatsapp_verify_2024"; // Change in production

    if (mode === "subscribe" && token === verifyToken) {
      console.log("[whatsapp] Webhook verified");
      return new Response(challenge || "", { status: 200 });
    }

    return new Response("Forbidden", { status: 403 });
  }),
});

http.route({
  path: "/api/whatsapp/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const body = await req.json();

      // Meta sends: { object, entry: [{ changes: [{ value: { messages: [...] } }] }] }
      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;

      if (!messages || messages.length === 0) {
        // Not a message event (could be status update, etc.)
        return jsonResponse({ status: "ok" });
      }

      for (const message of messages) {
        const from = message.from; // sender phone number
        const messageType = message.type;

        // Only process audio messages
        if (messageType !== "audio") {
          console.log(`[whatsapp] Ignoring non-audio message type: ${messageType}`);
          continue;
        }

        const audioId = message.audio?.id;
        if (!audioId) {
          console.log("[whatsapp] Audio message without media ID, skipping");
          continue;
        }

        const mimeType = message.audio?.mime_type || "audio/ogg";

        console.log(`[whatsapp] Processing audio ${audioId} from ${from}`);

        // Delegate to internal action (runs in Node.js, has env access)
        try {
          await ctx.runAction(internal.voiceProcessor.processWhatsAppAudio, {
            mediaId: audioId,
            mimeType,
            senderPhone: from,
          });
          console.log(`[whatsapp] Ticket created for ${from}`);
        } catch (err: any) {
          console.error(`[whatsapp] Failed to process audio from ${from}:`, err?.message);
        }
      }

      return jsonResponse({ status: "ok" });
    } catch (error: any) {
      console.error("[whatsapp] Webhook error:", error?.message);
      // Always return 200 to Meta to avoid retries
      return jsonResponse({ status: "error", message: error?.message });
    }
  }),
});

http.route({
  path: "/api/whatsapp/webhook",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS })),
});

export default http;
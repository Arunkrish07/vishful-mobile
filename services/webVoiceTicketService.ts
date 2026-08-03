/**
 * webVoiceTicketService.ts
 *
 * Frontend service for submitting voice tickets from a web application.
 * Sends audio directly to the Convex HTTP endpoint which processes and inserts
 * into Supabase maintenance_tickets. No Convex client SDK needed.
 *
 * This service is designed for web browsers (File/Blob APIs).
 * For React Native mobile, use mobileVoiceTicketService.ts instead.
 */

const VOICE_TICKET_URL = "https://wonderful-kiwi-122.convex.site/api/voice-ticket-direct";

export interface WebVoiceTicketParams {
  /** Audio file or blob from MediaRecorder / file input */
  audioBlob?: Blob;
  /** Or provide base64 directly */
  audioBase64?: string;
  /** Or provide pre-transcribed text */
  transcription?: string;
  /** MIME type (auto-detected from blob if not provided) */
  mimeType?: string;
  /** Tenant context */
  tenantId?: string;
  propertyId?: string;
  apartmentId?: string;
  bedId?: string;
  tenantName?: string;
  tenantPhone?: string;
  apartmentCode?: string;
  createdBy?: string;
}

export interface VoiceTicketResult {
  success: boolean;
  ticketId?: string;
  ticketNumber?: string;
  transcription?: string;
  extracted?: {
    summary: string;
    priority: string;
    issue_type: string;
    department: string;
  };
  error?: string;
}

/**
 * Convert a Blob to base64 string (browser environment).
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Strip data URL prefix: "data:audio/webm;base64,..."
      const base64 = result.split(",")[1] || result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Submit a voice recording from a web app as a ticket.
 */
export async function submitWebVoiceTicket(
  params: WebVoiceTicketParams
): Promise<VoiceTicketResult> {
  try {
    let audioBase64 = params.audioBase64;
    let mimeType = params.mimeType;

    // Convert blob to base64 if provided
    if (!audioBase64 && params.audioBlob) {
      audioBase64 = await blobToBase64(params.audioBlob);
      mimeType = mimeType || params.audioBlob.type || "audio/webm";
    }

    if (!audioBase64 && !params.transcription) {
      return {
        success: false,
        error: "Provide audioBlob, audioBase64, or transcription",
      };
    }

    const response = await fetch(VOICE_TICKET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioBase64: audioBase64 || undefined,
        transcription: params.transcription || undefined,
        mimeType: mimeType || "audio/webm",
        source: "web_voice",
        tenantId: params.tenantId,
        propertyId: params.propertyId,
        apartmentId: params.apartmentId,
        bedId: params.bedId,
        tenantName: params.tenantName,
        tenantPhone: params.tenantPhone,
        apartmentCode: params.apartmentCode,
        createdBy: params.createdBy,
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      return {
        success: false,
        error: data.error || `Server error (${response.status})`,
      };
    }

    return {
      success: true,
      ticketId: data.ticketId,
      ticketNumber: data.ticketNumber,
      transcription: data.transcription,
      extracted: data.extracted,
    };
  } catch (error: any) {
    console.error("[webVoiceTicket] Error:", error?.message);
    return {
      success: false,
      error: error?.message || "Failed to submit voice ticket",
    };
  }
}

/**
 * Submit a text complaint from a web app.
 */
export async function submitWebTextTicket(
  transcription: string,
  params: Omit<WebVoiceTicketParams, "audioBlob" | "audioBase64" | "transcription" | "mimeType"> = {}
): Promise<VoiceTicketResult> {
  return submitWebVoiceTicket({ ...params, transcription });
}
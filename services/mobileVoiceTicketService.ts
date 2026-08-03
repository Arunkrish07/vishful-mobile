/**
 * mobileVoiceTicketService.ts
 *
 * Frontend service for recording and submitting voice tickets from the mobile app.
 * Sends audio directly to the Convex HTTP endpoint which processes and inserts
 * into Supabase maintenance_tickets. No Convex client SDK needed.
 */

const VOICE_TICKET_URL = "https://wonderful-kiwi-122.convex.site/api/voice-ticket-direct";

export interface MobileVoiceTicketParams {
  /** Base64-encoded audio from expo-av or other recorder */
  audioBase64: string;
  /** MIME type of the recorded audio */
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
 * Submit a voice recording from the mobile app as a ticket.
 * Records audio → sends base64 → server transcribes → extracts → inserts to Supabase.
 */
export async function submitMobileVoiceTicket(
  params: MobileVoiceTicketParams
): Promise<VoiceTicketResult> {
  try {
    const response = await fetch(VOICE_TICKET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioBase64: params.audioBase64,
        mimeType: params.mimeType || "audio/m4a",
        source: "mobile_voice",
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
    console.error("[mobileVoiceTicket] Error:", error?.message);
    return {
      success: false,
      error: error?.message || "Failed to submit voice ticket",
    };
  }
}

/**
 * Submit a pre-transcribed text complaint from the mobile app.
 * Useful when transcription is done client-side or user types complaint.
 */
export async function submitMobileTextTicket(
  transcription: string,
  params: Omit<MobileVoiceTicketParams, "audioBase64" | "mimeType"> = {}
): Promise<VoiceTicketResult> {
  try {
    const response = await fetch(VOICE_TICKET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcription,
        source: "mobile_voice",
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
    console.error("[mobileTextTicket] Error:", error?.message);
    return {
      success: false,
      error: error?.message || "Failed to submit text ticket",
    };
  }
}
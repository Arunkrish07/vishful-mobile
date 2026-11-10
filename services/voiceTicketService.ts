/**
 * voiceTicketService.ts
 * Frontend service for submitting voice complaints via Convex → Supabase.
 * Used by all sources: web_voice, mobile_voice, whatsapp.
 */
import { client, api } from "../lib/convexApi";

export interface VoiceTicketParams {
  transcription: string;
  source: string; // "web_voice" | "mobile_voice" | "whatsapp"
  tenantId?: string;
  propertyId?: string;
  apartmentId?: string;
  bedId?: string;
  tenantName?: string;
  tenantPhone?: string;
  apartmentCode?: string;
  createdBy?: string;
}

export async function submitVoiceTicket(params: VoiceTicketParams): Promise<any> {
  return client.action(api.voiceTicket.processVoiceTicket, {
    transcription: params.transcription,
    source: params.source,
    tenantId: params.tenantId,
    propertyId: params.propertyId,
    apartmentId: params.apartmentId,
    bedId: params.bedId,
    tenantName: params.tenantName,
    tenantPhone: params.tenantPhone,
    apartmentCode: params.apartmentCode,
    createdBy: params.createdBy,
  });
}

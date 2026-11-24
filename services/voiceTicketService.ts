/**
 * voiceTicketService.ts
 * Submits voice complaints via the Supabase `tenant-voice-action` edge function
 * (no Convex). Used by all sources: web_voice, mobile_voice, whatsapp.
 */
import { supabase } from "../lib/supabase";

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
  const { data, error } = await supabase.functions.invoke("tenant-voice-action", {
    body: {
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
    },
  });
  if (error) throw error;
  return data;
}

/**
 * ticketService.ts
 * Routes all ticket operations through Convex actions → Supabase.
 * No direct Supabase calls from client.
 */
import { client, api } from "../lib/convexApi";
import { supabase } from "../lib/supabase"; // direct client for Storage only

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface Ticket {
  id: string;
  organization_id: string;
  ticket_number: string;
  tenant_id: string | null;
  property_id?: string | null;
  apartment_id?: string | null;
  bed_id?: string | null;
  issue_type_id: string;
  issue_type?: string | null;
  issue_subtype?: string | null;
  description?: string | null;
  priority: string;
  status: string;
  assigned_to?: string | null;
  assigned_to_name?: string | null;
  assigned_to_phone?: string | null;
  sla_deadline?: string | null;
  resolved_at?: string | null;
  closed_at?: string | null;
  completed_at?: string | null;
  tenant_approved?: boolean | null;
  tenant_rejection_reason?: string | null;
  tenant_name?: string | null;
  tenant_phone?: string | null;
  photo_urls?: string[] | null;
  diagnostic_data?: any;
  diagnosis?: string | null;
  estimated_cost?: number | null;
  created_by?: string | null;
  created_at: string;
  updated_at?: string | null;
  apartment_code?: string | null;
  apartment?: string | null;
  cost_submitted_at?: string | null;
  source?: string | null;           // 'admin' when raised by admin/PM, null/undefined for tenant-raised
}

export interface CostEstimate {
  id: string;
  ticket_id: string;
  item_name: string;
  cost_type: string;
  quantity: number;
  unit_price: number;
  total: number;
  status: string;
  submitted_by: string;
  approved_by?: string | null;
  approved_at?: string | null;
  decline_reason?: string | null;
  created_at: string;
}

export interface TicketLog {
  id: string;
  ticket_id: string;
  action: string;
  old_status?: string | null;
  new_status?: string | null;
  notes?: string | null;
  performed_by?: string | null;
  created_by?: string | null;
  created_at: string;
  cost_item?: string | null;
  cost_quantity?: number | null;
  cost_unit_price?: number | null;
  cost_total?: number | null;
  photo_urls?: string[] | string | null;
}

export interface IssueType {
  id: string;
  name: string;
  icon: string;
  priority: string;
  sla_hours: number;
}

export interface IssueSubType {
  id: string;
  issue_type_id: string;
  name: string;
  icon: string;
  description?: string | null;
}

export interface TeamMember {
  id: string;
  user_id: string;
  first_name?: string;
  last_name?: string;
  designation?: string;
  status: string;
  phone?: string;
}

// ─── STATUS CONFIG ────────────────────────────────────────────────────────────

export const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  open:                    { label: "Open",              color: "#7B6B90", bg: "#F3F0F9", icon: "radio-button-off-outline" },
  assigned:                { label: "Assigned",          color: "#2563EB", bg: "#DBEAFE", icon: "person-outline" },
  in_progress:             { label: "In Progress",       color: "#D97706", bg: "#FEF3C7", icon: "construct-outline" },
  waiting_for_parts:       { label: "Waiting Parts",     color: "#2563EB", bg: "#EFF6FF", icon: "cube-outline" },
  waiting_for_cost_approval:{ label: "Awaiting Approval", color: "#DC2626", bg: "#FEE2E2", icon: "timer-outline" },
  completed:               { label: "Completed",         color: "#16A34A", bg: "#DCFCE7", icon: "checkmark-circle-outline" },
  pending_tenant_approval: { label: "Pending Approval",  color: "#EA580C", bg: "#FFEDD5", icon: "hourglass-outline" },
  pending_admin_approval:  { label: "Pending Review",    color: "#BE185D", bg: "#FCE7F3", icon: "eye-outline" },
  closed:                  { label: "Closed",            color: "#374151", bg: "#E5E7EB", icon: "lock-closed-outline" },
  reassigned:              { label: "Reassigned",        color: "#0284C7", bg: "#E0F2FE", icon: "swap-horizontal-outline" },
  reopened:                { label: "Reopened",          color: "#D97706", bg: "#FEF3C7", icon: "refresh-outline" },
  on_hold:                 { label: "On Hold",           color: "#64748B", bg: "#F1F5F9", icon: "pause-circle-outline" },
  cancelled:               { label: "Cancelled",         color: "#B91C1C", bg: "#FEE2E2", icon: "close-circle-outline" },
};

export const PRIORITY_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  low:      { label: "Low",      color: "#16A34A", bg: "#DCFCE7" },
  medium:   { label: "Medium",   color: "#D97706", bg: "#FEF3C7" },
  high:     { label: "High",     color: "#DC2626", bg: "#FEE2E2" },
  critical: { label: "Critical", color: "#7C2D12", bg: "#FEE2E2" },
};

export function normalizeRole(role: string): "admin" | "technician" | "tenant" {
  if (role === "technician") return "technician";
  if (role === "tenant") return "tenant";
  if (["org_admin","super_admin","property_manager","admin","pm"].includes(role)) return "admin";
  return "admin";
}

export function getNextStatuses(currentStatus: string, role: string): string[] {
  const r = normalizeRole(role);
  if (r === "technician") {
    const map: Record<string, string[]> = {
      // "assigned" no longer has in_progress — Start Work button removed
      assigned:                ["waiting_for_parts", "completed", "reassigned"],
      in_progress:             ["waiting_for_parts", "completed", "reassigned"],
      waiting_for_parts:       ["in_progress"],
      reassigned:              ["assigned", "in_progress"],
    };
    return map[currentStatus] || [];
  }
  if (r === "admin") {
    const map: Record<string, string[]> = {
      open:                      ["assigned", "on_hold", "cancelled"],
      assigned:                  ["on_hold", "cancelled"],
      in_progress:               ["on_hold", "cancelled"],
      waiting_for_parts:         ["on_hold", "cancelled"],
      waiting_for_cost_approval: ["on_hold", "cancelled"],
      reopened:                  ["on_hold", "cancelled"],
      on_hold:                   ["in_progress", "cancelled"],
      pending_admin_approval:    ["closed", "in_progress"],
      closed:                    ["reopened"],
      completed:                 ["reopened"],
    };
    return map[currentStatus] || [];
  }
  if (r === "tenant") {
    const map: Record<string, string[]> = {
      pending_tenant_approval: ["closed", "in_progress"],
    };
    return map[currentStatus] || [];
  }
  return [];
}

// ─── PHOTO UPLOAD (Supabase Storage) ─────────────────────────────────────────

/**
 * Uploads a single photo to Supabase Storage bucket "ticket-photos"
 * and returns the public URL, or null on failure.
 *
 * SUPABASE SETUP REQUIRED:
 *   1. Create a Storage bucket named "ticket-photos" (public read)
 *   2. Add RLS policy: allow insert for authenticated + anon users
 *
 * The bucket path is: ticket-photos/{timestamp}_{random}.jpg
 */
export async function uploadTicketPhoto(
  uri: string,
  base64?: string,
  mimeType: string = "image/jpeg"
): Promise<string | null> {
  try {
    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
    const filePath = `tickets/${fileName}`;

    let uploadData: Blob | ArrayBuffer;

    if (base64) {
      // Convert base64 to Uint8Array for React Native
      const byteChars = atob(base64);
      const byteArr = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) {
        byteArr[i] = byteChars.charCodeAt(i);
      }
      uploadData = byteArr.buffer;
    } else {
      // Fallback: fetch the local URI as blob (works in Expo)
      const response = await fetch(uri);
      uploadData = await response.blob();
    }

    const { error } = await supabase.storage
      .from("ticket-photos")
      .upload(filePath, uploadData, {
        contentType: mimeType,
        upsert: false,
      });

    if (error) {
      console.warn("[uploadTicketPhoto] Upload error:", error.message);
      return null;
    }

    const { data } = supabase.storage.from("ticket-photos").getPublicUrl(filePath);
    return data?.publicUrl ?? null;
  } catch (err: any) {
    console.warn("[uploadTicketPhoto] Exception:", err?.message);
    return null;
  }
}

// ─── API FUNCTIONS ────────────────────────────────────────────────────────────

export async function fetchTickets(role: string, userId?: string, tenantId?: string): Promise<Ticket[]> {
  try {
    return await client.action(api.tickets.listTickets, { role, userId, tenantId });
  } catch (e: any) {
    console.warn("[ticketService] fetchTickets:", e?.message);
    return [];
  }
}

export async function fetchTicket(ticketId: string): Promise<Ticket | null> {
  try {
    return await client.action(api.tickets.getTicket, { ticketId });
  } catch (e: any) {
    console.warn("[ticketService] fetchTicket:", e?.message);
    return null;
  }
}

export async function fetchTicketLogs(ticketId: string): Promise<TicketLog[]> {
  try {
    return await client.action(api.tickets.getTicketLogs, { ticketId });
  } catch (e: any) {
    console.warn("[ticketService] fetchTicketLogs:", e?.message);
    return [];
  }
}

export async function createTicket(data: Partial<Ticket> & { issue_type_id: string }): Promise<Ticket> {
  return client.action(api.tickets.createTicket, { data });
}

export async function updateTicketStatus(
  ticketId: string,
  newStatus: string,
  userId: string,
  options?: { notes?: string; rejectionReason?: string }
): Promise<{ success: boolean; newStatus: string }> {
  return client.action(api.tickets.updateTicketStatus, {
    ticketId, newStatus, userId,
    notes: options?.notes, rejectionReason: options?.rejectionReason,
  });
}

export async function reassignTicket(
  ticketId: string, newAssigneeId: string, userId: string, notes?: string
): Promise<{ success: boolean }> {
  return client.action(api.tickets.reassignTicket, { ticketId, newAssigneeId, userId, notes });
}

export async function submitDiagnosis(args: {
  ticketId: string; issueTypeId: string; questionsAnswers: Record<string, string>;
  aiDiagnosis?: string; employeeOverride?: string; performedBy: string;
}): Promise<{ success: boolean }> {
  return client.action(api.tickets.submitDiagnosis, args);
}

export async function fetchCostEstimates(ticketId: string): Promise<CostEstimate[]> {
  try {
    return await client.action(api.tickets.getCostEstimates, { ticketId });
  } catch (e: any) {
    return [];
  }
}

export async function submitCostEstimates(
  ticketId: string,
  items: { item_name: string; cost_type: string; quantity: number; unit_price: number }[],
  submittedBy: string
): Promise<{ success: boolean }> {
  return client.action(api.tickets.submitCostEstimates, { ticketId, items, submittedBy });
}

export async function approveCostEstimate(args: {
  estimateId: string; ticketId: string;
  action: "approve" | "decline"; approvedBy: string;
  declineReason?: string; modifiedQuantity?: number; modifiedUnitPrice?: number;
}): Promise<{ success: boolean; newTicketStatus: string | null }> {
  return client.action(api.tickets.approveCostEstimate, args);
}

export async function recordPurchase(args: {
  ticketId: string; items: any[]; vendorId?: string;
  vendorNameManual?: string; invoiceUrl?: string;
  purchasedBy: string; costEstimateId?: string;
}): Promise<{ success: boolean }> {
  return client.action(api.tickets.recordPurchase, args);
}

export async function fetchPurchases(ticketId: string): Promise<any[]> {
  try {
    return await client.action(api.tickets.getPurchases, { ticketId });
  } catch (e: any) {
    return [];
  }
}

export async function tenantApproveCompletion(
  ticketId: string, approved: boolean, userId: string, rejectionReason?: string
): Promise<{ success: boolean }> {
  return client.action(api.tickets.tenantApproveCompletion, { ticketId, approved, userId, rejectionReason });
}

export async function adminApproveCompletion(
  ticketId: string, approved: boolean, userId: string, rejectionReason?: string
): Promise<{ success: boolean }> {
  return client.action(api.tickets.adminApproveCompletion, { ticketId, approved, userId, rejectionReason });
}

export async function fetchIssueTypes(): Promise<IssueType[]> {
  try {
    return await client.action(api.tickets.getIssueTypes, {});
  } catch (e: any) {
    return [];
  }
}

export async function fetchAssetTypesLite(): Promise<{ id: string; name: string }[]> {
  try { return await client.action((api as any).tickets.listAssetTypesLite, {}); }
  catch { return []; }
}

export async function updateIssueType(args: {
  issueTypeId: string; name?: string; icon?: string; priority?: string; slaHours?: number; assetTypeIds?: string[];
}): Promise<any> {
  return client.action((api as any).tickets.updateIssueType, args);
}

export async function deleteIssueType(issueTypeId: string): Promise<any> {
  return client.action((api as any).tickets.deleteIssueType, { issueTypeId });
}

export async function fetchIssueSubTypes(issueTypeId: string): Promise<IssueSubType[]> {
  try {
    return await client.action(api.tickets.getIssueSubTypes, { issueTypeId });
  } catch (e: any) {
    return [];
  }
}

export async function fetchTeamMembers(): Promise<TeamMember[]> {
  try {
    return await client.action(api.tickets.getTeamMembers, {});
  } catch (e: any) {
    return [];
  }
}

export async function fetchDiagnosticSession(ticketId: string): Promise<any | null> {
  try {
    return await client.action(api.tickets.getDiagnosticSession, { ticketId });
  } catch (e: any) {
    return null;
  }
}

export async function checkTenantPendingTickets(tenantId: string): Promise<{ hasPending: boolean; tickets: any[] }> {
  try {
    return await client.action(api.tickets.checkTenantPendingTickets, { tenantId });
  } catch (e: any) {
    return { hasPending: false, tickets: [] };
  }
}

export async function fetchProperties(): Promise<any[]> {
  try { return await client.action(api.tickets.getProperties, {}); } catch { return []; }
}

export async function fetchApartments(propertyId: string): Promise<any[]> {
  try { return await client.action(api.tickets.getApartments, { propertyId }); } catch { return []; }
}

export async function fetchBeds(apartmentId: string): Promise<any[]> {
  try { return await client.action(api.tickets.getBeds, { apartmentId }); } catch { return []; }
}

// ─── KYC DOCUMENT UPLOAD ──────────────────────────────────────────────────────
export async function uploadKycPhoto(
  uri: string,
  side: 'front' | 'back',
  tenantId: string,
  base64?: string,
  mimeType: string = 'image/jpeg'
): Promise<string | null> {
  try {
    const BUCKET = 'kyc-docs';
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const fileName = `${tenantId}_${side}_${Date.now()}.${ext}`;
    const filePath = `kyc/${fileName}`;

    let uploadData: Blob | ArrayBuffer;
    if (base64) {
      const byteChars = atob(base64);
      const byteArr = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
      uploadData = byteArr.buffer;
    } else {
      const response = await fetch(uri);
      uploadData = await response.blob();
    }

    // Ensure bucket exists
    const { data: buckets } = await supabase.storage.listBuckets();
    const bucketExists = buckets?.some((b: any) => b.name === BUCKET);
    if (!bucketExists) {
      await supabase.storage.createBucket(BUCKET, { public: true, fileSizeLimit: 10 * 1024 * 1024 });
    }

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(filePath, uploadData, { contentType: mimeType, upsert: true });

    if (error) {
      console.warn('[uploadKycPhoto] Upload error:', error.message);
      return null;
    }

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(filePath);
    return data?.publicUrl ?? null;
  } catch (err: any) {
    console.warn('[uploadKycPhoto] Exception:', err?.message);
    return null;
  }
}
// ─── PAYMENT PROOF UPLOAD ─────────────────────────────────────────────────────
// Uploads booking/onboarding payment proof to the `payment-proofs` Supabase
// storage bucket (same bucket as web app). Returns public URL or null on failure.

export async function uploadPaymentProof(
  uri: string,
  context: 'booking' | 'onboarding',
  contextId: string,          // allotmentId or tenantId
  base64?: string,
  mimeType: string = 'image/jpeg'
): Promise<string | null> {
  try {
    const BUCKET = 'payment-proofs';
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const fileName = `${context}_${contextId}_${Date.now()}.${ext}`;
    const filePath = `${context}/${fileName}`;

    let uploadData: Blob | ArrayBuffer;
    if (base64) {
      const byteChars = atob(base64);
      const byteArr = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
      uploadData = byteArr.buffer;
    } else {
      const response = await fetch(uri);
      uploadData = await response.blob();
    }

    // Ensure bucket exists (create with public access if missing)
    const { data: buckets } = await supabase.storage.listBuckets();
    const bucketExists = buckets?.some((b: any) => b.name === BUCKET);
    if (!bucketExists) {
      await supabase.storage.createBucket(BUCKET, { public: true, fileSizeLimit: 10 * 1024 * 1024 });
    }

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(filePath, uploadData, { contentType: mimeType, upsert: true });

    if (error) {
      console.warn('[uploadPaymentProof] Upload error:', error.message);
      return null;
    }

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(filePath);
    return data?.publicUrl ?? null;
  } catch (err: any) {
    console.warn('[uploadPaymentProof] Exception:', err?.message);
    return null;
  }
}

export async function saveTicketResolution(args: {
  ticketId: string; userId: string;
  resolutionType: string; serviceType: string; closureSummary: string;
  totalLabourCost?: number; vendorNameManual?: string; vendorId?: string;
  items?: { name: string; qty: number; unit_cost: number }[];
  paymentDate?: string; bankAccountId?: string; paymentReferenceNo?: string;
  proofOfPurchaseUrl?: string; proofOfPaymentUrl?: string;
  isUnlockEdit?: boolean;
}): Promise<{ success: boolean; newStatus: string }> {
  return client.action((api as any).tickets.saveResolution, args);
}

export async function postTicketComment(ticketId: string, text: string, userId: string): Promise<{ success: boolean }> {
  return client.action((api as any).tickets.postComment, { ticketId, text, userId });
}

export async function fetchVendors(): Promise<{ id: string; vendor_name: string }[]> {
  try { return await client.action((api as any).tickets.getVendors, {}); } catch { return []; }
}

export async function fetchTicketResolution(ticketId: string): Promise<any | null> {
  try { return await client.action((api as any).tickets.getResolution, { ticketId }); } catch { return null; }
}

export async function unlockResolutionEditing(ticketId: string, userId: string, reason: string): Promise<void> {
  await client.action((api as any).tickets.unlockResolutionEditing, { ticketId, userId, reason });
}

export async function classifyIssue(description: string, issueTypes: any[]): Promise<{
  matches: { issue_type_id: string; confidence: number; name?: string }[];
  top_issue_type_id: string | null;
  top_confidence: number;
  top_issue_sub_type_id: string | null;
  top_issue_sub_type_confidence: number;
  action: 'auto_select' | 'suggest' | 'manual' | 'idle';
}> {
  try {
    return await client.action((api as any).tickets.classifyIssue, {
      description,
      issueTypes: issueTypes.map((t: any) => ({
        id: t.id, name: t.name,
        subTypes: (t.subTypes || []).map((s: any) => ({ id: s.id, name: s.name, description: s.description || '' })),
      })),
    });
  } catch {
    return { matches: [], top_issue_type_id: null, top_confidence: 0, top_issue_sub_type_id: null, top_issue_sub_type_confidence: 0, action: 'manual' };
  }
}

export async function extractPaymentProof(imageBase64: string): Promise<{
  amount: number | null; payment_date: string | null;
  bank_name: string | null; transaction_reference: string | null;
}> {
  try {
    return await client.action((api as any).tickets.extractPaymentProof, { imageBase64 });
  } catch {
    return { amount: null, payment_date: null, bank_name: null, transaction_reference: null };
  }
}

export async function fetchBankAccounts(): Promise<{ id: string; bank_name: string; account_number?: string; account_name?: string }[]> {
  try { return await client.action((api as any).tickets.getBankAccounts, {}); } catch { return []; }
}
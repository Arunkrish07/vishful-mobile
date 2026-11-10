/**
 * ticketService.ts
 * Routes all ticket operations through Convex actions → Supabase.
 * No direct Supabase calls from client.
 */
import { client, api } from "../lib/convexApi";
import { supabase } from "../lib/supabase"; // direct client (Storage + data)
import { ORG_ID, safeList, insertRow, updateRow, deleteDisabledResult } from "../lib/supabaseDb";
import { calcWorkingHoursSlaDeadline } from "../lib/ticketSla";

async function generateTicketNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const { data } = await supabase
    .from("maintenance_tickets").select("ticket_number")
    .eq("organization_id", ORG_ID).like("ticket_number", `VISH-${year}-%`)
    .order("ticket_number", { ascending: false }).limit(1);
  let nextSeq = 1;
  if (data && data.length > 0) {
    const parts = String(data[0].ticket_number).split("-");
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastSeq)) nextSeq = lastSeq + 1;
  }
  const rand = Math.floor(Math.random() * 90 + 10);
  return `VISH-${year}-${String(nextSeq).padStart(4, "0")}${rand}`;
}

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface Ticket {
  id: string;
  organization_id: string;
  ticket_number: string;
  tenant_id: string | null;
  property_id?: string | null;
  apartment_id?: string | null;
  bed_id?: string | null;
  bed_code?: string | null;  // enriched by convex/tickets.ts from bed_id → beds.bed_code
  issue_type_id: string;
  issue_type?: string | null;
  issue_type_name?: string | null;  // enriched by convex/tickets.ts from issue_type_id → issue_types.name
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
    // Direct Supabase port of convex/tickets.ts listTickets (role-scoped + enriched).
    let query = supabase
      .from("maintenance_tickets").select("*")
      .eq("organization_id", ORG_ID)
      .order("created_at", { ascending: false });

    if (role === "technician" && userId) {
      const { data: memberRows } = await supabase
        .from("team_members").select("id, user_id")
        .eq("organization_id", ORG_ID)
        .or(`id.eq.${userId},user_id.eq.${userId}`);
      const possibleIds: string[] = [userId];
      if (memberRows?.length) {
        memberRows.forEach((m: any) => { if (m.id) possibleIds.push(m.id); if (m.user_id) possibleIds.push(m.user_id); });
      }
      query = query.in("assigned_to", [...new Set(possibleIds.filter(Boolean))]);
    } else if (role === "tenant" && tenantId) {
      query = query.eq("tenant_id", tenantId);
    }
    const tickets = await safeList(query);
    if (!tickets.length) return [];

    const bedIds = [...new Set(tickets.map((t: any) => t.bed_id).filter(Boolean))];
    const bedCodeMap: Record<string, string> = {};
    if (bedIds.length) {
      const beds = await safeList(supabase.from("beds").select("id, bed_code").eq("organization_id", ORG_ID).in("id", bedIds));
      beds.forEach((b: any) => { bedCodeMap[b.id] = b.bed_code || ""; });
    }
    const apartmentIds = [...new Set(tickets.map((t: any) => t.apartment_id).filter(Boolean))];
    const apartmentCodeMap: Record<string, string> = {};
    if (apartmentIds.length) {
      const apts = await safeList(supabase.from("apartments").select("id, apartment_code").eq("organization_id", ORG_ID).in("id", apartmentIds));
      apts.forEach((a: any) => { apartmentCodeMap[a.id] = a.apartment_code || ""; });
    }
    const issueTypeIds = [...new Set(tickets.map((t: any) => t.issue_type_id).filter(Boolean))];
    const issueTypeNameMap: Record<string, string> = {};
    if (issueTypeIds.length) {
      const its = await safeList(supabase.from("issue_types").select("id, name").eq("organization_id", ORG_ID).in("id", issueTypeIds));
      its.forEach((it: any) => { issueTypeNameMap[it.id] = it.name || ""; });
    }
    return tickets.map((t: any) => {
      const diag = t.diagnostic_data || {};
      const resolvedApartmentCode = (t.apartment_id ? apartmentCodeMap[t.apartment_id] : null) || diag.apartment_code || null;
      return {
        ...t,
        bed_code: t.bed_id ? (bedCodeMap[t.bed_id] || null) : null,
        apartment_code: resolvedApartmentCode,
        issue_type_name: t.issue_type_id ? (issueTypeNameMap[t.issue_type_id] || diag.issue_type || t.issue_type || null) : (diag.issue_type || t.issue_type || null),
        issue_subtype: diag.issue_subtype || null,
        assigned_to_name: diag.assigned_to_name || null,
        assigned_to_phone: diag.assigned_to_phone || null,
        photo_urls: Array.isArray(t.photo_urls)
          ? t.photo_urls
          : typeof t.photo_urls === 'string'
            ? (() => { try { return JSON.parse(t.photo_urls); } catch { return []; } })()
            : [],
      };
    }) as any;
  } catch (e: any) {
    console.warn("[ticketService] fetchTickets:", e?.message);
    return [];
  }
}

export async function fetchTicket(ticketId: string): Promise<Ticket | null> {
  try {
    const { data, error } = await supabase.from("maintenance_tickets").select("*").eq("id", ticketId).single();
    if (error) throw new Error(error.message);
    let bed_code: string | null = null;
    let apartment_code: string | null = null;
    if (data.bed_id) {
      const { data: bed } = await supabase.from("beds").select("id, bed_code, apartment_id").eq("organization_id", ORG_ID).eq("id", data.bed_id).single();
      if (bed) {
        bed_code = bed.bed_code || null;
        if (bed.apartment_id) {
          const { data: apt } = await supabase.from("apartments").select("apartment_code").eq("organization_id", ORG_ID).eq("id", bed.apartment_id).single();
          if (apt) apartment_code = apt.apartment_code || null;
        }
      }
    }
    if (!apartment_code && data.apartment_id) {
      const { data: apt } = await supabase.from("apartments").select("apartment_code").eq("organization_id", ORG_ID).eq("id", data.apartment_id).single();
      if (apt) apartment_code = apt.apartment_code || null;
    }
    if (!apartment_code) apartment_code = data.diagnostic_data?.apartment_code || null;
    let issue_type_name: string | null = null;
    if (data.issue_type_id) {
      const { data: it } = await supabase.from("issue_types").select("name").eq("organization_id", ORG_ID).eq("id", data.issue_type_id).single();
      issue_type_name = it?.name || data.diagnostic_data?.issue_type || data.issue_type || null;
    } else {
      issue_type_name = data.diagnostic_data?.issue_type || data.issue_type || null;
    }
    const diag = data.diagnostic_data || {};
    let property_name: string | null = null;
    if (data.property_id) {
      const { data: prop } = await supabase.from("properties").select("property_name").eq("organization_id", ORG_ID).eq("id", data.property_id).single();
      property_name = prop?.property_name || null;
    }
    let tenant_full_name: string | null = data.tenant_name || null;
    let tenant_phone_resolved: string | null = data.tenant_phone || null;
    if ((!tenant_full_name || !tenant_phone_resolved) && data.tenant_id) {
      const { data: ten } = await supabase.from("tenants").select("full_name, phone").eq("organization_id", ORG_ID).eq("id", data.tenant_id).single();
      if (ten) { if (!tenant_full_name) tenant_full_name = ten.full_name || null; if (!tenant_phone_resolved) tenant_phone_resolved = ten.phone || null; }
    }
    let created_by_name: string | null = null;
    let is_creator_tenant = false;
    if (data.created_by) {
      const { data: prof } = await supabase.from("profiles").select("full_name").eq("id", data.created_by).single();
      created_by_name = prof?.full_name || null;
      is_creator_tenant = !!(tenant_full_name && created_by_name && created_by_name === tenant_full_name);
    }
    let linked_asset: any = null;
    if (data.asset_id) {
      const { data: asset } = await supabase.from("assets").select("id, asset_code, brand, model, condition").eq("organization_id", ORG_ID).eq("id", data.asset_id).single();
      if (asset) linked_asset = { id: asset.id, asset_code: asset.asset_code, label: [asset.brand, asset.model].filter(Boolean).join(" ") || asset.asset_code, condition: asset.condition || null };
    }
    let photoUrls: string[] = [];
    if (Array.isArray(data.photo_urls)) photoUrls = data.photo_urls;
    else if (typeof data.photo_urls === 'string') { try { photoUrls = JSON.parse(data.photo_urls); } catch { photoUrls = []; } }
    return {
      ...data, photo_urls: photoUrls, bed_code, apartment_code, apartment: apartment_code,
      issue_type_name, issue_type: issue_type_name,
      issue_subtype: diag.issue_subtype || null, assigned_to_name: diag.assigned_to_name || null, assigned_to_phone: diag.assigned_to_phone || null,
      property_name, tenant_name: tenant_full_name, tenant_phone: tenant_phone_resolved,
      created_by_name, is_creator_tenant, linked_asset,
    } as any;
  } catch (e: any) {
    console.warn("[ticketService] fetchTicket:", e?.message);
    return null;
  }
}

export async function fetchTicketLogs(ticketId: string): Promise<TicketLog[]> {
  try {
    return await safeList(
      supabase.from("ticket_logs").select("*").eq("ticket_id", ticketId).order("created_at", { ascending: true })
    ) as any;
  } catch (e: any) {
    console.warn("[ticketService] fetchTicketLogs:", e?.message);
    return [];
  }
}

export async function createTicket(data: any): Promise<Ticket> {
  // Direct port of convex createTicketHelper (SMS to technician omitted — that is a
  // secret-key feature that belongs in an Edge Function, like login).
  const ticketNumber = await generateTicketNumber();
  let slaDelta = 24 * 3600000;
  let priority = data.priority || "medium";
  if (data.issue_type_id) {
    const { data: it } = await supabase.from("issue_types").select("sla_hours,priority").eq("id", data.issue_type_id).single();
    if (it) { slaDelta = (it.sla_hours || 24) * 3600000; priority = data.priority || it.priority || "medium"; }
  }
  const slaDeadline = calcWorkingHoursSlaDeadline(new Date(), slaDelta / 3600000).toISOString();
  let tenantPhone: string | null = data.tenant_phone || null;
  let tenantName: string | null = null;
  let resolvedTenantId: string | null = data.tenant_id || null;
  if (!resolvedTenantId && data.bed_id) {
    const { data: allotment } = await supabase.from("tenant_allotments").select("tenant_id")
      .eq("bed_id", data.bed_id).eq("organization_id", ORG_ID)
      .in("staying_status", ["Staying", "On-Notice", "Booked"]).order("created_at", { ascending: false }).limit(1).single();
    if (allotment?.tenant_id) resolvedTenantId = allotment.tenant_id;
  }
  if (resolvedTenantId) {
    const { data: profile } = await supabase.from("profiles").select("phone, full_name").eq("id", resolvedTenantId).single();
    if (profile) { tenantPhone = tenantPhone || profile.phone || null; tenantName = profile.full_name || null; }
  }
  let assignedTo: string | null = data.assigned_to || null;
  if (!assignedTo && data.issue_type_id) {
    const { data: rules } = await supabase.from("ticket_assignment_rules")
      .select("assigned_employee_id, apartment_code, priority")
      .eq("organization_id", ORG_ID).eq("issue_type_id", data.issue_type_id).order("priority", { ascending: true });
    if (rules?.length) {
      const prefixMatch = data.apartment_code && rules.find((r: any) => r.apartment_code && data.apartment_code?.startsWith(r.apartment_code));
      assignedTo = prefixMatch?.assigned_employee_id || rules[0].assigned_employee_id;
    }
  }
  if (!assignedTo) {
    const { data: allMembers } = await supabase.from("team_members").select("id, user_id, first_name, last_name").eq("organization_id", ORG_ID).eq("status", "active");
    if (allMembers?.length) {
      const memberUserIds = allMembers.map((m: any) => m.user_id).filter(Boolean);
      let technicianUserIds = new Set<string>();
      if (memberUserIds.length) {
        const { data: techRoles } = await supabase.from("user_roles").select("user_id").in("user_id", memberUserIds).eq("role", "technician");
        technicianUserIds = new Set((techRoles || []).map((r: any) => r.user_id));
      }
      const technicians = allMembers.filter((m: any) => technicianUserIds.has(m.user_id));
      const pool: any[] = technicians.length > 0 ? technicians : allMembers;
      let min = Infinity; let best: string | null = null;
      for (const m of pool) {
        const assignKey = m.user_id || m.id;
        const { count } = await supabase.from("maintenance_tickets").select("*", { count: "exact", head: true })
          .eq("organization_id", ORG_ID).eq("assigned_to", assignKey)
          .not("status", "in", "(closed,completed,pending_admin_approval,pending_tenant_approval)");
        if ((count || 0) < min) { min = count || 0; best = assignKey; }
      }
      assignedTo = best;
    }
  }
  let assignedToName: string | null = null;
  let assignedToPhone: string | null = null;
  if (assignedTo) {
    const { data: m } = await supabase.from("team_members").select("first_name, last_name, phone").eq("user_id", assignedTo).eq("organization_id", ORG_ID).single();
    if (m) { assignedToName = `${m.first_name || ""} ${m.last_name || ""}`.trim(); assignedToPhone = m.phone || null; }
  }
  const status = assignedTo ? "assigned" : "open";
  const extraMeta = {
    issue_type: data.issue_type || null, issue_subtype: data.issue_subtype || null,
    assigned_to_name: assignedToName, assigned_to_phone: assignedToPhone,
    apartment_code: data.apartment_code || null, source: data.source || null,
    voice_transcription: data.voice_transcription || null,
  };
  const row: any = await insertRow("maintenance_tickets", {
    organization_id: ORG_ID, ticket_number: ticketNumber,
    tenant_id: resolvedTenantId || null, property_id: data.property_id || null,
    apartment_id: data.apartment_id || null, bed_id: data.bed_id || null,
    issue_type_id: data.issue_type_id, description: data.description || null,
    priority, sla_deadline: slaDeadline, assigned_to: assignedTo, status,
    asset_id: data.asset_id || null, photo_urls: data.photo_urls || null,
    created_by: data.created_by || null, tenant_name: tenantName, tenant_phone: tenantPhone,
    diagnostic_data: extraMeta,
  });
  await insertRow("ticket_logs", {
    ticket_id: row.id, action: "Ticket created", new_status: status, created_by: data.created_by || null,
    notes: `${ticketNumber} created. Issue: ${data.issue_type || "N/A"}. ${assignedTo ? `Auto-assigned to ${assignedToName || assignedTo}.` : "Awaiting assignment."}${data.source ? ` Source: ${data.source}` : ""}`,
    organization_id: ORG_ID,
  });
  return row as any;
}

export async function updateTicketStatus(
  ticketId: string,
  newStatus: string,
  userId: string,
  options?: { notes?: string; rejectionReason?: string }
): Promise<{ success: boolean; newStatus: string }> {
  const notes = options?.notes;
  const rejectionReason = options?.rejectionReason;
  const { data: ticket } = await supabase.from("maintenance_tickets").select("status,created_by,tenant_id").eq("id", ticketId).single();
  if (!ticket) throw new Error("Ticket not found");
  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (newStatus === "completed") {
    updates.resolved_at = new Date().toISOString();
    const isAdminCreated = !ticket.tenant_id;
    const pendingStatus = isAdminCreated ? "pending_admin_approval" : "pending_tenant_approval";
    updates.status = pendingStatus;
    let raiserName = "the requester";
    const raiserId = ticket.tenant_id || ticket.created_by;
    if (raiserId) {
      const { data: prof } = await supabase.from("profiles").select("full_name").eq("id", raiserId).maybeSingle();
      if (prof) raiserName = prof.full_name || (ticket.tenant_id ? "Tenant" : "Admin");
    }
    await insertRow("ticket_logs", {
      ticket_id: ticketId, action: isAdminCreated ? "Approval request sent to Admin" : "Approval request sent to Tenant",
      new_status: pendingStatus, created_by: userId,
      notes: `Work is complete. Approval request sent to ${raiserName}. Please review and approve or reject.`,
      organization_id: ORG_ID,
    });
    // Push notification to raiser is a secret-key feature → handled by backend/edge fn, skipped here.
  } else if (newStatus === "closed") {
    updates.status = "closed"; updates.closed_at = new Date().toISOString(); updates.tenant_approved = true;
  } else if (newStatus === "in_progress" && rejectionReason) {
    updates.status = "in_progress"; updates.tenant_approved = false; updates.tenant_rejection_reason = rejectionReason; updates.resolved_at = null;
  } else {
    updates.status = newStatus;
  }
  await updateRow("maintenance_tickets", ticketId, updates);
  if (newStatus !== "completed") {
    await insertRow("ticket_logs", {
      ticket_id: ticketId, action: `Status → ${updates.status || newStatus}`,
      old_status: ticket.status, new_status: updates.status || newStatus,
      created_by: userId, notes: notes || rejectionReason || null, organization_id: ORG_ID,
    });
  }
  return { success: true, newStatus: updates.status || newStatus };
}

export async function reassignTicket(
  ticketId: string, newAssigneeId: string, userId: string, notes?: string
): Promise<{ success: boolean }> {
  // SMS to new technician omitted (secret-key → edge function).
  const { data: m } = await supabase.from("team_members").select("first_name, last_name, phone").eq("user_id", newAssigneeId).eq("organization_id", ORG_ID).single();
  const name = m ? `${m.first_name || ""} ${m.last_name || ""}`.trim() : null;
  const { data: existingTicket } = await supabase.from("maintenance_tickets").select("diagnostic_data, issue_type_id").eq("id", ticketId).single();
  const updatedMeta = { ...(existingTicket?.diagnostic_data || {}), assigned_to_name: name, assigned_to_phone: m?.phone || null };
  let newSlaDeadline: string | null = null;
  if (existingTicket?.issue_type_id) {
    const { data: it } = await supabase.from("issue_types").select("sla_hours").eq("id", existingTicket.issue_type_id).single();
    newSlaDeadline = calcWorkingHoursSlaDeadline(new Date(), it?.sla_hours || 24).toISOString();
  }
  await updateRow("maintenance_tickets", ticketId, {
    assigned_to: newAssigneeId, status: "assigned", updated_at: new Date().toISOString(),
    diagnostic_data: updatedMeta, ...(newSlaDeadline ? { sla_deadline: newSlaDeadline } : {}),
  });
  await insertRow("ticket_logs", {
    ticket_id: ticketId, action: "Ticket reassigned", new_status: "assigned", created_by: userId,
    notes: `${notes || `Reassigned to ${name || newAssigneeId}`}${newSlaDeadline ? `. SLA reset to ${new Date(newSlaDeadline).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`,
    organization_id: ORG_ID,
  });
  return { success: true };
}

export async function submitDiagnosis(args: {
  ticketId: string; issueTypeId: string; questionsAnswers: Record<string, string>;
  aiDiagnosis?: string; employeeOverride?: string; performedBy: string;
}): Promise<{ success: boolean }> {
  const { data: existing } = await supabase.from("diagnostic_sessions").select("id").eq("ticket_id", args.ticketId).maybeSingle();
  const diagData = {
    ticket_id: args.ticketId, organization_id: ORG_ID, issue_type_id: args.issueTypeId,
    performed_by: args.performedBy, questions_answers: args.questionsAnswers,
    ai_diagnosis: args.aiDiagnosis || null, employee_override: args.employeeOverride || null,
    status: "completed", completed_at: new Date().toISOString(),
  };
  if (existing?.id) await updateRow("diagnostic_sessions", existing.id, diagData);
  else await insertRow("diagnostic_sessions", diagData);
  const diagResult = args.employeeOverride || args.aiDiagnosis || "";
  await updateRow("maintenance_tickets", args.ticketId, {
    // NOTE: maintenance_tickets has no `diagnosis` scalar column — the result lives in diagnostic_data.
    diagnostic_data: { answers: args.questionsAnswers, result: diagResult, performed_at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  });
  const qaSummary = Object.entries(args.questionsAnswers || {}).map(([q, a]) => `Q: ${q} → A: ${a}`).join("; ");
  await insertRow("ticket_logs", { ticket_id: args.ticketId, action: "Diagnosis completed", created_by: args.performedBy, notes: `${qaSummary}. Result: ${diagResult}`, organization_id: ORG_ID });
  const { data: currentTicket } = await supabase.from("maintenance_tickets").select("status").eq("id", args.ticketId).maybeSingle();
  if (currentTicket?.status === "assigned") {
    await updateRow("maintenance_tickets", args.ticketId, { status: "in_progress" });
    await insertRow("ticket_logs", { ticket_id: args.ticketId, action: "Status → in_progress", old_status: "assigned", new_status: "in_progress", created_by: args.performedBy, notes: "Auto-transitioned to In Progress after diagnostics completion.", organization_id: ORG_ID });
  }
  return { success: true };
}

export async function fetchCostEstimates(ticketId: string): Promise<CostEstimate[]> {
  try {
    return await safeList(
      supabase.from("ticket_cost_estimates").select("*").eq("ticket_id", ticketId).order("created_at", { ascending: true })
    ) as any;
  } catch (e: any) {
    return [];
  }
}

export async function submitCostEstimates(
  ticketId: string,
  items: { item_name: string; cost_type: string; quantity: number; unit_price: number }[],
  submittedBy: string
): Promise<{ success: boolean }> {
  // Push notification to approvers omitted (secret-key → edge function).
  const inserted: any[] = [];
  for (const item of items) {
    const total = (item.quantity || 1) * (item.unit_price || 0);
    const row = await insertRow("ticket_cost_estimates", {
      ticket_id: ticketId, organization_id: ORG_ID, item_name: item.item_name,
      cost_type: item.cost_type || "parts", quantity: item.quantity || 1, unit_price: item.unit_price || 0,
      total, submitted_by: submittedBy, status: "pending",
    });
    inserted.push(row);
    await insertRow("ticket_logs", { ticket_id: ticketId, action: "Cost estimate submitted", created_by: submittedBy, notes: `${item.item_name} x${item.quantity || 1} @ ₹${item.unit_price || 0} = ₹${total}`, organization_id: ORG_ID });
  }
  await updateRow("maintenance_tickets", ticketId, { status: "waiting_for_cost_approval", updated_at: new Date().toISOString() });
  const { data: orgSettings } = await supabase.from("organizations").select("ticket_auto_approve_threshold, ticket_repeat_check_days").eq("id", ORG_ID).maybeSingle();
  const AUTO_APPROVE_THRESHOLD = Number((orgSettings as any)?.ticket_auto_approve_threshold) || 1000;
  const REPEAT_CHECK_DAYS = Number((orgSettings as any)?.ticket_repeat_check_days) || 30;
  const totalEstimatedCost = items.reduce((s: number, i: any) => s + ((i.quantity || 1) * (i.unit_price || 0)), 0);
  const { data: ticketCtx } = await supabase.from("maintenance_tickets").select("apartment_id, bed_id, issue_type_id, property_id, organization_id, issue_types(name)").eq("id", ticketId).maybeSingle();
  let isRepeatJob = false;
  if (ticketCtx?.apartment_id && ticketCtx?.issue_type_id) {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - REPEAT_CHECK_DAYS);
    let repeatQ: any = supabase.from("maintenance_tickets").select("id, ticket_number, created_at")
      .eq("organization_id", ORG_ID).eq("apartment_id", ticketCtx.apartment_id).eq("issue_type_id", ticketCtx.issue_type_id)
      .in("status", ["completed", "closed"]).gte("created_at", cutoff.toISOString()).neq("id", ticketId)
      .order("created_at", { ascending: false }).limit(1);
    if (ticketCtx.bed_id) repeatQ = repeatQ.eq("bed_id", ticketCtx.bed_id);
    const { data: repeatTickets } = await repeatQ;
    isRepeatJob = !!(repeatTickets && repeatTickets.length > 0);
    if (isRepeatJob) {
      const prev: any = (repeatTickets as any[])[0];
      const daysAgo = Math.floor((Date.now() - new Date(prev.created_at).getTime()) / 86400000);
      await supabase.from("ticket_cost_estimates").update({ repeat_job_alert: true, repeat_job_previous_ticket_id: prev.id }).eq("ticket_id", ticketId);
      await insertRow("ticket_logs", { ticket_id: ticketId, organization_id: ORG_ID, action: "Repeat Job Alert", notes: `Same issue (${(ticketCtx as any).issue_types?.name || "unknown"}) resolved in this apartment ${daysAgo} days ago (Ticket #${prev.ticket_number}). Manual approval required.`, created_by: submittedBy });
    }
  }
  if (!isRepeatJob && totalEstimatedCost > 0 && totalEstimatedCost <= AUTO_APPROVE_THRESHOLD) {
    await supabase.from("ticket_cost_estimates").update({
      status: "approved", is_auto_approved: true,
      auto_approval_reason: `Auto-approved: total ₹${Math.round(totalEstimatedCost)} is under ₹${AUTO_APPROVE_THRESHOLD} threshold`,
      approved_at: new Date().toISOString(),
    }).eq("ticket_id", ticketId);
    await updateRow("maintenance_tickets", ticketId, { status: "waiting_for_parts", updated_at: new Date().toISOString() });
    await insertRow("ticket_logs", { ticket_id: ticketId, organization_id: ORG_ID, action: "Cost auto-approved", notes: `Total ₹${Math.round(totalEstimatedCost)} is under ₹${AUTO_APPROVE_THRESHOLD} threshold — auto-approved. Ticket moved to Waiting for Parts.`, created_by: submittedBy });
  }
  return { success: true, estimates: inserted } as any;
}

export async function approveCostEstimate(args: {
  estimateId: string; ticketId: string;
  action: "approve" | "decline"; approvedBy: string;
  declineReason?: string; modifiedQuantity?: number; modifiedUnitPrice?: number;
}): Promise<{ success: boolean; newTicketStatus: string | null }> {
  const { data: estimate } = await supabase.from("ticket_cost_estimates").select("quantity, unit_price, item_name").eq("id", args.estimateId).single();
  const updates: Record<string, any> = {
    status: args.action === "approve" ? "approved" : "declined",
    approved_by: args.approvedBy, approved_at: new Date().toISOString(),
  };
  if (args.action === "decline") updates.decline_reason = args.declineReason || null;
  if (args.action === "approve" && args.modifiedQuantity !== undefined) updates.quantity = args.modifiedQuantity;
  if (args.action === "approve" && args.modifiedUnitPrice !== undefined) {
    updates.unit_price = args.modifiedUnitPrice;
    updates.total = (args.modifiedQuantity || (estimate as any)?.quantity || 1) * args.modifiedUnitPrice;
  }
  await supabase.from("ticket_cost_estimates").update(updates).eq("id", args.estimateId);
  const { data: all } = await supabase.from("ticket_cost_estimates").select("status").eq("ticket_id", args.ticketId);
  const pending = all?.filter((e: any) => e.status === "pending") || [];
  const approved = all?.filter((e: any) => e.status === "approved") || [];
  let newTicketStatus: string | null = null;
  if (pending.length === 0) newTicketStatus = approved.length > 0 ? "waiting_for_parts" : "in_progress";
  if (newTicketStatus) await updateRow("maintenance_tickets", args.ticketId, { status: newTicketStatus, updated_at: new Date().toISOString() });
  await insertRow("ticket_logs", {
    ticket_id: args.ticketId, action: `Cost ${args.action === "approve" ? "approved" : "declined"}`, created_by: args.approvedBy,
    notes: args.action === "decline" ? `Declined: ${args.declineReason}` : `Approved: ${(estimate as any)?.item_name}`, organization_id: ORG_ID,
  });
  return { success: true, newTicketStatus };
}

export async function recordPurchase(args: {
  ticketId: string; items: any[]; vendorId?: string;
  vendorNameManual?: string; invoiceUrl?: string;
  purchasedBy: string; costEstimateId?: string;
}): Promise<{ success: boolean }> {
  const totalCost = args.items.reduce((s: number, i: any) => s + (i.actual_cost || 0), 0);
  const purchase: any = await insertRow("ticket_purchases", {
    ticket_id: args.ticketId, organization_id: ORG_ID, cost_estimate_id: args.costEstimateId || null,
    actual_cost: totalCost, vendor_id: args.vendorId || null, vendor_name_manual: args.vendorNameManual || null,
    invoice_url: args.invoiceUrl || null, purchased_by: args.purchasedBy, purchase_date: new Date().toISOString().split("T")[0],
  });
  const { data: ticket } = await supabase.from("maintenance_tickets").select("bed_id, apartment_id, property_id, tenant_id, issue_type_id, diagnostic_data").eq("id", args.ticketId).single();
  if (ticket) {
    let costScope = "bed"; const distributedBeds: any = {};
    if (ticket.bed_id) { distributedBeds[ticket.bed_id] = totalCost; }
    else if (ticket.apartment_id) {
      costScope = "apartment";
      const { data: beds } = await supabase.from("beds").select("id").eq("apartment_id", ticket.apartment_id);
      if (beds?.length) { const perBed = totalCost / beds.length; beds.forEach((b: any) => { distributedBeds[b.id] = perBed; }); }
    } else { costScope = "property"; }
    await insertRow("running_bed_maintenance_details", {
      ticket_id: args.ticketId, purchase_id: purchase.id, organization_id: ORG_ID,
      tenant_id: ticket.tenant_id || null, bed_id: ticket.bed_id || null, apartment_id: ticket.apartment_id || null, property_id: ticket.property_id || null,
      item_name: args.items.map((i: any) => i.item_name).join(", "), quantity: args.items.reduce((s: number, i: any) => s + (i.quantity || 1), 0),
      actual_cost: totalCost, vendor_name: args.vendorNameManual || null, cost_scope: costScope,
      distributed_amount: totalCost, billing_month: new Date().toISOString().substring(0, 7),
      maintenance_type: ticket.diagnostic_data?.issue_type || "maintenance", parts_details: args.items, distributed_beds: distributedBeds,
    });
  }
  await updateRow("maintenance_tickets", args.ticketId, { status: "in_progress", updated_at: new Date().toISOString() });
  await insertRow("ticket_logs", { ticket_id: args.ticketId, action: "Purchase recorded", created_by: args.purchasedBy, notes: `₹${totalCost} from ${args.vendorNameManual || "vendor"}`, organization_id: ORG_ID });
  return { success: true, purchase } as any;
}

export async function fetchPurchases(ticketId: string): Promise<any[]> {
  try {
    return await safeList(
      supabase.from("ticket_purchases").select("*").eq("ticket_id", ticketId).order("created_at", { ascending: false })
    );
  } catch (e: any) {
    return [];
  }
}

export async function tenantApproveCompletion(
  ticketId: string, approved: boolean, userId: string, rejectionReason?: string
): Promise<{ success: boolean }> {
  const updates: Record<string, any> = { tenant_approved: approved, updated_at: new Date().toISOString() };
  if (approved) { updates.status = "closed"; updates.closed_at = new Date().toISOString(); }
  else { updates.status = "in_progress"; updates.tenant_rejection_reason = rejectionReason || null; updates.resolved_at = null; }
  await updateRow("maintenance_tickets", ticketId, updates);
  await insertRow("ticket_logs", {
    ticket_id: ticketId, action: approved ? "Completion approved by Tenant" : "Completion rejected by Tenant",
    new_status: updates.status, created_by: userId,
    notes: approved ? "Tenant approved — ticket closed" : `Tenant rejected: ${rejectionReason || ""}`, organization_id: ORG_ID,
  });
  return { success: true };
}

export async function adminApproveCompletion(
  ticketId: string, approved: boolean, userId: string, rejectionReason?: string
): Promise<{ success: boolean }> {
  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (approved) { updates.status = "closed"; updates.closed_at = new Date().toISOString(); }
  else { updates.status = "in_progress"; updates.resolved_at = null; }
  await updateRow("maintenance_tickets", ticketId, updates);
  await insertRow("ticket_logs", {
    ticket_id: ticketId, action: approved ? "Completion approved by Admin" : "Completion rejected by Admin",
    new_status: updates.status, created_by: userId,
    notes: approved ? "Admin approved — ticket closed" : `Admin rejected: ${rejectionReason || ""}`, organization_id: ORG_ID,
  });
  return { success: true };
}

export async function fetchIssueTypes(): Promise<IssueType[]> {
  try {
    return await safeList(
      supabase.from("issue_types")
        .select("*, issue_type_asset_types(asset_type_id, asset_types(id, name))")
        .eq("organization_id", ORG_ID)
        .order("name", { ascending: true })
    ) as any;
  } catch (e: any) {
    return [];
  }
}

export async function fetchAssetTypesLite(): Promise<{ id: string; name: string }[]> {
  try {
    return await safeList(
      supabase.from("asset_types").select("id, name").eq("organization_id", ORG_ID).order("name", { ascending: true })
    ) as any;
  } catch { return []; }
}

// Regular (recurring) maintenance rules — admin Tickets → "Regular" tab.
export async function fetchRegularMaintenanceRules(): Promise<any[]> {
  try {
    const rules = await safeList(
      supabase.from("regular_maintenance_rules")
        .select("id, maintenance_type, frequency, issue_type_id, is_active, next_run_at, created_at")
        .eq("organization_id", ORG_ID).order("created_at", { ascending: false })
    );
    const typeIds = [...new Set(rules.map((r: any) => r.issue_type_id).filter(Boolean))];
    const types = typeIds.length
      ? await safeList(supabase.from("issue_types").select("id, name").eq("organization_id", ORG_ID).in("id", typeIds)) : [];
    const typeName = new Map<string, string>(); for (const t of types) typeName.set(t.id, t.name);
    return rules.map((r: any) => ({
      id: r.id,
      name: r.maintenance_type || typeName.get(r.issue_type_id) || "Maintenance Rule",
      frequency: r.frequency || null,
      issue_type: r.issue_type_id ? (typeName.get(r.issue_type_id) || null) : null,
      is_active: r.is_active,
      next_run_at: r.next_run_at || null,
    }));
  } catch { return []; }
}

export async function updateIssueType(args: {
  issueTypeId: string; name?: string; icon?: string; priority?: string; slaHours?: number; assetTypeIds?: string[];
}): Promise<any> {
  const patch: any = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.icon !== undefined) patch.icon = args.icon;
  if (args.priority !== undefined) patch.priority = args.priority;
  if (args.slaHours !== undefined) patch.sla_hours = args.slaHours;
  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from("issue_types").update(patch).eq("id", args.issueTypeId).eq("organization_id", ORG_ID);
    if (error) throw new Error(`Update category failed: ${error.message}`);
  }
  if (args.assetTypeIds !== undefined) {
    await supabase.from("issue_type_asset_types").delete().eq("issue_type_id", args.issueTypeId).eq("organization_id", ORG_ID);
    if (args.assetTypeIds.length > 0) {
      const rows = args.assetTypeIds.map((atId) => ({ organization_id: ORG_ID, issue_type_id: args.issueTypeId, asset_type_id: atId }));
      const { error } = await supabase.from("issue_type_asset_types").insert(rows);
      if (error) throw new Error(`Link asset types failed: ${error.message}`);
    }
  }
  return { success: true };
}

export async function deleteIssueType(_issueTypeId: string): Promise<any> {
  return deleteDisabledResult();
}

export async function fetchIssueSubTypes(issueTypeId: string): Promise<IssueSubType[]> {
  try {
    return await safeList(
      supabase.from("issue_sub_types").select("*").eq("issue_type_id", issueTypeId).eq("organization_id", ORG_ID).order("sort_order", { ascending: true })
    ) as any;
  } catch (e: any) {
    return [];
  }
}

export async function fetchTeamMembers(): Promise<TeamMember[]> {
  try {
    // Technicians only (web parity): active members whose user_role is technician.
    const allMembers = await safeList(
      supabase.from("team_members").select("*").eq("organization_id", ORG_ID).eq("status", "active")
    );
    if (!allMembers.length) return [] as any;
    const memberUserIds = allMembers.map((m: any) => m.user_id).filter(Boolean);
    let technicianUserIds = new Set<string>();
    if (memberUserIds.length) {
      const { data: techRoles } = await supabase.from("user_roles").select("user_id").in("user_id", memberUserIds).eq("role", "technician");
      technicianUserIds = new Set((techRoles || []).map((r: any) => r.user_id));
    }
    if (technicianUserIds.size === 0) return allMembers as any;
    return allMembers.filter((m: any) => technicianUserIds.has(m.user_id)) as any;
  } catch (e: any) {
    return [];
  }
}

export async function fetchDiagnosticSession(ticketId: string): Promise<any | null> {
  try {
    const { data } = await supabase.from("diagnostic_sessions").select("*").eq("ticket_id", ticketId).maybeSingle();
    return data || null;
  } catch (e: any) {
    return null;
  }
}

export async function checkTenantPendingTickets(tenantId: string): Promise<{ hasPending: boolean; tickets: any[] }> {
  try {
    const { data, count } = await supabase
      .from("maintenance_tickets").select("id, ticket_number, status", { count: "exact" })
      .eq("tenant_id", tenantId).eq("status", "pending_tenant_approval");
    return { hasPending: (count || 0) > 0, tickets: data || [] };
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
  // Optional diagnostics the backend may attach (e.g. when OCR is unavailable
  // and the user must enter the amount manually).
  _requireManualAmount?: boolean; _message?: string; _source?: string;
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
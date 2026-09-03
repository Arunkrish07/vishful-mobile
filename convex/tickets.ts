"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  getSupabase,
  ORG_ID,
  safeList,
  insertRow,
  updateRow,
} from "./lib/supabaseAdmin";
import { sendTicketAssignmentSms } from "./lib/sms";

declare const fetch: any;
declare const Buffer: any;
declare const process: any;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Working hours: 9:30 AM – 5:30 PM (IST, UTC+5:30).
 * SLA deadline is calculated by counting only working-hour minutes.
 * If a ticket is raised (or reassigned) outside working hours, the SLA
 * clock does NOT start until the next working-hour window opens (9:30 AM).
 *
 * Examples:
 *  - Ticket at 11:00 AM  → SLA counts from 11:00 AM immediately
 *  - Ticket at 6:00 PM   → SLA counts from 9:30 AM next morning
 *  - Ticket at 2:00 AM   → SLA counts from 9:30 AM same morning
 *  - Ticket at 5:29 PM   → SLA counts from 5:29 PM (still in window)
 *  - Ticket at 5:30 PM   → SLA counts from 9:30 AM next morning
 */
const WORK_START_HOUR   = 9;  // 9 AM IST
const WORK_START_MINUTE = 30; // :30 → 9:30 AM IST
const WORK_END_HOUR     = 17; // 5 PM IST
const WORK_END_MINUTE   = 30; // :30 → 5:30 PM IST
const IST_OFFSET_MS     = 5.5 * 60 * 60 * 1000; // +5:30

/** Returns total minutes since midnight (IST) for a given UTC Date */
function toISTMinutes(date: Date): number {
  const istMs  = date.getTime() + IST_OFFSET_MS;
  const istDate = new Date(istMs);
  return istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
}

const WORK_START_MINS = WORK_START_HOUR * 60 + WORK_START_MINUTE; // 9*60+30 = 570
const WORK_END_MINS   = WORK_END_HOUR   * 60 + WORK_END_MINUTE;   // 17*60+30 = 1050

/** Returns the UTC Date of the next 9:30 AM IST on or after `from` */
function nextWorkStart(from: Date): Date {
  const istMs   = from.getTime() + IST_OFFSET_MS;
  const istDate = new Date(istMs);
  const minsNow = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();

  if (minsNow < WORK_START_MINS) {
    // Before today's window — set to 9:30 AM today (IST)
    istDate.setUTCHours(WORK_START_HOUR, WORK_START_MINUTE, 0, 0);
  } else {
    // At or past today's window start — go to 9:30 AM tomorrow (IST)
    istDate.setUTCDate(istDate.getUTCDate() + 1);
    istDate.setUTCHours(WORK_START_HOUR, WORK_START_MINUTE, 0, 0);
  }
  return new Date(istDate.getTime() - IST_OFFSET_MS); // back to UTC
}

/**
 * Returns the UTC Date that is `slaHours` worth of working-hours after `from`.
 * Working hours = 9:30 AM to 5:30 PM IST (8 hours/day).
 */
export function calcWorkingHoursSlaDeadline(from: Date, slaHours: number): Date {
  const minsNow  = toISTMinutes(from);
  const inWindow = minsNow >= WORK_START_MINS && minsNow < WORK_END_MINS;

  // If outside working hours, start counting from next window open (9:30 AM)
  let cursor = inWindow ? new Date(from) : nextWorkStart(from);

  let remainingMs = slaHours * 3600000;

  while (remainingMs > 0) {
    const cursorIstMs = cursor.getTime() + IST_OFFSET_MS;
    const cursorIst   = new Date(cursorIstMs);

    // End of today's working window: 5:30 PM IST → UTC
    const endIst = new Date(cursorIst);
    endIst.setUTCHours(WORK_END_HOUR, WORK_END_MINUTE, 0, 0);
    const endUtc = new Date(endIst.getTime() - IST_OFFSET_MS);

    const windowMs = endUtc.getTime() - cursor.getTime();
    if (remainingMs <= windowMs) {
      cursor = new Date(cursor.getTime() + remainingMs);
      remainingMs = 0;
    } else {
      remainingMs -= windowMs;
      cursor = nextWorkStart(endUtc); // jump to next day 9:30 AM
    }
  }
  return cursor;
}

async function generateTicketNumber(sb: ReturnType<typeof getSupabase>): Promise<string> {
  const year = new Date().getFullYear();
  // Use MAX of existing sequence numbers instead of COUNT
  // COUNT causes duplicates when tickets are deleted or created concurrently
  const { data } = await sb
    .from("maintenance_tickets")
    .select("ticket_number")
    .eq("organization_id", ORG_ID)
    .like("ticket_number", `VISH-${year}-%`)
    .order("ticket_number", { ascending: false })
    .limit(1);

  let nextSeq = 1;
  if (data && data.length > 0) {
    const last = data[0].ticket_number as string;
    const parts = last.split("-");
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastSeq)) nextSeq = lastSeq + 1;
  }

  // Add random 2-digit suffix to prevent race-condition duplicates
  const rand = Math.floor(Math.random() * 90 + 10);
  return `VISH-${year}-${String(nextSeq).padStart(4, "0")}${rand}`;
}

// ─── LIST TICKETS ─────────────────────────────────────────────────────────────

export const listTickets = action({
  args: {
    role: v.string(),
    userId: v.optional(v.string()),
    tenantId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    let query = sb
      .from("maintenance_tickets")
      .select("*")
      .eq("organization_id", ORG_ID)
      .order("created_at", { ascending: false });

    if (args.role === "technician" && args.userId) {
      // assigned_to can store either: supabase auth user_id OR team_member.id OR team_member.user_id
      // Try all three by looking up the team member record first
      const { data: memberRows } = await sb
        .from("team_members")
        .select("id, user_id")
        .eq("organization_id", ORG_ID)
        .or(`id.eq.${args.userId},user_id.eq.${args.userId}`);

      const possibleIds: string[] = [args.userId];
      if (memberRows?.length) {
        memberRows.forEach((m: any) => {
          if (m.id)      possibleIds.push(m.id);
          if (m.user_id) possibleIds.push(m.user_id);
        });
      }
      const uniqueIds = [...new Set(possibleIds.filter(Boolean))];
      query = query.in("assigned_to", uniqueIds);
    } else if (args.role === "tenant" && args.tenantId) {
      query = query.eq("tenant_id", args.tenantId);
    }

    const tickets = await safeList(query);

    // ── 1. Resolve bed_id → bed_code ─────────────────────────────────────────
    const bedIds = [...new Set(tickets.map((t: any) => t.bed_id).filter(Boolean))];
    const bedCodeMap: Record<string, string> = {};
    if (bedIds.length > 0) {
      const { data: beds } = await sb
        .from("beds")
        .select("id, bed_code")
        .eq("organization_id", ORG_ID)
        .in("id", bedIds);
      (beds || []).forEach((b: any) => { bedCodeMap[b.id] = b.bed_code || ""; });
    }

    // ── 2. Resolve apartment_id → apartment_code ──────────────────────────────
    // apartment_code is NOT a real column on maintenance_tickets — it lives only
    // in diagnostic_data. We must resolve it from the apartment_id FK.
    const apartmentIds = [...new Set(tickets.map((t: any) => t.apartment_id).filter(Boolean))];
    const apartmentCodeMap: Record<string, string> = {};
    if (apartmentIds.length > 0) {
      const { data: apartments } = await sb
        .from("apartments")
        .select("id, apartment_code")
        .eq("organization_id", ORG_ID)
        .in("id", apartmentIds);
      (apartments || []).forEach((a: any) => { apartmentCodeMap[a.id] = a.apartment_code || ""; });
    }

    // ── 3. Resolve issue_type_id → issue_type_name ───────────────────────────
    const issueTypeIds = [...new Set(tickets.map((t: any) => t.issue_type_id).filter(Boolean))];
    const issueTypeNameMap: Record<string, string> = {};
    if (issueTypeIds.length > 0) {
      const { data: issueTypes } = await sb
        .from("issue_types")
        .select("id, name")
        .eq("organization_id", ORG_ID)
        .in("id", issueTypeIds);
      (issueTypes || []).forEach((it: any) => { issueTypeNameMap[it.id] = it.name || ""; });
    }

    return tickets.map((t: any) => {
      const diag = t.diagnostic_data || {};
      // apartment_code: prefer resolved from FK, then fall back to diagnostic_data
      const resolvedApartmentCode =
        (t.apartment_id ? apartmentCodeMap[t.apartment_id] : null) ||
        diag.apartment_code ||
        null;

      return {
        ...t,
        bed_code:          t.bed_id        ? (bedCodeMap[t.bed_id]              || null) : null,
        apartment_code:    resolvedApartmentCode,
        issue_type_name:   t.issue_type_id ? (issueTypeNameMap[t.issue_type_id] || diag.issue_type || t.issue_type || null)
                                           : (diag.issue_type                   || t.issue_type || null),
        issue_subtype:     diag.issue_subtype     || null,
        assigned_to_name:  diag.assigned_to_name  || null,
        assigned_to_phone: diag.assigned_to_phone || null,
        // Always return photo_urls as a proper array
        photo_urls: Array.isArray(t.photo_urls)
          ? t.photo_urls
          : typeof t.photo_urls === 'string'
            ? (() => { try { return JSON.parse(t.photo_urls); } catch { return []; } })()
            : [],
      };
    });
  },
});

// ─── GET SINGLE TICKET ────────────────────────────────────────────────────────

export const getTicket = action({
  args: { ticketId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { ticketId }) => {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("maintenance_tickets")
      .select("*")
      .eq("id", ticketId)
      .single();
    if (error) throw new Error(error.message);

    // Resolve bed_code from bed_id
    let bed_code: string | null = null;
    let apartment_code: string | null = null;

    if (data.bed_id) {
      const { data: bed } = await sb
        .from("beds")
        .select("id, bed_code, apartment_id")
        .eq("organization_id", ORG_ID)
        .eq("id", data.bed_id)
        .single();
      if (bed) {
        bed_code = bed.bed_code || null;
        // Resolve apartment_code from bed's apartment_id
        if (bed.apartment_id) {
          const { data: apt } = await sb
            .from("apartments")
            .select("apartment_code")
            .eq("organization_id", ORG_ID)
            .eq("id", bed.apartment_id)
            .single();
          if (apt) apartment_code = apt.apartment_code || null;
        }
      }
    }

    // If apartment_code still missing, resolve from ticket's apartment_id directly
    if (!apartment_code && data.apartment_id) {
      const { data: apt } = await sb
        .from("apartments")
        .select("apartment_code")
        .eq("organization_id", ORG_ID)
        .eq("id", data.apartment_id)
        .single();
      if (apt) apartment_code = apt.apartment_code || null;
    }

    // Final fallback to diagnostic_data
    if (!apartment_code) {
      apartment_code = data.diagnostic_data?.apartment_code || null;
    }

    // Resolve issue_type_name from issue_type_id
    let issue_type_name: string | null = null;
    if (data.issue_type_id) {
      const { data: it } = await sb
        .from("issue_types")
        .select("name")
        .eq("organization_id", ORG_ID)
        .eq("id", data.issue_type_id)
        .single();
      issue_type_name = it?.name || data.diagnostic_data?.issue_type || data.issue_type || null;
    } else {
      issue_type_name = data.diagnostic_data?.issue_type || data.issue_type || null;
    }

    // Bubble up diagnostic_data fields so UI can read them at top level
    const diag = data.diagnostic_data || {};

    // ── Resolve PROPERTY name ──
    let property_name: string | null = null;
    if (data.property_id) {
      const { data: prop } = await sb
        .from("properties").select("property_name")
        .eq("organization_id", ORG_ID).eq("id", data.property_id).single();
      property_name = prop?.property_name || null;
    }

    // ── Resolve TENANT full_name + phone (fallback when denormalized columns empty) ──
    let tenant_full_name: string | null = data.tenant_name || null;
    let tenant_phone_resolved: string | null = data.tenant_phone || null;
    if ((!tenant_full_name || !tenant_phone_resolved) && data.tenant_id) {
      const { data: ten } = await sb
        .from("tenants").select("full_name, phone")
        .eq("organization_id", ORG_ID).eq("id", data.tenant_id).single();
      if (ten) {
        if (!tenant_full_name) tenant_full_name = ten.full_name || null;
        if (!tenant_phone_resolved) tenant_phone_resolved = ten.phone || null;
      }
    }

    // ── Resolve CREATED BY name (profiles) ──
    let created_by_name: string | null = null;
    let is_creator_tenant = false;
    if (data.created_by) {
      const { data: prof } = await sb
        .from("profiles").select("full_name").eq("id", data.created_by).single();
      created_by_name = prof?.full_name || null;
      // creator is the tenant if created_by matches a profile tied to the tenant (best-effort: tenant-raised => created_by is the tenant's auth id, name often equals tenant_name)
      is_creator_tenant = !!(tenant_full_name && created_by_name && created_by_name === tenant_full_name);
    }

    // ── Resolve LINKED ASSET ──
    let linked_asset: any = null;
    if (data.asset_id) {
      const { data: asset } = await sb
        .from("assets").select("id, asset_code, brand, model, condition")
        .eq("organization_id", ORG_ID).eq("id", data.asset_id).single();
      if (asset) {
        linked_asset = {
          id: asset.id,
          asset_code: asset.asset_code,
          label: [asset.brand, asset.model].filter(Boolean).join(" ") || asset.asset_code,
          condition: asset.condition || null,
        };
      }
    }

    // Ensure photo_urls is always an array (DB stores as JSONB — may come back as string or null)
    let photoUrls: string[] = [];
    if (Array.isArray(data.photo_urls)) {
      photoUrls = data.photo_urls;
    } else if (typeof data.photo_urls === 'string') {
      try { photoUrls = JSON.parse(data.photo_urls); } catch { photoUrls = []; }
    }

    return {
      ...data,
      photo_urls: photoUrls,
      bed_code,
      apartment_code,
      apartment:          apartment_code,          // alias the Details UI reads
      issue_type_name,
      issue_type:         issue_type_name,         // alias the Details UI reads
      issue_subtype:      diag.issue_subtype      || null,
      assigned_to_name:   diag.assigned_to_name   || null,
      assigned_to_phone:  diag.assigned_to_phone  || null,
      // newly resolved fields (web parity)
      property_name,
      tenant_name:        tenant_full_name,
      tenant_phone:       tenant_phone_resolved,
      created_by_name,
      is_creator_tenant,
      linked_asset,
    };
  },
});

// ─── GET TICKET LOGS ──────────────────────────────────────────────────────────

export const getTicketLogs = action({
  args: { ticketId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { ticketId }) => {
    const sb = getSupabase();
    return await safeList(
      sb.from("ticket_logs").select("*").eq("ticket_id", ticketId).order("created_at", { ascending: true })
    );
  },
});

// ─── CREATE TICKET ────────────────────────────────────────────────────────────

export async function createTicketHelper(data: any): Promise<any> {
  const sb = getSupabase();
  const ticketNumber = await generateTicketNumber(sb);

  let slaDelta = 24 * 3600000;
  let priority = data.priority || "medium";
  if (data.issue_type_id) {
    const { data: it } = await sb
      .from("issue_types")
      .select("sla_hours,priority")
      .eq("id", data.issue_type_id)
      .single();
    if (it) {
      slaDelta = (it.sla_hours || 24) * 3600000;
      priority = data.priority || it.priority || "medium";
    }
  }
  const slaDeadline = calcWorkingHoursSlaDeadline(new Date(), slaDelta / 3600000).toISOString();

  let tenantPhone: string | null = data.tenant_phone || null;
  let tenantName: string | null = null; // always resolve from DB so admin name is never stored as tenant
  let resolvedTenantId: string | null = data.tenant_id || null;

  // When admin raises a ticket against a bed with no explicit tenant_id,
  // look up the active tenant from allotments so we store the real tenant name
  if (!resolvedTenantId && data.bed_id) {
    const { data: allotment } = await sb
      .from("tenant_allotments")
      .select("tenant_id")
      .eq("bed_id", data.bed_id)
      .eq("organization_id", ORG_ID)
      .in("staying_status", ["Staying", "On-Notice", "Booked"])
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (allotment?.tenant_id) resolvedTenantId = allotment.tenant_id;
  }

  if (resolvedTenantId) {
    const { data: profile } = await sb
      .from("profiles")
      .select("phone, full_name")
      .eq("id", resolvedTenantId)
      .single();
    if (profile) {
      tenantPhone = tenantPhone || profile.phone || null;
      tenantName  = profile.full_name || null;
    }
  }

  let assignedTo: string | null = data.assigned_to || null;

  if (!assignedTo && data.issue_type_id) {
    const { data: rules } = await sb
      .from("ticket_assignment_rules")
      .select("assigned_employee_id, apartment_code, priority")
      .eq("organization_id", ORG_ID)
      .eq("issue_type_id", data.issue_type_id)
      .order("priority", { ascending: true });

    if (rules?.length) {
      const prefixMatch =
        data.apartment_code &&
        rules.find((r: any) => r.apartment_code && data.apartment_code?.startsWith(r.apartment_code));
      assignedTo = prefixMatch?.assigned_employee_id || rules[0].assigned_employee_id;
    }
  }

  if (!assignedTo) {
    const { data: allMembers, error: membersError } = await sb
      .from("team_members")
      .select("id, user_id, first_name, last_name")
      .eq("organization_id", ORG_ID)
      .eq("status", "active");

    console.log("[autoAssign] allMembers count:", allMembers?.length, "error:", membersError?.message);

    if (allMembers?.length) {
      const memberUserIds = allMembers.map((m: any) => m.user_id).filter(Boolean);

      const { data: techRoles } = await sb
        .from("user_roles")
        .select("user_id")
        .in("user_id", memberUserIds)
        .eq("role", "technician");

      const technicianUserIds = new Set((techRoles || []).map((r: any) => r.user_id));

      console.log("[autoAssign] technician user_ids from user_roles:", [...technicianUserIds]);

      const technicians = allMembers.filter((m: any) => technicianUserIds.has(m.user_id));
      const pool: any[] = technicians.length > 0 ? technicians : allMembers;

      console.log("[autoAssign] pool size:", pool.length, technicians.length > 0 ? "(technicians)" : "(all members fallback)");

      let min = Infinity;
      let best: string | null = null;

      for (const m of pool) {
        const assignKey = m.user_id || m.id;
        const { count } = await sb
          .from("maintenance_tickets")
          .select("*", { count: "exact", head: true })
          .eq("organization_id", ORG_ID)
          .eq("assigned_to", assignKey)
          .not("status", "in", "(closed,completed,pending_admin_approval,pending_tenant_approval)");

        console.log("[autoAssign] member:", m.first_name, assignKey, "open tickets:", count);

        if ((count || 0) < min) {
          min = count || 0;
          best = assignKey;
        }
      }

      assignedTo = best;
      console.log("[autoAssign] winner:", assignedTo);
    } else {
      console.warn("[autoAssign] No active team members found for org:", ORG_ID, "error:", membersError?.message);
    }
  }

  let assignedToName: string | null = null;
  let assignedToPhone: string | null = null;
  if (assignedTo) {
    const { data: m } = await sb
      .from("team_members")
      .select("first_name, last_name, phone")
      .eq("user_id", assignedTo)
      .eq("organization_id", ORG_ID)
      .single();
    if (m) {
      assignedToName  = `${m.first_name || ""} ${m.last_name || ""}`.trim();
      assignedToPhone = m.phone || null;
    }
  }

  const status = assignedTo ? "assigned" : "open";

  const extraMeta = {
    issue_type:          data.issue_type          || null,
    issue_subtype:       data.issue_subtype        || null,
    assigned_to_name:    assignedToName,
    assigned_to_phone:   assignedToPhone,
    apartment_code:      data.apartment_code       || null,
    source:              data.source               || null,
    voice_transcription: data.voice_transcription  || null,
  };

  const row = await insertRow("maintenance_tickets", {
    organization_id: ORG_ID,
    ticket_number:   ticketNumber,
    tenant_id:       resolvedTenantId  || null,
    property_id:     data.property_id  || null,
    apartment_id:    data.apartment_id || null,
    bed_id:          data.bed_id       || null,
    issue_type_id:   data.issue_type_id,
    description:     data.description  || null,
    priority,
    sla_deadline:    slaDeadline,
    assigned_to:     assignedTo,
    status,
    asset_id:        data.asset_id     || null,
    photo_urls:      data.photo_urls   || null,
    created_by:      data.created_by   || null,
    tenant_name:     tenantName,
    tenant_phone:    tenantPhone,
    diagnostic_data: extraMeta,
  });

  await insertRow("ticket_logs", {
    ticket_id:    row.id,
    action:       "Ticket created",
    new_status:   status,
    created_by:   data.created_by || null,
    notes:        `${ticketNumber} created. Issue: ${data.issue_type || "N/A"}. ${
      assignedTo
        ? `Auto-assigned to ${assignedToName || assignedTo}.`
        : "Awaiting assignment."
    }${data.source ? ` Source: ${data.source}` : ""}`,
    organization_id: ORG_ID,
  });

  // ── Send SMS to assigned technician ──────────────────────────────────────────
  if (assignedTo && assignedToPhone) {
    await sendTicketAssignmentSms({
      phone:         assignedToPhone,
      techName:      assignedToName || "Technician",
      ticketNumber,
      issueType:     data.issue_type     || null,
      apartmentCode: data.apartment_code || null,
      priority:      row.priority        || null,
      slaDeadline:   row.sla_deadline    || null,
    });
  }

  return row;
}

export const createTicket = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    return createTicketHelper(data);
  },
});

// ─── UPDATE TICKET STATUS ─────────────────────────────────────────────────────

export const updateTicketStatus = action({
  args: {
    ticketId:        v.string(),
    newStatus:       v.string(),
    userId:          v.string(),
    notes:           v.optional(v.string()),
    rejectionReason: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, { ticketId, newStatus, userId, notes, rejectionReason }) => {
    const sb = getSupabase();
    const { data: ticket } = await sb
      .from("maintenance_tickets")
      .select("status,created_by,tenant_id")
      .eq("id", ticketId)
      .single();
    if (!ticket) throw new Error("Ticket not found");

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };

    if (newStatus === "completed") {
      updates.resolved_at = new Date().toISOString();
      const isAdminCreated = !ticket.tenant_id;
      const pendingStatus  = isAdminCreated ? "pending_admin_approval" : "pending_tenant_approval";
      updates.status = pendingStatus;

      // ── Fetch raiser name to include in the approval-request log ─────
      let raiserName = "the requester";
      if (ticket.tenant_id) {
        const { data: tenant } = await sb
          .from("profiles")
          .select("full_name, first_name, last_name")
          .eq("id", ticket.tenant_id)
          .maybeSingle();
        if (tenant) {
          raiserName = tenant.full_name || `${tenant.first_name || ""} ${tenant.last_name || ""}`.trim() || "Tenant";
        }
      } else if (ticket.created_by) {
        const { data: creator } = await sb
          .from("profiles")
          .select("full_name, first_name, last_name")
          .eq("id", ticket.created_by)
          .maybeSingle();
        if (creator) {
          raiserName = creator.full_name || `${creator.first_name || ""} ${creator.last_name || ""}`.trim() || "Admin";
        }
      }

      // ── Insert approval-request log so the raiser sees the request ────
      await insertRow("ticket_logs", {
        ticket_id:    ticketId,
        action:       isAdminCreated ? "Approval request sent to Admin" : "Approval request sent to Tenant",
        new_status:   pendingStatus,
        created_by:   userId,
        notes:        `Work is complete. Approval request sent to ${raiserName}. Please review and approve or reject.`,
        organization_id: ORG_ID,
      });

      // ── Send push notification to ticket raiser ───────────────────────
      try {
        const raiserId = ticket.tenant_id || ticket.created_by;
        if (raiserId) {
          const { data: prof } = await sb
            .from("profiles")
            .select("push_token, full_name")
            .eq("id", raiserId)
            .maybeSingle();
          if (prof?.push_token) {
            await ctx.runAction(internal.notifications.sendNotification, {
              to:    prof.push_token,
              title: "Work Complete — Your Approval Needed",
              body:  `The work on your ticket has been completed. Please review and approve or reject.`,
              data:  { ticketId, screen: "ticket_detail" },
            });
          }
        }
      } catch (_notifErr) {
        // Notification failure must never block the status update
      }
    } else if (newStatus === "closed") {
      updates.status    = "closed";
      updates.closed_at = new Date().toISOString();
      updates.tenant_approved = true;
    } else if (newStatus === "in_progress" && rejectionReason) {
      updates.status                  = "in_progress";
      updates.tenant_approved         = false;
      updates.tenant_rejection_reason = rejectionReason;
      updates.resolved_at             = null;
    } else {
      updates.status = newStatus;
    }

    await updateRow("maintenance_tickets", ticketId, updates);

    // Only log generic status change when NOT completed (completed already logged approval-request above)
    if (newStatus !== "completed") {
      await insertRow("ticket_logs", {
        ticket_id:   ticketId,
        action:      `Status → ${updates.status || newStatus}`,
        old_status:  ticket.status,
        new_status:  updates.status || newStatus,
        created_by:  userId,
        notes:       notes || rejectionReason || null,
        organization_id: ORG_ID,
      });
    }

    return { success: true, newStatus: updates.status || newStatus };
  },
});

// ─── UPDATE LINKED ASSET ──────────────────────────────────────────────────────
// Assign / change / remove the asset linked to a ticket (web TicketDetail parity).
// Pass assetId = null to unlink. Returns the rebuilt linked_asset for the UI.
export const updateTicketAsset = action({
  args: {
    ticketId: v.string(),
    assetId:  v.union(v.string(), v.null()),
  },
  returns: v.any(),
  handler: async (_ctx, { ticketId, assetId }) => {
    const sb = getSupabase();
    const { error } = await sb
      .from("maintenance_tickets")
      .update({ asset_id: assetId, updated_at: new Date().toISOString() })
      .eq("id", ticketId)
      .eq("organization_id", ORG_ID);
    if (error) throw new Error(error.message);

    let linked_asset: any = null;
    if (assetId) {
      const { data: asset } = await sb
        .from("assets").select("id, asset_code, brand, model, condition")
        .eq("organization_id", ORG_ID).eq("id", assetId).single();
      if (asset) {
        linked_asset = {
          id: asset.id,
          asset_code: asset.asset_code,
          label: [asset.brand, asset.model].filter(Boolean).join(" ") || asset.asset_code,
          condition: asset.condition || null,
        };
      }
    }
    return { success: true, asset_id: assetId, linked_asset };
  },
});

// ─── REASSIGN TICKET ──────────────────────────────────────────────────────────

export const reassignTicket = action({
  args: {
    ticketId:      v.string(),
    newAssigneeId: v.string(),
    userId:        v.string(),
    notes:         v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, { ticketId, newAssigneeId, userId, notes }) => {
    const sb = getSupabase();
    const { data: m } = await sb
      .from("team_members")
      .select("first_name, last_name, phone")
      .eq("user_id", newAssigneeId)
      .eq("organization_id", ORG_ID)
      .single();
    const name = m ? `${m.first_name || ""} ${m.last_name || ""}`.trim() : null;

    const { data: existingTicket } = await sb
      .from("maintenance_tickets")
      .select("diagnostic_data, issue_type_id")
      .eq("id", ticketId)
      .single();

    const updatedMeta = {
      ...(existingTicket?.diagnostic_data || {}),
      assigned_to_name:  name,
      assigned_to_phone: m?.phone || null,
    };

    // Recalculate SLA from the issue type
    let newSlaDeadline: string | null = null;
    if (existingTicket?.issue_type_id) {
      const { data: it } = await sb
        .from("issue_types")
        .select("sla_hours")
        .eq("id", existingTicket.issue_type_id)
        .single();
      const slaHours = it?.sla_hours || 24;
      newSlaDeadline = calcWorkingHoursSlaDeadline(new Date(), slaHours).toISOString();
    }

    await updateRow("maintenance_tickets", ticketId, {
      assigned_to:     newAssigneeId,
      status:          "assigned",
      updated_at:      new Date().toISOString(),
      diagnostic_data: updatedMeta,
      ...(newSlaDeadline ? { sla_deadline: newSlaDeadline } : {}),
    });

    await insertRow("ticket_logs", {
      ticket_id:    ticketId,
      action:       "Ticket reassigned",
      new_status:   "assigned",
      created_by:   userId,
      notes:        `${notes || `Reassigned to ${name || newAssigneeId}`}${newSlaDeadline ? `. SLA reset to ${new Date(newSlaDeadline).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`,
      organization_id: ORG_ID,
    });

    // ── Send SMS to newly assigned technician ────────────────────────────────
    const techPhone = m?.phone || null;
    if (techPhone) {
      // Fetch ticket details for the SMS (issue type + apartment code)
      const sb2 = getSupabase();
      const { data: tkt } = await sb2
        .from("maintenance_tickets")
        .select("ticket_number, priority, sla_deadline, diagnostic_data")
        .eq("id", ticketId)
        .single();

      await sendTicketAssignmentSms({
        phone:         techPhone,
        techName:      name || "Technician",
        ticketNumber:  tkt?.ticket_number || ticketId,
        issueType:     tkt?.diagnostic_data?.issue_type     || null,
        apartmentCode: tkt?.diagnostic_data?.apartment_code || null,
        priority:      tkt?.priority                        || null,
        slaDeadline:   newSlaDeadline || tkt?.sla_deadline  || null,
      });
    }

    return { success: true };
  },
});

// ─── SUBMIT DIAGNOSIS ─────────────────────────────────────────────────────────

export const submitDiagnosis = action({
  args: {
    ticketId:         v.string(),
    issueTypeId:      v.string(),
    questionsAnswers: v.any(),
    aiDiagnosis:      v.optional(v.string()),
    employeeOverride: v.optional(v.string()),
    performedBy:      v.string(),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    const { data: existing } = await sb
      .from("diagnostic_sessions")
      .select("id")
      .eq("ticket_id", args.ticketId)
      .maybeSingle();

    const diagData = {
      ticket_id:        args.ticketId,
      organization_id:  ORG_ID,
      issue_type_id:    args.issueTypeId,
      performed_by:     args.performedBy,
      questions_answers: args.questionsAnswers,
      ai_diagnosis:     args.aiDiagnosis    || null,
      employee_override: args.employeeOverride || null,
      status:           "completed",
      completed_at:     new Date().toISOString(),
    };

    if (existing?.id) { await updateRow("diagnostic_sessions", existing.id, diagData); }
    else              { await insertRow("diagnostic_sessions", diagData); }

    const diagResult = args.employeeOverride || args.aiDiagnosis || "";
    await updateRow("maintenance_tickets", args.ticketId, {
      diagnosis:       diagResult,
      diagnostic_data: { answers: args.questionsAnswers, result: diagResult, performed_at: new Date().toISOString() },
      updated_at:      new Date().toISOString(),
    });

    const qaSummary = Object.entries(args.questionsAnswers || {})
      .map(([q, a]) => `Q: ${q} → A: ${a}`)
      .join("; ");

    await insertRow("ticket_logs", {
      ticket_id:    args.ticketId,
      action:       "Diagnosis completed",
      created_by:   args.performedBy,
      notes:        `${qaSummary}. Result: ${diagResult}`,
      organization_id: ORG_ID,
    });

    // Auto-transition assigned → in_progress after first diagnosis (mirrors web app)
    const { data: currentTicket } = await sb
      .from("maintenance_tickets")
      .select("status")
      .eq("id", args.ticketId)
      .maybeSingle();
    if (currentTicket?.status === "assigned") {
      await updateRow("maintenance_tickets", args.ticketId, { status: "in_progress" });
      await insertRow("ticket_logs", {
        ticket_id:    args.ticketId,
        action:       "Status → in_progress",
        old_status:   "assigned",
        new_status:   "in_progress",
        created_by:   args.performedBy,
        notes:        "Auto-transitioned to In Progress after diagnostics completion.",
        organization_id: ORG_ID,
      });
    }

    return { success: true };
  },
});

// ─── SUBMIT COST ESTIMATES ────────────────────────────────────────────────────

export const submitCostEstimates = action({
  args: {
    ticketId:    v.string(),
    items:       v.array(v.any()),
    submittedBy: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, { ticketId, items, submittedBy }) => {
    const sb = getSupabase();
    const inserted = [];

    for (const item of items) {
      const total = (item.quantity || 1) * (item.unit_price || 0);
      const row = await insertRow("ticket_cost_estimates", {
        ticket_id:       ticketId,
        organization_id: ORG_ID,
        item_name:       item.item_name,
        cost_type:       item.cost_type || "parts",
        quantity:        item.quantity  || 1,
        unit_price:      item.unit_price || 0,
        total,
        submitted_by:    submittedBy,
        status:          "pending",
      });
      inserted.push(row);

      await insertRow("ticket_logs", {
        ticket_id:       ticketId,
        action:          "Cost estimate submitted",
        created_by:      submittedBy,
        notes:           `${item.item_name} x${item.quantity || 1} @ ₹${item.unit_price || 0} = ₹${total}`,
        organization_id: ORG_ID,
      });
    }

    await updateRow("maintenance_tickets", ticketId, {
      status:     "waiting_for_cost_approval",
      updated_at: new Date().toISOString(),
    });

    // ── AUTO-APPROVAL + REPEAT JOB DETECTION (mirrors web saveDiagnostic) ────
    // Threshold + repeat-window come from org settings (web parity), default 1000 / 30d.
    const { data: orgSettings } = await sb
      .from("organizations")
      .select("ticket_auto_approve_threshold, ticket_repeat_check_days")
      .eq("id", ORG_ID)
      .maybeSingle();
    const AUTO_APPROVE_THRESHOLD = Number((orgSettings as any)?.ticket_auto_approve_threshold) || 1000;
    const REPEAT_CHECK_DAYS = Number((orgSettings as any)?.ticket_repeat_check_days) || 30;
    const totalEstimatedCost = items.reduce((s: number, i: any) => s + ((i.quantity || 1) * (i.unit_price || 0)), 0);

    const { data: ticketCtx } = await sb
      .from("maintenance_tickets")
      .select("apartment_id, bed_id, issue_type_id, property_id, organization_id, issue_types(name)")
      .eq("id", ticketId)
      .maybeSingle();

    // 1. Check for repeat job (same issue in same apartment within the configured window)
    let isRepeatJob = false;
    if (ticketCtx?.apartment_id && ticketCtx?.issue_type_id) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - REPEAT_CHECK_DAYS);
      let repeatQ = sb
        .from("maintenance_tickets")
        .select("id, ticket_number, created_at")
        .eq("organization_id", ORG_ID)
        .eq("apartment_id", ticketCtx.apartment_id)
        .eq("issue_type_id", ticketCtx.issue_type_id)
        .in("status", ["completed", "closed"])
        .gte("created_at", cutoff.toISOString())
        .neq("id", ticketId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (ticketCtx.bed_id) repeatQ = (repeatQ as any).eq("bed_id", ticketCtx.bed_id);
      const { data: repeatTickets } = await repeatQ;
      isRepeatJob = !!(repeatTickets && repeatTickets.length > 0);

      if (isRepeatJob) {
        const prev = (repeatTickets as any[])[0];
        const daysAgo = Math.floor((Date.now() - new Date(prev.created_at).getTime()) / 86400000);
        await sb.from("ticket_cost_estimates" as any)
          .update({ repeat_job_alert: true, repeat_job_previous_ticket_id: prev.id })
          .eq("ticket_id", ticketId);
        await insertRow("ticket_logs", {
          ticket_id:       ticketId,
          organization_id: ORG_ID,
          action:          "Repeat Job Alert",
          notes:           `Same issue (${(ticketCtx as any).issue_types?.name || "unknown"}) resolved in this apartment ${daysAgo} days ago (Ticket #${prev.ticket_number}). Manual approval required.`,
          created_by:      submittedBy,
        });
        // Already set to waiting_for_cost_approval above — no further status change needed
      }
    }

    // 2. Auto-approve if under threshold AND not a repeat job
    if (!isRepeatJob && totalEstimatedCost > 0 && totalEstimatedCost <= AUTO_APPROVE_THRESHOLD) {
      await sb.from("ticket_cost_estimates" as any)
        .update({
          status:               "approved",
          is_auto_approved:     true,
          auto_approval_reason: `Auto-approved: total ₹${Math.round(totalEstimatedCost)} is under ₹${AUTO_APPROVE_THRESHOLD} threshold`,
          approved_at:          new Date().toISOString(),
        })
        .eq("ticket_id", ticketId);
      await updateRow("maintenance_tickets", ticketId, {
        status:     "waiting_for_parts",
        updated_at: new Date().toISOString(),
      });
      await insertRow("ticket_logs", {
        ticket_id:       ticketId,
        organization_id: ORG_ID,
        action:          "Cost auto-approved",
        notes:           `Total ₹${Math.round(totalEstimatedCost)} is under ₹${AUTO_APPROVE_THRESHOLD} threshold — auto-approved. Ticket moved to Waiting for Parts.`,
        created_by:      submittedBy,
      });
    }

    // ── Send push notification to the cost-approval team member ──────────
    // Fetch from cost_estimate_approvers table — no hardcoding
    try {
      // 1. Get all approver user_ids for this org
      const { data: approverRows } = await sb
        .from("cost_estimate_approvers")
        .select("approver_user_id, scope_type, property_id, issue_type_id")
        .eq("organization_id", ORG_ID);

      if (approverRows && approverRows.length > 0) {
        // 2. Fetch ticket details for scope matching + notification body
        const { data: ticket } = await sb
          .from("maintenance_tickets")
          .select(`
            ticket_number, property_id, issue_type_id, description, priority, status,
            tenant_name, apartment_code,
            properties(property_name),
            issue_types(name)
          `)
          .eq("id", ticketId)
          .maybeSingle();

        // 3. Filter approvers by scope (global / matching property / matching issue_type)
        const matchedApprovers = approverRows.filter((rule: any) => {
          if (rule.scope_type === "global") return true;
          if (rule.scope_type === "property" && ticket?.property_id && rule.property_id === ticket.property_id) return true;
          if (rule.scope_type === "issue_type" && ticket?.issue_type_id && rule.issue_type_id === ticket.issue_type_id) return true;
          return false;
        });

        if (matchedApprovers.length > 0) {
          // 4. Fetch push tokens from profiles for matched approver user_ids
          const approverUserIds = [...new Set(matchedApprovers.map((a: any) => a.approver_user_id))];
          const { data: approverProfiles } = await sb
            .from("profiles")
            .select("id, push_token, full_name")
            .in("id", approverUserIds);

          // 5. Fetch recent timeline logs for notification body
          const { data: recentLogs } = await sb
            .from("ticket_logs")
            .select("action, notes, created_at")
            .eq("ticket_id", ticketId)
            .order("created_at", { ascending: false })
            .limit(3);

          // 6. Fetch diagnosis if available
          const { data: diagSession } = await sb
            .from("diagnostic_sessions")
            .select("ai_diagnosis, completed_at")
            .eq("ticket_id", ticketId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          // Build notification body
          const ticketNum = ticket?.ticket_number || ticketId.slice(0, 8);
          const propertyName = (ticket as any)?.properties?.property_name || "—";
          const issueType = (ticket as any)?.issue_types?.name || "—";
          const tenantName = ticket?.tenant_name || "—";
          const totalEstimated = items.reduce((s: number, i: any) => s + ((i.quantity || 1) * (i.unit_price || 0)), 0);
          const itemsSummary = items.map((i: any) => `${i.item_name} x${i.quantity || 1} @ ₹${i.unit_price || 0}`).join(", ");

          let diagSummary = "";
          if (diagSession?.ai_diagnosis) {
            const d = typeof diagSession.ai_diagnosis === "string"
              ? (() => { try { return JSON.parse(diagSession.ai_diagnosis); } catch { return null; } })()
              : diagSession.ai_diagnosis;
            if (d?.cause) diagSummary = `Diagnosis: ${d.cause}. `;
          }

          const notifTitle = `Cost Approval Needed — ${ticketNum}`;
          const notifBody = [
            `${issueType} at ${propertyName}`,
            `Tenant: ${tenantName}`,
            diagSummary ? diagSummary.trim() : null,
            `Items: ${itemsSummary}`,
            `Total: ₹${totalEstimated.toLocaleString("en-IN")}`,
          ].filter(Boolean).join(" | ");

          // 7. Send push notification to each matched approver
          for (const prof of (approverProfiles || [])) {
            if (prof?.push_token) {
              await ctx.runAction(internal.notifications.sendNotification, {
                to:    prof.push_token,
                title: notifTitle,
                body:  notifBody,
                data:  {
                  screen:    "ticket_detail",
                  ticketId,
                  type:      "cost_approval",
                },
              });
            }
          }
        }
      }
    } catch (_notifErr) {
      // Notification failure must never block the cost estimate submission
    }

    return { success: true, estimates: inserted };
  },
});

// ─── GET COST ESTIMATES ───────────────────────────────────────────────────────

export const getCostEstimates = action({
  args: { ticketId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { ticketId }) => {
    const sb = getSupabase();
    return await safeList(
      sb.from("ticket_cost_estimates").select("*").eq("ticket_id", ticketId).order("created_at", { ascending: true })
    );
  },
});

// ─── APPROVE / DECLINE COST ───────────────────────────────────────────────────

export const approveCostEstimate = action({
  args: {
    estimateId:        v.string(),
    ticketId:          v.string(),
    action:            v.union(v.literal("approve"), v.literal("decline")),
    approvedBy:        v.string(),
    declineReason:     v.optional(v.string()),
    modifiedQuantity:  v.optional(v.number()),
    modifiedUnitPrice: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    const { data: estimate } = await sb
      .from("ticket_cost_estimates")
      .select("quantity, unit_price, item_name")
      .eq("id", args.estimateId)
      .single();

    const updates: Record<string, any> = {
      status:      args.action === "approve" ? "approved" : "declined",
      approved_by: args.approvedBy,
      approved_at: new Date().toISOString(),
    };
    if (args.action === "decline") updates.decline_reason = args.declineReason || null;
    if (args.action === "approve" && args.modifiedQuantity  !== undefined) updates.quantity   = args.modifiedQuantity;
    if (args.action === "approve" && args.modifiedUnitPrice !== undefined) {
      updates.unit_price = args.modifiedUnitPrice;
      updates.total      = (args.modifiedQuantity || estimate?.quantity || 1) * args.modifiedUnitPrice;
    }

    await sb.from("ticket_cost_estimates").update(updates).eq("id", args.estimateId);

    const { data: all } = await sb.from("ticket_cost_estimates").select("status").eq("ticket_id", args.ticketId);
    const pending  = all?.filter((e: any) => e.status === "pending")  || [];
    const approved = all?.filter((e: any) => e.status === "approved") || [];
    let newTicketStatus: string | null = null;
    if (pending.length === 0) {
      newTicketStatus = approved.length > 0 ? "waiting_for_parts" : "in_progress";
    }

    if (newTicketStatus) {
      await updateRow("maintenance_tickets", args.ticketId, {
        status:     newTicketStatus,
        updated_at: new Date().toISOString(),
      });
    }

    await insertRow("ticket_logs", {
      ticket_id:    args.ticketId,
      action:       `Cost ${args.action === "approve" ? "approved" : "declined"}`,
      created_by:   args.approvedBy,
      notes:        args.action === "decline"
        ? `Declined: ${args.declineReason}`
        : `Approved: ${estimate?.item_name}`,
      organization_id: ORG_ID,
    });

    return { success: true, newTicketStatus };
  },
});

// ─── RECORD PURCHASE ──────────────────────────────────────────────────────────

export const recordPurchase = action({
  args: {
    ticketId:         v.string(),
    items:            v.array(v.any()),
    vendorId:         v.optional(v.string()),
    vendorNameManual: v.optional(v.string()),
    invoiceUrl:       v.optional(v.string()),
    purchasedBy:      v.string(),
    costEstimateId:   v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    const totalCost = args.items.reduce((s: number, i: any) => s + (i.actual_cost || 0), 0);

    const purchase = await insertRow("ticket_purchases", {
      ticket_id:          args.ticketId,
      organization_id:    ORG_ID,
      cost_estimate_id:   args.costEstimateId  || null,
      actual_cost:        totalCost,
      vendor_id:          args.vendorId         || null,
      vendor_name_manual: args.vendorNameManual || null,
      invoice_url:        args.invoiceUrl       || null,
      purchased_by:       args.purchasedBy,
      purchase_date:      new Date().toISOString().split("T")[0],
    });

    const { data: ticket } = await sb
      .from("maintenance_tickets")
      .select("bed_id, apartment_id, property_id, tenant_id, issue_type_id, diagnostic_data")
      .eq("id", args.ticketId)
      .single();

    if (ticket) {
      let costScope = "bed";
      let distributedBeds: any = {};

      if (ticket.bed_id) {
        distributedBeds = { [ticket.bed_id]: totalCost };
      } else if (ticket.apartment_id) {
        costScope = "apartment";
        const { data: beds } = await sb.from("beds").select("id").eq("apartment_id", ticket.apartment_id);
        if (beds?.length) {
          const perBed = totalCost / beds.length;
          beds.forEach((b: any) => { distributedBeds[b.id] = perBed; });
        }
      } else {
        costScope = "property";
      }

      await insertRow("running_bed_maintenance_details", {
        ticket_id:         args.ticketId,
        purchase_id:       purchase.id,
        organization_id:   ORG_ID,
        tenant_id:         ticket.tenant_id    || null,
        bed_id:            ticket.bed_id       || null,
        apartment_id:      ticket.apartment_id || null,
        property_id:       ticket.property_id  || null,
        item_name:         args.items.map((i: any) => i.item_name).join(", "),
        quantity:          args.items.reduce((s: number, i: any) => s + (i.quantity || 1), 0),
        actual_cost:       totalCost,
        vendor_name:       args.vendorNameManual || null,
        cost_scope:        costScope,
        distributed_amount: totalCost,
        billing_month:     new Date().toISOString().substring(0, 7),
        maintenance_type:  ticket.diagnostic_data?.issue_type || "maintenance",
        parts_details:     args.items,
        distributed_beds:  distributedBeds,
      });
    }

    await updateRow("maintenance_tickets", args.ticketId, {
      status:     "in_progress",
      updated_at: new Date().toISOString(),
    });

    await insertRow("ticket_logs", {
      ticket_id:    args.ticketId,
      action:       "Purchase recorded",
      created_by:   args.purchasedBy,
      notes:        `₹${totalCost} from ${args.vendorNameManual || "vendor"}`,
      organization_id: ORG_ID,
    });

    return { success: true, purchase };
  },
});

// ─── GET PURCHASES ────────────────────────────────────────────────────────────

export const getPurchases = action({
  args: { ticketId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { ticketId }) => {
    const sb = getSupabase();
    return await safeList(
      sb.from("ticket_purchases").select("*").eq("ticket_id", ticketId).order("created_at", { ascending: false })
    );
  },
});

// ─── TENANT APPROVE / REJECT ──────────────────────────────────────────────────

export const tenantApproveCompletion = action({
  args: {
    ticketId:        v.string(),
    approved:        v.boolean(),
    userId:          v.string(),
    rejectionReason: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, { ticketId, approved, userId, rejectionReason }) => {
    const updates: Record<string, any> = {
      tenant_approved: approved,
      updated_at:      new Date().toISOString(),
    };
    if (approved) {
      updates.status    = "closed";
      updates.closed_at = new Date().toISOString();
    } else {
      updates.status                  = "in_progress";
      updates.tenant_rejection_reason = rejectionReason || null;
      updates.resolved_at             = null;
    }

    await updateRow("maintenance_tickets", ticketId, updates);
    await insertRow("ticket_logs", {
      ticket_id:    ticketId,
      action:       approved ? "Completion approved by Tenant" : "Completion rejected by Tenant",
      new_status:   updates.status,
      created_by:   userId,
      notes:        approved ? "Tenant approved — ticket closed" : `Tenant rejected: ${rejectionReason || ""}`,
      organization_id: ORG_ID,
    });

    return { success: true };
  },
});

// ─── ADMIN APPROVE / REJECT ───────────────────────────────────────────────────

export const adminApproveCompletion = action({
  args: {
    ticketId:        v.string(),
    approved:        v.boolean(),
    userId:          v.string(),
    rejectionReason: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, { ticketId, approved, userId, rejectionReason }) => {
    const updates: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };
    if (approved) {
      updates.status    = "closed";
      updates.closed_at = new Date().toISOString();
    } else {
      updates.status          = "in_progress";
      updates.resolved_at     = null;
    }

    await updateRow("maintenance_tickets", ticketId, updates);
    await insertRow("ticket_logs", {
      ticket_id:    ticketId,
      action:       approved ? "Completion approved by Admin" : "Completion rejected by Admin",
      new_status:   updates.status,
      created_by:   userId,
      notes:        approved ? "Admin approved — ticket closed" : `Admin rejected: ${rejectionReason || ""}`,
      organization_id: ORG_ID,
    });

    return { success: true };
  },
});

// ─── LOOKUP DATA ──────────────────────────────────────────────────────────────

export const getIssueTypes = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    // Embed the linked asset types (via the issue_type_asset_types junction) so the
    // mobile Categories tab can show them, matching the web app.
    return await safeList(
      sb.from("issue_types")
        .select("*, issue_type_asset_types(asset_type_id, asset_types(id, name))")
        .eq("organization_id", ORG_ID)
        .order("name", { ascending: true })
    );
  },
});

// Lightweight asset-type list for the category edit multi-select.
export const listAssetTypesLite = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return await safeList(
      sb.from("asset_types").select("id, name").eq("organization_id", ORG_ID).order("name", { ascending: true })
    );
  },
});

// Edit a ticket category (issue type) + replace its linked asset types (web parity).
export const updateIssueType = action({
  args: {
    issueTypeId: v.string(),
    name: v.optional(v.string()),
    icon: v.optional(v.string()),
    priority: v.optional(v.string()),
    slaHours: v.optional(v.number()),
    assetTypeIds: v.optional(v.array(v.string())),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    const patch: any = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.icon !== undefined) patch.icon = args.icon;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.slaHours !== undefined) patch.sla_hours = args.slaHours;
    if (Object.keys(patch).length > 0) {
      const { error } = await sb.from("issue_types").update(patch).eq("id", args.issueTypeId).eq("organization_id", ORG_ID);
      if (error) throw new Error(`Update category failed: ${error.message}`);
    }
    // Replace asset-type links: delete all for this category, re-insert the selection.
    if (args.assetTypeIds !== undefined) {
      await sb.from("issue_type_asset_types").delete().eq("issue_type_id", args.issueTypeId).eq("organization_id", ORG_ID);
      if (args.assetTypeIds.length > 0) {
        const rows = args.assetTypeIds.map((atId) => ({ organization_id: ORG_ID, issue_type_id: args.issueTypeId, asset_type_id: atId }));
        const { error } = await sb.from("issue_type_asset_types").insert(rows);
        if (error) throw new Error(`Link asset types failed: ${error.message}`);
      }
    }
    return { success: true };
  },
});

// Delete a ticket category — remove its asset-type links first, then the category.
export const deleteIssueType = action({
  args: { issueTypeId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { issueTypeId }) => {
    const sb = getSupabase();
    await sb.from("issue_type_asset_types").delete().eq("issue_type_id", issueTypeId).eq("organization_id", ORG_ID);
    const { error } = await sb.from("issue_types").delete().eq("id", issueTypeId).eq("organization_id", ORG_ID);
    if (error) throw new Error(`Delete category failed: ${error.message}`);
    return { success: true };
  },
});

// Regular (recurring) maintenance rules — powers the admin Tickets → "Regular" tab.
// Reads the real `regular_maintenance_rules` table and resolves the issue-type name
// for display. (Previously this tab wrongly loaded issue types as stand-in "rules".)
export const listRegularMaintenanceRules = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rules = await safeList(
      sb.from("regular_maintenance_rules")
        .select("id, maintenance_type, frequency, issue_type_id, is_active, next_run_at, created_at")
        .eq("organization_id", ORG_ID)
        .order("created_at", { ascending: false })
    );
    const typeIds = [...new Set(rules.map((r: any) => r.issue_type_id).filter(Boolean))];
    const types = typeIds.length
      ? await safeList(sb.from("issue_types").select("id, name").eq("organization_id", ORG_ID).in("id", typeIds))
      : [];
    const typeName = new Map<string, string>();
    for (const t of types) typeName.set(t.id, t.name);
    return rules.map((r: any) => ({
      id: r.id,
      name: r.maintenance_type || typeName.get(r.issue_type_id) || "Maintenance Rule",
      frequency: r.frequency || null,
      issue_type: r.issue_type_id ? (typeName.get(r.issue_type_id) || null) : null,
      is_active: r.is_active,
      next_run_at: r.next_run_at || null,
    }));
  },
});

export const getIssueSubTypes = action({
  args: { issueTypeId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { issueTypeId }) => {
    const sb = getSupabase();
    return await safeList(
      sb.from("issue_sub_types").select("*").eq("issue_type_id", issueTypeId).eq("organization_id", ORG_ID).order("sort_order", { ascending: true })
    );
  },
});

export const getTeamMembers = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    // Fetch only technicians — exclude admins/managers from the reassign list
    const allMembers = await safeList(
      sb.from("team_members").select("*").eq("organization_id", ORG_ID).eq("status", "active")
    );
    if (!allMembers.length) return [];

    const memberUserIds = allMembers.map((m: any) => m.user_id).filter(Boolean);
    const { data: techRoles } = await sb
      .from("user_roles")
      .select("user_id")
      .in("user_id", memberUserIds)
      .eq("role", "technician");

    const technicianUserIds = new Set((techRoles || []).map((r: any) => r.user_id));
    // If no explicit technician roles found, fall back to all active members
    if (technicianUserIds.size === 0) return allMembers;
    return allMembers.filter((m: any) => technicianUserIds.has(m.user_id));
  },
});

export const getDiagnosticSession = action({
  args: { ticketId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { ticketId }) => {
    const sb = getSupabase();
    const { data } = await sb
      .from("diagnostic_sessions")
      .select("*")
      .eq("ticket_id", ticketId)
      .maybeSingle();
    return data || null;
  },
});

export const checkTenantPendingTickets = action({
  args: { tenantId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { tenantId }) => {
    const sb = getSupabase();
    const { data, count } = await sb
      .from("maintenance_tickets")
      .select("id, ticket_number, status", { count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("status", "pending_tenant_approval");
    return { hasPending: (count || 0) > 0, tickets: data || [] };
  },
});

export const getCostApprovers = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return await safeList(
      sb.from("cost_estimate_approvers").select("*").eq("organization_id", ORG_ID)
    );
  },
});

export const getProperties = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return await safeList(
      sb.from("properties").select("id, property_name").eq("organization_id", ORG_ID).order("property_name", { ascending: true })
    );
  },
});

export const getApartments = action({
  args: { propertyId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { propertyId }) => {
    const sb = getSupabase();
    return await safeList(
      sb.from("apartments").select("id, apartment_code, property_id").eq("property_id", propertyId).order("apartment_code", { ascending: true })
    );
  },
});

export const getBeds = action({
  args: { apartmentId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { apartmentId }) => {
    const sb = getSupabase();
    return await safeList(
      sb.from("beds").select("id, bed_code, apartment_id, bed_type, toilet_type").eq("apartment_id", apartmentId).order("bed_code", { ascending: true })
    );
  },
});

// ─── UPLOAD PHOTO ─────────────────────────────────────────────────────────────

export const uploadPhoto = action({
  args: {
    base64:   v.string(),
    mimeType: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, { base64, mimeType = "image/jpeg" }) => {
    const sb = getSupabase();
    const BUCKET = "ticket-photos";

    const { data: buckets } = await sb.storage.listBuckets();
    const exists = buckets?.some((b: any) => b.name === BUCKET);
    if (!exists) {
      const { error: bucketErr } = await sb.storage.createBucket(BUCKET, {
        public: true,
        fileSizeLimit: 10 * 1024 * 1024,
      });
      if (bucketErr && !bucketErr.message?.includes("already exists")) {
        console.warn("[uploadPhoto] bucket create error:", bucketErr.message);
      }
    }

    const buffer   = Buffer.from(base64, "base64");
    const ext      = mimeType.includes("png") ? "png" : mimeType.includes("gif") ? "gif" : "jpg";
    const fileName = `tickets/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

    const { error: uploadErr } = await sb.storage
      .from(BUCKET)
      .upload(fileName, buffer, { contentType: mimeType, upsert: false });

    if (uploadErr) {
      console.error("[uploadPhoto] upload error:", uploadErr.message);
      return { success: false, error: uploadErr.message };
    }

    const { data } = sb.storage.from(BUCKET).getPublicUrl(fileName);
    return { success: true, url: data?.publicUrl ?? null };
  },
});

// ─── SAVE TICKET RESOLUTION ───────────────────────────────────────────────────
// Saves resolution details before marking ticket complete. Mirrors web
// ticket_resolutions table write + updateStatus('completed') in one atomic action.

export const saveResolution = action({
  args: {
    ticketId:             v.string(),
    userId:               v.string(),
    resolutionType:       v.string(),
    serviceType:          v.string(),
    closureSummary:       v.string(),
    totalLabourCost:      v.optional(v.number()),
    vendorNameManual:     v.optional(v.string()),
    vendorId:             v.optional(v.string()),
    items:                v.optional(v.array(v.any())),
    paymentDate:          v.optional(v.string()),
    bankAccountId:        v.optional(v.string()),
    paymentReferenceNo:   v.optional(v.string()),
    proofOfPurchaseUrl:   v.optional(v.string()),
    proofOfPaymentUrl:    v.optional(v.string()),
    isUnlockEdit:         v.optional(v.boolean()),  // editing a closed ticket
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    const { data: ticket } = await sb
      .from("maintenance_tickets")
      .select("status, tenant_id, created_by, property_id, apartment_id, bed_id, issue_type_id, asset_id, ticket_number, organization_id")
      .eq("id", args.ticketId)
      .single();
    if (!ticket) throw new Error("Ticket not found");

    const totalParts = (args.items || []).reduce((s: number, i: any) => s + ((i.qty || 1) * (i.unit_cost || 0)), 0);
    const totalCost  = totalParts + (args.totalLabourCost || 0);

    // Validate: if cost > 0, payment details required (mirrors web saveResolution)
    if (totalCost > 0) {
      if (!args.paymentDate)        throw new Error("Payment date is required when actual cost is greater than 0.");
      if (!args.bankAccountId)      throw new Error("Bank account is required when actual cost is greater than 0.");
      if (!args.paymentReferenceNo) throw new Error("Payment reference no. is required when actual cost is greater than 0.");
      if (!args.proofOfPurchaseUrl) throw new Error("Bill of purchase is required to complete resolution when cost is involved.");
    }

    // Save / upsert resolution row
    const { data: existing } = await sb.from("ticket_resolutions").select("id").eq("ticket_id", args.ticketId).maybeSingle();
    const resPayload: any = {
      ticket_id:              args.ticketId,
      organization_id:        ORG_ID,
      resolution_type:        args.resolutionType,
      service_type:           args.serviceType,
      closure_summary:        args.closureSummary,
      total_labour_cost:      args.totalLabourCost || 0,
      total_parts_cost:       totalParts,
      total_cost:             totalCost,
      vendor_name_manual:     args.vendorNameManual || null,
      vendor_id:              args.vendorId || null,
      items_used:             args.items || [],
      actual_items_used:      args.items || [],
      actual_total_cost:      totalCost,
      payment_date:           args.paymentDate || null,
      bank_account_id:        args.bankAccountId || null,
      payment_reference_no:   args.paymentReferenceNo || null,
      proof_of_purchase_url:  args.proofOfPurchaseUrl || null,
      proof_of_payment_url:   args.proofOfPaymentUrl || null,
      resolved_by:            args.userId,
      resolved_at:            new Date().toISOString(),
    };

    let resolutionRowId: string | undefined;
    if (existing?.id) {
      await sb.from("ticket_resolutions").update(resPayload).eq("id", existing.id);
      resolutionRowId = existing.id;
      await sb.from("maintenance_tickets").update({ resolution_id: existing.id } as any).eq("id", args.ticketId);
    } else {
      const { data: res } = await sb.from("ticket_resolutions").insert(resPayload).select("id").single();
      resolutionRowId = res?.id;
      if (res?.id) await sb.from("maintenance_tickets").update({ resolution_id: res.id } as any).eq("id", args.ticketId);
    }

    // If editing an unlocked closed ticket, do NOT change status
    if (args.isUnlockEdit) {
      const itemSummary = (args.items || []).filter((i: any) => i.name).map((i: any) => `${i.name} × ${i.qty}`).join("; ");
      await insertRow("ticket_logs", {
        ticket_id:       args.ticketId,
        action:          "Resolution updated (admin unlock)",
        created_by:      args.userId,
        notes:           `Edited on closed ticket. Cost: ₹${Math.round(totalCost)}${itemSummary ? ` | Items: ${itemSummary}` : ""}`,
        organization_id: ORG_ID,
      });
      // Sync expense even for closed-ticket edits
      if (resolutionRowId && totalCost > 0 && args.paymentDate) {
        await _syncExpenseToSupabase(sb, ticket, resolutionRowId, totalCost, args.paymentDate, args.vendorId || null, args.proofOfPurchaseUrl || null, args.closureSummary);
      }
      return { success: true, newStatus: ticket.status };
    }

    // Determine approval routing (same as web). Admin-created tickets with NO cost
    // estimates need no approval step → auto-close.
    const isAdminCreated = !ticket.tenant_id;
    let pendingStatus: string = isAdminCreated ? "pending_admin_approval" : "pending_tenant_approval";
    if (isAdminCreated) {
      const { data: estRows } = await sb
        .from("ticket_cost_estimates")
        .select("id")
        .eq("ticket_id", args.ticketId)
        .limit(1);
      if (!estRows || (estRows as any[]).length === 0) pendingStatus = "closed";
    }
    await sb.from("maintenance_tickets").update({
      status:      pendingStatus,
      resolved_at: new Date().toISOString(),
      updated_at:  new Date().toISOString(),
    } as any).eq("id", args.ticketId);

    // Sync expense to accounting (mirrors web syncTicketResolutionExpense)
    if (resolutionRowId && totalCost > 0 && args.paymentDate) {
      await _syncExpenseToSupabase(sb, ticket, resolutionRowId, totalCost, args.paymentDate, args.vendorId || null, args.proofOfPurchaseUrl || null, args.closureSummary);
    }

    // Log
    const itemSummary = (args.items || []).filter((i: any) => i.name).map((i: any) => `${i.name} × ${i.qty}`).join("; ");
    await insertRow("ticket_logs", {
      ticket_id:       args.ticketId,
      action:          "Resolution submitted",
      created_by:      args.userId,
      notes:           `Type: ${args.resolutionType} • Service: ${args.serviceType} • Cost: ₹${Math.round(totalCost)}${itemSummary ? ` | Items: ${itemSummary}` : ""}${args.closureSummary ? ` | Summary: ${args.closureSummary}` : ""}`,
      new_status:      pendingStatus,
      organization_id: ORG_ID,
    });

    return { success: true, newStatus: pendingStatus, resolutionId: resolutionRowId };
  },
});

// ─── INTERNAL: Sync expense to accounting (mirrors web syncTicketResolutionExpense) ─

async function _syncExpenseToSupabase(
  sb: any, ticket: any, resolutionRowId: string,
  totalCost: number, paymentDate: string, vendorId: string | null,
  proofUrl: string | null, closureSummary: string,
) {
  try {
    // Idempotency check
    const { data: existing } = await sb.from("expenses").select("id").eq("ticket_resolution_id", resolutionRowId).maybeSingle();

    // Resolve expense category from issue_type_expense_mapping
    let categoryId: string | null = null;
    let subcategoryId: string | null = null;
    if (ticket.issue_type_id) {
      const { data: mapping } = await sb.from("issue_type_expense_mapping").select("expense_category_id, expense_subcategory_id")
        .eq("organization_id", ORG_ID).eq("issue_type_id", ticket.issue_type_id).maybeSingle();
      if ((mapping as any)?.expense_category_id) {
        categoryId = (mapping as any).expense_category_id;
        subcategoryId = (mapping as any).expense_subcategory_id || null;
      }
    }
    if (!categoryId) {
      const { data: cat } = await sb.from("expense_categories").select("id").eq("organization_id", ORG_ID).ilike("label", "%maintenance%").limit(1).maybeSingle();
      categoryId = (cat as any)?.id || null;
    }
    if (!categoryId) return; // Can't categorize

    const billingMonth = paymentDate.slice(0, 7);
    const description = `[Maintenance] Ticket ${ticket.ticket_number ?? ticket.id}\n${closureSummary}\nReference: resolution ${resolutionRowId}`.trim();

    const payload: any = {
      organization_id:      ORG_ID,
      category_id:          categoryId,
      subcategory_id:       subcategoryId,
      issue_type_id:        ticket.issue_type_id || null,
      amount:               Math.round(totalCost * 100) / 100,
      expense_date:         paymentDate,
      billing_month:        billingMonth,
      description,
      receipt_url:          proofUrl,
      property_id:          ticket.property_id || null,
      apartment_id:         ticket.apartment_id || null,
      bed_id:               ticket.bed_id || null,
      vendor_id:            vendorId,
      data_source:          "ticket_resolution",
      ticket_resolution_id: resolutionRowId,
    };

    if (existing?.id) {
      await sb.from("expenses").update(payload).eq("id", (existing as any).id);
    } else {
      await sb.from("expenses").insert(payload);
    }
  } catch (e) {
    // Expense sync failure must never block the resolution save
    console.error("[_syncExpenseToSupabase] error:", e);
  }
}

// ─── POST COMMENT ─────────────────────────────────────────────────────────────
// Inserts a technician/admin comment into ticket_logs (mirrors web Add Comment).

export const postComment = action({
  args: { ticketId: v.string(), text: v.string(), userId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { ticketId, text, userId }) => {
    await insertRow("ticket_logs", {
      ticket_id:    ticketId,
      action:       "Comment",
      created_by:   userId,
      notes:        text.trim(),
      organization_id: ORG_ID,
    });
    return { success: true };
  },
});

// ─── GET VENDORS ──────────────────────────────────────────────────────────────
export const getVendors = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return await safeList(sb.from("vendors").select("id, vendor_name").eq("organization_id", ORG_ID).eq("status", "active").order("vendor_name"));
  },
});

// ─── GET TICKET RESOLUTION ────────────────────────────────────────────────────
export const getResolution = action({
  args: { ticketId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { ticketId }) => {
    const sb = getSupabase();
    const { data } = await sb.from("ticket_resolutions").select("*").eq("ticket_id", ticketId).maybeSingle();
    return data || null;
  },
});

// ─── UNLOCK RESOLUTION EDITING (closed tickets — admin only) ──────────────────
export const unlockResolutionEditing = action({
  args: { ticketId: v.string(), userId: v.string(), reason: v.string() },
  returns: v.any(),
  handler: async (_ctx, { ticketId, userId, reason }) => {
    const sb = getSupabase();
    const { data: ticket } = await sb.from("maintenance_tickets").select("status").eq("id", ticketId).single();
    if (!ticket) throw new Error("Ticket not found");
    if (ticket.status !== "closed") throw new Error("Only closed tickets can be unlocked.");
    await insertRow("ticket_logs", {
      ticket_id:       ticketId,
      organization_id: ORG_ID,
      action:          "Admin unlocked resolution editing",
      notes:           reason?.trim() ? `Reason: ${reason.trim()}` : "Unlocked resolution editing on a closed ticket.",
      created_by:      userId,
    });
    return { success: true };
  },
});

// ─── CLASSIFY ISSUE FROM DESCRIPTION (AI-powered, mirrors web useIssueClassifier) ─
export const classifyIssue = action({
  args: {
    description: v.string(),
    issueTypes:  v.array(v.any()),  // [{id, name, subTypes:[{id,name,description}]}]
  },
  returns: v.any(),
  handler: async (_ctx, { description, issueTypes }) => {
    if (!description || description.trim().length < 4 || !issueTypes.length) {
      return { matches: [], top_issue_type_id: null, top_confidence: 0, action: "manual" };
    }
    try {
      // Call same AI endpoint as web (Groq/Gemini via runAIDiagnosis pattern)
      const groqKey   = process.env.GROQ_API_KEY;
      const geminiKey = process.env.GEMINI_API_KEY;

      const prompt = `You are a property maintenance issue classifier. Given the description and the catalogue of issue types, return a JSON object with:
- matches: array of {issue_type_id, confidence} sorted by confidence descending (0-100)
- top_issue_type_id: the best match id
- top_confidence: highest confidence score
- top_issue_sub_type_id: best sub-type id or null
- top_issue_sub_type_confidence: sub-type confidence 0-100

Description: "${description.trim()}"

Issue types catalogue:
${JSON.stringify(issueTypes.map((t: any) => ({
  id: t.id, name: t.name,
  subTypes: (t.subTypes || []).map((s: any) => ({ id: s.id, name: s.name, description: s.description || "" }))
})))}

Return ONLY valid JSON, no other text.`;

      let rawJson = "{}";
      if (groqKey) {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            temperature: 0.1,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "You are a property maintenance issue classifier. Always respond with valid JSON only." },
              { role: "user", content: prompt },
            ],
          }),
        });
        if (res.ok) { const j = await res.json(); rawJson = j.choices?.[0]?.message?.content || "{}"; }
      } else if (geminiKey) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: "application/json" } }),
        });
        if (res.ok) { const j = await res.json(); rawJson = j.candidates?.[0]?.content?.parts?.[0]?.text || "{}"; }
      } else {
        return { matches: [], top_issue_type_id: null, top_confidence: 0, action: "manual", error: "No AI key configured" };
      }

      const data = JSON.parse(rawJson);
      const confidence = Number(data.top_confidence || 0);
      const action = confidence >= 85 ? "auto_select" : confidence >= 60 ? "suggest" : "manual";
      return { ...data, action };
    } catch (e: any) {
      return { matches: [], top_issue_type_id: null, top_confidence: 0, action: "manual", error: e.message };
    }
  },
});

// ─── EXTRACT PAYMENT PROOF via AI OCR (mirrors web extract-payment-proof edge fn) ─
export const extractPaymentProof = action({
  args: { imageBase64: v.string() },
  returns: v.any(),
  handler: async (_ctx, { imageBase64 }) => {
    const groqKey   = process.env.GROQ_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    const prompt = `You are a payment receipt OCR system. Analyze this payment receipt/screenshot and extract:
- amount: the payment amount as a number (digits and decimal only, no currency symbol, no commas)
- payment_date: the payment date in YYYY-MM-DD format
- bank_name: the name of the bank or payment app (e.g. HDFC, SBI, GPay, PhonePe, Paytm, ICICI, Axis)
- transaction_reference: the transaction ID, UTR number, or reference number

Return ONLY a valid JSON object with exactly these 4 fields. If a field is not found, set it to null.
Example: {"amount": 855.00, "payment_date": "2026-05-02", "bank_name": "GPay", "transaction_reference": "T2605021234"}`;

    try {
      // ── Gemini Vision (best for image OCR) ─────────────────────────────
      if (geminiKey) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
                { text: prompt },
              ],
            }],
            generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
          }),
        });
        if (res.ok) {
          const j = await res.json();
          const raw = j.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
          const parsed = JSON.parse(raw);
          return { ...parsed, _source: "gemini" };
        }
      }

      // ── Groq vision (Qwen-VL) — OpenAI-compatible chat completions ─────────
      // Groq now serves vision models; the Qwen VL model reads payment
      // screenshots well. Model id is overridable via GROQ_VISION_MODEL.
      if (groqKey) {
        const model = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
              ],
            }],
            temperature: 0.1,
            max_tokens: 500,
            // Qwen3 is a reasoning model; without this it emits a long <think>
            // block that can exhaust max_tokens before the JSON and blows the
            // 8k tokens/min limit. "none" → clean JSON in ~65 completion tokens.
            reasoning_effort: "none",
          }),
        });
        if (res.status === 429) {
          return {
            amount: null, payment_date: null, bank_name: null, transaction_reference: null,
            _source: "groq_rate_limited",
            _requireManualAmount: true,
            _message: "Too many scans right now — wait a minute and try again, or enter the details manually.",
          };
        }
        if (res.ok) {
          const j = await res.json();
          let raw = String(j.choices?.[0]?.message?.content ?? "");
          // Qwen may emit a <think>…</think> block and/or ```json fences —
          // strip them and pull out the JSON object before parsing.
          raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) {
            try {
              const parsed = JSON.parse(m[0]);
              return { ...parsed, _source: "groq_qwen" };
            } catch { /* fall through to manual entry */ }
          }
        }
        // Groq reachable but no usable result — ask for manual entry.
        return {
          amount: null, payment_date: null, bank_name: null, transaction_reference: null,
          _source: "groq_parse_fail",
          _requireManualAmount: true,
          _message: "Couldn't read the screenshot automatically. Please enter the payment details manually.",
        };
      }

      return {
        amount: null, payment_date: null, bank_name: null, transaction_reference: null,
        _source: "no_key",
        _requireManualAmount: true,
        _message: "No AI key configured for OCR. Please enter the payment amount manually.",
      };
    } catch (e: any) {
      return {
        amount: null, payment_date: null, bank_name: null, transaction_reference: null,
        _source: "error", error: e.message, _requireManualAmount: true,
      };
    }
  },
});

// ─── GET BANK ACCOUNTS ────────────────────────────────────────────────────────
export const getBankAccounts = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return await safeList(
      sb.from("organization_bank_accounts").select("id, bank_name, account_number, account_name").eq("organization_id", ORG_ID).eq("status", "active").order("bank_name")
    );
  },
});

// ─── LIST OPEN TICKETS WITH FULL DESCRIPTION (query format) ──────────────────
// Returns all non-terminal tickets with description, status, property, apartment,
// issue type, priority, assigned to, and created date — for reporting/querying.
export const listOpenTicketsWithDescription = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();

    const OPEN_STATUSES = [
      'open', 'in_progress', 'waiting_for_parts', 'assigned',
      'pending_tenant_approval', 'pending_admin_approval',
      'waiting_for_cost_approval', 'reopened', 'on_hold',
    ];

    const tickets = await safeList(
      sb.from("maintenance_tickets")
        .select("id, ticket_number, status, priority, description, created_at, issue_type_id, property_id, apartment_id, bed_id, assigned_to, tenant_id, diagnostic_data")
        .eq("organization_id", ORG_ID)
        .not("status", "in", "(closed,completed,cancelled)")
        .order("created_at", { ascending: false })
    );

    if (!tickets.length) return [];

    // Batch-resolve all FK lookups in parallel
    const issueTypeIds  = [...new Set(tickets.map((t: any) => t.issue_type_id).filter(Boolean))];
    const propertyIds   = [...new Set(tickets.map((t: any) => t.property_id).filter(Boolean))];
    const apartmentIds  = [...new Set(tickets.map((t: any) => t.apartment_id).filter(Boolean))];
    const bedIds        = [...new Set(tickets.map((t: any) => t.bed_id).filter(Boolean))];
    const assignedIds   = [...new Set(tickets.map((t: any) => t.assigned_to).filter(Boolean))];

    const [issueTypes, properties, apartments, beds, members] = await Promise.all([
      issueTypeIds.length ? safeList(sb.from("issue_types").select("id, name").eq("organization_id", ORG_ID).in("id", issueTypeIds)) : [],
      propertyIds.length  ? safeList(sb.from("properties").select("id, property_name").eq("organization_id", ORG_ID).in("id", propertyIds)) : [],
      apartmentIds.length ? safeList(sb.from("apartments").select("id, apartment_code").eq("organization_id", ORG_ID).in("id", apartmentIds)) : [],
      bedIds.length       ? safeList(sb.from("beds").select("id, bed_code").eq("organization_id", ORG_ID).in("id", bedIds)) : [],
      assignedIds.length  ? safeList(sb.from("team_members").select("id, first_name, last_name").eq("organization_id", ORG_ID).in("id", assignedIds)) : [],
    ]);

    // Build lookup maps
    const itMap   = Object.fromEntries((issueTypes  as any[]).map((x: any) => [x.id, x.name]));
    const propMap = Object.fromEntries((properties  as any[]).map((x: any) => [x.id, x.property_name]));
    const aptMap  = Object.fromEntries((apartments  as any[]).map((x: any) => [x.id, x.apartment_code]));
    const bedMap  = Object.fromEntries((beds        as any[]).map((x: any) => [x.id, x.bed_code]));
    const memMap  = Object.fromEntries((members     as any[]).map((x: any) => [x.id, `${x.first_name || ''} ${x.last_name || ''}`.trim()]));

    return tickets.map((t: any) => ({
      ticket_number:  t.ticket_number || t.id.slice(0, 8),
      status:         t.status,
      priority:       t.priority || 'medium',
      description:    t.description || '—',
      issue_type:     itMap[t.issue_type_id] || '—',
      property:       propMap[t.property_id] || '—',
      apartment:      aptMap[t.apartment_id] || '—',
      bed:            bedMap[t.bed_id] || '—',
      assigned_to:    memMap[t.assigned_to] || 'Unassigned',
      created_at:     t.created_at,
      created_date:   t.created_at ? new Date(t.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
    }));
  },
});
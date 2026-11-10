// ─── LIFECYCLE EXTRAS ────────────────────────────────────────────────────────
// convex/tenantsextraactions.ts  — drop-in replacement for the existing file.
// All original actions are preserved unchanged.
// NEW actions added at the bottom:
//   • createAbsenceRecord
//   • updateAbsenceRecord
//   • deleteAbsenceRecord
//   • listAbsenceRecords
//   • createExitTask
//   • listExitTasks

import { action } from "./_generated/server";
import { v } from "convex/values";
import {
  getSupabase, ORG_ID, safeList,
} from "./lib/supabaseAdmin";

// ─── LIST EXITS ───────────────────────────────────────────────────────
export const listExits = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const exits = await safeList(
      sb.from("tenant_exits")
        .select("*")
        .eq("organization_id", ORG_ID)
        .order("created_at", { ascending: false })
    );
    const tenants = await safeList(
      sb.from("tenants").select("id, full_name, phone").eq("organization_id", ORG_ID)
    );
    const tenantMap: Record<string, any> = {};
    tenants.forEach((t: any) => { tenantMap[t.id] = t; });

    return exits.map((e: any) => ({
      _id: e.id,
      tenantId: e.tenant_id,
      tenantName: tenantMap[e.tenant_id]?.full_name || "Unknown",
      bedId: e.bed_id,
      exitDate: e.exit_date,
      hasNotice: e.has_notice,
      damageCharges: Number(e.damage_charges) || 0,
      totalDeductions: Number(e.total_deductions) || 0,
      advanceHeld: Number(e.advance_held) || 0,
      refundDue: Number(e.refund_due) || 0,
      refundStatus: e.refund_status || "none",
      notes: e.notes || null,
      createdAt: e.created_at,
    }));
  },
});

// ─── LIST NOTICES ─────────────────────────────────────────────────────
export const listNotices = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const notices = await safeList(
      sb.from("tenant_notices")
        .select("*")
        .eq("organization_id", ORG_ID)
        .order("created_at", { ascending: false })
    );
    const tenants = await safeList(
      sb.from("tenants").select("id, full_name, phone").eq("organization_id", ORG_ID)
    );
    const tenantMap: Record<string, any> = {};
    tenants.forEach((t: any) => { tenantMap[t.id] = t; });

    return notices.map((n: any) => ({
      _id: n.id,
      tenantId: n.tenant_id,
      tenantName: tenantMap[n.tenant_id]?.full_name || "Unknown",
      allotmentId: n.allotment_id,
      bedId: n.bed_id,
      noticeDate: n.notice_date,
      exitDate: n.exit_date,
      notes: n.notes || null,
      createdAt: n.created_at,
    }));
  },
});

// ─── LIST LIFECYCLE RECEIPTS ──────────────────────────────────────────
export const listLifecycleReceipts = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const receipts = await safeList(
      sb.from("receipts")
        .select("*")
        .eq("organization_id", ORG_ID)
        .in("receipt_type", ["booking", "onboarding", "additional_payment", "settlement"])
        .order("created_at", { ascending: false })
    );
    const tenants = await safeList(
      sb.from("tenants").select("id, full_name, phone").eq("organization_id", ORG_ID)
    );
    const tenantMap: Record<string, any> = {};
    tenants.forEach((t: any) => { tenantMap[t.id] = t; });

    return receipts.map((r: any) => ({
      _id: r.id,
      tenantId: r.tenant_id,
      tenantName: tenantMap[r.tenant_id]?.full_name || "Unknown",
      allotmentId: r.tenant_allotment_id,
      amountPaid: Number(r.amount_paid) || 0,
      baseAmount: Number(r.base_amount) || 0,
      processingFee: Number(r.processing_fee) || 0,
      paymentMode: r.payment_mode || "",
      referenceNumber: r.reference_number || "",
      paymentDate: r.payment_date,
      receiptType: r.receipt_type,
      createdAt: r.created_at,
    }));
  },
});

// ─── RESOLVE TENANT BY PHONE ──────────────────────────────────────────
export const resolveTenantByPhone = action({
  args: { phone: v.string() },
  returns: v.any(),
  handler: async (_ctx, { phone }) => {
    const { getSupabase, ORG_ID, safeList } = await import("./lib/supabaseAdmin");
    const sb = getSupabase();

    const clean = phone.replace(/\D/g, '').slice(-10);
    const variants = [clean, `+91${clean}`, `91${clean}`, `0${clean}`, phone];

    let tenant: any = null;
    for (const variant of variants) {
      const rows = await safeList(
        sb.from('tenants')
          .select('id, full_name, phone, property_id, apartment_id, bed_id, organization_id')
          .eq('phone', variant)
          .eq('organization_id', ORG_ID)
          .limit(1)
      );
      if (rows[0]) { tenant = rows[0]; break; }
    }
    if (!tenant) return { found: false };

    const allotments = await safeList(
      sb.from('tenant_allotments')
        .select('id, bed_id, property_id, apartment_id, staying_status')
        .eq('tenant_id', tenant.id)
        .eq('organization_id', ORG_ID)
        .in('staying_status', ['Staying', 'On-Notice', 'Booked'])
        .order('created_at', { ascending: false })
        .limit(1)
    );
    const allotment = allotments[0] || null;

    const issueTypes = await safeList(
      sb.from('issue_types')
        .select('id, name')
        .eq('organization_id', ORG_ID)
        .order('name')
    );

    return {
      found:       true,
      tenantId:    tenant.id,
      orgId:       tenant.organization_id,
      fullName:    tenant.full_name,
      propertyId:  allotment?.property_id  || tenant.property_id  || null,
      apartmentId: allotment?.apartment_id || tenant.apartment_id || null,
      bedId:       allotment?.bed_id       || tenant.bed_id       || null,
      allotmentId: allotment?.id           || null,
      stayingStatus: allotment?.staying_status || null,
      issueTypes,
    };
  },
});

// ─── NEW: ABSENCE RECORDS ─────────────────────────────────────────────────────

export const listAbsenceRecords = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const records = await safeList(
      sb.from("tenant_absence_records")
        .select("*, tenants(full_name, phone)")
        .eq("organization_id", ORG_ID)
        .order("from_date", { ascending: false })
    );
    return records;
  },
});

export const createAbsenceRecord = action({
  args: {
    data: v.object({
      tenantId:     v.string(),
      allotmentId:  v.optional(v.string()),
      fromDate:     v.string(),
      toDate:       v.string(),
      reason:       v.optional(v.string()),
    }),
  },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    const { data: row, error } = await sb.from("tenant_absence_records").insert({
      organization_id: ORG_ID,
      tenant_id:       data.tenantId,
      allotment_id:    data.allotmentId || null,
      from_date:       data.fromDate,
      to_date:         data.toDate,
      reason:          data.reason || null,
    }).select().single();
    if (error) throw new Error(`Create absence failed: ${error.message}`);
    return row;
  },
});

export const updateAbsenceRecord = action({
  args: {
    data: v.object({
      id:         v.string(),
      fromDate:   v.string(),
      toDate:     v.string(),
      reason:     v.optional(v.string()),
    }),
  },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    const { data: row, error } = await sb
      .from("tenant_absence_records")
      .update({ from_date: data.fromDate, to_date: data.toDate, reason: data.reason || null })
      .eq("id", data.id)
      .eq("organization_id", ORG_ID)
      .select().single();
    if (error) throw new Error(`Update absence failed: ${error.message}`);
    return row;
  },
});

export const deleteAbsenceRecord = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    const sb = getSupabase();
    const { error } = await sb
      .from("tenant_absence_records")
      .delete()
      .eq("id", id)
      .eq("organization_id", ORG_ID);
    if (error) throw new Error(`Delete absence failed: ${error.message}`);
    return { success: true };
  },
});

// ─── NEW: EXIT TASKS ──────────────────────────────────────────────────────────

export const listExitTasks = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const tasks = await safeList(
      sb.from("exit_tasks")
        .select("*, tenants(full_name)")
        .eq("organization_id", ORG_ID)
        .order("created_at", { ascending: false })
    );
    return tasks;
  },
});

export const createExitTask = action({
  args: {
    data: v.object({
      allotmentId: v.string(),
      tenantId:    v.string(),
      exitDate:    v.string(),
    }),
  },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();

    // Load org assignees
    const { data: orgData } = await sb
      .from("organizations")
      .select("exit_task_assignee_1, exit_task_assignee_2")
      .eq("id", ORG_ID)
      .single();

    // Balance-assign: pick assignee with fewer pending tasks
    let assignee = orgData?.exit_task_assignee_1 || null;
    if (orgData?.exit_task_assignee_1 && orgData?.exit_task_assignee_2) {
      const { count: a1Tasks } = await sb
        .from("exit_tasks")
        .select("id", { count: "exact", head: true })
        .eq("assigned_to", orgData.exit_task_assignee_1)
        .eq("status", "pending")
        .eq("organization_id", ORG_ID);
      assignee = (a1Tasks || 0) < 3
        ? orgData.exit_task_assignee_1
        : orgData.exit_task_assignee_2;
    }

    const { data: row, error } = await sb.from("exit_tasks").insert({
      organization_id: ORG_ID,
      allotment_id:    data.allotmentId,
      tenant_id:       data.tenantId,
      exit_date:       data.exitDate,
      assigned_to:     assignee || null,
    }).select().single();
    if (error) throw new Error(`Create exit task failed: ${error.message}`);
    return row;
  },
});

// ─── NEW: TENANT REMARKS (read-only for mobile) ───────────────────────────────

export const listTenantRemarks = action({
  args: { tenantId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { tenantId }) => {
    const sb = getSupabase();
    const remarks = await safeList(
      sb.from("tenant_remarks")
        .select("remark_type, severity, title")
        .eq("tenant_id", tenantId)
        .eq("organization_id", ORG_ID)
    );
    return remarks;
  },
});
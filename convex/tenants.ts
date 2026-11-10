"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import {
  getSupabase, ORG_ID, safeList, insertRow, updateRow, deleteRow,
  cleanPhone, phoneVariants,
} from "./lib/supabaseAdmin";
import { getExitMonthEbBreakdown } from "./exiteb";

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const WORK_START_MINS = 9 * 60 + 30;
const WORK_END_MINS   = 17 * 60 + 30;
const IST_OFFSET_MS   = 5.5 * 60 * 60 * 1000;

function toISTMins(date: Date) {
  const istMs = date.getTime() + IST_OFFSET_MS;
  const d = new Date(istMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function nextWorkStart(from: Date): Date {
  const istMs = from.getTime() + IST_OFFSET_MS;
  const d = new Date(istMs);
  const minsNow = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (minsNow < WORK_START_MINS) {
    d.setUTCHours(9, 30, 0, 0);
  } else {
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(9, 30, 0, 0);
  }
  return new Date(d.getTime() - IST_OFFSET_MS);
}

// ─── MERGE TENANTS (web parity: merge_tenants RPC) ───────────────────────────
// Re-points every child record (allotments, remarks, documents, receipts,
// tickets…) from secondary → primary, applies p_field_values (COALESCE, so an
// empty object safely keeps the primary's values), then deletes the secondary.
// The DB function blocks when both tenants have allotments.
export const mergeTenants = action({
  args: { primaryId: v.string(), secondaryId: v.string(), fieldValues: v.optional(v.any()) },
  returns: v.any(),
  handler: async (_ctx, { primaryId, secondaryId, fieldValues }) => {
    const sb = getSupabase();
    if (!primaryId || !secondaryId || primaryId === secondaryId) {
      return { ok: false, error: "Pick two different tenant records to merge." };
    }
    try {
      const { data, error } = await sb.rpc("merge_tenants", {
        p_primary_id: primaryId,
        p_secondary_id: secondaryId,
        p_field_values: fieldValues || {},
      });
      if (error) return { ok: false, error: error.message };
      const moved = (data as any)?.moved || {};
      const totalMoved = Object.values(moved).reduce((s: number, n: any) => s + Number(n || 0), 0);
      return { ok: true, moved, totalMoved };
    } catch (e: any) {
      return { ok: false, error: e?.message || "Merge failed." };
    }
  },
});

// ─── ISSUE KYC QR TOKEN (web parity: kyc-token-issue) ────────────────────────
// The QR payload is AES-GCM encrypted with KYC_QR_SECRET, which only the
// deployed Supabase edge function holds — so we forward the caller's user token
// to that edge function (it checks admin role, issues/reuses, and stores the QR
// on properties.kyc_qr_code) rather than re-implementing the crypto here.
export const issueKycToken = action({
  args: { propertyId: v.string(), token: v.string() },
  returns: v.any(),
  handler: async (_ctx, { propertyId, token }) => {
    const url = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;
    if (!url || !anon) return { ok: false, error: "Server not configured." };
    if (!token) return { ok: false, error: "Please sign in again." };
    try {
      const res = await fetch(`${url}/functions/v1/kyc-token-issue`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: anon,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ property_id: propertyId }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data?.error || `Could not issue KYC QR (${res.status}).` };
      return { ok: true, qr: data.qr || null, propertyName: data.property_name || null, reused: !!data.reused };
    } catch (e: any) {
      return { ok: false, error: e?.message || "Request failed." };
    }
  },
});

// ─── TENANT SELF-SERVICE KYC (web parity: KYCForm admin_edit write) ──────────
// The tenant fills their own KYC details; we resolve their record by phone and
// update a whitelisted set of KYC fields, optionally marking kyc_completed.
export const updateTenantKyc = action({
  args: { phone: v.string(), fields: v.any() },
  returns: v.any(),
  handler: async (_ctx, { phone, fields }) => {
    const sb = getSupabase();
    let clean = String(phone || "").replace(/[^0-9]/g, "");
    if (clean.length === 12 && clean.startsWith("91")) clean = clean.slice(2);
    else if (clean.length === 11 && clean.startsWith("0")) clean = clean.slice(1);
    clean = clean.slice(-10);
    if (clean.length !== 10) return { ok: false, error: "Invalid phone number." };
    const variants = [clean, `+91${clean}`, `91${clean}`];
    let tenant: any = null;
    for (const vv of variants) {
      const { data } = await sb.from("tenants").select("id").eq("organization_id", ORG_ID).eq("phone", vv).maybeSingle();
      if (data) { tenant = data; break; }
    }
    if (!tenant) return { ok: false, error: "Your tenant record was not found." };
    const ALLOWED = new Set([
      "first_name", "last_name", "full_name", "gender", "date_of_birth", "food_preference", "profession",
      "email", "address", "city", "state", "pincode", "permanent_address",
      "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship", "emergency_contact_relation",
      "aadhar_number", "pan_number",
      "bank_name", "bank_branch", "bank_account_number", "bank_account_holder", "bank_ifsc",
      "company_name", "designation", "date_of_joining", "photo_url",
    ]);
    const payload: any = {};
    for (const k of Object.keys(fields || {})) {
      if (ALLOWED.has(k)) payload[k] = fields[k] === "" ? null : fields[k];
    }
    if (fields?.markComplete === true) payload.kyc_completed = true;
    if (Object.keys(payload).length === 0) return { ok: false, error: "Nothing to save." };
    const { error } = await sb.from("tenants").update(payload).eq("id", tenant.id).eq("organization_id", ORG_ID);
    if (error) return { ok: false, error: error.message };
    return { ok: true, tenantId: tenant.id };
  },
});

// ─── DASHBOARD DISCREPANCIES (web parity: NeedsAttentionTicker) ───────────────
// Counts beds genuinely double-booked and tenants occupying 2+ beds — using the
// same overlap rule as web findBed/findTenantDiscrepancies: an allotment window
// is [onboarding_date, effective-exit], effective exit = actual→estimated→notice;
// two windows overlap iff start<otherEnd && otherStart<end (same-day handover ok).
export const getBedTenantDiscrepancies = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const allots: any[] = await safeList(
      sb.from("tenant_allotments")
        .select("id, bed_id, tenant_id, staying_status, onboarding_date, actual_exit_date, estimated_exit_date, notice_date")
        .eq("organization_id", ORG_ID)
        .in("staying_status", ["Staying", "On-Notice", "Booked"])
    );
    const effExit = (a: any): string | null => {
      for (const v0 of [a.actual_exit_date, a.estimated_exit_date, a.notice_date]) {
        if (v0 && String(v0).trim()) return v0;
      }
      return null;
    };
    const win = (a: any) => {
      const s = a.onboarding_date && String(a.onboarding_date).trim() ? new Date(a.onboarding_date).getTime() : -Infinity;
      const e0 = effExit(a);
      const e = e0 && String(e0).trim() ? new Date(e0).getTime() : Infinity;
      return { start: s, end: e };
    };
    const overlaps = (group: any[]): boolean => {
      const w = group.map(win);
      for (let i = 0; i < w.length; i++) {
        for (let j = i + 1; j < w.length; j++) {
          if (w[i].start < w[j].end && w[j].start < w[i].end) return true;
        }
      }
      return false;
    };
    const byBed = new Map<string, any[]>();
    const byTenant = new Map<string, any[]>();
    for (const a of allots) {
      if (a.bed_id) { if (!byBed.has(a.bed_id)) byBed.set(a.bed_id, []); byBed.get(a.bed_id)!.push(a); }
      if (a.tenant_id) { if (!byTenant.has(a.tenant_id)) byTenant.set(a.tenant_id, []); byTenant.get(a.tenant_id)!.push(a); }
    }
    let bed = 0, tenant = 0;
    for (const g of byBed.values()) if (g.length >= 2 && overlaps(g)) bed++;
    for (const g of byTenant.values()) if (g.length >= 2 && overlaps(g)) tenant++;
    return { bed, tenant };
  },
});

// ─── BED RATES ────────────────────────────────────────────────────────────────

export const listBedRates = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return await safeList(
      sb.from("bed_rates").select("*").eq("organization_id", ORG_ID).order("from_date", { ascending: false })
    );
  },
});

// ─── LIFECYCLE CONFIG ─────────────────────────────────────────────────────────

export const getLifecycleConfig = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rows = await safeList(
      sb.from("lifecycle_config").select("*").eq("organization_id", ORG_ID).order("from_date", { ascending: false })
    );
    const today = new Date().toISOString().split("T")[0];
    const active = rows.find((c: any) => c.from_date <= today && (!c.to_date || c.to_date >= today));
    return active || {
      booking_fee: 1000, onboarding_fee: 1000, advance_ratio: 1.5,
      exit_fee_under_1yr: 2250, key_loss_fee: 500, notice_period_days: 30, refund_deadline_days: 5,
    };
  },
});

// ─── LIFECYCLE RECEIPTS ───────────────────────────────────────────────────────

export const listLifecycleReceipts = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const receipts = await safeList(
      sb.from("receipts").select("*")
        .eq("organization_id", ORG_ID)
        .in("receipt_type", ["booking", "onboarding", "additional_payment", "settlement"])
        .order("created_at", { ascending: false })
    );
    const tenants = await safeList(sb.from("tenants").select("id,full_name,phone").eq("organization_id", ORG_ID));
    const tMap: Record<string, any> = {};
    tenants.forEach((t: any) => { tMap[t.id] = t; });
    return receipts.map((r: any) => ({
      _id: r.id,
      tenantId: r.tenant_id,
      tenantName: tMap[r.tenant_id]?.full_name || "Unknown",
      tenantPhone: tMap[r.tenant_id]?.phone || "",
      allotmentId: r.tenant_allotment_id,
      amountPaid: Number(r.amount_paid) || 0,
      baseAmount: Number(r.base_amount) || 0,
      processingFee: Number(r.processing_fee) || 0,
      paymentMode: r.payment_mode || "",
      referenceNumber: r.reference_number || "",
      paymentDate: r.payment_date || r.created_at?.split("T")[0] || "",
      receiptType: r.receipt_type || "",
      createdAt: r.created_at,
    }));
  },
});

// ─── BOOKING ─────────────────────────────────────────────────────────────────

export const createBookingFull = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    const today = new Date().toISOString().split("T")[0];

    // 1. Create allotment
    const allotment = await insertRow("tenant_allotments", {
      tenant_id: data.tenantId,
      property_id: data.propertyId,
      apartment_id: data.apartmentId,
      bed_id: data.bedId,
      booking_date: today,
      onboarding_date: data.onboardingDate || null,
      staying_status: "Booked",
      deposit_paid: 0,
      onboarding_charges: data.amount,
      paid_amount: data.amount,
      payment_status: "partial",
      discount: data.discount || 0,
      premium: data.premium || 0,
    });

    // 2. Record receipt
    await insertRow("receipts", {
      tenant_id: data.tenantId,
      tenant_allotment_id: allotment.id,
      amount_paid: data.amount,
      base_amount: data.amount,
      processing_fee: 0,
      payment_mode: data.paymentMode,
      reference_number: data.referenceNumber || null,
      payment_date: today,
      receipt_type: "booking",
      ...(data.bankAccountId ? { bank_account_id: data.bankAccountId } : {}),
    });

    // 3. Update bed status
    const bedStatus = data.isBedOnNotice ? "notice-booked" : "booked";
    await sb.from("beds").update({ bed_lifecycle_status: bedStatus } as any).eq("id", data.bedId);

    // 4. Update tenant status
    await sb.from("tenants").update({ staying_status: "booked" } as any).eq("id", data.tenantId);

    return { success: true, allotmentId: allotment.id };
  },
});

// ─── CANCEL BOOKING ───────────────────────────────────────────────────────────

export const cancelBookingFull = action({
  args: { allotmentId: v.string(), reason: v.string() },
  returns: v.any(),
  handler: async (_ctx, { allotmentId }) => {
    const sb = getSupabase();

    const allots = await safeList(
      sb.from("tenant_allotments").select("*").eq("id", allotmentId).eq("organization_id", ORG_ID).limit(1)
    );
    const allot = allots[0];
    if (!allot) throw new Error("Allotment not found");

    await sb.from("tenant_allotments").update({ staying_status: "Cancelled" } as any)
      .eq("id", allotmentId).eq("organization_id", ORG_ID);

    await sb.from("beds").update({ bed_lifecycle_status: "vacant" } as any).eq("id", allot.bed_id);

    // Check other active allotments
    const others = await safeList(
      sb.from("tenant_allotments").select("id").eq("tenant_id", allot.tenant_id)
        .eq("organization_id", ORG_ID).in("staying_status", ["Booked", "Staying", "On-Notice"])
        .neq("id", allotmentId)
    );

    if (others.length === 0) {
      // Check if they have exited allotments
      const exitedOnes = await safeList(
        sb.from("tenant_allotments").select("id").eq("tenant_id", allot.tenant_id)
          .eq("organization_id", ORG_ID).eq("staying_status", "Exited")
      );
      const newStatus = exitedOnes.length > 0 ? "exited" : "new";
      await sb.from("tenants").update({ staying_status: newStatus } as any).eq("id", allot.tenant_id);
    }

    return { success: true };
  },
});

// ─── ONBOARDING ───────────────────────────────────────────────────────────────

export const processOnboardingFull = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();

    const allots = await safeList(
      sb.from("tenant_allotments").select("*").eq("id", data.allotmentId).eq("organization_id", ORG_ID).limit(1)
    );
    const allot = allots[0];
    if (!allot) throw new Error("Allotment not found");

    const paidNow = data.paidAmount || 0;
    const alreadyPaid = Math.max(allot.paid_amount || 0, allot.deposit_paid || 0);
    const totalPaid = alreadyPaid + paidNow;
    const balanceDue = Math.max(0, (data.totalDue || 0) - totalPaid);
    const paymentStatus = balanceDue <= 0 ? "paid" : "partial";
    const bedId = data.bedId || allot.bed_id;

    // 1. Update allotment
    await sb.from("tenant_allotments").update({
      staying_status: "Staying",
      onboarding_date: data.onboardingDate,
      bed_id: bedId,
      monthly_rental: data.monthlyRent,
      deposit_paid: data.advance,
      prorated_rent: data.proratedRent,
      onboarding_charges: data.onboardingCharges,
      total_due: data.totalDue,
      paid_amount: totalPaid,
      balance_due: balanceDue,
      payment_status: paymentStatus,
    } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);

    // 2. Record receipt if payment made
    const ccChargesOnboard = Number(data.ccCharges) || 0;
    if (paidNow > 0) {
      await insertRow("receipts", {
        tenant_id: allot.tenant_id,
        tenant_allotment_id: data.allotmentId,
        amount_paid: paidNow,
        base_amount: paidNow,
        processing_fee: ccChargesOnboard,
        payment_mode: data.paymentMode,
        reference_number: data.referenceNumber || null,
        payment_date: data.onboardingDate || new Date().toISOString().split("T")[0],
        receipt_type: "onboarding",
        ...(data.bankAccountId ? { bank_account_id: data.bankAccountId } : {}),
      });
    }

    // 2b. Record CC charges as debit-note tenant_adjustment (mirrors web app behaviour)
    if (ccChargesOnboard > 0) {
      await insertRow("tenant_adjustments", {
        tenant_id: allot.tenant_id,
        allotment_id: data.allotmentId,
        type: "debit_note",
        category: "cc_charges",
        reason: "CC Charges",
        amount: Math.ceil(ccChargesOnboard),
        adjustment_date: data.onboardingDate || new Date().toISOString().split("T")[0],
      });
    }

    // 3. Update beds
    await sb.from("beds").update({ bed_lifecycle_status: "occupied" } as any).eq("id", bedId);
    if (bedId !== allot.bed_id) {
      await sb.from("beds").update({ bed_lifecycle_status: "vacant" } as any).eq("id", allot.bed_id);
    }

    // 4. Update tenant
    await sb.from("tenants").update({ staying_status: "staying" } as any).eq("id", allot.tenant_id);

    return { success: true };
  },
});

// ─── ADD PAYMENT ──────────────────────────────────────────────────────────────

export const addLifecyclePayment = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();

    const allots = await safeList(
      sb.from("tenant_allotments").select("*").eq("id", data.allotmentId).eq("organization_id", ORG_ID).limit(1)
    );
    const allot = allots[0];
    if (!allot) throw new Error("Allotment not found");

    const amt = data.amount || 0;
    const ccChargesPayment = Number(data.ccCharges) || 0;
    await insertRow("receipts", {
      tenant_id: allot.tenant_id,
      tenant_allotment_id: data.allotmentId,
      amount_paid: amt,
      base_amount: amt,
      processing_fee: ccChargesPayment,
      payment_mode: data.paymentMode,
      reference_number: data.referenceNumber || null,
      payment_date: new Date().toISOString().split("T")[0],
      receipt_type: "additional_payment",
      ...(data.bankAccountId ? { bank_account_id: data.bankAccountId } : {}),
    });

    // Record CC charges as debit-note if applicable (mirrors web app behaviour)
    if (ccChargesPayment > 0) {
      await insertRow("tenant_adjustments", {
        tenant_id: allot.tenant_id,
        allotment_id: data.allotmentId,
        type: "debit_note",
        category: "cc_charges",
        reason: "CC Charges",
        amount: Math.ceil(ccChargesPayment),
        adjustment_date: new Date().toISOString().split("T")[0],
      });
    }

    const newPaid = (allot.paid_amount || 0) + amt;
    const newBalance = Math.max(0, (allot.total_due || 0) - newPaid);
    await sb.from("tenant_allotments").update({
      paid_amount: newPaid,
      balance_due: newBalance,
      payment_status: newBalance <= 0 ? "paid" : "partial",
    } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);

    return { success: true };
  },
});

// ─── ROOM SWITCH ──────────────────────────────────────────────────────────────

export const processSwitchFull = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();

    const oldRate = data.oldRate || 0;
    const newRate = data.newRate || 0;
    const rentDiff = newRate - oldRate;
    const today = new Date().toISOString().split("T")[0];

    // Insert room switch record
    await insertRow("room_switches", {
      tenant_id: data.tenantId,
      allotment_id: data.allotmentId,
      old_bed_id: data.oldBedId,
      new_bed_id: data.newBedId,
      switch_type: "immediate",
      switch_date: data.switchDate || today,
      effective_date: data.switchDate || today,
      rent_difference: rentDiff,
      adjustment_type: rentDiff > 0 ? "tenant_pays" : rentDiff < 0 ? "credit_tenant" : "none",
    });

    // Update allotment
    const apt = data.newApartmentId;
    const prop = data.newPropertyId;
    await sb.from("tenant_allotments").update({
      bed_id: data.newBedId,
      apartment_id: apt || undefined,
      property_id: prop || undefined,
      monthly_rental: newRate,
    } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);

    // Update bed statuses
    await sb.from("beds").update({ bed_lifecycle_status: "vacant" } as any).eq("id", data.oldBedId);
    await sb.from("beds").update({ bed_lifecycle_status: "occupied" } as any).eq("id", data.newBedId);

    return { success: true };
  },
});

// ─── NOTICE ───────────────────────────────────────────────────────────────────

export const createNoticeFull = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    const today = new Date().toISOString().split("T")[0];

    await insertRow("tenant_notices", {
      tenant_id: data.tenantId,
      allotment_id: data.allotmentId,
      bed_id: data.bedId,
      notice_date: today,
      exit_date: data.exitDate,
      notes: data.notes || null,
    });

    await sb.from("tenant_allotments").update({
      staying_status: "On-Notice",
      notice_date: today,
      estimated_exit_date: data.exitDate,
    } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);

    await sb.from("beds").update({ bed_lifecycle_status: "notice" } as any).eq("id", data.bedId);
    await sb.from("tenants").update({ staying_status: "on-notice" } as any).eq("id", data.tenantId);

    return { success: true };
  },
});

export const updateNoticeFull = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    if (data.noticeId) {
      await sb.from("tenant_notices").update({
        notice_date: data.noticeDate,
        exit_date: data.exitDate,
        notes: data.notes || null,
      } as any).eq("id", data.noticeId).eq("organization_id", ORG_ID);
    }
    if (data.allotmentId) {
      await sb.from("tenant_allotments").update({
        notice_date: data.noticeDate,
        estimated_exit_date: data.exitDate,
      } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);
    }
    return { success: true };
  },
});

export const deleteNoticeFull = action({
  args: { noticeId: v.string(), allotmentId: v.string(), bedId: v.string(), tenantId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { noticeId, allotmentId, bedId, tenantId }) => {
    const sb = getSupabase();
    await sb.from("tenant_notices").delete().eq("id", noticeId).eq("organization_id", ORG_ID);
    await sb.from("tenant_allotments").update({
      staying_status: "Staying",
      notice_date: null,
      estimated_exit_date: null,
    } as any).eq("id", allotmentId).eq("organization_id", ORG_ID);
    await sb.from("beds").update({ bed_lifecycle_status: "occupied" } as any).eq("id", bedId);
    await sb.from("tenants").update({ staying_status: "staying" } as any).eq("id", tenantId);
    return { success: true };
  },
});

// ─── LIST NOTICES ──────────────────────────────────────────────────────────────

export const listNotices = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return await safeList(
      sb.from("tenant_notices").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false })
    );
  },
});

// ─── EXIT ─────────────────────────────────────────────────────────────────────

// ─── EXIT-MONTH ESTIMATED EB (recompute + invoice revision) ──────────────────
// Mirrors web lib/exit-settlement.ts (fetchExitMonthEstimatedEbFromDb +
// reviseExitMonthEstimatedEb). The estimated EB on the exit-month invoice is
// recomputed from the ACTUAL exit date and written back ONLY when the exit is
// completed (inside processExitFull).

/** What estimated EB (if any) is already invoiced for the exit billing month. */
async function fetchExitMonthEstimatedEb(
  sb: any,
  allotmentId: string,
  billingMonth: string,
  exitDateIso: string,
): Promise<{ included: boolean; amount: number }> {
  const invoices = await safeList(
    sb.from("invoices")
      .select("id, estimated_eb")
      .eq("allotment_id", allotmentId)
      .eq("billing_month", billingMonth)
      .lte("invoice_date", exitDateIso)
      .or("is_deleted.is.null,is_deleted.eq.false"),
  );
  let amount = 0;
  let included = false;
  for (const inv of invoices as any[]) {
    const e = Number(inv.estimated_eb || 0);
    if (e > 0) { amount += e; included = true; }
  }
  if (!included && (invoices as any[]).length > 0) {
    const ids = (invoices as any[]).map((i: any) => i.id).filter(Boolean);
    const lines = await safeList(
      sb.from("invoice_line_items")
        .select("amount")
        .in("invoice_id", ids)
        .eq("line_type", "estimated_eb"),
    );
    for (const l of lines as any[]) {
      const a = Number(l.amount || 0);
      if (a > 0) { amount += a; included = true; }
    }
  }
  return { included, amount: Math.round(amount) };
}

/**
 * Replace the already-invoiced estimated EB for the exit billing month with a revised
 * value. Updates the carrier invoice's estimated_eb column, recomputes total/balance/
 * status, and syncs the estimated_eb line item. No-op when nothing is invoiced, when the
 * change is < ₹1, or when the carrying invoice is locked.
 */
async function reviseExitEbInvoice(
  sb: any,
  params: { allotmentId: string; exitBillingMonth: string; exitDateIso: string; targetEb: number },
): Promise<{ changed: boolean; locked: boolean; oldEb: number; newEb: number; delta: number }> {
  const { allotmentId, exitBillingMonth, exitDateIso } = params;
  const newEb = Math.max(0, Math.round(params.targetEb));

  const invoices = await safeList(
    sb.from("invoices")
      .select("id, estimated_eb, rent_amount, electricity_amount, other_charges, late_fee, amount_paid, locked")
      .eq("allotment_id", allotmentId)
      .eq("billing_month", exitBillingMonth)
      .lte("invoice_date", exitDateIso)
      .or("is_deleted.is.null,is_deleted.eq.false"),
  );

  const invIds = (invoices as any[]).map((i: any) => i.id).filter(Boolean);
  let lines: any[] = [];
  if (invIds.length > 0) {
    lines = await safeList(
      sb.from("invoice_line_items")
        .select("id, invoice_id, amount, description")
        .in("invoice_id", invIds)
        .eq("line_type", "estimated_eb"),
    );
  }

  const byId = new Map((invoices as any[]).map((i: any) => [i.id, i]));
  let carrier: any =
    (invoices as any[])
      .filter((i: any) => Number(i.estimated_eb || 0) > 0)
      .sort((a: any, b: any) => Number(b.estimated_eb || 0) - Number(a.estimated_eb || 0))[0] || null;
  let carrierLine = carrier ? lines.find((l: any) => l.invoice_id === carrier.id) || null : null;
  if (!carrier && lines.length > 0) {
    carrierLine = [...lines].sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))[0];
    carrier = byId.get(carrierLine.invoice_id) || null;
  }
  if (!carrier) return { changed: false, locked: false, oldEb: 0, newEb, delta: 0 };

  const oldEb = Math.round(
    Number(carrier.estimated_eb || 0) > 0 ? Number(carrier.estimated_eb) : Number(carrierLine?.amount || 0),
  );
  const delta = newEb - oldEb;
  if (Math.abs(delta) < 1) return { changed: false, locked: false, oldEb, newEb, delta: 0 };
  if (carrier.locked) return { changed: false, locked: true, oldEb, newEb, delta };

  const rent = Number(carrier.rent_amount || 0);
  const elec = Number(carrier.electricity_amount || 0);
  const other = Number(carrier.other_charges || 0);
  const late = Number(carrier.late_fee || 0);
  const paid = Number(carrier.amount_paid || 0);
  const totalAmount = rent + elec + newEb + other + late;
  const balance = Math.max(0, totalAmount - paid);
  const status = balance <= 0 ? "paid" : paid > 0 ? "partial" : "pending";

  await sb.from("invoices")
    .update({ estimated_eb: newEb, total_amount: totalAmount, balance, status })
    .eq("id", carrier.id);

  const dir = delta > 0 ? "increased" : "decreased";
  const note = `Estimated EB ${dir} by ₹${Math.abs(delta)} due to change of exit date (as of ${exitDateIso}).`;
  if (carrierLine) {
    const baseDesc = String(carrierLine.description || "").split(" | Estimated EB ")[0];
    await sb.from("invoice_line_items")
      .update({ amount: newEb, description: `${baseDesc} | ${note}` })
      .eq("id", carrierLine.id);
  } else {
    await insertRow("invoice_line_items", {
      invoice_id: carrier.id,
      line_type: "estimated_eb",
      amount: newEb,
      description: note,
    });
  }
  return { changed: true, locked: false, oldEb, newEb, delta };
}

/**
 * UI helper: recompute the exit-month estimated EB for an allotment as of a given exit
 * date, and report what's already invoiced. Read-only — does NOT touch any invoice.
 */
export const computeExitMonthEb = action({
  args: { allotmentId: v.string(), exitDate: v.string() },
  returns: v.any(),
  handler: async (_ctx, { allotmentId, exitDate }) => {
    const sb = getSupabase();
    const allotRows = await safeList(
      sb.from("tenant_allotments")
        .select("id, apartment_id")
        .eq("id", allotmentId)
        .eq("organization_id", ORG_ID),
    );
    const allot = (allotRows as any[])[0];
    const empty = {
      recomputed: 0, invoicedOriginal: 0, estimatedEbIncluded: false,
      perDayRate: 0, daysInExitMonth: 0, canRecompute: false,
    };
    if (!allot?.apartment_id || !exitDate) return empty;

    const aptId = allot.apartment_id;
    const exitD = new Date(exitDate);
    const exitBillingMonth = String(exitDate).slice(0, 7);

    const [readings, aptAllotments] = await Promise.all([
      safeList(
        sb.from("electricity_readings")
          .select("apartment_id, billing_month, reading_start, reading_end, unit_cost")
          .eq("organization_id", ORG_ID),
      ),
      safeList(
        sb.from("tenant_allotments")
          .select("apartment_id, onboarding_date, actual_exit_date, staying_status")
          .eq("organization_id", ORG_ID)
          .eq("apartment_id", aptId),
      ),
    ]);

    const breakdown = getExitMonthEbBreakdown(aptId, exitD, readings as any[], aptAllotments as any[]);
    const { included, amount: invoicedOriginal } = await fetchExitMonthEstimatedEb(
      sb, allotmentId, exitBillingMonth, exitDate,
    );
    const canRecompute = breakdown.perDayRate > 0;
    // Never silently zero a real EB charge when readings are missing.
    const recomputed = canRecompute ? Math.max(0, breakdown.estimatedAmount) : invoicedOriginal;

    return {
      recomputed: Math.round(recomputed),
      invoicedOriginal,
      estimatedEbIncluded: included,
      perDayRate: breakdown.perDayRate,
      daysInExitMonth: breakdown.daysInExitMonth,
      canRecompute,
    };
  },
});

export const processExitFull = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    const today = data.exitDate || new Date().toISOString().split("T")[0];

    await insertRow("tenant_exits", {
      tenant_id: data.tenantId,
      allotment_id: data.allotmentId,
      bed_id: data.bedId,
      exit_date: today,
      has_notice: data.hasNotice || false,
      room_inspection: data.roomInspection || false,
      key_returned: data.keyReturned !== false,
      damage_charges: data.damageCharges || 0,
      key_loss_fee: data.keyLossFee || 0,
      exit_charges: data.exitCharges || 0,
      eb_charges: data.ebCharges || 0,
      pending_rent: data.pendingRent || 0,
      total_deductions: data.totalDeductions || 0,
      advance_held: data.advanceHeld || 0,
      refund_due: data.refundDue > 0 ? data.refundDue : 0,
      refund_status: data.refundDue > 0 ? "pending" : "none",
      notes: data.notes || null,
    });

    await sb.from("tenant_allotments").update({
      staying_status: "Exited",
      actual_exit_date: today,
    } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);

    await sb.from("beds").update({ bed_lifecycle_status: "vacant" } as any).eq("id", data.bedId);

    // Only update tenant if no other active allotments
    const others = await safeList(
      sb.from("tenant_allotments").select("id").eq("tenant_id", data.tenantId)
        .eq("organization_id", ORG_ID).in("staying_status", ["Booked", "Staying", "On-Notice"])
        .neq("id", data.allotmentId)
    );
    if (others.length === 0) {
      await sb.from("tenants").update({ staying_status: "exited" } as any).eq("id", data.tenantId);
    }

    // Revise the already-invoiced estimated EB to the recomputed value — ONLY here,
    // i.e. when the exit is completed. Non-blocking: a failure must not abort the exit.
    let ebRevision: any = null;
    if (data.reviseEstimatedEb && data.estimatedEbTarget != null) {
      try {
        ebRevision = await reviseExitEbInvoice(sb, {
          allotmentId: data.allotmentId,
          exitBillingMonth: data.exitBillingMonth || String(today).slice(0, 7),
          exitDateIso: today,
          targetEb: Number(data.estimatedEbTarget) || 0,
        });
      } catch (e: any) {
        console.warn("[processExitFull] EB revision failed:", e?.message);
      }
    }

    return { success: true, ebRevision };
  },
});

export const updateExitFull = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();

    await sb.from("tenant_exits").update({
      exit_date: data.exitDate,
      has_notice: data.hasNotice,
      damage_charges: data.damageCharges || 0,
      key_returned: data.keyReturned,
      key_loss_fee: data.keyLossFee || 0,
      exit_charges: data.exitCharges || 0,
      total_deductions: data.totalDeductions || 0,
      refund_due: data.refundDue > 0 ? data.refundDue : 0,
      notes: data.notes || null,
    } as any).eq("id", data.exitId).eq("organization_id", ORG_ID);

    // Update allotment exit date
    if (data.allotmentId) {
      await sb.from("tenant_allotments").update({
        actual_exit_date: data.exitDate,
      } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);
    }

    return { success: true };
  },
});

export const updateExitRefund = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    const total = (data.pendingRent || 0) + (data.ebCharges || 0) + (data.exitCharges || 0) + (data.damageCharges || 0) + (data.keyLossFee || 0);
    const refundDue = Math.max(0, (data.advanceHeld || 0) - total);

    await sb.from("tenant_exits").update({
      pending_rent: data.pendingRent || 0,
      eb_charges: data.ebCharges || 0,
      exit_charges: data.exitCharges || 0,
      damage_charges: data.damageCharges || 0,
      key_loss_fee: data.keyLossFee || 0,
      total_deductions: total,
      refund_due: refundDue,
    } as any).eq("id", data.exitId).eq("organization_id", ORG_ID);

    return { success: true };
  },
});

export const completeRefundFull = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();

    // Get exit record details
    const exitRows = await safeList(
      sb.from("tenant_exits").select("*").eq("id", data.exitId).eq("organization_id", ORG_ID).limit(1)
    );
    const exitRec = exitRows[0];
    if (!exitRec) throw new Error("Exit record not found");

    // Create settlement record
    await insertRow("deposit_settlements", {
      tenant_id: data.tenantId,
      allotment_id: data.allotmentId,
      deposit_amount: exitRec.advance_held || 0,
      pending_rent: exitRec.pending_rent || 0,
      pending_eb: exitRec.eb_charges || 0,
      damages: exitRec.damage_charges || 0,
      other_deductions: (exitRec.exit_charges || 0) + (exitRec.key_loss_fee || 0),
      total_deductions: exitRec.total_deductions || 0,
      refund_amount: exitRec.refund_due || 0,
      settlement_date: data.refundDate,
      status: "completed",
      notes: `Refund ref: ${data.referenceNumber}`,
      ...(data.bankAccountId ? { bank_account_id: data.bankAccountId } : {}),
    });

    // Update exit record
    await sb.from("tenant_exits").update({
      refund_status: "completed",
      refund_date: data.refundDate,
      refund_reference: data.referenceNumber,
    } as any).eq("id", data.exitId).eq("organization_id", ORG_ID);

    return { success: true };
  },
});

// ─── EDIT OCCUPIED ALLOTMENT ─────────────────────────────────────────────────

export const updateAllotmentDetails = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    await sb.from("tenant_allotments").update({
      onboarding_date: data.onboardingDate,
      discount: data.discount || 0,
      premium: data.premium || 0,
      deposit_paid: data.depositPaid || 0,
    } as any).eq("id", data.allotmentId).eq("organization_id", ORG_ID);
    return { success: true };
  },
});

// ─── UNDO ONBOARDING ─────────────────────────────────────────────────────────

export const undoOnboardingFull = action({
  args: { allotmentId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { allotmentId }) => {
    const sb = getSupabase();

    const allots = await safeList(
      sb.from("tenant_allotments").select("*").eq("id", allotmentId).eq("organization_id", ORG_ID).limit(1)
    );
    const allot = allots[0];
    if (!allot) throw new Error("Allotment not found");
    if (allot.staying_status !== "Staying") throw new Error("Only Staying tenants can be reverted");

    // Delete onboarding receipts
    await sb.from("receipts").delete()
      .eq("tenant_allotment_id", allotmentId)
      .eq("receipt_type", "onboarding")
      .eq("organization_id", ORG_ID);

    // Revert allotment to Booked
    await sb.from("tenant_allotments").update({
      staying_status: "Booked",
      onboarding_date: null,
      monthly_rental: null,
      deposit_paid: 0,
      prorated_rent: null,
      total_due: null,
      paid_amount: allot.onboarding_charges || 0,
      balance_due: 0,
      payment_status: "partial",
    } as any).eq("id", allotmentId).eq("organization_id", ORG_ID);

    // Revert bed
    await sb.from("beds").update({ bed_lifecycle_status: "booked" } as any).eq("id", allot.bed_id);
    // Revert tenant
    await sb.from("tenants").update({ staying_status: "booked" } as any).eq("id", allot.tenant_id);

    return { success: true };
  },
});

// ─── ROOM SWITCHES LIST ───────────────────────────────────────────────────────

export const listRoomSwitches = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const switches = await safeList(
      sb.from("room_switches").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false })
    );
    const tenants = await safeList(sb.from("tenants").select("id,full_name").eq("organization_id", ORG_ID));
    const tMap: Record<string, any> = {};
    tenants.forEach((t: any) => { tMap[t.id] = t; });
    return switches.map((s: any) => ({
      _id: s.id,
      tenantId: s.tenant_id,
      tenantName: tMap[s.tenant_id]?.full_name || "Unknown",
      allotmentId: s.allotment_id,
      oldBedId: s.old_bed_id,
      newBedId: s.new_bed_id,
      switchType: s.switch_type || "immediate",
      switchDate: s.switch_date,
      rentDifference: Number(s.rent_difference) || 0,
      adjustmentType: s.adjustment_type || "none",
      createdAt: s.created_at,
    }));
  },
});

// ─── NOT-IN-PROPERTY: ABSENCE RECORDS ────────────────────────────────────────
// Track tenant absences > 30 days to exclude from electricity billing.
// Mirrors web app "Not in Property" tab in TenantLifecycle.

export const listAbsenceRecords = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return await safeList(
      sb.from("tenant_absence_records")
        .select("*, tenants(full_name, phone)")
        .eq("organization_id", ORG_ID)
        .order("from_date", { ascending: false })
    );
  },
});

export const createAbsenceRecord = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    return await insertRow("tenant_absence_records", {
      tenant_id: data.tenantId,
      allotment_id: data.allotmentId || null,
      from_date: data.fromDate,
      to_date: data.toDate,
      reason: data.reason || null,
    });
  },
});

export const updateAbsenceRecord = action({
  args: { id: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { id, data }) => {
    const sb = getSupabase();
    await sb.from("tenant_absence_records").update({
      from_date: data.fromDate,
      to_date: data.toDate,
      reason: data.reason || null,
    } as any).eq("id", id).eq("organization_id", ORG_ID);
    return { success: true };
  },
});

export const deleteAbsenceRecord = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    const sb = getSupabase();
    await sb.from("tenant_absence_records").delete().eq("id", id).eq("organization_id", ORG_ID);
    return { success: true };
  },
});

export const getLifecycleFullData = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const [allotments, tenants, beds, apartments, properties, exits, notices, bedRates, lifecycleConfigRows, bankAccounts, absenceRecords] = await Promise.all([
      safeList(sb.from("tenant_allotments").select("*, tenants(full_name,phone,kyc_completed,gender), properties(property_name), apartments(apartment_code,gender_allowed,status), beds(bed_code,bed_type,toilet_type,bed_lifecycle_status)").eq("organization_id", ORG_ID).order("created_at", { ascending: false })),
      safeList(sb.from("tenants").select("*").eq("organization_id", ORG_ID).order("full_name")),
      safeList(sb.from("beds").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("apartments").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("properties").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("tenant_exits").select("*, tenants(full_name,phone), tenant_allotments(apartment_id, apartments(apartment_code))").eq("organization_id", ORG_ID).eq("is_deleted", false).order("created_at", { ascending: false })),
      safeList(sb.from("tenant_notices").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false })),
      safeList(sb.from("bed_rates").select("*").eq("organization_id", ORG_ID).order("from_date", { ascending: false })),
      safeList(sb.from("lifecycle_config").select("*").eq("organization_id", ORG_ID).order("from_date", { ascending: false })),
      // Fetch active org bank accounts for payment tracking (matches web app behaviour)
      safeList(sb.from("organization_bank_accounts").select("id,bank_name,account_number,ifsc_code,is_primary,status").eq("organization_id", ORG_ID).eq("status", "active").order("is_primary", { ascending: false })),
      // Fetch absence records for "Not in Property" tab
      safeList(sb.from("tenant_absence_records").select("*, tenants(full_name, phone)").eq("organization_id", ORG_ID).order("from_date", { ascending: false })),
    ]);

    const today = new Date().toISOString().split("T")[0];
    const activeConfig = lifecycleConfigRows.find((c: any) => c.from_date <= today && (!c.to_date || c.to_date >= today)) || {
      booking_fee: 1000, onboarding_fee: 1000, advance_ratio: 1.5,
      exit_fee_under_1yr: 2250, key_loss_fee: 500, notice_period_days: 30,
      refund_deadline_days: 5, cc_charge_percent: 1.5,
    };

    // Ensure cc_charge_percent is always present (may be missing from older DB rows)
    if (activeConfig.cc_charge_percent == null) activeConfig.cc_charge_percent = 1.5;

    return { allotments, tenants, beds, apartments, properties, exits, notices, bedRates, config: activeConfig, bankAccounts, absenceRecords };
  },
});

// ─── GET TENANT LOCATION ──────────────────────────────────────────────────────
// Called by auth.tsx on login for tenant role users.
// Looks up the tenant record by phone, finds their active allotment,
// then resolves apartment, property, and bed details for ticket creation.

export const getTenantLocation = action({
  args: { phone: v.string() },
  returns: v.any(),
  handler: async (_ctx, { phone }) => {
    const sb = getSupabase();
    const clean = cleanPhone(phone);
    const variants = phoneVariants(clean);

    // ── 1. Find tenant by phone (try all variants) ────────────────────────────
    const { data: tenants, error: tenantErr } = await sb
      .from("tenants")
      .select("id, full_name, phone, staying_status, kyc_completed")
      .eq("organization_id", ORG_ID)
      .in("phone", variants);

    if (tenantErr) {
      console.warn("[getTenantLocation] tenant lookup error:", tenantErr.message);
      return { found: false, reason: "db_error" };
    }

    const tenant = tenants?.[0];
    if (!tenant) {
      console.warn("[getTenantLocation] no tenant found for phone variants:", variants);
      return { found: false, reason: "tenant_not_found" };
    }

    // ── 2. Find active allotment ──────────────────────────────────────────────
    // Cover both casing variants that exist in the DB
    // Must match the exact enum values: CREATE TYPE staying_status AS ENUM ('Booked','Staying','On-Notice','Exited','Cancelled')
    const ACTIVE_STATUSES = ["Staying", "On-Notice", "Booked"];

    const { data: allotments, error: allotErr } = await sb
      .from("tenant_allotments")
      .select("id, tenant_id, property_id, apartment_id, bed_id, staying_status, monthly_rental, onboarding_date")
      .eq("tenant_id", tenant.id)
      .eq("organization_id", ORG_ID)
      .in("staying_status", ACTIVE_STATUSES)
      .order("created_at", { ascending: false })
      .limit(1);

    if (allotErr) {
      console.warn("[getTenantLocation] allotment lookup error:", allotErr.message);
      return { found: false, reason: "db_error" };
    }

    const allotment = allotments?.[0];
    if (!allotment) {
      console.warn("[getTenantLocation] no active allotment for tenant:", tenant.id);
      return { found: false, reason: "no_active_allotment" };
    }

    // ── 3. Resolve bed details ────────────────────────────────────────────────
    const { data: bed } = await sb
      .from("beds")
      .select("id, bed_code, bed_type, toilet_type")
      .eq("id", allotment.bed_id)
      .single();

    // ── 4. Resolve apartment details ──────────────────────────────────────────
    const { data: apartment } = await sb
      .from("apartments")
      .select("id, apartment_code, floor_number")
      .eq("id", allotment.apartment_id)
      .single();

    // ── 5. Resolve property details ───────────────────────────────────────────
    const { data: property } = await sb
      .from("properties")
      .select("id, property_name, address")
      .eq("id", allotment.property_id)
      .single();

    return {
      found: true,
      tenantId:        tenant.id,
      tenantName:      tenant.full_name,
      // Allotment ID — used when creating tickets so createTicketHelper
      // can skip the allotment lookup and use this directly
      allotmentId:     allotment.id,
      // Property
      propertyId:      property?.id      || allotment.property_id,
      propertyName:    property?.property_name || "",
      propertyAddress: property?.address || "",
      // Apartment
      apartmentId:     apartment?.id     || allotment.apartment_id,
      apartmentName:   apartment?.apartment_code || "",
      unitNumber:      apartment?.apartment_code || "",
      floor:           apartment?.floor_number?.toString() || "",
      buildingName:    property?.property_name || "",
      // Bed
      bedId:           bed?.id           || allotment.bed_id,
      bedCode:         bed?.bed_code     || "",
      // Financials / dates
      monthlyRent:     Number(allotment.monthly_rental) || 0,
      checkInDate:     allotment.onboarding_date || "",
      // Status / KYC (web parity) — the active allotment's status is authoritative
      stayingStatus:   allotment.staying_status || tenant.staying_status || "Staying",
      staying_status:  allotment.staying_status || tenant.staying_status || "Staying",
      kycCompleted:    tenant.kyc_completed || false,
      kyc_completed:   tenant.kyc_completed || false,
    };
  },
});

// ─── GET TENANT PROFILE ───────────────────────────────────────────────────────
// Full tenant profile for the tenant profile screen.

export const getTenantProfile = action({
  args: { phone: v.string() },
  returns: v.any(),
  handler: async (_ctx, { phone }) => {
    const sb = getSupabase();
    const clean = cleanPhone(phone);
    const variants = phoneVariants(clean);

    const { data: tenants, error } = await sb
      .from("tenants")
      .select("*")
      .eq("organization_id", ORG_ID)
      .in("phone", variants);

    if (error) throw new Error(error.message);

    const tenant = tenants?.[0];
    if (!tenant) return null;

    // Active allotment for context
    const { data: allotments } = await sb
      .from("tenant_allotments")
      .select("id, property_id, apartment_id, bed_id, staying_status, monthly_rental, onboarding_date, notice_date, estimated_exit_date")
      .eq("tenant_id", tenant.id)
      .eq("organization_id", ORG_ID)
      .in("staying_status", ["Staying", "On-Notice", "Booked"])
      .order("created_at", { ascending: false })
      .limit(1);

    const allotment = allotments?.[0] || null;

    // Resolve apartment/bed codes for the active allotment (nice display).
    let apartmentCode: string | null = null;
    let bedCode: string | null = null;
    if (allotment?.apartment_id) {
      const { data: apt } = await sb.from("apartments").select("apartment_code").eq("id", allotment.apartment_id).limit(1);
      apartmentCode = apt?.[0]?.apartment_code || null;
    }
    if (allotment?.bed_id) {
      const { data: bed } = await sb.from("beds").select("bed_code").eq("id", allotment.bed_id).limit(1);
      bedCode = bed?.[0]?.bed_code || null;
    }

    return {
      id:               tenant.id,
      fullName:         tenant.full_name,
      phone:            tenant.phone,
      email:            tenant.email || null,
      gender:           tenant.gender || null,
      photoUrl:         tenant.photo_url || null,
      permanentAddress: tenant.permanent_address || tenant.address || null,
      kycCompleted:     tenant.kyc_completed || false,
      stayingStatus:    tenant.staying_status || "new",
      allotmentId:      allotment?.id || null,
      propertyId:       allotment?.property_id || null,
      apartmentId:      allotment?.apartment_id || null,
      apartmentCode,
      bedId:            allotment?.bed_id || null,
      bedCode,
      monthlyRent:      Number(allotment?.monthly_rental) || 0,
      checkInDate:      allotment?.onboarding_date || null,
      noticeDate:       allotment?.notice_date || null,
      estimatedExitDate: allotment?.estimated_exit_date || null,
    };
  },
});

// ─── LIST TENANTS (enriched — matches what TenantsScreen.tsx expects) ─────────
// Returns camelCase fields with status normalisation and current bed/apartment/property.

export const listTenants = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();

    // 1. All tenants for this org
    const tenants = await safeList(
      sb.from("tenants")
        .select("id, full_name, first_name, last_name, phone, email, gender, date_of_birth, permanent_address, address, city, state, pincode, company_name, company_address, designation, profession, emergency_contact_name, emergency_contact_phone, id_proof_type, id_proof_number, id_proof_url, photo_url, kyc_completed, staying_status, tenant_rating, rating_last_computed, pan_number, created_at")
        .eq("organization_id", ORG_ID)
        .order("full_name")
    );

    if (!tenants.length) return [];

    // 2. Fetch active allotments for all tenants in one query (join bed, apartment, property)
    const tenantIds = tenants.map((t: any) => t.id);
    const allotments = await safeList(
      sb.from("tenant_allotments")
        .select("id, tenant_id, bed_id, apartment_id, property_id, staying_status, monthly_rental, onboarding_date, actual_exit_date, balance_due, beds(bed_code), apartments(apartment_code), properties(property_name)")
        .eq("organization_id", ORG_ID)
        .in("tenant_id", tenantIds)
        .in("staying_status", ["Staying", "On-Notice", "Booked"])
        .order("created_at", { ascending: false })
    );

    // Map allotments by tenant_id (take latest active one)
    const allotByTenant: Record<string, any> = {};
    for (const a of allotments) {
      if (!allotByTenant[a.tenant_id]) allotByTenant[a.tenant_id] = a;
    }

    // 3. Normalise status: DB stores mixed case — map to lowercase for the mobile app
    const normStatus = (raw: string | null | undefined): string => {
      if (!raw) return "new";
      const s = raw.toLowerCase().replace(/_/g, "-");
      // Map common DB variants
      if (s === "on_notice" || s === "on-notice") return "on-notice";
      if (s === "staying") return "staying";
      if (s === "booked") return "booked";
      if (s === "exited") return "exited";
      if (s === "new") return "new";
      return s;
    };

    return tenants.map((t: any) => {
      const allot = allotByTenant[t.id];
      return {
        _id:                  t.id,
        name:                 t.full_name || [t.first_name, t.last_name].filter(Boolean).join(' ') || "",
        phone:                t.phone || "",
        email:                t.email || null,
        gender:               t.gender || null,
        dateOfBirth:          t.date_of_birth || null,
        permanentAddress:     t.permanent_address || t.address || null,
        city:                 t.city || null,
        state:                t.state || null,
        pincode:              t.pincode || null,
        companyName:          t.company_name || null,
        companyAddress:       t.company_address || null,
        designation:          t.designation || t.profession || null,
        idProofType:          t.id_proof_type || null,
        idProofNumber:        t.id_proof_number || null,
        idProofUrl:           t.id_proof_url || null,
        panNumber:            t.pan_number || null,
        emergencyContactName: t.emergency_contact_name || null,
        emergencyContactPhone:t.emergency_contact_phone || null,
        photoUrl:             t.photo_url || null,
        onboardingDate:       allot?.onboarding_date || null,
        electricityBillAmount:null,   // not stored on tenants row
        kycCompleted:         t.kyc_completed || false,
        stayingStatus:        normStatus(t.staying_status),
        tenantRating:         t.tenant_rating != null ? Number(t.tenant_rating) : null,
        ratingLastComputed:   t.rating_last_computed || null,
        allotmentId:          allot?.id || null,
        currentBed:           allot?.beds?.bed_code || null,
        currentApartment:     allot?.apartments?.apartment_code || null,
        currentProperty:      allot?.properties?.property_name || null,
        monthlyRental:        allot ? Number(allot.monthly_rental) || 0 : 0,
        noticeDate:           allot?.notice_date || null,
      };
    });
  },
});

// ─── CREATE / UPDATE TENANT ─────────────────────────────────────────────────
// Columns that actually exist on the `tenants` table (mirrors the listTenants
// select). Writes are whitelisted to these so extra UI-only keys (bank_*, gst_*,
// food_preference, etc.) are dropped rather than failing the whole insert/update.
const TENANT_WRITABLE = [
  "full_name", "first_name", "last_name", "phone", "email", "gender",
  "date_of_birth", "permanent_address", "address", "city", "state", "pincode",
  "company_name", "company_address", "designation", "profession",
  "emergency_contact_name", "emergency_contact_phone",
  "id_proof_type", "id_proof_number", "id_proof_url", "photo_url",
  "kyc_completed", "pan_number",
  // Previously dropped KYC columns (web writes these to `tenants`) — fixes silent data-loss
  "aadhar_image_url", "id_card_url", "age", "date_of_joining", "food_preference",
  "relation_name", "emergency_contact_relation",
  "company_city", "company_state", "company_pincode",
  "bank_name", "bank_account_holder", "bank_account_number", "bank_branch", "bank_ifsc",
  "gst_number", "gst_name",
];

// Pick only real columns from an arbitrary payload; map the Aadhaar field into
// the id_proof_* columns (that is where the DB keeps KYC document numbers).
function mapTenantColumns(data: any): Record<string, any> {
  const row: Record<string, any> = {};
  for (const k of TENANT_WRITABLE) if (data[k] !== undefined) row[k] = data[k];
  if (data.aadhar_number && row.id_proof_number === undefined) {
    row.id_proof_number = data.aadhar_number;
    if (row.id_proof_type === undefined) row.id_proof_type = "aadhaar";
  }
  return row;
}

export const createTenant = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const row = mapTenantColumns(data);
    row.full_name = data.fullName || data.full_name || row.full_name || null;
    row.phone = cleanPhone(data.phone);
    row.organization_id = ORG_ID;
    return await insertRow("tenants", row);
  },
});

export const updateTenant = action({
  args: { id: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { id, data }) => {
    if (!id) throw new Error("updateTenant: missing tenant id");
    const row = mapTenantColumns(data);
    if (data.fullName || data.full_name) row.full_name = data.fullName || data.full_name;
    if (Object.keys(row).length === 0) return { success: true };
    return await updateRow("tenants", id, row);
  },
});

// ─── LIST STAYS ────────────────────────────────────────────────────────────────

export const listStays = action({
  args: { tenantId: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, { tenantId }) => {
    const sb = getSupabase();
    let q = sb.from("tenant_allotments").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false });
    if (tenantId) q = q.eq("tenant_id", tenantId);
    return await safeList(q);
  },
});

// ─── LIST ALLOTMENTS (enriched — matches what TenantsScreen.tsx allotments tab needs) ─

export const listAllotments = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rows = await safeList(
      sb.from("tenant_allotments")
        .select("id, tenant_id, bed_id, apartment_id, property_id, staying_status, monthly_rental, deposit_paid, onboarding_date, actual_exit_date, balance_due, tenants(full_name, phone), beds(bed_code), apartments(apartment_code), properties(property_name)")
        .eq("organization_id", ORG_ID)
        .in("staying_status", ["Staying", "On-Notice", "Booked"])
        .order("created_at", { ascending: false })
    );

    const normStatus = (raw: string): string => {
      const s = (raw || "").toLowerCase().replace(/_/g, "-");
      if (s === "on-notice" || s === "on_notice") return "on-notice";
      return s;
    };

    return rows.map((a: any) => ({
      _id:           a.id,
      tenantId:      a.tenant_id,
      tenantName:    a.tenants?.full_name || "—",
      phone:         a.tenants?.phone || null,
      bedId:         a.bed_id,
      bedCode:       a.beds?.bed_code || a.bed_id || "—",
      apartmentId:   a.apartment_id,
      apartmentCode: a.apartments?.apartment_code || "—",
      propertyId:    a.property_id,
      propertyName:  a.properties?.property_name || "—",
      stayingStatus: normStatus(a.staying_status),
      monthlyRental: Number(a.monthly_rental) || 0,
      depositPaid:   Number(a.deposit_paid) || 0,
      deposit_paid:  Number(a.deposit_paid) || 0,  // both casings for consumer parity
      onboardingDate:a.onboarding_date || null,
      exitDate:      a.actual_exit_date || null,
      noticeDate:    null,  // notice_date not in base schema
      balanceDue:    Number(a.balance_due) || 0,
    }));
  },
});

// ─── LIST HISTORICAL ALLOTMENTS ───────────────────────────────────────────────

export const listHistoricalAllotments = action({
  args: { propertyId: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, { propertyId }) => {
    const sb = getSupabase();
    let query = sb
      .from("tenant_allotments")
      .select("id, tenant_id, bed_id, apartment_id, property_id, staying_status, actual_exit_date, created_at")
      .eq("organization_id", ORG_ID)
      .in("staying_status", ["Exited", "Cancelled", "exited", "cancelled"])
      .order("created_at", { ascending: false });

    if (propertyId) {
      query = query.eq("property_id", propertyId);
    }

    const rows = await safeList(query);
    return rows.map((a: any) => ({
      _id: a.id,
      tenantId: a.tenant_id,
      bedId: a.bed_id,
      apartmentId: a.apartment_id,
      propertyId: a.property_id,
      stayingStatus: a.staying_status,
      actualExitDate: a.actual_exit_date || null,
      createdAt: a.created_at,
    }));
  },
});

// ─── CREATE ALLOTMENT ──────────────────────────────────────────────────────────

export const createAllotment = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    return await insertRow("tenant_allotments", data);
  },
});

// ─── UPDATE ALLOTMENT STATUS ───────────────────────────────────────────────────

export const updateAllotmentStatus = action({
  args: { allotmentId: v.string(), status: v.string(), bedId: v.optional(v.string()), tenantId: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, { allotmentId, status }) => {
    return await updateRow("tenant_allotments", allotmentId, { staying_status: status });
  },
});

// ─── RECORD NOTICE ─────────────────────────────────────────────────────────────

export const recordNotice = action({
  args: { allotmentId: v.string(), tenantId: v.string(), bedId: v.string(), exitDate: v.string(), notes: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, args) => {
    return await insertRow("tenant_notices", {
      tenant_id:    args.tenantId,
      allotment_id: args.allotmentId,
      bed_id:       args.bedId,
      exit_date:    args.exitDate,
      notes:        args.notes || null,
      notice_date:  new Date().toISOString().split("T")[0],
    });
  },
});

// ─── SWITCH ROOM ───────────────────────────────────────────────────────────────

export const switchRoom = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    return await updateRow("tenant_allotments", data.allotmentId, {
      bed_id:       data.newBedId,
      apartment_id: data.newApartmentId || undefined,
      property_id:  data.newPropertyId  || undefined,
    });
  },
});

// ─── REMOVE ALLOTMENT ──────────────────────────────────────────────────────────

export const removeAllotment = action({
  args: { allotmentId: v.string(), bedId: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, { allotmentId }) => {
    return await deleteRow("tenant_allotments", allotmentId);
  },
});

// ─── CREATE BOOKING ────────────────────────────────────────────────────────────

export const createBooking = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    return await insertRow("tenant_allotments", { ...data, staying_status: "Booked" });
  },
});

// ─── LIST BOOKINGS ─────────────────────────────────────────────────────────────

export const listBookings = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return await safeList(
      sb.from("tenant_allotments").select("*").eq("organization_id", ORG_ID).eq("staying_status", "Booked").order("created_at", { ascending: false })
    );
  },
});

// ─── CREATE TEST TENANT ────────────────────────────────────────────────────────

export const createTestTenant = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    return await insertRow("tenants", {
      full_name: "Test Tenant",
      phone:     cleanPhone("9999999999"),
      organization_id: ORG_ID,
    });
  },
});

// ─── SUBMIT KYC FORM ───────────────────────────────────────────────────────────

export const submitKYCForm = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    if (!data.tenantId) throw new Error("tenantId required");
    return await updateRow("tenants", data.tenantId, {
      kyc_completed: true,
      id_proof_type:  data.idProofType  || null,
      id_proof_number: data.idProofNumber || null,
      id_proof_url:   data.idProofUrl   || null,
      photo_url:      data.photoUrl     || null,
    });
  },
});

// ─── GET TENANT DETAILS (for mobile) ───────────────────────────────────────

export const getTenantDetails = action({
  args: { phone: v.string() },
  returns: v.any(),
  handler: async (ctx, { phone }) => {
    const sb = getSupabase();
    
    // Clean phone number
    const cleaned = phone.replace(/\D/g, '').slice(-10);
    if (!cleaned || cleaned.length < 10) {
      return { tenant: null, allotment: null };
    }

    try {
      // Find tenant by phone
      const { data: tenants, error: err1 } = await sb
        .from('tenants')
        .select('*')
        .eq('organization_id', ORG_ID)
        .or(`phone.ilike.%${cleaned}%,phone.ilike.%${phone}%`)
        .limit(1)
        .single();

      if (err1 || !tenants) {
        return { tenant: null, allotment: null };
      }

      // Get allotment details
      const { data: allotments } = await sb
        .from('tenant_allotments')
        .select('*, properties!inner(*), apartments!inner(*), beds!inner(*)')
        .eq('tenant_id', tenants.id)
        .eq('organization_id', ORG_ID)
        .order('onboarding_date', { ascending: false })
        .limit(1)
        .single();

      return { 
        tenant: tenants,
        allotment: allotments || null
      };
    } catch (e) {
      console.error('[getTenantDetails] error:', e);
      return { tenant: null, allotment: null };
    }
  },
});
// ─── COMPUTE TENANT RATING ────────────────────────────────────────────────────
// Mirrors web lib/tenant-rating.ts exactly.
// Payment timeliness (4pts) + Ticket volume (3pts) + Remarks (3pts) = 10pts max

export const computeTenantRating = action({
  args: { tenantId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { tenantId }) => {
    const sb = getSupabase();

    const [{ data: invoices }, { data: receipts }, { count: ticketCount }, { data: remarks }] =
      await Promise.all([
        sb.from("invoices").select("id, due_date, billing_month").eq("tenant_id", tenantId).eq("organization_id", ORG_ID),
        sb.from("receipts").select("payment_date, billing_month").eq("tenant_id", tenantId).eq("organization_id", ORG_ID),
        sb.from("maintenance_tickets").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("organization_id", ORG_ID),
        sb.from("tenant_remarks").select("remark_type, severity").eq("tenant_id", tenantId).eq("organization_id", ORG_ID),
      ]);

    // 1. Payment timeliness (4 pts)
    let paymentScore = 4;
    if (invoices && invoices.length > 0) {
      const scores: number[] = [];
      for (const inv of invoices as any[]) {
        if (!inv.due_date) continue;
        const dueDate = new Date(inv.due_date);
        const match = (receipts as any[] || []).find((r: any) => {
          if (!r.payment_date) return false;
          if (r.billing_month && inv.billing_month && r.billing_month === inv.billing_month) return true;
          const pd = new Date(r.payment_date);
          const diff = (pd.getTime() - dueDate.getTime()) / 86400000;
          return diff >= -15 && diff <= 60;
        });
        if (!match) { scores.push(0); continue; }
        const daysLate = Math.max(0, Math.floor((new Date(match.payment_date).getTime() - dueDate.getTime()) / 86400000));
        scores.push(daysLate <= 7 ? 4 : daysLate <= 15 ? 3 : daysLate <= 30 ? 2 : 1);
      }
      if (scores.length) paymentScore = scores.reduce((s, v) => s + v, 0) / scores.length;
    }

    // 2. Ticket volume (3 pts)
    const tc = ticketCount || 0;
    const ticketScore = tc === 0 ? 3 : tc <= 2 ? 2 : tc <= 5 ? 1 : 0;

    // 3. Remarks (3 pts)
    let remarkScore = 3;
    if (remarks && (remarks as any[]).length > 0) {
      let raw = 0;
      for (const r of remarks as any[]) {
        if (r.remark_type === "positive") raw += 1;
        else if (r.remark_type === "negative") raw -= r.severity === "critical" ? 2 : r.severity === "high" ? 1.5 : 1;
        else if (r.remark_type === "dispute") raw -= r.severity === "critical" ? 2.5 : 2;
      }
      remarkScore = Math.max(0, Math.min(3, 3 + raw * 0.5));
    }

    const finalScore = Math.max(0, Math.min(10, Math.round((paymentScore + ticketScore + remarkScore) * 10) / 10));
    await sb.from("tenants").update({ tenant_rating: finalScore, rating_last_computed: new Date().toISOString() } as any).eq("id", tenantId);
    return { score: finalScore };
  },
});

// ─── LIST TENANT REMARKS ──────────────────────────────────────────────────────
export const listTenantRemarks = action({
  args: { tenantId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { tenantId }) => {
    const sb = getSupabase();
    return await safeList(
      sb.from("tenant_remarks").select("*").eq("tenant_id", tenantId).eq("organization_id", ORG_ID).order("created_at", { ascending: false })
    );
  },
});

// ─── ADD TENANT REMARK ────────────────────────────────────────────────────────
export const addTenantRemark = action({
  args: {
    tenantId:    v.string(),
    remarkType:  v.string(),  // positive | negative | dispute | neutral
    title:       v.string(),
    description: v.optional(v.string()),
    severity:    v.string(),  // low | medium | high | critical
    createdBy:   v.string(),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    await insertRow("tenant_remarks", {
      organization_id: ORG_ID,
      tenant_id:    args.tenantId,
      remark_type:  args.remarkType,
      title:        args.title,
      description:  args.description || null,
      severity:     args.severity,
      created_by:   args.createdBy,
    });
    return { success: true };
  },
});

// ─── GET DUPLICATE TENANT PHONE RECORDS ───────────────────────────────────────
// Mirrors web runDuplicateScanAll — finds all phone numbers with 2+ tenants
export const getDuplicateTenants = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const data = await safeList(
      sb.from("tenants")
        .select("id, full_name, phone, email, staying_status, kyc_completed")
        .eq("organization_id", ORG_ID)
        .not("phone", "is", null)
        .order("created_at", { ascending: false })
    );
    // Group by normalised phone
    const norm = (v: string) => String(v || "").replace(/\D/g, "").trim();
    const map = new Map<string, any[]>();
    for (const r of data) {
      const p = norm(r.phone);
      if (!p) continue;
      if (!map.has(p)) map.set(p, []);
      map.get(p)!.push(r);
    }
    return Array.from(map.entries())
      .filter(([, list]) => list.length >= 2)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([phone, tenants]) => ({ phone, tenants }));
  },
});

// ─── SEARCH DUPLICATE TENANTS BY PHONE ────────────────────────────────────────
export const searchTenantsByPhone = action({
  args: { phone: v.string() },
  returns: v.any(),
  handler: async (_ctx, { phone }) => {
    const sb = getSupabase();
    return await safeList(
      sb.from("tenants")
        .select("id, full_name, phone, email, staying_status, kyc_completed")
        .eq("organization_id", ORG_ID)
        .eq("phone", phone.trim())
        .order("created_at", { ascending: false })
    );
  },
});

// ─── DELETE TENANT (guard: NEW status, no allotments) ─────────────────────────
export const deleteTenant = action({
  args: { tenantId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { tenantId }) => {
    const sb = getSupabase();
    const { data: tenant } = await sb.from("tenants").select("staying_status").eq("id", tenantId).single();
    if (!tenant) throw new Error("Tenant not found");
    if ((tenant as any).staying_status !== "new" && (tenant as any).staying_status !== "New")
      throw new Error("Only NEW tenants can be deleted.");
    const { data: allots } = await sb.from("tenant_allotments").select("id").eq("tenant_id", tenantId).limit(1);
    if ((allots || []).length > 0) throw new Error("Tenant has allotments and cannot be deleted.");
    await sb.from("tenants").delete().eq("id", tenantId).eq("organization_id", ORG_ID);
    return { success: true };
  },
});
// ═══════════════════════════════════════════════════════════════════════════
//  ONBOARDING REGISTRATION — WhatsApp send (offline-KYC link)
//  Mirrors the web "Send Registration Form" flow: invokes the offline-kyc-issue
//  edge function, which generates a secure link AND sends it over WhatsApp via
//  the botbee provider. Returns { ok, link?, reason? } so the client can fall
//  back to the native share sheet if the edge function path is unavailable.
// ═══════════════════════════════════════════════════════════════════════════
export const sendOnboardingKycWhatsapp = action({
  args: { allotmentId: v.string(), registrationData: v.any() },
  returns: v.any(),
  handler: async (_ctx, { allotmentId, registrationData }) => {
    const sb = getSupabase();
    try {
      // The edge function does crypto link minting + DB insert + WhatsApp send.
      const { data, error } = await sb.functions.invoke("offline-kyc-issue", {
        body: { allotment_id: allotmentId, registration_data: registrationData || {} },
      });
      if (error) {
        return { ok: false, reason: error.message || "offline-kyc-issue failed", whatsapp: false };
      }
      const payload: any = data || {};
      // The issue function returns { ok, link, token, whatsapp? } in the web flow.
      return {
        ok: !!payload.ok || !!payload.link,
        link: payload.link || null,
        alreadySubmitted: !!payload.already_submitted,
        whatsapp: payload.whatsapp ?? null,
      };
    } catch (e: any) {
      return { ok: false, reason: e?.message || "edge function unavailable", whatsapp: false };
    }
  },
});

// Resolve the rich tenant/apartment/bed data needed to build the Registration PDF
// for a given booked allotment (web parity with build-onboarding-registration-data).
export const getOnboardingRegistrationData = action({
  args: { allotmentId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { allotmentId }) => {
    const sb = getSupabase();
    const { data: allot } = await sb
      .from("tenant_allotments")
      .select("id, tenant_id, bed_id, apartment_id, organization_id")
      .eq("id", allotmentId)
      .single();
    if (!allot) return null;

    const [tenantRes, aptRes, bedRes] = await Promise.all([
      allot.tenant_id ? sb.from("tenants").select("*").eq("id", allot.tenant_id).single() : Promise.resolve({ data: null }),
      allot.apartment_id ? sb.from("apartments").select("apartment_code, property_id").eq("id", allot.apartment_id).single() : Promise.resolve({ data: null }),
      allot.bed_id ? sb.from("beds").select("bed_code, bed_type, toilet_type").eq("id", allot.bed_id).single() : Promise.resolve({ data: null }),
    ]);
    const t: any = (tenantRes as any).data || {};
    const apt: any = (aptRes as any).data || {};
    const bed: any = (bedRes as any).data || {};

    return {
      tenant: {
        first_name: t.first_name, last_name: t.last_name, full_name: t.full_name,
        address: t.address || t.permanent_address, city: t.city, email: t.email,
        aadhar_number: t.aadhar_number || t.id_proof_number,
        aadhar_image_url: t.aadhar_image_url,
        company_name: t.company_name, phone: t.phone,
        emergency_contact_phone: t.emergency_contact_phone,
      },
      apartment: { apartment_code: apt.apartment_code },
      bed: { bed_code: bed.bed_code, bed_type: bed.bed_type, toilet_type: bed.toilet_type },
    };
  },
});
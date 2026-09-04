"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID, safeList, insertRow } from "./lib/supabaseAdmin";
import { selectOutstandingRecipients, hasUsablePhone } from "../lib/outstandingReminders";


// ─── LIST READINGS (grouped by billing_month + property_id) ──────────────────
export const listReadings = action({
  args: { billingMonth: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, { billingMonth }) => {
    const sb = getSupabase();
    let q = sb
      .from("electricity_readings")
      .select("*")
      .eq("organization_id", ORG_ID)
      .order("created_at", { ascending: false });
    if (billingMonth) q = q.eq("billing_month", billingMonth);

    const [readings, properties, apartments] = await Promise.all([
      safeList(q),
      safeList(sb.from("properties").select("id, property_name").eq("organization_id", ORG_ID)),
      safeList(sb.from("apartments").select("id, apartment_code, eb_meter_number, property_id, status, start_date").eq("organization_id", ORG_ID)),
    ]);

    const propMap: Record<string, string> = {};
    properties.forEach((p: any) => { propMap[p.id] = p.property_name || "Unknown"; });
    const aptMap: Record<string, any> = {};
    apartments.forEach((a: any) => { aptMap[a.id] = a; });

    // Group by billing_month + property_id
    const groupMap: Record<string, any> = {};
    readings.forEach((r: any) => {
      const key = `${r.billing_month}__${r.property_id}`;
      if (!groupMap[key]) {
        groupMap[key] = {
          key,
          billing_month: r.billing_month,
          property_id: r.property_id,
          property_name: propMap[r.property_id] || "Unknown",
          total_units: 0,
          unit_cost: parseFloat(r.unit_cost || 0),
          total_amount: 0,
          is_locked: false,
          readings: [],
        };
      }
      const units = parseFloat(r.units_consumed || 0);
      groupMap[key].total_units += units;
      groupMap[key].total_amount += units * parseFloat(r.unit_cost || 0);
      if (r.is_locked) groupMap[key].is_locked = true;
      const apt = aptMap[r.apartment_id];
      groupMap[key].readings.push({
        id: r.id,
        apartment_id: r.apartment_id,
        apartment_code: apt?.apartment_code || "Unknown",
        eb_meter_number: apt?.eb_meter_number || "",
        reading_start: parseFloat(r.reading_start || 0),
        reading_end: parseFloat(r.reading_end || 0),
        units_consumed: units,
        unit_cost: parseFloat(r.unit_cost || 0),
        amount: units * parseFloat(r.unit_cost || 0),
        meter_photo_url: r.meter_photo_url || null,
        is_locked: !!r.is_locked,
      });
    });

    return Object.values(groupMap).sort((a: any, b: any) =>
      b.billing_month.localeCompare(a.billing_month)
    );
  },
});

// ─── LIST EB RATES ────────────────────────────────────────────────────────────
export const listEbRates = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const [rates, properties] = await Promise.all([
      safeList(sb.from("eb_rates").select("*").eq("organization_id", ORG_ID).order("from_date", { ascending: false })),
      safeList(sb.from("properties").select("id, property_name").eq("organization_id", ORG_ID)),
    ]);
    const propMap: Record<string, string> = {};
    properties.forEach((p: any) => { propMap[p.id] = p.property_name; });
    return rates.map((r: any) => ({
      ...r,
      property_name: r.property_id ? (propMap[r.property_id] || "Unknown") : "All Properties",
    }));
  },
});

// ─── SAVE EB RATE (create or update) ─────────────────────────────────────────
export const saveEbRate = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    const payload: any = {
      property_id: data.property_id || null,
      unit_cost: parseFloat(data.unit_cost),
      from_date: data.from_date,
      to_date: data.to_date || null,
      organization_id: ORG_ID,
    };
    if (data.id) {
      const { data: rows, error } = await sb.from("eb_rates").update(payload).eq("id", data.id).select();
      if (error) throw new Error(error.message);
      return rows?.[0];
    } else {
      const { data: rows, error } = await sb.from("eb_rates").insert(payload).select();
      if (error) throw new Error(error.message);
      return rows?.[0];
    }
  },
});

// ─── DELETE EB RATE ───────────────────────────────────────────────────────────
export const deleteEbRate = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    const sb = getSupabase();
    const { error } = await sb.from("eb_rates").delete().eq("id", id).eq("organization_id", ORG_ID);
    if (error) throw new Error(error.message);
    return true;
  },
});

// ─── LIST APARTMENTS FOR BULK ENTRY ──────────────────────────────────────────
export const listApartmentsForEB = action({
  args: { propertyId: v.string(), billingMonth: v.string() },
  returns: v.any(),
  handler: async (_ctx, { propertyId, billingMonth }) => {
    const sb = getSupabase();
    const [apartments, existingReadings, prevReadings] = await Promise.all([
      safeList(
        sb.from("apartments")
          .select("id, apartment_code, eb_meter_number, status, start_date")
          .eq("property_id", propertyId)
          .eq("organization_id", ORG_ID)
          .eq("status", "Live")
      ),
      safeList(
        sb.from("electricity_readings")
          .select("*")
          .eq("property_id", propertyId)
          .eq("billing_month", billingMonth)
          .eq("organization_id", ORG_ID)
      ),
      safeList(
        sb.from("electricity_readings")
          .select("apartment_id, billing_month, reading_end")
          .eq("property_id", propertyId)
          .eq("organization_id", ORG_ID)
          .order("billing_month", { ascending: false })
      ),
    ]);

    const isLocked = existingReadings.some((r: any) => r.is_locked);

    const rows = apartments.map((apt: any) => {
      const existing = existingReadings.find((r: any) => r.apartment_id === apt.id);
      if (existing) {
        return {
          id: existing.id,
          apartment_id: apt.id,
          apartment_code: apt.apartment_code,
          eb_meter_number: apt.eb_meter_number || "",
          previous_reading: parseFloat(existing.reading_start || 0),
          reading_end: parseFloat(existing.reading_end || 0),
          meter_photo_url: existing.meter_photo_url || null,
          is_existing: true,
        };
      }
      const prev = prevReadings
        .filter((r: any) => r.apartment_id === apt.id && r.billing_month < billingMonth)
        .sort((a: any, b: any) => b.billing_month.localeCompare(a.billing_month))[0];
      return {
        id: null,
        apartment_id: apt.id,
        apartment_code: apt.apartment_code,
        eb_meter_number: apt.eb_meter_number || "",
        previous_reading: prev ? parseFloat(prev.reading_end || 0) : 0,
        reading_end: null,
        meter_photo_url: null,
        is_existing: false,
      };
    });

    rows.sort((a: any, b: any) =>
      a.apartment_code.localeCompare(b.apartment_code, undefined, { numeric: true })
    );
    return { rows, is_locked: isLocked };
  },
});

// ─── BULK SAVE READINGS ───────────────────────────────────────────────────────
export const bulkSaveReadings = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    const { propertyId, billingMonth, unitCost, rows } = data;

    const existing = await safeList(
      sb.from("electricity_readings")
        .select("id, is_locked")
        .eq("property_id", propertyId)
        .eq("billing_month", billingMonth)
        .eq("organization_id", ORG_ID)
    );
    if (existing.some((r: any) => r.is_locked)) {
      throw new Error("This month's readings are locked and cannot be modified.");
    }

    const validRows = rows.filter((r: any) =>
      r.reading_end !== null && r.reading_end !== "" && !isNaN(parseFloat(String(r.reading_end)))
    );
    if (validRows.length === 0) throw new Error("Enter at least one reading");

    const updates = validRows.filter((r: any) => r.id);
    const inserts = validRows.filter((r: any) => !r.id);

    for (const r of updates) {
      const readingEnd = parseFloat(String(r.reading_end));
      const { error } = await sb.from("electricity_readings").update({
        reading_start: r.previous_reading,
        reading_end: readingEnd,
        units_consumed: readingEnd - r.previous_reading,
        unit_cost: parseFloat(String(unitCost)),
        meter_photo_url: r.meter_photo_url || null,
      } as any).eq("id", r.id).eq("organization_id", ORG_ID);
      if (error) throw new Error(`Update failed: ${error.message}`);
    }

    if (inserts.length > 0) {
      const insertData = inserts.map((r: any) => {
        const readingEnd = parseFloat(String(r.reading_end));
        return {
          property_id: propertyId,
          apartment_id: r.apartment_id,
          billing_month: billingMonth,
          reading_start: r.previous_reading,
          reading_end: readingEnd,
          units_consumed: readingEnd - r.previous_reading,
          unit_cost: parseFloat(String(unitCost)),
          meter_photo_url: r.meter_photo_url || null,
          organization_id: ORG_ID,
        };
      });
      const { error } = await sb.from("electricity_readings").insert(insertData as any);
      if (error) throw new Error(`Insert failed: ${error.message}`);
    }

    return { saved: validRows.length };
  },
});

// ─── LOCK / UNLOCK ────────────────────────────────────────────────────────────
export const lockReadings = action({
  args: { propertyId: v.string(), billingMonth: v.string(), lock: v.boolean() },
  returns: v.any(),
  handler: async (_ctx, { propertyId, billingMonth, lock }) => {
    const sb = getSupabase();
    const { error } = await sb.from("electricity_readings")
      .update({ is_locked: lock } as any)
      .eq("property_id", propertyId)
      .eq("billing_month", billingMonth)
      .eq("organization_id", ORG_ID);
    if (error) throw new Error(error.message);
    return true;
  },
});

// ─── EB ANALYTICS (P&L: collected from invoices vs actual cost from readings) ──
export const getEBAnalytics = action({
  args: { propertyId: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, { propertyId }) => {
    const sb = getSupabase();

    const [readings, invoices, apartments, properties] = await Promise.all([
      safeList(
        sb.from("electricity_readings")
          .select("billing_month, property_id, apartment_id, units_consumed, unit_cost")
          .eq("organization_id", ORG_ID)
      ),
      safeList(
        sb.from("invoices")
          .select("billing_month, property_id, apartment_id, electricity_amount")
          .eq("organization_id", ORG_ID)
      ),
      safeList(
        sb.from("apartments")
          .select("id, apartment_code, property_id")
          .eq("organization_id", ORG_ID)
      ),
      safeList(
        sb.from("properties")
          .select("id, property_name")
          .eq("organization_id", ORG_ID)
      ),
    ]);

    const propMap: Record<string, string> = {};
    properties.forEach((p: any) => { propMap[p.id] = p.property_name; });
    const aptMap: Record<string, any> = {};
    apartments.forEach((a: any) => { aptMap[a.id] = a; });

    // Build last 12 months list (MMM-yy)
    const monthsList: string[] = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mon = d.toLocaleString("en-US", { month: "short" });
      monthsList.push(`${mon}-${String(d.getFullYear()).slice(2)}`);
    }

    const filterProp = (item: any) =>
      !propertyId || propertyId === "all" || item.property_id === propertyId;

    // Monthly P&L
    const monthlyData = monthsList.map((month) => {
      const mReadings = readings.filter((r: any) => r.billing_month === month && filterProp(r));
      const mInvoices = invoices.filter((i: any) => i.billing_month === month && filterProp(i));
      const ebPaid = mReadings.reduce(
        (s: number, r: any) => s + Number(r.units_consumed || 0) * Number(r.unit_cost || 0), 0
      );
      const ebCollected = mInvoices.reduce(
        (s: number, i: any) => s + Number(i.electricity_amount || 0), 0
      );
      return {
        month,
        ebCollected: Math.round(ebCollected),
        ebPaid: Math.round(ebPaid),
        variance: Math.round(ebCollected - ebPaid),
        isProfitable: ebCollected >= ebPaid,
      };
    });

    // Apartment breakdown per month (returned per-month on demand)
    const aptBreakdownByMonth: Record<string, any[]> = {};
    monthsList.forEach((month) => {
      const mReadings = readings.filter((r: any) => r.billing_month === month && filterProp(r));
      const mInvoices = invoices.filter((i: any) => i.billing_month === month && filterProp(i));

      const aptIds = new Set([
        ...mReadings.map((r: any) => r.apartment_id),
        ...mInvoices.map((i: any) => i.apartment_id),
      ]);

      const rows: any[] = [];
      aptIds.forEach((aptId: string) => {
        const apt = aptMap[aptId];
        if (!apt) return;
        const prop = propMap[apt.property_id] || "—";
        if (propertyId && propertyId !== "all" && apt.property_id !== propertyId) return;

        const aptReadings = mReadings.filter((r: any) => r.apartment_id === aptId);
        const aptInvoices = mInvoices.filter((i: any) => i.apartment_id === aptId);
        const ebActualCost = aptReadings.reduce(
          (s: number, r: any) => s + Number(r.units_consumed || 0) * Number(r.unit_cost || 0), 0
        );
        const ebCollected = aptInvoices.reduce(
          (s: number, i: any) => s + Number(i.electricity_amount || 0), 0
        );
        const totalUnits = aptReadings.reduce(
          (s: number, r: any) => s + Number(r.units_consumed || 0), 0
        );
        const unitCost = aptReadings[0] ? Number(aptReadings[0].unit_cost || 0) : 0;

        if (ebActualCost === 0 && ebCollected === 0) return;
        rows.push({
          aptCode: apt.apartment_code,
          propName: prop,
          unitsConsumed: Math.round(totalUnits * 10) / 10,
          unitCost,
          ebActualCost: Math.round(ebActualCost),
          ebCollected: Math.round(ebCollected),
          variance: Math.round(ebCollected - ebActualCost),
          tenantCount: aptInvoices.length,
        });
      });
      rows.sort((a, b) => b.ebActualCost - a.ebActualCost);
      aptBreakdownByMonth[month] = rows;
    });

    const totalCollected = monthlyData.reduce((s, m) => s + m.ebCollected, 0);
    const totalPaid = monthlyData.reduce((s, m) => s + m.ebPaid, 0);
    const profitableMonths = monthlyData.filter((m) => m.isProfitable && m.ebCollected > 0).length;

    return {
      monthlyData,
      aptBreakdownByMonth,
      totalCollected,
      totalPaid,
      totalVariance: totalCollected - totalPaid,
      profitableMonths,
      properties: properties.map((p: any) => ({ id: p.id, property_name: p.property_name })),
    };
  },
});

// ─── LEGACY addReading ────────────────────────────────────────────────────────
export const addReading = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data: args }) => {
    const sb = getSupabase();
    const unitsConsumed = args.readingEnd - args.readingStart;
    if (unitsConsumed < 0) throw new Error("End reading must be greater than start reading");
    const totalCost = unitsConsumed * args.unitCost;
    const reading = await insertRow("electricity_readings", {
      property_id: args.propertyId, apartment_id: args.apartmentId,
      reading_start: args.readingStart, reading_end: args.readingEnd,
      units_consumed: unitsConsumed, unit_cost: args.unitCost,
      total_cost: totalCost, billing_month: args.billingMonth,
    });
    let sharesCreated = 0;
    if (args.apartmentId) {
      const activeTenants = await safeList(
        sb.from("tenant_allotments").select("tenant_id,bed_id")
          .eq("apartment_id", args.apartmentId).eq("organization_id", ORG_ID)
          .in("staying_status", ["Staying", "On-Notice", "Booked"])
      );
      if (activeTenants.length > 0) {
        const sharePerTenant = Math.round((totalCost / activeTenants.length) * 100) / 100;
        for (const t of activeTenants) {
          try {
            await insertRow("electricity_shares", {
              reading_id: reading.id, tenant_id: t.tenant_id, bed_id: t.bed_id,
              share_amount: sharePerTenant, billing_month: args.billingMonth,
            });
            sharesCreated++;
          } catch (e: any) { console.warn("[electricity] share insert error:", e?.message); }
        }
      }
    }
    return { readingId: reading.id, sharesCreated };
  },
});

// ─── ACCOUNTING / ANALYTICS ──────────────────────────────────────────────────
export const listInvoices = action({
  args: {
    status: v.optional(v.string()),
    tenantId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, { status, tenantId }) => {
    const sb = getSupabase();
    // Real invoices schema (invoice_number/rent_amount/total_amount/…), soft-delete filtered.
    let query = sb
      .from("invoices")
      .select(
        "id, invoice_number, tenant_id, allotment_id, property_id, apartment_id, bed_id, billing_month, rent_amount, electricity_amount, estimated_eb, late_fee, other_charges, total_amount, amount_paid, due_date, invoice_type, status, is_deleted, created_at"
      )
      .eq("organization_id", ORG_ID)
      .or("is_deleted.is.null,is_deleted.eq.false")
      .order("created_at", { ascending: false });
    if (tenantId) query = query.eq("tenant_id", tenantId);
    const rows: any[] = await safeList(query);

    // Canonical per-invoice settlement (paid / outstanding / status) from the ledger view.
    const settleRows: any[] = await safeList(
      sb
        .from("v_invoice_settlement_status")
        .select("invoice_id, amount_settled, amount_outstanding, invoice_amount, settlement_status")
        .eq("organization_id", ORG_ID)
    );
    const settleById = new Map<string, any>();
    for (const s of settleRows) settleById.set(s.invoice_id, s);

    // Resolve tenant + property display names (no PostgREST embeds — avoids FK ambiguity).
    const tenantIds = [...new Set(rows.map((r) => r.tenant_id).filter(Boolean))];
    const propertyIds = [...new Set(rows.map((r) => r.property_id).filter(Boolean))];
    const tenantRows: any[] = tenantIds.length
      ? await safeList(sb.from("tenants").select("id, full_name").eq("organization_id", ORG_ID).in("id", tenantIds))
      : [];
    const propRows: any[] = propertyIds.length
      ? await safeList(sb.from("properties").select("id, property_name").eq("organization_id", ORG_ID).in("id", propertyIds))
      : [];
    const tenantName = new Map<string, string>();
    for (const t of tenantRows) tenantName.set(t.id, t.full_name);
    const propName = new Map<string, string>();
    for (const p of propRows) propName.set(p.id, p.property_name);

    const today = new Date().toISOString().slice(0, 10);
    const mapped = rows.map((row) => {
      const s = settleById.get(row.id);
      const total = Number(row.total_amount ?? 0);
      const paid = s ? Number(s.amount_settled ?? 0) : Number(row.amount_paid ?? 0);
      // Prefer the canonical settlement status; fall back to paid-vs-total + due date.
      const ss = s?.settlement_status;
      let st: string;
      if (ss === "paid" || (total > 0 && paid >= total)) st = "paid";
      else if (ss === "partial" || (paid > 0 && paid < total)) st = "partial";
      else if (row.due_date && row.due_date < today) st = "overdue";
      else st = "sent";
      return {
        _id: row.id,
        id: row.id,
        invoiceNumber: row.invoice_number || "—",
        tenantId: row.tenant_id,
        allotmentId: row.allotment_id,
        propertyId: row.property_id,
        apartmentId: row.apartment_id,
        bedId: row.bed_id,
        tenantName: tenantName.get(row.tenant_id) || "Unknown",
        propertyName: propName.get(row.property_id) || "",
        billingMonth: row.billing_month || "",
        dueDate: row.due_date || null,
        invoiceType: row.invoice_type || "regular",
        rentAmount: Number(row.rent_amount ?? 0),
        electricityAmount: Number(row.electricity_amount ?? 0),
        estimatedEb: Number(row.estimated_eb ?? 0),
        lateFee: Number(row.late_fee ?? 0),
        otherCharges: Number(row.other_charges ?? 0),
        totalAmount: total,
        paidAmount: paid,
        balance: Math.max(total - paid, 0),
        outstanding: s ? Number(s.amount_outstanding ?? 0) : Math.max(total - paid, 0),
        status: st,
      };
    });
    return status && status !== "all" ? mapped.filter((m) => m.status === status) : mapped;
  },
});

// ─── TENANT ADJUSTMENTS (credit/debit notes, read-only, web parity) ──────────
export const listAdjustments = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rows: any[] = await safeList(
      sb.from("tenant_adjustments")
        .select("id, adjustment_date, adjustment_type, category, amount, reason, reference_number, billing_month, tenant_id, allotment_id, property_id, apartment_id, bed_id, is_locked, created_at")
        .eq("organization_id", ORG_ID)
        .or("is_deleted.is.null,is_deleted.eq.false")
        .order("adjustment_date", { ascending: false }),
    );
    const tenantIds = [...new Set(rows.map((r) => r.tenant_id).filter(Boolean))];
    const propertyIds = [...new Set(rows.map((r) => r.property_id).filter(Boolean))];
    const tenants: any[] = tenantIds.length ? await safeList(sb.from("tenants").select("id, full_name").eq("organization_id", ORG_ID).in("id", tenantIds)) : [];
    const props: any[] = propertyIds.length ? await safeList(sb.from("properties").select("id, property_name").eq("organization_id", ORG_ID).in("id", propertyIds)) : [];
    const tName = new Map<string, string>(); for (const t of tenants) tName.set(t.id, t.full_name);
    const pName = new Map<string, string>(); for (const p of props) pName.set(p.id, p.property_name);
    return rows.map((r) => ({
      id: r.id,
      adjustmentDate: r.adjustment_date || null,
      adjustmentType: r.adjustment_type || "credit_note",
      category: r.category || "others",
      amount: Number(r.amount ?? 0),
      reason: r.reason || "",
      referenceNumber: r.reference_number || "",
      billingMonth: r.billing_month || "",
      tenantId: r.tenant_id,
      tenantName: tName.get(r.tenant_id) || "Unknown",
      propertyName: pName.get(r.property_id) || "",
      isLocked: !!r.is_locked,
    }));
  },
});

// ─── INVOICE DETAIL (line items + EB tenant shares, read-only, web parity) ────
export const getInvoiceDetail = action({
  args: { invoiceId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { invoiceId }) => {
    const sb = getSupabase();
    const [lineItems, ebShares] = await Promise.all([
      safeList(sb.from("invoice_line_items").select("id, invoice_id, line_type, amount, description, metadata, created_at").eq("invoice_id", invoiceId).order("created_at", { ascending: true })),
      safeList(sb.from("eb_tenant_shares").select("*").eq("invoice_id", invoiceId)),
    ]);
    return { lineItems, ebShares };
  },
});

export const createInvoice = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    const tenantId = data.tenant_id || data.tenantId;
    if (!tenantId) throw new Error("tenantId is required");

    // Resolve the tenant's active allotment (ledger pivot) + property/apartment/bed if not supplied.
    let allotmentId = data.allotment_id || data.allotmentId || null;
    let propertyId = data.property_id || data.propertyId || null;
    let apartmentId = data.apartment_id || data.apartmentId || null;
    let bedId = data.bed_id || data.bedId || null;
    if (!allotmentId || !propertyId) {
      const stays: any[] = await safeList(
        sb
          .from("tenant_allotments")
          .select("id, property_id, apartment_id, bed_id, staying_status, created_at")
          .eq("organization_id", ORG_ID)
          .eq("tenant_id", tenantId)
          .in("staying_status", ["Staying", "On-Notice", "Booked"])
          .order("created_at", { ascending: false })
          .limit(1)
      );
      const stay = stays[0];
      if (!stay) throw new Error("Tenant has no active allotment");
      allotmentId = allotmentId || stay.id;
      propertyId = propertyId || stay.property_id;
      apartmentId = apartmentId || stay.apartment_id;
      bedId = bedId || stay.bed_id;
    }

    const rent = Number(data.rent_amount ?? data.rentAmount ?? 0);
    const elec = Number(data.electricity_amount ?? data.electricityAmount ?? 0);
    const other = Number(data.other_charges ?? data.otherCharges ?? 0);
    const total = rent + elec + other;
    const today = new Date().toISOString().slice(0, 10);
    const billingMonth = data.billing_month || data.billingMonth || null;

    // ── (B) Server-side invoice numbering — web parity generateInvoiceNumbers:
    //     <Prop5>/<FY>/<MM>/<5-digit running>  e.g. VISHL/25-26/03/00001.
    //     Running count is per-property across all invoices (same client-side
    //     count as web; fine for single-admin use). Never left to a DB trigger.
    let invoiceNumber: string | null = null;
    try {
      const numMonth = /^\d{4}-\d{2}$/.test(String(billingMonth)) ? String(billingMonth) : today.slice(0, 7);
      const [yy, mm] = numMonth.split("-").map(Number);
      const fyStart = mm >= 4 ? yy : yy - 1;
      const fy = `${String(fyStart).slice(-2)}-${String(fyStart + 1).slice(-2)}`;
      const mmStr = numMonth.split("-")[1];
      const props: any[] = await safeList(sb.from("properties").select("property_name").eq("id", propertyId).limit(1));
      const abbr = String(props[0]?.property_name || "UNKNO").replace(/\s+/g, "").slice(0, 5).toUpperCase().padEnd(5, "X");
      const existingInv: any[] = await safeList(
        sb.from("invoices").select("id").eq("organization_id", ORG_ID).eq("property_id", propertyId)
      );
      const running = existingInv.length + 1;
      invoiceNumber = `${abbr}/${fy}/${mmStr}/${String(running).padStart(5, "0")}`;
    } catch (e: any) {
      console.warn("[accounting] invoice numbering failed, leaving null:", e?.message);
    }

    const payload: any = {
      organization_id: ORG_ID,
      tenant_id: tenantId,
      allotment_id: allotmentId,
      property_id: propertyId,
      apartment_id: apartmentId,
      bed_id: bedId,
      billing_month: billingMonth,
      rent_amount: rent,
      electricity_amount: elec,
      other_charges: other,
      total_amount: total,
      due_date: data.due_date || data.dueDate || null,
      invoice_date: today,
      status: "pending",
      invoice_number: invoiceNumber, // web parity: generated above, not left to a DB trigger
    };
    const { data: row, error } = await sb.from("invoices").insert(payload).select().single();
    if (error) throw new Error(error.message);

    // ── (A) invoice_line_items — one row per non-zero charge (web parity). Best-effort:
    //     the invoice already exists; the DB trigger/view drives the ledger (web's
    //     rebuildTenantTransactions is a no-op, so there is nothing else to post here).
    const charges: Array<[string, number]> = [["rent", rent], ["electricity", elec], ["other_charges", other]];
    for (const [lineType, amount] of charges) {
      if (amount > 0) {
        try {
          await insertRow("invoice_line_items", { invoice_id: (row as any).id, line_type: lineType, amount, description: lineType });
        } catch (e: any) {
          console.warn(`[accounting] invoice_line_items ${lineType} insert failed:`, e?.message);
        }
      }
    }
    return row;
  },
});

export const recordPayment = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    const invoiceId = data.invoice_id || data.invoiceId || null;
    const amount = Number(data.amount ?? data.amountPaid ?? 0);
    if (!amount || amount <= 0) throw new Error("Payment amount must be greater than 0");

    // Receipts are per-allotment; the DB trigger posts the journal (DR 1000 / CR 1200) and
    // FIFO-allocates across that allotment's outstanding invoices. Resolve tenant/allotment/
    // property from the invoice when not passed directly.
    let tenantId = data.tenant_id || data.tenantId || null;
    let allotmentId = data.tenant_allotment_id || data.allotmentId || null;
    let propertyId = data.property_id || data.propertyId || null;
    if (invoiceId && (!tenantId || !allotmentId)) {
      const { data: inv, error: invErr } = await sb
        .from("invoices")
        .select("tenant_id, allotment_id, property_id")
        .eq("id", invoiceId)
        .eq("organization_id", ORG_ID)
        .maybeSingle();
      if (invErr) throw new Error(invErr.message);
      tenantId = tenantId || (inv as any)?.tenant_id || null;
      allotmentId = allotmentId || (inv as any)?.allotment_id || null;
      propertyId = propertyId || (inv as any)?.property_id || null;
    }
    if (!tenantId || !allotmentId) throw new Error("Could not resolve tenant/allotment for receipt");

    const paymentDate = data.payment_date || data.paymentDate || new Date().toISOString().slice(0, 10);

    // ── (C) Duplicate-receipt guard (web parity checkReceiptDuplicate) ──
    //   A: reference/UTR uniqueness across the org. B: same tenant + date + amount
    //   (closes the manual re-entry hole). Fail-open: a broken check never blocks a
    //   legitimate payment. Returns { ok:false } so the UI can explain the block.
    try {
      const refNum = String(data.reference_number ?? data.referenceNumber ?? "").trim();
      if (refNum) {
        const dupRef: any[] = await safeList(
          sb.from("receipts").select("id, receipt_number, reference_number")
            .eq("organization_id", ORG_ID).eq("reference_number", refNum).eq("is_deleted", false).limit(1)
        );
        if (dupRef[0]) {
          return { ok: false, duplicate: true, reason: `Duplicate payment — reference/UTR "${refNum}" is already used (receipt ${dupRef[0].receipt_number ?? "—"}).` };
        }
      }
      const dupFp: any[] = await safeList(
        sb.from("receipts").select("id, receipt_number")
          .eq("organization_id", ORG_ID).eq("tenant_id", tenantId).eq("payment_date", paymentDate).eq("amount_paid", amount).eq("is_deleted", false).limit(1)
      );
      if (dupFp[0]) {
        return { ok: false, duplicate: true, reason: `Duplicate payment — this tenant already has a payment of ${amount} on ${paymentDate} (receipt ${dupFp[0].receipt_number ?? "—"}).` };
      }
    } catch (e: any) {
      console.warn("[accounting] duplicate-receipt check failed, allowing payment:", e?.message);
    }

    // Canonical server-side receipt numbering; fall back to DB default if the RPC is unavailable.
    let receiptNumber: string | null = null;
    try {
      const { data: rn, error: rnErr } = await sb.rpc("next_receipt_number", {
        p_org: ORG_ID,
        p_property: propertyId,
        p_date: paymentDate,
      });
      if (!rnErr && rn) receiptNumber = rn as string;
    } catch {
      /* numbering assigned by DB default/trigger when the RPC is not present */
    }

    const payload: any = {
      organization_id: ORG_ID,
      tenant_id: tenantId,
      tenant_allotment_id: allotmentId,
      amount_paid: amount,
      payment_date: paymentDate,
      payment_mode: data.payment_mode || data.paymentMode || null,
      reference_number: data.reference_number || data.referenceNumber || null,
      bank_account_id: data.bank_account_id || data.bankAccountId || null,
      receipt_number: receiptNumber,
    };
    // Insert the receipt only — the ledger trigger does the journal posting + FIFO allocation.
    // Do NOT write a `payments` row and do NOT manually flip invoice status.
    const { data: row, error } = await sb.from("receipts").insert(payload).select().single();
    if (error) {
      if ((error as any).code === "23505" || /duplicate key|unique constraint/i.test(error.message || "")) {
        return { ok: false, duplicate: true, reason: "Duplicate payment — this receipt already exists (unique constraint)." };
      }
      throw new Error(error.message);
    }
    return row;
  },
});

export const listExpenses = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    // Real schema: expenses.category_id → expense_categories.label (there is no expenses.category column).
    const rows = await safeList(
      sb.from("expenses")
        .select("id, category_id, description, amount, expense_date, created_at")
        .eq("organization_id", ORG_ID)
        .order("created_at", { ascending: false })
    );
    const catIds = [...new Set(rows.map((r: any) => r.category_id).filter(Boolean))];
    const cats = catIds.length
      ? await safeList(sb.from("expense_categories").select("id, label").eq("organization_id", ORG_ID).in("id", catIds))
      : [];
    const catLabel = new Map<string, string>();
    for (const c of cats) catLabel.set(c.id, c.label);
    return rows.map((row: any) => ({
      id: row.id,
      category: row.category_id ? (catLabel.get(row.category_id) || null) : null,
      description: row.description || null,
      amount: row.amount ?? 0,
      expense_date: row.expense_date || null,
      created_at: row.created_at || null,
    }));
  },
});

export const listReceipts = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rows = await safeList(
      sb.from("receipts")
        .select("id, tenant_id, tenant_allotment_id, amount_paid, base_amount, processing_fee, payment_mode, reference_number, payment_date, receipt_type, created_at")
        .eq("organization_id", ORG_ID)
        .order("created_at", { ascending: false })
    );
    return rows.map((row: any) => ({
      id: row.id,
      tenant_id: row.tenant_id || null,
      tenant_allotment_id: row.tenant_allotment_id || null,
      amount_paid: row.amount_paid ?? 0,
      base_amount: row.base_amount ?? 0,
      processing_fee: row.processing_fee ?? 0,
      payment_mode: row.payment_mode || null,
      reference_number: row.reference_number || null,
      payment_date: row.payment_date || null,
      receipt_type: row.receipt_type || null,
      created_at: row.created_at || null,
    }));
  },
});

export const listOwnerPayments = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rows = await safeList(
      sb.from("owner_payments")
        // Real schema: base_amount/escalated_amount (no `amount`), paid_date (no `payment_date`).
        .select("id, owner_id, base_amount, escalated_amount, paid_date, payment_mode, notes, created_at")
        .eq("organization_id", ORG_ID)
        .order("created_at", { ascending: false })
    );
    return rows.map((row: any) => ({
      id: row.id,
      owner_id: row.owner_id || null,
      amount: Number(row.escalated_amount ?? row.base_amount ?? 0),
      payment_date: row.paid_date || null,
      payment_mode: row.payment_mode || null,
      notes: row.notes || null,
      created_at: row.created_at || null,
    }));
  },
});

// ─── PENDING DUES (canonical) ────────────────────────────────────────────────
// Reads the journal-backed AR view — never sums raw invoices/receipts.
export const getPendingDues = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rows: any[] = await safeList(
      sb.from("v_tenant_current_dues").select("net_dues, ar_balance").eq("organization_id", ORG_ID)
    );
    let pending = 0;
    for (const r of rows) {
      const due = Number(r.net_dues ?? r.ar_balance ?? 0);
      if (due > 0) pending += due;
    }
    return { totalPending: Math.round(pending) };
  },
});

// ─── ACTIVE TENANTS FOR BILLING (invoice/receipt pickers) ────────────────────
export const listBillingTenants = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const allots: any[] = await safeList(
      sb
        .from("tenant_allotments")
        .select("id, tenant_id, property_id, apartment_id, bed_id, staying_status, monthly_rental, created_at")
        .eq("organization_id", ORG_ID)
        .in("staying_status", ["Staying", "On-Notice"])
        .order("created_at", { ascending: false })
    );
    const tenantIds = [...new Set(allots.map((a) => a.tenant_id).filter(Boolean))];
    const bedIds = [...new Set(allots.map((a) => a.bed_id).filter(Boolean))];
    const tenants: any[] = tenantIds.length
      ? await safeList(sb.from("tenants").select("id, full_name").eq("organization_id", ORG_ID).in("id", tenantIds))
      : [];
    const beds: any[] = bedIds.length
      ? await safeList(sb.from("beds").select("id, bed_code").in("id", bedIds))
      : [];
    const tName = new Map<string, string>();
    for (const t of tenants) tName.set(t.id, t.full_name);
    const bCode = new Map<string, string>();
    for (const b of beds) bCode.set(b.id, b.bed_code);

    const seen = new Set<string>();
    const out: any[] = [];
    for (const a of allots) {
      if (!a.tenant_id || seen.has(a.tenant_id)) continue; // latest active allotment per tenant
      seen.add(a.tenant_id);
      out.push({
        tenantId: a.tenant_id,
        allotmentId: a.id,
        tenantName: tName.get(a.tenant_id) || "Unknown",
        bedCode: bCode.get(a.bed_id) || "",
        propertyId: a.property_id,
        apartmentId: a.apartment_id,
        bedId: a.bed_id,
        monthlyRent: Number(a.monthly_rental) || 0,
        status: "active",
      });
    }
    return out;
  },
});

// ─── LIST EB PAYMENTS ─────────────────────────────────────────────────────────
export const listEbPayments = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rows = await safeList(
      sb.from("eb_payments")
        .select("*, properties(property_name)")
        .eq("organization_id", ORG_ID)
        .order("bill_date", { ascending: false })
    );
    return rows.map((p: any) => ({
      id: p.id,
      property_id: p.property_id,
      apartment_id: p.apartment_id || null,
      property_name: p.properties?.property_name || "—",
      bill_date: p.bill_date,
      bill_amount: Number(p.bill_amount) || 0,
      payment_date: p.payment_date || null,
      payment_mode: p.payment_mode || null,
      reference_number: p.reference_number || null,
      billing_period_start: p.billing_period_start || null,
      billing_period_end: p.billing_period_end || null,
      notes: p.notes || null,
    }));
  },
});

// ─── SAVE EB PAYMENT (insert or update) ──────────────────────────────────────
export const saveEbPayment = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    const payload: any = {
      organization_id: ORG_ID,
      property_id: data.property_id,
      apartment_id: data.apartment_id || null,
      bill_date: data.bill_date,
      bill_amount: parseFloat(data.bill_amount),
      payment_date: data.payment_date || null,
      payment_mode: data.payment_mode || null,
      reference_number: data.reference_number || null,
      billing_period_start: data.billing_period_start || null,
      billing_period_end: data.billing_period_end || null,
      notes: data.notes || null,
    };
    if (data.id) {
      await sb.from("eb_payments").update(payload).eq("id", data.id).eq("organization_id", ORG_ID);
    } else {
      await sb.from("eb_payments").insert(payload);
    }
    return { success: true };
  },
});

// ─── DELETE EB PAYMENT ────────────────────────────────────────────────────────
export const deleteEbPayment = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    const sb = getSupabase();
    await sb.from("eb_payments").delete().eq("id", id).eq("organization_id", ORG_ID);
    return { success: true };
  },
});

// ─── LOAD EB PAYMENT BULK ROWS (apartments for a property) ───────────────────
export const loadEbPayBulkRows = action({
  args: { propertyId: v.string(), billDate: v.string() },
  returns: v.any(),
  handler: async (_ctx, { propertyId, billDate }) => {
    const sb = getSupabase();
    const [apts, existing] = await Promise.all([
      safeList(sb.from("apartments").select("id, apartment_code").eq("organization_id", ORG_ID).eq("property_id", propertyId).eq("status", "Live").order("apartment_code")),
      billDate ? safeList(sb.from("eb_payments").select("id, apartment_id, bill_amount, reference_number").eq("organization_id", ORG_ID).eq("property_id", propertyId).eq("bill_date", billDate)) : Promise.resolve([]),
    ]);
    const existingMap: Record<string, any> = {};
    existing.forEach((p: any) => { if (p.apartment_id) existingMap[p.apartment_id] = p; });
    return apts.map((apt: any) => {
      const ex = existingMap[apt.id];
      return {
        apartment_id: apt.id,
        apartment_code: apt.apartment_code,
        bill_amount: ex ? String(ex.bill_amount) : "",
        reference_number: ex ? (ex.reference_number || "") : "",
        existing_id: ex?.id || null,
      };
    });
  },
});
// ─── LIST FLAT READINGS (per apartment, not grouped) ──────────────────────────
// Used by Analytics: EBAnalyticsTab and PredictiveTab need individual
// apartment-level readings with billing_month and property_id.
export const listFlatReadings = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rows = await safeList(
      sb.from("electricity_readings")
        .select("id, apartment_id, property_id, billing_month, reading_start, reading_end, units_consumed, unit_cost, is_locked")
        .eq("organization_id", ORG_ID)
        .order("billing_month", { ascending: false })
    );
    return rows.map((r: any) => ({
      id:            r.id,
      apartmentId:   r.apartment_id,
      propertyId:    r.property_id,
      billingMonth:  r.billing_month || "",
      readingStart:  Number(r.reading_start) || 0,
      readingEnd:    Number(r.reading_end) || 0,
      unitsConsumed: Number(r.units_consumed) || 0,
      unitCost:      Number(r.unit_cost) || 0,
      isLocked:      !!r.is_locked,
    }));
  },
});

// ─── OUTSTANDING DUES (ledger-backed reminder audience, web parity) ──────────
// Who currently owes money and how much, drawn from the LEDGER views (not
// invoices.status). Read-only preview. Enriches each recipient with the phone
// number so the UI can open a per-tenant WhatsApp/dialer deep link.
export const fetchOutstandingRecipients = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    // Audience is drawn from the reliable ledger view v_tenant_current_dues.
    // NOTE (verified on dev 2026-09-04): the sibling v_invoice_settlement_status
    // view is NOT reliably queryable via the service-role client — .range()/.limit()
    // intermittently return 0 rows (the view is expensive and reads flake to empty).
    // So we deliberately do NOT use it; auto_selected falls back to has_phone
    // instead of the web's invoice-backed nuance. v_tenant_current_dues needs an
    // explicit .order() before .range() or it too returns 0.
    const dues: any[] = await safeList(
      sb.from("v_tenant_current_dues")
        .select("tenant_id, ar_balance")
        .eq("organization_id", ORG_ID)
        .order("tenant_id", { ascending: true })
        .range(0, 99999),
    );

    const tenantIds = [...new Set((dues as any[]).map((d) => d.tenant_id).filter(Boolean))] as string[];
    if (tenantIds.length === 0) return [];

    const tenantNames = new Map<string, string>();
    const tenantPhones = new Map<string, string>();
    const tenantsMissingPhone = new Set<string>();
    const CHUNK = 200;
    for (let i = 0; i < tenantIds.length; i += CHUNK) {
      const slice = tenantIds.slice(i, i + CHUNK);
      const tRows: any[] = await safeList(
        sb.from("tenants").select("id, full_name, phone").eq("organization_id", ORG_ID).in("id", slice),
      );
      for (const t of tRows) {
        tenantNames.set(t.id, t.full_name || "Tenant");
        if (hasUsablePhone(t.phone)) tenantPhones.set(t.id, String(t.phone));
        else tenantsMissingPhone.add(t.id);
      }
    }
    // A tenant absent from `tenants` entirely has no number either.
    for (const id of tenantIds) if (!tenantNames.has(id)) tenantsMissingPhone.add(id);

    // Settlements omitted (view unreliable) → auto_selected = has_phone.
    const recipients = selectOutstandingRecipients(dues as any, tenantNames, tenantsMissingPhone);
    // Attach the phone number (for the UI's WhatsApp/dialer deep link).
    return recipients.map((r) => ({ ...r, phone: tenantPhones.get(r.tenant_id) || null }));
  },
});

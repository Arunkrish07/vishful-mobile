"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID, safeList, insertRow } from "./lib/supabaseAdmin";

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
      bank_account_id: p.bank_account_id || null,
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
      bank_account_id: data.bank_account_id || null,
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
// ─── METER PHOTO OCR (item 13) ────────────────────────────────────────────────
// Calls the Supabase `scan-meter-reading` edge function (Gemini vision) and returns
// { reading_value, apartment_code, confidence, unit, error }. The image must be a
// publicly-fetchable URL (the meter-photos bucket URL returned on upload).
export const scanMeterReading = action({
  args: { imageUrl: v.string() },
  returns: v.any(),
  handler: async (_ctx, { imageUrl }) => {
    const fail = (error: string) => ({
      reading_value: null, apartment_code: null, confidence: "low", unit: "kWh", error,
    });
    const base = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) return fail("OCR not configured on server");
    if (!imageUrl) return fail("imageUrl is required");
    try {
      const resp = await fetch(`${base}/functions/v1/scan-meter-reading`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          apikey: key,
        },
        body: JSON.stringify({ imageUrl }),
      });
      const data: any = await resp.json().catch(() => null);
      if (!resp.ok || !data) return fail((data && data.error) || `OCR service error (${resp.status})`);
      return data;
    } catch (e: any) {
      return fail(e?.message || "OCR request failed");
    }
  },
});
// lib/electricity.ts — client port of convex/electricity.ts (reads + writes),
// running directly against Supabase under the logged-in user's JWT (RLS).
// Keep in sync with convex/electricity.ts.
import { supabase } from "./supabase";
import { ORG_ID, safeList, insertRow, deleteDisabledResult } from "./supabaseDb";

export async function listReadings(billingMonth?: string) {
  let q = supabase.from("electricity_readings").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false });
  if (billingMonth) q = q.eq("billing_month", billingMonth);
  const [readings, properties, apartments] = await Promise.all([
    safeList(q),
    safeList(supabase.from("properties").select("id, property_name").eq("organization_id", ORG_ID)),
    safeList(supabase.from("apartments").select("id, apartment_code, eb_meter_number, property_id, status, start_date").eq("organization_id", ORG_ID)),
  ]);
  const propMap: Record<string, string> = {}; properties.forEach((p: any) => { propMap[p.id] = p.property_name || "Unknown"; });
  const aptMap: Record<string, any> = {}; apartments.forEach((a: any) => { aptMap[a.id] = a; });
  const groupMap: Record<string, any> = {};
  readings.forEach((r: any) => {
    const key = `${r.billing_month}__${r.property_id}`;
    if (!groupMap[key]) {
      groupMap[key] = { key, billing_month: r.billing_month, property_id: r.property_id, property_name: propMap[r.property_id] || "Unknown", total_units: 0, unit_cost: parseFloat(r.unit_cost || 0), total_amount: 0, is_locked: false, readings: [] };
    }
    const units = parseFloat(r.units_consumed || 0);
    groupMap[key].total_units += units;
    groupMap[key].total_amount += units * parseFloat(r.unit_cost || 0);
    if (r.is_locked) groupMap[key].is_locked = true;
    const apt = aptMap[r.apartment_id];
    groupMap[key].readings.push({
      id: r.id, apartment_id: r.apartment_id, apartment_code: apt?.apartment_code || "Unknown",
      eb_meter_number: apt?.eb_meter_number || "", reading_start: parseFloat(r.reading_start || 0),
      reading_end: parseFloat(r.reading_end || 0), units_consumed: units, unit_cost: parseFloat(r.unit_cost || 0),
      amount: units * parseFloat(r.unit_cost || 0), meter_photo_url: r.meter_photo_url || null, is_locked: !!r.is_locked,
    });
  });
  const MON = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const monthRank = (bm: string): number => {
    const [mon, yr] = String(bm || "").toLowerCase().split("-");
    const mi = MON.indexOf((mon || "").slice(0, 3));
    if (mi < 0) return -1;
    return (2000 + (parseInt(yr, 10) || 0)) * 12 + mi;
  };
  return Object.values(groupMap).sort((a: any, b: any) => monthRank(b.billing_month) - monthRank(a.billing_month));
}

export async function listEbRates() {
  const [rates, properties] = await Promise.all([
    safeList(supabase.from("eb_rates").select("*").eq("organization_id", ORG_ID).order("from_date", { ascending: false })),
    safeList(supabase.from("properties").select("id, property_name").eq("organization_id", ORG_ID)),
  ]);
  const propMap: Record<string, string> = {}; properties.forEach((p: any) => { propMap[p.id] = p.property_name; });
  return rates.map((r: any) => ({ ...r, property_name: r.property_id ? (propMap[r.property_id] || "Unknown") : "All Properties" }));
}

export async function saveEbRate(data: any) {
  const payload: any = {
    property_id: data.property_id || null, unit_cost: parseFloat(data.unit_cost),
    from_date: data.from_date, to_date: data.to_date || null, organization_id: ORG_ID,
  };
  if (data.id) {
    const { data: rows, error } = await supabase.from("eb_rates").update(payload).eq("id", data.id).select();
    if (error) throw new Error(error.message);
    return rows?.[0];
  }
  const { data: rows, error } = await supabase.from("eb_rates").insert(payload).select();
  if (error) throw new Error(error.message);
  return rows?.[0];
}

export async function deleteEbRate(_id: string) { return deleteDisabledResult(); }

export async function listApartmentsForEB(propertyId: string, billingMonth: string) {
  const [apartments, existingReadings, prevReadings] = await Promise.all([
    safeList(supabase.from("apartments").select("id, apartment_code, eb_meter_number, status, start_date").eq("property_id", propertyId).eq("organization_id", ORG_ID).eq("status", "Live")),
    safeList(supabase.from("electricity_readings").select("*").eq("property_id", propertyId).eq("billing_month", billingMonth).eq("organization_id", ORG_ID)),
    safeList(supabase.from("electricity_readings").select("apartment_id, billing_month, reading_end").eq("property_id", propertyId).eq("organization_id", ORG_ID).order("billing_month", { ascending: false })),
  ]);
  const isLocked = existingReadings.some((r: any) => r.is_locked);
  const rows = apartments.map((apt: any) => {
    const existing = existingReadings.find((r: any) => r.apartment_id === apt.id);
    if (existing) {
      return { id: existing.id, apartment_id: apt.id, apartment_code: apt.apartment_code, eb_meter_number: apt.eb_meter_number || "", previous_reading: parseFloat(existing.reading_start || 0), reading_end: parseFloat(existing.reading_end || 0), meter_photo_url: existing.meter_photo_url || null, is_existing: true };
    }
    const prev = prevReadings.filter((r: any) => r.apartment_id === apt.id && r.billing_month < billingMonth).sort((a: any, b: any) => b.billing_month.localeCompare(a.billing_month))[0];
    return { id: null, apartment_id: apt.id, apartment_code: apt.apartment_code, eb_meter_number: apt.eb_meter_number || "", previous_reading: prev ? parseFloat(prev.reading_end || 0) : 0, reading_end: null, meter_photo_url: null, is_existing: false };
  });
  rows.sort((a: any, b: any) => a.apartment_code.localeCompare(b.apartment_code, undefined, { numeric: true }));
  return { rows, is_locked: isLocked };
}

export async function bulkSaveReadings(data: any) {
  const { propertyId, billingMonth, unitCost, rows } = data;
  const existing = await safeList(supabase.from("electricity_readings").select("id, is_locked").eq("property_id", propertyId).eq("billing_month", billingMonth).eq("organization_id", ORG_ID));
  if (existing.some((r: any) => r.is_locked)) throw new Error("This month's readings are locked and cannot be modified.");
  const validRows = rows.filter((r: any) => r.reading_end !== null && r.reading_end !== "" && !isNaN(parseFloat(String(r.reading_end))));
  if (validRows.length === 0) throw new Error("Enter at least one reading");
  const updates = validRows.filter((r: any) => r.id);
  const inserts = validRows.filter((r: any) => !r.id);
  for (const r of updates) {
    const readingEnd = parseFloat(String(r.reading_end));
    const { error } = await supabase.from("electricity_readings").update({
      reading_start: r.previous_reading, reading_end: readingEnd, units_consumed: readingEnd - r.previous_reading,
      unit_cost: parseFloat(String(unitCost)), meter_photo_url: r.meter_photo_url || null,
    } as any).eq("id", r.id).eq("organization_id", ORG_ID);
    if (error) throw new Error(`Update failed: ${error.message}`);
  }
  if (inserts.length > 0) {
    const insertData = inserts.map((r: any) => {
      const readingEnd = parseFloat(String(r.reading_end));
      return { property_id: propertyId, apartment_id: r.apartment_id, billing_month: billingMonth, reading_start: r.previous_reading, reading_end: readingEnd, units_consumed: readingEnd - r.previous_reading, unit_cost: parseFloat(String(unitCost)), meter_photo_url: r.meter_photo_url || null, organization_id: ORG_ID };
    });
    const { error } = await supabase.from("electricity_readings").insert(insertData as any);
    if (error) throw new Error(`Insert failed: ${error.message}`);
  }
  return { saved: validRows.length };
}

export async function lockReadings(propertyId: string, billingMonth: string, lock: boolean) {
  const { error } = await supabase.from("electricity_readings").update({ is_locked: lock } as any).eq("property_id", propertyId).eq("billing_month", billingMonth).eq("organization_id", ORG_ID);
  if (error) throw new Error(error.message);
  return true;
}

export async function getEBAnalytics(propertyId?: string) {
  const [readings, invoices, apartments, properties] = await Promise.all([
    safeList(supabase.from("electricity_readings").select("billing_month, property_id, apartment_id, units_consumed, unit_cost").eq("organization_id", ORG_ID)),
    safeList(supabase.from("invoices").select("billing_month, property_id, apartment_id, electricity_amount").eq("organization_id", ORG_ID)),
    safeList(supabase.from("apartments").select("id, apartment_code, property_id").eq("organization_id", ORG_ID)),
    safeList(supabase.from("properties").select("id, property_name").eq("organization_id", ORG_ID)),
  ]);
  const propMap: Record<string, string> = {}; properties.forEach((p: any) => { propMap[p.id] = p.property_name; });
  const aptMap: Record<string, any> = {}; apartments.forEach((a: any) => { aptMap[a.id] = a; });
  const monthsList: string[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthsList.push(`${d.toLocaleString("en-US", { month: "short" })}-${String(d.getFullYear()).slice(2)}`);
  }
  const filterProp = (item: any) => !propertyId || propertyId === "all" || item.property_id === propertyId;
  const monthlyData = monthsList.map((month) => {
    const mReadings = readings.filter((r: any) => r.billing_month === month && filterProp(r));
    const mInvoices = invoices.filter((i: any) => i.billing_month === month && filterProp(i));
    const ebPaid = mReadings.reduce((s: number, r: any) => s + Number(r.units_consumed || 0) * Number(r.unit_cost || 0), 0);
    const ebCollected = mInvoices.reduce((s: number, i: any) => s + Number(i.electricity_amount || 0), 0);
    return { month, ebCollected: Math.round(ebCollected), ebPaid: Math.round(ebPaid), variance: Math.round(ebCollected - ebPaid), isProfitable: ebCollected >= ebPaid };
  });
  const aptBreakdownByMonth: Record<string, any[]> = {};
  monthsList.forEach((month) => {
    const mReadings = readings.filter((r: any) => r.billing_month === month && filterProp(r));
    const mInvoices = invoices.filter((i: any) => i.billing_month === month && filterProp(i));
    const aptIds = new Set([...mReadings.map((r: any) => r.apartment_id), ...mInvoices.map((i: any) => i.apartment_id)]);
    const rows: any[] = [];
    aptIds.forEach((aptId: any) => {
      const apt = aptMap[aptId]; if (!apt) return;
      const prop = propMap[apt.property_id] || "—";
      if (propertyId && propertyId !== "all" && apt.property_id !== propertyId) return;
      const aptReadings = mReadings.filter((r: any) => r.apartment_id === aptId);
      const aptInvoices = mInvoices.filter((i: any) => i.apartment_id === aptId);
      const ebActualCost = aptReadings.reduce((s: number, r: any) => s + Number(r.units_consumed || 0) * Number(r.unit_cost || 0), 0);
      const ebCollected = aptInvoices.reduce((s: number, i: any) => s + Number(i.electricity_amount || 0), 0);
      const totalUnits = aptReadings.reduce((s: number, r: any) => s + Number(r.units_consumed || 0), 0);
      const unitCost = aptReadings[0] ? Number(aptReadings[0].unit_cost || 0) : 0;
      if (ebActualCost === 0 && ebCollected === 0) return;
      rows.push({ aptCode: apt.apartment_code, propName: prop, unitsConsumed: Math.round(totalUnits * 10) / 10, unitCost, ebActualCost: Math.round(ebActualCost), ebCollected: Math.round(ebCollected), variance: Math.round(ebCollected - ebActualCost), tenantCount: aptInvoices.length });
    });
    rows.sort((a, b) => b.ebActualCost - a.ebActualCost);
    aptBreakdownByMonth[month] = rows;
  });
  const totalCollected = monthlyData.reduce((s, m) => s + m.ebCollected, 0);
  const totalPaid = monthlyData.reduce((s, m) => s + m.ebPaid, 0);
  const profitableMonths = monthlyData.filter((m) => m.isProfitable && m.ebCollected > 0).length;
  return { monthlyData, aptBreakdownByMonth, totalCollected, totalPaid, totalVariance: totalCollected - totalPaid, profitableMonths, properties: properties.map((p: any) => ({ id: p.id, property_name: p.property_name })) };
}

export async function addReading(args: any) {
  const unitsConsumed = args.readingEnd - args.readingStart;
  if (unitsConsumed < 0) throw new Error("End reading must be greater than start reading");
  const totalCost = unitsConsumed * args.unitCost;
  const reading: any = await insertRow("electricity_readings", {
    property_id: args.propertyId, apartment_id: args.apartmentId, reading_start: args.readingStart,
    reading_end: args.readingEnd, units_consumed: unitsConsumed, unit_cost: args.unitCost,
    total_cost: totalCost, billing_month: args.billingMonth,
  });
  let sharesCreated = 0;
  if (args.apartmentId) {
    const activeTenants = await safeList(
      supabase.from("tenant_allotments").select("tenant_id,bed_id").eq("apartment_id", args.apartmentId).eq("organization_id", ORG_ID).in("staying_status", ["Staying", "On-Notice", "Booked"])
    );
    if (activeTenants.length > 0) {
      const sharePerTenant = Math.round((totalCost / activeTenants.length) * 100) / 100;
      for (const t of activeTenants as any[]) {
        try {
          await insertRow("electricity_shares", { reading_id: reading.id, tenant_id: t.tenant_id, bed_id: t.bed_id, share_amount: sharePerTenant, billing_month: args.billingMonth });
          sharesCreated++;
        } catch (e: any) { console.warn("[electricity] share insert error:", e?.message); }
      }
    }
  }
  return { readingId: reading.id, sharesCreated };
}

export async function listEbPayments() {
  const rows = await safeList(
    supabase.from("eb_payments").select("*, properties(property_name)").eq("organization_id", ORG_ID).order("bill_date", { ascending: false })
  );
  return rows.map((p: any) => ({
    id: p.id, property_id: p.property_id, apartment_id: p.apartment_id || null,
    property_name: p.properties?.property_name || "—", bill_date: p.bill_date, bill_amount: Number(p.bill_amount) || 0,
    payment_date: p.payment_date || null, payment_mode: p.payment_mode || null, reference_number: p.reference_number || null,
    bank_account_id: p.bank_account_id || null, billing_period_start: p.billing_period_start || null,
    billing_period_end: p.billing_period_end || null, notes: p.notes || null,
  }));
}

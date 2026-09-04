"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID, safeList } from "./lib/supabaseAdmin";
import { generateInvoicePreviews, applyEbRounding, type InvoicePreview } from "../lib/billingEngine";

// ─── BILLING / GENERATE BILLS (web parity — see docs/billing-port-contract.md) ──
// The engine (lib/billingEngine.ts) computes previews from org data; generateBills
// builds the exact web save shapes and calls the SAME replace_invoices_atomic RPC.

/** Page past PostgREST's 1000-row cap on a table (ordered by id for stable ranges). */
async function pageAll(q: (from: number, to: number) => any): Promise<any[]> {
  const PAGE = 1000;
  let out: any[] = [];
  let from = 0;
  for (;;) {
    const chunk: any[] = await safeList(q(from, from + PAGE - 1));
    out = out.concat(chunk);
    if (chunk.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function loadBillingInputs(sb: any) {
  const [allotments, readings, bedRates, absence, roomSwitches, invoices, apartments, properties] = await Promise.all([
    pageAll((f, t) => sb.from("tenant_allotments").select("*").eq("organization_id", ORG_ID).order("id", { ascending: true }).range(f, t)),
    pageAll((f, t) => sb.from("electricity_readings").select("*").eq("organization_id", ORG_ID).order("id", { ascending: true }).range(f, t)),
    safeList(sb.from("bed_rates").select("*").eq("organization_id", ORG_ID).order("from_date", { ascending: false })),
    pageAll((f, t) => sb.from("tenant_absence_records").select("tenant_id, allotment_id, from_date, to_date").eq("organization_id", ORG_ID).order("tenant_id", { ascending: true }).range(f, t)),
    pageAll((f, t) => sb.from("room_switches").select("old_allotment_id").eq("organization_id", ORG_ID).order("old_allotment_id", { ascending: true }).range(f, t)),
    pageAll((f, t) => sb.from("invoices").select("id, allotment_id, billing_month, other_charges, is_deleted, property_id, invoice_type").eq("organization_id", ORG_ID).not("is_deleted", "is", true).order("id", { ascending: true }).range(f, t)),
    safeList(sb.from("apartments").select("id, apartment_code").eq("organization_id", ORG_ID)),
    safeList(sb.from("properties").select("id, property_name").eq("organization_id", ORG_ID)),
  ]);

  // Beds: fetch by this org's apartment ids (beds may not carry organization_id).
  const aptIds = [...new Set((apartments as any[]).map((a) => a.id).filter(Boolean))];
  const beds: any[] = [];
  const BC = 150;
  for (let i = 0; i < aptIds.length; i += BC) {
    const rows: any[] = await safeList(
      sb.from("beds").select("id, bed_code, apartment_id, bed_type, toilet_type, status").in("apartment_id", aptIds.slice(i, i + BC)),
    );
    for (const b of rows) beds.push(b);
  }

  // Tenant names.
  const tenantIds = [...new Set((allotments as any[]).map((a) => a.tenant_id).filter(Boolean))] as string[];
  const tenantNames = new Map<string, string>();
  const TC = 200;
  for (let i = 0; i < tenantIds.length; i += TC) {
    const rows: any[] = await safeList(sb.from("tenants").select("id, full_name").eq("organization_id", ORG_ID).in("id", tenantIds.slice(i, i + TC)));
    for (const r of rows) tenantNames.set(r.id, r.full_name || "Unknown");
  }

  return { allotments, readings, beds, bedRates, absence, roomSwitches, invoices, apartments, properties, tenantNames };
}

function computePreviews(inp: any, month: string, propertyId?: string): InvoicePreview[] {
  const raw = generateInvoicePreviews(
    month, inp.allotments, inp.readings, inp.tenantNames, inp.beds, inp.bedRates,
    propertyId || undefined, inp.apartments, inp.absence, inp.roomSwitches, inp.invoices,
  );
  return applyEbRounding(raw);
}

export const previewBills = action({
  args: { month: v.string(), propertyId: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, { month, propertyId }) => {
    const sb = getSupabase();
    const inp = await loadBillingInputs(sb);
    const previews = computePreviews(inp, month, propertyId);
    // Attach staying_status for the preview's status badge (web derives it from allotments).
    const statusByAllot = new Map((inp.allotments as any[]).map((a) => [a.id, a.staying_status]));
    return previews.map((p) => ({ ...p, staying_status: statusByAllot.get(p.allotment_id) || null }));
  },
});

// ── Invoice numbering (contract §4) ──
function getFY(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const s = m >= 4 ? y : y - 1;
  return `${String(s % 100).padStart(2, "0")}-${String((s + 1) % 100).padStart(2, "0")}`;
}
function propAbbr(name: string | undefined): string {
  return String(name || "UNKNO").replace(/\s+/g, "").slice(0, 5).toUpperCase().padEnd(5, "X");
}
function buildInvoiceNumbers(previews: InvoicePreview[], month: string, propertyMap: Map<string, string>, offsets: Map<string, number>): string[] {
  const fy = getFY(month);
  const mm = month.split("-")[1];
  const cnt = new Map<string, number>();
  return previews.map((p) => {
    const a = propAbbr(propertyMap.get(p.property_id));
    const off = offsets.get(p.property_id) || 0;
    const c = (cnt.get(p.property_id) || 0) + 1;
    cnt.set(p.property_id, c);
    return `${a}/${fy}/${mm}/${String(off + c).padStart(5, "0")}`;
  });
}

export const generateBills = action({
  args: { month: v.string(), propertyId: v.optional(v.string()), allotmentIds: v.optional(v.array(v.string())) },
  returns: v.any(),
  handler: async (_ctx, { month, propertyId, allotmentIds }) => {
    const sb = getSupabase();
    const inp = await loadBillingInputs(sb);
    let previews = computePreviews(inp, month, propertyId);
    if (allotmentIds && allotmentIds.length) {
      const set = new Set(allotmentIds);
      previews = previews.filter((p) => set.has(p.allotment_id));
    }
    if (previews.length === 0) return { count: 0, message: "No eligible invoices for this selection." };

    const [y, m] = month.split("-");
    const propertyMap = new Map((inp.properties as any[]).map((p) => [p.id, p.property_name]));

    // Replacement targets: {regular} + unconditional {exit_charge} per preview (contract §3.5).
    const targetsRaw: { allotment_id: string; invoice_type: string }[] = [];
    for (const p of previews) {
      targetsRaw.push({ allotment_id: p.allotment_id, invoice_type: (p as any).is_exit_charge_invoice ? "exit_charge" : "regular" });
      targetsRaw.push({ allotment_id: p.allotment_id, invoice_type: "exit_charge" });
    }
    const uniqueTargets = Array.from(new Map(targetsRaw.map((t) => [`${t.allotment_id}|${t.invoice_type}`, t])).values());
    const targetKeys = new Set(uniqueTargets.map((t) => `${t.allotment_id}|${t.invoice_type}`));

    // Per-property offsets: existing non-deleted invoices for this month NOT being replaced (contract §4).
    const offsets = new Map<string, number>();
    for (const inv of inp.invoices as any[]) {
      if (inv.billing_month !== month) continue;
      const key = `${inv.allotment_id}|${inv.invoice_type || "regular"}`;
      if (targetKeys.has(key)) continue;
      offsets.set(inv.property_id, (offsets.get(inv.property_id) || 0) + 1);
    }
    const numbers = buildInvoiceNumbers(previews, month, propertyMap, offsets);

    const invoiceRows = previews.map((p, idx) => ({
      organization_id: ORG_ID,
      tenant_id: p.tenant_id, property_id: p.property_id, apartment_id: p.apartment_id, bed_id: p.bed_id, allotment_id: p.allotment_id,
      invoice_number: numbers[idx], billing_month: month,
      rent_amount: p.rent_amount, electricity_amount: p.eb_amount, estimated_eb: p.estimated_eb_amount || 0,
      late_fee: p.late_fee, other_charges: (p.exit_charges || 0) + (p.other_charges || 0), total_amount: p.total,
      invoice_date: `${y}-${m}-01`, due_date: `${y}-${m}-07`, status: "pending", balance: p.total, amount_paid: 0,
      invoice_type: (p as any).is_exit_charge_invoice ? "exit_charge" : "regular", is_deleted: false,
    }));

    const lineItems: any[] = [];
    const ebShares: any[] = [];
    previews.forEach((p, idx) => {
      if (p.rent_amount > 0) {
        const dNote = p.discount > 0 ? ` (discount ₹${p.discount})` : "";
        const prNote = p.premium > 0 ? ` (premium ₹${p.premium})` : "";
        lineItems.push({
          invoice_index: idx, line_type: "rent",
          description: `Rent: ${p.stay_days}/${p.total_days_in_month} days @ ₹${Math.round(p.per_day_rent)}/day${dNote}${prNote}`,
          amount: p.rent_amount,
          metadata: { bed_rate: p.bed_rate, discount: p.discount, premium: p.premium, effective_rate: Math.max(0, p.bed_rate - p.discount + p.premium), stay_days: p.stay_days, total_days_in_month: p.total_days_in_month, per_day_rent: p.per_day_rent },
        });
      }
      if (p.eb_amount > 0) {
        lineItems.push({
          invoice_index: idx, line_type: "electricity", description: `EB: ${p.eb_details}`, amount: p.eb_amount,
          metadata: p.eb_breakdown ? { total_units: p.eb_breakdown.total_units, unit_cost: p.eb_breakdown.unit_cost, total_apartment_bill: p.eb_breakdown.total_apartment_bill, total_tenant_days: p.eb_breakdown.total_tenant_days, per_day_rate: p.eb_breakdown.per_day_rate, tenant_stay_days: p.eb_breakdown.tenant_stay_days, tenant_eb_charge: p.eb_breakdown.tenant_eb_charge, all_tenants: p.eb_breakdown.all_tenants || [] } : {},
        });
      }
      if ((p.estimated_eb_amount || 0) > 0) {
        lineItems.push({
          invoice_index: idx, line_type: "estimated_eb",
          description: `Estimated EB (${p.eb_billable_days || p.stay_days} days × prev month per-day rate)`,
          amount: p.estimated_eb_amount, metadata: { stay_days: p.stay_days, per_day_rate: p.eb_breakdown?.per_day_rate || 0 },
        });
      }
      if ((p.exit_charges || 0) > 0) {
        lineItems.push({
          invoice_index: idx, line_type: "exit_charges",
          description: `Exit Charges: ₹${(p.exit_charges || 0).toLocaleString("en-IN")} (Total stay: ${p.total_stay_days || p.stay_days} days, under 365 days)`,
          amount: p.exit_charges, metadata: { total_stay_days: p.total_stay_days || p.stay_days },
        });
      }
      if (p.eb_breakdown) {
        ebShares.push({
          invoice_index: idx, apartment_id: p.eb_breakdown.apartment_id, billing_month: p.eb_breakdown.billing_month,
          total_apartment_bill: p.eb_breakdown.total_apartment_bill, total_tenant_days: p.eb_breakdown.total_tenant_days,
          per_day_rate: p.eb_breakdown.per_day_rate, tenant_stay_days: p.eb_breakdown.tenant_stay_days,
          tenant_eb_charge: p.eb_breakdown.tenant_eb_charge, total_units: p.eb_breakdown.total_units, unit_cost: p.eb_breakdown.unit_cost,
        });
      }
    });

    const allotmentIdsUniq = [...new Set(previews.map((p) => p.allotment_id))];
    const { data, error } = await sb.rpc("replace_invoices_atomic", {
      p_org_id: ORG_ID, p_billing_month: month, p_allotment_ids: allotmentIdsUniq,
      p_invoices: invoiceRows, p_line_items: lineItems, p_eb_shares: ebShares, p_replacement_targets: uniqueTargets,
    });
    if (error) throw new Error(error.message || JSON.stringify(error));
    const result = data as any;
    if (result?.error) throw new Error(result.error);
    return { count: result?.count ?? previews.length, invoiceNumbers: numbers };
  },
});

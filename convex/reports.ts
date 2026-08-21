"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID, safeList } from "./lib/supabaseAdmin";
import { filterLiveBeds, computePropertyStatus, computeAccountingMetrics } from "./metrics";

// ─── PERIOD HELPERS ───────────────────────────────────────────────────────────

type ReportingPeriod =
  | "current_fy"
  | "last_fy"
  | "last_2fy"
  | "last_5y"
  | "from_beginning";

function getFYStartYear(date: Date = new Date()): number {
  return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
}

function getPeriodDateRange(period: ReportingPeriod): { from: Date; to: Date } {
  const today = new Date();
  const fyStartYear = getFYStartYear(today);
  switch (period) {
    case "last_fy":
      return { from: new Date(fyStartYear - 1, 3, 1), to: new Date(fyStartYear, 2, 31) };
    case "last_2fy":
      return { from: new Date(fyStartYear - 2, 3, 1), to: today };
    case "last_5y": {
      const d = new Date(today);
      d.setFullYear(d.getFullYear() - 5);
      return { from: d, to: today };
    }
    case "from_beginning":
      return { from: new Date(2020, 0, 1), to: today };
    case "current_fy":
    default:
      return { from: new Date(fyStartYear, 3, 1), to: today };
  }
}

function fmtMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function isInPeriod(dateStr: string | null | undefined, from: Date, to: Date): boolean {
  if (!dateStr) return false;
  const key = dateStr.slice(0, 7);
  return key >= fmtMonth(from) && key <= fmtMonth(to);
}

function fmtDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

// Map the mobile reporting period → get_universal_metrics_v2 args. Presets the RPC
// knows are passed as-is; ranges it has no preset for (last_2fy/last_5y) are passed
// as an explicit custom window. Mirrors dashboard.ts's rpcPeriodMap.
function buildMetricsRpcArgs(period: ReportingPeriod, from: Date, to: Date): any {
  const presetMap: Record<string, string> = {
    current_fy: "current_fy",
    last_fy: "last_fy",
    from_beginning: "all_time",
  };
  const args: any = { p_organization_id: ORG_ID };
  if (presetMap[period]) {
    args.p_period = presetMap[period];
  } else {
    // last_2fy / last_5y → resolved custom range
    args.p_period = "custom";
    args.p_from = fmtDay(from);
    args.p_to = fmtDay(to);
  }
  return args;
}

const TERMINAL_STATUSES = new Set(["completed", "closed", "cancelled"]);

// ─── LEGACY: kept so existing api.reports.* calls don't break ────────────────

export const getMaintenanceReport = action({
  args: { startDate: v.string(), endDate: v.string() },
  returns: v.any(),
  handler: async (_ctx, { startDate, endDate }) => {
    const sb = getSupabase();
    const tickets = await safeList(
      sb.from("maintenance_tickets").select("*")
        .eq("organization_id", ORG_ID)
        .gte("created_at", startDate).lte("created_at", endDate)
    );
    const totalTickets = tickets.length;
    const resolvedTickets = tickets.filter((t: any) =>
      ["resolved", "completed"].includes((t.status || "").toLowerCase())
    ).length;
    const slaViolations = tickets.filter((t: any) => t.sla_violated === true).length;
    const totalMaintenanceCost = tickets.reduce(
      (sum: number, t: any) => sum + (Number(t.cost) || Number(t.total_cost) || 0), 0
    );
    const statusCounts: Record<string, number> = {};
    tickets.forEach((t: any) => { const s = t.status || "unknown"; statusCounts[s] = (statusCounts[s] || 0) + 1; });
    const byStatus = Object.entries(statusCounts).map(([status, count]) => ({ status, count }));
    const catCounts: Record<string, number> = {};
    tickets.forEach((t: any) => { const c = t.category || t.issue_category || "Uncategorized"; catCounts[c] = (catCounts[c] || 0) + 1; });
    const byCategory = Object.entries(catCounts).map(([name, count]) => ({ name, count }));
    return { summary: { totalTickets, resolvedTickets, slaViolations, totalMaintenanceCost }, byStatus, byCategory };
  },
});

export const getOccupancyReport = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const [properties, apartments, beds] = await Promise.all([
      safeList(sb.from("properties").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("apartments").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("beds").select("*").eq("organization_id", ORG_ID)),
    ]);
    return properties.map((p: any) => {
      const propAptIds = apartments.filter((a: any) => a.property_id === p.id).map((a: any) => a.id);
      const propBeds = beds.filter((b: any) => propAptIds.includes(b.apartment_id));
      const totalBeds = propBeds.length;
      const occupiedBeds = propBeds.filter(
        (b: any) => b.is_occupied === true || (b.bed_lifecycle_status || "").toLowerCase() === "occupied"
      ).length;
      return {
        propertyName: p.property_name || p.name || p.code || "Unknown",
        totalBeds, occupiedBeds,
        occupancyRate: totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0,
      };
    });
  },
});

export const getRevenueReport = action({
  args: { billingMonth: v.string() },
  returns: v.any(),
  handler: async (_ctx, { billingMonth }) => {
    const sb = getSupabase();
    const [invoices, properties] = await Promise.all([
      safeList(sb.from("invoices").select("*").eq("organization_id", ORG_ID).eq("billing_month", billingMonth)),
      safeList(sb.from("properties").select("*").eq("organization_id", ORG_ID)),
    ]);
    const propMap: Record<string, string> = {};
    properties.forEach((p: any) => { propMap[p.id] = p.property_name || p.name || p.code || "Unknown"; });
    const totalRevenue = invoices.reduce((sum: number, inv: any) => sum + (Number(inv.total_amount) || 0), 0);
    const collected = invoices.filter((inv: any) => inv.status === "paid")
      .reduce((sum: number, inv: any) => sum + (Number(inv.total_amount) || 0), 0);
    const pending = invoices.filter((inv: any) => ["sent", "partial", "overdue"].includes(inv.status))
      .reduce((sum: number, inv: any) => sum + (Number(inv.total_amount) || 0), 0);
    const byPropMap: Record<string, { total: number; collected: number }> = {};
    invoices.forEach((inv: any) => {
      const pid = inv.property_id || "unknown";
      if (!byPropMap[pid]) byPropMap[pid] = { total: 0, collected: 0 };
      byPropMap[pid].total += Number(inv.total_amount) || 0;
      if (inv.status === "paid") byPropMap[pid].collected += Number(inv.total_amount) || 0;
    });
    const byProperty = Object.entries(byPropMap).map(([pid, data]) => ({
      propertyName: propMap[pid] || "Unknown", total: data.total, collected: data.collected,
    }));
    return { totalRevenue, collected, pending, byProperty };
  },
});

// ─── NEW: UNIVERSAL KPI SUMMARY ───────────────────────────────────────────────

export const getReportsSummary = action({
  args: { period: v.string() },
  returns: v.any(),
  handler: async (_ctx, { period }) => {
    const sb = getSupabase();
    const { from, to } = getPeriodDateRange((period || "current_fy") as ReportingPeriod);

    const [
      invoices, receipts, expenses, allotments,
      apartments, beds, tickets, settlements, adjustments,
    ] = await Promise.all([
      safeList(sb.from("invoices").select("*").eq("organization_id", ORG_ID).eq("is_deleted", false)),
      safeList(sb.from("receipts").select("*").eq("organization_id", ORG_ID).eq("is_deleted", false)),
      safeList(sb.from("expenses").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("tenant_allotments").select("tenant_id,bed_id,staying_status").eq("organization_id", ORG_ID)),
      safeList(sb.from("apartments").select("id,property_id,status").eq("organization_id", ORG_ID)),
      safeList(sb.from("beds").select("id,apartment_id,status").eq("organization_id", ORG_ID)),
      safeList(sb.from("maintenance_tickets").select("id,status,created_at").eq("organization_id", ORG_ID)),
      safeList(sb.from("deposit_settlements").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("tenant_adjustments").select("*").eq("organization_id", ORG_ID)),
    ]);

    // ── Accounting: authoritative KPIs from the journal-ledger RPC ────────────
    // get_universal_metrics_v2 returns posted-ledger money, so these reconcile 1:1
    // with the web Reports page (never SUM raw invoices/receipts). computeAccounting-
    // Metrics is the sanctioned offline fallback (mirrors dashboard.ts:364-370) used
    // only when the RPC isn't deployed / errors.
    const inRange = (d: string | null | undefined) => isInPeriod(d, from, to);
    let acct: any = {};
    try {
      const { data: rpcData, error: rpcErr } = await sb.rpc(
        "get_universal_metrics_v2",
        buildMetricsRpcArgs((period || "current_fy") as ReportingPeriod, from, to),
      );
      if (rpcErr) throw rpcErr;
      const payload = Array.isArray(rpcData) ? rpcData[0] : rpcData;
      acct = payload?.accounting || {};
    } catch (rpcE: any) {
      console.warn("[reports] get_universal_metrics_v2 failed, using canonical fallback:", rpcE?.message);
    }
    const rpcEmpty = !acct || Object.keys(acct).length === 0;
    const fb = rpcEmpty
      ? computeAccountingMetrics(invoices, receipts, expenses, adjustments, settlements, inRange)
      : null;

    // Rent-only revenue isn't a distinct ledger KPI — derive it from period invoices
    // purely as a display breakdown (same approach dashboard.ts uses for its rent base).
    const pInvoices = invoices.filter((i: any) => inRange(i.billing_month || i.invoice_date));
    const totalRentalRevenue = pInvoices.reduce((s: number, i: any) => s + Number(i.rent_amount || 0), 0);

    const totalInvoiced        = Number(acct.totalRevenue ?? fb?.totalInvoiced ?? 0);
    const totalEbCharged       = Number(
      acct.totalEbCharged ?? pInvoices.reduce((s: number, i: any) => s + Number(i.electricity_amount || 0), 0),
    );
    const totalCollections     = Number(acct.totalCollections ?? fb?.totalCollections ?? 0);
    const depositCollections   = Number(acct.depositCollections ?? fb?.depositCollections ?? 0);
    const totalCollectionsWithoutDeposit = Number(
      acct.totalCollectionsWithoutDeposit ?? fb?.totalCollectionsWithoutDeposit ?? 0,
    );
    const totalRefundsGiven    = Number(acct.totalRefundsGiven ?? fb?.totalRefundsGiven ?? 0);
    const totalPendingCollection = Number(acct.totalPendingCollection ?? fb?.totalPendingCollection ?? 0);
    const totalExpenses        = Number(acct.totalExpenses ?? fb?.totalExpenses ?? 0);
    const totalProfit          = Number(acct.totalProfit ?? fb?.totalProfit ?? 0);

    // Tenants
    const activeIds = new Set<string>(); const bookedIds = new Set<string>(); const allIds = new Set<string>();
    for (const a of allotments) {
      if (!a.tenant_id) continue;
      allIds.add(a.tenant_id);
      if (a.staying_status === "Staying" || a.staying_status === "On-Notice") activeIds.add(a.tenant_id);
      else if (a.staying_status === "Booked") bookedIds.add(a.tenant_id);
    }

    // Occupancy — canonical (live beds + occupied/notice classification, web parity).
    const liveBeds = filterLiveBeds(beds, apartments);
    const ps = computePropertyStatus(liveBeds, allotments);
    const { total, occupied, notice: noticeBeds, booked: bookedBeds, vacant: vacantBeds } = ps;

    // Tickets
    const pTickets = tickets.filter((t: any) => isInPeriod(t.created_at, from, to));
    const ticketClosed = pTickets.filter((t: any) => TERMINAL_STATUSES.has((t.status || "").toLowerCase())).length;

    return {
      period,
      accounting: {
        totalRentalRevenue, totalEbCharged, totalInvoiced,
        totalCollections, totalCollectionsWithoutDeposit, depositCollections,
        totalRefundsGiven, totalPendingCollection, totalExpenses, totalProfit,
      },
      tenants: { totalUniqueTenants: allIds.size, activeTenants: activeIds.size, bookedTenants: bookedIds.size },
      propertyStatus: { total, occupied, vacant: vacantBeds, booked: bookedBeds, notice: noticeBeds, occupancyPct: ps.occupancyPct },
      tickets: { total: pTickets.length, open: pTickets.length - ticketClosed, closed: ticketClosed, needsTenantApproval: pTickets.filter((t: any) => t.status === "pending_tenant_approval").length },
    };
  },
});

// ─── NEW: P&L BY PROPERTY ─────────────────────────────────────────────────────

export const getPropertyPnL = action({
  args: { period: v.string() },
  returns: v.any(),
  handler: async (_ctx, { period }) => {
    const sb = getSupabase();
    const { from, to } = getPeriodDateRange((period || "current_fy") as ReportingPeriod);

    const [properties, apartments, beds, invoices, expenses, allotments] = await Promise.all([
      safeList(sb.from("properties").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("apartments").select("id,property_id,status").eq("organization_id", ORG_ID)),
      safeList(sb.from("beds").select("id,apartment_id,status,bed_lifecycle_status").eq("organization_id", ORG_ID)),
      safeList(sb.from("invoices").select("*").eq("organization_id", ORG_ID).eq("is_deleted", false)),
      safeList(sb.from("expenses").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("tenant_allotments").select("bed_id,staying_status").eq("organization_id", ORG_ID)),
    ]);

    const liveBedsAll = filterLiveBeds(beds, apartments);

    return properties.map((prop: any) => {
      const propAptIds = apartments.filter((a: any) => a.property_id === prop.id).map((a: any) => a.id);
      const propInvoices = invoices.filter((i: any) => i.property_id === prop.id && isInPeriod(i.billing_month || i.invoice_date, from, to));
      const revenue = propInvoices.reduce((s: number, i: any) => s + Number(i.total_amount || 0), 0);
      const rentRevenue = propInvoices.reduce((s: number, i: any) => s + Number(i.rent_amount || 0), 0);
      const ebBilled = propInvoices.reduce((s: number, i: any) => s + Number(i.electricity_amount || 0), 0);
      const propExpenses = expenses.filter((e: any) => e.property_id === prop.id && isInPeriod(e.expense_date || e.billing_month, from, to));
      const totalExpense = propExpenses.reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
      const ebActual = propExpenses.filter((e: any) => (e.cat?.key || e.category) === "eb_actual")
        .reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
      const propAptIdSet = new Set(propAptIds);
      const propLiveBeds = liveBedsAll.filter((b: any) => propAptIdSet.has(b.apartment_id));
      const pps = computePropertyStatus(propLiveBeds, allotments);
      const totalBeds = pps.total;
      const occupiedBeds = pps.occupied + pps.notice; // occupied = staying + on-notice (web parity)
      const profit = revenue - totalExpense;
      return {
        id: prop.id,
        property_name: prop.property_name || prop.name || prop.code || "Unknown",
        revenue, rentRevenue, ebBilled, ebActual, totalExpense, profit,
        totalBeds, occupiedBeds, occupancy: pps.occupancyPct,
        ebVariance: ebBilled - ebActual,
        revPerBed: occupiedBeds > 0 ? Math.round(revenue / occupiedBeds) : 0,
      };
    });
  },
});

// ─── NEW: BED PROFITABILITY ───────────────────────────────────────────────────

export const getBedProfitability = action({
  args: { period: v.string() },
  returns: v.any(),
  handler: async (_ctx, { period }) => {
    const sb = getSupabase();
    const { from, to } = getPeriodDateRange((period || "current_fy") as ReportingPeriod);
    const [beds, apartments, properties, invoices, expenses] = await Promise.all([
      safeList(sb.from("beds").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("apartments").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("properties").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("invoices").select("*").eq("organization_id", ORG_ID).eq("is_deleted", false)),
      safeList(sb.from("expenses").select("*").eq("organization_id", ORG_ID)),
    ]);
    const liveBeds = filterLiveBeds(beds, apartments);
    return liveBeds.map((bed: any) => {
      const apt = apartments.find((a: any) => a.id === bed.apartment_id);
      const prop = apt ? properties.find((p: any) => p.id === apt.property_id) : null;
      const revenue = invoices.filter((i: any) => i.bed_id === bed.id && isInPeriod(i.billing_month || i.invoice_date, from, to))
        .reduce((s: number, i: any) => s + Number(i.total_amount || 0), 0);
      const directCost = expenses.filter((e: any) => e.bed_id === bed.id && isInPeriod(e.expense_date || e.billing_month, from, to))
        .reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
      const propBeds = apt ? liveBeds.filter((b: any) => { const bApt = apartments.find((a: any) => a.id === b.apartment_id); return bApt && bApt.property_id === apt.property_id; }) : [];
      const sharedCost = (prop ? expenses.filter((e: any) => e.property_id === prop.id && !e.apartment_id && !e.bed_id && isInPeriod(e.expense_date || e.billing_month, from, to)).reduce((s: number, e: any) => s + Number(e.amount || 0), 0) : 0) / (propBeds.length || 1);
      const profit = revenue - directCost - sharedCost;
      return {
        bed_code: bed.bed_code || bed.code || "—",
        bed_type: bed.bed_type || "—",
        property_name: prop?.property_name || prop?.name || "—",
        apartment_code: apt?.apartment_code || apt?.code || "—",
        revenue, totalCost: Math.round(directCost + sharedCost), profit: Math.round(profit), isLoss: profit < 0,
      };
    }).sort((a: any, b: any) => b.revenue - a.revenue);
  },
});

// ─── NEW: EB RECONCILIATION ───────────────────────────────────────────────────

export const getEBReconciliation = action({
  args: { period: v.string() },
  returns: v.any(),
  handler: async (_ctx, { period }) => {
    const sb = getSupabase();
    const { from, to } = getPeriodDateRange((period || "current_fy") as ReportingPeriod);
    const [properties, invoices, expenses] = await Promise.all([
      safeList(sb.from("properties").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("invoices").select("*").eq("organization_id", ORG_ID).eq("is_deleted", false)),
      safeList(sb.from("expenses").select("*").eq("organization_id", ORG_ID)),
    ]);
    return properties.map((prop: any) => {
      const propInvoices = invoices.filter((i: any) => i.property_id === prop.id && isInPeriod(i.billing_month || i.invoice_date, from, to));
      const ebBilled = propInvoices.reduce((s: number, i: any) => s + Number(i.electricity_amount || 0), 0);
      const ebActual = expenses.filter((e: any) => e.property_id === prop.id && (e.cat?.key || e.category) === "eb_actual" && isInPeriod(e.expense_date || e.billing_month, from, to))
        .reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
      const variance = ebBilled - ebActual;
      return {
        property_name: prop.property_name || prop.name || prop.code || "Unknown",
        ebBilled, ebActual, variance,
        variancePct: ebActual > 0 ? Math.round((variance / ebActual) * 100) : 0,
      };
    }).filter((r: any) => r.ebBilled > 0 || r.ebActual > 0);
  },
});

// ─── NEW: OCCUPANCY DETAIL ────────────────────────────────────────────────────

export const getOccupancyDetail = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const [properties, apartments, beds, allotments] = await Promise.all([
      safeList(sb.from("properties").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("apartments").select("id,property_id,status").eq("organization_id", ORG_ID)),
      safeList(sb.from("beds").select("id,apartment_id").eq("organization_id", ORG_ID)),
      safeList(sb.from("tenant_allotments").select("bed_id,staying_status,tenant_id").eq("organization_id", ORG_ID)),
    ]);
    const liveBedsAll = filterLiveBeds(beds, apartments);
    return properties.map((prop: any) => {
      const propAptIdSet = new Set(apartments.filter((a: any) => a.property_id === prop.id).map((a: any) => a.id));
      const propLiveBeds = liveBedsAll.filter((b: any) => propAptIdSet.has(b.apartment_id));
      const pps = computePropertyStatus(propLiveBeds, allotments);
      return { propertyName: prop.property_name || prop.name || prop.code || "Unknown", totalBeds: pps.total, occupied: pps.occupied, notice: pps.notice, booked: pps.booked, vacant: pps.vacant, occupancyPct: pps.occupancyPct };
    });
  },
});
// ═══════════════════════════════════════════════════════════════════════════
//  AVAILABILITY — scoped properties + raw data for the bed recommender
//  (client runs the deterministic recommendBeds() algorithm, web parity)
// ═══════════════════════════════════════════════════════════════════════════

// Live properties only (mirrors the web's scopedProperties query, minus the
// per-user maintenance-scope filter which doesn't apply on mobile org-wide view).
export const listScopedProperties = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const props = await safeList(
      sb.from("properties").select("id, property_name, status").eq("organization_id", ORG_ID)
    );
    return props
      .filter((p: any) => !p.status || ["Live", "live"].includes(String(p.status)))
      .map((p: any) => ({ id: p.id, name: p.property_name || "Unnamed" }));
  },
});

// All apartments + beds + allotments + tenants for ONE property — the exact
// raw inputs the web Availability page transforms before scoring.
export const getAvailabilityData = action({
  args: { propertyId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { propertyId }) => {
    const sb = getSupabase();
    const apartments = await safeList(
      sb.from("apartments")
        .select("id, apartment_code, property_id, status, gender_allowed")
        .eq("property_id", propertyId)
        .eq("organization_id", ORG_ID)
    );
    const apartmentIds = apartments.map((a: any) => a.id);
    if (apartmentIds.length === 0) return { apartments: [], beds: [], allotments: [], tenants: [] };

    const [beds, allotments] = await Promise.all([
      safeList(sb.from("beds").select("id, apartment_id, bed_code, bed_type, toilet_type, status").in("apartment_id", apartmentIds)),
      safeList(sb.from("tenant_allotments").select("id, tenant_id, bed_id, apartment_id, staying_status, estimated_exit_date, actual_exit_date").in("apartment_id", apartmentIds)),
    ]);

    const tenantIds = [...new Set(
      allotments
        .filter((al: any) => ["Staying", "On-Notice", "Booked"].includes(al.staying_status))
        .map((al: any) => al.tenant_id)
        .filter(Boolean)
    )];
    const tenants = tenantIds.length
      ? await safeList(sb.from("tenants").select("id, full_name, profession, designation, company_name, state, company_city, city, food_preference").in("id", tenantIds))
      : [];

    return { apartments, beds, allotments, tenants };
  },
});
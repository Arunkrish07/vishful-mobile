"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID, safeList } from "./lib/supabaseAdmin";
import {
  filterLiveBeds,
  classifyBed,
  computePropertyStatus,
  computeAccountingMetrics,
} from "./metrics";

// ─── PERIOD HELPERS (mirror reports.ts / web useUniversalMetrics) ─────────────
type ReportingPeriod = "current_fy" | "last_fy" | "last_2fy" | "last_5y" | "from_beginning";
function getFYStartYear(date: Date = new Date()): number {
  return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
}
function getPeriodDateRange(period: ReportingPeriod): { from: Date; to: Date } {
  const today = new Date();
  const fyStartYear = getFYStartYear(today);
  switch (period) {
    case "last_fy":        return { from: new Date(fyStartYear - 1, 3, 1), to: new Date(fyStartYear, 2, 31) };
    case "last_2fy":       return { from: new Date(fyStartYear - 2, 3, 1), to: today };
    case "last_5y": {      const d = new Date(today); d.setFullYear(d.getFullYear() - 5); return { from: d, to: today }; }
    case "from_beginning": return { from: new Date(2020, 0, 1), to: today };
    case "current_fy":
    default:               return { from: new Date(fyStartYear, 3, 1), to: today };
  }
}
function fmtMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Resolve either a preset string OR a custom {from,to} into a concrete date range.
function resolveRange(period?: string, customFrom?: string, customTo?: string): { from: Date; to: Date } {
  if (period === "custom" && customFrom && customTo) {
    const from = new Date(customFrom + "T00:00:00");
    const to   = new Date(customTo   + "T23:59:59.999");
    if (from.getTime() > to.getTime()) return { from: to, to: from };
    return { from, to };
  }
  return getPeriodDateRange((period || "current_fy") as ReportingPeriod);
}
function isInPeriod(dateStr: string | null | undefined, from: Date, to: Date): boolean {
  if (!dateStr) return false;
  const key = String(dateStr).slice(0, 7);
  return key >= fmtMonthKey(from) && key <= fmtMonthKey(to);
}
const DEPOSIT_TYPES = new Set(["booking", "onboarding"]);

export const getStats = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    try {
      const sb = getSupabase();
      const [properties, tenants, beds, invoices, apartments, allotments] = await Promise.all([
        safeList(sb.from("properties").select("*").eq("organization_id", ORG_ID)),
        safeList(sb.from("tenants").select("*").eq("organization_id", ORG_ID)),
        safeList(sb.from("beds").select("*").eq("organization_id", ORG_ID)),
        safeList(sb.from("invoices").select("*").eq("organization_id", ORG_ID)),
        safeList(sb.from("apartments").select("*").eq("organization_id", ORG_ID)),
        // Source of truth for bed occupancy — allotments with active staying_status
        safeList(sb.from("tenant_allotments").select("bed_id,staying_status").eq("organization_id", ORG_ID)),
      ]);

      // Build a map of bed_id → staying_status from allotments (source of truth)
      // One allotment per bed — use the most recent active one
      const activeBedStatusMap: Record<string, string> = {};
      for (const a of allotments) {
        const bedId = a.bed_id;
        const status = (a.staying_status || "").trim();
        if (!bedId) continue;
        // Active statuses that mean the bed is not free
        if (["Staying", "On-Notice", "Booked"].includes(status)) {
          // Don't overwrite Staying with a lower-priority status
          const existing = activeBedStatusMap[bedId];
          if (!existing || existing !== "Staying") {
            activeBedStatusMap[bedId] = status;
          }
        }
      }

      // LIVE beds = bed.status === 'Live' AND apartment.status === 'Live' (web parity).
      const liveAptIds = new Set(
        apartments
          .filter((a: any) => (a.status || "").toLowerCase() === "live")
          .map((a: any) => a.id)
      );
      const liveApartments = liveAptIds.size;
      const liveBedsList = filterLiveBeds(beds, apartments);

      // Per-bed occupancy via canonical classifier (Staying > On-Notice > Booked).
      const getBedOccupancy = (bedId: string): "occupied" | "notice" | "booked" | "vacant" =>
        classifyBed(bedId, allotments);

      let occupiedBeds = 0, vacantBeds = 0, noticeBeds = 0, bookedBeds = 0;
      for (const b of liveBedsList) {
        const occ = getBedOccupancy(b.id);
        if (occ === "occupied") occupiedBeds++;
        else if (occ === "notice") noticeBeds++;
        else if (occ === "booked") bookedBeds++;
        else vacantBeds++;
      }
      const liveBeds = liveBedsList.length;

      // Lifecycle counts
      const stayingCount  = allotments.filter((a: any) => a.staying_status === "Staying").length;
      const onNoticeCount = allotments.filter((a: any) => a.staying_status === "On-Notice").length;
      const bookedCount   = allotments.filter((a: any) => a.staying_status === "Booked").length;

      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const monthlyRevenue = invoices
        .filter((i: any) => i.billing_month === currentMonth && i.status === "paid")
        .reduce((sum: number, i: any) => sum + (Number(i.total_amount) || 0), 0);
      const pendingPayments = invoices
        .filter((i: any) => ["sent", "partial", "overdue"].includes(i.status))
        .reduce((sum: number, i: any) => sum + (Number(i.total_amount) || 0), 0);
      const electricityPending = invoices
        .filter((i: any) => ["sent", "partial", "overdue"].includes(i.status))
        .reduce((sum: number, i: any) => sum + (Number(i.electricity_amount) || 0), 0);

      // Per-property occupancy — canonical (live beds, occupancy = occupied+notice).
      const occupancyByProperty = properties.map((p: any) => {
        const propAptIds = new Set(
          apartments.filter((a: any) => a.property_id === p.id).map((a: any) => a.id)
        );
        const propLiveBeds = liveBedsList.filter((b: any) => propAptIds.has(b.apartment_id));
        const ps = computePropertyStatus(propLiveBeds, allotments);
        return {
          id: p.id,
          name: p.property_name || p.name || p.code || "Unknown",
          totalBeds: ps.total,
          occupiedBeds: ps.occupied,
          noticeBeds: ps.notice,
          bookedBeds: ps.booked,
          vacantBeds: ps.vacant,
          occupancyRate: ps.occupancyPct,
        };
      });

      return {
        totalProperties: properties.length,
        totalTenants: tenants.length,
        totalBeds: beds.length,
        vacantBeds, occupiedBeds, noticeBeds, bookedBeds,
        liveBeds, liveApartments,
        monthlyRevenue, pendingPayments, electricityPending,
        occupancyByProperty,
        // Lifecycle summary for dashboard card
        lifecycle: { staying: stayingCount, onNotice: onNoticeCount, booked: bookedCount },
      };
    } catch (e: any) {
      console.error("[dashboard.getStats]", e?.message);
      return {
        totalProperties: 0, totalTenants: 0, totalBeds: 0,
        vacantBeds: 0, occupiedBeds: 0, noticeBeds: 0, bookedBeds: 0,
        liveBeds: 0, liveApartments: 0,
        monthlyRevenue: 0, pendingPayments: 0, electricityPending: 0,
        occupancyByProperty: [],
        lifecycle: { staying: 0, onNotice: 0, booked: 0 },
      };
    }
  },
});

// ─── REVENUE VS EXPENSES CHART (last 6 months) ───────────────────────────────
export const getRevenueChart = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    try {
      const sb = getSupabase();
      const months: { key: string; label: string }[] = [];
      const now = new Date();
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const label = d.toLocaleString("en-US", { month: "short" });
        months.push({ key, label });
      }

      const [invoices, readings] = await Promise.all([
        safeList(
          sb.from("invoices")
            .select("billing_month, total_amount, status")
            .eq("organization_id", ORG_ID)
        ),
        safeList(
          sb.from("electricity_readings")
            .select("billing_month, units_consumed, unit_cost")
            .eq("organization_id", ORG_ID)
        ),
      ]);

      return months.map(({ key, label }) => {
        const revenue = invoices
          .filter((i: any) => (i.billing_month || "").startsWith(key) && i.status === "paid")
          .reduce((s: number, i: any) => s + Number(i.total_amount || 0), 0);

        // EB actual cost as a proxy for electricity expense
        const expenses = readings
          .filter((r: any) => (r.billing_month || "").startsWith(key))
          .reduce((s: number, r: any) => s + Number(r.units_consumed || 0) * Number(r.unit_cost || 0), 0);

        return { month: key, label, revenue: Math.round(revenue), expenses: Math.round(expenses) };
      });
    } catch (e: any) {
      console.error("[dashboard.getRevenueChart]", e?.message);
      return [];
    }
  },
});

// ─── EXTENDED DASHBOARD DATA ──────────────────────────────────────────────────
// Mirrors web app AdminDashboard: financials, bed-type occupancy,
// tenant payment KPIs, star customers, needs-attention apartments, announcements.
export const getExtendedStats = action({
  args: { period: v.optional(v.string()), customFrom: v.optional(v.string()), customTo: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, { period, customFrom, customTo }) => {
    try {
      const sb = getSupabase();

      // Period window for financial KPIs (preset or custom — matches web AccountingPeriodSelector)
      const { from: fyFrom, to: fyTo } = resolveRange(period, customFrom, customTo);

      // Enumerate the months of the selected period for the chart series (cap 48, like web)
      const months: { key: string; label: string }[] = [];
      {
        const cur = new Date(fyFrom.getFullYear(), fyFrom.getMonth(), 1);
        const end = new Date(fyTo.getFullYear(), fyTo.getMonth(), 1);
        let guard = 0;
        while (cur.getTime() <= end.getTime() && guard < 48) {
          months.push({
            key: `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`,
            label: cur.toLocaleString("en-IN", { month: "short", year: "2-digit" }),
          });
          cur.setMonth(cur.getMonth() + 1);
          guard++;
        }
        if (months.length === 0) {
          months.push({ key: fmtMonthKey(fyFrom), label: fyFrom.toLocaleString("en-IN", { month: "short", year: "2-digit" }) });
        }
      }

      const [
        invoices,
        receipts,
        expenses,
        beds,
        apartments,
        allotments,
        announcements,
        tenants,
        ebPayments,
        settlements,
        adjustments,
      ] = await Promise.all([
        safeList(
          sb.from("invoices")
            .select("id, tenant_id, billing_month, invoice_date, due_date, total_amount, rent_amount, electricity_amount, balance, status, bed_id, is_deleted")
            .eq("organization_id", ORG_ID)
            .eq("is_deleted", false)
        ),
        safeList(
          sb.from("receipts")
            .select("id, tenant_id, payment_date, amount_paid, receipt_type, is_deleted")
            .eq("organization_id", ORG_ID)
            .eq("is_deleted", false)
        ),
        safeList(
          sb.from("expenses")
            .select("id, expense_date, billing_month, amount")
            .eq("organization_id", ORG_ID)
        ),
        safeList(
          sb.from("beds")
            .select("id, apartment_id, bed_type, status")
            .eq("organization_id", ORG_ID)
        ),
        safeList(
          sb.from("apartments")
            .select("id, apartment_code, property_id, status, properties(property_name)")
            .eq("organization_id", ORG_ID)
        ),
        safeList(
          sb.from("tenant_allotments")
            .select("bed_id, staying_status")
            .eq("organization_id", ORG_ID)
        ),
        safeList(
          sb.from("announcements")
            .select("id, title, content, priority, published_at")
            .eq("organization_id", ORG_ID)
            .eq("is_published", true)
            .order("published_at", { ascending: false })
            .limit(5)
        ),
        safeList(
          sb.from("tenants")
            .select("id, full_name")
            .eq("organization_id", ORG_ID)
        ),
        safeList(
          sb.from("eb_payments")
            .select("id, bill_amount, bill_date")
            .eq("organization_id", ORG_ID)
        ).catch(() => [] as any[]),
        safeList(
          sb.from("deposit_settlements")
            .select("refund_amount, status, settlement_date, created_at")
            .eq("organization_id", ORG_ID)
        ).catch(() => [] as any[]),
        safeList(
          sb.from("tenant_adjustments")
            .select("amount, adjustment_type, billing_month, adjustment_date")
            .eq("organization_id", ORG_ID)
        ).catch(() => [] as any[]),
      ]);

      // ── FINANCIALS: call the SAME journal-ledger RPC the web uses ───────────
      // get_universal_metrics_v2 returns posted-ledger accounting so the numbers
      // match the web dashboard EXACTLY (revenue/collections/pending/profit etc.)
      const monthKey = (s: string | null | undefined) => String(s || "").slice(0, 7);

      // Map mobile period keys → RPC period keys
      const rpcPeriodMap: Record<string, string> = {
        current_fy: "current_fy", last_fy: "last_fy", from_beginning: "all_time",
      };
      let rpcArgs: any = { p_organization_id: ORG_ID };
      if (period === "custom" && customFrom && customTo) {
        rpcArgs.p_period = "custom"; rpcArgs.p_from = customFrom; rpcArgs.p_to = customTo;
      } else if (period && rpcPeriodMap[period]) {
        rpcArgs.p_period = rpcPeriodMap[period];
      } else if (period === "last_2fy" || period === "last_5y") {
        // RPC has no 2fy/5y preset — pass the resolved range as custom
        rpcArgs.p_period = "custom";
        rpcArgs.p_from = fmtMonthKey(fyFrom) + "-01";
        rpcArgs.p_to = `${fyTo.getFullYear()}-${String(fyTo.getMonth() + 1).padStart(2, "0")}-${String(fyTo.getDate()).padStart(2, "0")}`;
      } else {
        rpcArgs.p_period = "current_fy";
      }

      let acct: any = {};
      let rpcPropertyStatus: any = null;
      let rpcTenants: any = null;
      let rpcTickets: any = null;
      try {
        const { data: rpcData, error: rpcErr } = await sb.rpc("get_universal_metrics_v2", rpcArgs);
        if (rpcErr) throw rpcErr;
        const payload = Array.isArray(rpcData) ? rpcData[0] : rpcData;
        acct = payload?.accounting || {};
        rpcPropertyStatus = payload?.propertyStatus || null;
        rpcTenants = payload?.tenants || null;
        rpcTickets = payload?.tickets || null;
      } catch (rpcE: any) {
        console.warn("[dashboard] get_universal_metrics_v2 failed, falling back to raw compute:", rpcE?.message);
      }

      // If the ledger RPC returned nothing (not deployed / errored), fall back to a
      // canonical client-side computation so collections/pending still match the web app.
      const rpcAccountingEmpty = !acct || Object.keys(acct).length === 0;
      const fallbackAcct = rpcAccountingEmpty
        ? computeAccountingMetrics(
            invoices, receipts, expenses, adjustments, settlements,
            (d: any) => isInPeriod(d, fyFrom, fyTo),
          )
        : null;

      // Core financials from the ledger RPC (web parity), with canonical fallback.
      const totalRevenue           = Number(acct.totalRevenue ?? fallbackAcct?.totalInvoiced ?? 0);
      const operationalCollections = Number(acct.totalCollectionsWithoutDeposit ?? fallbackAcct?.totalCollectionsWithoutDeposit ?? 0);
      const pendingAmount          = Number(acct.totalPendingCollection ?? fallbackAcct?.totalPendingCollection ?? 0);
      const totalProfit            = Number(acct.totalProfit ?? fallbackAcct?.totalProfit ?? 0);
      const totalExpenseAmt        = Number(acct.totalExpenses ?? fallbackAcct?.totalExpenses ?? 0);
      const totalCollections       = Number(acct.totalCollections ?? fallbackAcct?.totalCollections ?? 0);
      const depositCollections     = Number(acct.depositCollections ?? fallbackAcct?.depositCollections ?? 0);
      const totalRefundsGiven      = Number(acct.totalRefundsGiven ?? fallbackAcct?.totalRefundsGiven ?? 0);
      const ebBilled               = Number(acct.totalEbCharged ?? 0);

      // ebPaid + revPerBed are computed client-side from raw rows (exactly like web)
      const fyInvoices = invoices.filter((i: any) => isInPeriod(i.billing_month || i.invoice_date, fyFrom, fyTo));
      const fyEbPayments = (ebPayments as any[]).filter((p: any) => isInPeriod(p.bill_date, fyFrom, fyTo));
      const ebPaid    = fyEbPayments.reduce((s: number, p: any) => s + Number(p.bill_amount || 0), 0);
      const ebMargin  = ebBilled - ebPaid;
      const totalRent = fyInvoices.reduce((s: number, i: any) => s + Number(i.rent_amount || 0), 0);
      const uniqueBilledBeds = new Set(fyInvoices.filter((i: any) => i.bed_id).map((i: any) => i.bed_id));
      const revPerBed = uniqueBilledBeds.size > 0 ? Math.round(totalRent / uniqueBilledBeds.size) : 0;

      // ── Monthly chart series (last 6) ───────────────────────────────────────
      const financialSeries = months.map(({ key, label }) => {
        const rev = invoices
          .filter((i: any) => monthKey(i.billing_month || i.invoice_date) === key)
          .reduce((s: number, i: any) => s + Number(i.total_amount || 0), 0);
        const exp = expenses
          .filter((e: any) => monthKey(e.expense_date) === key)
          .reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
        return { label, revenue: Math.round(rev), expenses: Math.round(exp), profit: Math.round(rev - exp) };
      });

      // ── Bed-type occupancy (current) ────────────────────────────────────────
      // LIVE beds = bed.status Live AND apartment.status Live (web parity).
      const liveAptIds = new Set(
        apartments.filter((a: any) => (a.status || "").toLowerCase() === "live").map((a: any) => a.id)
      );
      const liveBedsList = filterLiveBeds(beds, apartments);

      const stayingBedIds = new Set(
        allotments.filter((a: any) => a.staying_status === "Staying").map((a: any) => String(a.bed_id))
      );

      const byType = new Map<string, { total: number; occupied: number }>();
      for (const b of liveBedsList as any[]) {
        const t = String(b.bed_type || "Unknown");
        if (!byType.has(t)) byType.set(t, { total: 0, occupied: 0 });
        byType.get(t)!.total += 1;
        if (stayingBedIds.has(String(b.id))) byType.get(t)!.occupied += 1;
      }
      const bedTypeOccupancy = Array.from(byType.entries())
        .map(([type, v]) => ({
          type,
          pct: v.total > 0 ? Math.round((v.occupied / v.total) * 100) : 0,
          total: v.total,
          occupied: v.occupied,
        }))
        .sort((a, b) => b.pct - a.pct);

      // ── Needs-attention apartments (lowest occupancy) ────────────────────────
      // Occupancy here matches the headline: (occupied + notice) / total live beds.
      const liveBedsByApt = new Map<string, string[]>();
      for (const b of liveBedsList as any[]) {
        const aptId = String(b.apartment_id || "");
        if (!aptId) continue;
        if (!liveBedsByApt.has(aptId)) liveBedsByApt.set(aptId, []);
        liveBedsByApt.get(aptId)!.push(String(b.id));
      }

      const liveApts = apartments.filter((a: any) => liveAptIds.has(a.id));
      const needsAttention = liveApts
        .map((a: any) => {
          const aptBeds = liveBedsByApt.get(String(a.id)) || [];
          const total   = aptBeds.length;
          let occupied = 0, notice = 0;
          for (const id of aptBeds) {
            const c = classifyBed(id, allotments);
            if (c === "occupied") occupied++;
            else if (c === "notice") notice++;
          }
          const pct = total > 0 ? Math.round(((occupied + notice) / total) * 100) : 0;
          return {
            id: a.id,
            code: a.apartment_code || a.id,
            propertyName: (a.properties as any)?.property_name || "—",
            totalBeds: total,
            occupiedBeds: occupied,
            occupancyPct: pct,
          };
        })
        .filter((r) => r.totalBeds > 0)
        .sort((a, b) => a.occupancyPct - b.occupancyPct)
        .slice(0, 8);

      // ── Tenant payment KPIs ─────────────────────────────────────────────────
      const tenantName = new Map(tenants.map((t: any) => [t.id, t.full_name || t.id]));

      // Earliest payment per tenant per month
      const earliestPayByTenantMonth = new Map<string, string>();
      for (const r of receipts as any[]) {
        if (!r.tenant_id || !r.payment_date) continue;
        const k = `${r.tenant_id}:${monthKey(r.payment_date)}`;
        const prev = earliestPayByTenantMonth.get(k);
        if (!prev || String(r.payment_date) < prev) {
          earliestPayByTenantMonth.set(k, String(r.payment_date));
        }
      }

      let paidOnOrBefore7th = 0;
      const paidOnFirstCount  = new Map<string, number>();
      const paidMonthsCount   = new Map<string, number>();

      for (const inv of fyInvoices as any[]) {
        const tId = inv.tenant_id;
        const mKey = monthKey(inv.billing_month || inv.due_date);
        if (!tId || !mKey) continue;
        const pay = earliestPayByTenantMonth.get(`${tId}:${mKey}`);
        if (!pay) continue;
        const day = parseInt(String(pay).slice(8, 10), 10);
        if (day <= 7) paidOnOrBefore7th += 1;
        paidMonthsCount.set(tId, (paidMonthsCount.get(tId) || 0) + 1);
        if (day === 1) paidOnFirstCount.set(tId, (paidOnFirstCount.get(tId) || 0) + 1);
      }

      const starCustomers = Array.from(paidOnFirstCount.entries())
        .map(([tenantId, firstCount]) => ({
          tenantId,
          name: tenantName.get(tenantId) || tenantId,
          firstCount,
          paidMonths: paidMonthsCount.get(tenantId) || 0,
        }))
        .sort((a, b) => b.firstCount - a.firstCount)
        .slice(0, 5);

      return {
        financials: {
          totalRevenue:           Math.round(totalRevenue),
          totalExpenses:          Math.round(totalExpenseAmt),
          totalProfit:            Math.round(totalProfit),
          pendingAmount:          Math.round(pendingAmount),
          operationalCollections: Math.round(operationalCollections),
          ebBilled:               Math.round(ebBilled),
          ebPaid:                 Math.round(ebPaid),
          ebMargin:               Math.round(ebMargin),
          revPerBed,
          totalCollections:       Math.round(totalCollections),
          depositCollections:     Math.round(depositCollections),
          totalRefundsGiven:      Math.round(totalRefundsGiven),
        },
        financialSeries,
        bedTypeOccupancy,
        needsAttention,
        tenantPayments: {
          paidOnOrBefore7th,
          starCustomers,
        },
        announcements: announcements as any[],
        // Ledger-RPC snapshots (web parity) — occupancy & active counts.
        // Fall back to canonical client-side occupancy when the RPC has no propertyStatus.
        propertyStatus: rpcPropertyStatus ?? computePropertyStatus(liveBedsList, allotments),
        rpcTenants,
        rpcTickets,
      };
    } catch (e: any) {
      console.error("[dashboard.getExtendedStats]", e?.message);
      return {
        financials: {
          totalRevenue: 0, totalExpenses: 0, totalProfit: 0,
          pendingAmount: 0, operationalCollections: 0,
          ebBilled: 0, ebPaid: 0, ebMargin: 0, revPerBed: 0,
        },
        financialSeries: [],
        bedTypeOccupancy: [],
        needsAttention: [],
        tenantPayments: { paidOnOrBefore7th: 0, starCustomers: [] },
        announcements: [],
      };
    }
  },
});
/**
 * metrics.ts — canonical occupancy & accounting logic.
 *
 * This MIRRORS the web app's source of truth so mobile numbers match exactly:
 *   - src/lib/reporting-utils.ts  (computePropertyStatus / computeAccountingMetrics)
 *   - supabase migration get_universal_metrics_v2 (occupancy SQL)
 *
 * Rules (do not change without changing the web app too):
 *   • A LIVE bed = bed.status === 'Live' AND its apartment.status === 'Live'.
 *   • Per-bed status priority: Staying > On-Notice > Booked.
 *       - has Staying            -> occupied
 *       - has On-Notice          -> notice   (even if also Booked)
 *       - has Booked only        -> booked
 *       - none                   -> vacant
 *   • occupancyPct = round((occupied + notice) / totalLiveBeds * 100)
 *       Booked beds are NOT counted as occupied.
 *   • Pending dues = totalInvoiced + debitNotes - creditNotes - collectionsWithoutDeposit
 */

export type BedOccupancy = "occupied" | "notice" | "booked" | "vacant";

const ACTIVE_STATUSES = ["Staying", "On-Notice", "Booked"];

/** Lower-cased equality helper that tolerates null/undefined. */
function isLive(status: any): boolean {
  return String(status || "").trim().toLowerCase() === "live";
}

/**
 * Filter to LIVE beds only: bed.status === 'Live' AND apartment.status === 'Live'.
 * Pass the raw beds + apartments arrays (each apartment needs `id` and `status`).
 */
export function filterLiveBeds(beds: any[], apartments: any[]): any[] {
  const liveAptIds = new Set(
    (apartments || []).filter((a: any) => isLive(a.status)).map((a: any) => a.id),
  );
  return (beds || []).filter(
    (b: any) => liveAptIds.has(b.apartment_id) && isLive(b.status),
  );
}

/**
 * Classify a single bed from its active allotments (Staying > On-Notice > Booked).
 * `activeAllotments` may contain all allotments; only the active ones for this bed matter.
 */
export function classifyBed(bedId: string, activeAllotments: any[]): BedOccupancy {
  let hasStaying = false, hasNotice = false, hasBooked = false;
  for (const a of activeAllotments) {
    if (String(a.bed_id) !== String(bedId)) continue;
    const s = a.staying_status;
    if (s === "Staying") hasStaying = true;
    else if (s === "On-Notice") hasNotice = true;
    else if (s === "Booked") hasBooked = true;
  }
  if (hasStaying) return "occupied";
  if (hasNotice) return "notice"; // notice wins over booked (matches SQL priority)
  if (hasBooked) return "booked";
  return "vacant";
}

export interface PropertyStatus {
  total: number;
  occupied: number;
  notice: number;
  booked: number;
  vacant: number;
  occupancyPct: number;
}

/**
 * Bed-level occupancy across a set of live beds.
 * @param liveBeds        beds already filtered to Live (use filterLiveBeds)
 * @param activeAllotments allotments with staying_status in (Staying, On-Notice, Booked)
 */
export function computePropertyStatus(liveBeds: any[], activeAllotments: any[]): PropertyStatus {
  const active = (activeAllotments || []).filter((a: any) =>
    ACTIVE_STATUSES.includes(a.staying_status),
  );
  let occupied = 0, notice = 0, booked = 0;
  for (const bed of liveBeds) {
    switch (classifyBed(bed.id, active)) {
      case "occupied": occupied++; break;
      case "notice":   notice++;   break;
      case "booked":   booked++;   break;
    }
  }
  const total = liveBeds.length;
  const vacant = total - occupied - notice - booked;
  return {
    total,
    occupied,
    notice,
    booked,
    vacant,
    occupancyPct: total > 0 ? Math.round(((occupied + notice) / total) * 100) : 0,
  };
}

// ─── Accounting (collections / pending dues) ──────────────────────────────────

const DEPOSIT_LIKE_RECEIPT_TYPES = new Set(["booking", "onboarding"]);

export function isDepositLikeReceipt(receiptType: string | null | undefined): boolean {
  return DEPOSIT_LIKE_RECEIPT_TYPES.has(String(receiptType || "").toLowerCase());
}

export interface AccountingMetrics {
  totalInvoiced: number;
  totalCollections: number;
  depositCollections: number;
  totalCollectionsWithoutDeposit: number;
  totalRefundsGiven: number;
  totalPendingCollection: number;
  totalExpenses: number;
  totalProfit: number;
}

/**
 * Canonical accounting metrics. `inRange(dateStr)` returns true if a date falls in
 * the selected period (pass a closure built from your period window).
 *
 * Mirrors computeAccountingMetrics in web reporting-utils.ts.
 */
export function computeAccountingMetrics(
  invoices: any[],
  receipts: any[],
  expenses: any[],
  adjustments: any[],
  settlements: any[],
  inRange: (dateStr: string | null | undefined) => boolean,
): AccountingMetrics {
  const pInvoices = (invoices || []).filter((i: any) => inRange(i.billing_month || i.invoice_date));
  const totalInvoiced = pInvoices.reduce((s, i) => s + Number(i.total_amount || 0), 0);

  const pReceipts = (receipts || []).filter((r: any) => inRange(r.payment_date));
  const totalCollections = pReceipts.reduce((s, r) => s + Number(r.amount_paid || 0), 0);
  const depositCollections = pReceipts
    .filter((r: any) => isDepositLikeReceipt(r.receipt_type))
    .reduce((s, r) => s + Number(r.amount_paid || 0), 0);
  const totalCollectionsWithoutDeposit = totalCollections - depositCollections;

  const pSettlements = (settlements || []).filter(
    (s: any) =>
      (s.status === "completed" || s.status === "approved") &&
      inRange(s.settlement_date || s.created_at),
  );
  const totalRefundsGiven = pSettlements.reduce((s, r) => s + Number(r.refund_amount || 0), 0);

  const pAdjustments = (adjustments || []).filter((a: any) => inRange(a.billing_month || a.adjustment_date));
  const adjustDebit = pAdjustments
    .filter((a: any) => a.adjustment_type === "debit_note")
    .reduce((s, a) => s + Number(a.amount || 0), 0);
  const adjustCredit = pAdjustments
    .filter((a: any) => a.adjustment_type === "credit_note")
    .reduce((s, a) => s + Number(a.amount || 0), 0);

  const totalPendingCollection =
    totalInvoiced + adjustDebit - adjustCredit - totalCollectionsWithoutDeposit;

  const pExpenses = (expenses || []).filter((e: any) => inRange(e.expense_date || e.billing_month));
  const totalExpenses = pExpenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const totalProfit = totalInvoiced - totalExpenses;

  return {
    totalInvoiced,
    totalCollections,
    depositCollections,
    totalCollectionsWithoutDeposit,
    totalRefundsGiven,
    totalPendingCollection,
    totalExpenses,
    totalProfit,
  };
}
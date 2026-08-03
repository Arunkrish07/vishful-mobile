/**
 * exitEb.ts — exit-month estimated-EB recompute (mirrors web lib/exit-settlement.ts).
 *
 * Estimate = (prev-month bill ÷ prev-month tenant-days) × days-in-exit-month.
 *   - prev-month bill   = (reading_end − reading_start) × unit_cost  for the apartment
 *   - tenant-days       = Σ days each active allotment occupied the apartment that month
 *   - days-in-exit-month = day-of-month of the actual exit date (exit on the 15th → 15)
 *
 * The per-day rate is derived from the PREVIOUS month's reading (the latest finalised
 * bill) and applied to the exit month's day count.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtMMMyy(d: Date): string {
  return `${MONTHS[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
}
function fmtYYYYMM(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}
function diffDaysInclusive(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

const TENANT_DAY_STATUSES = ["Staying", "On-Notice", "Exited", "Booked"];

/**
 * Total tenant-days the apartment was occupied during the month starting `monthStart`.
 * Mirrors getTotalTenantDaysInMonth in the web TenantLifecycle page.
 */
export function getTotalTenantDaysInMonth(allotments: any[], aptId: string, monthStart: Date): number {
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const aptAllotments = (allotments || []).filter(
    (a: any) =>
      a.apartment_id === aptId &&
      a.onboarding_date &&
      TENANT_DAY_STATUSES.includes(a.staying_status),
  );
  let totalDays = 0;
  for (const a of aptAllotments) {
    const onboard = new Date(a.onboarding_date);
    const exit = a.actual_exit_date ? new Date(a.actual_exit_date) : null;
    const stayStart = onboard > monthStart ? onboard : monthStart;
    const stayEnd = exit && exit < monthEnd ? exit : monthEnd;
    const days = diffDaysInclusive(stayStart, stayEnd);
    if (days > 0) totalDays += days;
  }
  return totalDays || daysInMonth(monthStart);
}

function findPrevMonthReading(readings: any[], aptId: string, exitDate: Date): any | null {
  const prevMonth = new Date(exitDate.getFullYear(), exitDate.getMonth() - 1, 1);
  const s1 = fmtMMMyy(prevMonth);
  const s2 = fmtYYYYMM(prevMonth);
  return (
    (readings || []).find(
      (r: any) => r.apartment_id === aptId && (r.billing_month === s1 || r.billing_month === s2),
    ) || null
  );
}

export interface ExitEbBreakdown {
  perDayRate: number;
  daysInExitMonth: number;
  estimatedAmount: number;
}

/**
 * Recompute the exit-month estimated EB from the ACTUAL exit date.
 * Returns perDayRate 0 (and estimatedAmount 0) when the prior-month reading is missing —
 * callers should then keep any already-invoiced value rather than zeroing it.
 */
export function getExitMonthEbBreakdown(
  aptId: string,
  exitDate: Date,
  readings: any[],
  allotments: any[],
): ExitEbBreakdown {
  const daysInExitMonth = exitDate.getDate();
  const reading = findPrevMonthReading(readings, aptId, exitDate);
  if (!reading) return { perDayRate: 0, daysInExitMonth, estimatedAmount: 0 };

  const totalUnits = Number(reading.reading_end) - Number(reading.reading_start);
  const unitCost = Number(reading.unit_cost);
  const totalBill = totalUnits * unitCost;

  const prevMonth = new Date(exitDate.getFullYear(), exitDate.getMonth() - 1, 1);
  const totalTenantDays = getTotalTenantDaysInMonth(allotments, aptId, prevMonth);
  const perDayRate = totalTenantDays > 0 ? totalBill / totalTenantDays : 0;

  return {
    perDayRate,
    daysInExitMonth,
    estimatedAmount: Math.ceil(perDayRate * daysInExitMonth),
  };
}
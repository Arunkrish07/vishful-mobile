/**
 * Pure payroll math for the 28th–27th pay period. No imports (safe for both
 * the Convex bundle and the RN bundle). Ported verbatim from the web app's
 * lib/team-attendance-salary.ts + computePaySlipAmounts.
 */
export type TeamAttendanceStatus = 'present' | 'absent' | 'late' | 'half_day' | 'leave' | 'weekly_off';

export const DEFAULT_SALARY_WORKING_DAYS = 26;
const PAYROLL_PERIOD_START_DAY = 28;
const PAYROLL_PERIOD_END_DAY = 27;

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function payrollMonthKey(date: Date): string {
  if (date.getDate() >= PAYROLL_PERIOD_START_DAY) return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  const prev = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}`;
}

export function dateToPayrollMonth(dateYmd: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) return null;
  const [y, m, d] = dateYmd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (isNaN(dt.getTime())) return null;
  return payrollMonthKey(dt);
}

export function payrollMonthRange(monthYm: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}$/.test(monthYm)) throw new Error(`Invalid payroll month: ${monthYm}`);
  const [y, m] = monthYm.split('-').map(Number);
  const start = new Date(y, m - 1, PAYROLL_PERIOD_START_DAY);
  const end = new Date(y, m, PAYROLL_PERIOD_END_DAY);
  return { start: ymd(start), end: ymd(end) };
}

export function isDateInPayrollMonth(dateYmd: string, monthYm: string): boolean {
  const { start, end } = payrollMonthRange(monthYm);
  return dateYmd >= start && dateYmd <= end;
}

export function eachDateInPayrollMonth(monthYm: string): string[] {
  const { start, end } = payrollMonthRange(monthYm);
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const endD = new Date(ey, em - 1, ed);
  const out: string[] = [];
  let cur = new Date(sy, sm - 1, sd);
  while (cur <= endD) {
    out.push(ymd(cur));
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }
  return out;
}

export function isSundayDate(dateYmd: string): boolean {
  const [y, m, d] = dateYmd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return !isNaN(dt.getTime()) && dt.getDay() === 0;
}

export function normalizeAttendanceStatus(raw: string | null | undefined): TeamAttendanceStatus | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['present', 'p', 'checked_in', 'check_in', 'in', 'working'].includes(s)) return 'present';
  if (['absent', 'a', 'no_show', 'no_show_up', 'absence'].includes(s)) return 'absent';
  if (['late', 'late_in', 'late_arrival', 'late_mark', 'tardy', 'delayed', 'l_in'].includes(s)) return 'late';
  if (['half_day', 'halfday', 'half', 'hd', 'half_day_present'].includes(s)) return 'half_day';
  if (['weekly_off', 'weeklyoff', 'wo', 'week_off'].includes(s)) return 'weekly_off';
  if (['leave', 'on_leave', 'approved_leave', 'l', 'paid_leave'].includes(s)) return 'leave';
  if (['holiday', 'off'].includes(s)) return 'weekly_off';
  return null;
}

export interface MonthAttendanceSummary {
  month: string;
  presentUnits: number;
  absentDays: number;
  halfDays: number;
  leaveDays: number;
  sundayPaidDays: number;
  recordedDays: number;
  unloggedAbsentDays: number;
}

export function summarizeMonthAttendance(
  records: { date?: string | null; status?: string | null }[],
  monthYm: string,
  today: Date = new Date(),
  joiningDate?: string | null,
  exitDate?: string | null,
): MonthAttendanceSummary {
  const statusByDate = new Map<string, string>();
  let recordedDays = 0;
  for (const r of records) {
    if (!r.date || !isDateInPayrollMonth(r.date, monthYm)) continue;
    recordedDays += 1;
    if (r.status) statusByDate.set(r.date, r.status);
  }
  const todayYmd = ymd(today);
  let presentUnits = 0, absentDays = 0, halfDays = 0, leaveDays = 0, sundayPaidDays = 0, unloggedAbsentDays = 0;
  for (const dateYmd of eachDateInPayrollMonth(monthYm)) {
    const raw = statusByDate.get(dateYmd);
    const norm = raw ? normalizeAttendanceStatus(raw) : null;
    const sunday = isSundayDate(dateYmd);
    if (norm === 'absent') { absentDays += 1; continue; }
    if (norm === 'leave') { leaveDays += 1; continue; }
    if (norm === 'half_day') { halfDays += 1; presentUnits += 1; if (sunday) sundayPaidDays += 1; continue; }
    if (norm === 'present' || norm === 'late' || norm === 'weekly_off') { presentUnits += 1; if (sunday) sundayPaidDays += 1; continue; }
    const beforeJoining = !!joiningDate && dateYmd < joiningDate;
    const afterExit = !!exitDate && dateYmd > exitDate;
    if (beforeJoining || afterExit) continue;
    if (sunday) { presentUnits += 1; sundayPaidDays += 1; continue; }
    if (dateYmd <= todayYmd) { absentDays += 1; unloggedAbsentDays += 1; }
  }
  return {
    month: monthYm,
    presentUnits: Math.round(presentUnits * 100) / 100,
    absentDays, halfDays, leaveDays, sundayPaidDays, recordedDays, unloggedAbsentDays,
  };
}

export function capPresentDays(presentUnits: number, workingDays: number): number {
  const wd = Math.max(workingDays, 1);
  return Math.round(Math.min(Math.max(presentUnits, 0), wd) * 100) / 100;
}

export function computePaySlipAmounts(input: {
  base_salary: number; working_days: number; present_days: number; advance_deducted: number; other_deductions: number;
}): { earned_salary: number; net_payable: number } {
  const base = Number(input.base_salary) || 0;
  const wd = Number(input.working_days) || 0;
  const pd = Number(input.present_days) || 0;
  const adv = Number(input.advance_deducted) || 0;
  const oth = Number(input.other_deductions) || 0;
  const earned = wd > 0 ? Math.round((base * pd) / wd) : 0;
  const net = Math.max(earned - adv - oth, 0);
  return { earned_salary: earned, net_payable: net };
}

export function recentPayrollMonths(n: number, from: Date = new Date()): string[] {
  const cur = payrollMonthKey(from);
  const [y, m] = cur.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(y, m - 1 - i, 1);
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  }
  return out;
}

export function payrollPeriodLabel(monthYm: string): string {
  const { start, end } = payrollMonthRange(monthYm);
  const fmt = (s: string) => {
    const [yy, mm, dd] = s.split('-').map(Number);
    return new Date(yy, mm - 1, dd).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };
  const [ey, em, ed] = end.split('-').map(Number);
  return `${fmt(start)} – ${fmt(end)} ${new Date(ey, em - 1, ed).getFullYear()}`;
}

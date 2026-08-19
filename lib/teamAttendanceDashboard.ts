/**
 * Pure, framework-agnostic aggregation layer for the Team → Attendance dashboard
 * on mobile. Ported from the web `team-attendance-dashboard.ts` /
 * `team-attendance-salary.ts` / `team-work-hours.ts` trio, but:
 *
 *  - NO date-fns / React / React-Native imports (date-fns isn't installed here);
 *    all date math is plain string/Date arithmetic on "YYYY-MM-DD" / "YYYY-MM".
 *  - Uses plain CALENDAR months ("YYYY-MM") rather than the web's 28th–27th
 *    payroll period, because mobile has no payroll-bill concept — the goal here
 *    is attendance visibility, not pay-slip math.
 *  - Reads the exact row shapes the mobile `supabaseService` wrappers already
 *    return: team_members rows (first_name/last_name/status/joining_date/…) and
 *    team_attendance rows (team_member_id/date/status/check_in/check_out).
 *
 * Semantics preserved from web (see per-function notes):
 *  - Status normalization is a superset alias map (present/absent/late/half_day/
 *    leave/weekly_off).
 *  - "present units" = present + late + half_day + weekly_off + auto-paid Sundays.
 *  - An un-logged past weekday (no record, member employed that day) counts as an
 *    absence ("unlogged absent"); Sundays auto-pay; future days are ignored.
 *  - Attendance rate = presentUnits / (presentUnits + absentDays + leaveDays).
 */

// ─── Loose input shapes (mobile data is `any`-ish; read defensively) ───────────
export interface TeamMemberLike {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  status?: string | null;
  department?: string | null;
  salary_amount?: number | string | null;
  joining_date?: string | null;
  exit_date?: string | null;
  /** Optional work-schedule fields — may be absent pre-migration. */
  work_start_time?: string | null;
  work_hours_per_day?: number | string | null;
  [key: string]: unknown;
}

export interface AttendanceRowLike {
  team_member_id?: string | null;
  date?: string | null;
  status?: string | null;
  check_in?: string | null;
  check_out?: string | null;
  [key: string]: unknown;
}

export type NormalizedStatus =
  | "present"
  | "absent"
  | "late"
  | "half_day"
  | "leave"
  | "weekly_off";

export interface MemberMonthSummary {
  memberId: string;
  month: string;
  /** present + late + half_day + weekly_off + auto-paid Sundays. */
  presentUnits: number;
  absentDays: number;
  leaveDays: number;
  halfDays: number;
  lateDays: number;
  /** Sundays paid with no absent/leave mark. */
  sundayPaidDays: number;
  /** Of absentDays, how many came from a day with no record at all. */
  unloggedAbsentDays: number;
  /** presentUnits + absentDays + leaveDays — days that "counted" this month. */
  possibleDays: number;
  /** presentUnits / possibleDays * 100, one decimal. null when possibleDays === 0. */
  ratePct: number | null;
}

export interface MemberDashRow {
  member: TeamMemberLike;
  name: string;
  summary: MemberMonthSummary;
  rate: number | null;
}

export interface OrgRollup {
  presentDays: number;
  lateDays: number;
  leaveDays: number;
  absentDays: number;
  unloggedAbsentDays: number;
  possibleDays: number;
  /** presentDays / possibleDays * 100, one decimal. 0 when possibleDays === 0. */
  ratePct: number;
}

export interface DaySnapshot {
  present: number;
  leave: number;
  absent: number;
  unlogged: number;
  total: number;
}

export interface TeamKpis {
  /** Members employed as of `today` (joined, not exited, not marked inactive). */
  teamSize: number;
  /** Present (incl. late) today per attendance rows. */
  presentToday: number;
  /** Overall attendance rate for the current calendar month (0–100). */
  attendanceRate: number;
}

export interface DayHeat {
  date: string;
  present: number;
  late: number;
  leave: number;
  absent: number;
  unlogged: number;
  isFuture: boolean;
  isSunday: boolean;
}

export interface WorkHoursSummary {
  daysWithTimes: number;
  totalWorkedHours: number;
  expectedHours: number;
  /** expectedHours − totalWorkedHours, SIGNED (negative = overtime). */
  missingHours: number;
  lateDays: number;
  avgLateMinutes: number | null;
  lateCompensated: number;
  autoLoggedOutDays: number;
}

// ─── Small pure helpers ────────────────────────────────────────────────────────
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const YM_RE = /^\d{4}-\d{2}$/;

/** "YYYY-MM-DD" for a Date, in local time (matches how records are entered). */
export function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Calendar month key ("YYYY-MM") for a date or "YYYY-MM-DD" string. */
export function monthKey(input: Date | string = new Date()): string {
  if (typeof input === "string") return input.slice(0, 7);
  return `${input.getFullYear()}-${String(input.getMonth() + 1).padStart(2, "0")}`;
}

/** Every calendar date ("YYYY-MM-DD") in a calendar month, in order. */
export function eachDateInMonth(monthYm: string): string[] {
  if (!YM_RE.test(monthYm)) return [];
  const [y, m] = monthYm.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const out: string[] = [];
  for (let d = 1; d <= daysInMonth; d += 1) {
    out.push(`${monthYm}-${String(d).padStart(2, "0")}`);
  }
  return out;
}

/** List `n` calendar-month keys ending at `endYm`, oldest → newest. */
export function lastMonths(endYm: string, n: number): string[] {
  if (!YM_RE.test(endYm)) return [];
  const [y, m] = endYm.split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(y, m - 1 - i, 1);
    out.push(monthKey(d));
  }
  return out;
}

export function isSunday(dateYmd: string): boolean {
  if (!YMD_RE.test(dateYmd)) return false;
  const [y, m, d] = dateYmd.split("-").map(Number);
  return new Date(y, m - 1, d).getDay() === 0;
}

function isDateInMonth(dateYmd: string | null | undefined, monthYm: string): boolean {
  return !!dateYmd && dateYmd.slice(0, 7) === monthYm;
}

export function memberName(m: TeamMemberLike | null | undefined): string {
  if (!m) return "Team member";
  return `${m.first_name || ""} ${m.last_name || ""}`.trim() || "Team member";
}

/**
 * Superset status normalizer (ported verbatim from the web salary lib). Maps a
 * free-form status string to a canonical bucket, or null if unrecognized/empty.
 */
export function normalizeAttendanceStatus(
  raw: string | null | undefined,
): NormalizedStatus | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["present", "p", "checked_in", "check_in", "in", "working"].includes(s)) return "present";
  if (["absent", "a", "no_show", "no_show_up", "absence"].includes(s)) return "absent";
  if (["late", "late_in", "late_arrival", "late_mark", "tardy", "delayed", "l_in"].includes(s)) return "late";
  if (["half_day", "halfday", "half", "hd", "half_day_present"].includes(s)) return "half_day";
  if (["weekly_off", "weeklyoff", "wo", "week_off"].includes(s)) return "weekly_off";
  if (["leave", "on_leave", "approved_leave", "l", "paid_leave"].includes(s)) return "leave";
  if (["holiday", "off"].includes(s)) return "weekly_off";
  return null;
}

/** Was the member employed on `dateYmd`? Gates unlogged-day → absent fallback. */
function isEmployedOn(member: TeamMemberLike, dateYmd: string): boolean {
  const joining = member.joining_date || null;
  const exit = member.exit_date || null;
  if (joining && dateYmd < joining) return false;
  if (exit && dateYmd > exit) return false;
  return true;
}

// ─── Per-member month summary ──────────────────────────────────────────────────
/**
 * Port of `summarizeMonthAttendance`, over a calendar month. Filters `rows` to
 * this member, then walks every day of the month applying the same rules:
 * explicit statuses are honored; an un-logged past weekday (member employed,
 * not a Sunday, not future) counts as an unlogged absence; Sundays auto-pay.
 */
export function memberMonthSummary(
  member: TeamMemberLike,
  rows: AttendanceRowLike[],
  monthYm: string,
  today: Date = new Date(),
): MemberMonthSummary {
  const statusByDate = new Map<string, string | null | undefined>();
  for (const r of rows) {
    if (r.team_member_id !== member.id) continue;
    if (!isDateInMonth(r.date, monthYm)) continue;
    statusByDate.set(r.date as string, r.status);
  }

  const todayYmd = toYmd(today);

  let presentUnits = 0;
  let absentDays = 0;
  let leaveDays = 0;
  let halfDays = 0;
  let lateDays = 0;
  let sundayPaidDays = 0;
  let unloggedAbsentDays = 0;

  for (const dateYmd of eachDateInMonth(monthYm)) {
    const norm = normalizeAttendanceStatus(statusByDate.get(dateYmd));
    const sunday = isSunday(dateYmd);

    if (norm === "absent") { absentDays += 1; continue; }
    if (norm === "leave") { leaveDays += 1; continue; }
    if (norm === "late") {
      presentUnits += 1; lateDays += 1;
      if (sunday) sundayPaidDays += 1;
      continue;
    }
    if (norm === "half_day") {
      presentUnits += 1; halfDays += 1;
      if (sunday) sundayPaidDays += 1;
      continue;
    }
    if (norm === "present" || norm === "weekly_off") {
      presentUnits += 1;
      if (sunday) sundayPaidDays += 1;
      continue;
    }

    // Unlogged / unrecognized day.
    if (!isEmployedOn(member, dateYmd)) continue;
    if (sunday) { presentUnits += 1; sundayPaidDays += 1; continue; }
    if (dateYmd > todayYmd) continue; // future
    absentDays += 1;
    unloggedAbsentDays += 1;
  }

  const possibleDays = presentUnits + absentDays + leaveDays;
  const ratePct = possibleDays > 0 ? round1((presentUnits / possibleDays) * 100) : null;

  return {
    memberId: member.id,
    month: monthYm,
    presentUnits: round2(presentUnits),
    absentDays,
    leaveDays,
    halfDays,
    lateDays,
    sundayPaidDays,
    unloggedAbsentDays,
    possibleDays: round2(possibleDays),
    ratePct,
  };
}

/** Per-member dashboard rows for a month (name + summary + rate), unsorted. */
export function computeMemberRows(
  members: TeamMemberLike[],
  rows: AttendanceRowLike[],
  monthYm: string = monthKey(),
  today: Date = new Date(),
): MemberDashRow[] {
  return members.map((member) => {
    const summary = memberMonthSummary(member, rows, monthYm, today);
    return { member, name: memberName(member), summary, rate: summary.ratePct };
  });
}

// ─── Org rollup ────────────────────────────────────────────────────────────────
export function orgRollup(
  members: TeamMemberLike[],
  rows: AttendanceRowLike[],
  monthYm: string = monthKey(),
  today: Date = new Date(),
): OrgRollup {
  let presentDays = 0;
  let lateDays = 0;
  let leaveDays = 0;
  let absentDays = 0;
  let unloggedAbsentDays = 0;

  for (const member of members) {
    const s = memberMonthSummary(member, rows, monthYm, today);
    presentDays += s.presentUnits;
    lateDays += s.lateDays;
    leaveDays += s.leaveDays;
    absentDays += s.absentDays;
    unloggedAbsentDays += s.unloggedAbsentDays;
  }

  const possibleDays = presentDays + absentDays + leaveDays;
  const ratePct = possibleDays > 0 ? round1((presentDays / possibleDays) * 100) : 0;

  return {
    presentDays: round2(presentDays),
    lateDays,
    leaveDays: round2(leaveDays),
    absentDays: round2(absentDays),
    unloggedAbsentDays,
    possibleDays: round2(possibleDays),
    ratePct,
  };
}

// ─── Single-day (today) snapshot ───────────────────────────────────────────────
type DayBucket = "present" | "late" | "leave" | "absent" | null;

function bucketForStatus(status: string | null | undefined): DayBucket {
  const norm = normalizeAttendanceStatus(status);
  if (!norm) return null;
  if (norm === "late") return "late";
  if (norm === "leave") return "leave";
  if (norm === "absent") return "absent";
  return "present"; // present, half_day, weekly_off
}

/** Present/leave/absent/unlogged headcount for a single date (default: today). */
export function daySnapshot(
  members: TeamMemberLike[],
  rows: AttendanceRowLike[],
  dateYmd: string,
  today: Date = new Date(),
): DaySnapshot {
  const statusByMember = new Map<string, string | null | undefined>();
  for (const r of rows) {
    if (r.date === dateYmd && r.team_member_id) statusByMember.set(r.team_member_id as string, r.status);
  }

  const todayYmd = toYmd(today);
  const isFuture = dateYmd > todayYmd;
  const sunday = isSunday(dateYmd);

  let present = 0;
  let late = 0;
  let leave = 0;
  let absent = 0;
  let unlogged = 0;

  for (const member of members) {
    const bucket = bucketForStatus(statusByMember.get(member.id));
    if (bucket === "present") { present += 1; continue; }
    if (bucket === "late") { late += 1; continue; }
    if (bucket === "leave") { leave += 1; continue; }
    if (bucket === "absent") { absent += 1; continue; }
    // no row
    if (sunday || isFuture) continue;
    if (!isEmployedOn(member, dateYmd)) continue;
    unlogged += 1;
  }

  const presentTotal = present + late;
  return {
    present: presentTotal,
    leave,
    absent,
    unlogged,
    total: presentTotal + leave + absent + unlogged,
  };
}

// ─── KPI header for the Team list view ─────────────────────────────────────────
/** Team size (employed today), present-today, and current-month attendance rate. */
export function teamKpis(
  members: TeamMemberLike[],
  rows: AttendanceRowLike[],
  today: Date = new Date(),
): TeamKpis {
  const todayYmd = toYmd(today);
  const teamSize = members.filter(
    (m) => isEmployedOn(m, todayYmd) && (m.status || "active") !== "inactive",
  ).length;

  const snap = daySnapshot(members, rows, todayYmd, today);
  const rollup = orgRollup(members, rows, monthKey(today), today);

  return { teamSize, presentToday: snap.present, attendanceRate: rollup.ratePct };
}

// ─── Needs attention (lowest attendance rate) ──────────────────────────────────
/** Lowest-rate members this month (only members with possibleDays > 0). */
export function needsAttention(
  members: TeamMemberLike[],
  rows: AttendanceRowLike[],
  monthYm: string = monthKey(),
  limit = 5,
  today: Date = new Date(),
): MemberDashRow[] {
  return computeMemberRows(members, rows, monthYm, today)
    .filter((r) => r.rate !== null)
    .sort((a, b) => (a.rate as number) - (b.rate as number))
    .slice(0, limit);
}

// ─── Calendar heat (per-day headcount buckets for a month) ─────────────────────
export function calendarHeat(
  members: TeamMemberLike[],
  rows: AttendanceRowLike[],
  monthYm: string = monthKey(),
  today: Date = new Date(),
): DayHeat[] {
  const todayYmd = toYmd(today);
  return eachDateInMonth(monthYm).map((date) => {
    const statusByMember = new Map<string, string | null | undefined>();
    for (const r of rows) {
      if (r.date === date && r.team_member_id) statusByMember.set(r.team_member_id as string, r.status);
    }
    const sunday = isSunday(date);
    const isFuture = date > todayYmd;

    let present = 0;
    let late = 0;
    let leave = 0;
    let absent = 0;
    let unlogged = 0;

    for (const member of members) {
      const bucket = bucketForStatus(statusByMember.get(member.id));
      if (bucket === "present") { present += 1; continue; }
      if (bucket === "late") { late += 1; continue; }
      if (bucket === "leave") { leave += 1; continue; }
      if (bucket === "absent") { absent += 1; continue; }
      if (sunday || isFuture) continue;
      if (!isEmployedOn(member, date)) continue;
      unlogged += 1;
    }

    return { date, present, late, leave, absent, unlogged, isFuture, isSunday: sunday };
  });
}

/** Dominant bucket for a heat cell (for coloring); null when no signal. */
export function heatDominant(day: DayHeat): "present" | "late" | "leave" | "absent" | null {
  const absentTotal = day.absent + day.unlogged;
  const entries: ["present" | "late" | "leave" | "absent", number][] = [
    ["present", day.present],
    ["late", day.late],
    ["leave", day.leave],
    ["absent", absentTotal],
  ];
  const max = Math.max(...entries.map(([, v]) => v));
  if (max <= 0) return null;
  return entries.find(([, v]) => v === max)?.[0] ?? null;
}

// ─── Work-hours analytics (ported from team-work-hours.ts) ──────────────────────
const DEFAULT_GRACE_MINUTES = 10;
const AUTO_LOGOUT_MINUTES = 23 * 60 + 59;

/** Parse "HH:mm" / "HH:mm:ss" / ISO-ish time into minutes since midnight. */
export function parseTimeToMinutes(t: string | null | undefined): number | null {
  if (t == null) return null;
  const s = String(t).trim();
  if (!s) return null;
  const timePart = /[T\s]/.test(s) ? s.split(/[T\s]/)[1] : s;
  if (!timePart) return null;
  const m = timePart.match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function lateMinutes(checkIn: string | null | undefined, workStartMin: number): number | null {
  const inMin = parseTimeToMinutes(checkIn);
  if (inMin == null) return null;
  return Math.max(0, inMin - workStartMin);
}

export function workedHoursForDay(checkIn?: string | null, checkOut?: string | null): number | null {
  const inMin = parseTimeToMinutes(checkIn);
  const outMin = parseTimeToMinutes(checkOut);
  if (inMin == null || outMin == null) return null;
  if (outMin <= inMin) return null;
  return (outMin - inMin) / 60;
}

export function summarizeWorkHours(
  rows: AttendanceRowLike[],
  opts: { workStart: string; hoursPerDay: number; graceMinutes?: number },
): WorkHoursSummary {
  const grace = opts.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const workStartMin = parseTimeToMinutes(opts.workStart) ?? 0;
  const hoursPerDay = opts.hoursPerDay;

  let daysWithTimes = 0;
  let totalWorkedHours = 0;
  let lateDays = 0;
  let lateMinutesSum = 0;
  let lateCompensated = 0;
  let autoLoggedOutDays = 0;

  for (const row of rows) {
    const norm = normalizeAttendanceStatus(row.status);
    if (norm !== "present" && norm !== "late" && norm !== "half_day") continue;

    const worked = workedHoursForDay(row.check_in, row.check_out);
    if (worked != null) {
      daysWithTimes += 1;
      totalWorkedHours += worked;
    }
    if (parseTimeToMinutes(row.check_out) === AUTO_LOGOUT_MINUTES) autoLoggedOutDays += 1;

    const late = lateMinutes(row.check_in, workStartMin);
    if (late != null && late > grace) {
      lateDays += 1;
      lateMinutesSum += late;
      if (worked != null && worked >= hoursPerDay) lateCompensated += 1;
    }
  }

  const expectedHours = daysWithTimes * hoursPerDay;
  const missingHours = expectedHours - totalWorkedHours;
  const avgLateMinutes = lateDays > 0 ? lateMinutesSum / lateDays : null;

  return {
    daysWithTimes,
    totalWorkedHours,
    expectedHours,
    missingHours,
    lateDays,
    avgLateMinutes,
    lateCompensated,
    autoLoggedOutDays,
  };
}

/** Convenience: filter a member's attendance rows to one calendar month. */
export function memberMonthRows(
  memberId: string,
  rows: AttendanceRowLike[],
  monthYm: string,
): AttendanceRowLike[] {
  return rows.filter((r) => r.team_member_id === memberId && isDateInMonth(r.date, monthYm));
}

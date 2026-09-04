# Team Salary Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the mobile app generate/recompute draft monthly salary bills from `team_attendance`, matching the web app's payroll math exactly.

**Architecture:** A pure, dependency-free payroll module in `lib/payroll.ts` (importable by BOTH the Convex action and the React Native screen — it has zero imports, so it is safe for Convex bundling and for the RN bundle). A new service-role Convex action `generateSalaryBills` in `convex/settings.ts` consumes that module to upsert `team_salary_bills`. A batch "Generate drafts" button + payroll-month picker on the Team → Salary tab drives it. (Deviation from the spec, which named the module `convex/teamSalary.ts`: `lib/payroll.ts` is used instead so the UI and the action share one source of truth without the screen importing from `convex/`.)

**Tech Stack:** Expo SDK 54, React Native, TypeScript, Convex actions (service-role → Supabase via `convex/lib/supabaseAdmin`).

**Spec:** `docs/superpowers/specs/2026-09-04-team-salary-generation-design.md`

## As-built amendments (post-execution — the code differs from the task bodies below)

The three tasks were implemented and reviewed as written, then these deltas were applied from review + a product decision. The commits are the source of truth; the task code blocks below are the pre-amendment version.

1. **Org-scoped update** (commit `ceee6c1`, from Task-2 review): the `team_salary_bills` update also `.eq("organization_id", ORG_ID)`.
2. **`approved` bills immutable** (commit `591f444`, product decision — **DIVERGES from web**): the action skips an existing `approved` bill just like `paid` (via a case-insensitive `existingStatus`), returning a new `skippedApproved` count; the Salary-tab Alert shows "N approved (locked)". Revert an approved bill to draft to recompute it.
3. **Case-insensitive paid guard + `skippedEmpty` surfaced** (commit `5f07874`, from final review): paid/approved skip uses `String(status).toLowerCase()`; the Alert surfaces the no-attendance count.
4. **Return shape** is `{ month, created, updated, skippedPaid, skippedApproved, skippedEmpty, failed, membersConsidered }`.
5. **Deployed** to `dev:polished-sockeye-740` on 2026-09-04 (via `npx convex dev --once --typecheck=disable`, orphan `convex/registrationpdf.ts` moved aside for the push). On-device QA still pending.

## Global Constraints

- **No test runner exists** (no jest/eslint in this repo). Per-task type verification = `npx tsc --noEmit` (expect no NEW errors in touched files; ~40 pre-existing errors are known). The pure module is additionally verified by a scratch script run with `npx --yes tsx` (money-critical core).
- **Payroll period:** 28th of prev month → 27th, keyed `"yyyy-MM"`. `payrollMonthRange("2026-08")` = `2026-08-28`…`2026-09-27`.
- **`working_days` default = 26.**
- **`month` stored format = `"yyyy-MM"`.**
- **Pay-slip amounts:** `earned_salary = working_days>0 ? Math.round(base_salary*present_days/working_days) : 0`; `net_payable = max(earned_salary − advance_deducted − other_deductions, 0)`. Write these defensively in addition to the inputs.
- **Never touch `paid` bills. Preserve existing `advance_deducted`/`other_deductions`. Only CREATE a new bill when the member has attendance records in the period.** (See As-built amendment #2: `approved` bills are also skipped entirely, not recomputed.)
- **Eligibility:** members with `status === 'active'` AND `salary_amount > 0`.
- **Out of scope:** external `attendance_logs` sync, auto-recompute on attendance change, salary→Expense sync, department exemption, `free_leave_days`, Excel.
- **Convex codegen/deploy caveat:** `convex/registrationpdf.ts` (untracked, `require('expo-print')`) breaks Convex bundling. tsc does NOT need codegen because wrappers use `(api as any)`. Actually RUNNING the action needs a deploy — temporarily rename `convex/registrationpdf.ts` → `convex/registrationpdf.ts.orphan-bak` before `npx convex deploy --typecheck disable`, then rename back. Deploy is a manual post-implementation step (see Final Verification).
- **Windows/PowerShell environment.** Use forward slashes in code; git-bash also available.
- Commit after each task on branch `sdk-54-expo-go`.

---

### Task 1: Pure payroll module `lib/payroll.ts`

**Files:**
- Create: `lib/payroll.ts`
- Test (scratch, not committed): `<scratchpad>/verify-payroll.ts`

**Interfaces:**
- Consumes: nothing (zero imports).
- Produces:
  - `type TeamAttendanceStatus = 'present'|'absent'|'late'|'half_day'|'leave'|'weekly_off'`
  - `const DEFAULT_SALARY_WORKING_DAYS = 26`
  - `payrollMonthKey(date: Date): string`
  - `dateToPayrollMonth(dateYmd: string): string | null`
  - `payrollMonthRange(monthYm: string): { start: string; end: string }`
  - `isDateInPayrollMonth(dateYmd: string, monthYm: string): boolean`
  - `eachDateInPayrollMonth(monthYm: string): string[]`
  - `isSundayDate(dateYmd: string): boolean`
  - `normalizeAttendanceStatus(raw: string|null|undefined): TeamAttendanceStatus | null`
  - `interface MonthAttendanceSummary { month:string; presentUnits:number; absentDays:number; halfDays:number; leaveDays:number; sundayPaidDays:number; recordedDays:number; unloggedAbsentDays:number }`
  - `summarizeMonthAttendance(records: {date?:string|null;status?:string|null}[], monthYm: string, today?: Date, joiningDate?: string|null, exitDate?: string|null): MonthAttendanceSummary`
  - `capPresentDays(presentUnits: number, workingDays: number): number`
  - `computePaySlipAmounts(input:{base_salary:number;working_days:number;present_days:number;advance_deducted:number;other_deductions:number}): {earned_salary:number;net_payable:number}`
  - `recentPayrollMonths(n: number, from?: Date): string[]`
  - `payrollPeriodLabel(monthYm: string): string`

- [ ] **Step 1: Write the failing verification script**

Create `<scratchpad>/verify-payroll.ts` (replace `<scratchpad>` with the session scratchpad dir):

```ts
import assert from 'node:assert';
import {
  payrollMonthRange, dateToPayrollMonth, eachDateInPayrollMonth, isSundayDate,
  summarizeMonthAttendance, capPresentDays, computePaySlipAmounts, recentPayrollMonths,
} from '../../../<repo>/lib/payroll'; // adjust the relative path to the repo's lib/payroll.ts

// Period boundaries
assert.deepStrictEqual(payrollMonthRange('2026-08'), { start: '2026-08-28', end: '2026-09-27' });
assert.strictEqual(dateToPayrollMonth('2026-08-28'), '2026-08');
assert.strictEqual(dateToPayrollMonth('2026-08-27'), '2026-07');
assert.strictEqual(dateToPayrollMonth('2026-09-27'), '2026-08');
assert.strictEqual(dateToPayrollMonth('bad'), null);

// computePaySlipAmounts
assert.deepStrictEqual(computePaySlipAmounts({ base_salary:26000, working_days:26, present_days:26, advance_deducted:0, other_deductions:0 }), { earned_salary:26000, net_payable:26000 });
assert.deepStrictEqual(computePaySlipAmounts({ base_salary:26000, working_days:26, present_days:13, advance_deducted:1000, other_deductions:500 }), { earned_salary:13000, net_payable:11500 });
assert.strictEqual(computePaySlipAmounts({ base_salary:30000, working_days:26, present_days:20, advance_deducted:0, other_deductions:0 }).earned_salary, Math.round(30000*20/26));
assert.strictEqual(capPresentDays(30, 26), 26);

// Sundays are auto-paid for unlogged days; count them independently.
const dates = eachDateInPayrollMonth('2026-08');
const sundayCount = dates.filter(isSundayDate).length;
const farFuture = new Date(2027, 0, 1);
const sEmpty = summarizeMonthAttendance([], '2026-08', farFuture);
assert.strictEqual(sEmpty.presentUnits, sundayCount, 'empty month → only Sundays paid');
assert.strictEqual(sEmpty.absentDays, dates.length - sundayCount, 'non-Sunday unlogged → absent');
assert.strictEqual(sEmpty.unloggedAbsentDays, sEmpty.absentDays);

// Explicit statuses honoured
const withMarks = summarizeMonthAttendance(
  [ { date:'2026-08-31', status:'present' }, { date:'2026-09-01', status:'absent' }, { date:'2026-09-02', status:'leave' }, { date:'2026-09-03', status:'half_day' } ],
  '2026-08', farFuture);
assert.strictEqual(withMarks.leaveDays, 1);
assert.ok(withMarks.halfDays >= 1);

// Future gating: unlogged future days are NOT absent
const midPeriod = summarizeMonthAttendance([], '2026-08', new Date(2026, 8, 10)); // 2026-09-10
assert.ok(midPeriod.absentDays < sEmpty.absentDays, 'future days not counted absent');

// Joining gating: days before joining are neither present nor absent
const joined = summarizeMonthAttendance([], '2026-08', farFuture, '2026-09-01', null);
assert.ok(joined.absentDays < sEmpty.absentDays, 'pre-joining days excluded');

// recentPayrollMonths
const rec = recentPayrollMonths(3, new Date(2026, 8, 15)); // payroll month 2026-08
assert.deepStrictEqual(rec, ['2026-08','2026-07','2026-06']);

console.log('payroll verify: ALL PASS');
```

- [ ] **Step 2: Run it to verify it fails (module missing)**

Run: `npx --yes tsx "<scratchpad>/verify-payroll.ts"`
Expected: FAIL — cannot find module `lib/payroll` (or type errors), because the file does not exist yet.

- [ ] **Step 3: Implement `lib/payroll.ts`**

Create `lib/payroll.ts`:

```ts
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
```

- [ ] **Step 4: Run the verification script to verify it passes**

Run: `npx --yes tsx "<scratchpad>/verify-payroll.ts"`
Expected: prints `payroll verify: ALL PASS` and exits 0.
(If `tsx` cannot be fetched: `npx --yes tsc lib/payroll.ts --outDir "<scratchpad>/dist" --module commonjs --target es2019` then point the script's import at the compiled `.js` and run with `node`.)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors mentioning `lib/payroll.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/payroll.ts
git commit -m "feat(payroll): pure 28-27 payroll math module (web parity)"
```

---

### Task 2: `generateSalaryBills` Convex action + service wrapper

**Files:**
- Modify: `convex/settings.ts` (add action after `setSalaryBillStatus`, ~:154; update the note at ~:157)
- Modify: `lib/supabaseService.ts` (add wrapper near the other team helpers, ~:494)

**Interfaces:**
- Consumes: `lib/payroll.ts` — `summarizeMonthAttendance`, `capPresentDays`, `computePaySlipAmounts`, `payrollMonthRange`, `DEFAULT_SALARY_WORKING_DAYS`; `convex/lib/supabaseAdmin` — `getSupabase`, `ORG_ID`, `safeList`.
- Produces:
  - Convex action `generateSalaryBills({ month: string, workingDays?: number })` returning `{ month, created, updated, skippedPaid, skippedEmpty, failed, membersConsidered }`.
  - `lib/supabaseService.ts` export `generateSalaryBills(month: string, workingDays?: number): Promise<any>`.

- [ ] **Step 1: Add the import to `convex/settings.ts`**

At the top of `convex/settings.ts`, after the existing imports (after line 7):

```ts
import {
  summarizeMonthAttendance, capPresentDays, computePaySlipAmounts,
  payrollMonthRange, DEFAULT_SALARY_WORKING_DAYS,
} from "../lib/payroll";
```

- [ ] **Step 2: Add the action**

Immediately after the `setSalaryBillStatus` action (after line 154) insert:

```ts
// ─── GENERATE SALARY BILLS (attendance → draft pay-slips, web parity) ─────────
// Recompute/create DRAFT bills for a payroll month ("yyyy-MM", period 28th→27th).
// Never touches `paid` bills; preserves existing deductions and `approved`
// status; only creates a bill when the member has attendance in the period.
export const generateSalaryBills = action({
  args: { month: v.string(), workingDays: v.optional(v.number()) },
  returns: v.any(),
  handler: async (_ctx, { month, workingDays }) => {
    const sb = getSupabase();
    const wd = workingDays ?? DEFAULT_SALARY_WORKING_DAYS;
    const { start, end } = payrollMonthRange(month);

    const [members, attendance] = await Promise.all([
      safeList(
        sb.from("team_members")
          .select("id, salary_amount, joining_date, exit_date, status")
          .eq("organization_id", ORG_ID),
      ),
      safeList(
        sb.from("team_attendance")
          .select("team_member_id, date, status")
          .eq("organization_id", ORG_ID)
          .gte("date", start).lte("date", end),
      ),
    ]);

    const attByMember = new Map<string, { date?: string | null; status?: string | null }[]>();
    for (const a of attendance as any[]) {
      if (!a.team_member_id) continue;
      const list = attByMember.get(a.team_member_id) || [];
      list.push({ date: a.date, status: a.status });
      attByMember.set(a.team_member_id, list);
    }

    let created = 0, updated = 0, skippedPaid = 0, skippedEmpty = 0, failed = 0, membersConsidered = 0;
    const now = new Date();

    for (const m of members as any[]) {
      const base = Number(m.salary_amount) || 0;
      const active = String(m.status || "").toLowerCase() === "active";
      if (!active || base <= 0) continue;
      membersConsidered += 1;
      try {
        const rows = attByMember.get(m.id) || [];
        const summary = summarizeMonthAttendance(rows, month, now, m.joining_date, m.exit_date);

        const existingList = await safeList(
          sb.from("team_salary_bills")
            .select("id, status, advance_deducted, other_deductions")
            .eq("organization_id", ORG_ID).eq("team_member_id", m.id).eq("month", month),
        );
        const existing = (existingList as any[])[0];

        if (existing?.status === "paid") { skippedPaid += 1; continue; }
        if (!existing && summary.recordedDays === 0) { skippedEmpty += 1; continue; }

        const present_days = capPresentDays(summary.presentUnits, wd);
        const advance_deducted = Number(existing?.advance_deducted ?? 0);
        const other_deductions = Number(existing?.other_deductions ?? 0);
        const { earned_salary, net_payable } = computePaySlipAmounts({
          base_salary: base, working_days: wd, present_days, advance_deducted, other_deductions,
        });
        const notes = `Auto from attendance (${summary.recordedDays} days, ${summary.absentDays} absent)`;

        if (existing?.id) {
          const { error } = await sb.from("team_salary_bills")
            .update({ working_days: wd, present_days, base_salary: base, advance_deducted, other_deductions, earned_salary, net_payable, notes })
            .eq("id", existing.id).neq("status", "paid");
          if (error) throw error;
          updated += 1;
        } else {
          const { error } = await sb.from("team_salary_bills")
            .insert({ organization_id: ORG_ID, team_member_id: m.id, month, working_days: wd, present_days, base_salary: base, advance_deducted, other_deductions, earned_salary, net_payable, notes, status: "draft" });
          if (error) throw error;
          created += 1;
        }
      } catch { failed += 1; }
    }

    return { month, created, updated, skippedPaid, skippedEmpty, failed, membersConsidered };
  },
});
```

- [ ] **Step 3: Update the stale note**

In `convex/settings.ts`, change the comment block at ~:156-158 from:

```ts
// ─── TEAM ATTENDANCE ─────────────────────────────────────────────────
// NOTE: web also recomputes draft salary bills on attendance change
// (onTeamAttendanceChanged) — not ported here yet.
```

to:

```ts
// ─── TEAM ATTENDANCE ─────────────────────────────────────────────────
// Draft-bill generation is ported (see generateSalaryBills above); it is
// batch/manual (not auto-triggered on each attendance change like web's
// onTeamAttendanceChanged). The attendance_logs external-app sync and the
// salary→Expense sync remain web-only.
```

- [ ] **Step 4: Add the service wrapper in `lib/supabaseService.ts`**

Near the other team helpers (after `listTeamAttendance`, ~:494), add — matching the existing `(api as any)` cast used by `scanMeterReading`:

```ts
export async function generateSalaryBills(month: string, workingDays?: number) {
  return client.action((api as any).settings.generateSalaryBills, { month, workingDays });
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors in `convex/settings.ts` or `lib/supabaseService.ts`. (`(api as any)` avoids needing codegen.)

- [ ] **Step 6: Commit**

```bash
git add convex/settings.ts lib/supabaseService.ts
git commit -m "feat(team): generateSalaryBills action — draft bills from attendance (web parity)"
```

---

### Task 3: Salary tab — month picker + Generate button

**Files:**
- Modify: `screens/TeamScreen.tsx` (import ~:14; salary state ~:85; salary render block ~:675 and its empty-state ~:679)

**Interfaces:**
- Consumes: `lib/payroll` — `recentPayrollMonths`, `payrollMonthKey`, `payrollPeriodLabel`; `lib/supabaseService` — `generateSalaryBills`.
- Produces: user-visible batch generation on the Salary tab.

- [ ] **Step 1: Add imports**

After the `payslipPdf` import (~:15) add:

```ts
import { recentPayrollMonths, payrollMonthKey, payrollPeriodLabel } from '../lib/payroll';
```

- [ ] **Step 2: Add state**

After `const [orgName, setOrgName] = useState('Vishful Spaces LLP');` (~:86) add:

```ts
  const [salaryMonth, setSalaryMonth] = useState<string>(() => payrollMonthKey(new Date()));
  const [generating, setGenerating] = useState(false);
  const salaryMonthOptions = useMemo(() => recentPayrollMonths(6), []);
```

- [ ] **Step 3: Add the generate handler**

After `handleDownloadPayslip` (the callback added for the payslip feature), add:

```ts
  const handleGenerateSalary = useCallback(async () => {
    setGenerating(true);
    try {
      const r: any = await sb.generateSalaryBills(salaryMonth);
      await loadSalary();
      const parts = [
        `Created ${r?.created ?? 0}`,
        `updated ${r?.updated ?? 0}`,
        (r?.skippedPaid ?? 0) > 0 ? `${r.skippedPaid} already paid` : null,
        (r?.failed ?? 0) > 0 ? `${r.failed} failed` : null,
      ].filter(Boolean).join(', ');
      Alert.alert('Salary drafts', (r?.membersConsidered ?? 0) === 0
        ? 'No active members with a salary set for this period.'
        : `${parts}.`);
    } catch (e: any) {
      Alert.alert('Salary drafts', e?.message || 'Could not generate salary bills. Please try again.');
    } finally {
      if (mounted.current) setGenerating(false);
    }
  }, [salaryMonth, loadSalary]);
```

- [ ] **Step 4: Render the month picker + Generate button**

At the very start of the `activeTab === 'salary'` block, BEFORE the `salaryLoading ? ... : salaryBills.length === 0 ? ...` ternary (i.e. right after the opening `activeTab === 'salary' && (` at ~:675), wrap so a control header always renders. Replace:

```tsx
          {activeTab === 'salary' && (
            salaryLoading ? (
```

with:

```tsx
          {activeTab === 'salary' && (
            <>
            <View style={{ marginBottom: 12 }}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {salaryMonthOptions.map((mo) => {
                    const active = salaryMonth === mo;
                    return (
                      <TouchableOpacity key={mo} onPress={() => setSalaryMonth(mo)}
                        style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99, backgroundColor: active ? '#2563EB' : '#F1F3F9' }}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>{payrollPeriodLabel(mo)}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>
              <TouchableOpacity disabled={generating} onPress={handleGenerateSalary}
                style={{ backgroundColor: '#0F172A', borderRadius: 12, paddingVertical: 11, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8, opacity: generating ? 0.6 : 1 }}>
                {generating ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="sparkles-outline" size={16} color="#fff" />}
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>{generating ? 'Generating…' : 'Generate drafts from attendance'}</Text>
              </TouchableOpacity>
            </View>
            {salaryLoading ? (
```

- [ ] **Step 5: Close the fragment**

The `activeTab === 'salary'` block currently ends (after the `salaryBills.map(...)` and its wrapping ternary) with:

```tsx
              })
            )
          )}
```

Change it to close the added fragment:

```tsx
              })
            )}
            </>
          )}
```

Note: the middle `)` that closed the old `salaryLoading ? (...) : ...` ternary becomes `)}` here because the ternary is now a child of the fragment rather than the direct child of `{activeTab === 'salary' && (...)}`. Verify by reading the block after editing: the structure must be `{activeTab === 'salary' && ( <> <View>…controls…</View> {salaryLoading ? (…) : salaryBills.length === 0 ? (…) : ( salaryBills.map(…) )} </> )}`.

- [ ] **Step 6: Update the empty-state copy**

Change the `EmptyState` subtitle at ~:679 from:

```tsx
              <EmptyState icon="receipt-outline" title="No salary bills" subtitle="Pay slips are generated from attendance on the web app; they appear here to approve and mark paid." />
```

to:

```tsx
              <EmptyState icon="receipt-outline" title="No salary bills" subtitle="Pick a pay period and tap “Generate drafts from attendance” to create pay-slips, then approve and mark paid." />
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors in `screens/TeamScreen.tsx`. If JSX nesting errors appear, re-read the salary block and fix the fragment/ternary balance per Step 5's note.

- [ ] **Step 8: Commit**

```bash
git add screens/TeamScreen.tsx
git commit -m "feat(team): batch-generate salary drafts by pay period on Salary tab"
```

---

## Final Verification (manual — requires a deploy + a build)

Backend actions in this repo run only after a Convex deploy, and there is no emulator QA in this environment. These steps are for whoever has the deploy + device.

- [ ] **Deploy the action.** Because `convex/registrationpdf.ts` (untracked, `require('expo-print')`) breaks Convex bundling: `mv convex/registrationpdf.ts convex/registrationpdf.ts.orphan-bak`, then `npx convex deploy --typecheck disable` (dev deployment `polished-sockeye-740`), then `mv convex/registrationpdf.ts.orphan-bak convex/registrationpdf.ts`.
- [ ] **Idempotency + parity spot-check.** On the Salary tab pick the current pay period → Generate. Note the counts. Re-run: `created` should now be 0 and `updated` equal to the first run's `created+updated` (no duplicates).
- [ ] **Hand-calc one member.** For one member, count their `present`/paid days in the period and verify `present_days` and `net_payable` on the generated bill match `round(base × present_days / 26)` minus any deductions.
- [ ] **Paid-bill safety.** Mark one bill `paid`, re-run Generate, confirm it is untouched (counts show it under `already paid`).
- [ ] **Status strings.** Confirm the org's actual `team_attendance.status` values normalize (present/absent/late/half_day/leave/weekly_off + aliases). Any unrecognized string is treated as unlogged → absent (unless Sunday/future/outside employment) — flag if the org uses a status not in `normalizeAttendanceStatus`.

## Self-Review notes (done by plan author)

- **Spec coverage:** payroll math (Task 1), action with skip-paid/preserve-deductions/no-empty-bills + eligibility (Task 2), batch month-picker UI + empty-state (Task 3), deploy caveat + QA (Final). Out-of-scope items are not built.
- **Type consistency:** function names/params/returns in Task 2/3 interfaces match Task 1's Produces block (`summarizeMonthAttendance`, `capPresentDays`, `computePaySlipAmounts`, `payrollMonthRange`, `recentPayrollMonths`, `payrollMonthKey`, `payrollPeriodLabel`, `DEFAULT_SALARY_WORKING_DAYS`) and the action's return shape matches the UI's usage (`created/updated/skippedPaid/failed/membersConsidered`).
- **Placeholders:** none — all steps carry real code.

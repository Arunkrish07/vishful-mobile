# Team Salary Generation (attendance → draft pay-slips) — Design

**Date:** 2026-09-04
**Branch:** `sdk-54-expo-go`
**Status:** Approved design → implementation plan next
**Audit source:** `docs/AUDIT-mobile-web-parity-v7-2026-08-20.md` (P1 "Team — No salary / pay-slip system"; salary *generation* was the deferred sub-scope).

## Goal

Let the mobile app **generate/recompute draft monthly salary bills from attendance**, matching the web app's payroll math exactly. Today mobile can only *read* bills and advance their status (`listSalaryBills`, `setSalaryBillStatus`) and export a pay-slip PDF; bills are created only on the web. This closes that gap.

## Non-goals (deliberately out of scope — mirrors web's separation)

- **External attendance-app sync** (`attendance_logs`/`employees` → `team_attendance`). Mobile manages `team_attendance` directly (`listTeamAttendance`/`createTeamAttendance`).
- **Auto-recompute on attendance change** (web `onTeamAttendanceChanged`). Generation is manual/button-driven.
- **Salary → Accounting-Expense sync** (`syncTeamSalaryPaymentExpense`). Separate deferred item.
- **Department-based attendance exemption.** Not available in this DB (`team_members` has no `department_id`/`attendance_exempt`; `departments` has no `attendance_exempt`).
- **`free_leave_days`.** The draft-recompute path does not use it on web either (only the V2 display path does).
- **Excel import/export.** No `xlsx` dependency; separately deferred.

## Schema facts (verified against the web app's generated Supabase types)

`team_salary_bills` columns: `organization_id, team_member_id, month, working_days, present_days, base_salary, advance_deducted, other_deductions, earned_salary?, net_payable?, notes, status, created_at`.
- `month` is `"yyyy-MM"` (the payroll month key).
- `earned_salary`/`net_payable` are populated by a **DB trigger** (no app code writes them; existing rows prove the trigger runs). Canonical formula:
  - `earned_salary = working_days > 0 ? round(base_salary × present_days / working_days) : 0`
  - `net_payable = max(earned_salary − advance_deducted − other_deductions, 0)`

`team_members` relevant columns: `id, organization_id, status, salary_amount, joining_date, exit_date, department, first_name, last_name, email`.

## Payroll model (ported verbatim from web `lib/team-attendance-salary.ts`)

- **Payroll period:** 28th of the previous month → 27th, keyed as `"yyyy-MM"`.
  `payrollMonthDateRange("2026-08")` = `2026-08-28` … `2026-09-27`.
  `dateToPayrollMonth(ymd)` = same month if `day ≥ 28`, else previous month.
- **Status normalization:** map raw attendance strings → `present | absent | late | half_day | leave | weekly_off` (same alias table as web).
- **Per-day pay rules:** `present`/`late`/`weekly_off`/`half_day` → 1 pay unit (Sunday among them counts as a paid Sunday); `absent`/`leave` → 0 (counted as off).
- **Unlogged days** (no record / unrecognized status) → **absent**, EXCEPT: the day is a Sunday (auto-paid), the day is in the future relative to `today`, or the day is outside `[joining_date, exit_date]` when set (then it counts as nothing).
- **`present_days`** for the bill = `min(presentUnits, working_days)` (capped), rounded to 2 dp.
- **`working_days`** default = **26** (`DEFAULT_SALARY_WORKING_DAYS`).

Implemented in a new pure module **`lib/payroll.ts`** (as-built; the plan chose `lib/` over `convex/teamSalary.ts` so the UI and the action share one source without the screen importing from `convex/`) with NO `date-fns` (plain `Date` + string y-m-d comparisons, zero-padded formatting to avoid timezone drift). Exposed functions: `payrollMonthKey(date)`, `payrollMonthRange(monthYm)`, `eachDateInPayrollMonth`, `isSundayDate`, `normalizeAttendanceStatus`, `summarizeMonthAttendance`, `capPresentDays`, `computePaySlipAmounts`, `recentPayrollMonths(n)`, `payrollPeriodLabel(monthYm)`.

> **Amendment (2026-09-04, post-review product decision — DIVERGES from web).** Web recomputes any non-`paid` bill on regeneration, including `approved` ones. Per the user's decision, **an `approved` bill is now immutable to regeneration too** — it is skipped like `paid` (see step 3 below). Rationale: `approved` is an amount a reviewer signed off on; a silent re-cost with no re-approval is unacceptable. To recompute an approved bill, revert it to `draft` first (the existing Salary-tab Revert action). This is the one intentional departure from web parity in this feature.

## Backend — new Convex action

`generateSalaryBills({ month, workingDays? })` in `convex/settings.ts` (service-role, `organization_id = ORG_ID`):

1. Load active members: `team_members` where `organization_id = ORG_ID`, `status = 'active'`, `salary_amount` not null/`> 0`.
2. Load `team_attendance` for the period `[start, end]` once (all members), group by `team_member_id`.
3. For each eligible member:
   - `summary = summarizeMonthAttendance(rows, month, now, joining_date, exit_date)`.
   - Look up existing bill (`team_member_id`, `month`). Status comparisons are **case-insensitive** (`String(status).toLowerCase()`) — web-created bills may store `"Paid"`/`"Approved"`.
   - If existing `status === 'paid'` → **skip** (never touch a settled payment).
   - If existing `status === 'approved'` → **skip** (immutable per the amendment above — do not re-cost a signed-off amount).
   - If `summary.recordedDays === 0` and no existing bill → **skip** (don't create empty bills — web parity).
   - `present_days = cap(presentUnits, workingDays)`; preserve existing `advance_deducted`/`other_deductions` (default 0); `{earned_salary, net_payable} = computePaySlipAmounts(...)`.
   - **Upsert:** update the existing `draft` (the only non-locked existing state left here) OR insert a new `draft`. `notes = "Auto from attendance (${recordedDays} days, ${absentDays} absent)"`.
   - Write **only the inputs**. `earned_salary`/`net_payable` are DB-computed (generated columns) — **writing them is rejected by Postgres** (found in on-device QA: every insert/update failed until removed), and web parity never writes them either. The DB computes them as decimals (`base*present/working`).
4. Return `{ month, created, updated, skippedPaid, skippedApproved, skippedEmpty, failed, membersConsidered }`.

`lib/supabaseService.ts`: add `generateSalaryBills(month, workingDays?)` wrapper calling the action.

Existing `listSalaryBills` / `setSalaryBillStatus` are unchanged. The `convex/settings.ts:157` "not ported yet" note is updated.

## Mobile UI — Salary tab (`screens/TeamScreen.tsx`)

- A **payroll-month picker** (horizontal chips, last 6 payroll months, default = current payroll month via `payrollMonthKey(today)`), each labelled by period (`28 Jul – 27 Aug 2026`).
- A **"Generate drafts"** button → calls `sb.generateSalaryBills(selectedMonth)`, shows a busy spinner, then `loadSalary()` and an `Alert` summary (e.g. `"Created 4, updated 2, 1 already paid, 1 approved (locked)."`). Uses the RNW-safe pattern (direct call, not an Alert-button `onPress`).
- The bill list continues to show all bills; the existing per-bill Approve / Mark Paid / Revert / Payslip actions are unchanged.
- Empty-state copy updated: bills can now be generated on mobile.

## Error handling

- Action wraps Supabase errors and returns a structured result; per-member failures are counted, not fatal (one bad member never aborts the batch).
- UI surfaces failures via `Alert`; a zero-eligible run reports "No eligible members / attendance for this period."
- Never mutates `paid` bills; never deletes bills.

## Testing

- **Pure module:** add `convex/teamSalary.test.ts` (if a runner is wired) — otherwise a scratch Node script — asserting: period boundaries (28/27), `dateToPayrollMonth`, Sunday auto-pay, unlogged→absent gating (future / joining / exit), `present_days` cap, `computePaySlipAmounts` rounding, against hand-computed fixtures. This is the money-critical core.
- `npx tsc --noEmit` clean (no new errors in touched files).
- Manual: on a build, pick a month → Generate → verify counts and that a spot-checked member's `present_days`/`net_payable` match a hand calc; confirm a `paid` bill is untouched and a re-run is idempotent.

## Risks

- **No live DB access during development** (Supabase MCP can't see this project) — schema was taken from the web app's generated types, which list `earned_salary`/`net_payable` as writable Insert fields. They are in fact **generated columns**; the planned "defensive write" of them made every insert/update fail. Caught only by on-device QA (2026-09-04) and fixed (commit `4627826`): the action now writes inputs only. Lesson: verify generated/computed columns against the live DB, not the generated types, before writing money-flow code.
- **Attendance status variants** in `team_attendance` are normalized with the same alias table as web; any org-specific status string not in the table is treated as unlogged (→ absent unless gated). QA should confirm the org's status strings are covered.

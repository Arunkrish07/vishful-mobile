/**
 * teamPayroll.ts
 *
 * Team payroll WRITE helpers for the DIRECT-to-Supabase layer (RLS, user JWT).
 * New write features that reach parity with the web app (SOURCE OF TRUTH):
 *   C:/vishful-web-v7/.../src/pages/Team.tsx
 *   C:/vishful-web-v7/.../src/services/teamSalaryExpense.ts
 *   C:/vishful-web-v7/.../src/hooks/useTeamDepartments.ts
 *   C:/vishful-web-v7/.../src/lib/team-attendance-salary.ts
 *
 * All table/column/RPC names are replicated VERBATIM from the web source.
 * Deletes still route through the single DELETES_ENABLED switch.
 */
import { supabase } from './supabase';
import { ORG_ID, DELETES_ENABLED } from './supabaseDb';
import { createTeamPayment, setSalaryBillStatus } from './supabaseService';
import {
  summarizeMonthAttendance,
  eachDateInPayrollMonth,
  payrollMonthKey,
  payrollPeriodLabel,
  type MonthAttendanceSummary,
} from './payroll';

// ── small local helpers ──────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');
function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function teamMemberName(member: any): string {
  if (!member) return 'Team member';
  const full = `${member.first_name || ''} ${member.last_name || ''}`.trim();
  return full || member.name || 'Team member';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEAM SALARY PAYMENT → EXPENSE BRIDGE
// Ported VERBATIM from web src/services/teamSalaryExpense.ts (whole file).
// Expense row lands in Accounting → Expenses:
//   table "expenses" — columns: organization_id, category_id, subcategory_id,
//   issue_type_id, asset_type_id, amount, expense_date, billing_month,
//   description, property_id, apartment_id, bed_id, vendor_id,
//   data_source = 'team_salary', team_payment_id.
//   category resolved via "expense_categories" (key='salaries' / label ~ 'salar'),
//   auto-created with gl_account_id from "coa_accounts" (5600 / name ~ 'salar').
// ═══════════════════════════════════════════════════════════════════════════════

export type TeamPaymentLite = {
  id: string;
  organization_id: string;
  team_member_id: string;
  payment_type: string;
  amount: number;
  payment_date: string | null;
  payment_month: string | null;
  payment_mode?: string | null;
  notes?: string | null;
};

// web teamSalaryExpense.ts L25-48
async function resolveSalariesCategoryId(organizationId: string): Promise<string | null> {
  const { data: byKey } = await supabase
    .from('expense_categories')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('key', 'salaries')
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  if (byKey?.id) return byKey.id as string;

  const { data: byLabel } = await supabase
    .from('expense_categories')
    .select('id')
    .eq('organization_id', organizationId)
    .ilike('label', '%salar%')
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  return (byLabel?.id as string | undefined) ?? null;
}

// web teamSalaryExpense.ts L50-89
async function ensureSalariesExpenseCategoryId(organizationId: string): Promise<string | null> {
  const existing = await resolveSalariesCategoryId(organizationId);
  if (existing) return existing;

  let glAccountId: string | null = null;
  const { data: glRow } = await supabase
    .from('coa_accounts')
    .select('id, account_code, account_name')
    .eq('organization_id', organizationId)
    .or('account_code.eq.5600,account_name.ilike.%salar%')
    .limit(1)
    .maybeSingle();
  if (glRow?.id) glAccountId = glRow.id as string;

  const { data: created, error } = await supabase
    .from('expense_categories')
    .insert({
      organization_id: organizationId,
      key: 'salaries',
      label: 'Salaries',
      is_active: true,
      sort_order: 50,
      gl_account_id: glAccountId,
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505' || String(error.message).toLowerCase().includes('duplicate')) {
      return resolveSalariesCategoryId(organizationId);
    }
    console.warn('[teamPayroll] could not auto-create Salaries category', error);
    return null;
  }
  return (created?.id as string | undefined) ?? null;
}

// web teamSalaryExpense.ts L91-101
export function teamSalaryExpenseSyncWarning(
  syncRes: { skippedReason?: string; action: string },
): string | null {
  if (syncRes.action !== 'noop' || !syncRes.skippedReason || syncRes.skippedReason === 'not_salary') {
    return null;
  }
  if (syncRes.skippedReason === 'salaries_category_unresolved') {
    return 'Payment saved in Team, but Accounting → Expenses was not updated. Add a Salaries category in Settings → Expense categories (or ask an admin).';
  }
  return `Payment saved in Team, but the expense row was not created (${syncRes.skippedReason}).`;
}

// web teamSalaryExpense.ts L103-112
function normalizePaymentMonth(payment: TeamPaymentLite): string | null {
  const raw = payment.payment_month?.trim();
  if (raw && /^\d{4}-\d{2}$/.test(raw)) return raw;
  if (raw && /^\d{4}-\d{1,2}$/.test(raw)) {
    const [y, m] = raw.split('-');
    return `${y}-${m.padStart(2, '0')}`;
  }
  if (payment.payment_date) return payment.payment_date.slice(0, 7);
  return null;
}

// web teamSalaryExpense.ts L114-126
function buildDescription(payment: TeamPaymentLite, memberLabel: string): string {
  const month = normalizePaymentMonth(payment);
  const mode = payment.payment_mode ? ` · ${payment.payment_mode}` : '';
  const note = payment.notes?.trim();
  return [
    `[Team Salary] ${memberLabel}${month ? ` · ${month}` : ''}${mode}`,
    note,
    `team_payment_id:${payment.id}`,
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

// web teamSalaryExpense.ts L128-153
async function findExpenseForPayment(paymentId: string): Promise<{ id: string } | null> {
  const { data: byFk, error: fkErr } = await supabase
    .from('expenses')
    .select('id')
    .eq('team_payment_id', paymentId)
    .maybeSingle();
  if (!fkErr && byFk?.id) return { id: byFk.id as string };

  const missingCol =
    fkErr &&
    (String(fkErr.message ?? '').includes('team_payment_id') || String(fkErr.code ?? '') === '42703');
  if (!missingCol && fkErr) throw fkErr;

  const { data: byDesc } = await supabase
    .from('expenses')
    .select('id')
    .eq('data_source', 'team_salary')
    .ilike('description', `%team_payment_id:${paymentId}%`)
    .limit(1)
    .maybeSingle();
  return byDesc?.id ? { id: byDesc.id as string } : null;
}

// web teamSalaryExpense.ts L155-240
export async function syncTeamSalaryPaymentExpense(args: {
  payment: TeamPaymentLite;
  memberLabel?: string;
}): Promise<{ action: 'inserted' | 'updated' | 'noop'; expenseId?: string; skippedReason?: string }> {
  const { payment, memberLabel } = args;

  if (payment.payment_type !== 'salary') {
    return { action: 'noop', skippedReason: 'not_salary' };
  }

  const amount = Number(payment.amount ?? 0);
  if (!(amount > 0)) {
    return { action: 'noop', skippedReason: 'no_amount' };
  }

  const expenseDate =
    payment.payment_date?.trim() ||
    (normalizePaymentMonth(payment) ? `${normalizePaymentMonth(payment)}-01` : null);
  if (!expenseDate) {
    return { action: 'noop', skippedReason: 'missing_payment_date' };
  }

  const categoryId = await ensureSalariesExpenseCategoryId(payment.organization_id);
  if (!categoryId) {
    return { action: 'noop', skippedReason: 'salaries_category_unresolved' };
  }

  const billingMonth = normalizePaymentMonth(payment) ?? expenseDate.slice(0, 7);
  const label = memberLabel?.trim() || 'Team member';
  const description = buildDescription(payment, label);
  const roundedAmount = Math.round(amount * 100) / 100;

  const basePayload: Record<string, unknown> = {
    organization_id: payment.organization_id,
    category_id: categoryId,
    subcategory_id: null,
    issue_type_id: null,
    asset_type_id: null,
    amount: roundedAmount,
    expense_date: expenseDate,
    billing_month: billingMonth,
    description,
    property_id: null,
    apartment_id: null,
    bed_id: null,
    vendor_id: null,
    data_source: 'team_salary',
    team_payment_id: payment.id,
  };

  const existing = await findExpenseForPayment(payment.id);

  if (existing?.id) {
    const { error } = await supabase.from('expenses').update(basePayload).eq('id', existing.id);
    if (error) throw error;
    return { action: 'updated', expenseId: existing.id };
  }

  const { data: inserted, error } = await supabase
    .from('expenses')
    .insert(basePayload as any)
    .select('id')
    .single();
  if (error) {
    if (String(error.message ?? '').includes('team_payment_id')) {
      const { team_payment_id: _drop, ...withoutFk } = basePayload;
      const { data: fallback, error: err2 } = await supabase
        .from('expenses')
        .insert(withoutFk as any)
        .select('id')
        .single();
      if (err2) throw err2;
      return { action: 'inserted', expenseId: fallback?.id as string | undefined };
    }
    if (String(error.message ?? '').toLowerCase().includes('duplicate') || error.code === '23505') {
      return { action: 'noop', skippedReason: 'duplicate' };
    }
    throw error;
  }

  return { action: 'inserted', expenseId: inserted?.id as string | undefined };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. MARK PAYSLIP PAID  (CONFIRMED MONEY BUG FIX)
// Ported VERBATIM from web Team.tsx markSalaryBillPaid (L1485-1528):
//   insert team_payments (salary) → post Accounting→Expenses line → set bill 'paid'.
// Reuses createTeamPayment + setSalaryBillStatus from supabaseService (no edits there).
// (web auditLog("team_payments", …) call omitted — no audit-log layer on mobile.)
// ═══════════════════════════════════════════════════════════════════════════════
export async function markSalaryBillPaid(
  bill: any,
  member: any,
): Promise<{ syncWarning: string | null }> {
  const today = todayYmd(); // web: format(new Date(), "yyyy-MM-dd")
  const teamMemberId = member?.id || bill?.team_member_id;
  const payPayload = {
    team_member_id: teamMemberId,
    organization_id: ORG_ID,
    payment_type: 'salary' as const,
    amount: Number(bill.net_payable ?? 0),
    payment_date: today,
    payment_month: bill.month,
    notes: `Salary for ${bill.month}`,
    payment_mode: 'bank_transfer',
  };
  // createTeamPayment → insertRow → returns the inserted row (parity with web .select().single()).
  const pay: any = await createTeamPayment(payPayload);
  const syncRes = await syncTeamSalaryPaymentExpense({
    payment: pay as TeamPaymentLite,
    memberLabel: teamMemberName(member),
  });
  const syncWarning = teamSalaryExpenseSyncWarning(syncRes);
  await setSalaryBillStatus(bill.id, 'paid');
  return { syncWarning };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. MANUAL PAYSLIP — generate (upsert) + edit
// Ported from web Team.tsx insertSalaryBill non-quick path (L1391-1415) and
// updateSalaryBill (L1428-1447). earned_salary / net_payable are DB-computed
// (generated columns) — same as web, which never writes them.
// ═══════════════════════════════════════════════════════════════════════════════
export type PaySlipFormInput = {
  team_member_id: string;
  month: string;
  working_days: string;
  present_days: string;
  base_salary: string;
  advance_deducted: string;
  other_deductions: string;
  notes: string;
};

// web insertSalaryBill L1391-1415 (manual branch)
export async function saveManualPaySlip(form: PaySlipFormInput): Promise<{ id: string }> {
  const workingDays = parseInt(form.working_days, 10) || 26;
  const presentDaysVal = parseInt(form.present_days, 10) || 0;
  const baseSalary = parseFloat(form.base_salary) || 0;
  const advance = parseFloat(form.advance_deducted) || 0;
  const otherDed = parseFloat(form.other_deductions) || 0;
  const notes = form.notes?.trim() || null;
  const row = {
    organization_id: ORG_ID,
    team_member_id: form.team_member_id,
    month: form.month,
    working_days: workingDays,
    present_days: presentDaysVal,
    base_salary: baseSalary,
    advance_deducted: advance,
    other_deductions: otherDed,
    notes,
    status: 'draft',
  };
  const { data, error } = await supabase
    .from('team_salary_bills')
    .upsert(row, { onConflict: 'organization_id,team_member_id,month' })
    .select('id')
    .single();
  if (error) throw error;
  return data as { id: string };
}

// web updateSalaryBill L1428-1447
export async function updateSalaryBillFields(billId: string, form: PaySlipFormInput): Promise<void> {
  const workingDays = parseInt(form.working_days, 10) || 26;
  const presentDaysVal = parseInt(form.present_days, 10) || 0;
  const baseSalary = parseFloat(form.base_salary) || 0;
  const advance = parseFloat(form.advance_deducted) || 0;
  const otherDed = parseFloat(form.other_deductions) || 0;
  const { error } = await supabase
    .from('team_salary_bills')
    .update({
      working_days: workingDays,
      present_days: presentDaysVal,
      base_salary: baseSalary,
      advance_deducted: advance,
      other_deductions: otherDed,
      notes: form.notes?.trim() || null,
    })
    .eq('id', billId)
    .eq('organization_id', ORG_ID); // extra org scope vs web (RLS-safe superset)
  if (error) throw error;
}

// web deleteSalaryBill L1460-1471 — gated by the single DELETES_ENABLED switch.
export async function deleteSalaryBill(billId: string): Promise<boolean> {
  if (!DELETES_ENABLED) throw new Error('Deleting is currently disabled.');
  const { error } = await supabase
    .from('team_salary_bills')
    .delete()
    .eq('id', billId)
    .eq('organization_id', ORG_ID);
  if (error) throw error;
  return true;
}

// Live preview of earned / net for the payslip form (web Team.tsx L1626-1629).
export function previewPaySlipAmounts(form: {
  working_days: string;
  present_days: string;
  base_salary: string;
  advance_deducted: string;
  other_deductions: string;
}): { earned: number; net: number } {
  const earned =
    ((parseFloat(form.base_salary) || 0) / Math.max(parseInt(form.working_days, 10) || 26, 1)) *
    (parseInt(form.present_days, 10) || 0);
  const net =
    earned - (parseFloat(form.advance_deducted) || 0) - (parseFloat(form.other_deductions) || 0);
  return { earned, net };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. DEPARTMENT ATTENDANCE-EXEMPT TOGGLE
// Ported from web useTeamDepartments.useSetDepartmentExempt (L83-99):
//   team_departments.attendance_exempt = <bool>.
// ═══════════════════════════════════════════════════════════════════════════════
export async function setDepartmentExempt(id: string, attendanceExempt: boolean): Promise<void> {
  const { error } = await supabase
    .from('team_departments')
    .update({ attendance_exempt: attendanceExempt })
    .eq('id', id)
    .eq('organization_id', ORG_ID); // extra org scope vs web (RLS-safe superset)
  if (error) throw error;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. CURRENT PAY-PERIOD SALARY BREAKDOWN CARD
// Ported from web Team.tsx currentAttendanceSalary (L682-743) + computePayrollSalaryV2
// (team-attendance-salary.ts L265-297). Estimated from attendance (no bill/sync
// fallback on mobile — the attendance panel has no bill context).
// ═══════════════════════════════════════════════════════════════════════════════
function computePayrollSalaryV2(
  baseSalary: number,
  daysInPeriod: number,
  summary: MonthAttendanceSummary,
  freeLeaveDays = 0,
): {
  perDayRate: number;
  daysInPeriod: number;
  presentDays: number;
  offDays: number;
  freeLeaveDays: number;
  deductibleDays: number;
  deductionAmount: number;
  payableSalary: number;
} {
  const days = Math.max(daysInPeriod, 1);
  const perDayRate = Math.round((Number(baseSalary) / days) * 100) / 100;
  const offDays = summary.absentDays + summary.leaveDays;
  const free = Math.max(0, freeLeaveDays);
  const deductibleDays = Math.max(0, offDays - free);
  const deductionAmount = Math.round(perDayRate * deductibleDays * 100) / 100;
  const payableSalary = Math.max(0, Math.round((Number(baseSalary) - deductionAmount) * 100) / 100);
  return { perDayRate, daysInPeriod: days, presentDays: summary.presentUnits, offDays, freeLeaveDays: free, deductibleDays, deductionAmount, payableSalary };
}

export type CurrentPeriodBreakdown = {
  month: string;
  periodLabel: string;
  baseSalary: number;
  perDayRate: number;
  earned: number;
  net: number;
  presentDays: number;
  daysInPeriod: number;
  summary: MonthAttendanceSummary;
};

export function computeCurrentPeriodBreakdown(member: any, attendance: any[]): CurrentPeriodBreakdown | null {
  if (!member?.id) return null;
  const month = payrollMonthKey(new Date());
  const memberRows = (attendance || []).filter((a: any) => a.team_member_id === member.id);
  const summary = summarizeMonthAttendance(
    memberRows,
    month,
    new Date(),
    member.joining_date,
    member.exit_date,
  );
  const baseSalary = Number(member.salary_amount ?? 0);
  const daysInPeriod = eachDateInPayrollMonth(month).length;
  const freeLeaveDays = Number(member.free_leave_days ?? 0);
  const v2 = computePayrollSalaryV2(baseSalary, daysInPeriod, summary, freeLeaveDays);
  return {
    month,
    periodLabel: payrollPeriodLabel(month),
    baseSalary,
    perDayRate: v2.perDayRate,
    earned: v2.payableSalary,
    net: v2.payableSalary,
    presentDays: v2.presentDays,
    daysInPeriod: v2.daysInPeriod,
    summary,
  };
}

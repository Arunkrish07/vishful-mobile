// ============================================================
// Accounting WRITE features — DIRECT-to-Supabase (user JWT / RLS).
//
// Verbatim ports of the web Accounting tabs' write paths
// (C:/vishful-web-v7/.../src/components/accounting/*), so the
// mobile app reaches write-parity with the web source of truth.
//
// Tables / columns / RPCs / sign-conventions mirror the web
// EXACTLY. Money math (rounding, deduction sums, refund split,
// EB/exit-charge ceil) is copied line-for-line.
//
// Data layer: all helpers come from ./supabaseDb (same `supabase`
// client the rest of the migrated app uses). Read wrappers are
// reused from ./supabaseService; this module is WRITE-only + the
// small reference loaders the forms need.
//
// DELETES: every delete routes through DELETES_ENABLED. While it
// is false, delete-shaped operations return deleteDisabledResult()
// or throw "Deleting is currently disabled." — nothing bypasses it.
// ============================================================
import { supabase } from './supabase';
import {
  ORG_ID,
  safeList,
  safeFetch,
  insertRow,
  updateRow,
  deleteRow,
  DELETES_ENABLED,
  deleteDisabledResult,
  fetchAllPages,
  toISODate,
} from './supabaseDb';
import { recordPayment } from './supabaseService';

// ── small shared helpers ──────────────────────────────────────────────

/** Logged-in user's id (for locked_by / created_by / audit rows). Null-safe. */
async function currentUserId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getUser();
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Indian FY label "YY-YY" from a "yyyy-MM" month (document-number-utils.ts:11-17). */
function getFY(billingMonth: string): string {
  const [y, m] = billingMonth.split('-').map(Number);
  const fyStart = m >= 4 ? y : y - 1;
  const fyEnd = fyStart + 1;
  return `${String(fyStart).slice(-2)}-${String(fyEnd).slice(-2)}`;
}

/** Property abbreviation — first 5 chars, upper, padded (document-number-utils.ts:22-24). */
function getPropertyAbbr(propertyName: string): string {
  return (propertyName || '').replace(/\s+/g, '').slice(0, 5).toUpperCase().padEnd(5, 'X');
}

const today = () => new Date().toISOString().slice(0, 10);

// Invoice field → line_type (InvoicesTab.tsx:72-83 FIELD_TO_LINE_TYPE equivalent).
const FIELD_TO_LINE_TYPE: Record<string, string> = {
  rent_amount: 'rent',
  electricity_amount: 'electricity',
  estimated_eb: 'estimated_eb',
  late_fee: 'late_fee',
  other_charges: 'other_charges',
};

// ═══════════════════════════════════════════════════════════════════════════
// REFERENCE DATA for the forms (raw rows; org-scoped server-side under RLS)
// ═══════════════════════════════════════════════════════════════════════════

/** Dropdown data for the Expense add/edit form (ExpensesTab props). */
export async function loadExpenseFormRefs(): Promise<{
  properties: any[]; apartments: any[]; beds: any[]; vendors: any[]; categories: any[];
}> {
  const [properties, apartments, beds, vendors, categories] = await Promise.all([
    safeList(supabase.from('properties').select('id, property_name, status').eq('organization_id', ORG_ID)),
    safeList(supabase.from('apartments').select('id, apartment_code, property_id, status').eq('organization_id', ORG_ID)),
    safeList(supabase.from('beds').select('id, bed_code, bed_type, apartment_id, status').eq('organization_id', ORG_ID)),
    safeList(supabase.from('vendors').select('id, vendor_name, contact_person').eq('organization_id', ORG_ID).order('vendor_name', { ascending: true })),
    safeList(supabase.from('expense_categories').select('id, key, label, is_active, sort_order').eq('organization_id', ORG_ID).order('sort_order', { ascending: true })),
  ]);
  return { properties, apartments, beds, vendors, categories: (categories as any[]).filter((c) => c.is_active !== false) };
}

/**
 * Active tenants for the Adjustment form — allotments in Staying/On-Notice,
 * enriched with tenant name + apt/bed codes (TenantAdjustmentsTab.tsx:115-125).
 */
export async function loadAdjustmentActiveTenants(): Promise<any[]> {
  const allots: any[] = await safeList(
    supabase.from('tenant_allotments')
      .select('id, tenant_id, property_id, apartment_id, bed_id, staying_status')
      .eq('organization_id', ORG_ID)
      .in('staying_status', ['Staying', 'On-Notice']),
  );
  const tenantIds = [...new Set(allots.map((a) => a.tenant_id).filter(Boolean))];
  const aptIds = [...new Set(allots.map((a) => a.apartment_id).filter(Boolean))];
  const bedIds = [...new Set(allots.map((a) => a.bed_id).filter(Boolean))];
  const [tenants, apts, beds] = await Promise.all([
    tenantIds.length ? safeList(supabase.from('tenants').select('id, full_name').eq('organization_id', ORG_ID).in('id', tenantIds)) : Promise.resolve([]),
    aptIds.length ? safeList(supabase.from('apartments').select('id, apartment_code').eq('organization_id', ORG_ID).in('id', aptIds)) : Promise.resolve([]),
    bedIds.length ? safeList(supabase.from('beds').select('id, bed_code').in('id', bedIds)) : Promise.resolve([]),
  ]);
  const tN = new Map<string, string>(); for (const t of tenants as any[]) tN.set(t.id, t.full_name);
  const aC = new Map<string, string>(); for (const a of apts as any[]) aC.set(a.id, a.apartment_code);
  const bC = new Map<string, string>(); for (const b of beds as any[]) bC.set(b.id, b.bed_code);
  return allots
    .map((a) => ({
      tenant_id: a.tenant_id, allotment_id: a.id,
      full_name: tN.get(a.tenant_id) || 'Unknown',
      apartment_code: aC.get(a.apartment_id) || '', bed_code: bC.get(a.bed_id) || '',
      property_id: a.property_id, apartment_id: a.apartment_id, bed_id: a.bed_id,
    }))
    .sort((x, y) => x.full_name.localeCompare(y.full_name));
}

/**
 * Exited allotments for the Settlement form + org bank accounts
 * (SettlementsTab.tsx:112-116).
 */
export async function loadSettlementRefs(): Promise<{ exitedTenants: any[]; banks: any[] }> {
  const allots: any[] = await safeList(
    supabase.from('tenant_allotments')
      .select('id, tenant_id, property_id, staying_status, actual_exit_date, deposit_paid')
      .eq('organization_id', ORG_ID)
      .or('staying_status.eq.exited,actual_exit_date.not.is.null'),
  );
  const tenantIds = [...new Set(allots.map((a) => a.tenant_id).filter(Boolean))];
  const [tenants, banks] = await Promise.all([
    tenantIds.length ? safeList(supabase.from('tenants').select('id, full_name').eq('organization_id', ORG_ID).in('id', tenantIds)) : Promise.resolve([]),
    safeList(supabase.from('organization_bank_accounts').select('id, bank_name, account_number, ifsc_code, is_primary').eq('organization_id', ORG_ID)),
  ]);
  const tN = new Map<string, string>(); for (const t of tenants as any[]) tN.set(t.id, t.full_name);
  const exitedTenants = allots
    .map((a) => ({
      allotment_id: a.id, tenant_id: a.tenant_id, full_name: tN.get(a.tenant_id) || 'Unknown',
      property_id: a.property_id, actual_exit_date: a.actual_exit_date || null,
      deposit_paid: Number(a.deposit_paid || 0),
    }))
    .filter((x) => x.full_name)
    .sort((x, y) => x.full_name.localeCompare(y.full_name));
  return { exitedTenants, banks };
}

/** Org bank accounts (used by exit-reconciliation refund). */
export async function loadBankAccounts(): Promise<any[]> {
  return safeList(
    supabase.from('organization_bank_accounts')
      .select('id, bank_name, account_number, ifsc_code, is_primary')
      .eq('organization_id', ORG_ID),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. EXPENSES — add / edit / delete  (ExpensesTab.tsx:207-314)
// ═══════════════════════════════════════════════════════════════════════════

export interface ExpenseFormInput {
  property_id: string; apartment_id?: string; bed_ids?: string[];
  category_id: string; subcategory_id?: string; asset_type_id?: string; issue_type_id?: string;
  vendor_id?: string; description?: string; amount: string | number;
  expense_date: string; receipt_url?: string; bill_photo_url?: string;
  categoryKey?: string; // 'maintenance' toggles subcategory vs asset/issue (ExpensesTab.tsx:211-212)
}

/**
 * Insert or update an expense (+ multi-bed split allocations).
 * Verbatim port of ExpensesTab.handleSave (ExpensesTab.tsx:207-301).
 * Payload shape / billing_month derivation / per-bed rounding are copied exactly.
 *
 * NOTE: on EDIT, the web clears expense_bed_allocations before re-inserting.
 * That clear is a delete, so it is gated on DELETES_ENABLED; while deletes are
 * off, an edit will NOT re-split across beds (header still updates).
 */
export async function saveExpense(form: ExpenseFormInput, editId?: string | null): Promise<any> {
  if (!form.property_id || !form.category_id || !form.amount) {
    throw new Error('Property, category & amount required');
  }
  const isMaintenance = (form.categoryKey || '') === 'maintenance';
  const bedIds: string[] = form.bed_ids || [];
  const amount = parseFloat(String(form.amount));
  // Auto-derive billing_month from expense_date (ExpensesTab.tsx:215).
  const derivedBillingMonth = form.expense_date ? form.expense_date.slice(0, 7) : null;
  const payload: any = {
    organization_id: ORG_ID,
    property_id: form.property_id,
    apartment_id: form.apartment_id || null,
    bed_id: bedIds.length === 1 ? bedIds[0] : null,
    category_id: form.category_id || null,
    subcategory_id: isMaintenance ? null : (form.subcategory_id || null),
    asset_type_id: isMaintenance ? (form.asset_type_id || null) : null,
    issue_type_id: isMaintenance ? (form.issue_type_id || null) : null,
    vendor_id: form.vendor_id || null,
    description: form.description || null,
    amount,
    expense_date: form.expense_date,
    billing_month: derivedBillingMonth,
    receipt_url: form.receipt_url || form.bill_photo_url || null,
  };

  let expenseId: string;
  if (editId) {
    await updateRow('expenses', editId, payload);
    expenseId = editId;
    // Clear old allocations (gated — this is a delete; ExpensesTab.tsx:240).
    if (DELETES_ENABLED) {
      await supabase.from('expense_bed_allocations').delete().eq('expense_id', editId).eq('organization_id', ORG_ID);
    }
  } else {
    const row = await insertRow('expenses', payload);
    expenseId = row.id;
  }

  // Insert bed allocations when multiple beds selected (ExpensesTab.tsx:251-264).
  // Skip re-allocation on edit when deletes are off (can't clear the old split).
  const canAllocate = !editId || DELETES_ENABLED;
  if (bedIds.length > 1 && canAllocate) {
    const perBed = Math.round((amount / bedIds.length) * 100) / 100;
    const allocations = bedIds.map((bedId, idx) => ({
      expense_id: expenseId,
      bed_id: bedId,
      organization_id: ORG_ID,
      allocated_amount: idx === bedIds.length - 1
        ? Math.round((amount - perBed * (bedIds.length - 1)) * 100) / 100
        : perBed,
    }));
    const { error: allocErr } = await supabase.from('expense_bed_allocations').insert(allocations);
    if (allocErr) console.warn('[saveExpense] allocation insert:', allocErr.message);
  }
  return { success: true, id: expenseId };
}

/** Delete an expense. Gated via deleteRow → throws while deletes are disabled. (ExpensesTab.tsx:303-314) */
export async function deleteExpense(id: string): Promise<any> {
  if (!DELETES_ENABLED) return deleteDisabledResult();
  await supabase.from('expense_bed_allocations').delete().eq('expense_id', id).eq('organization_id', ORG_ID);
  await deleteRow('expenses', id);
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. TENANT ADJUSTMENTS — create / edit / delete  (TenantAdjustmentsTab.tsx:177-252)
// ═══════════════════════════════════════════════════════════════════════════

export const ADJUSTMENT_CATEGORIES = [
  { value: 'guest_stay', label: 'Guest Stay' },
  { value: 'referral_bonus', label: 'Referral Bonus' },
  { value: 'eb_credit', label: 'EB Credit' },
  { value: 'rental_adjustment', label: 'Rental Adjustment' },
  { value: 'cc_charges', label: 'CC Charges' },
  { value: 'late_fees', label: 'Late Fees' },
  { value: 'others', label: 'Others' },
] as const;

export interface AdjustmentFormInput {
  tenant_id: string; allotment_id?: string;
  adjustment_type: 'credit_note' | 'debit_note';
  category?: string; amount: string | number;
  reason?: string; reference_number?: string; adjustment_date: string;
  property_id?: string; apartment_id?: string; bed_id?: string;
}

/**
 * Insert or update a tenant adjustment (credit/debit note).
 * Verbatim port of TenantAdjustmentsTab.handleSave (TenantAdjustmentsTab.tsx:177-215).
 * billing_month is auto-derived from adjustment_date; allotment/property/apt/bed
 * default to the selected tenant's active allotment.
 */
export async function saveAdjustment(form: AdjustmentFormInput, editId?: string | null): Promise<any> {
  if (!form.tenant_id || !form.amount || !form.adjustment_type) {
    throw new Error('Tenant, type & amount required');
  }
  const derivedBillingMonth = form.adjustment_date ? form.adjustment_date.slice(0, 7) : null;
  const payload: any = {
    organization_id: ORG_ID,
    tenant_id: form.tenant_id,
    allotment_id: form.allotment_id || null,
    adjustment_type: form.adjustment_type,
    category: form.category || 'others',
    amount: parseFloat(String(form.amount)),
    reason: form.reason || null,
    reference_number: form.reference_number || null,
    adjustment_date: form.adjustment_date,
    billing_month: derivedBillingMonth,
    property_id: form.property_id || null,
    apartment_id: form.apartment_id || null,
    bed_id: form.bed_id || null,
  };
  if (editId) {
    await updateRow('tenant_adjustments', editId, payload);
    return { success: true, id: editId };
  }
  const row = await insertRow('tenant_adjustments', payload);
  return { success: true, id: row.id };
}

/**
 * Delete a tenant adjustment (and its receipt_allocations).
 * Gated — both are deletes (TenantAdjustmentsTab.tsx:231-252). Returns the
 * disabled result while deletes are off; the web's rebuildTenantTransactions
 * ledger-sync is a no-op here (delete path is inactive).
 */
export async function deleteAdjustment(id: string): Promise<any> {
  if (!DELETES_ENABLED) return deleteDisabledResult();
  await supabase.from('receipt_allocations').delete().eq('adjustment_id', id).eq('organization_id', ORG_ID);
  await deleteRow('tenant_adjustments', id);
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. SETTLEMENTS — create / complete-refund  (SettlementsTab.tsx:118-259)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pre-fill deposit + pending rent/EB/late-fees for an exited tenant.
 * Verbatim port of SettlementsTab.handleTenantSelect (SettlementsTab.tsx:118-134).
 */
export async function computeSettlementPrefill(allotmentId: string, tenantId: string, depositPaid = 0): Promise<{
  deposit_amount: number; pending_rent: number; pending_eb: number; pending_late_fees: number;
}> {
  const invRows: any[] = await safeList(
    supabase.from('invoices')
      .select('tenant_id, status, rent_amount, electricity_amount, late_fee')
      .eq('organization_id', ORG_ID).eq('tenant_id', tenantId),
  );
  const unpaid = invRows.filter((inv) => inv.status !== 'paid');
  const pendingRent = unpaid.reduce((s, inv) => s + Number(inv.rent_amount || 0), 0);
  const pendingEB = unpaid.reduce((s, inv) => s + Number(inv.electricity_amount || 0), 0);
  const pendingLateFees = unpaid.reduce((s, inv) => s + Number((inv as any).late_fee || 0), 0);
  // Sum original deposit + additional deposit invoices (SettlementsTab.tsx:126-132).
  const addlDeps: any[] = await safeList(
    supabase.from('invoices').select('total_amount')
      .eq('organization_id', ORG_ID).eq('allotment_id', allotmentId).eq('invoice_type', 'additional_deposit'),
  );
  const addlTotal = addlDeps.reduce((s, r) => s + Number(r.total_amount || 0), 0);
  return {
    deposit_amount: Number(depositPaid || 0) + addlTotal,
    pending_rent: pendingRent, pending_eb: pendingEB, pending_late_fees: pendingLateFees,
  };
}

export interface SettlementFormInput {
  tenant_id: string; allotment_id?: string;
  deposit_amount: string | number;
  pending_rent?: string | number; pending_eb?: string | number; pending_late_fees?: string | number;
  damages?: string | number; other_deductions?: string | number;
  settlement_date: string; notes?: string;
  payment_bank_id?: string; payment_reference?: string; payment_proof_url?: string;
}

/**
 * Create a deposit settlement row (status 'settled') + best-effort refund
 * details on tenant_exits. Verbatim port of SettlementsTab.handleSave
 * (SettlementsTab.tsx:173-213). total_deductions & refund are computed the
 * same way (deposit − sum of 5 deduction buckets).
 */
export async function createSettlement(form: SettlementFormInput): Promise<any> {
  if (!form.tenant_id || !form.deposit_amount) throw new Error('Tenant and deposit required');
  if (!form.settlement_date) throw new Error('Settlement date required');
  const deposit = parseFloat(String(form.deposit_amount)) || 0;
  const pending_rent = parseFloat(String(form.pending_rent ?? 0)) || 0;
  const pending_eb = parseFloat(String(form.pending_eb ?? 0)) || 0;
  const pending_late_fees = parseFloat(String(form.pending_late_fees ?? 0)) || 0;
  const damages = parseFloat(String(form.damages ?? 0)) || 0;
  const other_deductions = parseFloat(String(form.other_deductions ?? 0)) || 0;
  const totalDeductions = pending_rent + pending_eb + pending_late_fees + damages + other_deductions;
  const refund = deposit - totalDeductions;
  const payload: any = {
    organization_id: ORG_ID, tenant_id: form.tenant_id, allotment_id: form.allotment_id || null,
    deposit_amount: deposit, pending_rent, pending_eb, pending_late_fees, damages, other_deductions,
    total_deductions: totalDeductions, refund_amount: refund, status: 'settled',
    settlement_date: form.settlement_date, notes: (form.notes || '').trim() || null,
  };
  const row = await insertRow('deposit_settlements', payload);

  // Best-effort: persist payment details on tenant_exits (SettlementsTab.tsx:192-205).
  if (form.allotment_id) {
    const bankId = (form.payment_bank_id || '').trim();
    const ref = (form.payment_reference || '').trim();
    const proofUrl = (form.payment_proof_url || '').trim();
    if (bankId || ref || proofUrl || form.settlement_date) {
      const { error } = await supabase.from('tenant_exits').update({
        refund_date: form.settlement_date,
        refund_bank_id: bankId || null,
        refund_reference: ref || null,
        refund_proof_url: proofUrl || null,
      }).eq('allotment_id', form.allotment_id).eq('organization_id', ORG_ID);
      if (error) console.warn('[createSettlement] tenant_exits update:', error.message);
    }
  }
  return { success: true, id: row.id };
}

export interface CompleteRefundInput {
  settlement_id: string; allotment_id?: string;
  refund_date: string; refund_bank_id: string; refund_reference: string;
  refund_proof_url?: string;
}

/**
 * Complete a settlement's refund: flip deposit_settlements → completed, mirror
 * onto tenant_exits, write an audit_logs row. Verbatim port of
 * SettlementsTab.completeRefundMutation (SettlementsTab.tsx:216-250).
 */
export async function completeRefund(form: CompleteRefundInput): Promise<any> {
  if (!form.refund_bank_id) throw new Error('Please select a bank account');
  if (!form.refund_reference) throw new Error('Please enter a reference number');

  const { error: dsErr } = await supabase.from('deposit_settlements').update({
    status: 'completed',
    settlement_date: form.refund_date,
    notes: `Refund ref: ${form.refund_reference}`,
  }).eq('id', form.settlement_id).eq('organization_id', ORG_ID);
  if (dsErr) throw new Error(dsErr.message);

  if (form.allotment_id) {
    const { error: teErr } = await supabase.from('tenant_exits').update({
      refund_status: 'completed',
      refund_date: form.refund_date,
      refund_reference: form.refund_reference,
      refund_bank_id: form.refund_bank_id,
      refund_proof_url: form.refund_proof_url || null,
    }).eq('allotment_id', form.allotment_id).eq('organization_id', ORG_ID);
    if (teErr) console.warn('[completeRefund] tenant_exits update:', teErr.message);
  }

  const uid = await currentUserId();
  await supabase.from('audit_logs').insert({
    organization_id: ORG_ID,
    table_name: 'deposit_settlements',
    record_id: form.settlement_id,
    action: 'COMPLETE_REFUND',
    performed_by: uid,
    new_value: {
      status: 'completed', settlement_date: form.refund_date,
      refund_bank_id: form.refund_bank_id, refund_reference: form.refund_reference,
    },
  } as any);
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. EXIT RECONCILIATION — settle exit  (exit-reconciliation.ts + ExitReconciliationTab.tsx)
// ═══════════════════════════════════════════════════════════════════════════

/** Dues after adding new EB + exit charges (exit-reconciliation.ts:21-25). */
export function computeDuesAfter(duesNow: number, addEb: number, addExit: number): number {
  return Math.round(Number(duesNow) + Math.ceil(Number(addEb) || 0) + Math.ceil(Number(addExit) || 0));
}
/** Refund = deposit held − dues utilized, floored at zero (exit-reconciliation.ts:28-30). */
export function computeExitRefund(depositHeld: number, duesAfter: number): number {
  return Math.max(Math.round(Number(depositHeld) - Math.max(Number(duesAfter), 0)), 0);
}

/** Next invoice number "<Prop5>/<FY>/<MM>/00001" (exit-reconciliation.ts:40-56). */
async function getNextInvoiceNumber(propertyId: string, propertyName: string, billingMonth: string): Promise<string> {
  const mm = billingMonth.split('-')[1];
  const fy = getFY(billingMonth);
  const abbr = getPropertyAbbr(propertyName || 'UNKNO');
  const { count, error } = await supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', propertyId)
    .eq('billing_month', billingMonth);
  if (error) throw new Error(error.message);
  return `${abbr}/${fy}/${mm}/${String((count || 0) + 1).padStart(5, '0')}`;
}

export interface ExitChargeInvoiceArgs {
  allotmentId: string; propertyId: string; apartmentId: string; bedId: string; tenantId: string;
  propertyName: string; exitDateIso: string; estimatedEbToPost: number; exitChargeToPost: number;
}

/**
 * Post additional estimated-EB and/or exit-charge invoices for an exited tenant.
 * Idempotent per (reference_type, allotment, invoice_date). Verbatim port of
 * exit-reconciliation.createExitChargeInvoices (exit-reconciliation.ts:76-187).
 * Amounts are Math.ceil'd exactly as the web does.
 */
export async function createExitChargeInvoices(a: ExitChargeInvoiceArgs): Promise<void> {
  const billingMonth = a.exitDateIso.slice(0, 7);

  if (a.estimatedEbToPost > 0) {
    const existing = await safeFetch(
      supabase.from('invoices').select('id')
        .eq('allotment_id', a.allotmentId).eq('reference_type', 'exit_estimated_eb')
        .eq('reference_id', a.allotmentId).eq('invoice_date', a.exitDateIso).limit(1).maybeSingle(),
    );
    if (!existing) {
      const invoiceNumber = await getNextInvoiceNumber(a.propertyId, a.propertyName, billingMonth);
      const amt = Math.ceil(a.estimatedEbToPost);
      const inv = await safeFetch(
        supabase.from('invoices').insert({
          organization_id: ORG_ID, tenant_id: a.tenantId, allotment_id: a.allotmentId,
          property_id: a.propertyId, apartment_id: a.apartmentId, bed_id: a.bedId,
          invoice_number: invoiceNumber, invoice_type: 'regular', billing_month: billingMonth,
          rent_amount: 0, electricity_amount: 0, estimated_eb: amt, other_charges: 0, late_fee: 0,
          total_amount: amt, amount_paid: 0, balance: amt,
          invoice_date: a.exitDateIso, due_date: a.exitDateIso, status: 'pending',
          reference_type: 'exit_estimated_eb', reference_id: a.allotmentId,
        }).select('id').single(),
      );
      const { error: lineErr } = await supabase.from('invoice_line_items').insert({
        invoice_id: (inv as any).id, line_type: 'estimated_eb', amount: amt,
        description: `Estimated EB (reconciliation) for ${billingMonth}`, organization_id: ORG_ID,
      });
      if (lineErr) throw new Error(lineErr.message);
    }
  }

  if (a.exitChargeToPost > 0) {
    const existing = await safeFetch(
      supabase.from('invoices').select('id')
        .eq('allotment_id', a.allotmentId).eq('reference_type', 'exit_charge')
        .eq('reference_id', a.allotmentId).eq('invoice_date', a.exitDateIso).limit(1).maybeSingle(),
    );
    if (!existing) {
      const invoiceNumber = await getNextInvoiceNumber(a.propertyId, a.propertyName, billingMonth);
      const amt = Math.ceil(a.exitChargeToPost);
      const inv = await safeFetch(
        supabase.from('invoices').insert({
          organization_id: ORG_ID, tenant_id: a.tenantId, allotment_id: a.allotmentId,
          property_id: a.propertyId, apartment_id: a.apartmentId, bed_id: a.bedId,
          invoice_number: invoiceNumber, invoice_type: 'exit_charge', billing_month: billingMonth,
          rent_amount: 0, electricity_amount: 0, estimated_eb: 0, other_charges: amt, late_fee: 0,
          total_amount: amt, amount_paid: 0, balance: amt,
          invoice_date: a.exitDateIso, due_date: a.exitDateIso, status: 'pending',
          reference_type: 'exit_charge', reference_id: a.allotmentId,
        }).select('id').single(),
      );
      const { error: lineErr } = await supabase.from('invoice_line_items').insert({
        invoice_id: (inv as any).id, line_type: 'exit_charges', amount: amt,
        description: `Exit charges (reconciliation) on ${a.exitDateIso}`, organization_id: ORG_ID,
      });
      if (lineErr) throw new Error(lineErr.message);
    }
  }
}

export interface CommitReconcileArgs {
  allotmentId: string; exitDate: string;
  refundAmount: number | null; refundDate: string | null;
  refundBankId: string | null; refundReference: string | null;
}

/**
 * Settle the deposit (utilized + refund split) + record refund details, atomically.
 * Calls the reconcile_exit_settlement RPC (exit-reconciliation.ts:235-247).
 */
export async function commitReconcile(a: CommitReconcileArgs): Promise<any> {
  const { data, error } = await supabase.rpc('reconcile_exit_settlement', {
    p_allotment_id: a.allotmentId,
    p_exit_date: a.exitDate,
    p_refund_amount: a.refundAmount,
    p_refund_date: a.refundDate,
    p_refund_bank_id: a.refundBankId,
    p_refund_reference: a.refundReference,
  });
  if (error) throw new Error(error.message);
  return data;
}

export interface SettleExitInput {
  allotmentId: string; propertyId: string; apartmentId: string; bedId: string; tenantId: string;
  propertyName: string;
  exitDate: string; addEb?: string | number; addExit?: string | number;
  refund?: string | number; touchedRefund?: boolean;
  refundDate?: string; bankId?: string; ref?: string;
}

/**
 * One-click "settle exit": post any additional EB/exit-charge invoices, then
 * commit the deposit reconciliation. Verbatim port of ExitReconciliationTab.save
 * (ExitReconciliationTab.tsx:130-178).
 */
export async function settleExit(r: SettleExitInput): Promise<any> {
  if (!r.exitDate) throw new Error('Exit date required');
  const addEb = Number(r.addEb) || 0;
  const addExit = Number(r.addExit) || 0;
  if (addEb > 0 || addExit > 0) {
    await createExitChargeInvoices({
      allotmentId: r.allotmentId, propertyId: r.propertyId, apartmentId: r.apartmentId,
      bedId: r.bedId, tenantId: r.tenantId, propertyName: r.propertyName,
      exitDateIso: r.exitDate, estimatedEbToPost: addEb, exitChargeToPost: addExit,
    });
  }
  const res = await commitReconcile({
    allotmentId: r.allotmentId,
    exitDate: r.exitDate,
    refundAmount: r.touchedRefund && r.refund !== '' && r.refund != null ? Number(r.refund) : null,
    refundDate: r.refundDate || r.exitDate,
    refundBankId: r.bankId || null,
    refundReference: r.ref || null,
  });
  return res;
}

/** Hard-delete every transaction for an allotment (exit-reconciliation.ts:225-232). Gated. */
export async function purgeAllotmentTransactions(allotmentId: string): Promise<any> {
  if (!DELETES_ENABLED) return deleteDisabledResult();
  const { data, error } = await supabase.rpc('purge_allotment_transactions', { p_allotment_id: allotmentId });
  if (error) throw new Error(error.message);
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. INVOICES — edit / lock / unlock / mark-paid / send-WhatsApp  (InvoicesTab.tsx)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Replace all invoice line items with a fresh set from the edited fields.
 * Verbatim port of InvoicesTab.replaceAllLineItems (InvoicesTab.tsx:85-103).
 * The delete half is gated — while deletes are off this returns a message and
 * the header-level amounts are the source of truth until deletes are enabled.
 */
async function replaceAllLineItems(invoiceId: string, fields: Record<string, number>): Promise<string | null> {
  if (!DELETES_ENABLED) return 'Line-item replace skipped — deleting is currently disabled.';
  const { error: delErr } = await supabase.from('invoice_line_items').delete().eq('invoice_id', invoiceId);
  if (delErr) return delErr.message;
  const rows = Object.entries(fields)
    .map(([field, amount]) => {
      const lineType = FIELD_TO_LINE_TYPE[field];
      return lineType && amount > 0
        ? { invoice_id: invoiceId, line_type: lineType, amount, description: lineType, organization_id: ORG_ID }
        : null;
    })
    .filter(Boolean);
  if (rows.length > 0) {
    const { error: insErr } = await supabase.from('invoice_line_items').insert(rows as any);
    if (insErr) return insErr.message;
  }
  return null;
}

export interface InvoiceEditForm {
  rent_amount: number; electricity_amount: number; estimated_eb: number;
  late_fee: number; other_charges: number;
}

/**
 * Edit an invoice's amounts (blocked when locked). Recomputes total / balance /
 * status and re-syncs line items. Verbatim port of InvoicesTab.handleSaveEdit
 * (InvoicesTab.tsx:800-840). `invoice` is the raw invoice row (needs id, locked,
 * amount_paid — or paidAmount from the mobile mapped shape).
 */
export async function saveInvoiceEdit(invoice: any, editForm: InvoiceEditForm): Promise<any> {
  if (invoice.locked) throw new Error('Invoice is locked. Unlock first to edit.');
  const totalAmount =
    editForm.rent_amount + editForm.electricity_amount + editForm.estimated_eb +
    editForm.late_fee + editForm.other_charges;
  const paid = Number(invoice.amount_paid ?? invoice.paidAmount ?? 0);
  const balance = Math.max(0, totalAmount - paid);
  const status = balance <= 0 ? 'paid' : paid > 0 ? 'partial' : 'pending';
  const { error } = await supabase.from('invoices').update({
    rent_amount: editForm.rent_amount,
    electricity_amount: editForm.electricity_amount,
    estimated_eb: editForm.estimated_eb,
    late_fee: editForm.late_fee,
    other_charges: editForm.other_charges,
    total_amount: totalAmount, balance, status,
  }).eq('id', invoice.id || invoice._id).eq('organization_id', ORG_ID);
  if (error) throw new Error(error.message);
  const lineErr = await replaceAllLineItems(invoice.id || invoice._id, {
    rent_amount: editForm.rent_amount, electricity_amount: editForm.electricity_amount,
    estimated_eb: editForm.estimated_eb, late_fee: editForm.late_fee, other_charges: editForm.other_charges,
  });
  return { success: true, total_amount: totalAmount, balance, status, lineItemWarning: lineErr };
}

/**
 * Lock or unlock an invoice. Verbatim port of InvoicesTab.handleLock
 * (InvoicesTab.tsx:911-943): lock sets locked/locked_by/locked_at; unlock clears
 * the flag. An audit_logs row is written for both (web gates unlock behind an
 * admin reason-dialog; here `reason` is passed through to the audit row).
 */
export async function setInvoiceLock(invoice: any, lock: boolean, reason?: string): Promise<any> {
  const id = invoice.id || invoice._id;
  const uid = await currentUserId();
  if (lock) {
    const nowIso = new Date().toISOString();
    const { error } = await supabase.from('invoices')
      .update({ locked: true, locked_by: uid, locked_at: nowIso })
      .eq('id', id).eq('organization_id', ORG_ID);
    if (error) throw new Error(error.message);
    await supabase.from('audit_logs').insert({
      organization_id: ORG_ID, table_name: 'invoices', record_id: id, action: 'manual_lock',
      performed_by: uid, new_value: { invoice_number: invoice.invoice_number || invoice.invoiceNumber, locked_at: nowIso },
    } as any);
  } else {
    const { error } = await supabase.from('invoices')
      .update({ locked: false })
      .eq('id', id).eq('organization_id', ORG_ID);
    if (error) throw new Error(error.message);
    await supabase.from('audit_logs').insert({
      organization_id: ORG_ID, table_name: 'invoices', record_id: id, action: 'manual_unlock',
      performed_by: uid, new_value: { invoice_number: invoice.invoice_number || invoice.invoiceNumber, reason: reason || null },
    } as any);
  }
  return { success: true, locked: lock };
}

/**
 * Mark an invoice paid by recording a receipt for its outstanding balance.
 *
 * DEVIATION: the web InvoicesTab has NO direct "mark paid" write — invoice
 * status is DERIVED from FIFO receipt settlement (InvoicesTab.tsx:587-610). To
 * stay faithful to that model, "mark paid" records a full-balance payment via
 * the existing recordPayment path (the ledger trigger then settles the invoice),
 * rather than force-flipping invoices.status. Pass the mobile mapped invoice
 * (has _id, totalAmount, paidAmount).
 */
export async function markInvoicePaid(
  invoice: any,
  opts: { paymentMode?: string; paymentDate?: string; bankAccountId?: string | null; referenceNumber?: string | null } = {},
): Promise<any> {
  const total = Number(invoice.totalAmount ?? invoice.total_amount ?? 0);
  const paid = Number(invoice.paidAmount ?? invoice.amount_paid ?? 0);
  const balance = Math.max(0, total - paid);
  if (balance <= 0) return { ok: false, reason: 'Invoice already fully paid.' };
  return recordPayment({
    invoiceId: invoice._id || invoice.id,
    amountPaid: balance,
    paymentDate: opts.paymentDate || today(),
    paymentMode: opts.paymentMode || 'cash',
    bankAccountId: opts.bankAccountId || null,
    referenceNumber: opts.referenceNumber || null,
  });
}

/** Resolve the org's WhatsApp controls (parity with sendAnnouncementWhatsapp). */
async function resolveWhatsappControls(): Promise<{ enabled: boolean; testNumber: string; testAnnouncementMode: boolean; testInvoiceMode: boolean }> {
  let controlsRow: any = null;
  try {
    const { data } = await supabase.from('org_whatsapp_settings')
      .select('notifications_enabled, test_phone, test_mode_enabled')
      .eq('organization_id', ORG_ID).maybeSingle();
    controlsRow = data;
  } catch { controlsRow = null; }
  const orgSandbox = Boolean(controlsRow?.test_mode_enabled);
  return {
    enabled: controlsRow?.notifications_enabled ?? true,
    testNumber: (controlsRow?.test_phone ?? '').trim(),
    testAnnouncementMode: orgSandbox,
    testInvoiceMode: orgSandbox,
  };
}

/**
 * Send one or more invoices to tenants over WhatsApp by queuing a durable
 * whatsapp_send_jobs row (job_type 'invoice') + one delivery per invoice, then
 * kicking off the shared `whatsapp-send-job` edge worker — the SAME path the
 * mobile app already uses for announcements (supabaseService.sendAnnouncementWhatsapp)
 * and the web uses for invoices (whatsappSendJobService.createAndStartInvoiceJob).
 * Visible/retryable in WhatsApp Logs.
 *
 * ASSUMES the deployed `whatsapp-send-job` edge function builds/sends the invoice
 * message for each delivery (payload: tenant_id, billing_month, invoice_id).
 * Pass the mobile mapped invoices (have _id/id, tenantId, tenantName, billingMonth).
 */
export async function sendInvoicesWhatsApp(invoices: any[]): Promise<any> {
  const list = [...new Map((invoices || []).map((i) => [String(i._id || i.id), i])).values()];
  if (list.length === 0) throw new Error('No invoices selected');
  const controls = await resolveWhatsappControls();
  if (!controls.enabled) {
    return { ok: false, skipped: 'whatsapp_disabled', reason: 'WhatsApp notifications are turned off in Settings.' };
  }
  const uid = await currentUserId();
  const label = list.length === 1
    ? `Invoice · ${list[0].tenantName || list[0].invoiceNumber || ''}`.slice(0, 120)
    : `Invoices · ${list.length} tenants`;
  let job: any;
  try {
    job = await insertRow('whatsapp_send_jobs', {
      created_by: uid, job_type: 'invoice', status: 'pending', total_count: list.length,
      label, payload: { invoices: [], controls, use_deliveries: true, prep_complete: false },
    });
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'Could not create the send job.' };
  }
  const jobId = job?.id;
  if (!jobId) return { ok: false, reason: 'Send job was not created.' };

  // One delivery row per invoice (whatsappSendJobService.insertJobDeliveries parity).
  const deliveries = list.map((inv) => ({
    organization_id: ORG_ID, job_id: jobId, delivery_kind: 'invoice',
    reference_id: inv._id || inv.id || null,
    tenant_id: inv.tenantId || inv.tenant_id || null,
    tenant_name: inv.tenantName || null,
    label: inv.invoiceNumber || inv.invoice_number || null,
    payload: {
      tenant_id: inv.tenantId || inv.tenant_id || null,
      billing_month: inv.billingMonth || inv.billing_month || null,
      invoice_id: inv._id || inv.id || null,
    },
    status: 'pending',
  }));
  const { error: delErr } = await supabase.from('whatsapp_send_deliveries').insert(deliveries as any);
  if (delErr) {
    try { await updateRow('whatsapp_send_jobs', jobId, { status: 'failed', error_message: delErr.message }); } catch { /* best-effort */ }
    return { ok: false, reason: delErr.message };
  }
  // Mark prep complete, then kick off the worker (not awaited server-side).
  try { await updateRow('whatsapp_send_jobs', jobId, { payload: { invoices: list.map((i) => ({ invoice_id: i._id || i.id })), controls, use_deliveries: true, prep_complete: true } }); } catch { /* best-effort */ }
  try {
    const { error } = await supabase.functions.invoke('whatsapp-send-job', { body: { job_id: jobId } });
    if (error) {
      try { await updateRow('whatsapp_send_jobs', jobId, { status: 'failed', error_message: error.message || 'kickoff failed' }); } catch { /* best-effort */ }
      return { ok: false, queued: true, jobId, reason: error.message || 'Send job created but the worker did not start; retry from WhatsApp Logs.' };
    }
    return { ok: true, queued: true, jobId, count: list.length };
  } catch (e: any) {
    try { await updateRow('whatsapp_send_jobs', jobId, { status: 'failed', error_message: e?.message || 'kickoff failed' }); } catch { /* best-effort */ }
    return { ok: false, queued: true, jobId, reason: e?.message || 'Send job created but the worker is unavailable; retry from WhatsApp Logs.' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. RENTAL PAYMENTS — record owner payout
//    Reuses supabaseService.recordOwnerPayment (owner_payments → status 'paid').
//    RentalPaymentsTab.tsx records the payout the same way; no new fn needed —
//    the screen calls sb.recordOwnerPayment(id, {...}) directly. `toISODate` is
//    re-exported for date normalisation on the owner-payment form.
// ═══════════════════════════════════════════════════════════════════════════
export { toISODate };

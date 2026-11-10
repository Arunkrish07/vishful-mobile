# Accounting Parity Build Spec — Vishful Mobile (a0-project) → Vishful OS (web)

Goal: bring the mobile app's Accounting to parity with the Vishful OS web app, **on the same double-entry ledger**, so the same organization + period produces identical numbers on both.

- **Mobile (this repo):** Expo SDK 52. UI in `screens/AccountingScreen.tsx`. Data via Convex actions in `convex/accounting.ts` (service-role Supabase client, `convex/lib/supabaseAdmin.ts`), routed through `lib/supabaseService.ts` → `lib/convexApi.ts`.
- **Web reference:** `…/external-db-guide-f04b8927-main (1)/external-db-guide-f04b8927-main`. Accounting UI in `src/pages/Accounting.tsx` + `src/components/accounting/*Tab.tsx`. Financial contract: `docs/03-accounting.md`.
- **Shared truth:** both apps hit the **same Supabase Postgres**. Web reaches it directly; mobile reaches it through Convex. Parity = mobile Convex actions must call the **same canonical views/RPCs** the web uses.

---

## 0. Current state (why this is more than "add tabs")

Web Accounting has **13 tabs** on a full journal. Mobile has **one invoice screen** that is currently **broken and off-ledger**:

- `createInvoice` (`convex/accounting.ts:477-496`) ignores the rent/electricity/other/due-date the form sends and inserts `amount: 0`.
- `recordPayment` (`convex/accounting.ts:498-526`) reads `data.amount` while `AccountingScreen` sends `amountPaid` → payment saved as `0`; it writes the wrong table (`payments`) and manually flips `invoices.status='paid'` with **no journal posting**.
- Invoice cards (`AccountingScreen.tsx:154-166`) read fields the backend never returns (`invoiceNumber`, `totalAmount`, `paidAmount`, `tenantName`, `propertyName`) → blank cards; the "pending" banner math is `NaN`.
- `convex/reports.ts`, `convex/metrics.ts`, and `getEBAnalytics` compute money by **SUMming raw tables** — the forbidden pattern. Only `convex/dashboard.ts` correctly uses `get_universal_metrics_v2`.

---

## 1. Non-negotiable data contract (applies to EVERY accounting action)

The double-entry ledger (`journal_entries` + `journal_lines`) is the **only** financial truth. Source docs (`invoices`, `receipts`, `expenses`, `tenant_adjustments`, `deposit_settlements`) post journals **via DB triggers**. Read money only through the views/RPCs below.

### Read money via (never SUM raw tables):
| View / RPC | Returns | Use for |
|---|---|---|
| `get_universal_metrics_v2(p_organization_id, p_period[, p_from, p_to])` | revenue, collections, expenses, profit, deposits, advances, expenseBreakdown | Header KPIs |
| `get_universal_metrics_series(p_organization_id, p_months)` | monthly KPI series | Trend charts |
| `v_tenant_current_dues` | `ar_balance` (signed), `deposit_held`, `booking_advance`, `net_dues`, counts | Invoice status, dues totals |
| `v_tenant_ledger` | per-allotment DR/CR rows + `running_balance`, `account_code` | Tenant statement / Ledger tab |
| `v_tenant_aging` | 0-30 / 31-60 / 61-90 / 90+ buckets | Aging |
| `v_invoice_settlement_status` | FIFO paid/partial/unpaid per invoice | Invoice settlement |
| `get_trial_balance_detailed(p_org, p_from, p_to)` | trial-balance rows | Trial Balance |
| `get_account_rollup(p_org, p_from, p_to)` | parent-account rollups | Balance Sheet / Income Statement |
| `get_account_drilldown(p_org, p_account_id, p_from, p_to, p_include_descendants)` | journal lines + bank grouping | Account drill-down |
| `v_exit_reconciliation_worklist` | exited tenants w/ non-zero ledger | Exit Reconciliation |
| `v_expense_composition`, `v_pnl_by_category`, `v_property_pnl` | journal-backed P&L | Profitability / Reports |
| `financial_integrity_check(p_organization_id)` | 3 drift checks | Integrity badge |

### Write money via (journal-safe):
| RPC / pattern | Use |
|---|---|
| `replace_invoices_atomic(p_org_id, p_billing_month, p_allotment_ids, p_invoices, p_line_items, p_eb_shares, p_replacement_targets)` | Bulk invoice generation (advisory-locked, atomic) — the only approved bulk write |
| `next_receipt_number(p_org, p_property, p_date)` then insert `receipts` | Record a collection; trigger posts DR 1000 / CR 1200 + FIFO `receipt_allocations` |
| insert `expenses` (+ `expense_bed_allocations`) | Expense; DB trigger posts the journal |
| insert `tenant_adjustments` | Credit/debit note; trigger `trg_adjustment_journal_post` |
| insert `deposit_settlements` (+ update `tenant_exits`) | Settlement; trigger `trg_settlement_journal_post` |
| `reconcile_exit_settlement(...)`, `purge_allotment_transactions(...)` | Exit reconciliation |
| `edit_tenant_ledger_entry_amount(p_je_id, p_new_amount)`, `delete_tenant_ledger_entry(p_je_id, p_reason)` | Ledger entry edits (keep row-action gating) |

### FORBIDDEN (mobile currently does all of these):
- `SUM(invoices.total_amount)` / `SUM(receipts.amount_paid)` / `SUM(expenses.amount)` for money (misses owner rent, ignores the ledger).
- Reading `invoices.balance` or `tenant_allotments.balance_due` as authoritative.
- Client-side invoice/receipt numbering (RPC/trigger owns it).
- Writing money outside the journal (e.g. current `recordPayment` → `payments` + manual status flip).
- `Math.max(x, 0)` clamping of signed balances (masks overpayments).

### Chart of accounts (key codes): `1000` Cash/Bank · `1200` AR–Tenants · `2100` Deposits Held · `2400` Booking Advance · `4100` Rent Rev · `4200` Electricity Rev · `5xxx` Expenses. **Tenant balance = signed net of 1200** (>0 owes, <0 credit).

---

## 2. Target tabs → Convex actions to build

Each tab maps to Convex action(s) that wrap the canonical view/RPC above. Mirror the web tab's UI (`src/components/accounting/<Tab>.tsx`).

| Tab | Convex action(s) to add in `convex/accounting.ts` | Wraps |
|---|---|---|
| Header KPIs | `getAccountingKPIs(period)` | `get_universal_metrics_v2` + `v_tenant_current_dues` |
| Billing (bulk generate) | `generateInvoices(month, allotmentIds)` (port `src/lib/billing-engine.ts`) | `replace_invoices_atomic` |
| Invoices | `listInvoices`, `getInvoiceDetail`, `upsertInvoice`, `deleteInvoice` | real `invoices` + `invoice_line_items`; status from `v_tenant_current_dues` / `v_invoice_settlement_status` |
| Adjustments | `createAdjustment`, `listAdjustments`, `deleteAdjustment` | insert `tenant_adjustments` (trigger posts) |
| Collections (receipts) | `recordReceipt`, `listReceipts`, `deleteReceipt` | `next_receipt_number` + insert `receipts` |
| Expenses | `createExpense`, `updateExpense`, `deleteExpense`, `listExpenseCategories` | insert `expenses` (+bed allocations) |
| Rental Payments | `settleOwnerPayment`, `updateOwnerPayment`, `deleteOwnerPayment` | `owner_payments` |
| GST Billing | `computeGstWorking`, `saveGstWorking` | `gst_monthly_workings` (⚠ not journal-integrated) |
| Settlements | `createSettlement`, `completeRefund`, `listSettlements` | insert `deposit_settlements` + `tenant_exits` |
| Tenant Ledger | `getTenantLedger`, `editLedgerEntry`, `deleteLedgerEntry` | `v_tenant_ledger`, `edit_/delete_tenant_ledger_entry` |
| Trial Balance / BS / IS | `getTrialBalance`, `getAccountRollup`, `getAccountDrilldown` | `get_trial_balance_detailed`, `get_account_rollup`, `get_account_drilldown` |
| Exit Reconciliation | `getExitWorklist`, `reconcileExit`, `purgeAllotment` | `v_exit_reconciliation_worklist`, `reconcile_exit_settlement`, `purge_allotment_transactions` |
| Profitability | `getProfitability` (replace raw SUMs in `reports.ts`) | `v_property_pnl`, `v_pnl_by_category`, `v_expense_composition` |
| Reports | `getFinancialReports` (rebuild on views) | canonical views |
| Bank Accounts (sub) | `listBankAccounts`, CRUD | `organization_bank_accounts` |
| WhatsApp Matched Payments (sub) | `listSubmissions`, `acceptSubmission`, `rejectSubmission`, `reocrSubmission` | `whatsapp_payment_submissions` + edge fns `payments-extract-proof`, `backfill-whatsapp-images` |

---

## 3. P0 — Fix the broken flow first (small, unblocks everything)

1. **`listInvoices`** (`convex/accounting.ts:445`): return real invoice fields the UI needs — `invoice_number, total_amount, amount_paid, rent_amount, electricity_amount, billing_month, status`, plus joins `tenants(full_name)`, `properties(property_name)`, `apartments(apartment_code)`. Update `AccountingScreen.tsx:154-166` to read those exact keys. Derive `status` from `v_tenant_current_dues.ar_balance` (Paid / Partial / Overdue / Pending), not the raw column.
2. **`createInvoice`** (`convex/accounting.ts:477`): accept `{tenantId, propertyId, apartmentId, bedId, billingMonth, rentAmount, electricityAmount, otherCharges, dueDate}` from `AccountingScreen.tsx:67-78`; insert a **complete** invoice row (`rent_amount`, `electricity_amount`, `other_charges`, `total_amount = sum`, `billing_month`, `due_date`, org/tenant/property/apartment/bed) + `invoice_line_items`, so the journal trigger posts. Do not insert `amount: 0`.
3. **`recordPayment` → `recordReceipt`** (`convex/accounting.ts:498`): read `amountPaid` (the field the screen sends, `AccountingScreen.tsx:95`); call `next_receipt_number(...)`, insert a **`receipts`** row (`tenant_allotment_id, amount_paid, payment_date, payment_mode, receipt_number, bank_account_id?, reference_number?`). **Do not** write `payments` and **do not** manually set `invoices.status` — the receipt trigger + FIFO `receipt_allocations` settle it, and status derives from `v_tenant_current_dues`.
4. **Header KPIs / pending banner**: replace client-side `NaN` math (`AccountingScreen.tsx:115-116`) with `getAccountingKPIs(period)` → `get_universal_metrics_v2` + `v_tenant_current_dues`.
5. **Stop the raw SUMs**: switch `convex/reports.ts` and `convex/metrics.ts` money math to `get_universal_metrics_v2` / the canonical views (keep the raw-compute only as an explicit offline fallback, like `dashboard.ts:364-370`).

---

## 4. Phased plan

- **P0** — §3 correctness fixes (invoice/payment on-ledger; KPIs via RPC; kill raw SUMs).
- **P1** — Operational core: Collections (receipts), Expenses entry, **Tenant Ledger** (`v_tenant_ledger`), dues/aging.
- **P2** — Billing engine (`replace_invoices_atomic`), Adjustments, Settlements, Rental Payments.
- **P3** — Financial statements: Trial Balance / Balance Sheet / Income Statement, Exit Reconciliation, Profitability, Reports, GST.
- **P4** — WhatsApp payment reconciliation (OCR edge fns, submission matching, Accept→receipt / Reject→audited cascade), Bank Accounts, locking/audit. Big and self-contained — do last.

---

## 5. Cross-cutting rules

- **Locking/audit:** invoices & receipts auto-lock once WhatsApp-sent (`auto_lock_on_send` trigger); unlock is admin-only + writes `audit_logs`. Any mobile edit/delete must respect `locked`/`is_locked`.
- **Signed balances:** never `Math.max(balance, 0)`.
- **Org scope:** every read/write filtered by `organization_id` (mobile Convex currently hardcodes `ORG_ID` in `convex/lib/supabaseAdmin.ts` — fine for single-org, revisit for multi-org).
- **Numbering:** always server-side (`next_receipt_number`, invoice RPC) — never client-generated.
- **Verify parity:** for a given org + period, mobile KPIs, trial balance, and a sample tenant ledger must reconcile 1:1 with the web app.

---

## 6. Copy-paste build prompt (scoped to P0 + P1)

```
Bring the Vishful mobile app's Accounting to correctness + operational parity with Vishful OS
(web). Work in this repo (a0-project). Reference ACCOUNTING_PARITY_SPEC.md in the repo root and
the web app at "…/external-db-guide-f04b8927-main (1)/external-db-guide-f04b8927-main"
(src/components/accounting/*, docs/03-accounting.md).

HARD RULES (from the spec §1):
- Read money ONLY via canonical views/RPCs: get_universal_metrics_v2, v_tenant_current_dues,
  v_tenant_ledger, v_invoice_settlement_status. NEVER SUM invoices/receipts/expenses.
- Write money journal-safe: receipts via next_receipt_number + receipts insert (trigger posts);
  invoices as complete rows + invoice_line_items; NEVER write journal_entries directly; NEVER
  manually set invoice.status. Keep balances signed (no Math.max(x,0)).

P0 — fix the broken flow (convex/accounting.ts + screens/AccountingScreen.tsx):
1. listInvoices: return invoice_number, total_amount, amount_paid, rent_amount, electricity_amount,
   billing_month, status + joins tenant/property/apartment; update the screen cards to match;
   derive status from v_tenant_current_dues.
2. createInvoice: map rentAmount/electricityAmount/otherCharges/dueDate → a complete invoice row
   (total = sum) + invoice_line_items. No more amount:0.
3. recordReceipt (replace recordPayment): read amountPaid; call next_receipt_number; insert a
   receipts row; do NOT write payments or flip invoice.status.
4. Replace the NaN pending banner + KPIs with getAccountingKPIs(period) → get_universal_metrics_v2
   + v_tenant_current_dues.
5. Fix convex/reports.ts and convex/metrics.ts to use canonical RPCs/views instead of raw SUMs.

P1 — operational core: add Collections (receipts list/entry), Expenses (create/edit/delete +
categories), and a Tenant Ledger screen (v_tenant_ledger, with edit/delete via
edit_/delete_tenant_ledger_entry, keeping the web's row-action gating).

Add matching Convex actions per the spec §2. Verify: for one org + period, mobile KPIs and a
sample tenant ledger reconcile exactly with the web app.
```

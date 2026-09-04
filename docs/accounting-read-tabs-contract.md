# Accounting — Remaining Tabs: READ/Display Parity Contract

Scope: READ/display side only (create/edit/delete deferred). Web source: `C:\vishful-web-v7\external-db-guide-f04b8927-main\src\components\accounting\`. Schema: `src\integrations\supabase\types.ts`. Mobile: `screens/AccountingScreen.tsx` + `convex/accounting.ts`.

---

## ⑤ ExpensesTab.tsx

1. **Source**: `expenses` table (`id, organization_id, property_id, apartment_id, bed_id, category_id, subcategory_id, asset_type_id, issue_type_id, vendor_id, description, amount, expense_date, billing_month, receipt_url, bank_account_id, data_source, related_asset_id, team_payment_id, ticket_resolution_id, created_at`) joined to `expense_categories` (id, key, label), `properties`, `apartments`, `vendors`, and `expense_bed_allocations` (multi-bed split). Org-scope: `organization_id`.
2. **What it shows**: Row: Date, Category›Subcategory (maintenance rows show issue-type/asset-type instead), Property, Apt-Bed, Vendor, Description, Amount, Bill link, Lock icon, Actions. KPIs: Total expenses (period) = Σ`amount`; Category break-up = Σ`amount` grouped by `category_id` (desc, uncategorized bucket for null; salary category drills into per-employee breakdown). Filters: property, month (`billing_month`), category, search.
3. **Mobile gap**: Partially covered by `listExpenses` (id, category, description, amount, expense_date, created_at). Missing: property/apartment/bed/vendor names, receipt link, lock state, billing_month, KPI totals, category breakdown, filters. Add `getExpensesSummary(period?) -> { totalAmount, byCategory: {categoryId, label, amount}[] }` and enrich the list row with `property_name, apartment_code, bed_code, vendor_name, receipt_url, billing_month, locked`.
4. **Gotchas**: multi-bed expenses split via `expense_bed_allocations` (rounding: last bed absorbs remainder); single-row `bed_id` is null when split. `billing_month` is a separate stored column, not always `expense_date`'s month for legacy/imported rows. `data_source==='locked'` blocks edit/delete. Expenses linked to `ticket_resolution_id` reverse-sync cost fields on write (write-only concern).

---

## ⑥ RentalPaymentsTab.tsx (owner/asset payouts)

1. **Source**: `owner_payments` table (`id, organization_id, owner_id, contract_id, apartment_id, bank_account_id, base_amount, escalated_amount, bill_date, due_date, actual_due_date, payment_month, status, paid_date, payment_mode, reference_number, notes, created_at`) joined to `owners.full_name`, `apartments.apartment_code`/`property_id`. Org-scope: `organization_id`. Standalone implementation (not a wrapper around `AssetPaymentsTab.tsx`).
2. **What it shows**: Row: Owner, Apartment, Month (`payment_month`), Bill Date, Due Date, Amount (`escalated_amount`), Status badge, Paid Date, Mode, Ref #. Status is computed, not just stored: `paid` if `status==='paid'`; else `overdue` if `due_date<today`; else `pending`. KPIs (all filtered on `bill_date`, not `due_date`/`payment_month`): Total billed = Σ`escalated_amount`; Total received = Σ`escalated_amount` where paid; Total outstanding = Σ`escalated_amount` where not paid. Filters: property, bill month, status, search.
3. **Mobile gap**: Partially covered by `listOwnerPayments` (id, owner_id, amount, payment_date, payment_mode, notes). Missing: owner/apartment/property names, `bill_date`, `due_date`, computed status, `reference_number`, KPI totals, filters. Add `getOwnerPaymentsSummary(period?) -> { totalBilled, totalReceived, totalOutstanding }` and enrich list with `owner_name, apartment_code, property_id, bill_date, due_date, status, computedStatus, reference_number`.
4. **Gotchas**: display/KPI amount is always `escalated_amount` — web never falls back to `base_amount` (mobile's `escalated_amount ?? base_amount` fallback is a divergence). Period bucketing uses `bill_date` (arrears convention — e.g. March rent billed in April lands in April). "Overdue" is derived (`due_date < now && status!=='paid'`), not stored.

---

## ⑦ GstBillingTab.tsx

1. **Source**: Filed workings from `gst_monthly_workings` (`id, organization_id, month, year, generated_at, generated_by, tenant_json, summary_json, rcm_json, last_updated_at`), org-scope `organization_id`. "Current" (unfiled) sub-tab computes live from `tenant_allotments` + `lifecycle_config` (gst_exemption_days, gst_short_stay_rate, gst_rcm_rate, gst_applicable_minimum_rent) + journal views `v_tenant_ledger`/`v_pnl_by_category` + `invoices`/`invoice_line_items`.
2. **What it shows**: "Current": per-tenant GST row (tenant, property/room, status, dates, days stayed, rent, GST-applicable amount, onboarding/exit charges, Exempt/Taxable category, rate%, GST amount) + summary: Total Revenue = rentPaid + shortStayHistoricalRent + onboardingCharges + exitCharges; Exempt = revenue below minimum-rent/within exemption days; Taxable = Total − Exempt; GST = Taxable × short_stay_rate% (default 5%); RCM = ownerRentBase × rcm_rate% (default 18%). "Filed": saved workings list (month/year/generated_at/by + totals), paginated 10/page, filters: status, GST category, property, tenant search.
3. **Mobile gap**: Net-new (mobile has nothing for GST). Add read-only `getGstFiledWorkings() -> { id, month, year, generatedAt, generatedByName, totalRevenue, exemptAmount, taxableAmount, gstAmount, ownersInvoiceAmount, rcmGstAmount }[]` reading only the aggregate fields from `summary_json`/`rcm_json` — the live "Current" generator depends on ledger views and is out of scope for v1.
4. **Gotchas**: GST config is per-org and time-varying (latest `lifecycle_config` row by `from_date`) — filed historic workings may reflect different rules than "current". Money rounded with `Math.ceil`, not standard rounding. "Current" tab is expensive (multiple view queries per click) — don't poll it; Filed table is the cheap path. No DB uniqueness on month/year — duplicate filed rows are possible.

---

## ⑧ SettlementsTab.tsx (deposit settlements)

1. **Source**: `deposit_settlements` table (`id, organization_id, tenant_id, allotment_id, deposit_amount, pending_rent, pending_eb, pending_late_fees, damages, other_deductions, total_deductions, refund_amount, settlement_date, status, notes, is_deleted`), org-scope `organization_id`. Refund proof/status also touches `tenant_exits` (`refund_status, refund_date, refund_reference, refund_bank_id, refund_proof_url`). Most data is passed in as props from the parent container, not fetched in-component.
2. **What it shows**: Row: Tenant, Deposit, Rent Due, EB Due, Late Fees, Damages, Total Deductions, Refund (green if `status==='completed'`), Status badge (`settled`|`completed`), Date. KPIs: Total Deposits = Σ`deposit_amount`, Total Refunds = Σ`refund_amount` (property/month filtered). Formula: `total_deductions = pending_rent+pending_eb+pending_late_fees+damages+other_deductions`; `refund_amount = deposit_amount - total_deductions` (can go negative → "Amount Payable"). No grouping. Filters: property, month, search.
3. **Mobile gap**: Net-new (distinct table from `tenant_adjustments`/`receipts`/`invoices`). Add `getDepositSettlements(period?) -> { id, tenantName, allotmentId, depositAmount, pendingRent, pendingEB, pendingLateFees, damages, otherDeductions, totalDeductions, refundAmount, status, settlementDate, notes, refundProofUrl }[]`.
4. **Gotchas**: `refund_amount` can be negative — must branch label "Refund" vs "Amount Payable", not just recolor. `refund_proof_url` may come from `tenant_exits` join or a same-named column on the settlement row — verify which the join returns. `status` is free text (`'settled'`/`'completed'`), match exact casing. Round only at render time, not before summing.

---

## ⑨ LedgerTab.tsx (Tenant Ledger)

1. **Source**: VIEW `v_tenant_ledger` (built on `journal_entries`, NOT a raw table — do not use deprecated `tenant_transactions`). Columns: `organization_id, tenant_id, allotment_id, entry_date, posted_at, journal_entry_id, is_reversal_of, source_table, source_id, description, account_code, account_name, debit, credit, running_balance, memo, property_id, apartment_id, bed_id`. Org-scope: `organization_id`. Related views: `v_tenant_current_dues`, `v_tenant_aging`, `v_invoice_settlement_status`.
2. **What it shows**: Grouped by tenant or by apartment (toggle). Per-tenant summary: status badge, Total Charges (Σ debit), Total Payments (Σ credit), Outstanding Due (`openingDue + totalCharges − totalPayments`), Deposit Balance. Grand-totals footer across filtered rows. Expand → full transaction list with `account_code`, category badge (INVOICE/PAYMENT/DEPOSIT_UTILIZED/etc.), `running_balance`. Filters: groupBy, status, balance-only, search, allotment view (current/all); period cuts the ledger off at the period's TO date (cumulative-to-date, not period-only).
3. **Mobile gap**: Net-new — the double-entry ledger view mobile currently lacks (distinct from raw `tenant_adjustments`/`receipts`/`invoices`). Add `getTenantLedger(tenantId | allotmentId, period?) -> { entries: {entryDate, journalEntryId, accountCode, accountName, sourceTable, description, debit, credit, runningBalance, category}[], summary: {totalCharges, totalPayments, outstandingDue, depositBalance} }`.
4. **Gotchas**: must filter reversal pairs — drop any row with `is_reversal_of` set AND the row it reverses (`journal_entry_id` referenced by another's `is_reversal_of`), or charges/payments double-count. Supabase caps at 1000 rows/request — web batches 50 allotment IDs per query with manual `.range()` pagination; large orgs need the same. `running_balance` is pre-computed by the view — don't re-derive from debit/credit deltas (opening balances matter). Fixed account codes: `1200`=AR-Tenants, `2100`=Tenant Deposits Held, `2400`=Tenant Booking Advance.

---

## ⑩ TrialBalanceTab.tsx

1. **Source**: No table/view — two RPCs: `get_trial_balance_detailed(p_org, p_from, p_to)` and `get_account_rollup(p_org, p_from, p_to)`. Comment: "No client-side aggregation." Returns per leaf-account: `account_id, code, name, account_type (ASSET|LIABILITY|EQUITY|INCOME|EXPENSE), normal_balance (DEBIT|CREDIT), parent_id, depth, total_debit, total_credit, balance, cum_total_debit, cum_total_credit, cum_balance, is_active`. Rollup RPC pre-aggregates up the tree (`*_rollup` fields). Org-scope: `p_org` arg.
2. **What it shows**: 3 tabs — Trial Balance (account tree indented by depth; ASSET/LIABILITY/EQUITY show cumulative columns, INCOME/EXPENSE show period columns; two separate integrity badges: "Period balanced" and "As-of balanced"); Balance Sheet (point-in-time cumulative: Assets vs Liabilities+Equity+RetainedEarnings, `retainedEarnings = totalIncome − totalExpense`); Income Statement (period-only Income/Expense/NetProfit/margin%). Leaf rows drill into `AccountDrillDownDrawer` (journal entries). Period filter drives `p_from`/`p_to`, default current FY.
3. **Mobile gap**: Net-new — unrelated to the raw tables mobile reads. Add `getTrialBalance(period) -> { rows: {accountId, code, name, accountType, normalBalance, parentId, depth, periodDebit, periodCredit, periodBalance, cumDebit, cumCredit, cumBalance}[], periodTotals: {debit, credit}, asOfTotals: {debit, credit} }` (thin passthrough of `get_trial_balance_detailed`; rollup is a v2 addition).
4. **Gotchas**: debit=credit invariant is checked TWICE independently (period totals for INCOME/EXPENSE vs cumulative for ASSET/LIABILITY/EQUITY, tolerances ~0.01/~0.5) — do not combine into one check or you'll get false imbalance. Which column family to show (period vs cumulative) is account-type-dependent, branch per row. Cumulative query effectively spans from inception (`1970-01-01`) — expensive; web caches with `staleTime: 60s`. Parent/rollup rows come only from `get_account_rollup`, never sum children client-side.

---

## ⑪ ProfitabilityTab.tsx

1. **Source**: No direct queries — consumes arrays from `useAccountingData()`: `invoices`, `expenses` (joined category), `owner_payments`, `tenant_adjustments`, `owner_contracts`, `bed_rates`, plus `properties`/`apartments`/`beds`/`tenant_allotments`. All underlying queries filter `organization_id`. Note: `lifecyclePayments` is hardcoded to `[]` upstream (dead/unwired in this build).
2. **What it shows**: Drill-down grid Property → Apartment → Bed → bed-month-detail. 5 summary cards: Revenue, Lifecycle Revenue (always $0 currently), Total Costs, Net Profit, Margin%. Row: Revenue, Expenses (direct + apportioned shared/apartment/property expense weighted by `bed_rates` share), Rental Cost (= `owner_payments.escalated_amount`), Profit, Margin%, Occupancy% (windowed to FY range), Rev/Bed. Formula: `profit = revenue − totalExpense − rentalCost`. Filters: FY period (incl. custom range), search, breadcrumb, XLSX export.
3. **Mobile gap**: Genuinely additional vs mobile's `getPropertyPnL`/`getBedProfitability` — richer accrual waterfall with drill-down levels, FY-windowed occupancy, owner-payout netting, weighted expense apportionment. Add net-new `getProfitabilityDrilldown(period, level, parentId?) -> { id, name, revenue, directExpense, sharedExpenseShare, totalExpense, rentalCost, profit, margin, occupancy?, revPerBed? }[]`.
4. **Gotchas**: rental-cost FY attribution uses `bill_date` (arrears), same as RentalPaymentsTab. Shared/property-level expense apportionment weight = bed's `bed_rates.monthly_rate` ÷ apartment total (falls back to equal split); property-level expenses only spread across "Live" apartments. Per-step rounding means drill levels won't sum exactly to parent totals. Bed-rate lookup is date-effective with property→global fallback.

---

## ⑫ ExitReconciliationTab.tsx

1. **Source**: VIEW `v_exit_reconciliation_worklist` — `organization_id, tenant_id, allotment_id, property_id, apartment_id, bed_id, tenant_name, property_name, bed_label, bed_code, apartment_code, actual_exit_date, dues_now, deposit_held, eb_already, exit_charge_already, settlement_status`. Also `organization_bank_accounts` for the refund-bank picker. Org-scope: `organization_id`.
2. **What it shows**: One row per exited tenant with a non-zero ledger (already-settled exits drop off the view — it's a live worklist, not a historical report). Columns: Tenant (→ full statement side-sheet), Bed, Exit date, Dues now, Deposit held, +EB/+Exit charge, computed Dues-after, Refund, Refund date, Bank, Reference. No period/property filter — search + client pagination (50/page). Formula: `duesAfter = round(dues_now + ceil(addEb) + ceil(addExit))`; `refund = max(round(deposit_held − max(duesAfter,0)), 0)` (user-overridable); balanced iff deposit_held ≈ appropriated + refund (±₹1).
3. **Mobile gap**: Net-new. Add `getExitReconciliationWorklist() -> { allotmentId, tenantId, tenantName, propertyName, bedLabel, actualExitDate, duesNow, depositHeld, ebAlready, exitChargeAlready, settlementStatus, duesAfter, refund, balanced }[]` — display-only; compute `duesAfter`/`refund`/`balanced` client-side from the raw fields, skip the edit/save/delete flow.
4. **Gotchas**: this is a backlog-cleanup worklist, not a period/FY report — no date filter makes sense here, and it only shows unsettled exits. Underlying commit (`reconcile_exit_settlement` RPC) posts journal entries transactionally server-side — a read view must never claim authoritative refund math, only display the current suggestion. Refund is manually overridable, so "expected" can diverge from what was actually paid.

---

## ⑬ ReportsTab.tsx

1. **Source**: Same prop-drilled arrays as ProfitabilityTab (`invoices`, `receipts`, `expenses`, `properties`, `apartments`, `beds`, `allotments`, `electricityReadings`, `ownerPayments`) — no in-file queries. A 3-tab index that renders 3 self-contained client-computed reports (not links elsewhere).
2. **What it shows**: Tab 1 P&L by Property: Revenue (Σ `invoices.total_amount`), Expenses (Σ `expenses.amount`), Profit = revenue−totalExpense (no rental-cost subtraction), Occupancy% (current snapshot: `staying_status in ('Staying','On-Notice')`), Rev/Bed, EB Margin (billed − actual). Tab 2 Bed Profitability: Revenue by `bed_id`, Cost = direct bed expenses + shared property expenses ÷ live-bed-count, Profit; Live beds only. Tab 3 EB Reconciliation: EB Billed/Actual/Variance/Variance%. No date/period filter anywhere in this file.
3. **Mobile gap**: Cosmetic overlap only — this is essentially mobile's existing `getPropertyPnL`/`getBedProfitability`/`getEBReconciliation` (same shape, similar names), NOT net-new. But confirm formulas match: this tab's "profit" has no rental/owner-payout cost subtracted (unlike ProfitabilityTab's richer formula) and occupancy is a simple current-snapshot count — verify mobile's existing 3 actions mirror *this* simpler formula, not ProfitabilityTab's.
4. **Gotchas**: ReportsTab "profit" and ProfitabilityTab "profit" are NOT reconcilable against each other for the same property — different formulas (no rental-cost subtraction here). Occupancy definitions also differ between the two tabs (snapshot vs FY-windowed). Bed Profitability silently filters to Live beds only, no toggle. No pagination — assumes full arrays in memory.

---

## Summary: net-new vs already-covered

- ⑤ Expenses — already covered (`listExpenses`), gaps: property/vendor/receipt/lock/KPI/filters
- ⑥ Rental Payments — already covered (`listOwnerPayments`), gaps: owner/apartment names, status logic, KPI/filters
- ⑦ GST Billing — net-new
- ⑧ Settlements — net-new
- ⑨ Tenant Ledger — net-new
- ⑩ Trial Balance — net-new
- ⑪ Profitability — net-new (richer than existing reports, not a duplicate)
- ⑫ Exit Reconciliation — net-new
- ⑬ Reports (P&L/Bed/EB tab) — already covered (mobile's `getPropertyPnL`/`getBedProfitability`/`getEBReconciliation`), verify formula parity only

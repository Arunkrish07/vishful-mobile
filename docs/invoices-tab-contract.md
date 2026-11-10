# Invoices Tab — Web → Mobile Parity Contract

Source of truth (READ-ONLY, not modified):
`C:\vishful-web-v7\external-db-guide-f04b8927-main\src\components\accounting\InvoicesTab.tsx` (2353 lines)
Supporting: `src/lib/tenant-ledger.ts` (`getInvoicePreviousBalance`), `src/lib/invoice-html-builder.ts`,
`src/lib/pdf-download.ts`, `src/services/whatsappSendJobService.ts`, `src/services/whatsappBackgroundSend.ts`,
`src/services/outstandingReminderService.ts`, `src/hooks/useWhatsappSentMap.ts`, `src/integrations/supabase/types.ts`.

Mobile (read for gap analysis only): `screens/AccountingScreen.tsx` (`section === 'invoices'`),
`convex/accounting.ts` (`listInvoices`, `createInvoice`, `recordPayment`), `lib/invoicePdf.ts`.

---

## 1. What the web Invoices tab displays

### Filters / search / sort (all client-side, over the `invoices` prop already loaded by the parent)
- **Property** filter (`propertyFilter`, `all` default) — matches `inv.property_id`.
- **Month** filter (`monthFilter`) — matches `inv.billing_month` (`yyyy-MM`); defaults to the *current calendar month*; the dropdown is populated only from months that actually have invoices (`availableMonths`, optionally bounded by an external `periodFilter`).
- **Status** filter (`statusFilter`, `all` default) — options `pending | partial | paid | overdue | excess` (lower-case value, compared case-insensitively against `getTenantInvoiceStatus(tenant_id)` — see §6, this is **per-tenant**, not per-invoice).
- **Search** (`searchQuery`) — matches (case-insensitive, substring) against `apartment_code-bed_code`, `tenants.full_name`, `invoice_number`.
- **Sort** (`sortKey`/`sortDir`, click column header, `ArrowUp/Down` icon) — sortable columns: `location` (apt-bed string), `tenant` (name), `status_badge` (tenant-status label, not the ledger status), `rent`, `actual_eb`, `est_eb`, `other`, `total`. Numeric columns sort numerically; text columns via `localeCompare(..., {numeric:true})`.

### List/table columns (per invoice row)
Checkbox (bulk-select) · **Apt‑Bed** (badge, colored by *staying* status — Staying/On‑Notice/Vacated, from `tenant_allotments.staying_status`, **not** invoice status) · **Tenant** (`tenants.full_name`) · **Rent** (`rent_amount`, inline-editable) · **Actual EB** (`electricity_amount`, inline-editable) · **Est. EB** (`estimated_eb`, inline-editable) · **Others** (`other_charges`, inline-editable) · **Total** (`total_amount`, bold, not editable directly) · **Status** badge (`getTenantInvoiceStatus`, colors in `STATUS_BADGE_COLORS`) · **Actions** (audit-log icon, PDF-download icon, lock/unlock icon, delete icon).
A totals row at the bottom sums Rent / Actual EB / Est EB / Others / Total across the *filtered* set.
Clicking anywhere on a row (not the checkbox/actions cell) opens the detail Sheet. Clicking a Rent/EB/Other cell directly starts **inline edit** of that one field (see §3).

### Summary/KPI cards above the table (over the *filtered* set `sorted`, not all invoices)
4 cards: **Rental** = Σ`rent_amount`; **Electricity (EB)** = Σ`electricity_amount` + Σ`estimated_eb`, with a sub-line showing Actual vs Est split; **Other Charges** = Σ`other_charges`; **Total Revenue** = Σ`total_amount`. Below the cards: `"{count} invoice(s)"`.

### Status derivation — READ THIS CAREFULLY (see §6 for the full gotcha)
The visible status badge (list row, filter, and detail-sheet header) is **`getTenantInvoiceStatus(tenant_id)`**, computed as:
```
out = v_tenant_current_dues.ar_balance for that tenant   (Σ debits − credits on ledger account 1200)
if |out| <= 0.5        → "Paid"
else if out < 0        → "Excess"
else if day-of-month>7 → "Overdue"
else out < lastInvoiceTotal(tenant) → "Partial"   (lastInvoiceTotal = most recent invoice's total_amount for the tenant)
else                    → "Pending"
```
This is a **per-tenant** aggregate (every open invoice for the same tenant shows the *same* badge), not per-invoice. It reads `v_tenant_current_dues` (view, org-scoped, columns: `tenant_id, ar_balance, allotment_id, net_dues, deposit_held, booking_advance, …`), fetched once for the whole org via `fetchAllRows(...).select('tenant_id, ar_balance').eq('organization_id', orgId)` and summed per tenant into a `Map`.

A **separate, per-invoice** FIFO-settlement calculation (`invoicePaidMap`, walking invoices oldest-first against pooled `receipts` per allotment) also exists and feeds a function `getComputedStatus` with values `Paid | Partial | Overdue | Pending | Generated` — **but `getComputedStatus` is dead code**: it is defined (lines ~587-610) but never called anywhere in the component. It is not what users see.
There is also a canonical **per-invoice ledger view `v_invoice_settlement_status`** (`invoice_id, amount_settled, amount_outstanding, invoice_amount, settlement_status, allotment_id, tenant_id, source_table`) that exists in the schema and is used elsewhere in the app (e.g. mobile's own `listInvoices` — see §6) — **the web Invoices tab does not query it at all.**

---

## 2. Invoice detail (Sheet, opened by clicking a row — `openDetail(inv)`)

On open, two parallel reads (`Promise.all`):
- `invoice_line_items` — `select('*').eq('invoice_id', inv.id).order('created_at')`
- `eb_tenant_shares` — `select('*').eq('invoice_id', inv.id)`

Sheet contents, top to bottom:
1. Header: `Invoice {invoice_number}`, Locked badge (if `locked`), Edit button (if not locked/not tenant-view), Download-PDF button (renders the *displayed* sheet DOM via html2canvas → jsPDF, not the templated PDF), tenant status badge (`getTenantInvoiceStatus`).
2. Staying-status badge (apt-bed · Staying/On-Notice/Vacated).
3. Key facts grid: Tenant, Unit (apt-bed), Month, Due date, Property.
4. **Detailed Line Items** table (from `invoice_line_items`): columns Type (`line_type`, e.g. `rent`/`electricity`/`estimated_eb`/`exit_charges`/`late_fee`/`onboarding`), Description, Amount.
5. **Computation breakdown blocks**, built from each line item's `metadata` JSON (falls back to `eb_tenant_shares` row for EB when line-item metadata is empty):
   - *Rental Computation*: Bed Rate, Discount, Premium, Effective Rate, Days in Month, Stay Days, Per Day Rent, Total Rent.
   - *EB Computation*: Total Units, Unit Cost, Total Apt EB, Total Tenant Days, Per Day EB Rate, Tenant's Days, Tenant's EB — plus, if `metadata.all_tenants` present, a per-tenant EB-share sub-table.
   - *Estimated EB* note block (stay days × per-day rate).
   - *Exit Charges* note block (total stay days, "< 1 year" note).
6. **Invoice Summary** table: Rental Due, Actual EB, Estimated EB, Late Fee, Exit Charges (split out of `other_charges` when a matching `exit_charges` line item exists), remaining Other Charges, **Total Amount Due** (`total_amount`), Amount Paid (`amount_paid`, green, shown only if >0), **Balance Due** (`balance`, red/bold).
7. In **edit mode** (see §3): inline form for Rent / Actual EB / Estimated EB / Late Fee / Other Charges with a live New Total and Save/Cancel.

Payment **history** (a list of individual receipts/payments) is **not shown anywhere in the Invoices tab** — not in the list, not in the detail sheet. (It lives in the separate Collections/Receipts tab, filterable by tenant, and in `receipt_allocations` which links a receipt to the invoice(s) it settled — but InvoicesTab never queries `receipts` or `receipt_allocations` for display, only for the FIFO `invoicePaidMap` calc.)

---

## 3. Actions on an invoice — exact table/operation per action

| Action | Trigger | Table(s) + operation | Notes |
|---|---|---|---|
| **Edit** (full form, in detail sheet) | Edit button → Save | `invoices` **update**: `rent_amount, electricity_amount, estimated_eb, late_fee, other_charges, total_amount, balance, status` (`status` recomputed client-side as `balance<=0?'paid':paid>0?'partial':'pending'`) `.eq('id', invoiceId)`. Then `invoice_line_items` **delete all** `.eq('invoice_id',...)` + **insert** fresh rows for each non-zero field (`replaceAllLineItems`, mapping `rent_amount→'rent'`, `electricity_amount→'electricity'`, `estimated_eb→'estimated_eb'`, `other_charges→'exit_charges'`, `late_fee→'late_fee'`, `onboarding_charges→'onboarding'`). Blocked if `invoice.locked`. Writes `audit_logs` via `auditLog('invoices', id, 'updated', editForm)`. Then `rebuildTenantTransactions(allotment_id)` to resync the ledger. | No Convex equivalent today. |
| **Inline edit** (single cell, in list row) | Click a Rent/Actual-EB/Est-EB/Other cell | Same `invoices` update + `replaceAllLineItems` + `audit_logs` + `rebuildTenantTransactions`, but for one field at a time (`saveInlineEdit`). Blocked if locked or `isTenantView`. | Same underlying write path as full edit. |
| **Add Invoice** (manual create) | "Add Invoice" dialog | `invoices` **insert** (fields: `organization_id, tenant_id, property_id, apartment_id, bed_id, allotment_id, invoice_number, invoice_date, due_date, billing_month, rent_amount, electricity_amount, estimated_eb:0, late_fee, other_charges` [= `other_charges + onboarding_charges` combined], `total_amount, amount_paid:0, balance:total_amount, status:'pending', invoice_type` ['exit_charge' if only other_charges>0, else 'regular']). Invoice number generated client-side: `{propertyAbbr}/{FY}/{MM}/{00001}` via a `count` query on `invoices`. Then `invoice_line_items` insert (rent/electricity/exit_charges/late_fee/**onboarding** as separate line types — note: `onboarding_charges` is NOT an `invoices` column, it only exists as a line-item). Then `rebuildTenantTransactions(allotment_id)`. | Mobile's `convex/accounting.ts createInvoice` already exists but only writes `rent_amount/electricity_amount/other_charges/total_amount` — no `estimated_eb`, no line items, no onboarding-charge support, no client-visible invoice-number preview, no ledger rebuild call. |
| **Delete** (single) | Trash icon (list row), requires `canPerform('invoice.delete')`, blocked if `locked` | **Hard delete**, not soft: `eb_tenant_shares` delete `.eq('invoice_id',id)` + `invoice_line_items` delete + `receipt_allocations` delete (all in parallel), then `invoices` **delete** `.eq('id',id)`. `audit_logs` write, then `rebuildTenantTransactions`. | `invoices.is_deleted` column exists in the schema but this component **never sets it** — it does true hard deletes. Mobile's `listInvoices` filters `is_deleted.is.null,is_deleted.eq.false` (defensive, but nothing in web's Invoices tab ever soft-deletes an invoice). |
| **Bulk delete** | Toolbar "Delete (N)", same permission/lock rules | Same 4-table cascade as single delete, batched 40 IDs at a time; skips locked rows and reports how many were skipped; rebuilds ledger for all affected allotments. | |
| **Lock / Unlock** | Lock icon (row) or bulk Lock/Unlock buttons, requires `canPerform('invoice.lock')` | Lock: `invoices` update `{locked:true, locked_by, locked_at}`. Unlock: opens `UnlockReasonDialog` (admin-only: `super_admin`/`org_admin`), captures a mandatory reason, then `invoices` update `{locked:false, unlocked_by, unlocked_at, unlock_reason}`. Both write `audit_logs`. | No mobile equivalent (no `locked` concept in mobile invoices at all). |
| **Void/Cancel** | — | **Does not exist** as a distinct action in this component. The only ways an invoice stops being "active" are (a) hard Delete, or (b) editing amounts down. There is no `status='void'`/`cancelled` state written here. | |
| **Mark paid / Record payment** | — | **Not done from the Invoices tab.** Paying an invoice happens by recording a `receipts` row elsewhere (Collections tab); a DB trigger then posts the journal and FIFO-allocates against `invoices`/`receipt_allocations`, which is what feeds `v_tenant_current_dues` / `v_invoice_settlement_status`. InvoicesTab only *reads* the resulting balance. | Mobile's `recordPayment` action (in `convex/accounting.ts`) inserts into `receipts` directly from the Invoices-tab payment modal — this is a **mobile-only UX shortcut**; the web app deliberately keeps "record a payment" out of the Invoices tab. |
| **Send** (single or bulk, WhatsApp) | "Send invoice (WhatsApp)" toolbar button (bulk, needs selection) | `runBackgroundInvoiceSend()` → queues a background job that (per `src/services/whatsappBackgroundSend.ts` / `whatsappSendJobService.ts`) generates the PDF client-side then calls Supabase **edge function `whatsapp-send-job`** (`supabase.functions.invoke('whatsapp-send-job', {...})`). Delivery success is later readable from table **`whatsapp_send_deliveries`** (`reference_id` = invoice id), which is what `useWhatsappSentMap` reads to decide "Generated" vs "Pending" in the (dead) `getComputedStatus` helper. | No per-invoice WhatsApp send in mobile at all. |
| **Send** (single, PDF only) | Download icon (list row) or Sheet's Download button | Client-side only: builds `InvoiceHtmlData` (invoice + `invoice_line_items` + `eb_tenant_shares` + tenant/property/apartment/bed + org PDF config + `getInvoicePreviousBalance()`), renders via `buildInvoiceInnerHtml`/`downloadInvoicePdf` (uses org's saved `invoice_pdf_configs` template: logo, colors, bank/UPI details, T&Cs). No DB write. | Mobile's `lib/invoicePdf.ts` builds a much simpler PDF from only the 8 fields `listInvoices` returns — no line items, no estimated_eb/late_fee lines, no previous-balance carry-forward, no org branding/bank/QR (see §4). |
| **Send Outstanding Messages** (bulk reminder, not per-invoice) | Toolbar dropdown | Preview via `fetchOutstandingReminderRecipients(orgId)` (reads ledger, not invoices), then `runBackgroundOutstandingSend()` → same `whatsapp-send-job` edge fn with a tenant-id list. | Not in scope for per-invoice parity, mentioned for completeness. |
| **Export** (PDF/CSV/Excel, list or selection) | Toolbar dropdown | Client-side only, no DB writes. PDF concatenates each selected invoice's templated HTML into one document. CSV/XLSX list the same 13 display columns. | Not required for parity; nice-to-have. |
| **Import from Excel** | Toolbar dropdown → upload | Bulk `invoices` insert/upsert (+ `invoice_line_items` insert) from a spreadsheet, with an "overwrite" mode that hard-deletes existing (unlocked) invoices for the same allotment+month first. | Out of scope for a mobile Invoices-tab port; admin/bulk-ops feature. |

---

## 4. Exact table/column names (verified against `integrations/supabase/types.ts`)

**`invoices`** (columns actually used by this component): `id, organization_id, tenant_id, property_id, apartment_id, bed_id, allotment_id, invoice_number, invoice_date, due_date, billing_month, invoice_type, rent_amount, electricity_amount, estimated_eb, late_fee, other_charges, total_amount, amount_paid, balance, status, locked, locked_by, locked_at, unlocked_by, unlocked_at, unlock_reason, is_deleted, created_at`.
Note: mobile's `listInvoices` selects a *subset* — `id, invoice_number, tenant_id, allotment_id, property_id, apartment_id, bed_id, billing_month, rent_amount, electricity_amount, other_charges, total_amount, amount_paid, due_date, status, is_deleted, created_at` — **missing `estimated_eb`, `late_fee`, `invoice_type`, `locked*`, `unlocked*`**.

**`invoice_line_items`**: `id, invoice_id, organization_id, line_type, amount, description, metadata (Json), created_at`. `line_type` values used: `rent, electricity, estimated_eb, exit_charges, late_fee, onboarding`. Mobile has **no read or write path for this table at all**.

**`eb_tenant_shares`**: `id, invoice_id, organization_id, tenant_id, apartment_id, billing_month, tenant_stay_days, per_day_rate, tenant_eb_charge, total_units, unit_cost, total_apartment_bill, total_tenant_days, created_at`. Mobile: not read.

**`receipt_allocations`**: `id, receipt_id, invoice_id, adjustment_id, amount, allocated_at, allocated_by, organization_id, notes`. This is the row-level link between a payment (`receipts`) and the invoice(s) it settles (FIFO). InvoicesTab deletes rows here on invoice delete but never displays them (no per-invoice payment-history list exists in this tab). Mobile: not read or written (mobile's `recordPayment` only inserts `receipts`; allocation is presumably left to a DB trigger, same as web).

**`v_tenant_current_dues`** (view): `tenant_id, organization_id, allotment_id, ar_balance, net_dues, deposit_held, booking_advance, charge_count, payment_count, last_charge_date, last_payment_date`. **This is what drives the visible status badge** (per tenant).

**`v_invoice_settlement_status`** (view, exists but unused by web's InvoicesTab): `invoice_id, tenant_id, allotment_id, organization_id, invoice_amount, amount_settled, amount_outstanding, settlement_status, invoice_date, source_table`. **This is what mobile's `listInvoices` already uses** for its per-invoice `status`/`paidAmount`.

**`whatsapp_send_deliveries`**: read via `.select('reference_id')`, filtered by kind + org, to know which invoices were WhatsApp-sent (feeds the unused `getComputedStatus` Generated/Pending distinction).

---

## 5. Data gaps: what mobile's current `listInvoices` + UI does NOT provide

All gaps below are relative to `convex/accounting.ts::listInvoices` and `screens/AccountingScreen.tsx` (`section==='invoices'`) as they stand today.

**New Convex *read* actions needed:**
1. `getInvoiceLineItems(invoiceId)` — wraps `invoice_line_items` select, needed for the Detail view's line-item table and the Rent/EB computation breakdown blocks. Not present at all today.
2. `getInvoiceEbShares(invoiceId)` (or fold into #1) — wraps `eb_tenant_shares`, used as the EB-metadata fallback.
3. `getTenantArBalances()` (or extend `listInvoices`) — wraps `v_tenant_current_dues` so mobile *can* reproduce the web's actual visible status if exact parity with web (not with the ledger view) is wanted (see §6 — this is a product decision, not just a data gap).
4. `getInvoicePreviousBalance(invoiceId, tenantId)` equivalent, if the PDF is to show carried-forward old dues like web's PDF does.

**New Convex *write* actions needed (currently zero write surface beyond create/recordPayment):**
5. `updateInvoice(id, fields)` — full-edit + inline-edit, must also replace `invoice_line_items` and call the ledger-rebuild equivalent (check if mobile's backend has a `rebuildTenantTransactions`-equivalent trigger already firing on `invoices` update, or if it must be called explicitly — **verify before implementing**, since mobile bypasses this app layer and talks to Supabase directly like web does).
6. `deleteInvoice(id)` / `bulkDeleteInvoices(ids)` — cascade delete across `eb_tenant_shares`, `invoice_line_items`, `receipt_allocations`, then `invoices`.
7. `lockInvoice(id)` / `unlockInvoice(id, reason)` — plus surfacing `locked` in `listInvoices` (column exists in `invoices` but is not currently selected).
8. `sendInvoiceWhatsApp(invoiceIds)` — mobile has no WhatsApp-send path for invoices at all; would need to either call the same `whatsapp-send-job` edge function or a Convex-side equivalent.

**UI gaps in `AccountingScreen.tsx` (frontend-only, once data exists):**
9. No invoice **detail view** — mobile only has list-card → "record payment" modal; there's no drill-down showing line items / computation breakdown / summary-with-balance the way web's Sheet does.
10. No **Estimated EB**, **Late Fee**, or **Exit-charges-vs-other** split shown anywhere (card shows Rent + Elec only; total/paid only).
11. No **lock/unlock**, **delete**, or **edit** affordance on mobile invoice cards.
12. No **"Excess"** status option in mobile's filter chips (`all/sent/partial/paid/overdue` vs web's `pending/partial/paid/overdue/excess`) — also note mobile's filter/status vocabulary (`sent`) doesn't match web's (`pending`/`Generated`/`Pending` naming — see §6 for why these differ semantically anyway).
13. No summary KPI row scoped to the *filtered* invoice set the way web's 4-card Rental/EB/Other/Total-Revenue block is (mobile has a `Total Invoiced` tile elsewhere in the header, not filter-scoped).
14. Mobile's `lib/invoicePdf.ts` PDF is missing: Estimated EB line, Late Fee line, previous-balance/old-dues carry-forward, org branding (logo/address/GST), bank/UPI/QR payment details — all present in web's templated PDF (`invoice_pdf_configs` + `buildInvoiceInnerHtml`).
15. No per-invoice **payment history** — but note this is also absent from web's Invoices tab (§2), so this is *not* a gap to close for parity; it would be a net-new feature beyond web parity if added.

---

## 6. Money/parity gotchas — read before writing any code

1. **Status vocabulary mismatch is real and load-bearing.** Web's Invoices-tab status badge (`getTenantInvoiceStatus`) is a **per-tenant** aggregate off `v_tenant_current_dues.ar_balance` — every invoice belonging to the same tenant shows the identical badge, and the value flips to "Overdue" purely based on **today's day-of-month being > 7** (not the invoice's own `due_date`), and to "Partial" vs "Pending" based on comparing outstanding vs the tenant's *most recent* invoice total (not this invoice's total). Mobile's current `listInvoices` instead computes a **per-invoice** status from `v_invoice_settlement_status.settlement_status` (with a paid/partial/overdue-by-due_date/sent fallback) — this is arguably the more "correct"/canonical per-invoice signal (and is in fact the view CLAUDE.md-style guidance would point you to), but it is **not what the reference web screen currently shows**. Decide explicitly which behavior "parity" means before porting: (a) copy web's exact (arguably confusing) per-tenant logic for pixel/behavior parity, or (b) keep mobile's canonical per-invoice ledger status and treat the web behavior as a known web quirk. Do not silently pick one without flagging it — the numbers *will* visibly diverge per invoice whenever a tenant has more than one invoice open.
2. **`v_invoice_settlement_status` is unused by the exact file being ported.** Don't assume "the web app uses the ledger view for invoice status" — grep this specific component; it doesn't. The ledger view is used elsewhere in the web app (worth reproducing) but not here.
3. **`getComputedStatus` (Paid/Partial/Overdue/Pending/Generated, per-invoice FIFO) is dead code in web** — don't port its exact behavior expecting it to match anything visible; it's unused.
4. **Balance/outstanding source for the Invoice Summary panel** is simply `invoices.balance` (`= total_amount − amount_paid`, maintained by whatever DB trigger/journal process updates it on receipt insert) — not re-derived from the ledger view in the detail sheet. If mobile's `invoices.balance` isn't being kept in sync the same way (verify the DB trigger fires identically for Convex-issued Supabase writes), the Summary panel numbers will drift from what the status badge implies.
5. **`onboarding_charges` is not an `invoices` column** — it only ever becomes an `invoice_line_items` row (`line_type:'onboarding'`); on create it's folded into `other_charges` on the invoice header. Don't add an `onboarding_charges` column to any Convex write payload for `invoices` itself.
6. **Hard delete, not soft delete**, is what this component actually does (`is_deleted` is never set here) — despite the column existing and mobile's read path defensively filtering on it.
7. **Edits always fully replace line items** (delete-all-then-insert-non-zero), never patch individual line items — replicate that pattern rather than trying to diff/update.
8. **Every write (edit/delete/lock) triggers `rebuildTenantTransactions(allotment_id)`** client-side after the Supabase write — if mobile relies on a DB trigger to do the equivalent automatically, confirm it actually fires for the mutation path mobile will use; if not, mobile writes will leave the ledger stale even though the `invoices` row itself looks right.
9. **KPI totals and the totals table row are computed over the *filtered* list (`sorted`)**, not all invoices — a mobile "Total Invoiced" tile that sums *all* invoices regardless of the active filter will not visually match web's per-view totals in a side-by-side.

---

## Summary of top gaps mobile must close for parity

1. **Status semantics diverge by design** (web = per-tenant AR-balance badge shown for every invoice of that tenant; mobile = per-invoice `v_invoice_settlement_status` badge) — this needs a product decision before any UI work, not just a data fetch.
2. **No line-item / computation-breakdown data path exists in Convex** (`invoice_line_items`, `eb_tenant_shares` are never read), so mobile cannot show the Rent/EB breakdown, and the mobile PDF is missing Estimated EB, Late Fee, and previous-balance lines that web's PDF has.
3. **No write actions for edit/delete/lock/send** exist on the mobile backend at all — only create + record-payment — so lock/unlock, void-by-delete, and WhatsApp send are 100% net-new Convex actions, each needing the matching cascade-delete/ledger-rebuild/edge-function behavior documented above to stay money-safe.

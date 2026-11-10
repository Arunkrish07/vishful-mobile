# Mobile ↔ Web Parity Audit — Consolidated Report (v7 web, 2026-08-20)

Source of truth: web app v7 extracted at `C:\vishful-web-v7\external-db-guide-f04b8927-main`.
Method: 11 parallel per-area audits (mobile `screens/*.tsx` vs web `src/pages` + components/services), synthesized.
Result: 99 raw gaps, 0 P0, 14 P1, ~27 P2, rest P3.

## 1. Executive Summary

Parity is **high on read/CRUD surfaces and low on money-movement, bulk-ops, and evidence-viewing flows**. Mobile faithfully mirrors web for core lists, detail views, KYC add/edit, ticket lifecycle, owner/asset/electricity management, and dashboards/reports (often a superset). The 14 P1s cluster in four themes: (a) reconciliation flows missing/unreconciled (no UPI/bank auto-match, no standalone collection, EB payments lack bank account, no outstanding-reminder send); (b) data can't be created/repaired on mobile (no tenant merge, no KYC-QR issuance, no in-app tenant KYC form, no salary/pay-slip system, no Excel import/export); (c) evidence/monitoring invisible (ticket photos never render, "Current EB" tab absent, WhatsApp log has no search); (d) architecture divergence in WhatsApp Logs (job-card vs flat per-message). P2s risk ledger drift (invoice status from stored `status`, CC-fee recovery unverified) and cross-app inconsistency (Team `exit_type` enum, KYC URL `/kyc` vs `/vista/kyc`).

## 2. Top Gaps (by severity)

| Sev | Screen | Gap | Fix hint |
|---|---|---|---|
| P1 | Dashboard | Discrepancy alerts hardcoded to 0, never fire | Fetch beds+active allotments, reuse findBed/TenantDiscrepancies |
| P1 | Tenants | Merge-duplicate-tenants flow missing | Add Merge button + `tenants.mergeTenants` action |
| P1 | PropertyDetail | Can't ISSUE a KYC QR (view-only) | Add `sb.issueKycToken(propertyId)`, call on modal open |
| P1 | Accounting | UPI/bank-statement auto-match absent | Large; Convex action mirroring `buildAutoMatchPreview` |
| P1 | Accounting | Outstanding-reminder send missing | Action mirroring `fetchOutstandingReminderRecipients` + preview |
| P1 | Accounting | No standalone collection (payment not tied to one invoice) | "Add Collection" modal → `recordReceipt` wrapper |
| P1 | Electricity | "Current EB" live-monitoring tab missing | Port `computeEbSlabBill` + `EB_DANGER_THRESHOLD` |
| P1 | Electricity | EB payment has no bank-account field / non-cash validation | Add bank picker, require for non-cash |
| P1 | Team | No salary / pay-slip system | Salary sub-view over `team_salary_bills` |
| P1 | Team | No Excel import/export | Likely deferred (XLSX-heavy) |
| P1 | WhatsAppLogs | No search box | Search input → server-filtered; port `classifySearchTerm` |
| P1 | WhatsAppLogs | Job-card model vs web flat per-message log | Add message-level list mirroring `fetchWhatsappDeliveryLogPage` |
| P1 | TicketDetail | Issue photos (`photo_urls`) never displayed | Add PHOTOS card mapping `photo_urls` + `log.photo_urls` |
| P1 | Tenant KYC | No in-app KYC form (tenant can't complete KYC) | New TenantKycScreen; tappable profile status row |
| P2 | PropertyDetail | KYC URL `/kyc` vs `/vista/kyc` (can 404) | Add `/vista` to template |
| P2 | Accounting | Invoice status from stored `status`, not journal AR | Journal-derived status in `listInvoices` |
| P2 | Accounting | CC-fee auto-recovery unverified on mobile | Confirm `recordPayment` mirrors `autoRecoverCcCharges` |
| P2 | Team | `exit_type` enum diverges from web | Change EXIT_TYPES to web's set |
| P2 | Tickets | `completed` in Closed tab (mobile) vs Open (web) | Move `completed` into open group — SEE CONFLICT NOTE |
| P2 | Tickets modal | Admin New-Ticket modal has no Linked-Asset picker | Port `computeTicketAssetSuggestion` |
| P2 | CreateTicket | Admin flow blocks past Bed (should be optional) | Gate on `selectedProperty` not `selectedBed` |
| P2 | TenantLifecycle | Occupancy Intelligence dashboard is a stub | Implement; reuse bedCounts + prev-month snapshot |
| P2 | PropertyDetail | Apartment form missing Owner (`owner_id`) selector | Add `sb.listOwners` + PickerSelect |
| P2 | Properties | Property form missing GPS lat/long | Add two numeric inputs |
| P2 | Electricity | EB Profit tab possibly replaced by different Analytics | Verify `getEBAnalytics` rows match |
| P2 | Accounting | Missing tabs (Adjustments, Ledgers, Settlements, GST…) | Prioritize Adjustments + read-only Tenant Ledger |
| P2 | TicketDetail | No Reopen / no admin Delete | Add Reopen+reason and admin Delete+confirm |

Additional P2/P3: bank field on Record Payment; PDF/WhatsApp send for invoices/receipts; WhatsAppLogs date/status/property/Outstanding filters + CSV; Team member-form fields + attendance-exempt dept + active-only toggle; Settings missing tabs (Email/Expense-Categories/Templates/Inventory/AI-Usage/WhatsApp); Owners XLSX import; apartment tax-frequency/EB-load/doc uploads; resolution maintenance-item catalog; announcement/home images; native voice on TenantHome; OTP one-time-code autofill hint.

## 3. Already Solid (parity good or mobile is a superset)

Reports & Analytics; Tenants KYC/Remarks/Rating; Tenant Lifecycle (booking/onboarding OCR/exit/refunds/registration PDF); Properties/Apartments/Beds/Rates + Discrepancies/Photos/availability recommender; Owners/Assets/Electricity core; Tickets full lifecycle (staff/tenant/technician) + AI classifier; Team/Settings/AuditLogs core CRUD; Auth two-step OTP; Market/Announcements CRUD.

## 4. Recommended Fix Order

1. **Quick correctness/data-integrity one-liners (low risk):** Dashboard discrepancy chips; KYC URL `/vista`; ticket `completed` grouping (SEE CONFLICT); Team `exit_type` enum; CreateTicket gate `selectedProperty`.
2. **Accounting reconciliation cluster:** journal-derived invoice status; verify/port CC-fee recovery; bank picker on Record Payment + "Add Collection"; then Adjustments tab + read-only Tenant Ledger; defer UPI auto-match / outstanding-reminder / PDF+WhatsApp send.
3. **Electricity cluster:** bank field + non-cash validation on EB payments; "Current EB" tab; verify EB-Profit.
4. **TicketDetail cluster:** render `photo_urls` + `log.photo_urls`; Reopen + admin Delete; admin-modal asset picker.
5. **Tenant self-service:** TenantKycScreen + tappable status; native voice; images.
6. **Tenants + Lifecycle:** merge-duplicates + `tenants.mergeTenants`; Occupancy Intelligence view.
7. **Properties/Apartments completeness:** Issue-KYC-QR; owner selector; GPS; tax-frequency/EB-load/doc uploads.
8. **Team salary system:** salary sub-view; member-form fields; defer XLSX.
9. **WhatsAppLogs:** search first; then flat per-message list vs layered filters + CSV.
10. **Settings + P3 polish.**

## CONFLICT NOTE — ticket `completed` grouping
The audit (reading v7 web) says web treats `completed` as an OPEN status; mobile currently groups `completed` under Closed (a deliberate earlier change on branch `feat/ticket-flow-parity`). Flipping this back to Open contradicts that prior decision — needs a product call before changing.

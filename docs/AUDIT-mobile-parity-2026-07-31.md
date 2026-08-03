# Mobile ↔ Backend Parity Audit — 2026-07-31

**Basis:** The web app source is not in this repo. `convex/*` + Supabase is the canonical contract both web and mobile call, so it is the source of truth. This audit compares every mobile screen against the backend contract it should implement.

**⚠️ Deploy constraint:** Convex deploy is BLOCKED (anonymous checkout, no account). Fixes are tagged:
- **[FE]** frontend-only — shippable now against already-deployed backend.
- **[BE]** needs a new/edited `convex/*` action deployed — cannot go live yet.
- **[FE*]** frontend workaround possible (e.g. direct supabase-js, or create-then-update raw row pattern) instead of a Convex deploy.

Totals: **3 P0**, **~22 P1**, **~24 P2**. ~85% are [FE] shippable now.

---

## P0 — Crashers / dead screens (fix first)

| # | Screen | Problem | Tag | Fix |
|---|--------|---------|-----|-----|
| P0-1 | TenantProfileScreen | `const formatDate = d => d ? formatDate(d,'') : null` shadows the import and calls itself → infinite recursion / stack overflow crash for any onboarded/on-notice tenant. `:143-144` used at `:229,232` | **FE** | Rename local to `fmt` or delete and use imported `formatDate(d,'')` |
| P0-2 | AnnouncementsScreen | List ALWAYS empty — loads via `sb.getAll('announcements')` which is a dead stub returning `[]`; real `listAnnouncements` never called. `:62,78` → supabaseService.ts:543-547 | **FE** | Call `sb.listAnnouncements()` (already wired at supabaseService.ts:932) |
| P0-3 | AnnouncementsScreen | Create/edit/delete/publish are silent no-ops — `insertRow/updateRow/deleteRow` are dead stubs that return success without persisting. `:114,166,196,242` | **BE / FE\*** | Backend has NO announcement write actions (anouncements.ts only list/image/whatsapp). Either add Convex CRUD **[BE]** or write via direct supabase-js **[FE\*]** (RLS permitting) |

---

## P1 — Broken or missing flows

### Permissions & Settings (Domain 1)
- **[FE]** App drawer gating locks out managed-admin roles (property_manager/admin/manager) — `canAccess` looks up permMap with capitalized names but map is keyed lowercase. App.tsx:119 vs SettingsScreen.tsx:21-69,319. Fix: normalize module keys both sides.
- **[FE]** Unknown non-tenant roles (e.g. `employee`) bypass ALL permission checks (`canAccess` returns true when `!isManaged`). App.tsx:66-67,117. Fix: deny-by-default DB lookup.
- **[FE]** Settings → Bank Accounts always empty — calls `api.settings.getBankAccounts` (doesn't exist); real is `api.tickets.getBankAccounts`. Error swallowed. SettingsScreen.tsx:241. Fix: call tickets namespace.
- **[FE]** Team add/edit sends `specializations` column; backend uses `specialties` → likely PostgREST 400. TeamScreen.tsx:155,193,287. Fix: rename to `specialties`.
- **[FE partial / BE full]** Organization save always errors — `updateOrgSettings` validator only accepts `costApprovalThreshold`; extra `organizationName` throws ArgumentValidationError. FE partial: send only threshold. Full org-fields persistence needs [BE].

### Tickets (Domain 4)
- **[FE]** TicketDetail — admin can never cancel / on-hold / reopen-closed. `getNextStatuses` omits those transitions though STATUS_CONFIG renders them and backend accepts them. ticketService.ts:151-157. Fix: add transitions.
- **[FE]** TicketDetail — scoped cost approvers never fetched/enforced (`getCostApprovers` exists in backend; Approve/Decline shown to every admin). TicketDetailScreen.tsx:1043-1062. Fix: wrap + gate.
- **[FE]** TicketDetail — admin approval modal is non-dismissable, blocks reviewing Details/Costs/Resolution before deciding. `:592-595`. Fix: drive visibility from `showApprovalModal` alone + open via banner.

### Analytics / Reports (Domain 6) — mostly field-contract drift
- **[FE]** Analytics "Owner Payouts" always ₹0 — reads bill_date/status/escalated_amount but `listOwnerPayments` returns only owner_id/amount/payment_date/mode/notes. `:317-321`. Fix: sum `op.amount` by `payment_date`.
- **[BE]** Analytics "Deposits Held" always ₹0 — TitleCase vs lowercased status AND `deposit_paid` not returned by `listAllotments`. Needs field exposed [BE]; status compare is [FE].
- **[FE]** Analytics BedPerformance — every bed shows Vacant (TitleCase vs lowercased `stayingStatus`). `:200`. Fix: normalize case.
- **[FE]** Analytics EB Paid/Variance wrong — reads `e.cat.key/category_key` but `listExpenses` returns `category`. `:232-233`. Fix: read `e.category`.
- **[BE]** Electricity monthly P&L all zero (`getEBAnalytics` builds `MMM-yy` vs invoices `YYYY-MM`). accounting.ts:311-330.
- **[FE]** Reports — `getPropertyPnL/getBedProfitability/getEBReconciliation/getOccupancyDetail` exist but never surfaced (only `getReportsSummary`). ReportsScreen.tsx:75. Fix: add tabs calling them.
- **[FE/BE]** Analytics computes money by client-side raw SUM of invoices/receipts/expenses (spec-forbidden off-ledger). Full fix wants canonical-view actions [BE]; partial cleanup [FE].

### Tenants (Domain 3)
- **[FE]** TenantHome — tenant's "Expected Exit" always "—": `getTenantNotices` uses `api.tenants.listNotices` (raw snake_case `exit_date`) but card reads `n.exitDate`. Fix: use `tenantsextraactions.listNotices` or read `n.exit_date`.
- **[FE*]** TenantHome — profile card hardcodes `staying_status:'Staying'` and `kyc_completed:false`. `:251-252`. Fix: read real values (may need getTenantLocation to surface status → possibly [BE]).

### Properties / Owners / Availability (Domain 2)
- **[FE*/BE]** Owners — editing a contract wipes escalation/lock-in/revenue-share/payment-schedule/rent-in-advance/notes (getOwnerDetail omits them; updateContract nulls them). Fix: return full row [BE] or read row via supabase-js + repopulate [FE*].
- **[FE]** Availability — apartments with gender Mixed/Any excluded from all recommendations. AvailabilityScreen.tsx:106-107. Fix: `['both','mixed','any'].includes(g) || g===tenantGender`.

### Electricity (Domain 7)
- **[FE]** EB Rates CRUD unreachable — `TABS` only has `readings`; rates/analytics/eb-payments tabs never reachable though fully coded. ElectricityScreen.tsx:248-251. Fix: restore tabs.
- **[FE]** "Add Payment" creates orphaned eb_payments (view/edit/delete lives in unreachable tab). Fix: restore payments tab (covered by above).

### Voice / Technician (Domain 5)
- **[FE] SECURITY** TenantTicketsScreen — Groq API key hardcoded in client bundle. `:41,149-151`. Fix: route transcription through server endpoint `/api/transcribe`.
- **[BE]** TenantTickets voice — tenant's forced issue-type selection is silently discarded (`/api/voice-ticket-direct` never forwards it; voiceProcessor re-classifies). Needs http.ts + voiceProcessor passthrough [BE].

---

## P2 — Correctness polish & cleanup

**Tickets:** cost approval can't modify qty/price [FE]; post-create "auto-assigned" message always wrong (reads `ticket.assigned_to_name`, actually in `diagnostic_data`) [FE]; "No cost required" ₹0 dead-ends in waiting_for_parts [FE]; diagnosis is 2-question stub, no AI [FE/BE]; cost_type 'labor' vs 'labour' [FE].

**Technician:** ProfileScreen status breakdown uses non-existent statuses (approval_pending/approved/work_done) & omits real ones [FE]; `complete` resets resolutionForm to malformed shape (missing vendorId/bankAccountId/refs, bad proofUrl key) [FE]; response/work time metrics perpetually null (no in_progress on happy path) [FE]; DiagnosticFlow hardcodes approver "Saraswathi P" [FE]; no-cost complete writes no ticket_resolutions row [FE/BE]; voice `apartmentCode` populated with bed code [FE]; ProfileScreen passes phone into tenantId arg [FE].

**Tenants:** `services/fetchTenantDetails.ts` queries non-existent tables (dead but latent) [FE]; backend `getTenantDetails` wrapper targets non-existent `allotments` table (dead) [FE/BE]; TenantsScreen check-in modal is a dead control that would fail (camelCase into snake_case insert) [FE]; exit tasks created but `listExitTasks` never surfaced [FE]; TenantProfile "Notice Date" hardcoded null [BE]; tenant self-service notice doesn't flip status [FE/BE]; exit settlement never captures actual EB dues (`ebCharges:0`) [FE].

**Accounting/Reports:** Analytics historical/forecast occupancy overstated (reads wrong exit field) [FE]; per-property receipt filter no-op (listReceipts lacks tenant_allotment_id) [BE]; receipts bucketed by created_at not payment_date [FE]; Reports fetch failures rendered as real ₹0/0% (no error state) [FE]; blank rent creates ₹0 invoice [FE]; legacy report actions unreferenced [FE].

**Settings/Dashboard/Auth:** LoginScreen branches on `result.reason` backend never returns (signup prompt never fires) [FE]; tenant-punctuality ignores last_2fy/last_5y [FE]; Organization tab GST/address/contact/website decorative [BE]; push notifications never registered/delivered [FE+BE]; background session validation nulls supabaseUserId each resume [FE]; Dashboard "tickets need attention" shows ≤5 slice length not activeTicketsV [FE]; Bank Accounts no delete path + is_primary not enforced [BE].

**Properties/Assets/Logs:** Assets edit doesn't recompute warranty_expiry [FE*]; Owners contract Renewal Periods not collected [FE]; PropertyDetail dead handleAddApt [FE]; Audit Logs missing performedBy/from/to filters [FE] + hardcoded table subset [FE]; Announcements no role gating [FE]; Market no role gating on Scan/Retry [FE]; WhatsApp Logs jobType filter not surfaced + stale "read-only" header [FE]; Electricity inconsistent payment-mode casings [FE]; getEBAnalytics fetched every focus but never rendered [FE].

---

## Proposed implementation batches (all-FE batches ship immediately)

- **Batch A — P0 crashers [FE]:** TenantProfile recursion; Announcements read via listAnnouncements. (P0-3 writes need a decision: [BE] Convex CRUD vs [FE*] supabase-js.)
- **Batch B — Permissions & Settings integrity [FE]:** drawer gating normalize, unknown-role deny, bank-accounts namespace, team specialties, org-save partial.
- **Batch C — Tickets completeness [FE]:** admin cancel/on-hold/reopen, scoped cost approvers, approval-modal dismiss, zero-cost path, auto-assign message, cost_type, qty/price modify.
- **Batch D — Analytics/Reports correctness [FE]:** status-case + field-name fixes (Owner Payouts, BedPerformance, EB Paid, occupancy, receipts date), surface Reports actions, error states.
- **Batch E — Tenant lifecycle [FE]:** expected-exit field, exit EB charges, exit-tasks list, dead-control/dead-module cleanup, notice status.
- **Batch F — Electricity [FE]:** restore Rates / Payments / Analytics tabs.
- **Batch G — Owners/Availability/Assets [FE/FE*]:** contract-edit field preservation, gender filter, warranty recompute, renewal periods.
- **Batch H — Voice/Technician [FE]:** remove Groq key → server endpoint, technician status breakdown, resolution-form reset, time metrics, apartmentCode, approver name.
- **Batch I — Polish [FE]:** audit-log filters, whatsapp jobType, role gating, dashboard count, login reason.
- **Backend-blocked bucket [BE]:** announcement write actions, org full fields, deposit_paid/listReceipts columns, EB monthly-P&L format, voice issue-type passthrough, notice-date resolution, push registration table. Collect into a single `npx convex deploy` when account access is available.

**Recommended order:** A → B → C → D → E → F → G → H → I, verifying each batch in the emulator before the next.

---

## IMPLEMENTATION STATUS — 2026-07-31 (all batches done, fresh Metro bundle verified clean)

All 9 batches implemented (frontend-only). Full no-cache Android bundle compiles with zero errors. Authenticated visual QA still pending (login needs a real OTP — verify on device).

**Fixed & live now (uses already-deployed backend):**
- A: TenantProfile recursion crash; Announcements list (+ fixed `announcements`→`anouncements` module typo that also unbroke WhatsApp send + image upload/delete).
- B: drawer permission gating (module-key normalization), unknown-role deny-by-default, bank accounts via tickets namespace, team specialties column, org-save no longer errors, team badge read.
- C: admin on_hold/cancelled/reopen transitions; dismissable approval modal + review banner; scoped cost approvers (super_admin-safe fallback); modifiable qty/price on approval; correct auto-assign name; ₹0 estimate → in_progress instead of dead-end; cost_type spelling.
- D: Analytics field-contract fixes (Owner Payouts, BedPerformance, EB Paid, occupancy exit date, receipt date); 4 new Reports tabs (Property P&L, Bed Profitability, EB Reconciliation, Occupancy Detail) + error/retry banner; Accounting requires positive rent.
- E: TenantHome expected-exit field + real status/KYC (with fallback); removed dead check-in modal; Pre-Exit Tasks section; exit EB charges in settlement; deleted dead fetchTenantDetails module + import.
- F/G: Electricity Rates/Payments/Analytics tabs restored; unified payment-mode casing; Availability Mixed/Any gender; Assets warranty recompute on edit; Owners Renewal Periods input; deleted dead handleAddApt.
- H: removed hardcoded Groq key (security); technician status breakdown from STATUS_CONFIG; dropped bad tenantId arg; full resolutionForm reset; time metrics off assigned→completed; DiagnosticFlow real approver name + no-cost writes a resolution; voice apartmentCode uses unit number.
- I: audit-log performedBy/date filters + expanded tables; whatsapp jobType filter + comment; Market/Announcements role gating; dashboard active-ticket count; punctuality last_2fy/last_5y; auth preserves supabaseUserId; login messaging off {success,message}.

**DEPLOY-PENDING (needs one `npx convex deploy` — code ready or TODO(deploy) in place):**
1. Announcement writes — createAnnouncement/updateAnnouncement/deleteAnnouncement actions written in convex/anouncements.ts; screen wired; not live until deployed (shows a clear "not deployed yet" message meanwhile).
2. `updateOrgSettings` validator — extend to persist organizationName + GST/address/contact/website.
3. `listAllotments` — return `deposit_paid` (Analytics Deposits Held = 0 until then).
4. `listReceipts` — return `tenant_allotment_id` (Analytics per-property receipt filter no-op until then).
5. `listBillingTenants` — return real `monthly_rental` (Accounting requires manual rent entry until then).
6. `getTenantLocation` — return real `staying_status`/`kyc_completed` (TenantHome falls back to Staying/false).
7. `getSession` — return `supabaseUserId` (frontend preserves cached value meanwhile).
8. `getOwnerDetail` — return full owner_contracts row; `updateContract` accept `renewal_periods` (owner contract edit still risks wiping escalation/lock-in/revenue-share/payment_schedule/rent_in_advance until then).
9. Tenant voice — server transcribe-only endpoint (secure key removed; recording falls back to manual review entry); + issue-type passthrough in http.ts/voiceProcessor.

**Not addressed (deferred P2, mostly backend/architectural):** push-notification device-token registration; Bank Accounts delete + is_primary server enforcement; TenantProfile notice-date (hardcoded null in getTenantProfile); AI diagnosis (2-question stub vs web AI); Analytics off-ledger→canonical-view migration; legacy unused report actions cleanup; tenant self-service notice not flipping allotment status (may be intended as a request).

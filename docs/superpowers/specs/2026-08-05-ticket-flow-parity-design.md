# Ticket-Flow Parity: Mobile ↔ Web — Design Spec

**Date:** 2026-08-05
**Status:** Approved (design), pending spec review
**Scope owner:** Arun Vishful

## 1. Goal

Make the VISHFUL **mobile** app's maintenance-ticket lifecycle match the **web** app
(`localhost:8080`, source: `external-db-guide-f04b8927-main`) exactly for the
end-to-end journey:

> **Tenant raises a ticket → technician diagnoses → cost estimate/approval →
> resolution → tenant approves → closed.**

Both apps call the same backend (Supabase on web; Convex actions on mobile that
front the same `maintenance_tickets` data). The backend is the canonical contract;
this work aligns the **mobile UI/flow** to the **web UI/flow**.

## 2. Out of scope (explicit)

- **Tenant voice notes** — `RaiseTicketScreen.tsx` (voice), `TenantTicketsScreen`
  voice modal, `TenantHomeScreen` voice, `/api/transcribe`, `/api/voice-ticket-direct`.
  Do NOT modify these.
- **Tenant rating/feedback** — does not exist on web either; mobile already matches.
  No work.
- **Tenant reopen of a *closed* ticket** — web tenants cannot do this (admin-only);
  mobile already matches. No work. (Tenant "Not Resolved" on `pending_tenant_approval`
  → `in_progress` is the real behavior, and it exists in both.)
- **Screen consolidation / big refactor** — deferred. See §7 decision 1.

## 3. Canonical flow contract (from web source, for reference)

**Statuses:** `open, assigned, in_progress, waiting_for_cost_approval,
waiting_for_parts, completed, pending_tenant_approval, pending_admin_approval,
closed` (+ `reassigned` appears only in list grouping).

**Technician-triggerable transitions** (require `assigned_to === me` + active):
- complete diagnostics → `assigned → in_progress`
- submit parts ≤ threshold, not repeat → auto-approved, stays/`→ in_progress`
- submit parts > threshold OR repeat-job → `→ waiting_for_cost_approval`
- Record Purchase → `waiting_for_parts → in_progress`
- Reassign → `→ assigned` (resets SLA, clears diagnostic_data)
- Save & Mark Completed → `→ completed`, server routes to
  `pending_tenant_approval` (tenant-created) or `pending_admin_approval`
  (admin-created); admin-created with no estimates auto-`closed`.

**Tenant-triggerable transitions:**
- Create → `assigned` (auto-assign matched) else `open`
- Accept & Close → `pending_tenant_approval → closed` (`tenant_approved=true`)
- Not Resolved (reason required) → `pending_tenant_approval → in_progress`

**Auto-approve threshold:** org setting `ticket_auto_approve_threshold` (default
₹1000). Repeat-job (same apartment+bed+issue type completed/closed within
`repeatCheckDays`, default 30) forces manual approval even under threshold.

## 4. Confirmed gaps and fixes

### A. Tenant raise-ticket form — `screens/CreateTicketScreen.tsx`
Web tenant fields: **Describe\*** (AI-classified) → **Issue Category\*** →
optional **sub-type chips** → auto **Linked Asset** (read-only confirmation) →
**single Issue Photo** → NO priority (auto from issue type), NO property/apt/bed
(auto-derived). Pending-approval wall blocks new tickets.

Fixes:
1. **Remove the tenant Priority step** (web auto-sets `priority` from the issue
   type). Priority must not be a tenant-facing field.
2. **Single issue photo** for tenants (approved decision) — cap tenant raise at 1.
3. **Surface auto-linked asset** as a read-only confirmation line (as web does).
4. Keep AI classify + manual override, pending-approval gate, auto location
   (already present).

### B. Tenant ticket list — `screens/TenantTicketsScreen.tsx`
Web = **"My Tickets"**, 3 status tabs: **Open / Tenant Approval / Closed**
(Open bundles open/assigned/in_progress/waiting_for_parts/completed/reassigned;
Tenant Approval = pending_tenant_approval; Closed = closed). Columns: Ticket# ·
Bed/unit · Issue · Status · Priority · SLA · Created. No cost/name/assigned-to.

Fix: restructure the current stat-cards + Active/Completed/Needs-approval layout
into the **3-tab** structure with matching labels and status groupings. Keep the
pending-approval banner and Raise button (Voice button stays untouched).

### C. Tenant ticket detail — `screens/TicketDetailScreen.tsx` (tenant mode)
Web hides from tenants: cost, SLA timer, time metrics, activity log. Tenant sees:
Ticket Details (read-only linked asset), a simplified "Work in progress / Work
completed → what was done (closure_summary)" card, and Accept & Close /
Not Resolved (reason) on `pending_tenant_approval`.

Fix: verify and enforce that mobile hides cost/SLA/time/activity for
`isTenant`, and that the simplified card + approve/decline match web copy/behavior.

### D. Technician ticket list — `screens/TechnicianTicketsNavigatorScreen.tsx` (`MyTicketsScreen`)
Web = 5 tabs: **Open · Cost Approval · Admin Approval · Tenant Approval · Closed**.
- Open = open/assigned/in_progress/waiting_for_parts/completed/reassigned
- Cost Approval = waiting_for_cost_approval
- Admin Approval = pending_admin_approval
- Tenant Approval = pending_tenant_approval
- Closed = closed

Fix: replace current `all/active/waiting/Approvals/closed/breached` `FILTERS`
with the 5 web tabs + counts. (Breached remains available as an SLA indicator on
cards, not as a primary tab, to match web.)

### E. Auto-approve threshold — `TechnicianTicketsNavigatorScreen.tsx` `CostEstimateReviewModal` (~:2323)
Replace the hardcoded "₹1,000" copy with the configurable
`ticket_auto_approve_threshold` (source: `convex/settings.ts`,
`SettingsScreen.tsx`). Message must reflect the real threshold and the repeat-job
caveat, matching web wording. Also review `parseCostMidpoint` default (`DiagnosticFlow.tsx:135`).

### F. Cleanup
- Delete dead `screens/TechnicianTicketsScreen.tsx` (not imported anywhere).
- Relabel/remove the `RaiseTicketScreen.tsx` "Manual — coming soon" stub tab
  (superseded by `CreateTicketScreen`). Do not touch its Voice tab.

## 5. Phasing

1. **Phase 1 — Tenant side (A, B, C):** raise form + list + detail parity.
2. **Phase 2 — Technician side (D, E):** list tabs + threshold.
3. **Phase 3 — Cleanup (F).**

Lifecycle transition logic already mirrors web (per existing `// web:` parity
comments), so no restructuring of the diagnostic/cost/resolution engines — only
the threshold fix (E) and verification passes.

## 6. Testing / verification constraints

- **Emulator run is currently blocked** (C: drive low on space; native build
  needs ~8–10 GB). Runtime QA on-device is deferred until space is freed.
- Interim verification = TypeScript/Metro bundle compile + code review against
  this spec's parity contract. Each phase gets a compile check.
- When disk allows: run the full **tenant-raise (demo 9876543210) → technician
  (9087887766) close** loop on the emulator and compare to web.

## 7. Decisions (recorded)

1. **Patch in place, not consolidate.** Because runtime QA is blocked, prefer
   localized low-risk edits over merging the two ticket-detail / two resolution
   implementations. Consolidation noted as future cleanup.
2. **Single photo** on tenant raise (exact web parity).

## 8. Affected files

- `screens/CreateTicketScreen.tsx` (A)
- `screens/TenantTicketsScreen.tsx` (B)
- `screens/TicketDetailScreen.tsx` (C, tenant mode)
- `screens/TechnicianTicketsNavigatorScreen.tsx` (D, E)
- `screens/DiagnosticFlow.tsx` (E, threshold default)
- `screens/TechnicianTicketsScreen.tsx` (F, delete)
- `screens/RaiseTicketScreen.tsx` (F, stub tab only — Voice untouched)
- Read-only refs: `convex/settings.ts`, `services/ticketService.ts`.

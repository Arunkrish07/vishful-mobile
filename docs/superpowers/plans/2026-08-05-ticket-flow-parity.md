# Ticket-Flow Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the mobile app's maintenance-ticket flow (tenant raise → technician close) to the web app exactly, without touching voice notes.

**Architecture:** Patch existing React Native screens in place (no consolidation). Tenant screens first (Phase 1), technician screens next (Phase 2), dead-code cleanup last (Phase 3). All data flows through existing Convex actions; only UI/flow structure changes.

**Tech Stack:** Expo SDK 52, React Native, TypeScript, Convex backend, React Query.

## Global Constraints

- **Do NOT modify voice-note code:** `RaiseTicketScreen.tsx` Voice tab, `TenantTicketsScreen` voice modal, `TenantHomeScreen` voice, `/api/transcribe`, `/api/voice-ticket-direct`.
- **No test harness exists** (no jest/eslint). Per-task verification = `npx tsc --noEmit` (typecheck) + manual review against the parity contract below. On-emulator runtime QA is DEFERRED until the C: drive has ~8–10 GB free.
- **Canonical status strings:** `open, assigned, in_progress, waiting_for_cost_approval, waiting_for_parts, completed, pending_tenant_approval, pending_admin_approval, closed` (+`reassigned` in list grouping only).
- **"Open" tab group** everywhere = `['open','assigned','in_progress','waiting_for_parts','completed','reassigned']`.
- **Auto-approve threshold** = org setting `ticket_auto_approve_threshold` (default 1000); repeat-job forces manual approval even under threshold.
- **Spec:** `docs/superpowers/specs/2026-08-05-ticket-flow-parity-design.md`.
- Commit after each task. Branch: `feat/ticket-flow-parity`.

---

## PHASE 1 — Tenant side

### Task 1: Remove tenant Priority step; auto-derive priority

**Files:**
- Modify: `screens/CreateTicketScreen.tsx` (tenant branch, ~:416-555; Step 4 Priority)

**Interfaces:**
- Produces: tenant ticket create payload without a user-chosen priority; priority derived from the selected issue type (`issueType.priority || 'medium'`), matching web `Tickets.tsx:851`.

- [ ] **Step 1: Read the tenant flow region**

Read `screens/CreateTicketScreen.tsx` and locate the tenant step sequence and the Priority step (Step 4) plus the create-payload assembly (where `priority` is set).

- [ ] **Step 2: Remove the Priority step from the tenant flow**

Delete the Priority selection step/UI from the tenant branch only (leave any admin priority handling intact if the same screen serves admins). Renumber remaining steps so the tenant flow is: Describe → Issue Type → Issue Details/sub-type → (submit). Do not remove the photo or SLA info.

- [ ] **Step 3: Auto-derive priority in the create payload**

Where the create payload is built for a tenant, set `priority` from the chosen issue type: `const priority = selectedIssueType?.priority || 'medium';` and pass that. Remove references to the removed priority-state for the tenant path.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors in CreateTicketScreen.tsx).

- [ ] **Step 5: Commit**

```bash
git add screens/CreateTicketScreen.tsx
git commit -m "feat(tickets): tenant raise auto-derives priority from issue type (web parity)"
```

---

### Task 2: Single issue photo on tenant raise

**Files:**
- Modify: `screens/CreateTicketScreen.tsx` (photo upload, ~:733-776)

**Interfaces:**
- Produces: tenant photo state limited to a single URL; payload sends one photo (web sends `photo_urls = [photo_url]`).

- [ ] **Step 1: Read the photo-upload region**

Locate the photo picker/state (currently max 5) in the tenant branch.

- [ ] **Step 2: Cap tenant photos at 1**

For the tenant path, limit selection to a single image (replace the array/max-5 handling with single-photo state, or cap the max to 1 and show only one thumbnail with replace/remove). Keep the upload target bucket unchanged.

- [ ] **Step 3: Send single photo in payload**

Ensure the create payload passes the one photo as the app's existing photo field (array of one, matching web `photo_urls`), or the existing single-photo field the Convex action expects. Verify the Convex `createTicket` arg shape is satisfied.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add screens/CreateTicketScreen.tsx
git commit -m "feat(tickets): limit tenant raise to a single photo (web parity)"
```

---

### Task 3: Surface auto-linked asset (read-only) on tenant raise

**Files:**
- Modify: `screens/CreateTicketScreen.tsx` (tenant branch, near location auto-fill ~:299-305)

**Interfaces:**
- Consumes: the tenant's resolved location (apartment/bed) already used for location auto-fill.
- Produces: a read-only "Linked to your room's allocated asset: <name>" line when an allocated asset resolves; sends `asset_id` in the payload when available.

- [ ] **Step 1: Determine asset availability**

Read the tenant location resolution in `CreateTicketScreen.tsx`. Check whether the tenant context / an existing service exposes an allocated asset for the room (search `lib/` and `services/` for `asset_allocation`, `getAsset`, `assets`). If no asset data is reachable in the tenant context, STOP this task and note in the commit that mobile has no tenant asset-allocation source (parity gap deferred); skip to Task 4.

- [ ] **Step 2: Add read-only asset confirmation**

If asset data is available, resolve the allocated asset for the tenant's bed/apartment and render a read-only line (no dropdown for tenant): `Linked to your room's allocated asset: {assetName}`. Match web copy (`Tickets.tsx:1436-1444`).

- [ ] **Step 3: Include asset_id in payload**

Pass the resolved `asset_id` in the create payload (null when none), matching web `asset_id` handling.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add screens/CreateTicketScreen.tsx
git commit -m "feat(tickets): show auto-linked room asset on tenant raise (web parity)"
```

---

### Task 4: Tenant list → 3 tabs (Open / Tenant Approval / Closed)

**Files:**
- Modify: `screens/TenantTicketsScreen.tsx` (list layout ~:346-468)

**Interfaces:**
- Produces: a 3-tab filter identical to web `visibleStatusTabs = ['open','tenant_approval','closed']`.

- [ ] **Step 1: Read the current list layout**

Read `screens/TenantTicketsScreen.tsx`. Identify the current stat-cards + Active/Completed/Needs-approval sections and the grouping logic (~:346-348) and the `TenantTicketCard` usage.

- [ ] **Step 2: Add the 3-tab filter config**

Add near the top of the component:

```tsx
const TENANT_FILTERS = [
  { key: 'open', label: 'Open', statuses: ['open','assigned','in_progress','waiting_for_parts','completed','reassigned'] },
  { key: 'tenant_approval', label: 'Tenant Approval', statuses: ['pending_tenant_approval'] },
  { key: 'closed', label: 'Closed', statuses: ['closed'] },
] as const;
```

Add `const [activeTab, setActiveTab] = useState<'open'|'tenant_approval'|'closed'>('open');`

- [ ] **Step 3: Render the tab bar + filtered list**

Replace the Active/Completed/Needs-approval sections with a horizontal tab bar (buttons over `TENANT_FILTERS`, each showing its live count) and a single filtered list of `TenantTicketCard` for tickets whose `status` is in the active tab's `statuses`. Keep: the pending-approval banner, the "Account Not Linked" state, the Raise button, and the Voice button (untouched). Keep the approval CTA on cards in the Tenant Approval tab.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add screens/TenantTicketsScreen.tsx
git commit -m "feat(tickets): tenant list uses Open/Tenant Approval/Closed tabs (web parity)"
```

---

### Task 5: Tenant detail hides cost/SLA/time/activity

**Files:**
- Modify: `screens/TicketDetailScreen.tsx` (tenant-mode gating)

**Interfaces:**
- Consumes: existing `isTenant` flag in the screen.
- Produces: tenant view shows only Ticket Details (read-only linked asset) + simplified "Work in progress / Work completed → what was done" card + Accept & Close / Not Resolved (reason) on `pending_tenant_approval`.

- [ ] **Step 1: Audit current tenant gating**

Read `screens/TicketDetailScreen.tsx`. List every section (cost estimates, SLA/timer, time metrics, activity log/timeline, procurement) and confirm whether each is already hidden for `isTenant`. Web hides ALL of cost, SLA, time metrics, and activity log from tenants.

- [ ] **Step 2: Enforce hiding for any leaking section**

For each section not already gated, wrap its render in `!isTenant && (...)` (or the screen's equivalent role check). Ensure the tenant retains: Ticket Details, the simplified status card, and the Review & Approve / Not Resolved buttons on `pending_tenant_approval`.

- [ ] **Step 3: Verify approve/decline copy matches web**

Confirm Accept & Close → `tenantApproveCompletion(id,true,userId)` and Not Resolved (required reason) → `tenantApproveCompletion(id,false,userId,reason)`; labels align with web ("Accept & Close", "Not Resolved"/"Re-open Ticket").

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add screens/TicketDetailScreen.tsx
git commit -m "fix(tickets): hide cost/SLA/time/activity from tenant detail (web parity)"
```

---

## PHASE 2 — Technician side

### Task 6: Technician list → 5 tabs

**Files:**
- Modify: `screens/TechnicianTicketsNavigatorScreen.tsx` (`FILTERS` ~:393-400, `MyTicketsScreen` ~:402)

**Interfaces:**
- Produces: 5-tab filter matching web `statusTabs` for non-tenant.

- [ ] **Step 1: Read the current FILTERS + MyTicketsScreen**

Read the `FILTERS` array and how `MyTicketsScreen` filters/counts by it.

- [ ] **Step 2: Replace FILTERS with the web 5-tab config**

```tsx
const FILTERS = [
  { key: 'open', label: 'Open', statuses: ['open','assigned','in_progress','waiting_for_parts','completed','reassigned'] },
  { key: 'waiting_for_cost_approval', label: 'Cost Approval', statuses: ['waiting_for_cost_approval'] },
  { key: 'pending_admin_approval', label: 'Admin Approval', statuses: ['pending_admin_approval'] },
  { key: 'pending_tenant_approval', label: 'Tenant Approval', statuses: ['pending_tenant_approval'] },
  { key: 'closed', label: 'Closed', statuses: ['closed'] },
] as const;
```

Default the selected tab to `'open'`.

- [ ] **Step 3: Update filtering, counts, and default**

Update `MyTicketsScreen` to filter/count by the new keys' `statuses`. Remove the old `all/active/waiting/pending/breached` keys. Keep the SLA breach indicator on each `TicketCard` (breach becomes a card badge, not a tab, matching web).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add screens/TechnicianTicketsNavigatorScreen.tsx
git commit -m "feat(tickets): technician list uses web 5-tab structure (web parity)"
```

---

### Task 7: Auto-approve threshold from org setting

**Files:**
- Modify: `screens/TechnicianTicketsNavigatorScreen.tsx` (`CostEstimateReviewModal` ~:2323-2329)
- Modify: `screens/DiagnosticFlow.tsx` (`parseCostMidpoint` default ~:135)
- Read-only ref: `convex/settings.ts`, `screens/SettingsScreen.tsx`

**Interfaces:**
- Consumes: org setting `ticket_auto_approve_threshold` (default 1000).
- Produces: threshold-driven copy and value in the cost modal.

- [ ] **Step 1: Find how settings are read on mobile**

Read `convex/settings.ts` and `SettingsScreen.tsx` to find the query that returns `ticket_auto_approve_threshold` (and `repeatCheckDays` if present). Note the exact Convex query/action name and shape.

- [ ] **Step 2: Load the threshold into the cost modal**

In `TechnicianTicketsNavigatorScreen.tsx`, fetch the org setting (via the query found in Step 1) and store `autoApproveThreshold` (fallback `1000`). Pass it into `CostEstimateReviewModal`.

- [ ] **Step 3: Replace the hardcoded ₹1,000 copy/logic**

In `CostEstimateReviewModal`, replace the hardcoded `1000` in both the numeric comparison and the display copy with `autoApproveThreshold`. Copy should read (formatted): `Under ₹{threshold} — auto-approved instantly and moves to 'Waiting for Parts' (unless it's a repeat job in the same apartment, which needs admin approval).` else the over-threshold message. Keep the repeat-job caveat.

- [ ] **Step 4: Align parseCostMidpoint default**

In `DiagnosticFlow.tsx`, change the hardcoded `1000` default in `parseCostMidpoint` to accept/use the threshold if it is passed down, or leave the numeric parse fallback but remove any user-facing "₹1000" copy. (No user-facing hardcoded threshold text may remain.)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add screens/TechnicianTicketsNavigatorScreen.tsx screens/DiagnosticFlow.tsx
git commit -m "fix(tickets): use configurable auto-approve threshold, not hardcoded 1000 (web parity)"
```

---

## PHASE 3 — Cleanup

### Task 8: Delete dead `TechnicianTicketsScreen.tsx`

**Files:**
- Delete: `screens/TechnicianTicketsScreen.tsx`

- [ ] **Step 1: Confirm it is unused**

Run: `grep -rn "TechnicianTicketsScreen" --include=*.tsx --include=*.ts . | grep -v node_modules | grep -v "TechnicianTicketsNavigatorScreen"`
Expected: no import references (only the file's own definition, if any). If any real import exists, STOP and report.

- [ ] **Step 2: Delete the file**

```bash
git rm screens/TechnicianTicketsScreen.tsx
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(tickets): remove dead TechnicianTicketsScreen.tsx"
```

---

### Task 9: Relabel the RaiseTicketScreen "Manual" stub tab

**Files:**
- Modify: `screens/RaiseTicketScreen.tsx` (Manual tab stub ~:578-583)

**Interfaces:**
- The Voice tab and all voice logic MUST remain untouched.

- [ ] **Step 1: Read the Manual tab stub**

Locate the "Manual Entry — Coming soon — use Voice tab for now" stub.

- [ ] **Step 2: Point Manual to the real create flow**

Replace the stub content with a short line + button that navigates to `CreateTicket` (the real structured raise screen): e.g. button "Type it instead" → `navigation.navigate('CreateTicket')`. Do NOT touch the Voice tab.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add screens/RaiseTicketScreen.tsx
git commit -m "chore(tickets): Manual tab routes to CreateTicket instead of stub"
```

---

## Final verification (when disk is freed)

- [ ] Free ~8–10 GB on C:, then build+run on the emulator (from the non-OneDrive copy, `JAVA_HOME` = the Adoptium 17 JDK).
- [ ] Run the full loop: tenant (demo `9876543210`) raises a ticket → technician (`9087887766`) diagnoses → cost → resolve → tenant approves → **closed**. Compare each screen to the web app at `localhost:8080`.
- [ ] Confirm: no tenant priority field, single photo, 3 tenant tabs, 5 technician tabs, threshold copy matches org setting.

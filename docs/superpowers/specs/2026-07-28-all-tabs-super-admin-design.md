# Design — All tabs for super admin + 3 ported screens

Date: 2026-07-28
Repo: a0-project (Vishful mobile, Expo SDK 52)
Web reference: `…/external-db-guide-f04b8927-main (1)/external-db-guide-f04b8927-main`

## Goal

1. Super admin sees **every** tab in the mobile drawer.
2. Other roles see tabs based on tab-permission (`role_permissions`).
3. Accounting is left as-is (its parity work is tracked separately).
4. Bring the remaining web tabs to mobile: unhide the ones already built, and
   port the three that have no mobile screen yet.

## Web sidebar tabs (canonical, 18)

Dashboard, Properties, Owners, Tenants, Tenant Lifecycle, Assets, Tickets,
Accounts (Accounting), Electricity, Reports, Analytics, Availability,
Market AI, Announcements, Team, WhatsApp Logs, Audit Logs, Settings.

## Current mobile state

- Built + visible: Dashboard, Properties, Tenant Lifecycle, Assets, Tickets,
  Electricity, Availability, Announcements, Accounting, Settings.
- Built but **hidden** (`HIDDEN_ON_MOBILE`): Owners, Bulk Import, Tenants,
  Reports, Analytics, Team.
- **No mobile screen at all**: Market AI, WhatsApp Logs, Audit Logs.

## Part A — Navigation & permissions

- **A1** Remove `Owners, Bulk Import, Tenants, Reports, Analytics, Team` from
  `HIDDEN_ON_MOBILE` (`App.tsx`). Their existing screens wire straight into the drawer.
- **A2** Super-admin bypasses the hide list. `MainDrawer.canAccess` becomes
  `(m) => (isSuperuser || !HIDDEN_ON_MOBILE.has(m)) && rawCanAccess(m)`.
  `PermissionsContext` exposes `isSuperuser`.
- **A3** Register `Market AI`, `WhatsApp Logs`, `Audit Logs` in the `AppModule`
  type, add drawer entries gated by `canAccess`, and add them to the Settings
  permission `MODULES` list so permissions are configurable.

## Part B — Three new screens

Each = one Convex action file + a thin wrapper in `lib/supabaseService.ts`
(`client.action(api.<mod>.<fn>, args)`) + one screen, following the
`accounting.ts` → `AccountingScreen` pattern. All org-scoped via `ORG_ID`.

| Screen | Convex actions | Data source | Writes |
|---|---|---|---|
| AuditLogsScreen | `listAuditLogs({page,pageSize,tableName?,action?,performedBy?,from?,to?})` | `audit_logs` paginated + `profiles` name map | none |
| WhatsAppLogsScreen | `listWhatsappJobs({jobType?})`, `listJobDeliveries(jobId)` (+ later: `resendDelivery`, `resendAllFailed`, `resumeJob`) | `whatsapp_send_jobs`, `whatsapp_send_job_deliveries` (+ resend/resume edge fns) | deferred |
| MarketScreen | `getExpansionOpportunities()` (+ later: `triggerMarketScan()`) | `get_expansion_opportunities` RPC (+ `market-trigger` edge fn) | deferred |

## Part C — Scope decision (approved)

- **Audit Logs**: full (read-only anyway).
- **WhatsApp Logs + Market AI**: shipped read-first, then the side-effecting
  writes were wired as a follow-up. All ported.

### Write-actions (wired 2026-07-28)

Edge-function calls use the service-role client (`sb.functions.invoke`) like
`convex/anouncements.ts`; each returns `{ ok, reason }` and the screens confirm
via `Alert`, then reload. Status transitions stay owned by the edge function.

- `whatsapplogs.ts`: `resendDelivery` (`whatsapp-send-job {action:'resend_delivery', delivery_id}`),
  `resendAllFailed` (query failed/pending → resend each), `resumeJob`
  (set job `status='pending'` → `whatsapp-send-job {job_id}`).
- `market.ts`: `triggerMarketScan` (`market-trigger {}`), `retryMarketIntel`
  (`market-trigger {action:'retry-intel'}`).
- UI: WhatsApp job panel → Resume + Resend-failed; each failed delivery → Resend.
  Market header → Scan; competitors tab → Retry-failed.

Still needs a live Convex deploy + Supabase to verify service-role invocation.

## Testing

- Project typecheck: must introduce no error categories beyond the existing
  untyped-Supabase-client `never` baseline (Babel bundles regardless of tsc).
- Manual smoke of each new tab + super-admin drawer visibility.
- No unit-test harness exists in this repo.

## Out of scope

- Accounting parity (tracked in `ACCOUNTING_PARITY_SPEC.md`).
- Deep parity re-audit of the 6 unhidden screens (trusted as-is per decision).
- The deferred write-actions listed above.

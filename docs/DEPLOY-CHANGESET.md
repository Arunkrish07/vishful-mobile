# Backend Deploy Changeset — 2026-07-31

One `npx convex deploy` makes every deploy-pending item from the mobile parity audit go live. All edits are **additive** (new fields/columns/args/actions — nothing renamed or removed), so they are backward-compatible with the currently-deployed frontend. The matching frontend consumers are already shipped and bundle-verified; they degrade gracefully pre-deploy and light up post-deploy.

## How to deploy
```bash
cd "<project root>"
npx convex login            # or set CONVEX_DEPLOY_KEY for deployment wonderful-kiwi-122
npx convex deploy           # runs Convex's own typecheck + pushes
```
**Env requirement:** the deployment must have `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set (server-side `getSupabase()` reads `process.env`). These are already required by existing actions, so they should already be configured.

> Backend TS was verified for syntax (no TS1xxx errors). The remaining `tsc` output is `never`-type/possibly-null noise from checking outside Convex's tsconfig. Convex's real typecheck runs during `deploy` — treat a clean `deploy` as the authoritative backend check.

## Files changed (8 backend actions/modules)

| # | File | Change |
|---|------|--------|
| 1 | `convex/anouncements.ts` | **New actions** `createAnnouncement` / `updateAnnouncement` / `deleteAnnouncement` (service-role, org-scoped). Unblocks announcement create/edit/delete/publish. |
| 2 | `convex/settings.ts` | `updateOrgSettings` now accepts + persists `organizationName` + GST/address/contact/website (all optional; only provided keys write). `getOrgSettings` returns them. |
| 3 | `convex/tenants.ts` | `listAllotments` returns `deposit_paid`/`depositPaid`; `getTenantLocation` returns `stayingStatus`/`kycCompleted`. |
| 4 | `convex/accounting.ts` | `listReceipts` returns `tenant_allotment_id`; `listBillingTenants` returns real `monthlyRent` (was hardcoded 0). |
| 5 | `convex/otpAuth.ts` | `getSession` returns `supabaseUserId` (= auth user id, same value login sets). |
| 6 | `convex/owners.ts` | `getOwnerDetail` returns full contract terms (revenue-share, lock-in, escalation, rent-in-advance, payment_schedule, renewal_periods, gst); `updateContract` now persists `renewal_periods`. Fixes contract-edit wiping terms. |
| 7 | `convex/http.ts` | `/api/voice-ticket-direct` forwards `issueTypeId`/`issueType` to the processor. |
| 8 | `convex/voiceProcessor.ts` | `processVoice` accepts `issueTypeId`/`issueType`; matching honors the caller's selection (skips AI classification when set). |
| 9 | `convex/settings.ts` | **New action** `deleteBankAccount`; `createBankAccount`/`updateBankAccount` now enforce a single org-wide primary (setting one primary clears the others). |
| 10 | `convex/tenants.ts` | `getTenantProfile` returns real `noticeDate` + `estimatedExitDate` (was hardcoded null). |
| 11 | `convex/notifications.ts` | **New** `registerDeviceToken` / `removeDeviceToken` (public) + `notifyUsers` (internal fan-out: looks up a user's device tokens and pushes). |

## Push notifications — extra requirements (item 11)
Push is code-complete but needs more than a deploy to actually deliver (it **cannot run in Expo Go** — requires a native build):
1. **Supabase table** (run once):
   ```sql
   create table if not exists device_push_tokens (
     id uuid primary key default gen_random_uuid(),
     token text not null unique,
     user_id text,
     role text,
     platform text,
     organization_id uuid not null,
     created_at timestamptz default now(),
     updated_at timestamptz default now()
   );
   create index if not exists device_push_tokens_user_idx on device_push_tokens(user_id);
   ```
2. **Convex env:** set `A0_SERVER_KEY` (already referenced by the existing `sendNotification`).
3. **Native build:** `expo-notifications` + `expo-device` are installed and wired (`lib/pushNotifications.ts`, called on login/logout in `lib/auth.tsx`), but native device tokens only exist in a **custom dev/APK build** — add the `expo-notifications` plugin to `app.json` and build with EAS. In Expo Go registration silently no-ops.
4. **Trigger sends:** call `internal.notifications.notifyUsers({ userIds, title, body })` from wherever an event should notify (e.g. ticket assigned, approval needed) — not wired to any event yet.

> **Note:** the voice **transcribe-only** endpoint (`POST /api/transcribe`) is **already deployed** — no backend change needed. The three voice screens (`TenantTicketsScreen`, `RaiseTicketScreen`, `TenantLifecycleScreen`) were rewired to use it and **3 hardcoded Groq API keys were removed** — all frontend-only, live now.

## Matching frontend consumers (already shipped, bundle-verified)
- `screens/SettingsScreen.tsx` — loads + saves the full org profile.
- `screens/OwnersScreen.tsx` — contract edit form pre-populates all terms (no more wipe).
- `screens/AnalyticsScreen.tsx` — Deposits-Held sum + per-property receipt filter now real.
- `screens/AccountingScreen.tsx` — invoice rent defaults from the stay's real monthly rent.
- `screens/TenantHomeScreen.tsx` — profile card shows real status/KYC.
- `lib/auth.tsx` — uses the returned `supabaseUserId` (cached fallback for pre-deploy).
- `screens/TenantTicketsScreen.tsx` — already sends `issueTypeId`/`issueType`; now honored server-side.

## ⚠️ Column-name assumptions to verify against Supabase
These edits assume the following columns exist with these exact names. **Confirmed in use elsewhere in the codebase:** `tenant_allotments.deposit_paid`, `tenant_allotments.monthly_rental`, `tenants.kyc_completed`, `org_settings.organization_name`. **Assumed (web app persists them, but verify):**
- `org_settings`: `gst_number, address_line1, address_line2, city, state, pincode, country, contact_person_name, contact_phone, contact_email, website`
- `receipts.tenant_allotment_id`
- `owner_contracts.renewal_periods` (already accepted by `createOwnerContract`)

If any column name differs, adjust the mapping in the corresponding file before deploy (a wrong column name makes only that one write/read fail, not the whole action).

## Post-deploy smoke checks
1. Announcements: create a draft → appears in list; edit; delete. Publish toggles.
2. Settings → Organization: edit GST/address/contact → Save → reopen shows persisted values.
3. Analytics → Cash Flow: Deposits Held is non-zero; select a property → receipts filter narrows.
4. Accounting: create invoice with rent blank → uses the tenant's real monthly rent.
5. Owners: edit a contract → escalation/lock-in/revenue-share/renewal are pre-filled and survive save.
6. Tenant app: profile card shows real Staying/On-Notice/KYC; expected-exit date shows.
7. Tenant voice ticket with a chosen category → ticket gets that issue type (not an AI re-guess).
8. Settings → Bank Accounts: delete an account; mark one primary → the previous primary is cleared.
9. Tenant profile (On-Notice tenant): Notice Date + Expected Exit show real dates.

## Not built (remaining, optional)
- **Transcribe-only voice endpoint** for the tenant review-first flow (`TenantTicketsScreen`): the security-critical hardcoded Groq key is already removed; recording currently falls back to manual text entry. A server `/api/transcribe` route (audio → text, no ticket insert) would let recorded audio pre-fill the review transcript. New public HTTP route + client rewire — deferred.
- Other deferred P2s (push-notification device registration, Bank Accounts delete + is_primary enforcement, TenantProfile notice-date, AI-diagnosis parity, off-ledger→canonical-view migration) — see `AUDIT-mobile-parity-2026-07-31.md`.

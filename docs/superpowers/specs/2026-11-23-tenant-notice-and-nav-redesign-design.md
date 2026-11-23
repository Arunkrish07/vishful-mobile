# Tenant notice rules, dues removal & unified floating nav — design

Date: 2026-11-23
Branch: feat/ui-redesign-premium

## Intent / why
Tighten the tenant experience and unify the app's navigation:
- Tenants shouldn't see a self-service **Delete account** control (kept only in admin Settings) — already done.
- Tenants shouldn't see their **outstanding dues** on the home dashboard.
- The **move-out notice** flow (already exists) must enforce two house rules.
- All three role navigation bars (admin / technician / tenant) should share one
  modern **floating** look.

## Goals
1. Remove the **TOTAL DUE** tile from the tenant home dashboard.
2. Enforce move-out notice rules:
   - **60-day lock-in:** a tenant cannot submit a notice until 60 days after
     their check-in date. (e.g. check-in Nov 23 → eligible from Jan 22.)
   - **30-day notice:** the chosen move-out date must be ≥ 30 days from today.
3. Restyle admin, technician, and tenant nav bars to one **"glass bar + filled
   active chip"** floating design.

## Non-goals / anti-goals
- No database/schema/RPC changes. Notice rules are enforced **client-side**
  (consistent with the project's "no dev writes / frontend-only" constraint).
  Server-side enforcement is a noted follow-up, not in scope.
- No change to the notice data model or `recordNotice`.
- Not touching the admin "More" grid or which tabs appear — visual restyle only.

## Decisions (confirmed with user)
- Menu bar: **all three role bars** restyled.
- Nav look: **glass bar + filled active chip** (frosted white bar; active tab =
  solid #2563EB rounded chip with white icon+label; inactive = grey icon + tiny
  label; 26px radius, floats 12px off the sides, soft shadow).
- Min stay: **60 days from check-in** (exact day count).
- Notice: **move-out date must be ≥ 30 days ahead** (reject sooner dates).

## Approach
A single **presentational** `FloatingNav` component renders the glass bar + chip,
and each role wires its own navigation mechanics into it:
- **Admin** — `AdminFloatingNav` already drives navigation via `navRef`; swap its
  inner rendering to `FloatingNav`.
- **Technician** — its nav lives in `TechnicianTicketsNavigatorScreen`; restyle to
  `FloatingNav`.
- **Tenant** — `TenantTabNavigator` currently uses the default RN tab bar; supply
  a custom `tabBar` that renders `FloatingNav`.

Rejected: restyling each bar independently (3× duplicated styles, drifts over
time). Rejected: a fully animated sliding indicator (more motion/complexity than
the chosen look needs).

## Files touched
- `screens/TenantHomeScreen.tsx` — remove TOTAL DUE tile (+ its now-dead
  state/loader/import); make Open Tickets full-width; add 60-day/30-day notice
  validation + helper text; gate the move-out button during lock-in.
- `components/FloatingNav.tsx` — **new** shared presentational nav.
- `App.tsx` — `AdminFloatingNav` + `TenantTabNavigator` use `FloatingNav`.
- `screens/TechnicianTicketsNavigatorScreen.tsx` — technician nav → `FloatingNav`.

## Left to builder
- Date math uses local-midnight Dates (consistent with billingEngine).
- Exact chip sizing so 5 slots + an expanded active chip fit without overflow on
  small screens (active chip may show icon-only + label; verify on a narrow width).

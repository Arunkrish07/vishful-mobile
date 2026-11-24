# UI Redesign — "Premium Blue" (design-only, zero logic change)

**Date:** 2026-11-21
**Branch:** `feat/ui-redesign-premium` (off `sdk-58-expo-go`)
**Owner:** Arun / Vishful

## Intent & why
Make the whole app look modern, premium, and user-friendly — smooth transitions and
glassmorphism where it helps — **without changing a single function, data call, handler,
or navigation flow**. Current users should feel the app got nicer, not different.

## Goals
- Consistent, premium visual refresh across the app via the **shared design layer**.
- Keep the existing **blue brand** (`#2563EB` family); elevate it (depth, glass, polish).
- Add **smooth screen transitions** centrally (React Navigation + Reanimated 4).
- Hand-polish the **most-used screens**: Dashboard, Login, Tenants, Tickets, Settings,
  (+ TenantHome for tenant role).
- Everything verifiable live in **Expo Go (SDK 58)**.

## Non-goals / anti-goals
- **No logic/flow/data change.** No edits to fetches, state, handlers, nav targets, order of steps.
- Do **not** rewrite all 32 screens / 42k lines. (Only the shared layer + top screens.)
- Do **not** rename theme token keys or change shared-component prop signatures
  (that would ripple into every screen and break things). **Change values, not keys.**
- No dark mode (ThemeContext stays light-only) unless requested later.

## Constraints
- Must run in Expo Go SDK 58. Glass uses `expo-blur` (already used in `shared.tsx`).
- Don't run dependency installs that clobber the OneDrive `node_modules` junction.
- Verify visually in Expo Go after each phase; `tsc` must stay clean on touched files.
- Current branch has 13 uncommitted modified files (prior sessions' work) — redesign is
  committed separately so its diff stays clean and reversible.

## Approaches considered
1. **Full screen-by-screen rewrite** — restyle all 4,384 hardcoded color spots across
   42k lines. Most thorough, but slow, expensive, and high risk of breaking layout/handlers.
   *Rejected for now* (can be done later in batches if wanted).
2. **System reskin only** — repaint tokens + shared components + transitions. Safest, fastest,
   but heavily-hardcoded screens only improve partially.
3. **System reskin + top-screen polish (CHOSEN)** — do (2), then adopt the refreshed look on
   the 5–6 screens people actually live in. Best balance of impact, safety, and speed.

## The how (decided)

### Phase 1 — Design-system foundation (app-wide, low risk)
- **`lib/theme.ts`**: refine token *values* only (keys unchanged):
  - Premium blue palette (deeper gradients, refined neutral surface hierarchy).
  - Softer/larger radii; layered soft shadows for depth.
  - Real glass tokens (translucent surface + blur intensity) for cards/headers.
  - Unify the parallel `glass.*` and `WEB.*` palettes visually (keep both key sets intact).
- **`components/shared.tsx`**: upgrade shared components to the new look, same props/names:
  GlassCard, GlassHeader, StatCard, Button, Input, Badge, FilterChip, PageHeader, ModuleCard,
  PickerSelect, EmptyState, ListItem. Add tasteful press/entrance micro-interactions.
- **Navigation transitions** (`App.tsx` / navigators): set `screenOptions.animation`
  (e.g. `slide_from_right` for stacks, `fade` where it reads better). Central, no logic touched.

### Phase 2 — Top-screen polish (adopt refreshed components)
- DashboardScreen, LoginScreen, TenantsScreen, TicketsScreen, SettingsScreen, TenantHomeScreen.
- Swap ad-hoc hardcoded cards/headers for the refreshed shared components; apply new tokens;
  add subtle entrance animation to lists/cards. **Handlers, props, data, and navigation
  untouched** — only wrappers/styles change.

### Safety method
- Values-not-keys rule → changes propagate without breaking imports.
- Keep every exported name and prop signature.
- Commit per phase; `tsc` + Expo Go visual check between phases.

## Left to the builder
- Exact hex/shadow/radius values for the premium palette (within "keep blue, make premium").
- Which micro-interactions are worth the cost on low-end devices (keep them cheap).
- Per-screen polish details, as long as logic/flow stay identical.

## Verification
- `tsc` clean on touched files.
- Live Expo Go pass on each refreshed screen (login → dashboard → tenants → tickets → settings).
- Diff review confirms no handler/data/nav lines changed.

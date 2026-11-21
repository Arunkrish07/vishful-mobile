# UI Redesign Premium — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the whole app a premium-blue, glass-accented, smoother look by refreshing only the shared design layer (tokens + shared components) and enabling central screen transitions — with zero change to any logic, data, handler, or flow.

**Architecture:** Change token *values* (never keys) in `lib/theme.ts`; restyle the shared components in `components/shared.tsx` keeping every export name and prop signature; set consistent transition `animation` in the native-stack navigators in `App.tsx`. Because keys/props/names are unchanged, the refresh propagates to all 32 screens without breaking imports.

**Tech Stack:** React Native (Expo SDK 58), React Navigation 7 (native-stack/drawer/bottom-tabs), Reanimated 4, expo-blur, Ionicons.

**Spec:** `docs/superpowers/specs/2026-11-21-ui-redesign-premium-design.md`

## Global Constraints
- **No logic/flow change.** Do not edit data fetches, state, handlers, nav *targets*, or step order. Only styling/values/wrappers.
- **Values not keys.** Never rename a theme token key or change a shared-component prop signature or export name.
- Must run in **Expo Go SDK 58**. Glass uses `expo-blur` (already a dependency). No dependency installs.
- Don't clobber the OneDrive `node_modules` junction.
- `tsc` must stay clean on touched files; commit per task; verify live in Expo Go.
- No test harness for UI exists → "test" = `tsc` + logic-diff check + Expo Go visual check.

## Review Focus
- **Low-contrast text:** softened neutrals must keep body/secondary text readable on white and on the grey background (WCAG AA ~4.5:1). Check `textSecondary`/`textTertiary` on `surface` and `background`.
- **Translucent cards washing out:** glass on content cards can grey them out; content cards stay crisp white, glass is reserved for chrome (headers, floating nav, modal sheets). Verify cards still read as white.
- **Transition jank on Android/Expo Go:** a too-long/heavy stack animation stutters on low-end devices; keep duration modest and gesture-enabled. Verify push/pop on Tickets→TicketDetail feels smooth.
- **Shadow invisibility on Android:** Android ignores `shadow*` without `elevation`; every elevated surface must carry `elevation`. Verify cards/headers show depth on device.
- **Radius bump clipping:** larger radii must not clip inner content or images (e.g. avatar tiles). Verify no corner bleed on cards with images.

---

### Task 1: Premium token refresh — `lib/theme.ts`

**Files:**
- Modify: `lib/theme.ts` (values only; all exported keys unchanged)

**Interfaces:**
- Produces (unchanged keys, new values): `lightColors`, `colors`, `spacing`, `borderRadius`, `fontSize`, `shadows`, `glass`, `animation`, `typography`, `mobile`, `brand`, `sidebarColors`.

- [ ] **Step 1: Refresh `lightColors` values (keys unchanged)** — keep `primary:'#2563EB'`, `primaryDark:'#1D4ED8'`; set `background:'#F6F8FC'`, `surfaceSecondary:'#EEF2F8'`, `border:'#E6EBF2'`, `borderLight:'#EEF2F7'`, `textSecondary:'#5B6878'`, `textTertiary:'#8A98AA'` (keep AA contrast). Leave success/warning/danger/info families as-is.
- [ ] **Step 2: Soften radii** in `borderRadius` — `sm:14, md:16, lg:20, xl:24, xxl:30, full:9999`.
- [ ] **Step 3: Premium shadows** — in `shadows`, make `card`/`elevated`/`float` more diffuse (lower opacity ~0.05–0.10, larger radius ~22–28, keep/ increase `elevation` 2–6). Keep all five keys.
- [ ] **Step 4: Real glass tokens** — in `glass`, keep content `card`/`cardElevated` crisp white; add `blurIntensity: 40`, `blurTint: 'light'`, and a translucent `chrome: { backgroundColor:'rgba(255,255,255,0.72)' }`. Refresh `heroGradient` to premium blue `['#1E3A8A','#2563EB','#3B82F6']`. Keep existing keys.
- [ ] **Step 5: Transition tokens** — in `animation`, add `stackAnimation:'slide_from_right'` and `stackDuration: 220` (keep existing keys).
- [ ] **Step 6: Verify** — `npx tsc --noEmit` clean for `lib/theme.ts`; confirm no key removed/renamed (`git diff` shows only value lines). 
- [ ] **Step 7: Commit** — `git add lib/theme.ts && git commit -m "style(theme): premium-blue token refresh (values only)"`

---

### Task 2: Restyle shared components — `components/shared.tsx`

**Files:**
- Modify: `components/shared.tsx` (styling only; keep every export name + prop signature)

**Interfaces:**
- Consumes: refreshed tokens from Task 1.
- Produces (signatures unchanged): `GlassBackground`, `GlassHeader`, `GlassCard`, `StatCard`, `Button`, `Input`, `Badge`, `ListItem`, `SectionHeader`, `EmptyState`, `LoadingScreen`, `PickerSelect`, `DateField`, `PageHeader`, `IconBtnSolid`, `GhostLink`, `SearchField`, `FilterChip`, `EmptyPanel`, `ModuleCard`, `WEB`, date helpers.

- [ ] **Step 1: Glass chrome** — make `GlassHeader` and `PageHeader` use `BlurView` (intensity from `glass.blurIntensity`, translucent `glass.chrome` bg) on both platforms where cheap; keep hairline bottom border. Content cards (`GlassCard`, `ModuleCard`, `StatCard`) stay crisp white with the new soft shadow + new radius.
- [ ] **Step 2: Premium Button** — keep press-scale; refine to new radius, add soft primary shadow/`elevation`; keep variants and props identical.
- [ ] **Step 3: Inputs/Pickers/Chips/Badge** — apply new radius/border/surface tokens to `Input`, `PickerSelect`, `SearchField`, `FilterChip`, `Badge`; keep props.
- [ ] **Step 4: Unify palettes** — point hardcoded hex in shared components at the refreshed tokens/`WEB` where it keeps values consistent (keep `WEB` keys so screens importing it don't break; just align its values to the new look).
- [ ] **Step 5: Subtle entrance** — add a cheap fade/translate-in (RNAnimated or Reanimated) to `GlassCard`/`ModuleCard` mount; opt-in and low-cost; must not change layout size.
- [ ] **Step 6: Verify** — `npx tsc --noEmit` clean for `components/shared.tsx`; `git diff` shows no prop/name changes; Expo Go: header is glassy, cards crisp, buttons smooth.
- [ ] **Step 7: Commit** — `git add components/shared.tsx && git commit -m "style(shared): premium glass chrome + refreshed cards/controls"`

---

### Task 3: Central screen transitions — `App.tsx`

**Files:**
- Modify: `App.tsx` (navigator `screenOptions` only; no screen/route/handler changes)

**Interfaces:**
- Consumes: `animation.stackAnimation`, `animation.stackDuration` from Task 1.

- [ ] **Step 1: Stack animation** — add `animation: 'slide_from_right'`, `animationDuration: 220`, `gestureEnabled: true` to the `screenOptions` of `PropStack`, `TicketStack`, `TenantStack`, `AuthStack`, and `Stack` navigators (merge into existing `{ headerShown:false }`; do not touch `<Screen>` names/components).
- [ ] **Step 2: Tab/drawer polish (optional, safe)** — if cheap, add a short `sceneAnimationEnabled`/fade to the tenant bottom tab; skip if it risks layout. Leave drawer behavior as-is.
- [ ] **Step 3: Verify** — `npx tsc --noEmit` clean for `App.tsx`; `git diff` confirms only `screenOptions` lines changed; Expo Go: Tickets→TicketDetail and Login→PrivacyPolicy slide smoothly, back-gesture works.
- [ ] **Step 4: Commit** — `git add App.tsx && git commit -m "style(nav): consistent smooth stack transitions"`

---

### Task 4: Phase-1 live verification pass

- [ ] **Step 1:** Reload app in Expo Go; walk Login → Dashboard → Tenants → Tickets → TicketDetail → Settings.
- [ ] **Step 2:** Confirm: glass headers, crisp white cards with soft depth, smooth transitions, readable text, no layout breakage, every button/flow behaves exactly as before.
- [ ] **Step 3:** `npx tsc --noEmit` clean overall on touched files; note any pre-existing unrelated errors.
- [ ] **Step 4:** Report results; list anything deferred to Phase 2.

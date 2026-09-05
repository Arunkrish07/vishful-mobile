# Tenant Lifecycle — Exact Clone of Vercel Mobile Reference + Switching Fix

**Date:** 2026-09-05
**Status:** Design (approved approach, pending spec review)
**Owner:** mobile app (`screens/TenantLifecycleScreen.tsx`, `convex/tenants.ts`)

## Goal

Make the mobile **Tenant Lifecycle** screen an exact clone of the mobile
frame at `https://vishful-mobile-app.vercel.app` (Lifecycle section) —
matching layout, structure, spacing, and overall UI across all tabs —
**and** fix two functional bugs the user reported:

1. **Switch Type option not showing** in the New Switch form.
2. **EB not calculated** for the period a switched tenant stayed in the
   previous room.

The reference is the source of truth for **layout/style only**. Data
continues to flow from the existing Convex actions (extended where the
reference shows fields not yet computed — chiefly Switching EB/deposit).

Business logic (switch types, EB proration) is ported from the canonical
web app at `C:\vishful-web-v7\...\src\pages\TenantLifecycle.tsx`
(read-only; never edited).

## Decisions (user-approved)

- **Scope:** whole Lifecycle screen — all 10 reference tabs.
- **Build order:** shared design layer → **Switching first** (the broken
  thing) → remaining tabs top-down.
- **Switch backend writes:** deploy switch/EB functions to Convex dev,
  QA via **reads only** (`listRoomSwitches`, invoice reads). Real switch
  writes happen when the user uses the app. Honors the standing
  "no real accounting writes on dev" constraint.

## Reference structure (10 tab-strip items)

Horizontal, scrollable pill strip. Active = purple gradient pill
(icon+label, white text); inactive = light-gray pill (icon+label, dark
text).

| # | Item | Content summary |
|---|------|-----------------|
| 1 | **Overview** | "Bed Status" card: donut (Total 198), Current 86.4% / Month 89.4%, 5 status tiles (Occupied/Booked/Notice/Vacant/Not Booked) each with trend; tap a tile → detail list (search + tenant rows w/ edit). |
| 2 | Visual Map | Search + Sort + `…`; filter chips (All/Occupied/Vacant/Notice/Booked); apartment cards, each a horizontal strip of color-coded bed tiles (green occupied, yellow notice, blue booked, pink vacant) + chevron. |
| 3 | Booking | "New Tenants (KYC ✓)" cards (avatar, name, phone, KYC status, **Book**) + "+ New Booking"; "Returning Tenants (Previously Exited)" search; "Booked — Pending Onboarding". |
| 4 | Onboarding | "Booked — Ready for Onboarding" cards (avatar, name, property·bed, Booked/Planned dates, amount, **Onboard**/**Cancel**). |
| 5 | **Switching** | "Room Switching" + **+ New Switch**; search; status cards (see below); New Switch sheet (see below). |
| 6 | Notices | "Tenant Notices" + **Record Notice**; search; cards (avatar, name, **On Notice** badge, bed·property, Est. exit, amount, **Edit**/**Delete**). |
| 7 | Exit | Sub-tabs "Tenants on Notice (N)" / "Exit History (N)"; 3 KPI tiles (Est. Refund Due / 1 Week / 1 Month); cards (name, bed, Est. exit·Bal·Adv, amount, **Statement**/**Process Exit** + full-width **Create Pre-Exit Task**). |
| 8 | Refunds | "Refund Tracking" + **Download PDF**; search; cards (name, **Pending** badge, amount [green refund / red "Tenant Owes"], Exit·Held·Ded·days, **Edit**/**Complete** or **Collect**/**Statement**). |
| 9 | Not in Property | "Not in Property (Absence Records)" + **+ Add Absence**; subtitle about 30-day EB exclusion; search; cards (name, bed, date→date·days, Reason, **Edit**/**Delete**). |
| 10 | **Excel Upload** | Tab-styled item that opens an upload dialog (toast "Excel upload opened"). |

## Current mobile vs reference (delta)

- Header "Tenant Lifecycle" — **already matches**.
- `TABS` (`:351`) has 8 items (Visual Map → Not in Property). Bed Status
  is an always-on card (`renderBedStatusCard` `:1939`), **not** a tab.
  Excel Upload is a toast button (`:4587`), **not** in the strip.
- **Restructure:** Bed Status → first, default-selected **"Overview"**
  tab; Excel Upload → last strip item (keeps toast).
- Card/badge/button styling differs from the reference → restyle via the
  shared layer.

## Shared design layer (build first)

New tokens + components (in `screens/TenantLifecycleScreen.tsx` or a
co-located `components/lifecycle/`):

- **Tokens:** page bg off-white; card = white, radius ~16, soft shadow,
  padding ~14; primary blue `#2563EB`; destructive = light-red outline
  `#FEE2E2`/`#DC2626`; badges — green `#DCFCE7`/`#16A34A` (Completed),
  gray `#F1F5F9`/`#64748B` (Scheduled/Cancelled), orange
  `#FEF3C7`/`#D97706` (On Notice/Pending); search field gray rounded.
- **Components:** `PillTabStrip`, `LifecycleCard`, `StatusBadge`,
  `PrimaryButton`/`OutlineButton`, `SearchField`, `KpiTile`, `InfoLine`
  (compact `Type · Date · Rent± · EB · Deposit±` row), `AvatarInitial`.

Existing `Card`/`Row`/`ActionBtn`/`SelectF`/`DateF`/`BottomSheet` are
reused/wrapped, not thrown away.

## Switching — functional spec (P1)

### New Switch sheet (match reference field order)

Tenant (Staying)\* → **Switch Type** (Immediate / Future) → Switch Date →
**Effective Date** (only when Future) → New Bed\* → **Notes** →
Process Switch.

### Cards

Status badge (Completed / Scheduled / Cancelled), `oldBed → newBed`,
`InfoLine`: `Type · Date · Rent± · EB ₹… · Deposit ±₹…`. Buttons by
status: **Completed** → View / Reswitch; **Scheduled** → Complete /
Cancel; **Cancelled** → View only.

### Backend (`convex/tenants.ts`)

Port from web `processSwitch` (`TenantLifecycle.tsx:3041–3384`),
`completeSwitch` (`:1225–1482`), `cancelSwitch` (`~1493`).

- **`processSwitchFull`** — accept `switch_type`, `notes`,
  `effective_date`. Stop hardcoding `switch_type:"immediate"`.
  - **immediate:** new allotment `Staying`, old `Exited`, beds
    vacant/occupied, `room_switches.status="completed"` + `completed_at`,
    post rent-diff + EB + deposit entries now.
  - **future:** new allotment `Booked` (onboarding_date null), old
    `On-Notice` (notice_date today, est_exit=effective_date), beds
    notice/booked, `room_switches.status="scheduled"`; financials
    deferred to `completeSwitch`.
- **EB proration** (verbatim from web `:3074–3096`):
  1. `ebReading` = previous calendar month's `electricity_readings` for
     `oldApt.apartment_id` (match `billing_month` in `MMM-yy` **or**
     `yyyy-MM`).
  2. `totalBill = (reading_end − reading_start) × unit_cost`.
  3. `totalTenantDays = getTotalTenantDaysInMonth(oldApt, prevMonth)`.
  4. `perDay = totalBill / totalTenantDays`.
  5. `daysUsed = max(1, differenceInDays(switchDate, onboarding_date))`.
  6. `ebCharges = ceil(perDay × daysUsed)` → store on
     `room_switches.eb_charges` + post an invoice on the OLD bed
     (`invoice_type:"regular"`, `electricity_amount=ebCharges`, line item
     "Actual EB — <oldApt> until room switch",
     `reference_type:"room_switch"`).
  - No slab logic (flat per-unit). Switch path does **not** deduct
    absence days (matches web).
- **Rent proration** (web `:3190–3269`): `chargeDays = daysInMonth −
  switchDate.getDate() + 1`; upgrade → invoice
  `((newRate−oldRate)/daysInMonth) × chargeDays`; downgrade → credit_note
  adjustment.
- **Deposit difference** via advance_ratio (default 1.5) — web
  `computeSwitchDepositDifference` `:1167–1223`.
- **New actions:** `completeSwitch`, `cancelSwitch` (gate: only
  `status="scheduled"`).
- **`listRoomSwitches`** — return `ebCharges`, `depositDifference`,
  `status`, `switchType`, `notes`.

### Tables/columns

`room_switches`: `switch_type ∈ {immediate,future}`, `status ∈
{completed,scheduled,cancelled}`, `eb_charges`, `deposit_difference`,
`effective_date`, `notes`, `completed_at`, `completed_by`,
`old_allotment_id`, `new_allotment_id`, `old/new_apartment_id`,
`old/new_property_id`, `old_rent`, `new_rent`, `adjustment_type`.
`electricity_readings`: `apartment_id`, `billing_month`, `reading_start`,
`reading_end`, `unit_cost`. `invoices`/`invoice_line_items`,
`tenant_adjustments`.

### QA (read-only)

Deploy to dev; verify via `listRoomSwitches` that existing switches carry
`ebCharges`/`status`; verify the code paths with `tsc`. No live
`processSwitchFull` writes on dev (user runs real switches in-app).

## Phasing

- **P0** — shared design layer + header/pill strip + Overview &
  Excel-Upload restructure.
- **P1** — **Switching** full rebuild (frontend + backend + EB), deploy,
  read-QA.
- **P2** — Visual Map + Booking + Onboarding restyle.
- **P3** — Notices + Exit + Refunds + Not in Property restyle.
- **P4** — polish pass vs reference screenshots; web/Expo-Go QA.

Each phase: `npx tsc --noEmit` clean before moving on; visual QA against
the captured reference screenshots.

## Out of scope / deferred

- Deep re-implementation of already-deferred sub-features (UPI
  auto-match, salary Excel, etc.).
- Any live accounting/switch **writes** on dev (read-QA only).
- Pixel-identical fake data — the reference's sample numbers are a mock;
  we match layout/structure/spacing, not its literal values.

## Risks

- 4,619-line screen → large diff; mitigated by shared layer + phasing.
- Switch backend is a real mutation path; mitigated by read-only QA +
  in-app real writes.
- Reference is a design mock; some flows (e.g. Exit sub-tabs) may need
  data wiring beyond what the mock implies — flag per tab during
  implementation.

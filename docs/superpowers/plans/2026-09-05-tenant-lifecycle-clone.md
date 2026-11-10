# Tenant Lifecycle Clone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mobile Tenant Lifecycle screen an exact clone of the Vercel mobile reference (all 10 tabs) and fix Switching (Switch Type selector + EB proration for the old room).

**Architecture:** Build a small shared Lifecycle design layer (tokens + reusable components) first, then re-skin each tab with it. Do the broken Switching tab first (frontend form/cards + Convex backend for switch types, EB proration, and scheduled complete/cancel), then restyle the remaining tabs top-down. Data keeps flowing from existing Convex actions; the reference governs layout/style only.

**Tech Stack:** React Native + Expo SDK 57, TypeScript, Convex (service-role Supabase actions in `convex/tenants.ts`). No unit-test framework — verification is `npx tsc --noEmit` + visual/read QA.

**Spec:** `docs/superpowers/specs/2026-09-05-tenant-lifecycle-clone-design.md` (read it alongside this plan).

## Global Constraints

- **Verification gate per task:** `npx tsc --noEmit` must be clean before commit. There is no jest/vitest — do NOT add test files or `test` scripts.
- **Reference is layout-only source of truth** at `https://vishful-mobile-app.vercel.app` → Lifecycle. Match layout/structure/spacing; do NOT copy the mock's literal sample numbers.
- **Web app is read-only** at `C:\vishful-web-v7\...` — never edit it; port logic verbatim.
- **No real accounting/switch writes on Convex dev.** Deploy functions and QA via READS only (`listRoomSwitches`, invoice reads). Real `processSwitchFull` writes happen when the user uses the app.
- **Convex deploy to dev:** `npx convex dev --once` (dev deployment `polished-sockeye-740`). If bundling breaks on the orphan `convex/registrationpdf.ts`, deploy with `--typecheck disable` (see memory note).
- **Target file:** `screens/TenantLifecycleScreen.tsx` (4,619 lines) + `convex/tenants.ts`. New shared components go in `components/lifecycle/`.
- **Branch:** work on current `sdk-54-expo-go` (do not switch); commit each task separately. End commit messages with the Co-Authored-By trailer.
- **Reference colors:** primary blue `#2563EB`; badges green `#DCFCE7`/`#16A34A`, gray `#F1F5F9`/`#64748B`, orange `#FEF3C7`/`#D97706`; destructive `#FEE2E2`/`#DC2626`; ink `#0F172A`; muted `#64748B`; card white radius 16 padding 14 soft shadow; page bg off-white.

---

## Phase 0 — Shared design layer + tab restructure

### Task 1: Lifecycle design tokens + StatusBadge

**Files:**
- Create: `components/lifecycle/tokens.ts`
- Create: `components/lifecycle/StatusBadge.tsx`

**Interfaces:**
- Produces: `LC` (token object) with `LC.blue='#2563EB'`, `LC.ink='#0F172A'`, `LC.muted='#64748B'`, `LC.cardRadius=16`, `LC.cardPad=14`, `LC.pageBg='#F7F8FA'`, and `LC.badge` map (see below).
- Produces: `<StatusBadge kind='completed'|'scheduled'|'cancelled'|'onNotice'|'pending' label?={string} />`.

- [ ] **Step 1: Create `components/lifecycle/tokens.ts`**

```ts
export const LC = {
  blue: '#2563EB', ink: '#0F172A', muted: '#64748B', pageBg: '#F7F8FA',
  cardBg: '#FFFFFF', cardRadius: 16, cardPad: 14, border: '#EEF1F5',
  green: '#16A34A', greenBg: '#DCFCE7', gray: '#64748B', grayBg: '#F1F5F9',
  orange: '#D97706', orangeBg: '#FEF3C7', red: '#DC2626', redBg: '#FEE2E2',
  cardShadow: {
    shadowColor: '#0F172A', shadowOpacity: 0.06, shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
} as const;

export const BADGE = {
  completed: { bg: LC.greenBg, fg: LC.green, text: 'Completed' },
  scheduled: { bg: LC.grayBg,  fg: LC.gray,  text: 'Scheduled' },
  cancelled: { bg: LC.grayBg,  fg: LC.gray,  text: 'Cancelled' },
  onNotice:  { bg: LC.orangeBg, fg: LC.orange, text: 'On Notice' },
  pending:   { bg: LC.orangeBg, fg: LC.orange, text: 'Pending' },
} as const;
export type BadgeKind = keyof typeof BADGE;
```

- [ ] **Step 2: Create `components/lifecycle/StatusBadge.tsx`**

```tsx
import React from 'react';
import { View, Text } from 'react-native';
import { BADGE, BadgeKind } from './tokens';

export function StatusBadge({ kind, label }: { kind: BadgeKind; label?: string }) {
  const b = BADGE[kind];
  return (
    <View style={{ backgroundColor: b.bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color: b.fg }}>{label ?? b.text}</Text>
    </View>
  );
}
```

- [ ] **Step 3: Verify + commit**

Run: `npx tsc --noEmit` → Expected: clean (no new errors).
```bash
git add components/lifecycle/tokens.ts components/lifecycle/StatusBadge.tsx
git commit -m "feat(lifecycle): design tokens + StatusBadge"
```

---

### Task 2: Core reusable components (Card, buttons, search, KPI, InfoLine, Avatar)

**Files:**
- Create: `components/lifecycle/index.tsx`

**Interfaces:**
- Consumes: `LC` from Task 1.
- Produces:
  - `<LifecycleCard style?>{children}</LifecycleCard>`
  - `<PrimaryButton title icon? onPress loading? disabled? small? />`
  - `<OutlineButton title icon? onPress tone?='neutral'|'danger'|'success' small? />`
  - `<SearchField value onChangeText placeholder />`
  - `<KpiTile label value valueColor? />`
  - `<InfoLine parts={Array<{text:string;color?:string;bold?:boolean}>} />`
  - `<AvatarInitial name />`

- [ ] **Step 1: Create `components/lifecycle/index.tsx`** with all seven components

```tsx
import React from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LC } from './tokens';

export function LifecycleCard({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return (
    <View style={[{ backgroundColor: LC.cardBg, borderRadius: LC.cardRadius, padding: LC.cardPad, marginBottom: 12 }, LC.cardShadow, style]}>
      {children}
    </View>
  );
}

export function PrimaryButton({ title, icon, onPress, loading, disabled, small }: any) {
  return (
    <Pressable onPress={onPress} disabled={disabled || loading}
      style={{ backgroundColor: disabled ? '#93B4FB' : LC.blue, borderRadius: 10, paddingVertical: small ? 8 : 12,
        paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, flex: small ? 1 : undefined }}>
      {loading ? <ActivityIndicator color="#fff" /> : icon ? <Ionicons name={icon} size={16} color="#fff" /> : null}
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: small ? 13 : 15 }}>{title}</Text>
    </Pressable>
  );
}

export function OutlineButton({ title, icon, onPress, tone = 'neutral', small }: any) {
  const map: any = {
    neutral: { bg: '#fff', fg: LC.ink, bd: LC.border },
    danger:  { bg: LC.redBg, fg: LC.red, bd: '#FCA5A5' },
    success: { bg: '#ECFDF5', fg: LC.green, bd: '#86EFAC' },
  };
  const c = map[tone];
  return (
    <Pressable onPress={onPress}
      style={{ backgroundColor: c.bg, borderColor: c.bd, borderWidth: 1, borderRadius: 10,
        paddingVertical: small ? 8 : 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1 }}>
      {icon ? <Ionicons name={icon} size={15} color={c.fg} /> : null}
      <Text style={{ color: c.fg, fontWeight: '700', fontSize: small ? 13 : 14 }}>{title}</Text>
    </Pressable>
  );
}

export function SearchField({ value, onChangeText, placeholder }: any) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F3F6', borderRadius: 10, paddingHorizontal: 12, height: 40, marginBottom: 12 }}>
      <Ionicons name="search-outline" size={16} color={LC.muted} />
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={LC.muted}
        style={{ flex: 1, marginLeft: 8, fontSize: 14, color: LC.ink }} />
    </View>
  );
}

export function KpiTile({ label, value, valueColor }: any) {
  return (
    <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 10, borderWidth: 1, borderColor: LC.border }}>
      <Text style={{ fontSize: 9, fontWeight: '700', color: LC.muted, letterSpacing: 0.5 }}>{label}</Text>
      <Text style={{ fontSize: 15, fontWeight: '800', color: valueColor || LC.ink, marginTop: 4 }}>{value}</Text>
    </View>
  );
}

export function InfoLine({ parts }: { parts: Array<{ text: string; color?: string; bold?: boolean }> }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 6 }}>
      {parts.map((p, i) => (
        <Text key={i} style={{ fontSize: 12, color: p.color || LC.muted, fontWeight: p.bold ? '700' : '500' }}>{p.text}</Text>
      ))}
    </View>
  );
}

export function AvatarInitial({ name }: { name: string }) {
  const ch = (name || '?').trim().charAt(0).toUpperCase();
  return (
    <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: '#EEF2FF', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: LC.blue, fontWeight: '800', fontSize: 14 }}>{ch}</Text>
    </View>
  );
}
```

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit` → Expected: clean.
```bash
git add components/lifecycle/index.tsx
git commit -m "feat(lifecycle): reusable Card/Button/Search/Kpi/InfoLine/Avatar"
```

---

### Task 3: Pill tab-strip restyle + Overview/Excel-Upload restructure

**Files:**
- Modify: `screens/TenantLifecycleScreen.tsx:351-360` (TABS array), `:4480-4620` (header/strip/content render).

**Interfaces:**
- Consumes: `LC` (Task 1), components (Task 2), existing `renderBedStatusCard` (`:1939`), `tabContent` map (`:4446`), `activeTab`/`setActiveTab` (`:731`).
- Produces: TABS now includes `{ key:'overview', label:'Overview', icon:'grid-outline' }` first and `{ key:'excel', label:'Excel Upload', icon:'document-outline' }` last; `activeTab` defaults to `'overview'`.

- [ ] **Step 1: Add Overview + Excel Upload to TABS** (`:351`)

```ts
const TABS = [
  { key: 'overview', label: 'Overview',        icon: 'grid-outline'           },
  { key: 'map',      label: 'Visual Map',      icon: 'map-outline'            },
  { key: 'booking',  label: 'Booking',         icon: 'calendar-outline'       },
  { key: 'onboard',  label: 'Onboarding',      icon: 'person-add-outline'     },
  { key: 'switch',   label: 'Switching',       icon: 'swap-horizontal-outline'},
  { key: 'notices',  label: 'Notices',         icon: 'notifications-outline'  },
  { key: 'exit',     label: 'Exit',            icon: 'log-out-outline'        },
  { key: 'refunds',  label: 'Refunds',         icon: 'wallet-outline'         },
  { key: 'absent',   label: 'Not in Property', icon: 'home-outline'           },
  { key: 'excel',    label: 'Excel Upload',    icon: 'document-outline'       },
];
```

- [ ] **Step 2: Default `activeTab` to `'overview'`** (`:731`) — change `useState<string | null>(null)` to `useState<string>('overview')`.

- [ ] **Step 3: Restyle the tab-strip pills** — in the horizontal tab `ScrollView` (around `:4550-4600`), replace each pill's style so active = purple gradient pill, inactive = light-gray pill, both showing icon + label:

```tsx
// per-tab pill (active = solid purple, inactive = light gray)
<Pressable key={tab.key} onPress={() => {
    if (tab.key === 'excel') { Alert.alert('Excel Upload', 'Excel upload opened'); return; }
    setActiveTab(tab.key);
  }}
  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 999, marginRight: 8,
    backgroundColor: active ? '#6D5EF6' : '#EEF0F4' }}>
  <Ionicons name={tab.icon as any} size={15} color={active ? '#fff' : '#334155'} />
  <Text style={{ fontSize: 13, fontWeight: '700', color: active ? '#fff' : '#334155' }}>{tab.label}</Text>
</Pressable>
```

(Keep the existing Excel Upload toast `Alert.alert('Excel Upload', 'Excel upload opened')` — now fired from the strip item, remove the separate standalone button at `:4587`.)

- [ ] **Step 4: Route `overview` tab to Bed Status** — in the content switch (`:4613`), when `activeTab==='overview'` render `renderBedStatusCard()` + the bed-focus detail; remove the always-on Bed Status card that rendered above the strip (`:4546`) so Bed Status only shows under the Overview tab (matches reference).

- [ ] **Step 5: Verify + visual QA + commit**

Run: `npx tsc --noEmit` → Expected: clean.
Visual QA: launch Expo/web, open Lifecycle → strip shows Overview first (selected, purple), Excel Upload last; tapping Excel Upload shows the toast; Overview shows Bed Status.
```bash
git add screens/TenantLifecycleScreen.tsx
git commit -m "feat(lifecycle): pill tab-strip + Overview/Excel-Upload restructure"
```

---

## Phase 1 — Switching (frontend + backend + EB)

### Task 4: Backend — EB proration helper + `processSwitchFull` immediate/future branches

**Files:**
- Modify: `convex/tenants.ts:500-540` (`processSwitchFull`), add a `getTotalTenantDaysInMonth` helper near it.

**Interfaces:**
- Consumes: existing `getSupabase()`, `insertRow(table, row)`, `ORG_ID`, `today` pattern.
- Produces: `processSwitchFull` now reads `data.switchType` (`'immediate'|'future'`), `data.notes`, `data.effectiveDate`; computes and stores `eb_charges`, `deposit_difference`, `status`. Helper `getTotalTenantDaysInMonth(sb, apartmentId, prevMonthDate): Promise<number>`.

- [ ] **Step 1: Add the tenant-days helper** (port of web `:1731-1749`) above `processSwitchFull`:

```ts
// Sum of each tenant's occupied days in `apartmentId` during the month of prevMonth.
async function getTotalTenantDaysInMonth(sb: any, apartmentId: string, prevMonth: Date): Promise<number> {
  const y = prevMonth.getFullYear(), m = prevMonth.getMonth();
  const monthStart = new Date(y, m, 1);
  const monthEnd = new Date(y, m + 1, 0); // last day of month
  const daysInMonth = monthEnd.getDate();
  const { data: allots } = await sb.from('tenant_allotments')
    .select('onboarding_date, actual_exit_date, staying_status')
    .eq('apartment_id', apartmentId).eq('organization_id', ORG_ID);
  if (!allots || allots.length === 0) return daysInMonth;
  let total = 0;
  for (const a of allots) {
    const onb = a.onboarding_date ? new Date(a.onboarding_date) : monthStart;
    const ext = a.actual_exit_date ? new Date(a.actual_exit_date) : monthEnd;
    const start = onb > monthStart ? onb : monthStart;
    const end = ext < monthEnd ? ext : monthEnd;
    const days = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
    if (days > 0) total += days;
  }
  return total > 0 ? total : daysInMonth;
}
```

- [ ] **Step 2: Rewrite `processSwitchFull`** (`:500`) to branch on switch type, compute EB, and set status. Replace the handler body:

```ts
handler: async (_ctx, { data }) => {
  const sb = getSupabase();
  const oldRate = data.oldRate || 0;
  const newRate = data.newRate || 0;
  const rentDiff = newRate - oldRate;
  const today = new Date().toISOString().split('T')[0];
  const switchType: 'immediate' | 'future' = data.switchType === 'future' ? 'future' : 'immediate';
  const switchDateStr = data.switchDate || today;
  const effectiveDateStr = switchType === 'future' ? (data.effectiveDate || switchDateStr) : switchDateStr;

  // --- fetch old allotment (for onboarding_date + old apartment) ---
  const { data: allotRow } = await sb.from('tenant_allotments')
    .select('id, apartment_id, onboarding_date, deposit_paid')
    .eq('id', data.allotmentId).eq('organization_id', ORG_ID).single();
  const oldAptId = allotRow?.apartment_id || data.oldApartmentId;

  // --- EB proration for the OLD room (port of web :3074-3096) ---
  let ebCharges = 0;
  const switchDate = new Date(switchDateStr);
  const prevMonth = new Date(switchDate.getFullYear(), switchDate.getMonth() - 1, 1);
  const mmmYy = prevMonth.toLocaleString('en-US', { month: 'short', year: '2-digit' }).replace(' ', '-'); // e.g. Aug-26
  const yyyyMm = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
  const { data: ebRows } = await sb.from('electricity_readings')
    .select('reading_start, reading_end, unit_cost, billing_month')
    .eq('apartment_id', oldAptId);
  const ebReading = (ebRows || []).find((r: any) => r.billing_month === mmmYy || r.billing_month === yyyyMm);
  if (ebReading) {
    const totalUnits = Number(ebReading.reading_end) - Number(ebReading.reading_start);
    const totalBill = totalUnits * Number(ebReading.unit_cost);
    const totalTenantDays = await getTotalTenantDaysInMonth(sb, oldAptId, prevMonth);
    const perDay = totalTenantDays > 0 ? totalBill / totalTenantDays : 0;
    const onb = allotRow?.onboarding_date ? new Date(allotRow.onboarding_date) : switchDate;
    const daysUsed = Math.max(1, Math.floor((switchDate.getTime() - onb.getTime()) / 86400000));
    ebCharges = Math.ceil(perDay * daysUsed);
  }

  // --- deposit difference (advance_ratio default 1.5) ---
  const depositDifference = Math.round((newRate - oldRate) * 1.5);

  const status = switchType === 'immediate' ? 'completed' : 'scheduled';

  // --- insert room_switches ---
  await insertRow('room_switches', {
    tenant_id: data.tenantId, allotment_id: data.allotmentId,
    old_bed_id: data.oldBedId, new_bed_id: data.newBedId,
    old_apartment_id: oldAptId, new_apartment_id: data.newApartmentId || null,
    switch_type: switchType, switch_date: switchDateStr, effective_date: effectiveDateStr,
    rent_difference: rentDiff, deposit_difference: depositDifference, eb_charges: ebCharges,
    adjustment_type: rentDiff > 0 ? 'tenant_pays' : rentDiff < 0 ? 'credit_tenant' : 'none',
    status, notes: data.notes || null,
    completed_at: status === 'completed' ? new Date().toISOString() : null,
  });

  if (switchType === 'immediate') {
    // move tenant now
    await sb.from('tenant_allotments').update({
      bed_id: data.newBedId, apartment_id: data.newApartmentId || undefined,
      property_id: data.newPropertyId || undefined, monthly_rental: newRate,
    } as any).eq('id', data.allotmentId).eq('organization_id', ORG_ID);
    await sb.from('beds').update({ bed_lifecycle_status: 'vacant' } as any).eq('id', data.oldBedId);
    await sb.from('beds').update({ bed_lifecycle_status: 'occupied' } as any).eq('id', data.newBedId);
    // post the actual-EB invoice on the OLD bed
    if (ebCharges > 0) {
      await insertRow('invoices', {
        tenant_id: data.tenantId, allotment_id: data.allotmentId, bed_id: data.oldBedId,
        invoice_type: 'regular', electricity_amount: ebCharges, total_amount: ebCharges,
        billing_month: yyyyMm, reference_type: 'room_switch',
      });
    }
  } else {
    // scheduled: old room On-Notice, new bed Booked; financials deferred to completeSwitch
    await sb.from('tenant_allotments').update({
      staying_status: 'On-Notice', notice_date: today, estimated_exit_date: effectiveDateStr,
    } as any).eq('id', data.allotmentId).eq('organization_id', ORG_ID);
    await sb.from('beds').update({ bed_lifecycle_status: 'notice' } as any).eq('id', data.oldBedId);
    await sb.from('beds').update({ bed_lifecycle_status: 'booked' } as any).eq('id', data.newBedId);
  }

  return { success: true, ebCharges, depositDifference, status };
},
```

- [ ] **Step 3: Verify + commit**

Run: `npx tsc --noEmit` → Expected: clean.
```bash
git add convex/tenants.ts
git commit -m "feat(switch): switch types + EB proration in processSwitchFull"
```

---

### Task 5: Backend — `completeSwitch`, `cancelSwitch`, and enrich `listRoomSwitches`

**Files:**
- Modify: `convex/tenants.ts` — add two actions after `processSwitchFull`; extend `listRoomSwitches` (`:1030-1050`).

**Interfaces:**
- Consumes: `getSupabase`, `insertRow`, `ORG_ID`.
- Produces: `completeSwitch({ switchId })`, `cancelSwitch({ switchId })`; `listRoomSwitches` rows now include `ebCharges`, `depositDifference`, `status`, `switchType`, `notes`.

- [ ] **Step 1: Extend `listRoomSwitches` mapping** (`:1048`) to add fields:

```ts
return (rows || []).map((s: any) => ({
  _id: s.id, tenantId: s.tenant_id, allotmentId: s.allotment_id,
  oldBedId: s.old_bed_id, newBedId: s.new_bed_id,
  switchType: s.switch_type || 'immediate', switchDate: s.switch_date,
  rentDifference: s.rent_difference || 0,
  ebCharges: s.eb_charges || 0, depositDifference: s.deposit_difference || 0,
  status: s.status || 'completed', notes: s.notes || '',
  tenantName: /* existing name resolution */ s._tenantName,
}));
```
(Preserve the existing `tenantName` resolution already present in the function; only add the new fields.)

- [ ] **Step 2: Add `completeSwitch`** — gate on `status='scheduled'`, then apply the immediate move + post EB/rent invoices using the stored `eb_charges`:

```ts
export const completeSwitch = action({
  args: { switchId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { switchId }) => {
    const sb = getSupabase();
    const { data: sw } = await sb.from('room_switches').select('*')
      .eq('id', switchId).eq('organization_id', ORG_ID).single();
    if (!sw || sw.status !== 'scheduled') return { success: false, error: 'not scheduled' };
    await sb.from('tenant_allotments').update({
      bed_id: sw.new_bed_id, apartment_id: sw.new_apartment_id || undefined,
      staying_status: 'Staying', notice_date: null, estimated_exit_date: null,
    } as any).eq('id', sw.allotment_id).eq('organization_id', ORG_ID);
    await sb.from('beds').update({ bed_lifecycle_status: 'vacant' } as any).eq('id', sw.old_bed_id);
    await sb.from('beds').update({ bed_lifecycle_status: 'occupied' } as any).eq('id', sw.new_bed_id);
    if ((sw.eb_charges || 0) > 0) {
      await insertRow('invoices', {
        tenant_id: sw.tenant_id, allotment_id: sw.allotment_id, bed_id: sw.old_bed_id,
        invoice_type: 'regular', electricity_amount: sw.eb_charges, total_amount: sw.eb_charges,
        reference_type: 'room_switch',
      });
    }
    await sb.from('room_switches').update({
      status: 'completed', completed_at: new Date().toISOString(),
    } as any).eq('id', switchId).eq('organization_id', ORG_ID);
    return { success: true };
  },
});
```

- [ ] **Step 3: Add `cancelSwitch`** — gate on `status='scheduled'`, revert old allotment to Staying and free the booked bed:

```ts
export const cancelSwitch = action({
  args: { switchId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { switchId }) => {
    const sb = getSupabase();
    const { data: sw } = await sb.from('room_switches').select('*')
      .eq('id', switchId).eq('organization_id', ORG_ID).single();
    if (!sw || sw.status !== 'scheduled') return { success: false, error: 'not scheduled' };
    await sb.from('tenant_allotments').update({
      staying_status: 'Staying', notice_date: null, estimated_exit_date: null,
    } as any).eq('id', sw.allotment_id).eq('organization_id', ORG_ID);
    await sb.from('beds').update({ bed_lifecycle_status: 'occupied' } as any).eq('id', sw.old_bed_id);
    await sb.from('beds').update({ bed_lifecycle_status: 'vacant' } as any).eq('id', sw.new_bed_id);
    await sb.from('room_switches').update({ status: 'cancelled' } as any)
      .eq('id', switchId).eq('organization_id', ORG_ID);
    return { success: true };
  },
});
```

- [ ] **Step 4: Verify + commit**

Run: `npx tsc --noEmit` → Expected: clean.
```bash
git add convex/tenants.ts
git commit -m "feat(switch): completeSwitch + cancelSwitch + enriched listRoomSwitches"
```

---

### Task 6: Deploy backend to dev + read-QA

**Files:** none (deploy + verification only).

- [ ] **Step 1: Deploy**

Run: `npx convex dev --once` (if it fails on `convex/registrationpdf.ts`, run `npx convex dev --once --typecheck disable`).
Expected: functions push succeeds; `tenants:completeSwitch`, `tenants:cancelSwitch` appear.

- [ ] **Step 2: Read-QA `listRoomSwitches`**

Run: `npx convex run tenants:listRoomSwitches '{}'`
Expected: rows include `ebCharges`, `depositDifference`, `status`, `switchType`, `notes` keys (values may be 0/'immediate'/'completed' for legacy rows — that's fine; confirms the shape).

- [ ] **Step 3: Do NOT run `processSwitchFull`/`completeSwitch`/`cancelSwitch` writes on dev.** Note in the task log that the write path is verified only by `tsc` + shape; real writes happen in-app. Commit nothing (deploy-only task).

---

### Task 7: Frontend — New Switch sheet (Switch Type, Effective Date, Notes, reorder)

**Files:**
- Modify: `screens/TenantLifecycleScreen.tsx:1026-1027` (`blankSwitch`), `:1526-1540` (`doSwitch`), `:3458-3483` (Room Switch BottomSheet).

**Interfaces:**
- Consumes: existing `SelectF`, `DateF`, `Field`, `BottomSheet`, `swForm`/`setSwForm`, `stayingAllotments`, `switchBedOpts`.
- Produces: `swForm` now carries `switchType`, `effectiveDate`, `notes`; `doSwitch` passes them to `processSwitchFull`.

- [ ] **Step 1: Extend `blankSwitch`** (`:1026`):

```ts
const blankSwitch = { allotmentId: '', tenantId: '', oldBedId: '', newBedId: '',
  switchType: 'immediate', switchDate: today(), effectiveDate: '', notes: '',
  oldRate: 0, newRate: 0, newAptId: '', newPropId: '' };
```

- [ ] **Step 2: Pass new fields in `doSwitch`** (`:1529`) — add to the `processSwitchFull` `data`:

```ts
switchType: swForm.switchType,
effectiveDate: swForm.effectiveDate || swForm.switchDate,
notes: swForm.notes,
```

- [ ] **Step 3: Rebuild the Room Switch sheet body** (`:3459-3482`) in reference field order (Tenant → Switch Type → Switch Date → Effective Date[future] → New Bed → Notes → Process Switch):

```tsx
<Field label="Tenant (Staying) *">
  <SelectF options={stayingOpts} value={swForm.allotmentId} onChange={v => {
    const a = stayingAllotments.find((x: any) => x.id === v);
    const rate = getBedRate(a?.bed_id || '');
    setSwForm({ ...swForm, allotmentId: v, tenantId: a?.tenant_id || '', oldBedId: a?.bed_id || '', newBedId: '', oldRate: rate });
  }} />
</Field>
<Field label="Switch Type">
  <SelectF options={[{ label: 'Immediate', value: 'immediate' }, { label: 'Future', value: 'future' }]}
    value={swForm.switchType} onChange={v => setSwForm({ ...swForm, switchType: v })} />
</Field>
<Field label="Switch Date"><DateF value={swForm.switchDate} onChange={v => setSwForm({ ...swForm, switchDate: v, effectiveDate: v })} /></Field>
{swForm.switchType === 'future' && (
  <Field label="Effective Date"><DateF value={swForm.effectiveDate || swForm.switchDate} onChange={v => setSwForm({ ...swForm, effectiveDate: v })} /></Field>
)}
<Field label="New Bed *">
  <SelectF options={switchBedOpts} value={swForm.newBedId} onChange={v => {
    const b = bedById[v]; const apt = aptById[b?.apartment_id]; const rate = getBedRate(v);
    setSwForm({ ...swForm, newBedId: v, newRate: rate, newAptId: apt?.id || '', newPropId: apt?.property_id || '' });
  }} />
</Field>
{swForm.oldBedId && swForm.newBedId && (
  <Card style={{ marginBottom: 14 }}>
    <Row label="Current Rent" value={`₹${fmtAmt(swForm.oldRate)}`} />
    <Row label="New Rent" value={`₹${fmtAmt(swForm.newRate)}`} />
    <Row label="Difference" value={`${swForm.newRate - swForm.oldRate > 0 ? '+' : ''}₹${fmtAmt(swForm.newRate - swForm.oldRate)}`}
      valueColor={swForm.newRate > swForm.oldRate ? '#DC2626' : '#16A34A'} />
  </Card>
)}
<Field label="Notes">
  <TextInput value={swForm.notes} onChangeText={v => setSwForm({ ...swForm, notes: v })} placeholder="Notes"
    multiline style={{ borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 10, padding: 10, minHeight: 70, textAlignVertical: 'top' }} />
</Field>
<ActionBtn title="Process Switch" onPress={doSwitch} loading={saving} disabled={!swForm.allotmentId || !swForm.newBedId} />
```
(Ensure `TextInput` is imported from `react-native` at the top of the file — it already is if other inputs exist; verify.)

- [ ] **Step 4: Verify + visual QA + commit**

Run: `npx tsc --noEmit` → Expected: clean.
Visual QA: open Switching → New Switch → the sheet shows **Switch Type** (Immediate/Future); choosing Future reveals **Effective Date**; **Notes** present; order matches the reference screenshot.
```bash
git add screens/TenantLifecycleScreen.tsx
git commit -m "feat(switch): New Switch sheet — Switch Type, Effective Date, Notes"
```

---

### Task 8: Frontend — Switching cards restyle (status badge, EB/Deposit InfoLine, status buttons)

**Files:**
- Modify: `screens/TenantLifecycleScreen.tsx:3429-3456` (card list), add `doCompleteSwitch`/`doCancelSwitch` near `doReswitch` (`:1606`).

**Interfaces:**
- Consumes: `StatusBadge`, `LifecycleCard`, `OutlineButton`, `PrimaryButton`, `InfoLine` (Tasks 1-2); `roomSwitches` rows now have `status`/`ebCharges`/`depositDifference`/`switchType` (Task 5); `client.action((api as any).tenants.completeSwitch/cancelSwitch, {switchId})`.
- Produces: card renders badge by `s.status`; InfoLine with EB + Deposit; buttons by status.

- [ ] **Step 1: Add complete/cancel handlers** near `doReswitch` (`:1606`):

```ts
async function doCompleteSwitch(s: any) {
  try { setSaving(true);
    await client.action((api as any).tenants.completeSwitch, { switchId: s._id });
    Alert.alert('Success', 'Switch completed'); fetchAll();
  } catch (e: any) { Alert.alert('Error', e?.message || 'Failed'); } finally { setSaving(false); }
}
async function doCancelSwitch(s: any) {
  try { setSaving(true);
    await client.action((api as any).tenants.cancelSwitch, { switchId: s._id });
    Alert.alert('Cancelled', 'Switch cancelled'); fetchAll();
  } catch (e: any) { Alert.alert('Error', e?.message || 'Failed'); } finally { setSaving(false); }
}
```

- [ ] **Step 2: Rebuild the card** (`:3430-3454`) to match the reference:

```tsx
filtered.map((s: any) => {
  const badgeKind = s.status === 'completed' ? 'completed' : s.status === 'cancelled' ? 'cancelled' : 'scheduled';
  const typeLabel = s.switchType === 'future' ? 'Future' : 'Immediate';
  return (
    <LifecycleCard key={s._id}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontWeight: '700', fontSize: fontSize.sm, flex: 1 }}>{s.tenantName}</Text>
        <StatusBadge kind={badgeKind as any} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <Text style={{ fontSize: fontSize.xs, color: '#556274' }}>{bedLoc(s.oldBedId)}</Text>
        <Ionicons name="arrow-forward" size={12} color="#64748B" />
        <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#0F172A' }}>{bedLoc(s.newBedId)}</Text>
      </View>
      <InfoLine parts={[
        { text: typeLabel },
        { text: fmtDate(s.switchDate) },
        { text: `Rent ${s.rentDifference > 0 ? '+' : ''}₹${fmtAmt(s.rentDifference)}`, color: s.rentDifference > 0 ? '#DC2626' : '#16A34A', bold: true },
        { text: `EB ₹${fmtAmt(s.ebCharges)}` },
        { text: `Deposit ${s.depositDifference > 0 ? '+' : ''}₹${fmtAmt(s.depositDifference)}`, color: s.depositDifference < 0 ? '#16A34A' : undefined },
      ]} />
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        {s.status === 'scheduled' ? (
          <>
            <PrimaryButton title="Complete" icon="checkmark-outline" small loading={saving} onPress={() => doCompleteSwitch(s)} />
            <OutlineButton title="Cancel" icon="close-circle-outline" tone="danger" small onPress={() => doCancelSwitch(s)} />
          </>
        ) : s.status === 'cancelled' ? (
          <OutlineButton title="View" icon="eye-outline" small onPress={() => openStatement(s)} />
        ) : (
          <>
            <OutlineButton title="View" icon="eye-outline" small onPress={() => openStatement(s)} />
            <OutlineButton title="Reswitch" icon="swap-horizontal-outline" tone="danger" small onPress={() => doReswitch(s)} />
          </>
        )}
      </View>
    </LifecycleCard>
  );
})
```

- [ ] **Step 3: Verify + visual QA + commit**

Run: `npx tsc --noEmit` → Expected: clean.
Visual QA vs reference Switching screenshot: Completed card shows green badge + View/Reswitch; a Scheduled card shows gray badge + Complete/Cancel; InfoLine shows `Type · Date · Rent± · EB · Deposit`.
```bash
git add screens/TenantLifecycleScreen.tsx
git commit -m "feat(switch): card restyle — status badge, EB/Deposit line, Complete/Cancel"
```

---

## Phase 2 — Visual Map + Booking + Onboarding restyle

> Each task: swap the tab's existing cards/sections to the shared `LifecycleCard`/`StatusBadge`/`PrimaryButton`/`OutlineButton`/`SearchField`/`AvatarInitial`, and match the captured reference screenshot for that tab. Data wiring stays as-is. Gate: `npx tsc --noEmit` + visual QA + commit.

### Task 9: Visual Map restyle

**Files:** Modify `screens/TenantLifecycleScreen.tsx` (`renderMap`/Visual Map render).

- [ ] **Step 1:** Restyle to match reference: top row = `SearchField` ("Search tenant") + a "Sort: Apartment" dropdown + `…` menu button; filter chips row `All / Occupied N / Vacant N / Notice N / Booked N` (active = purple pill, others = outlined colored pills: green/pink/orange/blue). Apartment cards: left column = apartment code + gender + `x / y Beds` + `NN% Occupied`; right = horizontal strip of bed tiles color-coded (occupied `#DCFCE7`/green, notice `#FEF3C7`/orange, booked `#DBEAFE`/blue, vacant `#FFE4E6`/pink) each showing bed code + tenant name/status; trailing chevron.
- [ ] **Step 2:** `npx tsc --noEmit` clean; visual QA vs Visual Map screenshot.
- [ ] **Step 3:** `git commit -m "feat(lifecycle): Visual Map restyle to reference"`

### Task 10: Booking restyle

**Files:** Modify Booking render.

- [ ] **Step 1:** Three sections matching reference: **"New Tenants (KYC ✓)"** header + `+ New Booking` `PrimaryButton`; cards = `AvatarInitial` + name + phone + KYC `StatusBadge kind="completed"` + blue **Book** `PrimaryButton` (small, right). **"Returning Tenants (Previously Exited)"** header + `SearchField` + helper text "Search from N previously exited tenants." **"Booked — Pending Onboarding"** list.
- [ ] **Step 2:** `npx tsc --noEmit` clean; visual QA vs Booking screenshot.
- [ ] **Step 3:** `git commit -m "feat(lifecycle): Booking restyle to reference"`

### Task 11: Onboarding restyle

**Files:** Modify Onboarding render.

- [ ] **Step 1:** "Booked — Ready for Onboarding" cards: `AvatarInitial` + name + `property · bed` + `Booked DD-Mon-YY · Planned DD-Mon-YY` + amount (right, bold); buttons row = **Onboard** `PrimaryButton` + **Cancel** `OutlineButton tone="danger"`.
- [ ] **Step 2:** `npx tsc --noEmit` clean; visual QA vs Onboarding screenshot.
- [ ] **Step 3:** `git commit -m "feat(lifecycle): Onboarding restyle to reference"`

---

## Phase 3 — Notices + Exit + Refunds + Not in Property restyle

### Task 12: Notices restyle

**Files:** Modify Notices render.

- [ ] **Step 1:** "Tenant Notices" header + **Record Notice** `PrimaryButton` (bell icon); `SearchField`; cards = `AvatarInitial` + name + `StatusBadge kind="onNotice"` + `bed · property` + `Est. exit DD-Mon-YY` + amount (right); buttons **Edit** `OutlineButton` + **Delete** `OutlineButton tone="danger"`.
- [ ] **Step 2:** `npx tsc --noEmit` clean; visual QA vs Notices screenshot.
- [ ] **Step 3:** `git commit -m "feat(lifecycle): Notices restyle to reference"`

### Task 13: Exit restyle

**Files:** Modify Exit render.

- [ ] **Step 1:** Two sub-tab pills "Tenants on Notice (N)" (active purple) / "Exit History (N)"; three `KpiTile`s (EST. REFUND DUE / 1 WEEK / 1 MONTH, green values); `SearchField`; cards = `AvatarInitial` + name + bed + `Est. exit DD-Mon-YY · Bal ₹X · Adv ₹Y` + amount (red, right); buttons **Statement** `OutlineButton tone="success"` + **Process Exit** `OutlineButton tone="danger"`; full-width **Create Pre-Exit Task** `OutlineButton`.
- [ ] **Step 2:** `npx tsc --noEmit` clean; visual QA vs Exit screenshot. If Exit History data isn't wired in current mobile, keep the existing data source and flag it in the commit body.
- [ ] **Step 3:** `git commit -m "feat(lifecycle): Exit restyle to reference"`

### Task 14: Refunds restyle

**Files:** Modify Refunds render.

- [ ] **Step 1:** "Refund Tracking" header + **Download PDF** text link (blue); `SearchField`; cards = `AvatarInitial` + name + `StatusBadge kind="pending"` + amount (green refund / red "Tenant Owes" with subtext) + `code · phone` + `Exit DD-Mon-YY · Held ₹X · Ded ₹Y · N days`; buttons **Edit** `OutlineButton` + (**Complete** `PrimaryButton` when refund / **Collect** `OutlineButton tone="success"` when tenant owes) + **Statement** `OutlineButton tone="success"`.
- [ ] **Step 2:** `npx tsc --noEmit` clean; visual QA vs Refunds screenshot.
- [ ] **Step 3:** `git commit -m "feat(lifecycle): Refunds restyle to reference"`

### Task 15: Not in Property restyle

**Files:** Modify Not-in-Property render.

- [ ] **Step 1:** "Not in Property (Absence Records)" header + **+ Add Absence** `PrimaryButton`; subtitle "Record tenant absences exceeding 30 days to exclude them from electricity billing."; `SearchField`; cards = `AvatarInitial` + name + bed + `DD-Mon-YY → DD-Mon-YY · N days` + `Reason: …`; buttons **Edit** `OutlineButton` + **Delete** `OutlineButton tone="danger"`.
- [ ] **Step 2:** `npx tsc --noEmit` clean; visual QA vs Not-in-Property screenshot.
- [ ] **Step 3:** `git commit -m "feat(lifecycle): Not in Property restyle to reference"`

---

## Phase 4 — Overview restyle + polish

### Task 16: Overview / Bed Status restyle

**Files:** Modify `renderBedStatusCard` (`:1939`) + bed-focus detail render.

- [ ] **Step 1:** Match reference Overview: `LifecycleCard` titled **"Bed Status"** with subtitle "vs previous month"; right side small **Intelligence** pill + **Total N** link; a donut (existing) with center total; two stat columns **CURRENT OCCUPANCY 86.4% ▲+2.4%** (with "(Occupied + Notice) / Total") and **MONTH OCCUPANCY 89.4% ▲+3.7%** ("NNNN/NNNN bed-days"); a row of 5 mini tiles (Occupied/Booked/Notice/Vacant/Not Booked) each = dot + label + big number + trend arrow, using `BED_FOCUS_TILES` colors. Below: when no tile selected, an empty `LifecycleCard` with muted text "Pick a Bed Status tile to see the tenants behind it."; when a tile selected, the detail list (`SearchField` + tenant rows with `AvatarInitial`, name, `bed · Onboarded DD-Mon-YY · Rent ₹X`, amount, edit pencil).
- [ ] **Step 2:** `npx tsc --noEmit` clean; visual QA vs Overview screenshot.
- [ ] **Step 3:** `git commit -m "feat(lifecycle): Overview/Bed Status restyle to reference"`

### Task 17: Final polish pass + full-screen QA

**Files:** small tweaks across `screens/TenantLifecycleScreen.tsx`.

- [ ] **Step 1:** Walk all 10 tabs side-by-side with the captured reference screenshots; fix spacing/typography/color mismatches (card padding, badge radius, section-title size, button heights, gaps).
- [ ] **Step 2:** Run in Expo Go / web build; navigate every tab; confirm the pill strip scrolls, Overview is default, Excel Upload toasts, Switching form shows Switch Type/Notes and cards show EB/Deposit + status buttons.
- [ ] **Step 3:** `npx tsc --noEmit` clean.
- [ ] **Step 4:** `git commit -m "polish(lifecycle): final pass vs reference across all tabs"`

---

## Self-Review

**Spec coverage:**
- Shared design layer → Tasks 1-2 ✓
- Tab restructure (Overview first, Excel Upload in strip) → Task 3 ✓
- Switching frontend (Switch Type/Notes/Effective Date + cards) → Tasks 7-8 ✓
- Switching backend (types, EB proration, complete/cancel, enriched list) → Tasks 4-5 ✓
- Deploy + read-QA only → Task 6 ✓
- Visual Map/Booking/Onboarding → Tasks 9-11 ✓
- Notices/Exit/Refunds/Not-in-Property → Tasks 12-15 ✓
- Overview/Bed Status restyle → Task 16 ✓
- Polish vs screenshots → Task 17 ✓

**Placeholder scan:** No "TBD/TODO"; each restyle task names exact sections, components, colors, and copy. Backend tasks include full ported code.

**Type consistency:** `switchType`/`ebCharges`/`depositDifference`/`status`/`notes` used identically across `processSwitchFull` (Task 4), `listRoomSwitches`/`completeSwitch`/`cancelSwitch` (Task 5), the form (Task 7), and the card (Task 8). `StatusBadge` kinds (`completed/scheduled/cancelled/onNotice/pending`) consistent between Task 1 and consumers. `LC`/`BADGE` names consistent.

**Known adaptation:** verification is `npx tsc --noEmit` + visual/read QA (no unit-test framework in this repo, per Global Constraints) — deliberate, not a gap.

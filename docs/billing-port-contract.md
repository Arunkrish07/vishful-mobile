# Billing / Generate Bills — Mobile Port Contract

Source of truth (web, READ-ONLY, do not treat this doc as authoritative if the source drifts):
- `C:\vishful-web-v7\external-db-guide-f04b8927-main\src\lib\billing-engine.ts` (797 lines)
- `C:\vishful-web-v7\external-db-guide-f04b8927-main\src\components\accounting\BillingTab.tsx` (1377 lines)
- `C:\vishful-web-v7\external-db-guide-f04b8927-main\src\lib\document-number-utils.ts` (68 lines)
- `C:\vishful-web-v7\external-db-guide-f04b8927-main\src\integrations\supabase\types.ts` (generated Supabase types)
- `C:\vishful-web-v7\external-db-guide-f04b8927-main\src\hooks\useAccountingData.ts` (data-fetch queries that feed BillingTab's props)

This is a **money-critical** flow. Every field name/shape below was read verbatim from source, not inferred. Where the source itself is silent or ambiguous (mainly the exact destination table for `p_eb_shares`, since the RPC's SQL body is not checked into this repo), that is called out explicitly — do not guess a table name.

---

## 1. Engine inputs

`generateInvoicePreviews()` signature (positional args, `billing-engine.ts:279-309`):

```ts
generateInvoicePreviews(
  billingMonth: string,                 // "yyyy-MM", e.g. "2026-09"
  allotments: Allotment[],
  electricityReadings: ElectricityReading[],
  tenantNames: Map<string, string>,     // tenant_id -> full_name
  beds: Bed[],
  bedRates: BedRate[],
  propertyFilter?: string,              // property_id, or undefined = all properties
  apartments?: { id: string; apartment_code: string }[],
  absenceRecords?: { tenant_id: string; allotment_id?: string; from_date: string; to_date: string }[],
  roomSwitches?: { old_allotment_id: string | null }[],
  existingInvoices?: Array<{
    allotment_id: string | null;
    billing_month: string | null;
    other_charges: number | null;
    is_deleted?: boolean | null;
  }>,
): InvoicePreview[]
```

### 1.1 `allotments` — table `tenant_allotments`

Fetched with `select("*")`, `.eq("organization_id", orgId)`, **no status filter, no billing-month filter, no date filter** — the entire org's allotment rows are handed to the engine and it does all eligibility filtering itself (`useAccountingData.ts:245-258`).

Columns the engine's `Allotment` interface actually reads (all others in the row are ignored):

| Column | Type | Used for |
|---|---|---|
| `id` | uuid | `allotment_id` on the preview; join key everywhere |
| `tenant_id` | uuid | tenant lookup, EB grouping |
| `property_id` | uuid | property filter, preview output |
| `apartment_id` | uuid | EB apartment grouping, apartment_code lookup |
| `bed_id` | uuid | bed lookup → `bed_type`/`toilet_type` → rate |
| `monthly_rental` | number\|null | **declared on the interface but NOT read anywhere in the calc.** Rent always comes from `bed_rates` via `getBedRateForDate`, never from this column. Do not port logic that uses it for rent math. |
| `deposit_paid` | number\|null | declared, unused in billing calc |
| `onboarding_date` | string\|null (date) | stay-day start bound; allotment is skipped entirely if null |
| `actual_exit_date` | string\|null (date) | exit-date priority #1 |
| `staying_status` | string\|null (enum `staying_status`: `Booked \| On-Notice \| Staying \| Exited \| Cancelled`) | eligibility gate |
| `discount` | number\|null | subtracted from bed rate before per-day calc |
| `notice_date` | string\|null (date) | fallback exit-date reference for On-Notice when `estimated_exit_date` is null |
| `estimated_exit_date` | string\|null (date) | exit-date priority #2 (On-Notice/Exited) |
| `premium` | number\|null | added to bed rate before per-day calc |

Org scoping: `organization_id` (filtered at fetch time, not inside the engine — the engine trusts whatever `allotments` array it's given).

### 1.2 `electricityReadings` — table `electricity_readings`

Fetched `select("*")`, `.eq("organization_id", orgId)`, no month filter (`useAccountingData.ts:260-273`).

Columns used (`ElectricityReading` interface):

| Column | Notes |
|---|---|
| `id` | unused in calc, present for typing |
| `apartment_id` | join key to apartment's EB group |
| `property_id` | unused in calc |
| `billing_month` | matched against **previous** month, both `"yyyy-MM"` and `"MMM-yy"` formats are tried (`r.billing_month === prevBillingMonthISO \|\| r.billing_month === prevBillingMonthMMMyy`) — legacy data has both formats in the wild |
| `reading_start` | meter start |
| `reading_end` | meter end; `totalUnits = reading_end - reading_start` |
| `unit_cost` | ₹/unit |
| `units_consumed` | declared, unused (engine recomputes `reading_end - reading_start` itself) |

### 1.3 `beds` — table `beds`

Fetched `select("id, bed_code, apartment_id, bed_type, toilet_type, status")` (`useAccountingData.ts:51-64`).

Columns used (`Bed` interface): `id`, `bed_code` (optional, defaults to `''`), `bed_type`, `toilet_type`, `apartment_id`. `bed_type` enum: `Executive | Single | Double | Triple | Quad`. `toilet_type` enum: `Attached | Common`.

### 1.4 `bedRates` — table `bed_rates`

Fetched `select("*")`, ordered `from_date desc` (`useAccountingData.ts:81-94`).

Columns used (`BedRate` interface): `bed_type`, `toilet_type`, `property_id` (nullable — org-wide rate row when null), `from_date`, `to_date` (nullable = open-ended), `monthly_rate`.

Rate resolution (`getBedRateForDate`, `billing-engine.ts:107-129`): filter rows where `bed_type`+`toilet_type` match the bed AND `from_date <= rateDate` AND (`to_date` is null OR `to_date >= rateDate`), where `rateDate` = first day of the billing month (`yyyy-MM-dd`). If any match has `property_id === propertyId`, prefer the **most recent** (`from_date` desc) property-specific row; otherwise fall back to the most recent match across all properties (including org-wide `property_id: null` rows). No match → rate is `0`.

### 1.5 `absenceRecords` — table `tenant_absence_records`

Fetched separately in `BillingTab` (`BillingTab.tsx:284-293`): `select("tenant_id, allotment_id, from_date, to_date")`, `.eq("organization_id", orgId)` — **no per-billing-month filter**, all org absence records loaded every time.

Row shape used: `{ tenant_id, allotment_id?, from_date, to_date }`. Matching in `calcAbsentDays` is by `tenant_id` always, and additionally by `allotment_id` **only if** the record has one set (`if (rec.allotment_id && rec.allotment_id !== allotmentId) continue;`) — i.e. an absence record with a null `allotment_id` applies to that tenant regardless of which allotment they're being billed under.

### 1.6 `roomSwitches` — table `room_switches`

Fetched separately (`BillingTab.tsx:296-304`): `select("old_allotment_id")`, `.eq("organization_id", orgId)` — all org rows, no status/date filter.

Only field used: `old_allotment_id`. Every non-null value is added to `switchedOutAllotmentIds` — any allotment id in that set is exempted from exit charges (a bed switch, not a property exit).

### 1.7 `existingInvoices` — table `invoices`

`BillingTab` passes its already-fetched, already org/soft-delete-filtered `invoices` array straight through (`BillingTab.tsx:353`, `501`) — this is the **same** array documented in §1.8, not a separate query.

Fields the engine reads: `allotment_id`, `billing_month`, `other_charges`, `is_deleted`. Used only to build `allotmentsAlreadyBilledExitCharges`: an allotment is in that set if it has a non-deleted invoice with `other_charges > 0` **whose `billing_month` is strictly earlier** than the month being generated. Same-month rows are deliberately not deduped (replace-mode regenerates them).

### 1.8 `invoices` (as consumed elsewhere, e.g. `existingInvoices.length` badge, and the same array as §1.7) — table `invoices`

Fetched (`useAccountingData.ts:275-294`): `select("*, tenants(full_name), properties(property_name), apartments(apartment_code), beds(bed_code), tenant_allotments(staying_status, onboarding_date, notice_date, estimated_exit_date, actual_exit_date)")`, `.eq("organization_id", orgId)`, `.not("is_deleted", "is", true)` (excludes only rows where `is_deleted = true`; `null`/`false` both pass) — **all billing months**, no month filter.

### 1.9 Org scoping summary

Every one of the six source tables above (`tenant_allotments`, `electricity_readings`, `beds`, `bed_rates`, `tenant_absence_records`, `room_switches`, `invoices`) carries `organization_id` and every fetch filters on it. The engine itself never filters by org — it trusts the caller to have already scoped every array. **The mobile port must scope every one of these seven queries by the org id itself**, same as the web fetch layer does.

`propertyFilter` (engine's 7th positional arg) is a client-side UI filter only (from a `<Select>` of `properties`), applied inside the engine against `a.property_id`; it is not a separate table.

---

## 2. Engine output — `InvoicePreview` and `EBBreakdown`

```ts
export interface EBTenantDetail {
  tenant_id: string;
  tenant_name: string;
  stay_days: number;
  allotment_id: string;
}

export interface EBBreakdown {
  apartment_id: string;
  billing_month: string;          // the reading's billing_month string (prev month)
  total_units: number;            // reading_end - reading_start
  unit_cost: number;
  total_apartment_bill: number;   // Math.ceil(total_units * unit_cost)
  total_tenant_days: number;      // sum of adjusted stay_days across all tenants in the apartment
  per_day_rate: number;           // Math.round((ebTotal / totalTenantDays) * 100) / 100
  tenant_stay_days: number;       // this tenant's (absence-adjusted) stay days
  tenant_eb_charge: number;       // Math.ceil(per_day_rate * tenant_stay_days), pre-BillingTab-rounding
  all_tenants: EBTenantDetail[];  // every tenant sharing this apartment's bill that month
}

export interface InvoicePreview {
  tenant_id: string;
  tenant_name: string;
  property_id: string;
  apartment_id: string;
  bed_id: string;
  apartment_code: string;
  bed_code: string;
  billing_month: string;
  stay_days: number;
  total_days_in_month: number;
  per_day_rent: number;           // Math.round(perDayRent * 100) / 100
  rent_amount: number;            // Math.ceil(perDayRent_raw * stayDays)
  eb_amount: number;               // this month's ACTUAL (prev-month-reading-based) EB charge
  eb_details: string;              // human string, e.g. "1234 units × ₹8/unit (Aug-26)" or "No reading"
  eb_breakdown: EBBreakdown | null;
  late_fee: number;                // always 0 from the engine — late fee is not computed here
  other_charges: number;           // always 0 from the engine
  total: number;                   // Math.ceil(rent_amount + eb_amount + estimated_eb_amount + exit_charges)
  allotment_id: string;
  discount: number;
  premium: number;
  bed_rate: number;                 // raw monthly rate from bed_rates, before discount/premium
  is_eb_only?: boolean;             // engine always sets false; "EB-only" invoices are NOT generated (see §8)
  estimated_eb_amount?: number;     // for tenants exiting this month
  eb_billable_days?: number;        // stay days minus absent days, used for estimated EB
  exit_charges?: number;            // ₹2250 flat or 0
  is_exit_charge_invoice?: boolean; // engine never sets this true; declared but dead in current engine (legacy field — BillingTab still reads it defensively everywhere, treat as always false/undefined from the engine)
  total_stay_days?: number;         // only set when exit_charges > 0: differenceInDays(exit, onboarding)
}
```

Note: `is_exit_charge_invoice` is checked all over `BillingTab.tsx` (invoice_type, replacement targets, Excel export, filename) but `generateInvoicePreviews` never sets it — exit charges are folded into the single regular invoice (see §8). Treat any `is_exit_charge_invoice` branch in `BillingTab` as **legacy dead code kept for backward compatibility with old standalone exit-charge invoices**; the port only needs the `false`/`undefined` path, but should still emit the same `'exit_charge'` invoice_type cleanup target (§5) in case old data exists.

---

## 3. Save shapes (`saveInvoicesBatch`, `BillingTab.tsx:61-239`)

Called as `saveInvoicesBatch(selectedPreviews, billingMonthStr, orgId, properties, isPartialUpdate)`.

### 3.1 `due_date` / `invoice_date`

```ts
const [y, m] = month.split("-");           // month = "yyyy-MM"
const dueDate = `${y}-${m}-07`;             // ALWAYS the 7th of the billing month
const invoiceDate = `${y}-${m}-01`;         // ALWAYS the 1st of the billing month
```

No configurability — hardcoded day-of-month 7 and 1.

### 3.2 `p_invoices` (element shape, one per preview, `invoiceRows`, `BillingTab.tsx:103-124`)

```ts
{
  organization_id: orgId,
  tenant_id: p.tenant_id,
  property_id: p.property_id,
  apartment_id: p.apartment_id,
  bed_id: p.bed_id,
  allotment_id: p.allotment_id,
  invoice_number: invoiceNumbers[idx],          // see §4
  billing_month: month,                          // "yyyy-MM"
  rent_amount: p.rent_amount,
  electricity_amount: p.eb_amount,
  estimated_eb: p.estimated_eb_amount || 0,
  late_fee: p.late_fee,
  other_charges: (p.exit_charges || 0) + (p.other_charges || 0),   // exit charges ARE folded into other_charges here
  total_amount: p.total,
  invoice_date: `${y}-${m}-01`,
  due_date: `${y}-${m}-07`,
  status: "pending",                             // ALWAYS "pending" on generation
  balance: p.total,                              // balance starts equal to total (nothing paid yet)
  amount_paid: 0,
  invoice_type: p.is_exit_charge_invoice ? 'exit_charge' : 'regular',   // effectively always 'regular' from the current engine
}
```

`is_deleted` is **not** set on the row here — it's implicitly whatever the DB column default is (the RPC almost certainly defaults it to `false`, or the RPC itself manages the soft-delete/insert dance — not visible in this checkout). Do not assume; verify against the live DB default before porting, or explicitly set `is_deleted: false` for safety.

### 3.3 `p_line_items` (`lineItems`, `BillingTab.tsx:127-199`)

Array of `{ invoice_index, line_type, description, amount, metadata }` — **not** `invoice_id`; the RPC resolves `invoice_index` (0-based, matching the `p_invoices` array position) to the newly-created invoice id server-side. Up to 4 line items per preview, each conditional:

**`line_type: "rent"`** — only if `p.rent_amount > 0`:
```ts
{
  invoice_index: idx,
  line_type: "rent",
  description: `Rent: ${p.stay_days}/${p.total_days_in_month} days @ ₹${Math.round(p.per_day_rent)}/day${discountNote}${premiumNote}`,
  amount: p.rent_amount,
  metadata: {
    bed_rate: p.bed_rate,
    discount: p.discount,
    premium: p.premium,
    effective_rate: Math.max(0, p.bed_rate - p.discount + p.premium),
    stay_days: p.stay_days,
    total_days_in_month: p.total_days_in_month,
    per_day_rent: p.per_day_rent,
  },
}
```
`discountNote` = ` (discount ₹${p.discount})` if `p.discount > 0`, else `""`. `premiumNote` similarly for `p.premium > 0`.

**`line_type: "electricity"`** — only if `p.eb_amount > 0`:
```ts
{
  invoice_index: idx,
  line_type: "electricity",
  description: `EB: ${p.eb_details}`,
  amount: p.eb_amount,
  metadata: p.eb_breakdown ? {
    total_units: ..., unit_cost: ..., total_apartment_bill: ..., total_tenant_days: ...,
    per_day_rate: ..., tenant_stay_days: ..., tenant_eb_charge: ..., all_tenants: p.eb_breakdown.all_tenants || [],
  } : {},
}
```

**`line_type: "estimated_eb"`** — only if `(p.estimated_eb_amount || 0) > 0`:
```ts
{
  invoice_index: idx,
  line_type: "estimated_eb",
  description: `Estimated EB (${p.eb_billable_days || p.stay_days} days × prev month per-day rate)`,
  amount: p.estimated_eb_amount,
  metadata: { stay_days: p.stay_days, per_day_rate: p.eb_breakdown?.per_day_rate || 0 },
}
```

**`line_type: "exit_charges"`** — only if `(p.exit_charges || 0) > 0`:
```ts
{
  invoice_index: idx,
  line_type: "exit_charges",
  description: `Exit Charges: ₹${p.exit_charges.toLocaleString('en-IN')} (Total stay: ${p.total_stay_days || p.stay_days} days, under 365 days)`,
  amount: p.exit_charges,
  metadata: { total_stay_days: p.total_stay_days || p.stay_days },
}
```

### 3.4 `p_eb_shares` (`ebShares`, `BillingTab.tsx:185-198`)

One element **only when `p.eb_breakdown` is truthy** (i.e. only for tenants who got an actual, not estimated, EB charge this month):

```ts
{
  invoice_index: idx,
  apartment_id: p.eb_breakdown.apartment_id,
  billing_month: p.eb_breakdown.billing_month,
  total_apartment_bill: p.eb_breakdown.total_apartment_bill,
  total_tenant_days: p.eb_breakdown.total_tenant_days,
  per_day_rate: p.eb_breakdown.per_day_rate,
  tenant_stay_days: p.eb_breakdown.tenant_stay_days,
  tenant_eb_charge: p.eb_breakdown.tenant_eb_charge,
  total_units: p.eb_breakdown.total_units,
  unit_cost: p.eb_breakdown.unit_cost,
}
```

**IMPORTANT — table not found in this checkout.** No `invoice_eb_shares`/`eb_shares`/`invoice_eb_allocations` table exists in `integrations/supabase/types.ts` (the fully generated Supabase types file, which normally lists every `public` table). `replace_invoices_atomic`'s SQL is not present in `supabase/migrations/` — per `docs/02-database.md:5`, "the core schema … `replace_invoices_atomic` … pre-exists in the live DB and has no DDL in this checkout." So the exact destination table/columns for `p_eb_shares` cannot be confirmed from source alone. **Before porting this write path, inspect the live Supabase DB schema directly** (e.g. via `list_tables`/`execute_sql` on the Supabase project) to find where `p_eb_shares` rows land — do not assume a table name. As a fallback, note that every field in an eb_share row is already duplicated inside the `electricity` line item's `metadata` (§3.3), so if the mobile port cannot call the same opaque RPC, an equivalent Convex mutation can reconstruct the same information from line items alone.

### 3.5 Replacement targets (`p_replacement_targets`, `BillingTab.tsx:201-216`)

```ts
const allotmentIds = [...new Set(previews.map(p => p.allotment_id))];   // → p_allotment_ids

const replacementTargets = previews.map(p => ({
  allotment_id: p.allotment_id,
  invoice_type: p.is_exit_charge_invoice ? 'exit_charge' : 'regular',
}));
previews.forEach(p => {
  replacementTargets.push({ allotment_id: p.allotment_id, invoice_type: 'exit_charge' });
});
const uniqueTargets = Array.from(
  new Map(replacementTargets.map(t => [`${t.allotment_id}|${t.invoice_type}`, t])).values()
);
```

So for every preview being saved, **two** targets are always generated: `{allotment_id, invoice_type: 'regular'|'exit_charge' (from the preview)}` **and** `{allotment_id, invoice_type: 'exit_charge'}` unconditionally — the second one exists purely to sweep away any legacy standalone exit-charge invoice for that allotment (from back when exit charges were their own invoice_type), deduped by `allotment_id|invoice_type` key.

---

## 4. Invoice numbering (`generateInvoiceNumbers`, `document-number-utils.ts:30-50`)

Format: `<Prop5>/<FY>/<MM>/<00001>` e.g. `VISHL/25-26/03/00001`.

```ts
function generateInvoiceNumbers(previews, billingMonth, propertyMap, propertyOffsets?) {
  const fy = getFY(billingMonth);                    // Indian FY, Apr–Mar: "2025-03"→"24-25", "2025-04"→"25-26"
  const mm = billingMonth.split('-')[1];              // "03"
  const counterByProperty = new Map<string, number>();

  return previews.map(p => {
    const propName = propertyMap.get(p.property_id) || 'UNKNO';
    const abbr = propName.replace(/\s+/g,'').slice(0,5).toUpperCase().padEnd(5,'X');  // getPropertyAbbr
    const offset = propertyOffsets?.get(p.property_id) || 0;
    const count = (counterByProperty.get(p.property_id) || 0) + 1;
    counterByProperty.set(p.property_id, count);
    return `${abbr}/${fy}/${mm}/${String(offset + count).padStart(5,'0')}`;
  });
}
```

- **Per-property running numbers**: the sequence resets/counts independently per `property_id`, in the order previews appear in the input array (i.e. numbering order = preview array order, NOT sorted by anything — port must preserve preview array order exactly, or the numbers become non-deterministic/inconsistent with what a user saw in preview).
- **`propertyMap`**: `property_id -> property_name`, built client-side from the already-fetched `properties` list (`new Map(properties.map(p => [p.id, p.property_name]))`).
- **`propertyOffsets`** (`BillingTab.tsx:69-98`): only computed when `isPartialUpdate` is true (user selected fewer rows than the full preview set, i.e. only some rows are being regenerated). It counts, per property, how many *existing, non-deleted* invoices for that `billing_month`+org will NOT be touched by this save (i.e. their `allotment_id|invoice_type` composite key is not in the replacement set) — that count becomes the starting offset so the new numbers don't collide with the untouched invoices. Source query:
  ```ts
  supabase.from("invoices").select("property_id, allotment_id, invoice_type")
    .eq("organization_id", orgId).eq("billing_month", month).eq("is_deleted", false)
  ```
  When `isPartialUpdate` is false (full regeneration of the whole preview set), `propertyOffsets` stays an empty Map (all offsets 0).

---

## 5. The RPC — `replace_invoices_atomic`

Two overload shapes exist in the generated types (`types.ts:13319-13342`) — the second (with `p_replacement_targets`) is the one actually called:

```ts
replace_invoices_atomic(args: {
  p_org_id: string;
  p_billing_month: string;              // "yyyy-MM"
  p_allotment_ids: string[];            // unique allotment ids in this save
  p_invoices: Json;                     // array, shape in §3.2
  p_line_items: Json;                   // array, shape in §3.3
  p_eb_shares: Json;                    // array, shape in §3.4
  p_replacement_targets?: Json;         // array of {allotment_id, invoice_type}, shape in §3.5
}) -> Json   // { count: number } on success, or { error: string } (checked client-side: `if (result?.error) throw`)
```

Call site (`BillingTab.tsx:219-227`) uses `supabase.rpc("replace_invoices_atomic", {...})` directly (not an Edge Function). On error, `error.message` (or `JSON.stringify(error)`) is thrown.

**What it does (from doc comments only, SQL body not in this checkout):**
- `docs/02-database.md:28`: "Bulk invoice generation: `replace_invoices_atomic` RPC (advisory lock `acquire_billing_lock` prevents concurrent runs)."
- `docs/archive/DATABASE_SCHEMA.md:3208-3210`: "atomic monthly billing rebuild used by `BillingTab`" and separately lists `try_billing_lock(p_key)` / `release_billing_lock(p_key)` as "advisory lock primitives for billing." (Note the two docs name the lock function slightly differently — `acquire_billing_lock` vs `try_billing_lock`/`release_billing_lock`; this inconsistency exists in the source docs themselves and was not resolved by reading the SQL, which isn't present. Confirm the actual lock function name against the live DB before porting.)

Because the RPC atomically **deletes/replaces** existing invoices for the given `p_replacement_targets` (or `p_allotment_ids`+`p_billing_month`) and inserts the new set + line items + eb shares in one transaction, a mobile/Convex port must replicate this transactional replace-not-append semantics (a Convex mutation naturally gives this transactionality) — a partial failure must not leave orphaned old + new invoices for the same allotment/month.

---

## 6. Preview-only path (`handlePreview`, `BillingTab.tsx:339-382`)

1. Calls `generateInvoicePreviews(billingMonth, allotments, electricityReadings, tenantNames, beds, bedRates, propertyFilter==="all"?undefined:propertyFilter, apartments, absenceRecords, roomSwitches, invoices)` — no DB write.
2. **EB rounding is always applied as a UI-layer post-process** (the `roundEB` flag is hardcoded `true`, the checkbox for it was removed — `BillingTab.tsx:281-282`): for every preview with an `eb_breakdown`,
   ```ts
   const roundedRate = Math.round(p.eb_breakdown.per_day_rate);
   const newCharge = Math.ceil(roundedRate * p.eb_breakdown.tenant_stay_days);
   // replace: eb_amount = newCharge; eb_breakdown.per_day_rate = roundedRate; eb_breakdown.tenant_eb_charge = newCharge
   // recompute: total = Math.ceil(rent_amount + newCharge + late_fee + other_charges + estimated_eb_amount + exit_charges)
   ```
   This means the `per_day_rate`/`tenant_eb_charge`/`eb_amount`/`total` that end up saved (§3) are the **rounded** versions, not the engine's raw output. **The port must replicate this rounding step** — it is not inside `billing-engine.ts` itself.
3. Sets `previews` state, auto-selects all rows (`selectedIds = all indices`), opens the preview table, resets search/expand/edit UI state.
4. Per-row display in the preview table: Apt-Bed badge + status badge (On-Notice → "On Notice" orange; Exited/Vacated → "Vacated" destructive; else "Staying" green, derived by looking up `allotments.find(a => a.id === p.allotment_id).staying_status` — **not** stored on the preview itself), Tenant name (+ "Exit Charges" badge if `is_exit_charge_invoice`, effectively dead), Bed Rate, Rent, Actual EB (with `eb_details` as a hover title), Est. EB, Other (= `exit_charges`), Total, and an expandable detail panel (Rental Computation, EB Computation with per-tenant apartment share table, Estimated EB note, Exit Charges note, and a final Invoice Summary line-item table) plus an inline edit row (Rent, Estimated EB — mislabeled, actually binds to `eb_amount`/actual EB not estimated, Late Fee, Other — all four editable, `total` recomputed client-side via `updatePreview`, `BillingTab.tsx:563-578`).
5. Rows are sortable (by `apartment_code-bed_code` or `tenant_name`, numeric-aware `localeCompare`) and searchable (tenant name or `apt-bed` substring, case-insensitive) — pure client-side, does not affect what gets saved.
6. Footer totals (Rent / Actual EB / Est. EB / Grand Total) are sums over **selected** rows only, recomputed on every selection change.
7. Excel/PDF/CSV export and Excel re-upload (edit-in-Excel-then-reimport) are also available from this screen but are export/QA conveniences, not required for a mobile MVP port — documented in code (`BillingTab.tsx:589-826`) if later needed, not detailed further here per task scope (they only touch `previews` state).

---

## 7. `date-fns` usage in `billing-engine.ts` (line 6 import)

```ts
import { differenceInDays, startOfMonth, endOfMonth, min, max, parseISO, isAfter, isBefore, subMonths, subDays, format } from 'date-fns';
```

| Function | Used for | Plain-`Date` replacement notes |
|---|---|---|
| `parseISO(s)` | parse `"yyyy-MM-dd"` date-only strings | `new Date(s)` parses `"yyyy-MM-dd"` as UTC midnight in modern JS — matches `parseISO`'s date-only behavior closely enough, but verify timezone: `date-fns.parseISO` treats a date-only string as **local** midnight, `new Date("yyyy-MM-dd")` treats it as **UTC** midnight. This is the single riskiest gotcha in a naive port — a day-boundary bug here silently shifts every stay-day count by ±1 near month boundaries in non-UTC environments. Prefer manually splitting `"yyyy-MM-dd"` into `Y,M,D` and constructing `new Date(Y, M-1, D)` (local) to exactly match `parseISO`'s local-midnight semantics. |
| `startOfMonth(d)` / `endOfMonth(d)` | month bounds | `new Date(y, m, 1)` / `new Date(y, m+1, 0)` (last day via day-0 rollover) |
| `min([a,b])` / `max([a,b])` | clamp a date range | `new Date(Math.min(a.getTime(), b.getTime()))` / `Math.max` equivalent |
| `isAfter(a,b)` / `isBefore(a,b)` | strict date comparison | `a.getTime() > b.getTime()` / `<` |
| `differenceInDays(a,b)` | whole-day difference, **date-fns truncates toward zero using calendar days**, not a raw ms/86400000 division (DST-safe) — for this app's date-only (midnight) values a straightforward `Math.round((a-b)/86400000)` is safe since there's no time-of-day component and India doesn't observe DST | |
| `subMonths(d,n)` | previous month anchor for EB's one-month-arrears lookup | `new Date(d.getFullYear(), d.getMonth()-n, d.getDate())` — but note it's always called on a `startOfMonth` result here so day rollover isn't a concern |
| `subDays(d,n)` | `exitDateObj` minus 1 day for absence-window upper bound | `new Date(d); d2.setDate(d2.getDate()-n)` |
| `format(d, 'yyyy-MM')` / `format(d, 'MMM-yy')` | building `prevBillingMonthISO`/`prevBillingMonthMMMyy` strings, and human EB detail text | manual padding: `` `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` `` for the ISO form; `MMM-yy` needs a month-name lookup table (`Jan,Feb,…`) + 2-digit year |

`document-number-utils.ts` and the `BillingTab.tsx` rounding/preview logic use no date-fns beyond what's already covered (BillingTab itself separately imports `format, subMonths, parse` for UI-only month-label formatting, not billing math).

---

## 8. Gotchas — business rules, 1-2 lines each

- **Eligibility gate**: only `staying_status ∈ {Staying, On-Notice}` (active-during-month check against `actual_exit_date`) or `Exited` **with `actual_exit_date >= monthStart`** are billed at all. `Booked` and `Cancelled` allotments are never billed. An On-Notice allotment whose estimated exit (or `notice_date` fallback) is before `monthStart` is treated as already-exited and skipped.
- **Rent proration**: `effectiveRent = max(0, bed_rate - discount + premium)`; `per_day_rent = effectiveRent / total_days_in_month`; `rent_amount = ceil(per_day_rent_raw * stay_days)` — note **rounding happens after** multiplying by stay_days, not per-day (avoids under/over-charging by a few paise per day but means the exposed `per_day_rent` field, itself separately rounded to 2dp for display, is not exactly `rent_amount/stay_days`).
- **Stay-day calc** (`calcStayDays`): `start = max(onboarding, monthStart)`, `end = exitDate ? min(exitDate, monthEnd) : monthEnd`, days = `end - start + 1` (inclusive both ends), 0 if start > end or no onboarding date.
- **EB is billed one month in arrears**: an invoice for billing month M charges EB using the `electricity_readings` row for month M−1, matched on the *previous* month's active-allotment tenant-day pool (`EB_OCCUPYING_STATUSES = Staying|On-Notice|Exited`, explicitly excluding `Booked`/`Cancelled` from the previous month's denominator too — a stray non-occupying row would otherwise dilute/inflate everyone else's share).
- **EB tenant-day split**: `ebTotal = (reading_end - reading_start) * unit_cost`; each tenant's stay days in the apartment for the *previous* month (minus their absence days that month) form the denominator; `charge = ceil(ebPerDay * theirAdjustedStayDays)`. All tenants sharing that apartment/month are listed in `eb_breakdown.all_tenants` for transparency.
- **Estimated EB** (only for tenants whose effective exit date falls inside the *current* billing month): uses the previous month's **per-day EB rate** (from that tenant's own `eb_breakdown.per_day_rate` if they have one, else the apartment-level average per-day rate computed from all previous-month tenants) times `(stay_days - absentDaysExcludingExitDay)`. The exit day itself is always billable (absence window upper bound is `exitDate - 1 day`). This is a forward-looking estimate because the *current* month's actual meter reading won't exist until next month.
- **Exit-charge**: flat ₹2,250, applied only when (a) tenant is exiting this month AND (b) `differenceInDays(effectiveExit, onboarding_date) < 365` AND (c) the allotment is NOT in `switchedOutAllotmentIds` (room switch, not a real exit) AND (d) the allotment hasn't already had exit charges billed on a **strictly earlier** month's non-deleted invoice (`other_charges > 0`) — this last check is exactly what prevents double-billing when a notice period rolls from one billing month into the next (e.g. notice given in April targeting May, but the estimated exit later gets pushed to June — May's invoice already carried the ₹2,250, June must not repeat it).
- **Exit charges are folded into the single regular invoice**, not raised as a separate `invoice_type: 'exit_charge'` document (that's legacy behavior the save path still cleans up defensively — see §3.5's unconditional second replacement target).
- **No EB-only invoices for previous-month exits**: a tenant who fully exited *before* the current billing month gets nothing billed this month at all (explicit code comment, `billing-engine.ts:562`) — they are excluded by the eligibility gate itself since their `actual_exit_date < monthStart`.
- **Room-switch handling**: `room_switches.old_allotment_id` marks the allotment being switched *out of*; that allotment's "exit" (it becomes non-Staying because the tenant moved to a new bed/allotment) is exempted from exit charges via `switchedOutAllotmentIds`. The engine has no other room-switch-specific logic — the *new* allotment created by the switch is billed normally like any other active allotment.
- **`bed_rate` source of truth is `bed_rates`, never `tenant_allotments.monthly_rental`** — the latter column exists on the allotment row and on the `Allotment` TS interface but the engine never reads it for rent math; a port that pulls rent from a per-allotment `monthly_rental` field instead of the date-effective `bed_rates` row will silently diverge from the web app.
- **EB rounding is a UI concern, not an engine concern**: `generateInvoicePreviews` returns the raw (unrounded to whole rupees) `per_day_rate`; `BillingTab.handlePreview`/`handleBulkGenerateAll` always (hardcoded, no toggle) round `per_day_rate` to the nearest integer and recompute `tenant_eb_charge`/`eb_amount`/`total` from that rounded rate before display and before save (§6 step 2). Skipping this step in the port will produce EB totals that don't match what the web app has been charging.
- **Invoice numbering must preserve preview array order** and is per-property sequential; a partial re-save (subset of a previous preview selected) needs the `propertyOffsets` pre-count of untouched existing invoices for that property/month to avoid number collisions (§4).
- **`p_eb_shares`'s destination table is unverified** (§3.4) — the generated Supabase types file has no table matching that shape, and the RPC's SQL isn't in this checkout's migrations. Do not port a table name/schema for this without checking the live DB.

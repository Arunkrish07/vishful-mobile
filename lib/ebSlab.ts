/**
 * Tamil Nadu domestic EB slab tariff (telescopic) — ported verbatim from the web
 * app's lib/eb-slab.ts so the mobile "Current EB" tab computes identical bills.
 *
 *   1–100      ₹0.00   (free)
 *   101–400    ₹4.70
 *   401–500    ₹6.30
 *   501–600    ₹8.40
 *   601–800    ₹9.45
 *   801–1000   ₹10.50
 *   1001+      ₹11.55
 */
export const EB_SLABS: ReadonlyArray<{ upTo: number; rate: number }> = [
  { upTo: 100, rate: 0 },
  { upTo: 400, rate: 4.7 },
  { upTo: 500, rate: 6.3 },
  { upTo: 600, rate: 8.4 },
  { upTo: 800, rate: 9.45 },
  { upTo: 1000, rate: 10.5 },
  { upTo: Infinity, rate: 11.55 },
];

/** A Current-EB bill over ₹19,000 is flagged Danger; otherwise Acceptable. */
export const EB_DANGER_THRESHOLD = 19000;

export type EbSlabBand = { from: number; to: number; units: number; rate: number; amount: number };
export type EbSlabBill = { units: number; total: number; bands: EbSlabBand[]; isDanger: boolean };

/** Telescopic slab bill for a total number of consumed units. */
export function computeEbSlabBill(unitsInput: number): EbSlabBill {
  const units = Math.max(0, Math.round(Number(unitsInput) || 0));
  const bands: EbSlabBand[] = [];
  let prevCap = 0;
  let total = 0;
  for (const slab of EB_SLABS) {
    if (units <= prevCap) break;
    const cap = Math.min(units, slab.upTo);
    const bandUnits = cap - prevCap;
    if (bandUnits > 0 && slab.rate > 0) {
      const amount = Math.round(bandUnits * slab.rate * 100) / 100;
      bands.push({ from: prevCap + 1, to: cap, units: bandUnits, rate: slab.rate, amount });
      total += amount;
    }
    prevCap = slab.upTo;
  }
  total = Math.round(total * 100) / 100;
  return { units, total, bands, isDanger: total > EB_DANGER_THRESHOLD };
}

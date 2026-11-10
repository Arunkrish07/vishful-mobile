/**
 * dateUtils.ts — one place for date display + parsing.
 *
 * Display format across the whole app is dd-MMM-yy (e.g. 26-Jun-25).
 * Stored/transport format stays ISO yyyy-MM-dd (what the backend expects).
 */

export const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
export const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export const WEEKDAYS_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** Parse a value (ISO string, dd-MMM-yy, dd/mm/yyyy, Date, or epoch) to a Date, or null. */
export function parseToDate(value: any): Date | null {
  if (!value && value !== 0) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (!s) return null;

  // ISO yyyy-MM-dd (optionally with time) — parse as local date to avoid TZ shifts.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  // dd-MMM-yy / dd-MMM-yyyy
  const dmy = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/](\d{2,4})$/);
  if (dmy) {
    const mi = MONTHS_SHORT.findIndex((m) => m.toLowerCase() === dmy[2].slice(0, 3).toLowerCase());
    if (mi >= 0) {
      const yr = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
      const d = new Date(yr, mi, Number(dmy[1]));
      return isNaN(d.getTime()) ? null : d;
    }
  }
  // dd/mm/yyyy or dd-mm-yyyy
  const num = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (num) {
    const yr = num[3].length === 2 ? 2000 + Number(num[3]) : Number(num[3]);
    const d = new Date(yr, Number(num[2]) - 1, Number(num[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Format any date-ish value as dd-MMM-yy (e.g. 26-Jun-25). Empty/invalid → fallback. */
export function formatDate(value: any, fallback = "—"): string {
  const d = parseToDate(value);
  if (!d) return fallback;
  return `${pad(d.getDate())}-${MONTHS_SHORT[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
}

/** Format as dd-MMM-yyyy (full year) — useful for documents. */
export function formatDateFull(value: any, fallback = "—"): string {
  const d = parseToDate(value);
  if (!d) return fallback;
  return `${pad(d.getDate())}-${MONTHS_SHORT[d.getMonth()]}-${d.getFullYear()}`;
}

/** Convert any date-ish value to ISO yyyy-MM-dd (local), or '' if invalid. */
export function toISODate(value: any): string {
  const d = parseToDate(value);
  if (!d) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today as ISO yyyy-MM-dd (local). */
export function todayISO(): string {
  return toISODate(new Date());
}
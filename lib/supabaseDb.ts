// ============================================================
// Client-side data helpers for the DIRECT-to-Supabase layer.
//
// Mirrors the server-side helpers the Convex actions used
// (convex/lib/supabaseAdmin.ts), but runs through the real
// `supabase` client — i.e. as the logged-in user, under RLS.
//
// Used by supabaseService.ts as each data domain is migrated
// off Convex.
// ============================================================
import { supabase } from './supabase';
import { ORG_ID as CFG_ORG_ID } from './config';

export const ORG_ID = CFG_ORG_ID;

// Return [] on error (parity with server safeList) so list screens degrade
// gracefully instead of throwing.
export async function safeList<T = any>(q: PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const { data, error } = (await q) as any;
  if (error) { console.warn('[supabaseDb]', error.message); return []; }
  return (data ?? []) as T[];
}

// Throw on error — for single-row fetches where the caller wants to know.
export async function safeFetch<T = any>(q: PromiseLike<{ data: T | null; error: any }>): Promise<T | null> {
  const { data, error } = (await q) as any;
  if (error) throw new Error(error.message || 'Supabase operation failed');
  return (data ?? null) as T | null;
}

// PostgREST caps each query at 1000 rows; page through for complete sets.
const PAGE_SIZE = 1000;
export async function fetchAllPages<T = any>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = (await build(from, to)) as any;
    if (error) { console.warn('[supabaseDb fetchAllPages]', error.message); break; }
    const rows: T[] = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

const SKIP_ORG_ID = new Set(['ticket_logs']);

export async function insertRow(table: string, data: any): Promise<any> {
  const payload = { ...data };
  if (SKIP_ORG_ID.has(table)) delete payload.organization_id;
  else payload.organization_id = data.organization_id || ORG_ID;
  const { data: rows, error } = await supabase.from(table).insert(payload).select();
  if (error) throw new Error(`Insert ${table} failed: ${error.message}`);
  return Array.isArray(rows) && rows.length === 1 ? rows[0] : rows;
}

export async function updateRow(table: string, id: string, data: any): Promise<any> {
  const { data: rows, error } = await supabase
    .from(table).update(data).eq('id', id).eq('organization_id', ORG_ID).select();
  if (error) throw new Error(`Update ${table} failed: ${error.message}`);
  return Array.isArray(rows) && rows.length === 1 ? rows[0] : rows;
}

// ── DELETES ARE DISABLED (product decision, 2026-11-03) ──────────────
// Nothing in the app deletes data for now. To enable deletes in future,
// flip DELETES_ENABLED to true — that's the single switch.
export const DELETES_ENABLED = false;

export async function deleteRow(table: string, id: string): Promise<boolean> {
  if (!DELETES_ENABLED) {
    console.warn(`[supabaseDb] delete on "${table}" blocked — deletes are disabled`);
    throw new Error('Deleting is currently disabled.');
  }
  const { error } = await supabase.from(table).delete().eq('id', id).eq('organization_id', ORG_ID);
  if (error) throw new Error(`Delete ${table} failed: ${error.message}`);
  return true;
}

// A friendly disabled result for service-level delete wrappers to return
// (so the UI shows a message instead of throwing).
export function deleteDisabledResult(): { success: boolean; disabled: true; message: string } {
  return { success: false, disabled: true, message: 'Deleting is currently disabled.' };
}

// ── small shared utilities (parity with supabaseAdmin) ───────────────
export function isLive(status: any): boolean {
  return String(status || '').trim().toLowerCase() === 'live';
}

export function filterLiveBeds(beds: any[], apartments: any[]): any[] {
  const liveAptIds = new Set((apartments || []).filter((a: any) => isLive(a.status)).map((a: any) => a.id));
  return (beds || []).filter((b: any) => liveAptIds.has(b.apartment_id) && isLive(b.status));
}

export function cleanPhone(phone: string): string {
  return (phone || '').replace(/\D/g, '').slice(-10);
}

export function phoneVariants(clean: string): string[] {
  return [clean, `+91${clean}`, `91${clean}`, `0${clean}`];
}

export function toISODate(d?: string): string | null {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m = d.match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return d;
}

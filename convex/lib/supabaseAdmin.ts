import { createClient } from "@supabase/supabase-js";

// Typed as `any`: this is a schema-less service-role client, so @supabase/supabase-js
// infers query results as `never` (no Database generic). Every caller already treats
// results as `any`; returning `any` here clears ~467 spurious `never` type errors
// across convex/ that would otherwise block `convex dev/deploy`'s typecheck.
let _client: any = null;

export function getSupabase(): any {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
    }
    _client = createClient(url, key);
  }
  return _client;
}

export const ORG_ID = "00000000-0000-0000-0000-000000000001";

export function cleanPhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

export function phoneVariants(clean: string): string[] {
  return [clean, `+91${clean}`, `91${clean}`, `0${clean}`];
}

export async function safeList<T = any[]>(
  promise: PromiseLike<{ data: T | null; error: any }>
): Promise<T> {
  const { data, error } = await promise;
  if (error) {
    console.warn("[supabase]", error.message);
    return [] as any;
  }
  return (data ?? []) as T;
}

export async function safeFetch<T>(
  promise: PromiseLike<{ data: T | null; error: any }>
): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message || "Supabase operation failed");
  return data as T;
}

export async function insertRow(table: string, data: any): Promise<any> {
  const sb = getSupabase();
  const SKIP_ORG_ID = new Set(["ticket_logs"]);
  const payload = { ...data };
  if (SKIP_ORG_ID.has(table)) {
    delete payload.organization_id;
  } else {
    payload.organization_id = data.organization_id || ORG_ID;
  }
  const { data: rows, error } = await sb.from(table).insert(payload).select();
  if (error) throw new Error(`Insert ${table} failed: ${error.message}`);
  return Array.isArray(rows) && rows.length === 1 ? rows[0] : rows;
}

export async function updateRow(table: string, id: string, data: any): Promise<any> {
  const sb = getSupabase();
  const { data: rows, error } = await sb
    .from(table)
    .update(data)
    .eq("id", id)
    .eq("organization_id", ORG_ID)
    .select();
  if (error) throw new Error(`Update ${table} failed: ${error.message}`);
  return Array.isArray(rows) && rows.length === 1 ? rows[0] : rows;
}

export async function deleteRow(table: string, id: string): Promise<boolean> {
  const sb = getSupabase();
  const { error } = await sb
    .from(table)
    .delete()
    .eq("id", id)
    .eq("organization_id", ORG_ID);
  if (error) throw new Error(`Delete ${table} failed: ${error.message}`);
  return true;
}

export function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function toISODate(d?: string): string | null {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const match = d.match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  return d;
}

export function normaliseStatus(raw: string | null | undefined): string {
  if (!raw) return "New";
  const s = raw.trim().toLowerCase();
  if (s === "staying")                                    return "Staying";
  if (s === "onboarding" || s === "booking" || s === "booked") return "Booked";
  if (s === "on-notice" || s === "notice")                return "On-Notice";
  if (s === "exited" || s === "exit" || s === "checked_out") return "Exited";
  if (s === "new")                                        return "New";
  return "New";
}
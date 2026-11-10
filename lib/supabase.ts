// ============================================================
// REAL Supabase client (replaces the former no-op shim).
//
// All app data now flows DIRECTLY to Supabase under the logged-in
// user's session JWT, governed by your RLS policies. Convex is no
// longer in the data path.
//
// The client owns the auth session: on login we call
// `supabase.auth.setSession(...)` with the tokens the verify_otp edge
// function returns, and supabase-js persists + auto-refreshes it in
// AsyncStorage. Every `supabase.from(...)` / `supabase.rpc(...)` call
// then runs as that user, so RLS applies.
// ============================================================
import 'react-native-url-polyfill/auto'; // supabase-js needs a WHATWG URL in Hermes
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import { createClient, type SupabaseClient as SbClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';

export type SupabaseClient = SbClient;

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage as any,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  // Realtime is not used by the app; leave default. Reads/writes use PostgREST.
});

// RN best practice: only auto-refresh the token while the app is foregrounded.
if (Platform.OS !== 'web') {
  try {
    AppState.addEventListener('change', (state) => {
      if (state === 'active') supabase.auth.startAutoRefresh();
      else supabase.auth.stopAutoRefresh();
    });
    supabase.auth.startAutoRefresh();
  } catch {
    // ignore — AppState may be unavailable in some runtimes
  }
}

// ── Back-compat exports (kept so existing imports keep working) ──────
export function initSupabase(_url?: string, _key?: string): SupabaseClient {
  return supabase;
}

export function isSupabaseReady(): boolean {
  return true;
}

export function fromDb(row: Record<string, any>): Record<string, any> {
  if (!row || typeof row !== 'object') return {};
  return { ...row };
}

export function throwIfError<T extends { error?: { message?: string; code?: string } | null }>(result: T): T {
  if (result?.error) {
    throw new Error(result.error.message || 'Supabase operation failed');
  }
  return result;
}

/**
 * Auth session bootstrap utility
 * Safely gets current session or refreshes if needed
 */

import { supabase } from '../lib/supabase';

// Only clear session on true auth failures, not network errors
function shouldClearSession(err: any): boolean {
  if (!err) return false;
  const msg = (err?.message || '').toLowerCase();
  const status = err?.status || 0;
  
  // Only clear for TRUE auth failures, not transient network issues
  return status === 401 || 
         msg.includes('jwt expired') || 
         msg.includes('invalid jwt') ||
         msg.includes('token is expired') ||
         msg.includes('user not found');
}

export async function getActiveSession() {
  try {
    const { data, error } = await supabase.auth.getSession();

    if (error) {
      // Network error or other transient issue — keep cached session
      if (!shouldClearSession(error)) {
        console.log('[AUTH] Network/transient error in getSession:', error.message);
        return null; // Return null but DON'T clear session
      }
      // True auth failure — clear session
      console.warn('[AUTH] Auth failure in getSession:', error.message);
      return null;
    }

    // Session exists and is valid
    if (data?.session) {
      console.log('[AUTH] Active session found for user:', data.session.user?.phone || data.session.user?.id);
      return data.session;
    }

    // No session, try refresh
    console.log('[AUTH] No session, attempting refresh...');
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();

    if (refreshError) {
      // Only clear on true auth failures
      if (!shouldClearSession(refreshError)) {
        console.log('[AUTH] Network/transient error in refresh - keeping cached session:', refreshError.message);
        return null; // Return null but DON'T clear session
      }
      console.warn('[AUTH] Auth failure in refresh:', refreshError.message);
      return null;
    }

    if (refreshed?.session) {
      console.log('[AUTH] Session refreshed successfully');
      return refreshed.session;
    }

    console.warn('[AUTH] No session available after refresh');
    return null;
  } catch (e: any) {
    // Unexpected error — don't crash, just return null and let app use cached data
    console.error('[AUTH] Unexpected error in getActiveSession:', e?.message);
    return null;
  }
}
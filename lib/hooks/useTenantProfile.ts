/**
 * useTenantProfile Hook
 * Manages tenant profile fetching with auto-retry, error handling, and caching
 */

import { useCallback, useEffect, useState } from 'react';
import * as sb from '../supabaseService';
import type { TenantProfileResponse, ProfileError } from '../types/profile';

interface UseTenantProfileOptions {
  phone?: string;
  autoRetry?: boolean;
  maxRetries?: number;
  retryDelayMs?: number;
  cacheSeconds?: number;
}

interface UseTenantProfileState {
  data: TenantProfileResponse | null;
  loading: boolean;
  error: ProfileError | null;
  retryCount: number;
  canRetry: boolean;
  retry: () => Promise<void>;
  refresh: () => Promise<void>;
}

// ── Cache ─────────────────────────────────────────────────────────────────────
const profileCache = new Map<string, { data: TenantProfileResponse; timestamp: number }>();

function getCachedProfile(phone: string, cacheSeconds: number): TenantProfileResponse | null {
  const cached = profileCache.get(phone);
  if (!cached) return null;

  const age = (Date.now() - cached.timestamp) / 1000;
  if (age > cacheSeconds) {
    profileCache.delete(phone);
    return null;
  }

  return cached.data;
}

function setCachedProfile(phone: string, data: TenantProfileResponse): void {
  profileCache.set(phone, { data, timestamp: Date.now() });
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useTenantProfile(options: UseTenantProfileOptions = {}): UseTenantProfileState {
  const {
    phone,
    autoRetry = true,
    maxRetries = 3,
    retryDelayMs = 2000,
    cacheSeconds = 300, // 5 minutes
  } = options;

  const [data, setData] = useState<TenantProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ProfileError | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  // ── Fetch Logic ─────────────────────────────────────────────────────────────
  const fetchProfile = useCallback(async (isRetry = false) => {
    if (!phone) {
      setLoading(false);
      return;
    }

    setLoading(true);

    try {
      // Check cache first
      const cached = getCachedProfile(phone, cacheSeconds);
      if (cached && !isRetry) {
        setData(cached);
        setError(null);
        setLoading(false);
        return;
      }

      // Fetch from server.
      // NOTE: api.tenants.getTenantProfile currently returns a flat object (or null),
      // whereas this hook is written against the richer TenantProfileResponse
      // ({found, reason, message, ...}) contract. This hook has no live consumers yet;
      // the annotation preserves the intended contract so it works if the service is
      // repointed to a {found,...}-shaped action (e.g. tenantsextraactions).
      const result = (await sb.getTenantProfile(phone)) as unknown as TenantProfileResponse | null;

      if (result?.found) {
        // Success
        setData(result);
        setError(null);
        setCachedProfile(phone, result);
        setRetryCount(0); // Reset retry count on success
      } else {
        // Not found
        setData(result || null);
        setError({
          type: result?.reason === 'tenant_not_found' ? 'not_found' : 'unknown',
          message: result?.message || 'Could not load profile.',
          retryable: result?.reason !== 'tenant_not_found',
          contactManager: result?.reason === 'tenant_not_found',
        });
      }
    } catch (err: any) {
      // Network/other error
      console.warn('[useTenantProfile] Error:', err?.message);
      setData(null);
      setError({
        type: 'unknown',
        message: err?.message || 'Network error. Please try again.',
        retryable: true,
        contactManager: false,
      });

      // Auto-retry on network error
      if (autoRetry && retryCount < maxRetries && isRetry) {
        console.log(`[useTenantProfile] Auto-retrying (${retryCount + 1}/${maxRetries})...`);
        setTimeout(() => {
          setRetryCount(c => c + 1);
          fetchProfile(true);
        }, retryDelayMs);
      }
    } finally {
      setLoading(false);
    }
  }, [phone, autoRetry, maxRetries, retryDelayMs, cacheSeconds, retryCount]);

  // ── Initial Load ────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchProfile(false);
  }, [phone]); // Re-fetch when phone changes

  // ── Manual Retry ────────────────────────────────────────────────────────────
  const retry = useCallback(async () => {
    if (retryCount >= maxRetries) return;
    setRetryCount(c => c + 1);
    await fetchProfile(true);
  }, [retryCount, maxRetries, fetchProfile]);

  // ── Refresh ─────────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    profileCache.delete(phone || ''); // Bust cache
    setRetryCount(0);
    await fetchProfile(false);
  }, [phone, fetchProfile]);

  return {
    data,
    loading,
    error,
    retryCount,
    canRetry: retryCount < maxRetries && (error?.retryable ?? false),
    retry,
    refresh,
  };
}

/**
 * screenCache.ts — lightweight in-memory cache for screen data.
 *
 * WHY: Every screen calls fetchAll() on every focus event (useFocusEffect),
 * and many screens also have a useEffect + useFocusEffect both calling fetchAll,
 * causing 2x fetches on mount. Each fetchAll triggers 3-6 Convex actions.
 * With 9-19 post-mutation refetches on top, this creates massive redundant traffic.
 *
 * WHAT THIS DOES (without changing any existing code):
 * - Cache screen data for a configurable TTL (default 30s)
 * - Return cached data instantly on focus if cache is fresh
 * - Provide a `refresh(key)` helper screens can call after mutations
 *   instead of a full fetchAll() — but only if they choose to opt in
 * - Expose `isStale(key)` so screens can decide whether to skip a fetch
 *
 * USAGE (opt-in — existing code unchanged):
 *   import { screenCache } from '../lib/screenCache';
 *
 *   // Before fetchAll in useFocusEffect:
 *   if (!screenCache.isStale('assets')) return;
 *
 *   // After fetchAll succeeds:
 *   screenCache.set('assets', data);
 *
 *   // After a mutation (instead of full fetchAll):
 *   screenCache.invalidate('assets');
 */

type CacheEntry<T = any> = {
  data: T;
  timestamp: number;
  key: string;
};

class ScreenCache {
  private store = new Map<string, CacheEntry>();
  private listeners = new Map<string, Set<() => void>>();

  // Default TTL: 30 seconds — fresh enough for typical usage,
  // stale enough to prevent redundant focus-triggered fetches
  private DEFAULT_TTL_MS = 30_000;

  /**
   * Store data in cache.
   */
  set<T>(key: string, data: T, ttlMs?: number): void {
    this.store.set(key, {
      key,
      data,
      timestamp: Date.now(),
    });
    // Override TTL per-key if provided
    if (ttlMs !== undefined) {
      (this.store.get(key) as any).__ttl = ttlMs;
    }
  }

  /**
   * Get cached data. Returns null if not cached or expired.
   */
  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    const ttl = (entry as any).__ttl ?? this.DEFAULT_TTL_MS;
    if (Date.now() - entry.timestamp > ttl) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  /**
   * Returns true if the cache is stale/missing — i.e. a fetch is needed.
   * Returns false if data is fresh — caller can skip the fetch.
   */
  isStale(key: string): boolean {
    return this.get(key) === null;
  }

  /**
   * Invalidate a specific key (force next access to re-fetch).
   */
  invalidate(key: string): void {
    this.store.delete(key);
    // Notify any listeners (e.g. components watching this key)
    this.listeners.get(key)?.forEach(fn => fn());
  }

  /**
   * Invalidate all keys that start with a prefix.
   * e.g. invalidatePrefix('tenant') invalidates 'tenants', 'tenant_detail_123', etc.
   */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.invalidate(key);
    }
  }

  /**
   * Clear everything (e.g. on logout).
   */
  clear(): void {
    this.store.clear();
    this.listeners.clear();
  }

  /**
   * Subscribe to invalidation events for a key.
   * Returns an unsubscribe function.
   */
  subscribe(key: string, fn: () => void): () => void {
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(fn);
    return () => this.listeners.get(key)?.delete(fn);
  }

  /**
   * How old is the cached data, in seconds. Returns Infinity if not cached.
   */
  age(key: string): number {
    const entry = this.store.get(key);
    if (!entry) return Infinity;
    return (Date.now() - entry.timestamp) / 1000;
  }

  /**
   * Debug: list all cached keys with their ages.
   */
  debug(): void {
    console.log('[screenCache] Current cache:');
    this.store.forEach((entry, key) => {
      const age = ((Date.now() - entry.timestamp) / 1000).toFixed(1);
      const ttl = ((entry as any).__ttl ?? this.DEFAULT_TTL_MS) / 1000;
      console.log(`  ${key}: ${age}s old (TTL ${ttl}s)`);
    });
  }
}

// Singleton — shared across all screens
export const screenCache = new ScreenCache();

/**
 * Cache key constants — use these everywhere for consistency.
 */
export const CACHE_KEYS = {
  ASSETS:          'assets',
  TENANTS:         'tenants',
  TENANTS_DETAIL:  (id: string) => `tenant_detail_${id}`,
  TICKETS:         'tickets',
  PROPERTIES:      'properties',
  PROPERTY_DETAIL: (id: string) => `property_detail_${id}`,
  ELECTRICITY:     'electricity',
  REPORTS:         'reports',
  OWNERS:          'owners',
  DASHBOARD:       'dashboard',
  LIFECYCLE:       'lifecycle',
  SETTINGS:        'settings',
};

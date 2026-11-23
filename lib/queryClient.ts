// ─── React Query client + persistence ────────────────────────────────────────
// One shared QueryClient for the whole app. The cache is persisted to
// AsyncStorage (already a dependency, Expo Go compatible) so screens open
// instantly from the last-known data and survive app restarts / brief offline.
import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24h

// Android backs AsyncStorage with SQLite, whose CursorWindow caps a single row
// at ~2MB. A persisted cache larger than that throws
// "Row too big to fit into CursorWindow" on restore. Stay safely under it:
// never persist an oversized blob, and drop a bad/oversized one on read.
const MAX_CACHE_CHARS = 1_500_000; // ~1.5MB of mostly-ASCII JSON — under the ~2MB row limit

const sizeCappedStorage = {
  getItem: async (key: string): Promise<string | null> => {
    try {
      return await AsyncStorage.getItem(key);
    } catch {
      // e.g. a pre-existing oversized row throwing CursorWindow — discard it so
      // the app starts clean instead of erroring on every launch.
      try { await AsyncStorage.removeItem(key); } catch {}
      return null;
    }
  },
  setItem: async (key: string, value: string): Promise<void> => {
    // Refuse to store a blob that could exceed the SQLite row limit; a dropped
    // cache just means the next open refetches, which is fine. Better than a
    // persisted row that can never be read back.
    if (typeof value === 'string' && value.length > MAX_CACHE_CHARS) {
      try { await AsyncStorage.removeItem(key); } catch {}
      return;
    }
    try { await AsyncStorage.setItem(key, value); } catch {}
  },
  removeItem: async (key: string): Promise<void> => {
    try { await AsyncStorage.removeItem(key); } catch {}
  },
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,          // cache-first: data <60s old is served without refetch
      gcTime: CACHE_MAX_AGE,      // keep entries long enough to persist
      retry: 2,
      refetchOnReconnect: true,
      // RN has no window focus; screen-focus refetch is driven per-screen via
      // useFocusEffect(refetch), so disable the web-oriented option.
      refetchOnWindowFocus: false,
    },
  },
});

export const asyncStoragePersister = createAsyncStoragePersister({
  storage: sizeCappedStorage,
  throttleTime: 1000,
  key: 'VISHFUL_RQ_CACHE',
});

// Keep the persisted blob small so it stays under the row limit: only persist
// successful, reasonably-sized queries. Huge lists (e.g. thousands of invoices)
// are skipped from persistence and simply refetched on next open.
export const persistDehydrateOptions = {
  shouldDehydrateQuery: (query: any): boolean => {
    if (query?.state?.status !== 'success') return false;
    try {
      return JSON.stringify(query.state.data ?? null).length < 400_000; // ~400KB per query
    } catch {
      return false;
    }
  },
};

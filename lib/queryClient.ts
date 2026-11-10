// ─── React Query client + persistence ────────────────────────────────────────
// One shared QueryClient for the whole app. The cache is persisted to
// AsyncStorage (already a dependency, Expo Go compatible) so screens open
// instantly from the last-known data and survive app restarts / brief offline.
import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24h

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
  storage: AsyncStorage,
  throttleTime: 1000,
  key: 'VISHFUL_RQ_CACHE',
});

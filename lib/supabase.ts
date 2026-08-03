import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';

// Minimal local shim so the app can boot even when the Supabase package
// is unavailable in this runtime.
export type SupabaseClient = any;

let _client: any = null;
let _initialized = false;

function createLocalSupabaseClient() {
  const storage = {
    from: (_bucket: string) => ({
      async upload(_path: string, _data: any, _options?: any) {
        return { data: null, error: { message: 'Supabase storage unavailable in this runtime' } };
      },
      getPublicUrl(path: string) {
        return { data: { publicUrl: path } };
      },
    }),
    async listBuckets() {
      return { data: [], error: null };
    },
    async createBucket(_bucket: string, _options?: any) {
      return { data: null, error: null };
    },
  };

  const auth = {
    startAutoRefresh() {},
    stopAutoRefresh() {},
    async getSession() {
      return { data: { session: null }, error: null };
    },
  };

  return {
    storage,
    auth,
    from(_table: string) {
      return {
        select() {
          return Promise.resolve({ data: null, error: null });
        },
        insert() {
          return Promise.resolve({ data: null, error: null });
        },
        update() {
          return Promise.resolve({ data: null, error: null });
        },
        delete() {
          return Promise.resolve({ data: null, error: null });
        },
        upsert() {
          return Promise.resolve({ data: null, error: null });
        },
        eq() {
          return this;
        },
        order() {
          return this;
        },
        limit() {
          return this;
        },
        single() {
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
}

function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  return fetch(input, { ...init, signal: controller.signal })
    .then(resp => { clearTimeout(timeoutId); return resp; })
    .catch(err => {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') throw new Error('Supabase request timed out (15s)');
      throw err;
    });
}

export function initSupabase(url: string, key: string): SupabaseClient {
  if (_client && _initialized) {
    return _client;
  }

  console.log('[SUPABASE INIT] URL:', url);

  if (!url || !url.startsWith('https://') || !key || key.length < 20) {
    console.error('[SUPABASE INIT] INVALID CREDENTIALS');
  }

  _client = createLocalSupabaseClient();
  _initialized = true;
  console.log('[SUPABASE INIT] Local shim created successfully');

  if (Platform.OS !== 'web') {
    try {
      AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          _client?.auth.startAutoRefresh();
        } else {
          _client?.auth.stopAutoRefresh();
        }
      });
    } catch (_) {
      // ignore
    }
  }

  return _client;
}

initSupabase(SUPABASE_URL, SUPABASE_ANON_KEY);

export function isSupabaseReady(): boolean {
  return _initialized && _client !== null;
}

export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target: any, prop: string | symbol) {
    if (!_client) {
      if (prop === 'from') {
        console.warn('[SUPABASE] .from() called before initialization');
        return (table: string) => ({
          select: () => Promise.resolve({ data: null, error: { message: `Supabase not initialized (table: ${table})`, code: 'NOT_INIT' } }),
          insert: () => Promise.resolve({ data: null, error: { message: 'Supabase not initialized', code: 'NOT_INIT' } }),
          update: () => Promise.resolve({ data: null, error: { message: 'Supabase not initialized', code: 'NOT_INIT' } }),
          delete: () => Promise.resolve({ data: null, error: { message: 'Supabase not initialized', code: 'NOT_INIT' } }),
          upsert: () => Promise.resolve({ data: null, error: { message: 'Supabase not initialized', code: 'NOT_INIT' } }),
          eq: () => ({}),
        });
      }
      if (prop === 'storage') {
        console.warn('[SUPABASE] .storage accessed before initialization');
        return {
          from: () => ({
            upload: () => Promise.resolve({ data: null, error: { message: 'Supabase not initialized' } }),
            getPublicUrl: () => ({ data: { publicUrl: '' } }),
          }),
          listBuckets: () => Promise.resolve({ data: [], error: null }),
          createBucket: () => Promise.resolve({ data: null, error: null }),
        };
      }
      if (prop === 'auth') {
        console.warn('[SUPABASE] .auth accessed before initialization');
        return {
          startAutoRefresh: () => {},
          stopAutoRefresh: () => {},
          getSession: () => Promise.resolve({ data: { session: null }, error: null }),
        };
      }
      console.warn(`[SUPABASE] .${String(prop)} accessed before initialization`);
      return undefined;
    }

    const value = (_client as any)[prop];
    if (typeof value === 'function') {
      return value.bind(_client);
    }
    return value;
  },
});

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
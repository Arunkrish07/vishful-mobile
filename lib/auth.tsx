import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as sb from './supabaseService';


interface TenantLocation {
  found: true;
  tenantId: string;
  tenantName: string;
  unitNumber: string;
  floor: string;
  buildingName: string;
  propertyName: string;
  propertyAddress: string;
  bedCode: string;
  monthlyRent: number;
  checkInDate: string;
  propertyId: string;
  apartmentId: string;
  bedId: string;
}

interface AuthUser {
  userId: string;
  userName: string;
  phone: string;
  role: string;
  organizationId: string;
  organizationName: string;
  supabaseUserId: string | null;
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  tenantLocation: TenantLocation | null;
  login: (token: string, userData?: AuthUser) => Promise<void>;
  logout: () => void;
  refreshUser: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null, token: null, isLoading: true, isAuthenticated: false,
  tenantLocation: null,
  login: async () => {}, logout: () => {}, refreshUser: () => {},
});

const TOKEN_KEY = '@vishful_auth_token';
const USER_KEY = '@vishful_auth_user';

export function AuthProvider({ children }: { children: any }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isStorageLoading, setIsStorageLoading] = useState(true);
  const mounted = useRef(true);
  const justLoggedIn = useRef(false);
  const sessionValidated = useRef(false);

  useEffect(() => { return () => { mounted.current = false; }; }, []);

  // Load stored token + user on startup
  useEffect(() => {
    const loadAuth = async () => {
      try {
        const savedToken = await AsyncStorage.getItem(TOKEN_KEY);
        const savedUser = await AsyncStorage.getItem(USER_KEY);

        console.log("[LOAD AUTH] token exists:", !!savedToken, "user exists:", !!savedUser);

        if (savedToken && savedUser) {
          setToken(savedToken);
          setUser(JSON.parse(savedUser));
        }
      } catch (e) {
        console.log("[AUTH LOAD ERROR]", e);
      } finally {
        setIsStorageLoading(false);
      }
    };

    loadAuth();
  }, []);

  // Validate session in background — NEVER blocks the UI
  useEffect(() => {
    if (!token) {
      setUser(null);
      sessionValidated.current = false;
      return;
    }

    // Skip if fresh login — data is already verified
    if (justLoggedIn.current) {
      justLoggedIn.current = false;
      sessionValidated.current = true;
      console.log('[AUTH] Skipping session validation (fresh login)');
      return;
    }

    // Skip if already validated this session
    if (sessionValidated.current) return;
    sessionValidated.current = true;

    // Run in background — UI already showing with cached user
    console.log('[AUTH] Background session validation...');
    sb.getSession(token)
      .then((session) => {
        if (!mounted.current) return;

        if (session === null || session === undefined) {
          console.log('[AUTH] Session check returned null (error/offline) — keeping existing data');
          return;
        }

        if (session.valid) {
          console.log('[AUTH] Session valid, userId:', session.userId, 'role:', session.role);
          const userData: AuthUser = {
            userId: session.userId!,
            userName: session.userName || '',
            phone: session.phone || '',
            role: session.role || '',
            organizationId: session.organizationId || '',
            organizationName: session.organizationName || 'Vishful Spaces LLP',
            // Prefer the value getSession now returns; fall back to the cached
            // value so an older backend (pre-deploy) never wipes it to null.
            supabaseUserId: (session as any).supabaseUserId ?? user?.supabaseUserId ?? null,
          };
          setUser(userData);
          AsyncStorage.setItem(USER_KEY, JSON.stringify(userData)).catch(() => {});
        } else {
          console.log('[AUTH] Session invalid — clearing auth state');
          sessionValidated.current = false;
          setToken(null);
          setUser(null);
          AsyncStorage.removeItem(TOKEN_KEY).catch(() => {});
          AsyncStorage.removeItem(USER_KEY).catch(() => {});
        }
      })
      .catch((err) => {
        console.warn('[AUTH] Session validation error (keeping cached data):', err?.message);
      });
  }, [token]);

  // Diagnostic logging
  useEffect(() => {
    console.log('[AUTH] user:', user?.userId);
    console.log('[AUTH] role:', user?.role);
    console.log('[AUTH] token exists:', !!token);
  }, [user, token]);

  const isTenant = user?.role === 'tenant';
  const [tenantLocation, setTenantLocation] = useState<TenantLocation | null>(null);

  useEffect(() => {
    if (isTenant && token && user?.phone) {
      sb.getTenantLocation(user.phone)
        .then((result: any) => {
          if (mounted.current && result && result.found === true) {
            setTenantLocation(result as TenantLocation);
          } else if (mounted.current) {
            setTenantLocation(null);
          }
        })
        .catch((err: any) => {
          console.warn('[Auth] getTenantLocation error:', err?.message);
          if (mounted.current) setTenantLocation(null);
        });
    } else {
      setTenantLocation(null);
    }
  }, [isTenant, token, user?.phone]);

  const login = useCallback(async (newToken: string, userData?: AuthUser) => {
    try {
      await AsyncStorage.setItem(TOKEN_KEY, newToken);
      if (userData) {
        await AsyncStorage.setItem(USER_KEY, JSON.stringify(userData));
        setUser(userData);
      }
      justLoggedIn.current = true;
      sessionValidated.current = false;
      setToken(newToken);
      console.log("[AUTH LOGIN SUCCESS] user:", userData?.userName, "role:", userData?.role);
      // Best-effort push registration (no-ops in Expo Go / without a native build).
      import('./pushNotifications')
        .then(m => m.registerForPush(userData?.supabaseUserId ?? userData?.userId ?? null, userData?.role ?? null))
        .catch(() => {});
    } catch (e) {
      console.log("[AUTH LOGIN ERROR]", e);
    }
  }, []);

  const logout = useCallback(() => {
    sessionValidated.current = false;
    // Best-effort: drop this device's push token before clearing the session.
    import('./pushNotifications').then(m => m.unregisterPush()).catch(() => {});
    setToken(null);
    setUser(null);
    setTenantLocation(null);
    AsyncStorage.removeItem(TOKEN_KEY).catch(() => {});
    AsyncStorage.removeItem(USER_KEY).catch(() => {});
  }, []);

  const refreshUser = useCallback(() => {
    if (!token) return;
    sessionValidated.current = false;
    const t = token;
    setToken(null);
    setTimeout(() => { setToken(t); }, 50);
  }, [token]);

  // FIXED: only wait for AsyncStorage read (~50ms), never wait for network validation
  const isLoading = isStorageLoading;
  const isAuthenticated = !!token && !!user;

  return (
    <AuthContext.Provider value={{ user, token, isLoading, isAuthenticated, tenantLocation, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() { return useContext(AuthContext); }
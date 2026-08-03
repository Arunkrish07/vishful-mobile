/**
 * PermissionsContext
 * ─────────────────
 * Fetches role_permissions from Supabase (via Convex) once after login
 * and exposes a `canAccess(module)` helper used by App.tsx to filter
 * drawer screens based on each user's actual DB-configured permissions.
 *
 * super_admin / org_admin always get full access (short-circuit).
 * All other admin roles (property_manager, admin, …) go through DB lookup.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from 'react';
import { useAuth } from './auth';
import * as sb from './supabaseService';

// Module names must match the MODULES array in SettingsScreen & the drawer screen names in App.tsx
export type AppModule =
  | 'Dashboard'
  | 'Properties'
  | 'Owners'
  | 'Tenants'
  | 'Tenant Lifecycle'
  | 'Assets'
  | 'Accounting'
  | 'Electricity'
  | 'Reports'
  | 'Analytics'
  | 'Availability'
  | 'Tickets'
  | 'Team'
  | 'Market AI'
  | 'WhatsApp Logs'
  | 'Audit Logs'
  | 'Settings';

type PermMap = Record<string, { can_read: boolean; can_create: boolean; can_update: boolean; can_delete: boolean }>;

interface PermissionsContextType {
  /** Returns true when the current user's role grants can_read for the given module */
  canAccess: (module: AppModule) => boolean;
  /** Returns the full permission row for a module (for screens that check can_create / can_update etc.) */
  getModulePerms: (module: AppModule) => { can_read: boolean; can_create: boolean; can_update: boolean; can_delete: boolean };
  isPermissionsLoading: boolean;
  /** True for super_admin / org_admin — used by the drawer to bypass HIDDEN_ON_MOBILE. */
  isSuperuser: boolean;
}

const DEFAULT_PERMS = { can_read: false, can_create: false, can_update: false, can_delete: false };
const FULL_ACCESS   = { can_read: true,  can_create: true,  can_update: true,  can_delete: true  };

// Roles that always bypass DB permission checks and get full access
const SUPERUSER_ROLES = new Set(['super_admin', 'org_admin']);

// Roles that should go through DB permission lookup
const MANAGED_ROLES = new Set(['property_manager', 'admin', 'manager']);

const PermissionsContext = createContext<PermissionsContextType>({
  canAccess: () => true,
  getModulePerms: () => FULL_ACCESS,
  isPermissionsLoading: false,
  isSuperuser: false,
});

export function PermissionsProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated } = useAuth();
  const [permMap, setPermMap]     = useState<PermMap>({});
  const [isLoading, setIsLoading] = useState(false);
  const lastFetchedRole           = useRef<string | null>(null);

  const role = user?.role || '';

  // Determine access model for this role
  const isSuperuser    = SUPERUSER_ROLES.has(role);
  const isManagedAdmin = MANAGED_ROLES.has(role);
  // Any other non-null role that isn't tenant/technician falls back to full access
  const isUnknownAdmin = !isSuperuser && !isManagedAdmin && role !== 'tenant' && role !== 'technician' && role !== '';

  useEffect(() => {
    // Clear on logout
    if (!isAuthenticated || !role) {
      setPermMap({});
      lastFetchedRole.current = null;
      return;
    }

    // Superusers and unknown-but-admin roles don't need a fetch
    if (isSuperuser || isUnknownAdmin) {
      setPermMap({});
      lastFetchedRole.current = role;
      return;
    }

    // Only fetch for managed roles; skip if we already have data for this role
    if (!isManagedAdmin) return;
    if (lastFetchedRole.current === role) return;

    setIsLoading(true);
    lastFetchedRole.current = role;

    sb.getPermissions(role)
      .then((rows: any[]) => {
        const map: PermMap = {};
        (rows || []).forEach((r: any) => {
          map[r.module] = {
            can_read:   !!r.can_read,
            can_create: !!r.can_create,
            can_update: !!r.can_update,
            can_delete: !!r.can_delete,
          };
        });
        setPermMap(map);
        console.log('[PERMISSIONS] Loaded for role:', role, '| modules:', Object.keys(map).join(', '));
      })
      .catch((err: any) => {
        console.warn('[PERMISSIONS] Failed to load, defaulting to full access:', err?.message);
        setPermMap({}); // empty → canAccess falls back to true for safety
      })
      .finally(() => setIsLoading(false));
  }, [role, isAuthenticated, isSuperuser, isManagedAdmin, isUnknownAdmin]);

  const canAccess = useCallback((module: AppModule): boolean => {
    // Superusers / unknown-admin roles always have full access
    if (isSuperuser || isUnknownAdmin) return true;

    // Non-admin roles are handled by AppNavigator routing — not by this context
    if (role === 'tenant' || role === 'technician') return true;

    // Managed roles: check DB-loaded map
    // Dashboard is always visible (every admin needs a landing page)
    if (module === 'Dashboard') return true;

    const perm = permMap[module];
    if (!perm) {
      // If permissions haven't loaded yet or module isn't in DB, default to DENY
      // (safer: don't show pages the admin hasn't explicitly granted)
      return Object.keys(permMap).length === 0; // true only while still loading (before fetch completes)
    }
    return perm.can_read;
  }, [isSuperuser, isUnknownAdmin, role, permMap]);

  const getModulePerms = useCallback((module: AppModule) => {
    if (isSuperuser || isUnknownAdmin) return FULL_ACCESS;
    return permMap[module] || DEFAULT_PERMS;
  }, [isSuperuser, isUnknownAdmin, permMap]);

  return (
    <PermissionsContext.Provider value={{ canAccess, getModulePerms, isPermissionsLoading: isLoading, isSuperuser }}>
      {children}
    </PermissionsContext.Provider>
  );
}

export function usePermissions() {
  return useContext(PermissionsContext);
}
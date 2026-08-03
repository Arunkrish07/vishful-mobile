/**
 * tabPermissions.ts
 * Shared utility — fetch tab_permissions for a given role + module,
 * return a Set of visible tab_keys (or null = show all).
 *
 * null  → no rows configured in DB for this role/module → default OPEN (show all)
 * Empty Set → rows exist but none are visible → show nothing
 */
import { client, api } from './convexApi';

// Roles that always bypass tab permission checks
const SUPERUSER_ROLES = new Set(['super_admin', 'org_admin']);

/**
 * Returns Set<string> of visible tab_keys, or null (= show all tabs).
 * Call this once on screen mount per role+module combination.
 */
export async function fetchVisibleTabKeys(
  role: string,
  module: string
): Promise<Set<string> | null> {
  if (!role || SUPERUSER_ROLES.has(role)) return null; // superusers see everything

  try {
    const rows: any[] = await client.action(api.settings.getTabPermissions, {});
    const roleRows = (rows || []).filter(
      (r: any) => r.role === role && r.module === module
    );
    if (roleRows.length === 0) return null; // no config → show all
    const visible = new Set<string>(
      roleRows.filter((r: any) => r.is_visible).map((r: any) => r.tab_key as string)
    );
    return visible;
  } catch {
    return null; // on error → show all (safe fallback)
  }
}

/**
 * Filter a tabs array using the result of fetchVisibleTabKeys.
 * visibleKeys = null → return all tabs unchanged.
 */
export function filterTabs<T extends { key: string }>(
  tabs: T[],
  visibleKeys: Set<string> | null
): T[] {
  if (visibleKeys === null) return tabs;
  return tabs.filter(t => visibleKeys.has(t.key));
}
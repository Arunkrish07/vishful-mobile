"use node";

/**
 * convex/tabpermission.ts
 * Server-side Convex action — queries tab_permissions from Supabase.
 * This file runs on the Convex backend. Do NOT import client-side modules here.
 *
 * The client-side helpers (fetchVisibleTabKeys, filterTabs) live in
 * lib/tabPermissions.ts and call this action via the Convex HTTP client.
 */

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID, safeList } from "./lib/supabaseAdmin";

/**
 * Returns all tab_permission rows for this organisation.
 * Filtering by role/module/visibility is done client-side in lib/tabPermissions.ts.
 */
export const getTabPermissions = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return safeList(
      sb
        .from("tab_permissions")
        .select("*")
        .eq("organization_id", ORG_ID)
        .order("module")
    );
  },
});
"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase } from "./lib/supabaseAdmin";

export const checkUserRolesColumns = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    
    // Get one row to see column shape
    const { data: rows, error } = await sb
      .from("user_roles")
      .select("*")
      .limit(2);
    
    if (error) {
      return { error: error.message };
    }
    
    return {
      columnNames: rows && rows.length > 0 ? Object.keys(rows[0]) : [],
      sampleRows: rows,
      rowCount: rows?.length,
    };
  },
});

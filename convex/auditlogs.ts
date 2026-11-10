"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID, safeList } from "./lib/supabaseAdmin";

// ─── AUDIT LOGS (read-only, paginated) ───────────────────────────────────────
// Mirrors web src/pages/AuditLogs.tsx: server-paginated audit_logs, filtered by
// table / action / user / date, with performer names resolved from `profiles`.
export const listAuditLogs = action({
  args: {
    page: v.optional(v.number()),
    pageSize: v.optional(v.number()),
    tableName: v.optional(v.string()),
    action: v.optional(v.string()),
    performedBy: v.optional(v.string()),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    const page = Math.max(0, args.page ?? 0);
    const pageSize = Math.min(100, Math.max(1, args.pageSize ?? 50));
    const fromIdx = page * pageSize;
    const toIdx = fromIdx + pageSize - 1;

    let q = sb
      .from("audit_logs")
      .select(
        "id, table_name, action, performed_by, performed_at, changes, record_id",
        { count: "exact" },
      )
      .eq("organization_id", ORG_ID)
      .order("performed_at", { ascending: false });
    if (args.tableName && args.tableName !== "all") q = q.eq("table_name", args.tableName);
    if (args.action && args.action !== "all") q = q.eq("action", args.action);
    if (args.performedBy && args.performedBy !== "all") q = q.eq("performed_by", args.performedBy);
    if (args.from) q = q.gte("performed_at", args.from);
    if (args.to) q = q.lte("performed_at", args.to);

    const { data, error, count } = await q.range(fromIdx, toIdx);
    if (error) {
      console.warn("[auditlogs]", error.message);
      return { rows: [], total: 0, page, pageSize };
    }
    const rows: any[] = data || [];

    // Resolve performer display names from profiles (global lookup, like web).
    const ids = [...new Set(rows.map((r) => r.performed_by).filter(Boolean))];
    const profiles: any[] = ids.length
      ? await safeList(sb.from("profiles").select("id, full_name, email").in("id", ids))
      : [];
    const nameById = new Map<string, string>();
    for (const p of profiles) {
      nameById.set(p.id, p.full_name || p.email || String(p.id).slice(0, 8));
    }

    return {
      rows: rows.map((r) => ({
        id: r.id,
        tableName: r.table_name || "",
        action: r.action || "",
        performedBy: r.performed_by || null,
        performerName: r.performed_by
          ? nameById.get(r.performed_by) || String(r.performed_by).slice(0, 8)
          : "System",
        performedAt: r.performed_at || null,
        changes: r.changes || null,
        recordId: r.record_id || null,
      })),
      total: count ?? rows.length,
      page,
      pageSize,
    };
  },
});

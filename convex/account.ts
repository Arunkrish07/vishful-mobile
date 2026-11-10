"use node";

import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";
import { getSupabase, ORG_ID } from "./lib/supabaseAdmin";

// ─── ACCOUNT DELETION (request-only, non-destructive) ─────────────────────────
// Records an in-app "delete my account" request as an audit_logs entry so the team
// can action it per the published data-deletion policy. It does NOT touch the user's
// records — personal data removal and financial-record retention are handled by the
// team. Identity is resolved SERVER-SIDE from the auth token (never trusted from the
// client), by reusing the canonical getSession verifier.
export const requestAccountDeletion = action({
  args: { token: v.string(), reason: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, { token, reason }) => {
    const session: any = await ctx.runAction(api.otpAuth.getSession, { token });
    if (!session?.valid || !session?.userId) {
      return { success: false, message: "Your session has expired. Please sign in again." };
    }

    const sb = getSupabase();
    const tableName = session.role === "tenant" ? "tenants" : "team_members";
    const nowIso = new Date().toISOString();

    const { error } = await sb.from("audit_logs").insert({
      organization_id: session.organizationId || ORG_ID,
      table_name: tableName,
      action: "account_deletion_requested",
      performed_by: session.userId,
      record_id: session.userId,
      performed_at: nowIso,
      changes: {
        requestType: "account_deletion",
        name: session.userName || "",
        phone: session.phone || "",
        role: session.role || "",
        requestedAt: nowIso,
        reason: reason || null,
        source: "mobile_app",
      },
    });

    if (error) {
      console.warn("[account.requestAccountDeletion]", error.message);
      return { success: false, message: "Could not submit your request. Please try again." };
    }

    console.log(`[account] deletion requested: role=${session.role}, phone=${session.phone}`);
    return { success: true };
  },
});

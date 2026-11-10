"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID, safeList, updateRow } from "./lib/supabaseAdmin";

// ─── WHATSAPP DELIVERY LOGS (read-only) ──────────────────────────────────────
// Mirrors web WhatsAppDeliveryHistoryCard: list recent send jobs, then drill
// into a job's per-recipient deliveries. Resend/resume (edge-function writes)
// are intentionally deferred — added once they can be verified live.

export const listWhatsappJobs = action({
  args: { jobType: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (_ctx, { jobType, limit }) => {
    const sb = getSupabase();
    let q = sb
      .from("whatsapp_send_jobs")
      .select(
        "id, job_type, label, status, total_count, sent_count, failed_count, error_message, created_at, updated_at",
      )
      .eq("organization_id", ORG_ID)
      .order("created_at", { ascending: false })
      .limit(Math.min(100, Math.max(1, limit ?? 50)));
    if (jobType && jobType !== "all") q = q.eq("job_type", jobType);

    const rows: any[] = await safeList(q);
    return rows.map((r) => ({
      id: r.id,
      jobType: r.job_type || "",
      label: r.label || null,
      status: r.status || "",
      totalCount: Number(r.total_count ?? 0),
      sentCount: Number(r.sent_count ?? 0),
      failedCount: Number(r.failed_count ?? 0),
      errorMessage: r.error_message || null,
      createdAt: r.created_at || null,
      updatedAt: r.updated_at || null,
    }));
  },
});

export const listJobDeliveries = action({
  args: { jobId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { jobId }) => {
    const sb = getSupabase();
    const rows: any[] = await safeList(
      sb
        .from("whatsapp_send_deliveries")
        .select(
          "id, job_id, tenant_id, delivery_kind, tenant_name, label, status, error_message, phone_masked, created_at, sent_at",
        )
        .eq("organization_id", ORG_ID)
        .eq("job_id", jobId)
        .order("created_at", { ascending: true }),
    );
    return rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      tenantId: r.tenant_id || null,
      deliveryKind: r.delivery_kind || null,
      tenantName: r.tenant_name || null,
      label: r.label || null,
      status: r.status || "",
      errorMessage: r.error_message || null,
      phoneMasked: r.phone_masked || null,
      createdAt: r.created_at || null,
      sentAt: r.sent_at || null,
    }));
  },
});

// ─── SEARCH DELIVERIES (message-level, across all jobs) ──────────────────────
// Web parity (whatsapp-log-filters classifySearchTerm): search by tenant name,
// label/caption, or phone (resolved to tenant ids). Returns matching deliveries
// with their job id so the row keeps its resend/fix-number actions.
export const searchWhatsappDeliveries = action({
  args: { term: v.string() },
  returns: v.any(),
  handler: async (_ctx, { term }) => {
    const sb = getSupabase();
    // Strip LIKE wildcards / PostgREST or() grammar chars (sanitizeIlikeTerm).
    const clean = String(term || "").trim().replace(/[%_,()\\"']/g, " ").replace(/\s+/g, " ").trim();
    if (clean.length < 2) return [];

    // Phone-looking term → resolve to tenant ids by phone, OR'd into the search.
    const digits = clean.replace(/\D/g, "");
    let tenantIds: string[] = [];
    if (digits.length >= 6) {
      const ts: any[] = await safeList(
        sb.from("tenants").select("id").eq("organization_id", ORG_ID).ilike("phone", `%${digits.slice(-10)}%`).limit(200)
      );
      tenantIds = ts.map((t: any) => t.id).filter(Boolean);
    }

    const orParts = [`tenant_name.ilike.%${clean}%`, `label.ilike.%${clean}%`];
    if (tenantIds.length) orParts.push(`tenant_id.in.(${tenantIds.join(",")})`);

    const rows: any[] = await safeList(
      sb.from("whatsapp_send_deliveries")
        .select("id, job_id, tenant_id, delivery_kind, tenant_name, label, status, error_message, phone_masked, created_at, sent_at")
        .eq("organization_id", ORG_ID)
        .or(orParts.join(","))
        .order("created_at", { ascending: false })
        .limit(100)
    );
    return rows.map((r: any) => ({
      id: r.id,
      jobId: r.job_id,
      tenantId: r.tenant_id || null,
      deliveryKind: r.delivery_kind || null,
      tenantName: r.tenant_name || null,
      label: r.label || null,
      status: r.status || "",
      errorMessage: r.error_message || null,
      phoneMasked: r.phone_masked || null,
      createdAt: r.created_at || null,
      sentAt: r.sent_at || null,
    }));
  },
});

// ─── WRITES (edge-function backed) ───────────────────────────────────────────
// Mirror web whatsappSendJobService: resend a single delivery, resend all
// failed/pending in a job, and resume a stalled job. The whatsapp-send-job edge
// function posts to WhatsApp and updates delivery/job status — we never flip
// those statuses by hand.

// Re-queue one delivery: whatsapp-send-job { action: "resend_delivery", delivery_id }.
export const resendDelivery = action({
  args: { deliveryId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { deliveryId }) => {
    const sb = getSupabase();
    try {
      const { error } = await sb.functions.invoke("whatsapp-send-job", {
        body: { action: "resend_delivery", delivery_id: deliveryId },
      });
      if (error) return { ok: false, reason: error.message || "resend failed" };
      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: e?.message || "edge function unavailable" };
    }
  },
});

// Fix a delivery that failed due to a wrong/missing number: update the tenant's
// phone, then re-queue that one delivery. Mirrors web savePhone
// (updateTenantPhoneNumber + resendWhatsappDelivery). ok=true means the phone was
// saved; resent=false (with a reason) means the follow-up resend didn't fire.
export const updateTenantPhoneAndResend = action({
  args: { tenantId: v.string(), newPhone: v.string(), deliveryId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { tenantId, newPhone, deliveryId }) => {
    const phone = (newPhone || "").trim();
    if (!phone) return { ok: false, reason: "Enter a phone number" };
    const sb = getSupabase();
    try {
      await updateRow("tenants", tenantId, { phone });
    } catch (e: any) {
      return { ok: false, reason: e?.message || "Could not update phone" };
    }
    try {
      const { error } = await sb.functions.invoke("whatsapp-send-job", {
        body: { action: "resend_delivery", delivery_id: deliveryId },
      });
      if (error) return { ok: true, resent: false, reason: error.message || "Number saved, but resend failed" };
      return { ok: true, resent: true };
    } catch (e: any) {
      return { ok: true, resent: false, reason: e?.message || "Number saved, but resend is unavailable" };
    }
  },
});

// Resend every failed/pending delivery in a job (pending rows can be stuck if the
// edge function died mid-job), one invoke per delivery. Returns how many attempted.
export const resendAllFailed = action({
  args: { jobId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { jobId }) => {
    const sb = getSupabase();
    const rows: any[] = await safeList(
      sb
        .from("whatsapp_send_deliveries")
        .select("id")
        .eq("organization_id", ORG_ID)
        .eq("job_id", jobId)
        .in("status", ["failed", "pending"]),
    );
    const ids = rows.map((r) => r.id).filter(Boolean);
    const results = await Promise.allSettled(
      ids.map((id) =>
        sb.functions.invoke("whatsapp-send-job", {
          body: { action: "resend_delivery", delivery_id: id },
        }),
      ),
    );
    const failed = results.filter(
      (r) => r.status === "rejected" || (r as any).value?.error,
    ).length;
    return { ok: true, attempted: ids.length, failed };
  },
});

// Resume a stalled job: reset it to pending, then re-invoke the edge function
// so it picks up stuck deliveries. Status transitions from there are the edge
// function's job.
export const resumeJob = action({
  args: { jobId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { jobId }) => {
    const sb = getSupabase();
    try {
      const { error: upErr } = await sb
        .from("whatsapp_send_jobs")
        .update({ status: "pending", error_message: null } as any)
        .eq("id", jobId)
        .eq("organization_id", ORG_ID);
      if (upErr) return { ok: false, reason: upErr.message };
      const { error } = await sb.functions.invoke("whatsapp-send-job", {
        body: { job_id: jobId },
      });
      if (error) return { ok: false, reason: error.message || "resume failed" };
      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: e?.message || "edge function unavailable" };
    }
  },
});

"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID, safeList } from "./lib/supabaseAdmin";

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
          "id, job_id, delivery_kind, tenant_name, label, status, error_message, phone_masked, created_at, sent_at",
        )
        .eq("organization_id", ORG_ID)
        .eq("job_id", jobId)
        .order("created_at", { ascending: true }),
    );
    return rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
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

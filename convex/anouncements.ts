"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID, insertRow, updateRow, deleteRow } from "./lib/supabaseAdmin";

// ─── Resolve WhatsApp controls from org_whatsapp_settings (web parity) ────────
async function resolveWhatsappControls(sb: any) {
  let row: any = null;
  try {
    const { data } = await sb
      .from("org_whatsapp_settings")
      .select("notifications_enabled, test_phone, test_mode_enabled")
      .eq("organization_id", ORG_ID)
      .maybeSingle();
    row = data;
  } catch {
    row = null;
  }
  const notificationsEnabled = row?.notifications_enabled ?? true;
  const testNumber = (row?.test_phone ?? "").trim();
  const orgSandbox = Boolean(row?.test_mode_enabled);
  return {
    enabled: notificationsEnabled,
    testNumber,
    testAnnouncementMode: orgSandbox,
    testInvoiceMode: orgSandbox,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  SEND ANNOUNCEMENT OVER WHATSAPP
//  Mirrors web notifyAnnouncementCreated → whatsapp-notify edge function with
//  event_type "announcement_created". The server resolves active tenants and
//  sends the BotBee image/text template based on whether image_url is present.
//  Returns { ok, sent?, skipped?, reason? } so the UI can show the result and
//  fall back gracefully if WhatsApp is off / unavailable.
// ═══════════════════════════════════════════════════════════════════════════
export const sendAnnouncementWhatsapp = action({
  args: {
    title: v.string(),
    content: v.string(),
    priority: v.optional(v.string()),
    imageUrl: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.any(),
  handler: async (_ctx, { title, content, priority, imageUrl }) => {
    const sb = getSupabase();
    const controls = await resolveWhatsappControls(sb);
    if (!controls.enabled) {
      return { ok: false, skipped: "whatsapp_disabled", reason: "WhatsApp notifications are turned off in Settings." };
    }
    try {
      const { data, error } = await sb.functions.invoke("whatsapp-notify", {
        body: {
          event_type: "announcement_created",
          controls,
          organization_id: ORG_ID,
          title,
          content,
          priority: priority ?? "normal",
          image_url: (imageUrl && String(imageUrl).trim()) || null,
        },
      });
      if (error) {
        return { ok: false, reason: error.message || "whatsapp-notify failed", whatsapp: false };
      }
      const row: any = data || {};
      if (row?.error) return { ok: false, reason: row.error };
      if (row?.skipped === "disabled" || row?.skipped === "whatsapp_disabled") {
        return { ok: false, skipped: "whatsapp_disabled", reason: "WhatsApp is disabled for this workspace." };
      }
      return { ok: true, sent: row?.sent ?? 0, skipped: row?.skipped ?? null };
    } catch (e: any) {
      return { ok: false, reason: e?.message || "edge function unavailable", whatsapp: false };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  UPLOAD ANNOUNCEMENT IMAGE
//  Accepts a base64 image (from the mobile picker), uploads to the
//  announcement-images storage bucket, returns the public URL.
// ═══════════════════════════════════════════════════════════════════════════
export const uploadAnnouncementImage = action({
  args: { base64: v.string(), contentType: v.optional(v.string()), ext: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, { base64, contentType, ext }) => {
    const sb = getSupabase();
    // Web parity: announcement banners live in the `org-assets` bucket under
    // `announcements/<orgId>/...` (NOT a separate `announcement-images` bucket).
    const bucket = "org-assets";
    const extension = (ext || "png").replace(/[^a-z0-9]/gi, "") || "png";
    const path = `announcements/${ORG_ID}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
    // Decode base64 → bytes
    const bytes = Buffer.from(base64, "base64");
    const { error } = await sb.storage
      .from(bucket)
      .upload(path, bytes, { contentType: contentType || "image/jpeg", upsert: true });
    if (error) {
      return { ok: false, reason: error.message };
    }
    const { data: pub } = sb.storage.from(bucket).getPublicUrl(path);
    return { ok: true, url: pub?.publicUrl || null };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  DELETE ANNOUNCEMENT IMAGE (best-effort cleanup — web parity)
//  Mirrors deleteAnnouncementImageFromPublicUrl: removes the banner from
//  `org-assets` only for paths under `announcements/`.
// ═══════════════════════════════════════════════════════════════════════════
export const deleteAnnouncementImage = action({
  args: { imageUrl: v.optional(v.union(v.string(), v.null())) },
  returns: v.any(),
  handler: async (_ctx, { imageUrl }) => {
    if (!imageUrl || typeof imageUrl !== "string") return { ok: true, skipped: "no_url" };
    const trimmed = imageUrl.trim();
    if (!/^https:\/\//i.test(trimmed)) return { ok: true, skipped: "not_url" };
    const marker = "/object/public/org-assets/";
    const idx = trimmed.indexOf(marker);
    if (idx === -1) return { ok: true, skipped: "not_org_assets" };
    let path = decodeURIComponent(trimmed.slice(idx + marker.length));
    const q = path.indexOf("?");
    if (q !== -1) path = path.slice(0, q);
    if (!path.startsWith("announcements/")) return { ok: true, skipped: "not_announcement" };
    try {
      const sb = getSupabase();
      const { error } = await sb.storage.from("org-assets").remove([path]);
      if (error) return { ok: false, reason: error.message };
      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: e?.message || "remove failed" };
    }
  },
});

// ─── List announcements (org-scoped, newest first) ────────────────────────────
export const listAnnouncements = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const { data } = await sb
      .from("announcements")
      .select("id, title, content, image_url, priority, is_published, published_at, created_at, created_by, organization_id")
      .eq("organization_id", ORG_ID)
      .order("created_at", { ascending: false });
    return data || [];
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  CREATE / UPDATE / DELETE (org-scoped, service-role)
//  Web parity: announcements are managed by admins. Publishing sets
//  published_at; unpublishing clears it. Uses the shared supabaseAdmin
//  row helpers so organization_id scoping matches every other module.
// ═══════════════════════════════════════════════════════════════════════════
export const createAnnouncement = action({
  args: {
    title: v.string(),
    content: v.string(),
    priority: v.optional(v.string()),
    imageUrl: v.optional(v.union(v.string(), v.null())),
    isPublished: v.optional(v.boolean()),
    createdBy: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.any(),
  handler: async (_ctx, { title, content, priority, imageUrl, isPublished, createdBy }) => {
    const published = Boolean(isPublished);
    const row = await insertRow("announcements", {
      title: title.trim(),
      content: content.trim(),
      priority: priority || "normal",
      image_url: (imageUrl && String(imageUrl).trim()) || null,
      is_published: published,
      published_at: published ? new Date().toISOString() : null,
      created_by: createdBy ?? null,
    });
    return { ok: true, announcement: row };
  },
});

export const updateAnnouncement = action({
  args: {
    id: v.string(),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    priority: v.optional(v.string()),
    imageUrl: v.optional(v.union(v.string(), v.null())),
    isPublished: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (_ctx, { id, title, content, priority, imageUrl, isPublished }) => {
    const patch: Record<string, any> = {};
    if (title !== undefined) patch.title = title.trim();
    if (content !== undefined) patch.content = content.trim();
    if (priority !== undefined) patch.priority = priority;
    if (imageUrl !== undefined) patch.image_url = (imageUrl && String(imageUrl).trim()) || null;
    if (isPublished !== undefined) {
      patch.is_published = isPublished;
      patch.published_at = isPublished ? new Date().toISOString() : null;
    }
    const row = await updateRow("announcements", id, patch);
    return { ok: true, announcement: row };
  },
});

export const deleteAnnouncement = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    await deleteRow("announcements", id);
    return { ok: true };
  },
});
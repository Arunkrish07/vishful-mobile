"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID } from "./lib/supabaseAdmin";

// ─── MARKET AI (read-only) ───────────────────────────────────────────────────
// Mirrors web src/pages/MarketIntelligence.tsx read paths: tracked competitors
// and locality expansion opportunities. Both are RPC-backed. The market-trigger
// edge function (scan/retry) is a write and is intentionally deferred.

export const getMarketCompetitors = action({
  args: { limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (_ctx, { limit }) => {
    const sb = getSupabase();
    try {
      const { data, error } = await (sb.rpc as any)("get_market_competitors", {
        p_organization_id: ORG_ID,
        p_limit: Math.min(200, Math.max(1, limit ?? 100)),
      });
      if (error) throw error;
      const rows: any[] = Array.isArray(data) ? data : [];
      return rows.map((c) => {
        const intel = c.intelligence || {};
        return {
          id: c.id,
          name: c.name || "Unknown",
          rating: c.rating ?? null,
          reviewCount: c.review_count ?? null,
          website: c.website_url || null,
          lastScrapedAt: c.last_scraped_at || null,
          localityName: c.locality?.name || null,
          city: c.locality?.city || null,
          marketSegment: intel.market_segment || null,
          crawlStatus: intel.crawl_status || null,
          // Web parity: pass through the full intelligence block (was discarded) so the
          // mobile competitor card can expand to show pricing/rooms/scores/contact/etc.
          intelligence: {
            marketSegment: intel.market_segment || null,
            crawlStatus: intel.crawl_status || null,
            pricingMin: intel.pricing_min ?? null,
            pricingMax: intel.pricing_max ?? null,
            roomTypes: intel.room_types || null,
            amenityScore: intel.amenity_score ?? null,
            digitalMaturityScore: intel.digital_maturity_score ?? null,
            targetDemographic: intel.target_demographic || null,
            hasOnlineBooking: intel.has_online_booking ?? null,
            hasVirtualTour: intel.has_virtual_tour ?? null,
            hasPhotos: intel.has_photos ?? null,
            uspTags: intel.usp_tags || null,
            amenities: intel.amenities || null,
            phone: intel.phone || null,
            email: intel.email || null,
            errorMessage: intel.error_message || null,
            crawledUrl: intel.crawled_url || null,
          },
        };
      });
    } catch (e: any) {
      console.warn("[market] get_market_competitors failed:", e?.message);
      return [];
    }
  },
});

export const getExpansionOpportunities = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    try {
      const { data, error } = await (sb.rpc as any)("get_expansion_opportunities", {
        p_organization_id: ORG_ID,
      });
      if (error) throw error;
      const rows: any[] = Array.isArray(data) ? data : [];
      return rows.map((o) => ({
        localityName: o.locality_name || "",
        city: o.city || "",
        competitorCount: Number(o.competitor_count ?? 0),
        avgMarketPrice: Number(o.avg_market_price ?? 0),
        opportunityScore: Number(o.opportunity_score ?? 0),
      }));
    } catch (e: any) {
      console.warn("[market] get_expansion_opportunities failed:", e?.message);
      return [];
    }
  },
});

// ─── WRITES (market-trigger edge function) ───────────────────────────────────
// Mirror web MarketIntelligence: an empty body starts a discovery/scan run;
// { action: "retry-intel" } re-runs failed competitor analyses. The edge
// function enqueues jobs and writes results — we only kick it off.

export const triggerMarketScan = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    try {
      const { data, error } = await sb.functions.invoke("market-trigger", { body: {} });
      if (error) return { ok: false, reason: error.message || "market sync failed" };
      return { ok: true, jobs: (data as any)?.jobs ?? null };
    } catch (e: any) {
      return { ok: false, reason: e?.message || "edge function unavailable" };
    }
  },
});

export const retryMarketIntel = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    try {
      const { data, error } = await sb.functions.invoke("market-trigger", {
        body: { action: "retry-intel" },
      });
      if (error) return { ok: false, reason: error.message || "retry failed" };
      return { ok: true, retried: (data as any)?.retried ?? null };
    } catch (e: any) {
      return { ok: false, reason: e?.message || "edge function unavailable" };
    }
  },
});

// ─── TRACKED LOCALITIES (Settings tab CRUD) ──────────────────────────────────
// Web parity: wraps the same RPCs as web useMarketLocalities — the only way to
// add/pause/remove the localities the scraper tracks. Mutating RPCs (not the
// deferred market-trigger edge fn), so these work once deployed.
export const getTrackedLocalities = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    try {
      const { data, error } = await (sb.rpc as any)("get_tracked_localities", { p_organization_id: ORG_ID });
      if (error) throw error;
      const rows: any[] = Array.isArray(data) ? data : [];
      return rows.map((t) => ({
        id: t.id,
        isActive: t.is_active ?? true,
        cityWideScan: t.city_wide_scan ?? false,
        createdAt: t.created_at || null,
        locality: {
          id: t.locality?.id || null,
          name: t.locality?.name || null,
          city: t.locality?.city || null,
          state: t.locality?.state || null,
        },
      }));
    } catch (e: any) {
      console.warn("[market] get_tracked_localities failed:", e?.message);
      return [];
    }
  },
});

export const upsertTrackedLocality = action({
  args: { localityName: v.string(), city: v.string() },
  returns: v.any(),
  handler: async (_ctx, { localityName, city }) => {
    const sb = getSupabase();
    try {
      const { data, error } = await (sb.rpc as any)("upsert_tracked_locality", {
        p_organization_id: ORG_ID,
        p_locality_name: localityName,
        p_city: city,
      });
      if (error) return { ok: false, reason: error.message || "Could not add locality" };
      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, reason: e?.message || "Could not add locality" };
    }
  },
});

export const toggleTrackedLocality = action({
  args: { trackingId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { trackingId }) => {
    const sb = getSupabase();
    try {
      const { error } = await (sb.rpc as any)("toggle_tracked_locality", { p_tracking_id: trackingId, p_organization_id: ORG_ID });
      if (error) return { ok: false, reason: error.message };
      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: e?.message || "toggle failed" };
    }
  },
});

export const removeTrackedLocality = action({
  args: { trackingId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { trackingId }) => {
    const sb = getSupabase();
    try {
      const { error } = await (sb.rpc as any)("remove_tracked_locality", { p_tracking_id: trackingId, p_organization_id: ORG_ID });
      if (error) return { ok: false, reason: error.message };
      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: e?.message || "remove failed" };
    }
  },
});

export const toggleCityWideScan = action({
  args: { city: v.string() },
  returns: v.any(),
  handler: async (_ctx, { city }) => {
    const sb = getSupabase();
    try {
      const { error } = await (sb.rpc as any)("toggle_city_wide_scan", { p_organization_id: ORG_ID, p_city: city });
      if (error) return { ok: false, reason: error.message };
      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: e?.message || "toggle failed" };
    }
  },
});

// ─── SUMMARY + PRICING BENCHMARK (web get_market_summary_v1 / _benchmark_v1) ──
export const getMarketSummary = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    try {
      const { data, error } = await (sb.rpc as any)("get_market_summary_v1", { p_organization_id: ORG_ID });
      if (error) throw error;
      const d: any = data || {};
      return {
        competitorCount: d.competitorCount ?? d.competitor_count ?? 0,
        trackedLocalities: d.trackedLocalities ?? d.tracked_localities ?? 0,
        lastScrapedAt: d.lastScrapedAt ?? d.last_scraped_at ?? null,
        avgMarketPrice: d.avgMarketPrice ?? d.avg_market_price ?? null,
      };
    } catch (e: any) {
      console.warn("[market] get_market_summary_v1 failed:", e?.message);
      return null;
    }
  },
});

export const getMarketBenchmark = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    try {
      const { data, error } = await (sb.rpc as any)("get_market_benchmark_v1", { p_organization_id: ORG_ID });
      if (error) throw error;
      const rows: any[] = Array.isArray(data?.localities) ? data.localities : (Array.isArray(data) ? data : []);
      return rows.map((r) => ({
        localityName: r.locality_name || null,
        roomTypeLabel: r.room_type_label || null,
        priceMedian: r.price_median ?? null,
        priceP25: r.price_p25 ?? null,
        priceP75: r.price_p75 ?? null,
        priceAvg: r.price_avg ?? null,
        propertyCount: r.property_count ?? 0,
      }));
    } catch (e: any) {
      console.warn("[market] get_market_benchmark_v1 failed:", e?.message);
      return [];
    }
  },
});

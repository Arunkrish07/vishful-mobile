"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import {
  getSupabase, ORG_ID, safeList, insertRow, updateRow, deleteRow, uuid,
} from "./lib/supabaseAdmin";

// ─── Pagination helper ────────────────────────────────────────────────────────
// Supabase PostgREST caps every query at 1000 rows by default.
// This helper fetches pages of PAGE_SIZE until a page returns fewer rows,
// guaranteeing all records are retrieved regardless of table size.
const PAGE_SIZE = 1000;
async function fetchAllPages(buildQuery: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>): Promise<any[]> {
  const all: any[] = [];
  let from = 0;
  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await buildQuery(from, to);
    if (error) { console.warn("[supabase fetchAllPages]", error.message); break; }
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break; // last page reached
    from += PAGE_SIZE;
  }
  return all;
}

// ─── CATEGORIES ──────────────────────────────────────────────────────
export const listCategories = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const [cats, types] = await Promise.all([
      safeList(sb.from("asset_categories").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("asset_types").select("id,category_id").eq("organization_id", ORG_ID)),
    ]);
    return cats.map((c: any) => ({
      _id: c.id, name: c.name,
      typeCount: types.filter((t: any) => t.category_id === c.id).length,
    }));
  },
});

// ─── TYPES ───────────────────────────────────────────────────────────
export const listTypes = action({
  args: { categoryId: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, { categoryId }) => {
    const sb = getSupabase();
    let q = sb.from("asset_types").select("*").eq("organization_id", ORG_ID);
    if (categoryId) q = q.eq("category_id", categoryId);
    const [types, cats] = await Promise.all([
      safeList(q),
      safeList(sb.from("asset_categories").select("id,name").eq("organization_id", ORG_ID)),
    ]);
    const catMap = Object.fromEntries(cats.map((c: any) => [c.id, c.name]));
    return types.map((t: any) => ({
      _id: t.id, categoryId: t.category_id, categoryName: catMap[t.category_id] || "Unknown",
      name: t.name, expectedLifeMonths: t.expected_life_months ?? undefined,
      replacementCostEstimate: t.replacement_cost_estimate ?? undefined,
    }));
  },
});

export const createAssetType = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data: args }) => {
    const id = uuid();
    await insertRow("asset_types", {
      id, category_id: args.categoryId, name: args.name,
      expected_life_months: args.expectedLifeMonths ?? null,
      depreciation_method: args.depreciationMethod ?? null,
      depreciation_years: args.depreciationYears ?? null,
      maintenance_cycle_months: args.maintenanceCycleMonths ?? null,
      replacement_cost_estimate: args.replacementCostEstimate ?? null,
    });
    return id;
  },
});

// ─── ASSETS ──────────────────────────────────────────────────────────
export const listAssets = action({
  args: { status: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, { status }) => {
    const sb = getSupabase();
    // Paginate to fetch ALL assets — Supabase caps at 1000 rows per request
    const assets = await fetchAllPages((from, to) => {
      let q = sb.from("assets").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false }).range(from, to);
      if (status) q = q.eq("status", status);
      return q;
    });
    if (!assets.length) return [];

    const typeIds = [...new Set(assets.map((a: any) => a.asset_type_id).filter(Boolean))];
    let typeMap: Record<string, any> = {};
    let catMap: Record<string, string> = {};
    if (typeIds.length) {
      const types = await safeList(sb.from("asset_types").select("*").in("id", typeIds));
      typeMap = Object.fromEntries(types.map((t: any) => [t.id, t]));
      const catIds = [...new Set(types.map((t: any) => t.category_id).filter(Boolean))];
      if (catIds.length) {
        const cats = await safeList(sb.from("asset_categories").select("id,name").in("id", catIds));
        catMap = Object.fromEntries(cats.map((c: any) => [c.id, c.name]));
      }
    }
    let allocMap: Record<string, any> = {};
    try {
      const allocations = await safeList(
        sb.from("asset_allocations")
          .select("*,properties(property_name),apartments(apartment_code),beds(bed_code)")
          .eq("organization_id", ORG_ID)
      );
      for (const alloc of allocations) allocMap[alloc.asset_id] = alloc;
    } catch {}

    // Build vendor id → name map
    let vendorMap: Record<string, string> = {};
    try {
      const vendors = await safeList(sb.from("vendors").select("id,vendor_name").eq("organization_id", ORG_ID));
      vendorMap = Object.fromEntries(vendors.map((v: any) => [v.id, v.vendor_name || '']));
    } catch {}

    return assets.map((a: any) => {
      const t = typeMap[a.asset_type_id];
      const alloc = allocMap[a.id];
      let locationName: string | undefined;
      let apartmentId: string | undefined;
      if (alloc) {
        apartmentId = alloc.apartment_id ?? undefined;
        if (alloc.allocation_type === "bed") {
          const apt = alloc.apartments?.apartment_code || "";
          const bed = alloc.beds?.bed_code || "";
          locationName = apt && bed ? `${apt}-${bed}` : bed || apt || undefined;
        } else if (alloc.allocation_type === "apartment") {
          locationName = alloc.apartments?.apartment_code || undefined;
        } else if (alloc.allocation_type === "property") {
          locationName = alloc.properties?.property_name || undefined;
        }
      }
      return {
        _id: a.id, _creationTime: new Date(a.created_at || 0).getTime(),
        assetCode: a.asset_code || "", qrCode: a.qr_code || "",
        typeName: t?.name || "Unknown",
        categoryName: t ? catMap[t.category_id] || "Unknown" : "Unknown",
        brand: a.brand ?? undefined, model: a.model ?? undefined,
        purchaseDate: a.purchase_date ?? undefined,
        purchasePrice: a.purchase_price != null ? Number(a.purchase_price) : undefined,
        condition: a.condition || "new", status: a.status || "available",
        locationName, warrantyExpiry: a.warranty_expiry ?? undefined,
        warrantyMonths: a.warranty_months ?? undefined,
        invoiceNumber: a.invoice_number ?? undefined, invoiceDate: a.invoice_date ?? undefined,
        vendorNameManual: a.vendor_name_manual ?? undefined,
        vendorId: a.supplier_id ?? a.vendor_id ?? undefined,
        vendorName: vendorMap[a.supplier_id ?? a.vendor_id ?? ''] || undefined,
        invoiceUrl: a.invoice_url ?? undefined, productPhotoUrl: a.product_photo_url ?? undefined,
        serialNumber: a.serial_number ?? undefined, notes: a.notes ?? undefined,
        expectedLifeMonths: t?.expected_life_months ?? undefined,
        assetTypeId: a.asset_type_id ?? undefined,
        supplierId: a.supplier_id ?? undefined,
        capacityValue: a.capacity_value ?? undefined,
        capacityUnit: a.capacity_unit ?? undefined,
        apartmentId,
      };
    });
  },
});

export const getAssetStats = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    // Paginate to fetch ALL assets — Supabase caps at 1000 rows per request
    const assets = await fetchAllPages((from, to) =>
      sb.from("assets").select("*").eq("organization_id", ORG_ID).range(from, to)
    );
    if (!assets.length) return { totalAssets: 0, totalInvestment: 0, inWarranty: 0, needsMaintenance: 0, byCategory: [] };
    const totalInvestment = assets.reduce((sum: number, a: any) => sum + (Number(a.purchase_price) || 0), 0);
    const now = new Date().toISOString().split("T")[0];
    const inWarranty = assets.filter((a: any) => a.warranty_expiry && a.warranty_expiry > now).length;
    const needsMaintenance = assets.filter((a: any) => a.status === "maintenance").length;
    const typeIds = [...new Set(assets.map((a: any) => a.asset_type_id).filter(Boolean))];
    const catCount: Record<string, number> = {};
    if (typeIds.length) {
      const types = await safeList(sb.from("asset_types").select("id,category_id").in("id", typeIds));
      const catIds = [...new Set(types.map((t: any) => t.category_id).filter(Boolean))];
      let catNameMap: Record<string, string> = {};
      if (catIds.length) {
        const cats = await safeList(sb.from("asset_categories").select("id,name").in("id", catIds));
        catNameMap = Object.fromEntries(cats.map((c: any) => [c.id, c.name]));
      }
      const typeToCat = Object.fromEntries(types.map((t: any) => [t.id, catNameMap[t.category_id] || "Unknown"]));
      for (const a of assets) {
        const name = typeToCat[a.asset_type_id] || "Unknown";
        catCount[name] = (catCount[name] || 0) + 1;
      }
    }
    return {
      totalAssets: assets.length, totalInvestment, inWarranty, needsMaintenance,
      byCategory: Object.entries(catCount).map(([name, count]) => ({ name, count })),
    };
  },
});

export const createAsset = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data: args }) => {
    const sb = getSupabase();
    const types = await safeList(sb.from("asset_types").select("*").eq("id", args.assetTypeId));
    if (!types.length) throw new Error("Asset type not found");
    const assetType = types[0];
    const cats = await safeList(sb.from("asset_categories").select("*").eq("id", assetType.category_id));
    const cat = cats[0];
    const existing = await safeList(sb.from("assets").select("id").eq("organization_id", ORG_ID));
    const typePrefix = assetType.name.substring(0, 3).toUpperCase();
    const catPrefix = cat ? cat.name.substring(0, 3).toUpperCase() : "AST";
    const assetCode = `${catPrefix}-${typePrefix}-${String(existing.length + 1).padStart(5, "0")}`;
    const id = uuid();
    let warrantyExpiry: string | null = null;
    if (args.purchaseDate && args.warrantyMonths) {
      const d = new Date(args.purchaseDate);
      d.setMonth(d.getMonth() + args.warrantyMonths);
      warrantyExpiry = d.toISOString().split("T")[0];
    }
    await insertRow("assets", {
      id, asset_type_id: args.assetTypeId, asset_code: assetCode,
      qr_code: `https://vishful.co.in/vista/asset?id=${id}&code=${encodeURIComponent(assetCode)}`, serial_number: args.serialNumber ?? null,
      brand: args.brand ?? null, model: args.model ?? null,
      purchase_date: args.purchaseDate ?? null, purchase_price: args.purchasePrice ?? null,
      warranty_months: args.warrantyMonths ?? null, warranty_expiry: warrantyExpiry,
      vendor_name_manual: args.vendorNameManual ?? null,
      supplier_id: args.supplierId ?? null,
      invoice_number: args.invoiceNumber ?? null,
      invoice_date: args.invoiceDate ?? null,
      invoice_url: args.invoiceUrl ?? null,
      product_photo_url: args.productPhotoUrl ?? null,
      capacity_value: args.capacityValue ?? null,
      capacity_unit: args.capacityUnit ?? null,
      notes: args.notes ?? null,
      condition: args.condition ?? "new",
      status: args.status ?? "inventory",
    });
    return id;
  },
});

export const updateAsset = action({
  args: { assetId: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { assetId, data: args }) => {
    const update: Record<string, any> = {};
    if (args.brand !== undefined) update.brand = args.brand;
    if (args.model !== undefined) update.model = args.model;
    if (args.condition !== undefined) update.condition = args.condition;
    if (args.status !== undefined) update.status = args.status;
    if (args.purchasePrice !== undefined) update.purchase_price = args.purchasePrice;
    if (args.notes !== undefined) update.notes = args.notes;
    if (args.serialNumber !== undefined) update.serial_number = args.serialNumber;
    if (args.invoiceNumber !== undefined) update.invoice_number = args.invoiceNumber;
    if (args.invoiceDate !== undefined) update.invoice_date = args.invoiceDate;
    if (args.warrantyExpiry !== undefined) update.warranty_expiry = args.warrantyExpiry;
    if (args.warrantyMonths !== undefined) update.warranty_months = args.warrantyMonths;
    if (args.vendorNameManual !== undefined) update.vendor_name_manual = args.vendorNameManual;
    if (args.invoiceUrl !== undefined) update.invoice_url = args.invoiceUrl;
    if (args.productPhotoUrl !== undefined) update.product_photo_url = args.productPhotoUrl;
    if (args.assetTypeId !== undefined) update.asset_type_id = args.assetTypeId;
    if (args.supplierId !== undefined) update.supplier_id = args.supplierId;
    if (args.purchaseDate !== undefined) update.purchase_date = args.purchaseDate;
    if (args.capacityValue !== undefined) update.capacity_value = args.capacityValue;
    if (args.capacityUnit !== undefined) update.capacity_unit = args.capacityUnit;
    if (Object.keys(update).length > 0) await updateRow("assets", assetId, update);
    return { success: true };
  },
});

export const removeAsset = action({
  args: { assetId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { assetId }) => {
    const sb = getSupabase();
    for (const table of ["asset_allocations", "asset_movements", "asset_maintenance_logs"]) {
      try { await sb.from(table).delete().eq("asset_id", assetId); } catch {}
    }
    const { error } = await sb.from("assets").delete().eq("id", assetId).eq("organization_id", ORG_ID);
    if (error) throw new Error(`Delete failed: ${error.message}`);
    return { success: true, assetId };
  },
});

export const allocateAsset = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data: args }) => {
    const sb = getSupabase();
    try { await sb.from("asset_allocations").delete().eq("asset_id", args.assetId).eq("organization_id", ORG_ID); } catch {}
    if (args.allocationType === "bed" && args.bedIds?.length) {
      const rows = args.bedIds.map((bedId: string) => ({
        asset_id: args.assetId, allocation_type: "bed",
        property_id: args.propertyId || null, apartment_id: args.apartmentId || null,
        bed_id: bedId, organization_id: ORG_ID,
      }));
      const { error } = await sb.from("asset_allocations").insert(rows);
      if (error) throw new Error(`Allocate failed: ${error.message}`);
    } else {
      const { error } = await sb.from("asset_allocations").insert({
        asset_id: args.assetId, allocation_type: args.allocationType,
        property_id: args.propertyId || null, apartment_id: args.apartmentId || null,
        bed_id: null, organization_id: ORG_ID,
      });
      if (error) throw new Error(`Allocate failed: ${error.message}`);
    }
    await updateRow("assets", args.assetId, { status: "allocated" });
    return { success: true };
  },
});

export const deallocateAsset = action({
  args: { assetId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { assetId }) => {
    const sb = getSupabase();
    try { await sb.from("asset_allocations").delete().eq("asset_id", assetId).eq("organization_id", ORG_ID); } catch {}
    await updateRow("assets", assetId, { status: "inventory" });
    return { success: true };
  },
});

// ─── VENDORS ─────────────────────────────────────────────────────────
export const listVendors = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const data = await safeList(
      sb.from("vendors").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false })
    );
    return data.map((vn: any) => ({
      id: vn.id, name: vn.vendor_name || vn.name || "",
      contactPerson: vn.contact_person || "", phone: vn.phone || "",
      email: vn.email || "", address: vn.address || "",
      gstNumber: vn.gst_number || "", panNumber: vn.pan_number || "",
      vendorRating: vn.vendor_rating || 0,
      status: vn.status || "active", createdAt: vn.created_at,
    }));
  },
});

export const createVendor = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data: args }) => {
    return await insertRow("vendors", {
      vendor_name: args.vendor_name, contact_person: args.contact_person ?? null,
      phone: args.phone ?? null, email: args.email ?? null,
      address: args.address ?? null, gst_number: args.gst_number ?? null,
      pan_number: args.pan_number ?? null, status: "active",
      created_at: new Date().toISOString(),
    });
  },
});

// ─── NEW: LIST ALLOCATIONS ────────────────────────────────────────────────────
export const listAllocations = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    // ROBUST: no embedded joins. Fetch allocations plainly, then resolve the
    // related rows in separate queries and stitch in code. This removes every
    // PostgREST embed failure mode (whitespace, ambiguous FK, missing relation)
    // that can make an embedded select silently return [] via safeList.
    const allocs = await safeList(
      sb.from("asset_allocations")
        .select("id, asset_id, allocation_type, property_id, apartment_id, bed_id, allocated_date, created_at")
        .eq("organization_id", ORG_ID)
        .order("created_at", { ascending: false })
    );
    if (!allocs.length) return [];

    // Collect the ids we need to resolve
    const assetIds = [...new Set(allocs.map((a: any) => a.asset_id).filter(Boolean))];
    const propIds  = [...new Set(allocs.map((a: any) => a.property_id).filter(Boolean))];
    const aptIds   = [...new Set(allocs.map((a: any) => a.apartment_id).filter(Boolean))];
    const bedIds   = [...new Set(allocs.map((a: any) => a.bed_id).filter(Boolean))];

    // Fetch related rows in parallel (each guarded by safeList)
    const [assetsRows, propRows, aptRows, bedRows] = await Promise.all([
      assetIds.length ? safeList(sb.from("assets").select("id, asset_code, brand, model, purchase_price, asset_type_id").in("id", assetIds)) : Promise.resolve([]),
      propIds.length  ? safeList(sb.from("properties").select("id, property_name").in("id", propIds))                                       : Promise.resolve([]),
      aptIds.length   ? safeList(sb.from("apartments").select("id, apartment_code").in("id", aptIds))                                       : Promise.resolve([]),
      bedIds.length   ? safeList(sb.from("beds").select("id, bed_code").in("id", bedIds))                                                   : Promise.resolve([]),
    ]);

    // Resolve asset_type names → category names for the asset display
    const typeIds = [...new Set((assetsRows as any[]).map((a: any) => a.asset_type_id).filter(Boolean))];
    const typeRows = typeIds.length ? await safeList(sb.from("asset_types").select("id, name, category_id").in("id", typeIds)) : [];
    const catIds = [...new Set((typeRows as any[]).map((t: any) => t.category_id).filter(Boolean))];
    const catRows = catIds.length ? await safeList(sb.from("asset_categories").select("id, name").in("id", catIds)) : [];

    const typeMap = Object.fromEntries((typeRows as any[]).map((t: any) => [t.id, t]));
    const catMap  = Object.fromEntries((catRows as any[]).map((c: any) => [c.id, c.name]));
    const assetMap = Object.fromEntries((assetsRows as any[]).map((a: any) => {
      const t = typeMap[a.asset_type_id];
      return [a.id, {
        asset_code: a.asset_code,
        brand: a.brand,
        model: a.model,
        purchase_price: a.purchase_price,
        asset_types: t ? { name: t.name, asset_categories: { name: catMap[t.category_id] || null } } : null,
      }];
    }));
    const propMap = Object.fromEntries((propRows as any[]).map((p: any) => [p.id, { property_name: p.property_name }]));
    const aptMap  = Object.fromEntries((aptRows  as any[]).map((a: any) => [a.id, { apartment_code: a.apartment_code }]));
    const bedMap  = Object.fromEntries((bedRows  as any[]).map((b: any) => [b.id, { bed_code: b.bed_code }]));

    // Stitch into the shape the screen expects (snake_case row + nested embeds)
    return allocs.map((al: any) => ({
      id: al.id,
      asset_id: al.asset_id,
      allocation_type: al.allocation_type,
      property_id: al.property_id,
      apartment_id: al.apartment_id,
      bed_id: al.bed_id,
      allocated_date: al.allocated_date ?? al.created_at ?? null,
      created_at: al.created_at,
      assets: assetMap[al.asset_id] || null,
      properties: al.property_id ? (propMap[al.property_id] || null) : null,
      apartments: al.apartment_id ? (aptMap[al.apartment_id] || null) : null,
      beds: al.bed_id ? (bedMap[al.bed_id] || null) : null,
    }));
  },
});

// ─── NEW: GET ALLOCATION FOR BED (scoped — avoids org-wide fetch) ─────────────
// Tenant-safe: returns only the single allocation tied to this bed (or null),
// not the whole org's asset_allocations table. Used by the tenant ticket-raise
// screen to show the read-only "linked to your room's asset" line.
export const getAllocationForBed = action({
  args: { bedId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { bedId }) => {
    const sb = getSupabase();
    const { data: alloc } = (await sb
      .from("asset_allocations")
      .select("id, asset_id, allocation_type, bed_id")
      .eq("organization_id", ORG_ID)
      .eq("allocation_type", "bed")
      .eq("bed_id", bedId)
      .maybeSingle()) as any;
    if (!alloc?.asset_id) return null;

    const { data: asset } = (await sb
      .from("assets")
      .select("id, asset_code, brand, model")
      .eq("organization_id", ORG_ID)
      .eq("id", alloc.asset_id)
      .maybeSingle()) as any;
    if (!asset) return null;

    return {
      asset_id: alloc.asset_id,
      assets: { brand: asset.brand ?? null, model: asset.model ?? null, asset_code: asset.asset_code ?? null },
    };
  },
});

// ─── NEW: UPDATE VENDOR ───────────────────────────────────────────────────────
export const updateVendor = action({
  args: { vendorId: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { vendorId, data }) => {
    const sb = getSupabase();
    await sb.from("vendors").update({
      vendor_name:    data.vendor_name    ?? undefined,
      contact_person: data.contact_person ?? undefined,
      phone:          data.phone          ?? undefined,
      email:          data.email          ?? undefined,
      address:        data.address        ?? undefined,
      gst_number:     data.gst_number     ?? undefined,
      pan_number:     data.pan_number     ?? undefined,
      status:         data.status         ?? undefined,
    } as any).eq("id", vendorId).eq("organization_id", ORG_ID);
    return { success: true };
  },
});

// ─── NEW: DELETE VENDOR ───────────────────────────────────────────────────────
export const deleteVendor = action({
  args: { vendorId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { vendorId }) => {
    const sb = getSupabase();
    await sb.from("vendors").delete().eq("id", vendorId).eq("organization_id", ORG_ID);
    return { success: true };
  },
});

// ─── NEW: UPDATE VENDOR RATING ────────────────────────────────────────────────
export const updateVendorRating = action({
  args: { vendorId: v.string(), rating: v.number() },
  returns: v.any(),
  handler: async (_ctx, { vendorId, rating }) => {
    const sb = getSupabase();
    await sb.from("vendors").update({ vendor_rating: rating } as any).eq("id", vendorId).eq("organization_id", ORG_ID);
    return { success: true };
  },
});

// ─── NEW: CREATE CATEGORY ─────────────────────────────────────────────────────
export const createCategory = action({
  args: { name: v.string() },
  returns: v.any(),
  handler: async (_ctx, { name }) => {
    return await insertRow("asset_categories", {
      name,
      organization_id: ORG_ID,
      created_at: new Date().toISOString(),
    });
  },
});

// ─── GET ASSET DETAIL ─────────────────────────────────────────────────────────
// Fetches full asset data + vendor details + allocation + maintenance history
// Mirrors web AssetDetail.tsx data fetching exactly.
export const getAssetDetail = action({
  args: { assetId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { assetId }) => {
    const sb = getSupabase();
    const [assetRes, allocRes, maintRes, payRes, moveRes] = await Promise.all([
      sb.from("assets")
        .select("*, asset_types(name, expected_life_months, asset_categories(name)), vendors(vendor_name, phone, email, gst_number)")
        .eq("id", assetId)
        .single(),
      sb.from("asset_allocations")
        .select("*, properties(property_name), apartments(apartment_code), beds(bed_code)")
        .eq("asset_id", assetId)
        .order("created_at", { ascending: false }),
      sb.from("asset_maintenance_logs")
        .select("*")
        .eq("asset_id", assetId)
        .order("maintenance_date", { ascending: false }),
      sb.from("asset_payments")
        .select("*, vendors(vendor_name)")
        .eq("asset_id", assetId)
        .order("payment_date", { ascending: false }),
      sb.from("asset_movements")
        .select("*")
        .eq("asset_id", assetId)
        .order("move_date", { ascending: false }),
    ]);

    const a = assetRes.data;
    if (!a) return null;

    const allocList = allocRes.data || [];
    const alloc = allocList[0] || null;
    const maintenance = maintRes.data || [];
    const payments = payRes.data || [];
    const movements = moveRes.data || [];
    const totalPaid = payments.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
    const balanceDue = Math.max(0, (Number(a.purchase_price) || 0) - totalPaid);

    // Compute warranty expiry from purchase_date + warranty_months (mirrors web)
    let warrantyExpiry: string | null = a.warranty_expiry || null;
    if (!warrantyExpiry && a.purchase_date && a.warranty_months) {
      const d = new Date(a.purchase_date);
      d.setMonth(d.getMonth() + a.warranty_months);
      warrantyExpiry = d.toISOString().split("T")[0];
    }
    const warrantyActive = warrantyExpiry ? new Date(warrantyExpiry) > new Date() : false;
    const warrantyMonthsLeft = warrantyExpiry
      ? Math.max(0, Math.round((new Date(warrantyExpiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30)))
      : 0;

    const expectedLife = a.asset_types?.expected_life_months;
    const ageMonths = a.purchase_date
      ? Math.round((Date.now() - new Date(a.purchase_date).getTime()) / (1000 * 60 * 60 * 24 * 30))
      : 0;
    const lifetimePercent = expectedLife ? Math.min(100, Math.round((ageMonths / expectedLife) * 100)) : null;

    return {
      id: a.id,
      assetCode: a.asset_code || "",
      qrCode: a.qr_code || "",
      typeName: a.asset_types?.name || "Unknown",
      categoryName: (a.asset_types as any)?.asset_categories?.name || "Unknown",
      expectedLifeMonths: expectedLife ?? null,
      brand: a.brand ?? null, model: a.model ?? null,
      serialNumber: a.serial_number ?? null,
      purchaseDate: a.purchase_date ?? null,
      purchasePrice: a.purchase_price != null ? Number(a.purchase_price) : null,
      condition: a.condition || "new",
      status: a.status || "available",
      warrantyMonths: a.warranty_months ?? null,
      warrantyExpiry,
      warrantyActive,
      warrantyMonthsLeft,
      invoiceNumber: a.invoice_number ?? null,
      invoiceDate: a.invoice_date ?? null,
      invoiceUrl: a.invoice_url ?? null,
      productPhotoUrl: a.product_photo_url ?? null,
      notes: a.notes ?? null,
      vendorNameManual: a.vendor_name_manual ?? null,
      // Joined vendor details
      vendor: a.vendors ? {
        name: (a.vendors as any).vendor_name,
        phone: (a.vendors as any).phone || null,
        email: (a.vendors as any).email || null,
        gst:   (a.vendors as any).gst_number || null,
      } : null,
      // Current allocation
      allocation: alloc ? {
        type: alloc.allocation_type,
        property: alloc.properties?.property_name || null,
        apartment: alloc.apartments?.apartment_code || null,
        bed: alloc.beds?.bed_code || null,
        date: alloc.allocated_date || alloc.created_at || null,
      } : null,
      // Lifetime metrics
      ageMonths,
      lifetimePercent,
      // Maintenance history
      maintenance: maintenance.map((m: any) => ({
        id: m.id,
        date: m.maintenance_date,
        type: m.maintenance_type,
        issue: m.issue || null,
        vendor: m.vendor || null,
        cost: m.repair_cost ? Number(m.repair_cost) : 0,
        nextDue: m.next_service_due || null,
        notes: m.notes || null,
      })),
      totalMaintenanceCost: maintenance.reduce((s: number, m: any) => s + (Number(m.repair_cost) || 0), 0),
      // Payments
      payments: payments.map((p: any) => ({
        id: p.id,
        date: p.payment_date,
        amount: Number(p.amount) || 0,
        mode: p.payment_mode || null,
        reference: p.reference_number || null,
        vendor: (p.vendors as any)?.vendor_name || null,
        proofUrl: p.payment_proof_url || null,
        notes: p.notes || null,
      })),
      totalPaid,
      balanceDue,
      // Movement / flow history
      movements: movements.map((m: any) => ({
        id: m.id,
        date: m.move_date,
        from: m.from_location || null,
        to: m.to_location || null,
        reason: m.reason || null,
        movedBy: m.moved_by || null,
      })),
      // All allocations (not just the latest) for full flow view
      allocations: allocList.map((al: any) => ({
        id: al.id,
        type: al.allocation_type,
        property: al.properties?.property_name || null,
        apartment: al.apartments?.apartment_code || null,
        bed: al.beds?.bed_code || null,
        date: al.allocated_date || al.created_at || null,
      })),
    };
  },
});

// ─── ASSET PAYMENTS ───────────────────────────────────────────────────────────
export const listAssetPayments = action({
  args: { assetId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { assetId }) => {
    const sb = getSupabase();
    const rows = await safeList(
      sb.from("asset_payments")
        .select("*, vendors(vendor_name)")
        .eq("asset_id", assetId)
        .eq("organization_id", ORG_ID)
        .order("payment_date", { ascending: false })
    );
    return rows.map((p: any) => ({
      id: p.id,
      assetId: p.asset_id,
      date: p.payment_date,
      amount: Number(p.amount) || 0,
      mode: p.payment_mode || null,
      reference: p.reference_number || null,
      vendorId: p.vendor_id || null,
      vendor: (p.vendors as any)?.vendor_name || null,
      bankAccountId: p.bank_account_id || null,
      proofUrl: p.payment_proof_url || null,
      notes: p.notes || null,
    }));
  },
});

export const recordAssetPayment = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data: args }) => {
    const sb = getSupabase();
    const { data: row, error } = await sb.from("asset_payments").insert({
      organization_id:   ORG_ID,
      asset_id:          args.assetId,
      vendor_id:         args.vendorId || null,
      payment_date:      args.paymentDate,
      amount:            args.amount,
      payment_mode:      args.paymentMode || null,
      bank_account_id:   args.bankAccountId || null,
      reference_number:  args.referenceNumber || null,
      payment_proof_url: args.proofUrl || null,
      notes:             args.notes || null,
    }).select().single();
    if (error) throw new Error(`Record payment failed: ${error.message}`);
    return row;
  },
});

export const deleteAssetPayment = action({
  args: { paymentId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { paymentId }) => {
    const sb = getSupabase();
    const { error } = await sb.from("asset_payments").delete().eq("id", paymentId).eq("organization_id", ORG_ID);
    if (error) throw new Error(`Delete payment failed: ${error.message}`);
    return { success: true };
  },
});

// ─── ASSET PAYMENT STATUS (view) — exact web parity ───────────────────────────
// Queries v_asset_payment_status (the same view the web AssetPaymentsTab uses).
// Returns per-asset rows with balance_due / total_paid / status / vendor / invoice.
export const listAssetPaymentStatus = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rows = await fetchAllPages((from, to) =>
      sb.from("v_asset_payment_status")
        .select("asset_id, asset_code, vendor_name, supplier_id, invoice_number, invoice_date, purchase_date, purchase_price, total_paid, balance_due, payment_count, last_payment_date, status")
        .eq("organization_id", ORG_ID)
        .order("purchase_date", { ascending: false })
        .range(from, to)
    );
    return rows.map((r: any) => ({
      assetId: r.asset_id,
      assetCode: r.asset_code || "",
      vendorName: r.vendor_name || null,
      supplierId: r.supplier_id || null,
      invoiceNumber: r.invoice_number || null,
      invoiceDate: r.invoice_date || null,
      purchaseDate: r.purchase_date || null,
      purchasePrice: Number(r.purchase_price) || 0,
      totalPaid: Number(r.total_paid) || 0,
      balanceDue: Number(r.balance_due) || 0,
      paymentCount: Number(r.payment_count) || 0,
      lastPaymentDate: r.last_payment_date || null,
      status: r.status || "unpaid",
    }));
  },
});

// ─── BANK ACCOUNTS (for payment mode selection) ───────────────────────────────
export const listAssetBankAccounts = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rows = await safeList(
      sb.from("organization_bank_accounts")
        .select("id, bank_name, account_number, ifsc_code, is_primary, status")
        .eq("organization_id", ORG_ID)
        .eq("status", "active")
        .order("is_primary", { ascending: false })
    );
    return rows.map((b: any) => ({
      id: b.id,
      bankName: b.bank_name || "Bank",
      accountNumber: b.account_number || "",
      ifsc: b.ifsc_code || "",
      isPrimary: !!b.is_primary,
    }));
  },
});

// ─── ASSET MOVEMENTS (flow / transfer history) ────────────────────────────────
export const listAssetMovements = action({
  args: { assetId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { assetId }) => {
    const sb = getSupabase();
    const rows = await safeList(
      sb.from("asset_movements")
        .select("*")
        .eq("asset_id", assetId)
        .eq("organization_id", ORG_ID)
        .order("move_date", { ascending: false })
    );
    return rows.map((m: any) => ({
      id: m.id,
      assetId: m.asset_id,
      date: m.move_date,
      from: m.from_location || null,
      to: m.to_location || null,
      reason: m.reason || null,
      movedBy: m.moved_by || null,
    }));
  },
});

export const recordAssetMovement = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data: args }) => {
    const sb = getSupabase();
    const { data: row, error } = await sb.from("asset_movements").insert({
      organization_id: ORG_ID,
      asset_id:        args.assetId,
      move_date:       args.moveDate,
      from_location:   args.fromLocation || null,
      to_location:     args.toLocation || null,
      reason:          args.reason || null,
      moved_by:        args.movedBy || null,
    }).select().single();
    if (error) throw new Error(`Record movement failed: ${error.message}`);
    return row;
  },
});

// ─── ASSET TYPE: UPDATE / DELETE ──────────────────────────────────────────────
export const updateAssetType = action({
  args: { typeId: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { typeId, data: args }) => {
    const update: Record<string, any> = {};
    if (args.name !== undefined) update.name = args.name;
    if (args.categoryId !== undefined) update.category_id = args.categoryId;
    if (args.expectedLifeMonths !== undefined) update.expected_life_months = args.expectedLifeMonths;
    if (args.replacementCostEstimate !== undefined) update.replacement_cost_estimate = args.replacementCostEstimate;
    if (Object.keys(update).length > 0) await updateRow("asset_types", typeId, update);
    return { success: true };
  },
});

export const deleteAssetType = action({
  args: { typeId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { typeId }) => {
    const sb = getSupabase();
    // Guard: block delete if any asset still uses this type (mirrors web safety)
    const inUse = await safeList(
      sb.from("assets").select("id").eq("asset_type_id", typeId).eq("organization_id", ORG_ID).limit(1)
    );
    if (inUse.length > 0) throw new Error("Cannot delete: assets still use this type. Reassign or delete them first.");
    const { error } = await sb.from("asset_types").delete().eq("id", typeId).eq("organization_id", ORG_ID);
    if (error) throw new Error(`Delete type failed: ${error.message}`);
    return { success: true };
  },
});

// ─── ASSET BRANDS ─────────────────────────────────────────────────────────────
export const listBrands = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rows = await safeList(
      sb.from("asset_brands").select("id, name").eq("organization_id", ORG_ID).order("name")
    );
    return rows.map((b: any) => ({ id: b.id, name: b.name }));
  },
});
export const createBrand = action({
  args: { name: v.string() },
  returns: v.any(),
  handler: async (_ctx, { name }) => {
    const sb = getSupabase();
    const { data, error } = await sb.from("asset_brands").insert({ name, organization_id: ORG_ID }).select().single();
    if (error) throw new Error(`Create brand failed: ${error.message}`);
    return data;
  },
});

// ─── VENDOR REMARKS ───────────────────────────────────────────────────────────
export const listVendorRemarks = action({
  args: { vendorId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { vendorId }) => {
    const sb = getSupabase();
    const rows = await safeList(
      sb.from("vendor_remarks").select("*").eq("vendor_id", vendorId).eq("organization_id", ORG_ID).order("created_at", { ascending: false })
    );
    return rows;
  },
});
export const addVendorRemark = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data: args }) => {
    const sb = getSupabase();
    const { data, error } = await sb.from("vendor_remarks").insert({
      vendor_id: args.vendorId,
      remark_type: args.remark_type || "neutral",
      severity: args.severity || "medium",
      title: args.title,
      description: args.description || null,
      organization_id: ORG_ID,
    }).select().single();
    if (error) throw new Error(`Add remark failed: ${error.message}`);
    return data;
  },
});

// ─── REPLACEMENT FORECASTS ────────────────────────────────────────────────────
export const listForecasts = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rows = await safeList(
      sb.from("replacement_forecasts")
        .select("id, asset_id, expected_replacement_date, replacement_cost, urgency_level")
        .eq("organization_id", ORG_ID)
        .order("expected_replacement_date", { ascending: true })
    );
    if (!rows.length) return [];
    // Stitch asset code + type name (no embed, to avoid silent join failures)
    const assetIds = [...new Set(rows.map((r: any) => r.asset_id).filter(Boolean))];
    const assetsRows = assetIds.length ? await safeList(
      sb.from("assets").select("id, asset_code, asset_type_id").in("id", assetIds)
    ) : [];
    const typeIds = [...new Set((assetsRows as any[]).map((a: any) => a.asset_type_id).filter(Boolean))];
    const typeRows = typeIds.length ? await safeList(sb.from("asset_types").select("id, name").in("id", typeIds)) : [];
    const typeMap = Object.fromEntries((typeRows as any[]).map((t: any) => [t.id, t.name]));
    const assetMap = Object.fromEntries((assetsRows as any[]).map((a: any) => [a.id, { code: a.asset_code, type: typeMap[a.asset_type_id] || null }]));
    return rows.map((r: any) => ({
      id: r.id,
      assetCode: assetMap[r.asset_id]?.code || null,
      typeName: assetMap[r.asset_id]?.type || null,
      expectedReplacementDate: r.expected_replacement_date,
      replacementCost: Number(r.replacement_cost) || 0,
      urgency: r.urgency_level || null,
    }));
  },
});

// ─── Maintenance tickets grouped by asset (web AssetMaintenanceTab parity) ─────
// Returns a flat, enriched ticket list (only tickets linked to an asset);
// the client groups by asset_id to build per-asset ticket lists + KPIs.
export const listAssetMaintenance = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const [tickets, resolutions, issueTypes] = await Promise.all([
      fetchAllPages((from, to) =>
        sb.from("maintenance_tickets")
          .select("id, ticket_number, asset_id, issue_type_id, status, created_at, resolved_at, closed_at, closure_cost")
          .eq("organization_id", ORG_ID)
          .not("asset_id", "is", null)
          .range(from, to)),
      fetchAllPages((from, to) =>
        sb.from("ticket_resolutions")
          .select("ticket_id, resolution_type, service_type, total_cost, closure_summary, resolved_at")
          .range(from, to)),
      fetchAllPages((from, to) =>
        sb.from("issue_types").select("id, name").eq("organization_id", ORG_ID).range(from, to)),
    ]);
    const resByTicket: Record<string, any> = {};
    for (const r of resolutions || []) resByTicket[r.ticket_id] = r;
    const typeName: Record<string, string> = {};
    for (const t of issueTypes || []) typeName[t.id] = t.name;
    return (tickets || []).map((t: any) => {
      const res = resByTicket[t.id];
      return {
        id: t.id,
        asset_id: t.asset_id,
        ticket_number: t.ticket_number || null,
        status: t.status || null,
        created_at: t.created_at || null,
        resolved_at: t.resolved_at || t.closed_at || null,
        issue_type: (t.issue_type_id && typeName[t.issue_type_id]) || null,
        closure_cost: t.closure_cost ?? (res?.total_cost ?? null),
        resolution_type: res?.resolution_type || null,
        service_type: res?.service_type || null,
        closure_summary: res?.closure_summary || null,
      };
    });
  },
});
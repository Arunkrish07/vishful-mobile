"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import {
  getSupabase, ORG_ID, safeList, insertRow, updateRow, deleteRow,
} from "./lib/supabaseAdmin";
import { filterLiveBeds } from "./metrics";

// ─── LIST PROPERTIES (ENRICHED) ───────────────────────────────────────
export const listProperties = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const [properties, apartments, beds] = await Promise.all([
      safeList(sb.from("properties").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false })),
      safeList(sb.from("apartments").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("beds").select("*").eq("organization_id", ORG_ID)),
    ]);
    // Canonical live beds (bed.status Live AND apartment.status Live) — web parity.
    const liveBeds = filterLiveBeds(beds, apartments);
    return properties.map((p: any) => {
      const propAptIds = apartments.filter((a: any) => a.property_id === p.id).map((a: any) => a.id);
      const propAptIdSet = new Set(propAptIds);
      return {
        _id: p.id, id: p.id, _creationTime: p.created_at ? new Date(p.created_at).getTime() : 0,
        code: p.code || "", name: p.property_name || p.name || "",
        property_name: p.property_name || p.name || "",   // ← ElectricityScreen uses this
        address: p.address || undefined, city: p.city || undefined,
        status: p.status || "live",
        apartmentCount: propAptIds.length,
        bedCount: beds.filter((b: any) => propAptIds.includes(b.apartment_id)).length,
        liveBedCount: liveBeds.filter((b: any) => propAptIdSet.has(b.apartment_id)).length,
      };
    });
  },
});

export const createProperty = action({
  args: { name: v.string(), address: v.optional(v.string()), city: v.optional(v.string()), status: v.string() },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    const existing = await safeList(sb.from("properties").select("id").eq("organization_id", ORG_ID));
    const code = `PROP-${String(existing.length + 1).padStart(3, "0")}`;
    const row = await insertRow("properties", {
      code, name: args.name, property_name: args.name,
      address: args.address || null, city: args.city || null, status: args.status,
    });
    return row.id;
  },
});

export const updateProperty = action({
  args: { id: v.string(), updates: v.any() },
  returns: v.any(),
  handler: async (_ctx, { id, updates }) => {
    const filtered: Record<string, any> = {};
    for (const [k, val] of Object.entries(updates)) {
      if (val !== undefined) filtered[k] = val;
    }
    if (Object.keys(filtered).length > 0) await updateRow("properties", id, filtered);
    return { success: true };
  },
});

export const removeProperty = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    await deleteRow("properties", id);
    return { success: true };
  },
});

// ─── APARTMENTS ──────────────────────────────────────────────────────
export const listApartments = action({
  args: { propertyId: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, { propertyId }) => {
    const sb = getSupabase();
    let aptQ = sb.from("apartments").select("*").eq("organization_id", ORG_ID);
    if (propertyId) aptQ = aptQ.eq("property_id", propertyId);
    aptQ = aptQ.order("created_at", { ascending: false });

    const [apartments, properties, beds] = await Promise.all([
      safeList(aptQ),
      safeList(sb.from("properties").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("beds").select("*").eq("organization_id", ORG_ID)),
    ]);
    const propMap: Record<string, string> = {};
    properties.forEach((p: any) => { propMap[p.id] = p.property_name || p.name || p.code || "Unknown"; });

    return apartments.map((a: any) => {
      const aptBeds = beds.filter((b: any) => b.apartment_id === a.id);
      return {
        _id: a.id, _creationTime: a.created_at ? new Date(a.created_at).getTime() : 0,
        propertyId: a.property_id, propertyName: propMap[a.property_id] || "Unknown",
        code: a.apartment_code || a.code || "", name: a.apartment_code || a.code || "",
        floor: a.floor_number || a.floor || undefined, label: a.label || a.gender_allowed || undefined,
        type: a.apartment_type || undefined, sizeSqft: a.size_sqft || undefined,
        genderAllowed: a.gender_allowed || a.label || undefined, status: a.status || "live",
        // Raw fields for the mobile edit form (EB / tax / contract dates)
        signing_date: a.signing_date ?? undefined,
        start_date: a.start_date ?? undefined,
        end_date: a.end_date ?? undefined,
        eb_card_number: a.eb_card_number ?? undefined,
        eb_consumer_number: a.eb_consumer_number ?? undefined,
        eb_connection_type: a.eb_connection_type ?? undefined,
        property_tax_id: a.property_tax_id ?? undefined,
        property_tax_amount: a.property_tax_amount ?? undefined,
        water_tax_id: a.water_tax_id ?? undefined,
        water_tax_amount: a.water_tax_amount ?? undefined,
        bedCount: aptBeds.length,
        occupiedBeds: aptBeds.filter((b: any) => ["staying","occupied","on-notice","notice","booked","onboarding","booking"].includes((b.bed_lifecycle_status || "").toLowerCase())).length,
        liveBeds: aptBeds.filter((b: any) => (b.status || "").toLowerCase() === "live").length,
      };
    });
  },
});

export const createApartment = action({
  args: { propertyId: v.string(), name: v.string(), floor: v.optional(v.string()), status: v.string(), data: v.optional(v.any()) },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    const props = await safeList(sb.from("properties").select("code").eq("id", args.propertyId).eq("organization_id", ORG_ID));
    if (!props.length) throw new Error("Property not found");
    const d = args.data || {};
    // Use provided apartment_code or auto-generate
    let code = d.apartment_code || "";
    if (!code) {
      const existingApts = await safeList(sb.from("apartments").select("id").eq("property_id", args.propertyId).eq("organization_id", ORG_ID));
      code = `${props[0].code}-${String(existingApts.length + 1).padStart(2, "0")}`;
    }
    const row = await insertRow("apartments", {
      property_id: args.propertyId,
      apartment_code: code,
      floor_number: d.floor_number ? parseInt(d.floor_number) : (args.floor ? parseInt(args.floor) : null),
      status: d.status || args.status,
      apartment_type: d.apartment_type || null,
      size_sqft: d.size_sqft ? parseFloat(d.size_sqft) : null,
      gender_allowed: d.gender_allowed || null,
      signing_date: d.signing_date || null,
      start_date: d.start_date || null,
      end_date: d.end_date || null,
      eb_card_number: d.eb_card_number || null,
      eb_consumer_number: d.eb_consumer_number || null,
      eb_connection_type: d.eb_connection_type || null,
      eb_sanctioned_load: d.eb_sanctioned_load ? parseFloat(d.eb_sanctioned_load) : null,
      property_tax_id: d.property_tax_id || null,
      property_tax_amount: d.property_tax_amount ? parseFloat(d.property_tax_amount) : null,
      water_tax_id: d.water_tax_id || null,
      water_tax_amount: d.water_tax_amount ? parseFloat(d.water_tax_amount) : null,
    });
    return row.id;
  },
});

// ─── BEDS ────────────────────────────────────────────────────────────
export const listBeds = action({
  args: { apartmentId: v.optional(v.string()), propertyId: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    const today = new Date().toISOString().split("T")[0];
    let bedQ = sb.from("beds").select("*").eq("organization_id", ORG_ID);
    if (args.apartmentId) bedQ = bedQ.eq("apartment_id", args.apartmentId);
    bedQ = bedQ.order("created_at", { ascending: false });

    const [beds, properties, apartments, allotments, tenants, bedRates] = await Promise.all([
      safeList(bedQ),
      safeList(sb.from("properties").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("apartments").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("tenant_allotments").select("*").eq("organization_id", ORG_ID).in("staying_status", ["Staying", "On-Notice", "Booked"])),
      safeList(sb.from("tenants").select("*").eq("organization_id", ORG_ID)),
      safeList(sb.from("bed_rates").select("*").eq("organization_id", ORG_ID)),
    ]);

    let filteredBeds = beds;
    if (!args.apartmentId && args.propertyId) {
      const propAptIds = apartments.filter((a: any) => a.property_id === args.propertyId).map((a: any) => a.id);
      filteredBeds = beds.filter((b: any) => propAptIds.includes(b.apartment_id));
    }

    const propMap: Record<string, string> = {};
    properties.forEach((p: any) => { propMap[p.id] = p.property_name || p.name || p.code || "Unknown"; });
    const aptMap: Record<string, string> = {};
    apartments.forEach((a: any) => { aptMap[a.id] = a.apartment_code || a.code || "Unknown"; });
    const aptToPropId: Record<string, string> = {};
    apartments.forEach((a: any) => { aptToPropId[a.id] = a.property_id; });
    const tenantMap: Record<string, string> = {};
    tenants.forEach((t: any) => { tenantMap[t.id] = t.name || t.full_name || ""; });

    const getCurrentRate = (propertyId: string, bedType: string, toiletType: string): number | null => {
      if (!propertyId || !bedType || !toiletType) return null;
      const match = bedRates.find((r: any) =>
        r.property_id === propertyId &&
        (r.bed_type || "").toLowerCase() === bedType.toLowerCase() &&
        (r.toilet_type || "").toLowerCase() === toiletType.toLowerCase() &&
        r.from_date <= today && r.to_date >= today
      );
      return match ? Number(match.monthly_rate) : null;
    };

    return filteredBeds.map((b: any) => {
      const propId = aptToPropId[b.apartment_id] || "";
      const currentRate = propId ? getCurrentRate(propId, b.bed_type || "", b.toilet_type || "") : null;
      const stay = allotments.find((s: any) => s.bed_id === b.id);
      // bed_lifecycle_status is the source of truth — written on every lifecycle event
      const rawStatus = (b.bed_lifecycle_status || "vacant").toLowerCase().trim();
      const bedStatus = (rawStatus === "staying" || rawStatus === "occupied")
                      ? "Staying"
                      : (rawStatus === "on-notice" || rawStatus === "notice")
                      ? "On-Notice"
                      : (rawStatus === "booked" || rawStatus === "onboarding" || rawStatus === "booking")
                      ? "Booked"
                      : rawStatus === "exited"
                      ? "Exited"
                      : "vacant";
      const isOccupied = ["Staying", "On-Notice", "Booked"].includes(bedStatus);
      return {
        _id: b.id, _creationTime: b.created_at ? new Date(b.created_at).getTime() : 0,
        propertyId: propId, apartmentId: b.apartment_id,
        propertyName: propMap[propId] || "Unknown", apartmentName: aptMap[b.apartment_id] || "Unknown",
        code: b.bed_code || "", type: b.bed_type || "Single", toiletType: b.toilet_type || "Common",
        monthlyRent: currentRate || 0, currentRate, hasActiveRate: currentRate !== null,
        status: b.status || "live", isOccupied, bedStatus,
        tenantName: stay ? (tenantMap[stay.tenant_id] || undefined) : undefined,
        tenantId: stay ? stay.tenant_id : undefined,
        allotmentId: stay ? stay.id : undefined,
      };
    });
  },
});

export const createBed = action({
  args: {
    propertyId: v.string(), apartmentId: v.string(), type: v.string(),
    toiletType: v.string(), monthlyRent: v.number(), status: v.string(),
    unitNumber: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    const apts = await safeList(sb.from("apartments").select("apartment_code,code").eq("id", args.apartmentId).eq("organization_id", ORG_ID));
    if (!apts.length) throw new Error("Apartment not found");
    let bedCode: string;
    if (args.unitNumber && args.unitNumber.trim()) {
      // User-specified unit number — use directly as bed_code
      bedCode = args.unitNumber.trim();
    } else {
      // Auto-generate from apartment code
      const existingBeds = await safeList(sb.from("beds").select("id").eq("apartment_id", args.apartmentId).eq("organization_id", ORG_ID));
      const aptCode = apts[0].apartment_code || apts[0].code || "APT";
      bedCode = `${aptCode}-B${String(existingBeds.length + 1).padStart(2, "0")}`;
    }
    const row = await insertRow("beds", {
      apartment_id: args.apartmentId, bed_code: bedCode,
      bed_type: args.type, toilet_type: args.toiletType, status: args.status,
    });
    return row.id;
  },
});

export const updateBed = action({
  args: { id: v.string(), updates: v.any() },
  returns: v.any(),
  handler: async (_ctx, { id, updates }) => {
    const filtered: Record<string, any> = {};
    for (const [k, val] of Object.entries(updates as Record<string, any>)) {
      if (val !== undefined) filtered[k] = val;
    }
    if (Object.keys(filtered).length > 0) await updateRow("beds", id, filtered);
    return { success: true };
  },
});

export const deleteApartment = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    await deleteRow("apartments", id);
    return { success: true };
  },
});

export const deleteBed = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    await deleteRow("beds", id);
    return { success: true };
  },
});

export const updateApartment = action({
  args: { id: v.string(), updates: v.any() },
  returns: v.any(),
  handler: async (_ctx, { id, updates }) => {
    const filtered: Record<string, any> = {};
    for (const [k, val] of Object.entries(updates as Record<string, any>)) {
      if (val !== undefined) filtered[k] = val;
    }
    if (Object.keys(filtered).length > 0) await updateRow("apartments", id, filtered);
    return { success: true };
  },
});

// ─── BULK IMPORT ─────────────────────────────────────────────────────────────

export const bulkImportProperties = action({
  args: { rows: v.any() },
  returns: v.any(),
  handler: async (_ctx, { rows }) => {
    const sb = getSupabase();
    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Fetch existing property names for skip-detection
    const existing = await safeList(
      sb.from("properties").select("property_name").eq("organization_id", ORG_ID)
    );
    const existingNames = new Set(
      existing.map((p: any) => (p.property_name || "").toLowerCase().trim())
    );

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const name = (row.name || "").trim();
      if (!name) { errors.push(`Row ${i + 2}: Property Name is required`); continue; }

      if (existingNames.has(name.toLowerCase())) {
        skipped++;
        continue;
      }

      try {
        await insertRow("properties", {
          organization_id: ORG_ID,
          property_name:   name,
          address:         row.address  || null,
          city:            row.city     || null,
          status:          row.status   || "live",
          code:            name.replace(/\s+/g, "_").toUpperCase().slice(0, 20),
        });
        existingNames.add(name.toLowerCase());
        created++;
      } catch (e: any) {
        errors.push(`Row ${i + 2} (${name}): ${e.message}`);
      }
    }

    return { created, skipped, errors };
  },
});

export const bulkImportApartments = action({
  args: { rows: v.any() },
  returns: v.any(),
  handler: async (_ctx, { rows }) => {
    const sb = getSupabase();
    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Load all properties and apartments once
    const [properties, existingApts] = await Promise.all([
      safeList(sb.from("properties").select("id, property_name").eq("organization_id", ORG_ID)),
      safeList(sb.from("apartments").select("id, apartment_code, property_id").eq("organization_id", ORG_ID)),
    ]);

    const propNameMap: Record<string, string> = {};  // lowercase name → id
    properties.forEach((p: any) => {
      propNameMap[(p.property_name || "").toLowerCase().trim()] = p.id;
    });

    // existing set: "propertyId::aptCode"
    const existingSet = new Set(
      existingApts.map((a: any) => `${a.property_id}::${(a.apartment_code || "").toLowerCase()}`)
    );

    // Track how many apartments exist per property (for auto-code)
    const aptCountPerProp: Record<string, number> = {};
    existingApts.forEach((a: any) => {
      aptCountPerProp[a.property_id] = (aptCountPerProp[a.property_id] || 0) + 1;
    });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const propName = (row.propertyName || "").trim();
      const aptName  = (row.name || "").trim();

      if (!propName) { errors.push(`Row ${i + 2}: Property Name is required`); continue; }
      if (!aptName)  { errors.push(`Row ${i + 2}: Apartment Name is required`); continue; }

      const propId = propNameMap[propName.toLowerCase()];
      if (!propId) {
        errors.push(`Row ${i + 2}: Property "${propName}" not found — import properties first`);
        continue;
      }

      const key = `${propId}::${aptName.toLowerCase()}`;
      if (existingSet.has(key)) { skipped++; continue; }

      try {
        const aptCode = aptName; // use the provided name directly as the code
        await insertRow("apartments", {
          organization_id: ORG_ID,
          property_id:     propId,
          apartment_code:  aptCode,
          floor_number:    row.floor  || null,
          status:          row.status || "live",
        });
        existingSet.add(key);
        aptCountPerProp[propId] = (aptCountPerProp[propId] || 0) + 1;
        created++;
      } catch (e: any) {
        errors.push(`Row ${i + 2} (${propName} / ${aptName}): ${e.message}`);
      }
    }

    return { created, skipped, errors };
  },
});

export const bulkImportBeds = action({
  args: { rows: v.any() },
  returns: v.any(),
  handler: async (_ctx, { rows }) => {
    const sb = getSupabase();
    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    const [properties, apartments, existingBeds] = await Promise.all([
      safeList(sb.from("properties").select("id, property_name").eq("organization_id", ORG_ID)),
      safeList(sb.from("apartments").select("id, apartment_code, property_id").eq("organization_id", ORG_ID)),
      safeList(sb.from("beds").select("id, bed_code, apartment_id").eq("organization_id", ORG_ID)),
    ]);

    const propNameMap: Record<string, string> = {};
    properties.forEach((p: any) => {
      propNameMap[(p.property_name || "").toLowerCase().trim()] = p.id;
    });

    // "propertyId::aptCode" → aptId
    const aptLookup: Record<string, string> = {};
    apartments.forEach((a: any) => {
      const propId = a.property_id;
      const key = `${propId}::${(a.apartment_code || "").toLowerCase()}`;
      aptLookup[key] = a.id;
    });

    // Count existing beds per apartment for code generation
    const bedCountPerApt: Record<string, number> = {};
    existingBeds.forEach((b: any) => {
      bedCountPerApt[b.apartment_id] = (bedCountPerApt[b.apartment_id] || 0) + 1;
    });

    // existing bed codes per apartment: "aptId::bedCode"
    const existingBedSet = new Set(
      existingBeds.map((b: any) => `${b.apartment_id}::${(b.bed_code || "").toLowerCase()}`)
    );

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const propName  = (row.propertyName  || "").trim();
      const aptName   = (row.apartmentName || "").trim();
      const bedType   = (row.bedType       || "single").trim().toLowerCase();
      const toiletType = (row.toiletType   || "common").trim().toLowerCase();
      const monthlyRent = Number(row.monthlyRent) || 0;

      if (!propName) { errors.push(`Row ${i + 2}: Property Name is required`); continue; }
      if (!aptName)  { errors.push(`Row ${i + 2}: Apartment Name is required`); continue; }

      const propId = propNameMap[propName.toLowerCase()];
      if (!propId) {
        errors.push(`Row ${i + 2}: Property "${propName}" not found`);
        continue;
      }

      const aptKey = `${propId}::${aptName.toLowerCase()}`;
      const aptId  = aptLookup[aptKey];
      if (!aptId) {
        errors.push(`Row ${i + 2}: Apartment "${aptName}" not found in "${propName}"`);
        continue;
      }

      // Auto-generate bed code: APT_CODE-B01, B02, ...
      const aptCode = apartments.find((a: any) => a.id === aptId)?.apartment_code || aptName;
      const bedNum  = (bedCountPerApt[aptId] || 0) + 1;
      const bedCode = `${aptCode}-B${String(bedNum).padStart(2, "0")}`;

      const existKey = `${aptId}::${bedCode.toLowerCase()}`;
      if (existingBedSet.has(existKey)) { skipped++; continue; }

      try {
        await insertRow("beds", {
          organization_id:      ORG_ID,
          apartment_id:         aptId,
          bed_code:             bedCode,
          bed_type:             bedType,
          toilet_type:          toiletType,
          status:               row.status || "live",
          bed_lifecycle_status: "Vacant",
        });
        existingBedSet.add(existKey);
        bedCountPerApt[aptId] = bedNum;
        created++;
      } catch (e: any) {
        errors.push(`Row ${i + 2} (${propName}/${aptName}): ${e.message}`);
      }
    }

    return { created, skipped, errors };
  },
});
// ─── PROPERTY PERFORMANCE DATA ───────────────────────────────────────────────
// Fetches allotments + tickets for a property so the mobile app can compute
// apartment star ratings, occupancy, and discrepancies — mirrors web Properties.tsx.

export const getPropertyPerformanceData = action({
  args: { propertyId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { propertyId }) => {
    const sb = getSupabase();

    const [allotments, tickets, apartments, beds, invoices, property] = await Promise.all([
      // All allotments for this property (incl. Exited — needed for occupancy history)
      safeList(
        sb.from("tenant_allotments")
          .select("id, tenant_id, bed_id, apartment_id, property_id, staying_status, onboarding_date, actual_exit_date, estimated_exit_date, notice_date, monthly_rental, tenants(full_name,phone)")
          .eq("organization_id", ORG_ID)
          .eq("property_id", propertyId)
          .not("onboarding_date", "is", null)
      ),
      // All tickets for this property (for ticket-share score)
      safeList(
        sb.from("maintenance_tickets")
          .select("id, apartment_id, created_at, status")
          .eq("organization_id", ORG_ID)
          .eq("property_id", propertyId)
      ),
      // Apartments with start_date + end_date for occupancy inception + contract expiry
      safeList(
        sb.from("apartments")
          .select("id, apartment_code, status, end_date, start_date, floor_number")
          .eq("organization_id", ORG_ID)
          .eq("property_id", propertyId)
      ),
      // Beds for this property
      safeList(
        sb.from("beds")
          .select("id, apartment_id, bed_type, toilet_type, status, bed_lifecycle_status")
          .eq("organization_id", ORG_ID)
      ),
      // Invoices for revenue realization
      safeList(
        sb.from("invoices")
          .select("id, bed_id, apartment_id, total_amount, rent_amount, billing_month, status, property_id")
          .eq("organization_id", ORG_ID)
          .eq("property_id", propertyId)
      ),
      // Property itself — for start_date (inception) and kyc_qr_code
      sb.from("properties")
        .select("id, property_name, start_date, kyc_qr_code, address, city")
        .eq("id", propertyId)
        .eq("organization_id", ORG_ID)
        .single()
        .then(r => r.data)
        .catch(() => null),
    ]);

    // Filter beds to only those belonging to this property's apartments
    const aptIds = new Set(apartments.map((a: any) => a.id));
    const propBeds = beds.filter((b: any) => aptIds.has(b.apartment_id));

    return { allotments, tickets, apartments, beds: propBeds, invoices, property };
  },
});

// ─── BED HISTORY ─────────────────────────────────────────────────────────────
// Mirrors web BedHistoryDialog — fetches all allotments + invoice revenue for a bed.

export const getBedHistory = action({
  args: { bedId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { bedId }) => {
    const sb = getSupabase();
    const [allotments, invoices] = await Promise.all([
      safeList(
        sb.from("tenant_allotments")
          .select("id, tenant_id, onboarding_date, actual_exit_date, staying_status, tenants(full_name, phone)")
          .eq("bed_id", bedId)
          .eq("organization_id", ORG_ID)
          .order("onboarding_date", { ascending: true })
      ),
      safeList(
        sb.from("invoices")
          .select("amount_paid, tenant_id")
          .eq("bed_id", bedId)
          .eq("organization_id", ORG_ID)
      ),
    ]);
    return { allotments, invoices };
  },
});

// ─── PROPERTY IMAGES ─────────────────────────────────────────────────────────
// Uses the property_images table created by the web-app migration.

export const listPropertyImages = action({
  args: { propertyId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { propertyId }) => {
    const sb = getSupabase();
    return safeList(
      sb.from("property_images")
        .select("*")
        .eq("property_id", propertyId)
        .order("display_order", { ascending: true })
    );
  },
});

export const addPropertyImage = action({
  args: {
    propertyId: v.string(),
    imageUrl:   v.string(),
    caption:    v.optional(v.string()),
    isCover:    v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    // Get current max display_order
    const existing = await safeList(
      sb.from("property_images").select("display_order").eq("property_id", args.propertyId)
    );
    const maxOrder = existing.reduce((m: number, r: any) => Math.max(m, r.display_order ?? -1), -1);
    const row = await insertRow("property_images", {
      property_id:    args.propertyId,
      image_url:      args.imageUrl,
      caption:        args.caption ?? null,
      display_order:  maxOrder + 1,
      is_cover:       args.isCover ?? (existing.length === 0),
    });
    return row.id;
  },
});

export const deletePropertyImage = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    await deleteRow("property_images", id);
    return { success: true };
  },
});

export const setPropertyImageCover = action({
  args: { id: v.string(), propertyId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id, propertyId }) => {
    const sb = getSupabase();
    // Unset all covers for this property
    await sb.from("property_images").update({ is_cover: false }).eq("property_id", propertyId);
    // Set chosen image as cover
    const { error } = await sb.from("property_images").update({ is_cover: true }).eq("id", id);
    if (error) throw new Error(error.message);
    return { success: true };
  },
});
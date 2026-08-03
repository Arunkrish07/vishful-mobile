"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { getSupabase, ORG_ID, safeList } from "./lib/supabaseAdmin";

// ─── LIST OWNERS with contract + property info ────────────────────────────────
export const listOwners = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();

    // Fetch owners for this org
    const owners = await safeList(
      sb.from("owners")
        .select("id, full_name, phone, email, pan_number, aadhar_number, address, city, state, pincode, bank_name, bank_account_number, bank_ifsc, gst_number, notes, photo_url, id_proof_url, created_at")
        .eq("organization_id", ORG_ID)
        .order("created_at", { ascending: false })
    );

    if (!owners.length) return [];

    // Fetch ALL contracts (any status) for card enrichment + property filter (mirrors web)
    const ownerIds = owners.map((o: any) => o.id);
    const contracts = await safeList(
      sb.from("owner_contracts")
        .select("id, owner_id, contract_type, start_date, end_date, monthly_rent, status, apartment_id, apartments(apartment_code, property_id, properties(property_name))")
        .in("owner_id", ownerIds)
        .order("start_date", { ascending: false })
    );

    const today = new Date();
    const isExpired = (endDate: string | null) => {
      if (!endDate) return false;
      try { return new Date(endDate) < today; } catch { return false; }
    };
    // An "active" contract = not expired and not inactive (web rule)
    const isActiveContract = (c: any) =>
      !isExpired(c.end_date) && String(c.status || "").toLowerCase() !== "inactive";

    // Group contracts by owner_id
    const contractsByOwner: Record<string, any[]> = {};
    for (const c of contracts) {
      if (!contractsByOwner[c.owner_id]) contractsByOwner[c.owner_id] = [];
      contractsByOwner[c.owner_id].push(c);
    }

    return owners.map((o: any) => {
      const ownerContracts = contractsByOwner[o.id] || [];
      // Prefer an active contract; fall back to most recent for display
      const activeContract = ownerContracts.find(isActiveContract) || null;
      return {
        id:               o.id,
        name:             o.full_name || "—",
        phone:            o.phone      || "",
        email:            o.email      || null,
        panNumber:        o.pan_number || null,
        aadharNumber:     o.aadhar_number || null,
        address:          o.address    || null,
        city:             o.city       || null,
        state:            o.state      || null,
        pincode:          o.pincode    || null,
        bankName:         o.bank_name  || null,
        bankAccountNumber:o.bank_account_number || null,
        bankIfsc:         o.bank_ifsc  || null,
        gstNumber:        o.gst_number || null,
        notes:            o.notes      || null,
        photoUrl:         o.photo_url  || null,
        contractCount:    ownerContracts.length,
        activeContract:   activeContract ? {
          id:            activeContract.id,
          contractType:  activeContract.contract_type,
          startDate:     activeContract.start_date,
          endDate:       activeContract.end_date,
          monthlyRent:   Number(activeContract.monthly_rent) || 0,
          status:        activeContract.status,
          apartmentCode: activeContract.apartments?.apartment_code || null,
          propertyId:    activeContract.apartments?.property_id || null,
          propertyName:  activeContract.apartments?.properties?.property_name || null,
        } : null,
        // All contract property ids (for property filter)
        propertyIds: ownerContracts.map((c: any) => c.apartments?.property_id).filter(Boolean),
      };
    });
  },
});

// ─── GET OWNER DETAIL (contracts + payments) ─────────────────────────────────
export const getOwnerDetail = action({
  args: { ownerId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { ownerId }) => {
    const sb = getSupabase();

    const [ownerRows, contracts] = await Promise.all([
      safeList(sb.from("owners").select("id, full_name, phone, email, pan_number, aadhar_number, address, city, state, pincode, bank_name, bank_account_number, bank_ifsc, gst_number, notes, photo_url, id_proof_url, status").eq("id", ownerId).eq("organization_id", ORG_ID).limit(1)),
      safeList(
        sb.from("owner_contracts")
          .select("*, apartments(apartment_code, property_id, properties(property_name, address, city, state))")
          .eq("owner_id", ownerId)
          .order("created_at", { ascending: false })
      ),
    ]);

    const owner = ownerRows[0] || null;
    if (!owner) return null;

    return {
      owner: {
        id:                owner.id,
        name:              owner.full_name || "—",
        phone:             owner.phone || "",
        email:             owner.email || null,
        panNumber:         owner.pan_number || null,
        aadharNumber:      owner.aadhar_number || null,
        address:           owner.address || null,
        city:              owner.city || null,
        state:             owner.state || null,
        pincode:           owner.pincode || null,
        bankName:          owner.bank_name || null,
        bankAccountNumber: owner.bank_account_number || null,
        bankIfsc:          owner.bank_ifsc || null,
        gstNumber:         owner.gst_number || null,
        notes:             owner.notes || null,
        photoUrl:          owner.photo_url || null,
        idProofUrl:        owner.id_proof_url || null,
        status:            owner.status || "active",
      },
      contracts: contracts.map((c: any) => ({
        id:            c.id,
        contractType:  c.contract_type,
        startDate:     c.start_date,
        endDate:       c.end_date,
        monthlyRent:   Number(c.monthly_rent) || 0,
        status:        c.status,
        securityDeposit: Number(c.security_deposit) || 0,
        paymentDueDay: c.payment_due_day,
        apartmentCode: c.apartments?.apartment_code || null,
        propertyId:    c.apartments?.property_id || null,
        propertyName:  c.apartments?.properties?.property_name || null,
        propertyCity:  c.apartments?.properties?.city || null,
        agreementUrl:  c.agreement_url || null,
        notes:         c.notes || null,
        // Full contract terms (web parity) so the edit form pre-populates them
        // instead of nulling them on save.
        revenueSharePercentage:   c.revenue_share_percentage != null ? Number(c.revenue_share_percentage) : null,
        lockInMonths:             c.lock_in_months != null ? Number(c.lock_in_months) : null,
        escalationPercentage:     c.escalation_percentage != null ? Number(c.escalation_percentage) : null,
        escalationIntervalMonths: c.escalation_interval_months != null ? Number(c.escalation_interval_months) : null,
        rentPaidInAdvance:        !!c.rent_paid_in_advance,
        paymentSchedule:          c.payment_schedule || "monthly",
        renewalPeriods:           c.renewal_periods != null ? Number(c.renewal_periods) : null,
        gstInfo:                  c.gst_info || null,
        rentIncludesGst:          c.gst_info === "Rent Includes GST",
      })),
    };
  },
});

// ─── LIST APARTMENTS FOR CONTRACT FORM ───────────────────────────────────────
export const listApartmentsForContract = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    // All Live apartments with property name
    const apts = await safeList(
      sb.from("apartments")
        .select("id, apartment_code, property_id, status, properties(property_name)")
        .eq("organization_id", ORG_ID)
        .order("apartment_code")
    );
    // Active contracts to show which apartments are taken
    const activeCon = await safeList(
      sb.from("owner_contracts")
        .select("apartment_id, end_date, status")
        .eq("organization_id", ORG_ID)
        .in("status", ["active", "upcoming"])
    );
    const takenIds = new Set(
      activeCon
        .filter((c: any) => {
          if (!c.end_date) return true;
          return new Date(c.end_date) >= new Date();
        })
        .map((c: any) => c.apartment_id)
    );
    return apts.map((a: any) => ({
      id:            a.id,
      apartmentCode: a.apartment_code,
      propertyName:  a.properties?.property_name || "—",
      propertyId:    a.property_id,
      status:        a.status || "In-Progress",
      hasActiveContract: takenIds.has(a.id),
    })).sort((a: any, b: any) =>
      a.propertyName.localeCompare(b.propertyName) ||
      a.apartmentCode.localeCompare(b.apartmentCode, undefined, { numeric: true })
    );
  },
});

// ─── CREATE OWNER CONTRACT ────────────────────────────────────────────────────
export const createOwnerContract = action({
  args: { ownerId: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { ownerId, data }) => {
    const sb = getSupabase();

    const aptIds: string[] = data.apartment_ids || [];
    if (aptIds.length === 0) throw new Error("Select at least one apartment");

    const created: string[] = [];

    for (const aptId of aptIds) {
      // Look up apartment for property_id
      const aptRows = await safeList(
        sb.from("apartments").select("id, property_id, apartment_code").eq("id", aptId).limit(1)
      );
      const apt = aptRows[0];

      const payload: Record<string, any> = {
        organization_id:           ORG_ID,
        owner_id:                  ownerId,
        apartment_id:              aptId,
        property_id:               apt?.property_id || null,
        contract_type:             data.contract_type || "lease",
        start_date:                data.start_date || null,
        end_date:                  data.end_date   || null,
        monthly_rent:              data.monthly_rent              ? parseFloat(data.monthly_rent)              : null,
        revenue_share_percentage:  data.revenue_share_percentage  ? parseFloat(data.revenue_share_percentage)  : null,
        security_deposit:          data.security_deposit          ? parseFloat(data.security_deposit)          : null,
        lock_in_months:            data.lock_in_months            ? parseInt(data.lock_in_months)              : null,
        escalation_percentage:     data.escalation_percentage     ? parseFloat(data.escalation_percentage)     : null,
        escalation_interval_months:data.escalation_interval_months? parseInt(data.escalation_interval_months)  : null,
        payment_due_day:           parseInt(data.payment_due_day) || 1,
        rent_paid_in_advance:      !!data.rent_paid_in_advance,
        gst_info:                  data.gst_info || "GST under RCM",
        notes:                     data.notes || null,
        agreement_url:             data.agreement_url || null,
        payment_schedule:          data.payment_schedule || "monthly",
        renewal_periods:           data.renewal_periods ? parseInt(data.renewal_periods) : 0,
        renewal_date:              data.end_date ? autoRenewalDate(data.end_date) : null,
        status:                    "active",
      };

      const { data: newContract, error } = await sb
        .from("owner_contracts")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      created.push(newContract.id);

      // Auto-generate payment schedule for this contract
      try {
        const conRows = await safeList(sb.from("owner_contracts").select("*").eq("id", newContract.id).limit(1));
        const contract = conRows[0];
        if (contract) {
          const pays = generateContractPayments(contract);
          if (pays.length > 0) {
            const rows = pays.map((p) => ({
              organization_id: ORG_ID,
              owner_id:        ownerId,
              contract_id:     newContract.id,
              apartment_id:    aptId,
              payment_month:   p.month,
              bill_date:       p.billDate,
              due_date:        p.dueDate,
              actual_due_date: p.actualDueDate,
              base_amount:     p.baseAmount,
              escalated_amount:p.amount,
              status:          "pending",
            }));
            await sb.from("owner_payments").insert(rows);
          }
        }
      } catch (_) { /* schedule generation best-effort */ }

      // Sync dates back to apartment
      if (data.start_date || data.end_date) {
        await sb.from("apartments").update({
          ...(data.start_date ? { start_date: data.start_date } : {}),
          ...(data.end_date   ? { end_date:   data.end_date   } : {}),
        } as any).eq("id", aptId);
      }
    }

    return { success: true, contractIds: created };
  },
});

function autoRenewalDate(endDate: string): string | null {
  try {
    const d = new Date(endDate);
    d.setMonth(d.getMonth() - 3);
    return d.toISOString().split("T")[0];
  } catch { return null; }
}
// ═══════════════════════════════════════════════════════════════════════════════
// OWNER CRUD
// ═══════════════════════════════════════════════════════════════════════════════

export const createOwner = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    const { first_name, last_name, gender, title, ...rest } = data;  // gender/title are UI-only, not DB columns
    const fullName = `${first_name || ""} ${last_name || ""}`.trim();
    if (!fullName) throw new Error("Name is required");
    const { data: row, error } = await sb
      .from("owners")
      .insert({
        full_name:           fullName,
        phone:               rest.phone || null,
        email:               rest.email || null,
        pan_number:          rest.pan_number || null,
        aadhar_number:       rest.aadhar_number || null,
        address:             rest.address || null,
        city:                rest.city || null,
        state:               rest.state || null,
        pincode:             rest.pincode || null,
        bank_name:           rest.bank_name || null,
        bank_account_number: rest.bank_account_number || null,
        bank_ifsc:           rest.bank_ifsc || null,
        gst_number:          rest.gst_number || null,
        notes:               rest.notes || null,
        photo_url:           rest.photo_url || null,
        id_proof_url:        rest.id_proof_url || null,
        organization_id:     ORG_ID,
        status:              "active",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return row.id;
  },
});

export const updateOwner = action({
  args: { id: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { id, data }) => {
    const sb = getSupabase();
    const { first_name, last_name, gender, title, created_at, organization_id, contractCount, activeContract, status, propertyIds, ...rest } = data;  // gender/title UI-only
    const updates: Record<string, any> = {};
    if (first_name !== undefined || last_name !== undefined) {
      updates.full_name = `${first_name || ""} ${last_name || ""}`.trim();
    }
    [
      "phone", "email", "pan_number", "aadhar_number", "address", "city", "state",
      "pincode", "bank_name", "bank_account_number", "bank_ifsc", "gst_number",
      "notes", "photo_url", "id_proof_url",
    ].forEach((k) => {
      if (rest[k] !== undefined) updates[k] = rest[k] || null;
    });
    const { error } = await sb.from("owners").update(updates).eq("id", id);
    if (error) throw new Error(error.message);
    return { success: true };
  },
});

export const toggleOwnerStatus = action({
  args: { id: v.string(), currentStatus: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id, currentStatus }) => {
    const sb = getSupabase();
    const newStatus = currentStatus === "active" ? "inactive" : "active";
    const { error } = await sb.from("owners").update({ status: newStatus }).eq("id", id);
    if (error) throw new Error(error.message);
    return { status: newStatus };
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONTRACT EDIT / DELETE
// ═══════════════════════════════════════════════════════════════════════════════

export const updateContract = action({
  args: { id: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { id, data }) => {
    const sb = getSupabase();
    const payload: Record<string, any> = {
      contract_type:              data.contract_type,
      start_date:                 data.start_date || null,
      end_date:                   data.end_date || null,
      monthly_rent:               data.monthly_rent ? parseFloat(data.monthly_rent) : null,
      revenue_share_percentage:   data.revenue_share_percentage ? parseFloat(data.revenue_share_percentage) : null,
      security_deposit:           data.security_deposit ? parseFloat(data.security_deposit) : null,
      lock_in_months:             data.lock_in_months ? parseInt(data.lock_in_months) : null,
      escalation_percentage:      data.escalation_percentage ? parseFloat(data.escalation_percentage) : null,
      escalation_interval_months: data.escalation_interval_months ? parseInt(data.escalation_interval_months) : null,
      payment_due_day:            parseInt(data.payment_due_day) || 1,
      rent_paid_in_advance:       !!data.rent_paid_in_advance,
      gst_info:                   data.gst_info || "GST under RCM",
      notes:                      data.notes || null,
      payment_schedule:           data.payment_schedule || "monthly",
      renewal_periods:            data.renewal_periods ? parseInt(data.renewal_periods) : null,
      agreement_url:              data.agreement_url || null,
    };
    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);
    const { error } = await sb.from("owner_contracts").update(payload).eq("id", id);
    if (error) throw new Error(error.message);
    // Regenerate payment schedule
    await regeneratePaymentsForContract(sb, id);
    return { success: true };
  },
});

export const deleteContract = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    const sb = getSupabase();
    // delete payments first (FK)
    await sb.from("owner_payments").delete().eq("contract_id", id);
    const { error } = await sb.from("owner_contracts").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return { success: true };
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENTS — schedule generation, listing, record/edit, regenerate
// ═══════════════════════════════════════════════════════════════════════════════

// Pure port of generateOwnerContractPayments (web)
function generateContractPayments(contract: any): any[] {
  if (!contract.start_date || !contract.end_date || !contract.monthly_rent || Number(contract.monthly_rent) <= 0)
    return [];
  const payments: any[] = [];
  const start = new Date(contract.start_date);
  const end = new Date(contract.end_date);
  const baseAmount = Number(contract.monthly_rent);
  const escalationPct = Number(contract.escalation_percentage) || 0;
  const escalationInterval = Number(contract.escalation_interval_months) || 12;
  const dueDay = Math.min(Number(contract.payment_due_day) || 1, 28);
  const rentInAdvance = !!contract.rent_paid_in_advance;
  const today = new Date();

  const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
  const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };

  let current = startOfMonth(start);
  let monthIndex = 0;

  while (current <= end) {
    const billMonthForCap = rentInAdvance ? current : addMonths(current, 1);
    if (startOfMonth(billMonthForCap) > startOfMonth(today)) break;

    let amount = baseAmount;
    if (escalationPct > 0 && escalationInterval > 0 && monthIndex > 0) {
      const escalations = Math.floor(monthIndex / escalationInterval);
      amount = baseAmount * Math.pow(1 + escalationPct / 100, escalations);
    }
    amount = Math.ceil(amount);

    const y = current.getFullYear();
    const m = current.getMonth();
    const billMonth = rentInAdvance ? current : addMonths(current, 1);
    const billDateStr = `${billMonth.getFullYear()}-${String(billMonth.getMonth() + 1).padStart(2, "0")}-01`;
    const dueMonth = rentInAdvance ? current : addMonths(current, 1);
    const dueDateStr = `${dueMonth.getFullYear()}-${String(dueMonth.getMonth() + 1).padStart(2, "0")}-${String(dueDay).padStart(2, "0")}`;
    payments.push({
      month: `${y}-${String(m + 1).padStart(2, "0")}`,
      billDate: billDateStr,
      dueDate: dueDateStr,
      actualDueDate: dueDateStr,
      baseAmount,
      amount,
    });
    current = addMonths(current, 1);
    monthIndex++;
  }
  return payments;
}

// Regenerate payments for one contract, preserving paid records
async function regeneratePaymentsForContract(sb: any, contractId: string) {
  const conRows = await safeList(sb.from("owner_contracts").select("*").eq("id", contractId).limit(1));
  const contract = conRows[0];
  if (!contract) return;
  const payments = generateContractPayments(contract);
  if (payments.length === 0) return;

  const existing = await safeList(sb.from("owner_payments").select("*").eq("contract_id", contractId));
  const existingMap = new Map(existing.map((p: any) => [p.payment_month, p]));

  await sb.from("owner_payments").delete().eq("contract_id", contractId);

  const rows = payments.map((p) => {
    const prev: any = existingMap.get(p.month);
    return {
      organization_id: ORG_ID,
      owner_id:        contract.owner_id,
      contract_id:     contractId,
      apartment_id:    contract.apartment_id,
      payment_month:   p.month,
      bill_date:       p.billDate,
      due_date:        p.dueDate,
      actual_due_date: prev?.actual_due_date || p.actualDueDate,
      base_amount:     p.baseAmount,
      escalated_amount:p.amount,
      status:          prev?.status || "pending",
      paid_date:       prev?.paid_date || null,
      payment_mode:    prev?.payment_mode || null,
      notes:           prev?.notes || null,
      reference_number:prev?.reference_number || null,
    };
  });
  if (rows.length > 0) await sb.from("owner_payments").insert(rows);
}

export const getContractPayments = action({
  args: { contractId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { contractId }) => {
    const sb = getSupabase();
    return safeList(
      sb.from("owner_payments")
        .select("*")
        .eq("contract_id", contractId)
        .order("payment_month", { ascending: false })
    );
  },
});

export const listOwnerPaymentsConsolidated = action({
  args: { ownerId: v.string() },
  returns: v.any(),
  handler: async (_ctx, { ownerId }) => {
    const sb = getSupabase();
    return safeList(
      sb.from("owner_payments")
        .select("*, apartments(apartment_code), owner_contracts(contract_type)")
        .eq("owner_id", ownerId)
        .order("payment_month", { ascending: false })
    );
  },
});

export const recordOwnerPayment = action({
  args: { id: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { id, data }) => {
    const sb = getSupabase();
    if (!data.paid_date) throw new Error("Payment date is required");
    const { error } = await sb.from("owner_payments").update({
      status:           "paid",
      paid_date:        data.paid_date,
      payment_mode:     data.payment_mode || "transfer",
      reference_number: data.reference_number || null,
      notes:            data.notes || null,
    }).eq("id", id);
    if (error) throw new Error(error.message);
    return { success: true };
  },
});

export const editOwnerPayment = action({
  args: { id: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { id, data }) => {
    const sb = getSupabase();
    const updates: Record<string, any> = {
      escalated_amount: parseFloat(data.escalated_amount) || 0,
      due_date:         data.due_date,
      actual_due_date:  data.actual_due_date || data.due_date,
      notes:            data.notes || null,
      reference_number: data.reference_number || null,
    };
    if (data.status === "paid") {
      updates.status = "paid";
      updates.paid_date = data.paid_date || null;
      updates.payment_mode = data.payment_mode || null;
    } else {
      updates.status = "pending";
      updates.paid_date = null;
      updates.payment_mode = null;
    }
    const { error } = await sb.from("owner_payments").update(updates).eq("id", id);
    if (error) throw new Error(error.message);
    return { success: true };
  },
});

export const regenerateOwnerBills = action({
  args: { ownerId: v.string(), mode: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, { ownerId }) => {
    const sb = getSupabase();
    const contracts = await safeList(
      sb.from("owner_contracts").select("id").eq("owner_id", ownerId).eq("organization_id", ORG_ID)
    );
    for (const c of contracts) {
      await regeneratePaymentsForContract(sb, c.id);
    }
    return { success: true, contracts: contracts.length };
  },
});


// ─── PROPERTY LIST (for owners property filter) ──────────────────────────────
export const listPropertiesForFilter = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const props = await safeList(
      sb.from("properties").select("id, property_name, name, code").eq("organization_id", ORG_ID).order("property_name")
    );
    return props.map((p: any) => ({
      id:   p.id,
      name: p.property_name || p.name || p.code || "Property",
    }));
  },
});


// ─── DOCUMENT UPLOAD (photo / ID proof / agreement) ──────────────────────────
// Receives base64 from the mobile app, uploads to the `documents` storage bucket,
// returns the public URL. Mirrors the web FileUploadField behaviour.
export const uploadDocument = action({
  args: {
    base64:   v.string(),
    fileName: v.string(),
    folder:   v.optional(v.string()),
    contentType: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, { base64, fileName, folder, contentType }) => {
    const sb = getSupabase();
    // Strip data URI prefix if present
    const clean = base64.includes(",") ? base64.split(",")[1] : base64;
    const bytes = Buffer.from(clean, "base64");
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${folder || "owners"}/${Date.now()}_${safeName}`;
    const { error } = await sb.storage.from("documents").upload(path, bytes, {
      contentType: contentType || "image/jpeg",
      upsert: true,
    });
    if (error) throw new Error(`Upload failed: ${error.message}`);
    const { data } = sb.storage.from("documents").getPublicUrl(path);
    return { url: data.publicUrl };
  },
});
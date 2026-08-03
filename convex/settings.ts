"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import {
  getSupabase, ORG_ID, safeList, insertRow, updateRow, deleteRow,
} from "./lib/supabaseAdmin";

// ─── TEAM MEMBERS ────────────────────────────────────────────────────
export const getTeamMembers = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return safeList(
      sb.from("team_members").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false })
    );
  },
});

export const createTeamMember = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    return insertRow("team_members", { ...data, organization_id: ORG_ID, status: data.status || "active" });
  },
});

export const updateTeamMember = action({
  args: { id: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { id, data }) => {
    return updateRow("team_members", id, data);
  },
});

export const deleteTeamMember = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    return deleteRow("team_members", id);
  },
});

// ─── USERS FOR SETTINGS ──────────────────────────────────────────────
export const listUsersForSettings = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const [members, userRoles] = await Promise.all([
      safeList(
        sb.from("team_members").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false })
      ),
      safeList(
        sb.from("user_roles").select("user_id, role")
      ),
    ]);
    // Build role lookup by user_id (for linked accounts) AND by team_member id (for unlinked)
    const roleByKey: Record<string, string> = {};
    userRoles.forEach((r: any) => { if (r.user_id) roleByKey[r.user_id] = r.role; });

    return members.map((u: any) => ({
      id: u.id,
      user_id: u.user_id || null,
      name: `${u.first_name || ""} ${u.last_name || ""}`.trim() || u.name || "",
      phone: u.phone || "", email: u.email || undefined,
      // Prefer real user_id lookup, fall back to team_member id as key
      role: (u.user_id && roleByKey[u.user_id]) || roleByKey[u.id] || "technician",
      isActive: u.status !== "inactive",
      specialties: u.specialties || undefined,
    }));
  },
});

export const addUserForSettings = action({
  args: { name: v.string(), phone: v.string(), email: v.optional(v.string()), role: v.string(), specialties: v.optional(v.array(v.string())) },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    const cleanedPhone = args.phone.replace(/\s+/g, "").replace(/^\+/, "");
    const existing = await safeList(
      sb.from("team_members").select("id").eq("phone", cleanedPhone).eq("organization_id", ORG_ID).limit(1)
    );
    if (existing.length > 0) throw new Error("User with this phone already exists");
    const parts = args.name.trim().split(" ");
    const row = await insertRow("team_members", {
      first_name: parts[0] || args.name, last_name: parts.slice(1).join(" ") || "",
      phone: cleanedPhone, email: args.email || null,
      status: "active", specialties: args.specialties || null,
    });
    // Store role in user_roles keyed by team_member id (until they log in and get a real user_id)
    if (args.role && row.id) {
      await sb.from("user_roles").insert({ user_id: row.id, role: args.role });
    }
    return row.id;
  },
});

export const updateUserForSettings = action({
  args: { userId: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { userId, data: args }) => {
    const sb = getSupabase();
    // team_members columns (no role column — role lives in user_roles)
    const memberUpdates: Record<string, any> = {};
    if (args.name !== undefined) {
      const parts = args.name.trim().split(" ");
      memberUpdates.first_name = parts[0] || args.name;
      memberUpdates.last_name = parts.slice(1).join(" ") || "";
    }
    if (args.email !== undefined) memberUpdates.email = args.email;
    if (args.specialties !== undefined) memberUpdates.specialties = args.specialties;
    if (args.isActive !== undefined) memberUpdates.status = args.isActive ? "active" : "inactive";
    if (Object.keys(memberUpdates).length > 0) await updateRow("team_members", userId, memberUpdates);

    // Update role in user_roles
    // Key preference: real Supabase user_id if linked, else team_member id as stable key
    if (args.role !== undefined) {
      const { data: member } = await sb.from("team_members").select("user_id").eq("id", userId).maybeSingle();
      const roleKey = member?.user_id || userId; // userId = team_members.id
      const existing = await safeList(
        sb.from("user_roles").select("id").eq("user_id", roleKey).limit(1)
      );
      if (existing.length > 0) {
        await sb.from("user_roles").update({ role: args.role }).eq("user_id", roleKey);
      } else {
        await sb.from("user_roles").insert({ user_id: roleKey, role: args.role });
      }
    }
    return { success: true };
  },
});

export const updateProfile = action({
  args: { userId: v.string(), name: v.string(), email: v.optional(v.string()), organizationName: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const parts = args.name.trim().split(" ");
    await updateRow("team_members", args.userId, {
      first_name: parts[0] || args.name,
      last_name: parts.slice(1).join(" ") || "",
      email: args.email || undefined,
    });
    return { success: true };
  },
});

// ─── BED RATES ───────────────────────────────────────────────────────
export const listBedRates = action({
  args: { propertyId: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, { propertyId }) => {
    const sb = getSupabase();
    let q = sb.from("bed_rates").select("*").eq("organization_id", ORG_ID);
    if (propertyId) q = q.eq("property_id", propertyId);
    q = q.order("from_date", { ascending: false });
    return safeList(q);
  },
});

export const createBedRate = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data: args }) => {
    const { toISODate } = await import("./lib/supabaseAdmin");
    const row = await insertRow("bed_rates", {
      property_id: args.propertyId, bed_type: args.bedType,
      toilet_type: args.toiletType, monthly_rate: args.monthlyRate,
      from_date: toISODate(args.fromDate), to_date: toISODate(args.toDate),
    });
    return row.id;
  },
});

export const updateBedRate = action({
  args: { id: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { id, data: args }) => {
    const { toISODate } = await import("./lib/supabaseAdmin");
    const d: Record<string, any> = {};
    if (args.bedType !== undefined) d.bed_type = args.bedType;
    if (args.toiletType !== undefined) d.toilet_type = args.toiletType;
    if (args.monthlyRate !== undefined) d.monthly_rate = args.monthlyRate;
    if (args.fromDate !== undefined) d.from_date = toISODate(args.fromDate);
    if (args.toDate !== undefined) d.to_date = toISODate(args.toDate);
    if (Object.keys(d).length > 0) await updateRow("bed_rates", id, d);
    return { success: true };
  },
});

export const deleteBedRate = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    await deleteRow("bed_rates", id);
    return { success: true };
  },
});

// ─── APARTMENT LABELS ────────────────────────────────────────────────
export const listApartmentLabels = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return safeList(sb.from("apartment_labels").select("*").eq("organization_id", ORG_ID));
  },
});

export const createApartmentLabel = action({
  args: { label: v.string(), description: v.optional(v.string()) },
  returns: v.any(),
  handler: async (_ctx, args) => {
    return insertRow("apartment_labels", { label: args.label, description: args.description || null });
  },
});

export const deleteApartmentLabel = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    return deleteRow("apartment_labels", id);
  },
});

// ─── ROLE PERMISSIONS ────────────────────────────────────────────────
export const getPermissions = action({
  args: { role: v.string() },
  returns: v.any(),
  handler: async (_ctx, { role }) => {
    const sb = getSupabase();
    // Returns all module rows for this role so the UI can render a per-module
    // can_create / can_read / can_update / can_delete grid.
    const rows = await safeList(
      sb.from("role_permissions").select("*").eq("organization_id", ORG_ID).eq("role", role)
    );
    return rows; // array of { id, role, module, can_create, can_read, can_update, can_delete }
  },
});

export const setPermissions = action({
  args: {
    role: v.string(),
    // Each entry represents one module row
    permissions: v.array(v.object({
      module: v.string(),
      can_create: v.boolean(),
      can_read: v.boolean(),
      can_update: v.boolean(),
      can_delete: v.boolean(),
    })),
  },
  returns: v.any(),
  handler: async (_ctx, { role, permissions }) => {
    const sb = getSupabase();
    // Upsert each module row individually
    for (const perm of permissions) {
      const existing = await safeList(
        sb.from("role_permissions").select("id")
          .eq("organization_id", ORG_ID).eq("role", role).eq("module", perm.module).limit(1)
      );
      if (existing.length > 0) {
        await updateRow("role_permissions", existing[0].id, {
          can_create: perm.can_create,
          can_read: perm.can_read,
          can_update: perm.can_update,
          can_delete: perm.can_delete,
          updated_at: new Date().toISOString(),
        });
      } else {
        await insertRow("role_permissions", {
          organization_id: ORG_ID,
          role,
          module: perm.module,
          can_create: perm.can_create,
          can_read: perm.can_read,
          can_update: perm.can_update,
          can_delete: perm.can_delete,
        });
      }
    }
    return { success: true };
  },
});

// ─── ORG SETTINGS ────────────────────────────────────────────────────
export const getOrgSettings = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rows = await safeList(
      sb.from("org_settings").select("*").eq("organization_id", ORG_ID).limit(1)
    );
    if (rows.length > 0) {
      const r = rows[0];
      return {
        costApprovalThreshold: r.cost_approval_threshold ?? 5000,
        organizationName: r.organization_name || "Vishful Spaces LLP",
        // Org profile fields (web parity). Column names assumed to match the
        // Settings form; verify against org_settings if any comes back null.
        gst_number: r.gst_number ?? "",
        address_line1: r.address_line1 ?? "",
        address_line2: r.address_line2 ?? "",
        city: r.city ?? "",
        state: r.state ?? "",
        pincode: r.pincode ?? "",
        country: r.country ?? "India",
        contact_person_name: r.contact_person_name ?? "",
        contact_phone: r.contact_phone ?? "",
        contact_email: r.contact_email ?? "",
        website: r.website ?? "",
      };
    }
    return { costApprovalThreshold: 5000, organizationName: "Vishful Spaces LLP" };
  },
});

export const updateOrgSettings = action({
  args: {
    costApprovalThreshold: v.optional(v.number()),
    // Org profile fields (web parity). All optional — only provided keys persist.
    organizationName: v.optional(v.string()),
    gstNumber: v.optional(v.string()),
    addressLine1: v.optional(v.string()),
    addressLine2: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    pincode: v.optional(v.string()),
    country: v.optional(v.string()),
    contactPersonName: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    website: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    const existing = await safeList(
      sb.from("org_settings").select("id").eq("organization_id", ORG_ID).limit(1)
    );
    const updates: Record<string, any> = {};
    if (args.costApprovalThreshold !== undefined) updates.cost_approval_threshold = args.costApprovalThreshold;
    if (args.organizationName !== undefined) updates.organization_name = args.organizationName;
    if (args.gstNumber !== undefined) updates.gst_number = args.gstNumber;
    if (args.addressLine1 !== undefined) updates.address_line1 = args.addressLine1;
    if (args.addressLine2 !== undefined) updates.address_line2 = args.addressLine2;
    if (args.city !== undefined) updates.city = args.city;
    if (args.state !== undefined) updates.state = args.state;
    if (args.pincode !== undefined) updates.pincode = args.pincode;
    if (args.country !== undefined) updates.country = args.country;
    if (args.contactPersonName !== undefined) updates.contact_person_name = args.contactPersonName;
    if (args.contactPhone !== undefined) updates.contact_phone = args.contactPhone;
    if (args.contactEmail !== undefined) updates.contact_email = args.contactEmail;
    if (args.website !== undefined) updates.website = args.website;
    if (existing.length > 0) {
      await updateRow("org_settings", existing[0].id, updates);
    } else {
      await insertRow("org_settings", { organization_name: "Vishful Spaces LLP", ...updates });
    }
    return { success: true };
  },
});

// ─── ROLE PERMISSIONS (FULL CRUD) ────────────────────────────────────
export const getRolePermissions = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return safeList(
      sb.from("role_permissions").select("*").eq("organization_id", ORG_ID).order("module")
    );
  },
});

export const upsertRolePermission = action({
  args: { id: v.optional(v.string()), role: v.string(), module: v.string(), can_create: v.boolean(), can_read: v.boolean(), can_update: v.boolean(), can_delete: v.boolean() },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    if (args.id) {
      const { id, role, module, ...rest } = args;
      return updateRow("role_permissions", id, { ...rest, updated_at: new Date().toISOString() });
    }
    const existing = await safeList(
      sb.from("role_permissions").select("id").eq("organization_id", ORG_ID).eq("role", args.role).eq("module", args.module).limit(1)
    );
    if (existing.length > 0) {
      const { id: _id, role, module, ...rest } = args;
      return updateRow("role_permissions", existing[0].id, { ...rest, updated_at: new Date().toISOString() });
    }
    return insertRow("role_permissions", { organization_id: ORG_ID, role: args.role, module: args.module, can_create: args.can_create, can_read: args.can_read, can_update: args.can_update, can_delete: args.can_delete });
  },
});

export const deleteRolePermission = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    return deleteRow("role_permissions", id);
  },
});

export const deleteAllRolePermissions = action({
  args: { role: v.string() },
  returns: v.any(),
  handler: async (_ctx, { role }) => {
    const sb = getSupabase();
    await sb.from("role_permissions").delete().eq("organization_id", ORG_ID).eq("role", role);
    await sb.from("tab_permissions").delete().eq("organization_id", ORG_ID).eq("role", role);
    return { success: true };
  },
});

// ─── TAB PERMISSIONS ────────────────────────────────────────────────
export const getTabPermissions = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return safeList(
      sb.from("tab_permissions").select("*").eq("organization_id", ORG_ID).order("module")
    );
  },
});

export const upsertTabPermission = action({
  args: { id: v.optional(v.string()), role: v.string(), module: v.string(), tab_key: v.string(), is_visible: v.boolean(), can_create: v.optional(v.boolean()), can_read: v.optional(v.boolean()), can_update: v.optional(v.boolean()), can_delete: v.optional(v.boolean()) },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    const payload: Record<string, any> = {
      is_visible: args.is_visible,
      can_create: args.can_create ?? false,
      can_read: args.can_read ?? true,
      can_update: args.can_update ?? false,
      can_delete: args.can_delete ?? false,
      updated_at: new Date().toISOString(),
    };
    if (args.id) {
      return updateRow("tab_permissions", args.id, payload);
    }
    const existing = await safeList(
      sb.from("tab_permissions").select("id").eq("organization_id", ORG_ID).eq("role", args.role).eq("module", args.module).eq("tab_key", args.tab_key).limit(1)
    );
    if (existing.length > 0) {
      return updateRow("tab_permissions", existing[0].id, payload);
    }
    return insertRow("tab_permissions", { organization_id: ORG_ID, role: args.role, module: args.module, tab_key: args.tab_key, ...payload });
  },
});

export const deleteTabPermission = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    return deleteRow("tab_permissions", id);
  },
});

// ─── USER ROLES ─────────────────────────────────────────────────────
export const getUserRoles = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return safeList(sb.from("user_roles").select("*"));
  },
});

export const assignUserRole = action({
  args: { user_id: v.string(), role: v.string() },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    const existing = await safeList(
      sb.from("user_roles").select("id").eq("user_id", args.user_id).eq("role", args.role).limit(1)
    );
    if (existing.length > 0) throw new Error("User already has this role");
    return insertRow("user_roles", { user_id: args.user_id, role: args.role });
  },
});

export const removeUserRole = action({
  args: { user_id: v.string(), role: v.string() },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const sb = getSupabase();
    await sb.from("user_roles").delete().eq("user_id", args.user_id).eq("role", args.role);
    return { success: true };
  },
});

export const getOrgProfiles = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return safeList(sb.from("profiles").select("id, full_name, phone, email").eq("organization_id", ORG_ID));
  },
});
// ─── ASSIGNMENT RULES ────────────────────────────────────────────────
export const listAssignmentRules = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return safeList(sb.from("ticket_assignment_rules").select("*").eq("organization_id", ORG_ID).order("priority"));
  },
});
export const createAssignmentRule = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => insertRow("ticket_assignment_rules", { ...data, organization_id: ORG_ID }),
});
export const updateAssignmentRule = action({
  args: { id: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { id, data }) => updateRow("ticket_assignment_rules", id, data),
});
export const deleteAssignmentRule = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => deleteRow("ticket_assignment_rules", id),
});

// ─── BED TYPES ───────────────────────────────────────────────────────
export const listBedTypes = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return safeList(sb.from("bed_type_config").select("*").eq("organization_id", ORG_ID).order("sort_order"));
  },
});
export const createBedType = action({
  args: { name: v.string(), sort_order: v.optional(v.number()) },
  returns: v.any(),
  handler: async (_ctx, args) => insertRow("bed_type_config", { name: args.name, sort_order: args.sort_order ?? 0, organization_id: ORG_ID }),
});
export const deleteBedType = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => deleteRow("bed_type_config", id),
});

// ─── MAINTENANCE ITEMS ───────────────────────────────────────────────
export const listMaintenanceItems = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return safeList(sb.from("maintenance_items").select("*").eq("organization_id", ORG_ID).order("name"));
  },
});
export const createMaintenanceItem = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => insertRow("maintenance_items", { name: data.name, unit: data.unit || null, description: data.description || null, organization_id: ORG_ID }),
});
export const deleteMaintenanceItem = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => deleteRow("maintenance_items", id),
});

// ─── ISSUE TYPES (for rules tab) ─────────────────────────────────────
export const listIssueTypes = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    return safeList(sb.from("issue_types").select("id, name, icon, priority, sla_hours").eq("organization_id", ORG_ID).order("name"));
  },
});

// ─── LIFECYCLE CONFIG ────────────────────────────────────────────────
export const getLifecycleConfig = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const rows = await safeList(sb.from("lifecycle_config").select("*").eq("organization_id", ORG_ID).order("from_date", { ascending: false }).limit(1));
    return rows[0] || null;
  },
});
export const saveLifecycleConfig = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    const { id, ...rest } = data;
    if (id) return updateRow("lifecycle_config", id, rest);
    const today = new Date().toISOString().split("T")[0];
    return insertRow("lifecycle_config", { organization_id: ORG_ID, from_date: today, to_date: null, notice_period_days: 30, refund_deadline_days: 5, ...rest });
  },
});

// ─── ORG EXIT + AUTO APPROVAL SETTINGS ──────────────────────────────
export const getOrgExitSettings = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const sb = getSupabase();
    const { data } = await sb.from("organizations").select("exit_task_assignee_1, exit_task_assignee_2, ticket_auto_approve_threshold, ticket_repeat_check_days").eq("id", ORG_ID).single();
    return data;
  },
});
export const saveOrgExitSettings = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    const sb = getSupabase();
    const payload: Record<string, any> = {};
    if (data.exit_task_assignee_1 !== undefined) payload.exit_task_assignee_1 = data.exit_task_assignee_1 || null;
    if (data.exit_task_assignee_2 !== undefined) payload.exit_task_assignee_2 = data.exit_task_assignee_2 === '__none' ? null : (data.exit_task_assignee_2 || null);
    if (data.ticket_auto_approve_threshold !== undefined) payload.ticket_auto_approve_threshold = Number(data.ticket_auto_approve_threshold);
    if (data.ticket_repeat_check_days !== undefined) payload.ticket_repeat_check_days = Number(data.ticket_repeat_check_days);
    const { error } = await sb.from("organizations").update(payload as any).eq("id", ORG_ID);
    if (error) throw new Error(error.message);
    return { success: true };
  },
});

// ─── BANK ACCOUNTS ───────────────────────────────────────────────────
// Enforce a single primary account org-wide: setting one primary clears the rest.
async function clearOtherPrimaries(exceptId?: string) {
  const sb = getSupabase();
  let q = sb.from("bank_accounts").update({ is_primary: false } as any).eq("organization_id", ORG_ID).eq("is_primary", true);
  if (exceptId) q = q.neq("id", exceptId);
  await q;
}
export const createBankAccount = action({
  args: { data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { data }) => {
    if (data.is_primary) await clearOtherPrimaries();
    return insertRow("bank_accounts", { bank_name: data.bank_name, account_number: data.account_number, account_holder: data.account_holder || null, ifsc: data.ifsc || null, branch: data.branch || null, is_primary: data.is_primary || false, is_active: true, organization_id: ORG_ID });
  },
});
export const updateBankAccount = action({
  args: { id: v.string(), data: v.any() },
  returns: v.any(),
  handler: async (_ctx, { id, data }) => {
    const { id: _id, ...rest } = data;
    if (rest.is_primary) await clearOtherPrimaries(id);
    return updateRow("bank_accounts", id, rest);
  },
});
export const deleteBankAccount = action({
  args: { id: v.string() },
  returns: v.any(),
  handler: async (_ctx, { id }) => {
    await deleteRow("bank_accounts", id);
    return { success: true };
  },
});
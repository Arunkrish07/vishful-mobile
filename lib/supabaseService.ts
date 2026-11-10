/**
 * supabaseService.ts
 *
 * Frontend API layer — routes ALL data operations through Convex actions.
 * Convex actions use Supabase service role key server-side.
 * No direct Supabase calls from the client.
 */
import { client, api } from "./convexApi";
import { supabase } from "./supabase";
import {
  ORG_ID, safeList, insertRow, updateRow, deleteDisabledResult,
  filterLiveBeds, fetchAllPages, cleanPhone, phoneVariants, toISODate,
} from "./supabaseDb";

// ─── Tenant write helpers (ported from convex/tenants.ts) ────────────────────
const TENANT_WRITABLE = [
  "full_name", "first_name", "last_name", "phone", "email", "gender",
  "date_of_birth", "permanent_address", "address", "city", "state", "pincode",
  "company_name", "company_address", "designation", "profession",
  "emergency_contact_name", "emergency_contact_phone",
  "id_proof_type", "id_proof_number", "id_proof_url", "photo_url",
  "kyc_completed", "pan_number",
  "aadhar_image_url", "id_card_url", "age", "date_of_joining", "food_preference",
  "relation_name", "emergency_contact_relation",
  "company_city", "company_state", "company_pincode",
  "bank_name", "bank_account_holder", "bank_account_number", "bank_branch", "bank_ifsc",
  "gst_number", "gst_name",
];
function mapTenantColumns(data: any): Record<string, any> {
  const row: Record<string, any> = {};
  for (const k of TENANT_WRITABLE) if (data[k] !== undefined) row[k] = data[k];
  if (data.aadhar_number && row.id_proof_number === undefined) {
    row.id_proof_number = data.aadhar_number;
    if (row.id_proof_type === undefined) row.id_proof_type = "aadhaar";
  }
  return row;
}
async function assertGenderCompatible(tenantId?: string, bedId?: string): Promise<void> {
  if (!tenantId || !bedId) return;
  const beds = await safeList(supabase.from("beds").select("apartment_id").eq("id", bedId));
  const apartmentId = (beds[0] as any)?.apartment_id;
  if (!apartmentId) return;
  const apts = await safeList(supabase.from("apartments").select("gender_allowed").eq("id", apartmentId));
  const ga = String((apts[0] as any)?.gender_allowed || "").toLowerCase();
  if (!ga || ga === "both") return;
  const tens = await safeList(supabase.from("tenants").select("gender").eq("id", tenantId));
  const tg = String((tens[0] as any)?.gender || "").toLowerCase();
  if (tg && tg !== ga) throw new Error(`Gender mismatch: this ${ga}-only room cannot be allotted to a ${tg} tenant.`);
}
import {
  filterLiveBeds as mFilterLiveBeds,
  classifyBed,
  computePropertyStatus,
  computeAccountingMetrics,
} from "./metrics";
import { selectOutstandingRecipients, hasUsablePhone } from "./outstandingReminders";
import { SUPABASE_URL, SUPABASE_ANON_KEY, ORG_ID as CFG_ORG_ID } from './config';
// ─── allSettled polyfill — Promise.allSettled is undefined in older Hermes/JSC ─
function allSettled(promises: Promise<any>[]): Promise<{ status: string; value?: any; reason?: any }[]> {
  return Promise.all(
    promises.map(function(p) {
      return Promise.resolve(p).then(
        function(value) { return { status: 'fulfilled', value: value }; },
        function(reason) { return { status: 'rejected', reason: reason }; }
      );
    })
  );
}




// ═══════════════════════════════════════════════════════════════════════════════
// AUTH — OTP, Sessions, Login
// ═══════════════════════════════════════════════════════════════════════════════

// Send OTP via the server-side `send_otp` Edge Function (holds the Fast2SMS +
// service-role keys, which must never ship in the app). Business failures come
// back as { success:false, message } with HTTP 200; a thrown invoke error means
// the function is unreachable/not deployed.
export async function sendOtp(phone: string): Promise<{ success: boolean; message?: string; reason?: string }> {
  const { data, error } = await supabase.functions.invoke('send_otp', { body: { phone } });
  if (error) {
    console.warn('[supabaseService] sendOtp invoke error:', error.message);
    return { success: false, message: 'Could not reach the login service. Please try again.' };
  }
  return (data || { success: false, message: 'No response from login service.' }) as any;
}

// Verify OTP + mint a session via the `verify_otp` Edge Function. On success we
// hand the returned tokens to the Supabase client via setSession, so every
// subsequent .from()/.rpc() call runs as this user under RLS.
export async function verifyOtpAndLogin(phone: string, otp: string): Promise<{
  success: boolean;
  token?: string;
  refreshToken?: string;
  user?: { userId: string; userName: string; phone: string; role: string; organizationId: string; organizationName: string; supabaseUserId?: string | null };
  reason?: string;
  message?: string;
}> {
  const { data, error } = await supabase.functions.invoke('verify_otp', { body: { phone, otp } });
  if (error) {
    console.warn('[supabaseService] verifyOtp invoke error:', error.message);
    return { success: false, message: 'Could not reach the login service. Please try again.' };
  }
  const res = (data || { success: false }) as any;
  if (res?.success && res.token && res.refreshToken) {
    try {
      await supabase.auth.setSession({ access_token: res.token, refresh_token: res.refreshToken });
    } catch (e: any) {
      console.warn('[supabaseService] setSession after login failed:', e?.message);
    }
  }
  return res;
}

// Exchange a stored refresh token for a fresh access token, directly via
// Supabase Auth (no server needed). Returns { success:false } on any failure.
export async function refreshSession(refreshToken: string): Promise<{ success: boolean; token?: string; refreshToken?: string }> {
  if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.trim().length === 0) {
    return { success: false };
  }
  try {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data?.session?.access_token) {
      console.warn('[supabaseService] refreshSession failed:', error?.message);
      return { success: false };
    }
    return {
      success: true,
      token: data.session.access_token,
      refreshToken: data.session.refresh_token || refreshToken,
    };
  } catch (e: any) {
    console.warn('[supabaseService] refreshSession error:', e?.message);
    return { success: false };
  }
}

// Validate a stored access token and resolve the user's role, directly via
// Supabase (no server). Reads team_members / user_roles / tenants under the
// user's JWT — so these tables must allow the signed-in user to read their own
// row via RLS. On a read-blocked role lookup we fall back to the coarse userType.
export async function getSession(token: string): Promise<{
  valid: boolean;
  userId?: string; userName?: string; phone?: string;
  role?: string; organizationId?: string; organizationName?: string;
  supabaseUserId?: string | null;
} | null> {
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    console.warn('[supabaseService] getSession called with invalid token:', typeof token);
    return { valid: false };
  }
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return { valid: false };

    const email = user.email || '';
    const phone = email.replace('@vishful.local', '');
    const phoneVariants = [phone, `+91${phone}`, `91${phone}`];

    let userType = 'unknown';
    let resolvedRole = 'unknown';
    let userName = '';
    let organizationId = '';

    let foundTeamMember: any = null;
    for (const variant of phoneVariants) {
      const { data } = await supabase.from('team_members').select('id, first_name, last_name, user_id').eq('phone', variant).maybeSingle();
      if (data) { foundTeamMember = data; break; }
    }

    if (foundTeamMember) {
      userType = 'team_member';
      userName = `${foundTeamMember.first_name || ''} ${foundTeamMember.last_name || ''}`.trim();
      const candidateIds = [foundTeamMember.user_id, user.id, foundTeamMember.id].filter(Boolean);
      for (const uid of candidateIds) {
        const { data: roleData } = await supabase.from('user_roles').select('role').eq('user_id', uid).maybeSingle();
        if (roleData?.role) { resolvedRole = roleData.role; break; }
      }
      if (resolvedRole === 'unknown') resolvedRole = userType;
    } else {
      for (const variant of phoneVariants) {
        const { data } = await supabase.from('tenants').select('id, full_name, organization_id').eq('phone', variant).maybeSingle();
        if (data) {
          userType = 'tenant'; resolvedRole = 'tenant';
          userName = data.full_name || ''; organizationId = data.organization_id || '';
          break;
        }
      }
    }

    return {
      valid: true,
      userId: user.id,
      supabaseUserId: user.id,
      userName,
      phone,
      role: resolvedRole,
      organizationId,
      organizationName: 'Vishful Spaces LLP',
    };
  } catch (e: any) {
    console.warn('[supabaseService] getSession error:', e?.message);
    return null;
  }
}

// Submit an in-app account-deletion request (non-destructive). The backend verifies
// the token server-side and records the request as an audit_logs entry for the team.
export async function requestAccountDeletion(
  token: string,
  reason?: string,
): Promise<{ success: boolean; message?: string }> {
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return { success: false, message: 'Your session has expired. Please sign in again.' };
  }
  try {
    return await client.action((api as any).account.requestAccountDeletion, { token, reason });
  } catch (e: any) {
    console.warn('[supabaseService] requestAccountDeletion error:', e?.message);
    return { success: false, message: 'Could not submit your request. Please try again.' };
  }
}

// Clear the Supabase client session on logout so no authed session lingers.
export async function signOutSupabase(): Promise<void> {
  try { await supabase.auth.signOut(); } catch (e: any) { console.warn('[supabaseService] signOut error:', e?.message); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

// Dashboard KPI cards — direct Supabase port of convex/dashboard.ts getStats.
// Runs under the logged-in user's JWT (RLS). Occupancy uses the canonical
// metrics helpers so numbers match the web app exactly.
export async function getDashboardData() {
  try {
    const [properties, beds, apartments, allotments, invoices, tenantsCountRes] = await Promise.all([
      safeList(supabase.from("properties").select("*").eq("organization_id", ORG_ID)),
      safeList(supabase.from("beds").select("*").eq("organization_id", ORG_ID)),
      safeList(supabase.from("apartments").select("*").eq("organization_id", ORG_ID)),
      // Source of truth for occupancy — only ACTIVE allotments (keeps result under
      // PostgREST's 1000-row cap; see convex/dashboard.ts note).
      safeList(
        supabase.from("tenant_allotments")
          .select("bed_id,staying_status")
          .eq("organization_id", ORG_ID)
          .in("staying_status", ["Staying", "On-Notice", "Booked"]),
      ),
      // Invoices only need these 4 columns, but there are >1000 — page through so
      // revenue/pending are complete (PostgREST caps each page at 1000).
      fetchAllPages((from, to) =>
        supabase.from("invoices")
          .select("billing_month,status,total_amount,electricity_amount")
          .eq("organization_id", ORG_ID)
          .range(from, to),
      ),
      // Exact tenant total without pulling all rows (there are >1000).
      supabase.from("tenants").select("id", { count: "exact", head: true }).eq("organization_id", ORG_ID),
    ]);
    const totalTenants = (tenantsCountRes as any)?.count ?? 0;

    // LIVE beds = bed.status === 'Live' AND apartment.status === 'Live' (web parity).
    const liveAptIds = new Set(
      apartments.filter((a: any) => (a.status || "").toLowerCase() === "live").map((a: any) => a.id),
    );
    const liveApartments = liveAptIds.size;
    const liveBedsList = mFilterLiveBeds(beds, apartments);

    let occupiedBeds = 0, vacantBeds = 0, noticeBeds = 0, bookedBeds = 0;
    for (const b of liveBedsList) {
      const occ = classifyBed(b.id, allotments);
      if (occ === "occupied") occupiedBeds++;
      else if (occ === "notice") noticeBeds++;
      else if (occ === "booked") bookedBeds++;
      else vacantBeds++;
    }
    const liveBeds = liveBedsList.length;

    const stayingCount  = allotments.filter((a: any) => a.staying_status === "Staying").length;
    const onNoticeCount = allotments.filter((a: any) => a.staying_status === "On-Notice").length;
    const bookedCount   = allotments.filter((a: any) => a.staying_status === "Booked").length;

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const monthlyRevenue = invoices
      .filter((i: any) => i.billing_month === currentMonth && i.status === "paid")
      .reduce((sum: number, i: any) => sum + (Number(i.total_amount) || 0), 0);
    const pendingPayments = invoices
      .filter((i: any) => ["sent", "partial", "overdue"].includes(i.status))
      .reduce((sum: number, i: any) => sum + (Number(i.total_amount) || 0), 0);
    const electricityPending = invoices
      .filter((i: any) => ["sent", "partial", "overdue"].includes(i.status))
      .reduce((sum: number, i: any) => sum + (Number(i.electricity_amount) || 0), 0);

    const occupancyByProperty = properties.map((p: any) => {
      const propAptIds = new Set(
        apartments.filter((a: any) => a.property_id === p.id).map((a: any) => a.id),
      );
      const propLiveBeds = liveBedsList.filter((b: any) => propAptIds.has(b.apartment_id));
      const ps = computePropertyStatus(propLiveBeds, allotments);
      return {
        id: p.id,
        name: p.property_name || p.name || p.code || "Unknown",
        totalBeds: ps.total,
        occupiedBeds: ps.occupied,
        noticeBeds: ps.notice,
        bookedBeds: ps.booked,
        vacantBeds: ps.vacant,
        occupancyRate: ps.occupancyPct,
      };
    });

    return {
      totalProperties: properties.length,
      totalTenants,
      totalBeds: beds.length,
      vacantBeds, occupiedBeds, noticeBeds, bookedBeds,
      liveBeds, liveApartments,
      monthlyRevenue, pendingPayments, electricityPending,
      occupancyByProperty,
      lifecycle: { staying: stayingCount, onNotice: onNoticeCount, booked: bookedCount },
    };
  } catch (e: any) {
    console.error("[getDashboardData]", e?.message);
    return {
      totalProperties: 0, totalTenants: 0, totalBeds: 0,
      vacantBeds: 0, occupiedBeds: 0, noticeBeds: 0, bookedBeds: 0,
      liveBeds: 0, liveApartments: 0,
      monthlyRevenue: 0, pendingPayments: 0, electricityPending: 0,
      occupancyByProperty: [],
      lifecycle: { staying: 0, onNotice: 0, booked: 0 },
    };
  }
}

// Dashboard financial/extended section — direct port of convex/dashboard.ts getExtendedStats.
function extFmtMonthKey(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function extResolveRange(period?: string, customFrom?: string, customTo?: string): { from: Date; to: Date } {
  if (period === "custom" && customFrom && customTo) {
    const from = new Date(customFrom + "T00:00:00");
    const to = new Date(customTo + "T23:59:59.999");
    return from.getTime() > to.getTime() ? { from: to, to: from } : { from, to };
  }
  return rptPeriodDateRange((period || "current_fy") as ReportingPeriod);
}
function extInPeriod(dateStr: string | null | undefined, from: Date, to: Date): boolean {
  if (!dateStr) return false;
  const key = String(dateStr).slice(0, 7);
  return key >= extFmtMonthKey(from) && key <= extFmtMonthKey(to);
}
export async function getExtendedStats(period?: string, customFrom?: string, customTo?: string) {
  try {
    const { from: fyFrom, to: fyTo } = extResolveRange(period, customFrom, customTo);
    const months: { key: string; label: string }[] = [];
    {
      const cur = new Date(fyFrom.getFullYear(), fyFrom.getMonth(), 1);
      const end = new Date(fyTo.getFullYear(), fyTo.getMonth(), 1);
      let guard = 0;
      while (cur.getTime() <= end.getTime() && guard < 48) {
        months.push({ key: `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`, label: cur.toLocaleString("en-IN", { month: "short", year: "2-digit" }) });
        cur.setMonth(cur.getMonth() + 1); guard++;
      }
      if (months.length === 0) months.push({ key: extFmtMonthKey(fyFrom), label: fyFrom.toLocaleString("en-IN", { month: "short", year: "2-digit" }) });
    }
    const [invoices, receipts, expenses, beds, apartments, allotments, announcements, tenants, ebPayments, settlements, adjustments] = await Promise.all([
      fetchAllPages((f, t) => supabase.from("invoices").select("id, tenant_id, billing_month, invoice_date, due_date, total_amount, rent_amount, electricity_amount, balance, status, bed_id, is_deleted").eq("organization_id", ORG_ID).eq("is_deleted", false).range(f, t)),
      fetchAllPages((f, t) => supabase.from("receipts").select("id, tenant_id, payment_date, amount_paid, receipt_type, is_deleted").eq("organization_id", ORG_ID).eq("is_deleted", false).range(f, t)),
      safeList(supabase.from("expenses").select("id, expense_date, billing_month, amount").eq("organization_id", ORG_ID)),
      safeList(supabase.from("beds").select("id, apartment_id, bed_type, status").eq("organization_id", ORG_ID)),
      safeList(supabase.from("apartments").select("id, apartment_code, property_id, status, properties(property_name)").eq("organization_id", ORG_ID)),
      safeList(supabase.from("tenant_allotments").select("bed_id, staying_status").eq("organization_id", ORG_ID).in("staying_status", ["Staying", "On-Notice", "Booked"])),
      safeList(supabase.from("announcements").select("id, title, content, priority, published_at").eq("organization_id", ORG_ID).eq("is_published", true).order("published_at", { ascending: false }).limit(5)),
      fetchAllPages((f, t) => supabase.from("tenants").select("id, full_name").eq("organization_id", ORG_ID).range(f, t)),
      safeList(supabase.from("eb_payments").select("id, bill_amount, bill_date").eq("organization_id", ORG_ID)).catch(() => [] as any[]),
      safeList(supabase.from("deposit_settlements").select("refund_amount, status, settlement_date, created_at").eq("organization_id", ORG_ID)).catch(() => [] as any[]),
      safeList(supabase.from("tenant_adjustments").select("amount, adjustment_type, billing_month, adjustment_date").eq("organization_id", ORG_ID)).catch(() => [] as any[]),
    ]);
    const monthKey = (s: string | null | undefined) => String(s || "").slice(0, 7);
    const rpcPeriodMap: Record<string, string> = { current_fy: "current_fy", last_fy: "last_fy", from_beginning: "all_time" };
    let rpcArgs: any = { p_organization_id: ORG_ID };
    if (period === "custom" && customFrom && customTo) { rpcArgs.p_period = "custom"; rpcArgs.p_from = customFrom; rpcArgs.p_to = customTo; }
    else if (period && rpcPeriodMap[period]) { rpcArgs.p_period = rpcPeriodMap[period]; }
    else if (period === "last_2fy" || period === "last_5y") { rpcArgs.p_period = "custom"; rpcArgs.p_from = extFmtMonthKey(fyFrom) + "-01"; rpcArgs.p_to = `${fyTo.getFullYear()}-${String(fyTo.getMonth() + 1).padStart(2, "0")}-${String(fyTo.getDate()).padStart(2, "0")}`; }
    else { rpcArgs.p_period = "current_fy"; }
    let acct: any = {}; let rpcPropertyStatus: any = null; let rpcTenants: any = null; let rpcTickets: any = null;
    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc("get_universal_metrics_v2", rpcArgs);
      if (rpcErr) throw rpcErr;
      const payload = Array.isArray(rpcData) ? rpcData[0] : rpcData;
      acct = payload?.accounting || {}; rpcPropertyStatus = payload?.propertyStatus || null; rpcTenants = payload?.tenants || null; rpcTickets = payload?.tickets || null;
    } catch (rpcE: any) { console.warn("[getExtendedStats] rpc failed:", rpcE?.message); }
    const rpcAccountingEmpty = !acct || Object.keys(acct).length === 0;
    const fallbackAcct = rpcAccountingEmpty ? computeAccountingMetrics(invoices, receipts, expenses, adjustments, settlements, (d: any) => extInPeriod(d, fyFrom, fyTo)) : null;
    const totalRevenue = Number(acct.totalRevenue ?? fallbackAcct?.totalInvoiced ?? 0);
    const operationalCollections = Number(acct.totalCollectionsWithoutDeposit ?? fallbackAcct?.totalCollectionsWithoutDeposit ?? 0);
    const pendingAmount = Number(acct.totalPendingCollection ?? fallbackAcct?.totalPendingCollection ?? 0);
    const totalProfit = Number(acct.totalProfit ?? fallbackAcct?.totalProfit ?? 0);
    const totalExpenseAmt = Number(acct.totalExpenses ?? fallbackAcct?.totalExpenses ?? 0);
    const totalCollections = Number(acct.totalCollections ?? fallbackAcct?.totalCollections ?? 0);
    const depositCollections = Number(acct.depositCollections ?? fallbackAcct?.depositCollections ?? 0);
    const totalRefundsGiven = Number(acct.totalRefundsGiven ?? fallbackAcct?.totalRefundsGiven ?? 0);
    const ebBilled = Number(acct.totalEbCharged ?? 0);
    const fyInvoices = invoices.filter((i: any) => extInPeriod(i.billing_month || i.invoice_date, fyFrom, fyTo));
    const fyEbPayments = (ebPayments as any[]).filter((p: any) => extInPeriod(p.bill_date, fyFrom, fyTo));
    const ebPaid = fyEbPayments.reduce((s: number, p: any) => s + Number(p.bill_amount || 0), 0);
    const ebMargin = ebBilled - ebPaid;
    const totalRent = fyInvoices.reduce((s: number, i: any) => s + Number(i.rent_amount || 0), 0);
    const uniqueBilledBeds = new Set(fyInvoices.filter((i: any) => i.bed_id).map((i: any) => i.bed_id));
    const revPerBed = uniqueBilledBeds.size > 0 ? Math.round(totalRent / uniqueBilledBeds.size) : 0;
    const financialSeries = months.map(({ key, label }) => {
      const rev = invoices.filter((i: any) => monthKey(i.billing_month || i.invoice_date) === key).reduce((s: number, i: any) => s + Number(i.total_amount || 0), 0);
      const exp = expenses.filter((e: any) => monthKey(e.expense_date) === key).reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
      return { label, revenue: Math.round(rev), expenses: Math.round(exp), profit: Math.round(rev - exp) };
    });
    const liveAptIds = new Set(apartments.filter((a: any) => (a.status || "").toLowerCase() === "live").map((a: any) => a.id));
    const liveBedsList = mFilterLiveBeds(beds, apartments);
    const stayingBedIds = new Set(allotments.filter((a: any) => a.staying_status === "Staying").map((a: any) => String(a.bed_id)));
    const byType = new Map<string, { total: number; occupied: number }>();
    for (const b of liveBedsList as any[]) {
      const ty = String(b.bed_type || "Unknown");
      if (!byType.has(ty)) byType.set(ty, { total: 0, occupied: 0 });
      byType.get(ty)!.total += 1;
      if (stayingBedIds.has(String(b.id))) byType.get(ty)!.occupied += 1;
    }
    const bedTypeOccupancy = Array.from(byType.entries()).map(([type, v2]) => ({ type, pct: v2.total > 0 ? Math.round((v2.occupied / v2.total) * 100) : 0, total: v2.total, occupied: v2.occupied })).sort((a, b) => b.pct - a.pct);
    const liveBedsByApt = new Map<string, string[]>();
    for (const b of liveBedsList as any[]) { const aptId = String(b.apartment_id || ""); if (!aptId) continue; if (!liveBedsByApt.has(aptId)) liveBedsByApt.set(aptId, []); liveBedsByApt.get(aptId)!.push(String(b.id)); }
    const liveApts = apartments.filter((a: any) => liveAptIds.has(a.id));
    const needsAttention = liveApts.map((a: any) => {
      const aptBeds = liveBedsByApt.get(String(a.id)) || [];
      const total = aptBeds.length; let occupied = 0, notice = 0;
      for (const id of aptBeds) { const c = classifyBed(id, allotments); if (c === "occupied") occupied++; else if (c === "notice") notice++; }
      const pct = total > 0 ? Math.round(((occupied + notice) / total) * 100) : 0;
      return { id: a.id, code: a.apartment_code || a.id, propertyName: (a.properties as any)?.property_name || "—", totalBeds: total, occupiedBeds: occupied, occupancyPct: pct };
    }).filter((r) => r.totalBeds > 0).sort((a, b) => a.occupancyPct - b.occupancyPct).slice(0, 8);
    const tenantName = new Map(tenants.map((t: any) => [t.id, t.full_name || t.id]));
    const earliestPayByTenantMonth = new Map<string, string>();
    for (const r of receipts as any[]) {
      if (!r.tenant_id || !r.payment_date) continue;
      const k = `${r.tenant_id}:${monthKey(r.payment_date)}`;
      const prev = earliestPayByTenantMonth.get(k);
      if (!prev || String(r.payment_date) < prev) earliestPayByTenantMonth.set(k, String(r.payment_date));
    }
    let paidOnOrBefore7th = 0;
    const paidOnFirstCount = new Map<string, number>();
    const paidMonthsCount = new Map<string, number>();
    for (const inv of fyInvoices as any[]) {
      const tId = inv.tenant_id; const mKey = monthKey(inv.billing_month || inv.due_date);
      if (!tId || !mKey) continue;
      const pay = earliestPayByTenantMonth.get(`${tId}:${mKey}`);
      if (!pay) continue;
      const day = parseInt(String(pay).slice(8, 10), 10);
      if (day <= 7) paidOnOrBefore7th += 1;
      paidMonthsCount.set(tId, (paidMonthsCount.get(tId) || 0) + 1);
      if (day === 1) paidOnFirstCount.set(tId, (paidOnFirstCount.get(tId) || 0) + 1);
    }
    const starCustomers = Array.from(paidOnFirstCount.entries()).map(([tenantId, firstCount]) => ({ tenantId, name: tenantName.get(tenantId) || tenantId, firstCount, paidMonths: paidMonthsCount.get(tenantId) || 0 })).sort((a, b) => b.firstCount - a.firstCount).slice(0, 5);
    return {
      financials: {
        totalRevenue: Math.round(totalRevenue), totalExpenses: Math.round(totalExpenseAmt), totalProfit: Math.round(totalProfit),
        pendingAmount: Math.round(pendingAmount), operationalCollections: Math.round(operationalCollections),
        ebBilled: Math.round(ebBilled), ebPaid: Math.round(ebPaid), ebMargin: Math.round(ebMargin), revPerBed,
        totalCollections: Math.round(totalCollections), depositCollections: Math.round(depositCollections), totalRefundsGiven: Math.round(totalRefundsGiven),
      },
      financialSeries, bedTypeOccupancy, needsAttention,
      tenantPayments: { paidOnOrBefore7th, starCustomers },
      announcements: announcements as any[],
      propertyStatus: rpcPropertyStatus
        ? { total: Number(rpcPropertyStatus.total ?? 0), occupied: Number(rpcPropertyStatus.occupied ?? 0), notice: Number(rpcPropertyStatus.notice ?? 0), booked: Number(rpcPropertyStatus.booked ?? 0), vacant: Number(rpcPropertyStatus.vacant ?? 0), occupancyPct: Math.round(Number(rpcPropertyStatus.occupancyPct ?? 0)) }
        : computePropertyStatus(liveBedsList, allotments),
      monthOccupancy: rpcPropertyStatus ?? null,
      rpcTenants, rpcTickets,
    };
  } catch (e: any) {
    console.error("[getExtendedStats]", e?.message);
    return {
      financials: { totalRevenue: 0, totalExpenses: 0, totalProfit: 0, pendingAmount: 0, operationalCollections: 0, ebBilled: 0, ebPaid: 0, ebMargin: 0, revPerBed: 0 },
      financialSeries: [], bedTypeOccupancy: [], needsAttention: [], tenantPayments: { paidOnOrBefore7th: 0, starCustomers: [] }, announcements: [],
    };
  }
}

export async function getBedTenantDiscrepancies(): Promise<{ bed: number; tenant: number }> {
  const allots: any[] = await safeList(
    supabase.from("tenant_allotments")
      .select("id, bed_id, tenant_id, staying_status, onboarding_date, actual_exit_date, estimated_exit_date, notice_date")
      .eq("organization_id", ORG_ID)
      .in("staying_status", ["Staying", "On-Notice", "Booked"])
  );
  const effExit = (a: any): string | null => {
    for (const v0 of [a.actual_exit_date, a.estimated_exit_date, a.notice_date]) if (v0 && String(v0).trim()) return v0;
    return null;
  };
  const win = (a: any) => {
    const s = a.onboarding_date && String(a.onboarding_date).trim() ? new Date(a.onboarding_date).getTime() : -Infinity;
    const e0 = effExit(a);
    const e = e0 && String(e0).trim() ? new Date(e0).getTime() : Infinity;
    return { start: s, end: e };
  };
  const overlaps = (group: any[]): boolean => {
    const w = group.map(win);
    for (let i = 0; i < w.length; i++) for (let j = i + 1; j < w.length; j++) if (w[i].start < w[j].end && w[j].start < w[i].end) return true;
    return false;
  };
  const byBed = new Map<string, any[]>(); const byTenant = new Map<string, any[]>();
  for (const a of allots) {
    if (a.bed_id) { if (!byBed.has(a.bed_id)) byBed.set(a.bed_id, []); byBed.get(a.bed_id)!.push(a); }
    if (a.tenant_id) { if (!byTenant.has(a.tenant_id)) byTenant.set(a.tenant_id, []); byTenant.get(a.tenant_id)!.push(a); }
  }
  let bed = 0, tenant = 0;
  for (const g of byBed.values()) if (g.length >= 2 && overlaps(g)) bed++;
  for (const g of byTenant.values()) if (g.length >= 2 && overlaps(g)) tenant++;
  return { bed, tenant };
}

export async function issueKycToken(propertyId: string, token: string): Promise<{ ok: boolean; qr?: string | null; propertyName?: string | null; reused?: boolean; error?: string }> {
  return client.action((api as any).tenants.issueKycToken, { propertyId, token });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROPERTIES
// ═══════════════════════════════════════════════════════════════════════════════

// Enriched property list — apartment/bed counts + live-bed count. Direct Supabase.
export async function listPropertiesEnriched() {
  const [properties, apartments, beds] = await Promise.all([
    safeList(supabase.from('properties').select('*').eq('organization_id', ORG_ID).order('created_at', { ascending: false })),
    safeList(supabase.from('apartments').select('*').eq('organization_id', ORG_ID)),
    safeList(supabase.from('beds').select('*').eq('organization_id', ORG_ID)),
  ]);
  const liveBeds = filterLiveBeds(beds, apartments);
  return properties.map((p: any) => {
    const propAptIds = apartments.filter((a: any) => a.property_id === p.id).map((a: any) => a.id);
    const propAptIdSet = new Set(propAptIds);
    return {
      _id: p.id, id: p.id, _creationTime: p.created_at ? new Date(p.created_at).getTime() : 0,
      code: p.code || '', name: p.property_name || p.name || '',
      property_name: p.property_name || p.name || '',
      address: p.address || undefined, city: p.city || undefined,
      status: p.status || 'live',
      apartmentCount: propAptIds.length,
      bedCount: beds.filter((b: any) => propAptIds.includes(b.apartment_id)).length,
      liveBedCount: liveBeds.filter((b: any) => propAptIdSet.has(b.apartment_id)).length,
    };
  });
}

export async function createProperty(args: { name: string; address?: string; city?: string; status: string }) {
  const existing = await safeList(supabase.from('properties').select('id').eq('organization_id', ORG_ID));
  const code = `PROP-${String(existing.length + 1).padStart(3, '0')}`;
  const row = await insertRow('properties', {
    code, name: args.name, property_name: args.name,
    address: args.address || null, city: args.city || null, status: args.status,
  });
  return row.id;
}

export async function updateProperty(id: string, updates: Record<string, any>) {
  const filtered: Record<string, any> = {};
  for (const [k, val] of Object.entries(updates)) if (val !== undefined) filtered[k] = val;
  if (Object.keys(filtered).length > 0) await updateRow('properties', id, filtered);
  return { success: true };
}

export async function deleteProperty(_id: string) {
  // Deletes disabled for now (see supabaseDb.DELETES_ENABLED).
  return deleteDisabledResult();
}

// ═══════════════════════════════════════════════════════════════════════════════
// APARTMENTS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listApartments(propertyId?: string) {
  let aptQ = supabase.from('apartments').select('*').eq('organization_id', ORG_ID);
  if (propertyId) aptQ = aptQ.eq('property_id', propertyId);
  aptQ = aptQ.order('created_at', { ascending: false });

  const [apartments, properties, beds] = await Promise.all([
    safeList(aptQ),
    safeList(supabase.from('properties').select('*').eq('organization_id', ORG_ID)),
    safeList(supabase.from('beds').select('*').eq('organization_id', ORG_ID)),
  ]);
  const propMap: Record<string, string> = {};
  properties.forEach((p: any) => { propMap[p.id] = p.property_name || p.name || p.code || 'Unknown'; });

  return apartments.map((a: any) => {
    const aptBeds = beds.filter((b: any) => b.apartment_id === a.id);
    return {
      _id: a.id, _creationTime: a.created_at ? new Date(a.created_at).getTime() : 0,
      propertyId: a.property_id, propertyName: propMap[a.property_id] || 'Unknown',
      code: a.apartment_code || a.code || '', name: a.apartment_code || a.code || '',
      floor: a.floor_number || a.floor || undefined, label: a.label || a.gender_allowed || undefined,
      type: a.apartment_type || undefined, sizeSqft: a.size_sqft || undefined,
      genderAllowed: a.gender_allowed || a.label || undefined, status: a.status || 'live',
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
      occupiedBeds: aptBeds.filter((b: any) => ['staying','occupied','on-notice','notice','booked','onboarding','booking'].includes((b.bed_lifecycle_status || '').toLowerCase())).length,
      liveBeds: aptBeds.filter((b: any) => (b.status || '').toLowerCase() === 'live').length,
    };
  });
}

export async function createApartment(args: { propertyId: string; name: string; floor?: string; status: string; data?: any }) {
  const props = await safeList(supabase.from('properties').select('code').eq('id', args.propertyId).eq('organization_id', ORG_ID));
  if (!props.length) throw new Error('Property not found');
  const d = args.data || {};
  let code = d.apartment_code || '';
  if (!code) {
    const existingApts = await safeList(supabase.from('apartments').select('id').eq('property_id', args.propertyId).eq('organization_id', ORG_ID));
    code = `${(props[0] as any).code}-${String(existingApts.length + 1).padStart(2, '0')}`;
  }
  const row = await insertRow('apartments', {
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
}

export async function updateApartment(id: string, updates: any) {
  const filtered: Record<string, any> = {};
  for (const [k, val] of Object.entries(updates as Record<string, any>)) if (val !== undefined) filtered[k] = val;
  if (Object.keys(filtered).length > 0) await updateRow('apartments', id, filtered);
  return { success: true };
}

export async function deleteApartment(_id: string) {
  return deleteDisabledResult();
}

// ═══════════════════════════════════════════════════════════════════════════════
// BEDS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listBeds(args: { apartmentId?: string; propertyId?: string }) {
  const today = new Date().toISOString().split('T')[0];
  let bedQ = supabase.from('beds').select('*').eq('organization_id', ORG_ID);
  if (args.apartmentId) bedQ = bedQ.eq('apartment_id', args.apartmentId);
  bedQ = bedQ.order('created_at', { ascending: false });

  const [beds, properties, apartments, allotments, tenants, bedRates] = await Promise.all([
    safeList(bedQ),
    safeList(supabase.from('properties').select('*').eq('organization_id', ORG_ID)),
    safeList(supabase.from('apartments').select('*').eq('organization_id', ORG_ID)),
    safeList(supabase.from('tenant_allotments').select('*').eq('organization_id', ORG_ID).in('staying_status', ['Staying', 'On-Notice', 'Booked'])),
    safeList(supabase.from('tenants').select('*').eq('organization_id', ORG_ID)),
    safeList(supabase.from('bed_rates').select('*').eq('organization_id', ORG_ID)),
  ]);

  let filteredBeds = beds;
  if (!args.apartmentId && args.propertyId) {
    const propAptIds = apartments.filter((a: any) => a.property_id === args.propertyId).map((a: any) => a.id);
    filteredBeds = beds.filter((b: any) => propAptIds.includes(b.apartment_id));
  }

  const propMap: Record<string, string> = {};
  properties.forEach((p: any) => { propMap[p.id] = p.property_name || p.name || p.code || 'Unknown'; });
  const aptMap: Record<string, string> = {};
  apartments.forEach((a: any) => { aptMap[a.id] = a.apartment_code || a.code || 'Unknown'; });
  const aptToPropId: Record<string, string> = {};
  apartments.forEach((a: any) => { aptToPropId[a.id] = a.property_id; });
  const tenantMap: Record<string, string> = {};
  tenants.forEach((t: any) => { tenantMap[t.id] = t.name || t.full_name || ''; });

  const getCurrentRate = (propertyId: string, bedType: string, toiletType: string): number | null => {
    if (!propertyId || !bedType || !toiletType) return null;
    const match = bedRates.find((r: any) =>
      r.property_id === propertyId &&
      (r.bed_type || '').toLowerCase() === bedType.toLowerCase() &&
      (r.toilet_type || '').toLowerCase() === toiletType.toLowerCase() &&
      r.from_date <= today && r.to_date >= today
    );
    return match ? Number((match as any).monthly_rate) : null;
  };

  return filteredBeds.map((b: any) => {
    const propId = aptToPropId[b.apartment_id] || '';
    const currentRate = propId ? getCurrentRate(propId, b.bed_type || '', b.toilet_type || '') : null;
    const stay = allotments.find((s: any) => s.bed_id === b.id);
    const rawStatus = (b.bed_lifecycle_status || 'vacant').toLowerCase().trim();
    const bedStatus = (rawStatus === 'staying' || rawStatus === 'occupied')
      ? 'Staying'
      : (rawStatus === 'on-notice' || rawStatus === 'notice')
      ? 'On-Notice'
      : (rawStatus === 'booked' || rawStatus === 'onboarding' || rawStatus === 'booking')
      ? 'Booked'
      : rawStatus === 'exited'
      ? 'Exited'
      : 'vacant';
    const isOccupied = ['Staying', 'On-Notice', 'Booked'].includes(bedStatus);
    return {
      _id: b.id, _creationTime: b.created_at ? new Date(b.created_at).getTime() : 0,
      propertyId: propId, apartmentId: b.apartment_id,
      propertyName: propMap[propId] || 'Unknown', apartmentName: aptMap[b.apartment_id] || 'Unknown',
      code: b.bed_code || '', type: b.bed_type || 'Single', toiletType: b.toilet_type || 'Common',
      monthlyRent: currentRate || 0, currentRate, hasActiveRate: currentRate !== null,
      status: b.status || 'live', isOccupied, bedStatus,
      tenantName: stay ? (tenantMap[(stay as any).tenant_id] || undefined) : undefined,
      tenantId: stay ? (stay as any).tenant_id : undefined,
      allotmentId: stay ? (stay as any).id : undefined,
    };
  });
}

export async function createBed(args: { propertyId: string; apartmentId: string; type: string; toiletType: string; monthlyRent: number; status: string; unitNumber?: string }) {
  const apts = await safeList(supabase.from('apartments').select('apartment_code,code').eq('id', args.apartmentId).eq('organization_id', ORG_ID));
  if (!apts.length) throw new Error('Apartment not found');
  let bedCode: string;
  if (args.unitNumber && args.unitNumber.trim()) {
    bedCode = args.unitNumber.trim();
  } else {
    const existingBeds = await safeList(supabase.from('beds').select('id').eq('apartment_id', args.apartmentId).eq('organization_id', ORG_ID));
    const aptCode = (apts[0] as any).apartment_code || (apts[0] as any).code || 'APT';
    bedCode = `${aptCode}-B${String(existingBeds.length + 1).padStart(2, '0')}`;
  }
  const row = await insertRow('beds', {
    apartment_id: args.apartmentId, bed_code: bedCode,
    bed_type: args.type, toilet_type: args.toiletType, status: args.status,
  });
  return row.id;
}

export async function updateBed(id: string, updates: any) {
  const filtered: Record<string, any> = {};
  for (const [k, val] of Object.entries(updates as Record<string, any>)) if (val !== undefined) filtered[k] = val;
  if (Object.keys(filtered).length > 0) await updateRow('beds', id, filtered);
  return { success: true };
}

export async function deleteBed(_id: string) {
  return deleteDisabledResult();
}

// ═══════════════════════════════════════════════════════════════════════════════
// TENANTS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listTenantsEnriched() {
  // Direct port of convex/tenants.ts listTenants (tenants + active allotment join).
  const tenants = await fetchAllPages((from, to) =>
    supabase.from("tenants")
      .select("id, full_name, first_name, last_name, phone, email, gender, date_of_birth, permanent_address, address, city, state, pincode, company_name, company_address, designation, profession, emergency_contact_name, emergency_contact_phone, id_proof_type, id_proof_number, id_proof_url, photo_url, kyc_completed, staying_status, tenant_rating, rating_last_computed, pan_number, created_at")
      .eq("organization_id", ORG_ID)
      .order("full_name")
      .range(from, to)
  );
  if (!tenants.length) return [];

  const tenantIds = tenants.map((t: any) => t.id);
  const allotments = await safeList(
    supabase.from("tenant_allotments")
      .select("id, tenant_id, bed_id, apartment_id, property_id, staying_status, monthly_rental, onboarding_date, actual_exit_date, balance_due, beds(bed_code), apartments(apartment_code), properties(property_name)")
      .eq("organization_id", ORG_ID)
      .in("tenant_id", tenantIds)
      .in("staying_status", ["Staying", "On-Notice", "Booked"])
      .order("created_at", { ascending: false })
  );
  const allotByTenant: Record<string, any> = {};
  for (const a of allotments) { if (!allotByTenant[a.tenant_id]) allotByTenant[a.tenant_id] = a; }

  const normStatus = (raw: string | null | undefined): string => {
    if (!raw) return "new";
    const s = raw.toLowerCase().replace(/_/g, "-");
    if (s === "on_notice" || s === "on-notice") return "on-notice";
    if (s === "staying") return "staying";
    if (s === "booked") return "booked";
    if (s === "exited") return "exited";
    if (s === "new") return "new";
    return s;
  };

  return tenants.map((t: any) => {
    const allot = allotByTenant[t.id];
    return {
      _id: t.id,
      name: t.full_name || [t.first_name, t.last_name].filter(Boolean).join(' ') || "",
      phone: t.phone || "",
      email: t.email || null,
      gender: t.gender || null,
      dateOfBirth: t.date_of_birth || null,
      permanentAddress: t.permanent_address || t.address || null,
      city: t.city || null,
      state: t.state || null,
      pincode: t.pincode || null,
      companyName: t.company_name || null,
      companyAddress: t.company_address || null,
      designation: t.designation || t.profession || null,
      idProofType: t.id_proof_type || null,
      idProofNumber: t.id_proof_number || null,
      idProofUrl: t.id_proof_url || null,
      panNumber: t.pan_number || null,
      emergencyContactName: t.emergency_contact_name || null,
      emergencyContactPhone: t.emergency_contact_phone || null,
      photoUrl: t.photo_url || null,
      onboardingDate: allot?.onboarding_date || null,
      electricityBillAmount: null,
      kycCompleted: t.kyc_completed || false,
      stayingStatus: normStatus(t.staying_status),
      tenantRating: t.tenant_rating != null ? Number(t.tenant_rating) : null,
      ratingLastComputed: t.rating_last_computed || null,
      allotmentId: allot?.id || null,
      currentBed: allot?.beds?.bed_code || null,
      currentApartment: allot?.apartments?.apartment_code || null,
      currentProperty: allot?.properties?.property_name || null,
      monthlyRental: allot ? Number(allot.monthly_rental) || 0 : 0,
      noticeDate: allot?.notice_date || null,
    };
  });
}

export async function createTenant(args: any) {
  const row = mapTenantColumns(args);
  row.full_name = args.fullName || args.full_name || row.full_name || null;
  row.phone = cleanPhone(args.phone);
  row.organization_id = ORG_ID;
  return insertRow("tenants", row);
}

export async function updateTenant(id: string, args: any) {
  if (!id) throw new Error("updateTenant: missing tenant id");
  const row = mapTenantColumns(args);
  if (args.fullName || args.full_name) row.full_name = args.fullName || args.full_name;
  if (Object.keys(row).length === 0) return { success: true };
  return updateRow("tenants", id, row);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TENANT LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

export async function listStays(tenantId?: string) {
  let q = supabase.from("tenant_allotments").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false });
  if (tenantId) q = q.eq("tenant_id", tenantId);
  return safeList(q);
}

export async function listAllotments() {
  // Direct port of convex/tenants.ts listAllotments.
  const rows = await safeList(
    supabase.from("tenant_allotments")
      .select("id, tenant_id, bed_id, apartment_id, property_id, staying_status, monthly_rental, deposit_paid, onboarding_date, actual_exit_date, balance_due, tenants(full_name, phone), beds(bed_code), apartments(apartment_code), properties(property_name)")
      .eq("organization_id", ORG_ID)
      .in("staying_status", ["Staying", "On-Notice", "Booked"])
      .order("created_at", { ascending: false })
  );
  const normStatus = (raw: string): string => {
    const s = (raw || "").toLowerCase().replace(/_/g, "-");
    if (s === "on-notice" || s === "on_notice") return "on-notice";
    return s;
  };
  return rows.map((a: any) => ({
    _id: a.id,
    tenantId: a.tenant_id,
    tenantName: a.tenants?.full_name || "—",
    phone: a.tenants?.phone || null,
    bedId: a.bed_id,
    bedCode: a.beds?.bed_code || a.bed_id || "—",
    apartmentId: a.apartment_id,
    apartmentCode: a.apartments?.apartment_code || "—",
    propertyId: a.property_id,
    propertyName: a.properties?.property_name || "—",
    stayingStatus: normStatus(a.staying_status),
    monthlyRental: Number(a.monthly_rental) || 0,
    depositPaid: Number(a.deposit_paid) || 0,
    deposit_paid: Number(a.deposit_paid) || 0,
    onboardingDate: a.onboarding_date || null,
    exitDate: a.actual_exit_date || null,
    noticeDate: null,
    balanceDue: Number(a.balance_due) || 0,
  }));
}

export async function createAllotment(args: any) {
  await assertGenderCompatible(args.tenant_id, args.bed_id);
  return insertRow("tenant_allotments", args);
}

export async function updateAllotmentStatus(args: { allotmentId: string; status: string; bedId?: string; tenantId?: string }) {
  if (["Staying", "On-Notice", "Booked"].includes(args.status)) {
    await assertGenderCompatible(args.tenantId, args.bedId);
  }
  return updateRow("tenant_allotments", args.allotmentId, { staying_status: args.status });
}

export async function recordNotice(args: { allotmentId: string; tenantId: string; bedId: string; exitDate: string; notes?: string }) {
  return insertRow("tenant_notices", {
    tenant_id: args.tenantId, allotment_id: args.allotmentId, bed_id: args.bedId,
    exit_date: args.exitDate, notes: args.notes || null,
    notice_date: new Date().toISOString().split("T")[0],
  });
}

export async function getTenantNotices(_tenantId: string) {
  return safeList(
    supabase.from("tenant_notices").select("*").eq("organization_id", ORG_ID).order("notice_date", { ascending: false })
  ) as Promise<any[]>;
}

export async function switchRoom(args: any) {
  const al = await safeList(supabase.from("tenant_allotments").select("tenant_id").eq("id", args.allotmentId));
  await assertGenderCompatible((al[0] as any)?.tenant_id, args.newBedId);
  return updateRow("tenant_allotments", args.allotmentId, {
    bed_id: args.newBedId,
    apartment_id: args.newApartmentId || undefined,
    property_id: args.newPropertyId || undefined,
  });
}

export async function deleteAllotment(_allotmentId: string, _bedId?: string) {
  return deleteDisabledResult();
}

export async function createBooking(args: any) {
  return insertRow("tenant_allotments", { ...args, staying_status: "Booked" });
}

export async function listBookings() {
  return safeList(
    supabase.from("tenant_allotments").select("*").eq("organization_id", ORG_ID).eq("staying_status", "Booked").order("created_at", { ascending: false })
  );
}

export async function createTestTenant() {
  return insertRow("tenants", { full_name: "Test Tenant", phone: cleanPhone("9999999999"), organization_id: ORG_ID });
}

export async function submitKYCForm(args: any) {
  if (!args.tenantId) throw new Error("tenantId required");
  return updateRow("tenants", args.tenantId, {
    kyc_completed: true,
    id_proof_type: args.idProofType || null,
    id_proof_number: args.idProofNumber || null,
    id_proof_url: args.idProofUrl || null,
    photo_url: args.photoUrl || null,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TENANT PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

export async function getTenantProfile(phone: string) {
  const variants = phoneVariants(cleanPhone(phone));
  const tenants = await safeList(supabase.from("tenants").select("*").eq("organization_id", ORG_ID).in("phone", variants));
  const tenant: any = tenants?.[0];
  if (!tenant) return null;
  const allotments = await safeList(
    supabase.from("tenant_allotments")
      .select("id, property_id, apartment_id, bed_id, staying_status, monthly_rental, onboarding_date, notice_date, estimated_exit_date")
      .eq("tenant_id", tenant.id).eq("organization_id", ORG_ID)
      .in("staying_status", ["Staying", "On-Notice", "Booked"]).order("created_at", { ascending: false }).limit(1)
  );
  const allotment: any = allotments?.[0] || null;
  let apartmentCode: string | null = null; let bedCode: string | null = null;
  if (allotment?.apartment_id) { const apt = await safeList(supabase.from("apartments").select("apartment_code").eq("id", allotment.apartment_id).limit(1)); apartmentCode = (apt?.[0] as any)?.apartment_code || null; }
  if (allotment?.bed_id) { const bed = await safeList(supabase.from("beds").select("bed_code").eq("id", allotment.bed_id).limit(1)); bedCode = (bed?.[0] as any)?.bed_code || null; }
  return {
    id: tenant.id, fullName: tenant.full_name, phone: tenant.phone, email: tenant.email || null,
    gender: tenant.gender || null, photoUrl: tenant.photo_url || null,
    permanentAddress: tenant.permanent_address || tenant.address || null,
    kycCompleted: tenant.kyc_completed || false, stayingStatus: tenant.staying_status || "new",
    allotmentId: allotment?.id || null, propertyId: allotment?.property_id || null,
    apartmentId: allotment?.apartment_id || null, apartmentCode, bedId: allotment?.bed_id || null, bedCode,
    monthlyRent: Number(allotment?.monthly_rental) || 0, checkInDate: allotment?.onboarding_date || null,
    noticeDate: allotment?.notice_date || null, estimatedExitDate: allotment?.estimated_exit_date || null,
  };
}

export async function getTenantLocation(phone: string) {
  const variants = phoneVariants(cleanPhone(phone));
  const { data: tenants, error: tenantErr } = await supabase
    .from("tenants").select("id, full_name, phone, staying_status, kyc_completed")
    .eq("organization_id", ORG_ID).in("phone", variants);
  if (tenantErr) return { found: false, reason: "db_error" };
  const tenant: any = tenants?.[0];
  if (!tenant) return { found: false, reason: "tenant_not_found" };
  const { data: allotments, error: allotErr } = await supabase
    .from("tenant_allotments")
    .select("id, tenant_id, property_id, apartment_id, bed_id, staying_status, monthly_rental, onboarding_date")
    .eq("tenant_id", tenant.id).eq("organization_id", ORG_ID)
    .in("staying_status", ["Staying", "On-Notice", "Booked"]).order("created_at", { ascending: false }).limit(1);
  if (allotErr) return { found: false, reason: "db_error" };
  const allotment: any = allotments?.[0];
  if (!allotment) return { found: false, reason: "no_active_allotment" };
  const { data: bed } = await supabase.from("beds").select("id, bed_code, bed_type, toilet_type").eq("id", allotment.bed_id).single();
  const { data: apartment } = await supabase.from("apartments").select("id, apartment_code, floor_number").eq("id", allotment.apartment_id).single();
  const { data: property } = await supabase.from("properties").select("id, property_name, address").eq("id", allotment.property_id).single();
  return {
    found: true,
    tenantId: tenant.id, tenantName: tenant.full_name, allotmentId: allotment.id,
    propertyId: property?.id || allotment.property_id, propertyName: property?.property_name || "", propertyAddress: property?.address || "",
    apartmentId: apartment?.id || allotment.apartment_id, apartmentName: apartment?.apartment_code || "",
    unitNumber: apartment?.apartment_code || "", floor: apartment?.floor_number?.toString() || "", buildingName: property?.property_name || "",
    bedId: bed?.id || allotment.bed_id, bedCode: bed?.bed_code || "",
    monthlyRent: Number(allotment.monthly_rental) || 0, checkInDate: allotment.onboarding_date || "",
    stayingStatus: allotment.staying_status || tenant.staying_status || "Staying",
    staying_status: allotment.staying_status || tenant.staying_status || "Staying",
    kycCompleted: tenant.kyc_completed || false, kyc_completed: tenant.kyc_completed || false,
  };
}

export async function getTenantDetails(phone: string): Promise<{
  tenant: {
    id: string; full_name: string; first_name: string; last_name: string | null;
    phone: string; email: string | null; photo_url: string | null;
    gender: string | null; date_of_birth: string | null; age: number | null;
    profession: string | null; food_preference: string | null;
    permanent_address: string | null; address: string | null;
    city: string | null; state: string | null; pincode: string | null;
    staying_status: string | null; date_of_joining: string | null;
    emergency_contact_name: string | null; emergency_contact_phone: string | null;
    emergency_contact_relationship: string | null; kyc_completed: boolean | null;
    company_name: string | null; designation: string | null;
    tenant_rating: number | null; organization_id: string;
  };
  allotment: {
    id: string; monthly_rental: number | null; onboarding_date: string | null;
    staying_status: string | null;
    properties: { property_name: string; address: string | null } | null;
    apartments: { apartment_code: string; floor: string | null } | null;
    beds: { bed_code: string } | null;
  } | null;
} | null> {
  const variants = phoneVariants(cleanPhone(phone));
  const tenants = await safeList(supabase.from("tenants").select("*").eq("organization_id", ORG_ID).in("phone", variants));
  const tenant: any = tenants?.[0];
  if (!tenant) return { tenant: null, allotment: null } as any;
  const allotments = await safeList(
    supabase.from("tenant_allotments")
      .select("*, properties(property_name,address), apartments(apartment_code,floor_number), beds(bed_code)")
      .eq("tenant_id", tenant.id).eq("organization_id", ORG_ID)
      .in("staying_status", ["Staying", "On-Notice", "Booked"]).order("created_at", { ascending: false }).limit(1)
  );
  const a: any = allotments?.[0] || null;
  const allotment = a ? {
    id: a.id, monthly_rental: Number(a.monthly_rental) || 0, onboarding_date: a.onboarding_date || null,
    staying_status: a.staying_status || null,
    properties: a.properties ? { property_name: a.properties.property_name, address: a.properties.address || null } : null,
    apartments: a.apartments ? { apartment_code: a.apartments.apartment_code, floor: a.apartments.floor_number?.toString() || null } : null,
    beds: a.beds ? { bed_code: a.beds.bed_code } : null,
  } : null;
  return { tenant, allotment } as any;
}
export async function updateTenantKyc(phone: string, fields: Record<string, any>): Promise<{ ok: boolean; tenantId?: string; error?: string }> {
  const clean = cleanPhone(phone);
  if (clean.length !== 10) return { ok: false, error: "Invalid phone number." };
  const variants = phoneVariants(clean);
  let tenant: any = null;
  for (const vv of variants) {
    const { data } = await supabase.from("tenants").select("id").eq("organization_id", ORG_ID).eq("phone", vv).maybeSingle();
    if (data) { tenant = data; break; }
  }
  if (!tenant) return { ok: false, error: "Your tenant record was not found." };
  const ALLOWED = new Set([
    "first_name", "last_name", "full_name", "gender", "date_of_birth", "food_preference", "profession",
    "email", "address", "city", "state", "pincode", "permanent_address",
    "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship", "emergency_contact_relation",
    "aadhar_number", "pan_number",
    "bank_name", "bank_branch", "bank_account_number", "bank_account_holder", "bank_ifsc",
    "company_name", "designation", "date_of_joining", "photo_url",
  ]);
  const payload: any = {};
  for (const k of Object.keys(fields || {})) if (ALLOWED.has(k)) payload[k] = fields[k] === "" ? null : fields[k];
  if (fields?.markComplete === true) payload.kyc_completed = true;
  if (Object.keys(payload).length === 0) return { ok: false, error: "Nothing to save." };
  const { error } = await supabase.from("tenants").update(payload).eq("id", tenant.id).eq("organization_id", ORG_ID);
  if (error) return { ok: false, error: error.message };
  return { ok: true, tenantId: tenant.id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ASSETS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listCategories() {
  const [cats, types] = await Promise.all([
    safeList(supabase.from("asset_categories").select("*").eq("organization_id", ORG_ID)),
    safeList(supabase.from("asset_types").select("id,category_id").eq("organization_id", ORG_ID)),
  ]);
  return cats.map((c: any) => ({
    _id: c.id, name: c.name,
    typeCount: types.filter((t: any) => t.category_id === c.id).length,
  }));
}

export async function listTypes(categoryId?: string) {
  let q = supabase.from("asset_types").select("*").eq("organization_id", ORG_ID);
  if (categoryId) q = q.eq("category_id", categoryId);
  const [types, cats] = await Promise.all([
    safeList(q),
    safeList(supabase.from("asset_categories").select("id,name").eq("organization_id", ORG_ID)),
  ]);
  const catMap: Record<string, string> = Object.fromEntries(cats.map((c: any) => [c.id, c.name]));
  return types.map((t: any) => ({
    _id: t.id, categoryId: t.category_id, categoryName: catMap[t.category_id] || "Unknown",
    name: t.name, expectedLifeMonths: t.expected_life_months ?? undefined,
    replacementCostEstimate: t.replacement_cost_estimate ?? undefined,
  }));
}

export async function listAssets(status?: string) {
  const assets = await fetchAllPages((from, to) => {
    let q = supabase.from("assets").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false }).range(from, to);
    if (status) q = q.eq("status", status);
    return q;
  });
  if (!assets.length) return [];
  const typeIds = [...new Set(assets.map((a: any) => a.asset_type_id).filter(Boolean))];
  let typeMap: Record<string, any> = {};
  let catMap: Record<string, string> = {};
  if (typeIds.length) {
    const types = await safeList(supabase.from("asset_types").select("*").in("id", typeIds));
    typeMap = Object.fromEntries(types.map((t: any) => [t.id, t]));
    const catIds = [...new Set(types.map((t: any) => t.category_id).filter(Boolean))];
    if (catIds.length) {
      const cats = await safeList(supabase.from("asset_categories").select("id,name").in("id", catIds));
      catMap = Object.fromEntries(cats.map((c: any) => [c.id, c.name]));
    }
  }
  const allocMap: Record<string, any> = {};
  try {
    const allocations = await safeList(
      supabase.from("asset_allocations")
        .select("*,properties(property_name),apartments(apartment_code),beds(bed_code)")
        .eq("organization_id", ORG_ID)
    );
    for (const alloc of allocations) allocMap[alloc.asset_id] = alloc;
  } catch {}
  let vendorMap: Record<string, string> = {};
  try {
    const vendors = await safeList(supabase.from("vendors").select("id,vendor_name").eq("organization_id", ORG_ID));
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
}

// Maintenance tickets linked to assets (grouped client-side by asset_id)
export async function listAssetMaintenance() {
  const [tickets, resolutions, issueTypes] = await Promise.all([
    fetchAllPages((from, to) =>
      supabase.from("maintenance_tickets")
        .select("id, ticket_number, asset_id, issue_type_id, status, created_at, resolved_at, closed_at, closure_cost")
        .eq("organization_id", ORG_ID)
        .not("asset_id", "is", null)
        .range(from, to)),
    fetchAllPages((from, to) =>
      supabase.from("ticket_resolutions")
        .select("ticket_id, resolution_type, service_type, total_cost, closure_summary, resolved_at")
        .range(from, to)),
    fetchAllPages((from, to) =>
      supabase.from("issue_types").select("id, name").eq("organization_id", ORG_ID).range(from, to)),
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
}

export async function getAssetStats() {
  const assets = await fetchAllPages((from, to) =>
    supabase.from("assets").select("*").eq("organization_id", ORG_ID).range(from, to)
  );
  if (!assets.length) return { totalAssets: 0, totalInvestment: 0, inWarranty: 0, needsMaintenance: 0, byCategory: [] };
  const totalInvestment = assets.reduce((sum: number, a: any) => sum + (Number(a.purchase_price) || 0), 0);
  const now = new Date().toISOString().split("T")[0];
  const inWarranty = assets.filter((a: any) => a.warranty_expiry && a.warranty_expiry > now).length;
  const needsMaintenance = assets.filter((a: any) => a.status === "maintenance").length;
  const typeIds = [...new Set(assets.map((a: any) => a.asset_type_id).filter(Boolean))];
  const catCount: Record<string, number> = {};
  if (typeIds.length) {
    const types = await safeList(supabase.from("asset_types").select("id,category_id").in("id", typeIds));
    const catIds = [...new Set(types.map((t: any) => t.category_id).filter(Boolean))];
    let catNameMap: Record<string, string> = {};
    if (catIds.length) {
      const cats = await safeList(supabase.from("asset_categories").select("id,name").in("id", catIds));
      catNameMap = Object.fromEntries(cats.map((c: any) => [c.id, c.name]));
    }
    const typeToCat: Record<string, string> = Object.fromEntries(types.map((t: any) => [t.id, catNameMap[t.category_id] || "Unknown"]));
    for (const a of assets) {
      const name = typeToCat[a.asset_type_id] || "Unknown";
      catCount[name] = (catCount[name] || 0) + 1;
    }
  }
  return {
    totalAssets: assets.length, totalInvestment, inWarranty, needsMaintenance,
    byCategory: Object.entries(catCount).map(([name, count]) => ({ name, count })),
  };
}

export async function createAssetType(args: any) {
  const row = await insertRow("asset_types", {
    category_id: args.categoryId, name: args.name,
    expected_life_months: args.expectedLifeMonths ?? null,
    depreciation_method: args.depreciationMethod ?? null,
    depreciation_years: args.depreciationYears ?? null,
    maintenance_cycle_months: args.maintenanceCycleMonths ?? null,
    replacement_cost_estimate: args.replacementCostEstimate ?? null,
  });
  return row?.id ?? row;
}

export async function createAsset(args: any) {
  const types = await safeList(supabase.from("asset_types").select("*").eq("id", args.assetTypeId));
  if (!types.length) throw new Error("Asset type not found");
  const assetType: any = types[0];
  const cats = await safeList(supabase.from("asset_categories").select("*").eq("id", assetType.category_id));
  const cat: any = cats[0];
  const existing = await safeList(supabase.from("assets").select("id").eq("organization_id", ORG_ID));
  const typePrefix = String(assetType.name).substring(0, 3).toUpperCase();
  const catPrefix = cat ? String(cat.name).substring(0, 3).toUpperCase() : "AST";
  const assetCode = `${catPrefix}-${typePrefix}-${String(existing.length + 1).padStart(5, "0")}`;
  let warrantyExpiry: string | null = null;
  if (args.purchaseDate && args.warrantyMonths) {
    const d = new Date(args.purchaseDate); d.setMonth(d.getMonth() + args.warrantyMonths);
    warrantyExpiry = d.toISOString().split("T")[0];
  }
  // Insert first (DB generates id), then set qr_code from the returned id.
  const row: any = await insertRow("assets", {
    asset_type_id: args.assetTypeId, asset_code: assetCode, serial_number: args.serialNumber ?? null,
    brand: args.brand ?? null, model: args.model ?? null,
    purchase_date: args.purchaseDate ?? null, purchase_price: args.purchasePrice ?? null,
    warranty_months: args.warrantyMonths ?? null, warranty_expiry: warrantyExpiry,
    vendor_name_manual: args.vendorNameManual ?? null, supplier_id: args.supplierId ?? null,
    invoice_number: args.invoiceNumber ?? null, invoice_date: args.invoiceDate ?? null,
    invoice_url: args.invoiceUrl ?? null, product_photo_url: args.productPhotoUrl ?? null,
    capacity_value: args.capacityValue ?? null, capacity_unit: args.capacityUnit ?? null,
    notes: args.notes ?? null, condition: args.condition ?? "new", status: args.status ?? "inventory",
  });
  const id = row?.id;
  if (id) {
    try {
      await supabase.from("assets").update({ qr_code: `https://vishful.co.in/vista/asset?id=${id}&code=${encodeURIComponent(assetCode)}` }).eq("id", id).eq("organization_id", ORG_ID);
    } catch {}
  }
  return id ?? row;
}

export async function updateAsset(assetId: string, args: any) {
  const update: Record<string, any> = {};
  const map: Record<string, string> = {
    brand: "brand", model: "model", condition: "condition", status: "status",
    purchasePrice: "purchase_price", notes: "notes", serialNumber: "serial_number",
    invoiceNumber: "invoice_number", invoiceDate: "invoice_date", warrantyExpiry: "warranty_expiry",
    warrantyMonths: "warranty_months", vendorNameManual: "vendor_name_manual", invoiceUrl: "invoice_url",
    productPhotoUrl: "product_photo_url", assetTypeId: "asset_type_id", supplierId: "supplier_id",
    purchaseDate: "purchase_date", capacityValue: "capacity_value", capacityUnit: "capacity_unit",
  };
  for (const k of Object.keys(map)) if (args[k] !== undefined) update[map[k]] = args[k];
  if (Object.keys(update).length > 0) await updateRow("assets", assetId, update);
  return { success: true };
}

export async function deleteAsset(_assetId: string) {
  return deleteDisabledResult();
}

export async function allocateAsset(args: { assetId: string; allocationType: string; propertyId?: string; apartmentId?: string; bedIds?: string[] }) {
  // Clear existing allocations for this asset, then insert the new one(s).
  try { await supabase.from("asset_allocations").delete().eq("asset_id", args.assetId).eq("organization_id", ORG_ID); } catch {}
  if (args.allocationType === "bed" && args.bedIds?.length) {
    const rows = args.bedIds.map((bedId: string) => ({
      asset_id: args.assetId, allocation_type: "bed",
      property_id: args.propertyId || null, apartment_id: args.apartmentId || null,
      bed_id: bedId, organization_id: ORG_ID,
    }));
    const { error } = await supabase.from("asset_allocations").insert(rows);
    if (error) throw new Error(`Allocate failed: ${error.message}`);
  } else {
    const { error } = await supabase.from("asset_allocations").insert({
      asset_id: args.assetId, allocation_type: args.allocationType,
      property_id: args.propertyId || null, apartment_id: args.apartmentId || null,
      bed_id: null, organization_id: ORG_ID,
    });
    if (error) throw new Error(`Allocate failed: ${error.message}`);
  }
  await updateRow("assets", args.assetId, { status: "allocated" });
  return { success: true };
}

export async function deallocateAsset(assetId: string) {
  try { await supabase.from("asset_allocations").delete().eq("asset_id", assetId).eq("organization_id", ORG_ID); } catch {}
  await updateRow("assets", assetId, { status: "inventory" });
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VENDORS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listVendors() {
  const data = await safeList(
    supabase.from("vendors").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false })
  );
  return data.map((vn: any) => ({
    id: vn.id, name: vn.vendor_name || vn.name || "",
    contactPerson: vn.contact_person || "", phone: vn.phone || "",
    email: vn.email || "", address: vn.address || "",
    gstNumber: vn.gst_number || "", panNumber: vn.pan_number || "",
    vendorRating: vn.vendor_rating || 0,
    status: vn.status || "active", createdAt: vn.created_at,
  }));
}

export async function createVendor(args: any) {
  return insertRow("vendors", {
    vendor_name: args.vendor_name, contact_person: args.contact_person ?? null,
    phone: args.phone ?? null, email: args.email ?? null, address: args.address ?? null,
    gst_number: args.gst_number ?? null, pan_number: args.pan_number ?? null,
    status: "active", created_at: new Date().toISOString(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNTING
// ═══════════════════════════════════════════════════════════════════════════════

export async function listInvoices(args: { status?: string; tenantId?: string } = {}) {
  const { status, tenantId } = args;
  let query = supabase
    .from("invoices")
    .select("id, invoice_number, tenant_id, allotment_id, property_id, apartment_id, bed_id, billing_month, rent_amount, electricity_amount, estimated_eb, late_fee, other_charges, total_amount, amount_paid, due_date, invoice_type, status, is_deleted, created_at")
    .eq("organization_id", ORG_ID)
    .or("is_deleted.is.null,is_deleted.eq.false")
    .order("created_at", { ascending: false });
  if (tenantId) query = query.eq("tenant_id", tenantId);
  const rows: any[] = await fetchAllPages((from, to) => query.range(from, to));

  const settleRows: any[] = await safeList(
    supabase.from("v_invoice_settlement_status")
      .select("invoice_id, amount_settled, amount_outstanding, invoice_amount, settlement_status")
      .eq("organization_id", ORG_ID)
  );
  const settleById = new Map<string, any>();
  for (const s of settleRows) settleById.set(s.invoice_id, s);

  const tenantIds = [...new Set(rows.map((r) => r.tenant_id).filter(Boolean))];
  const propertyIds = [...new Set(rows.map((r) => r.property_id).filter(Boolean))];
  const tenantRows: any[] = tenantIds.length
    ? await safeList(supabase.from("tenants").select("id, full_name").eq("organization_id", ORG_ID).in("id", tenantIds)) : [];
  const propRows: any[] = propertyIds.length
    ? await safeList(supabase.from("properties").select("id, property_name").eq("organization_id", ORG_ID).in("id", propertyIds)) : [];
  const tenantName = new Map<string, string>(); for (const t of tenantRows) tenantName.set(t.id, t.full_name);
  const propName = new Map<string, string>(); for (const p of propRows) propName.set(p.id, p.property_name);

  const today = new Date().toISOString().slice(0, 10);
  const mapped = rows.map((row) => {
    const s = settleById.get(row.id);
    const total = Number(row.total_amount ?? 0);
    const paid = s ? Number(s.amount_settled ?? 0) : Number(row.amount_paid ?? 0);
    const ss = s?.settlement_status;
    let st: string;
    if (ss === "paid" || (total > 0 && paid >= total)) st = "paid";
    else if (ss === "partial" || (paid > 0 && paid < total)) st = "partial";
    else if (row.due_date && row.due_date < today) st = "overdue";
    else st = "sent";
    return {
      _id: row.id, id: row.id,
      invoiceNumber: row.invoice_number || "—",
      tenantId: row.tenant_id, allotmentId: row.allotment_id, propertyId: row.property_id,
      apartmentId: row.apartment_id, bedId: row.bed_id,
      tenantName: tenantName.get(row.tenant_id) || "Unknown",
      propertyName: propName.get(row.property_id) || "",
      billingMonth: row.billing_month || "", dueDate: row.due_date || null,
      invoiceType: row.invoice_type || "regular",
      rentAmount: Number(row.rent_amount ?? 0), electricityAmount: Number(row.electricity_amount ?? 0),
      estimatedEb: Number(row.estimated_eb ?? 0), lateFee: Number(row.late_fee ?? 0),
      otherCharges: Number(row.other_charges ?? 0), totalAmount: total, paidAmount: paid,
      balance: Math.max(total - paid, 0),
      outstanding: s ? Number(s.amount_outstanding ?? 0) : Math.max(total - paid, 0),
      status: st,
    };
  });
  return status && status !== "all" ? mapped.filter((m) => m.status === status) : mapped;
}

export async function createInvoice(args: any) {
  const data = args;
  const tenantId = data.tenant_id || data.tenantId;
  if (!tenantId) throw new Error("tenantId is required");
  let allotmentId = data.allotment_id || data.allotmentId || null;
  let propertyId = data.property_id || data.propertyId || null;
  let apartmentId = data.apartment_id || data.apartmentId || null;
  let bedId = data.bed_id || data.bedId || null;
  if (!allotmentId || !propertyId) {
    const stays: any[] = await safeList(
      supabase.from("tenant_allotments")
        .select("id, property_id, apartment_id, bed_id, staying_status, created_at")
        .eq("organization_id", ORG_ID).eq("tenant_id", tenantId)
        .in("staying_status", ["Staying", "On-Notice", "Booked"])
        .order("created_at", { ascending: false }).limit(1)
    );
    const stay = stays[0];
    if (!stay) throw new Error("Tenant has no active allotment");
    allotmentId = allotmentId || stay.id;
    propertyId = propertyId || stay.property_id;
    apartmentId = apartmentId || stay.apartment_id;
    bedId = bedId || stay.bed_id;
  }
  const rent = Number(data.rent_amount ?? data.rentAmount ?? 0);
  const elec = Number(data.electricity_amount ?? data.electricityAmount ?? 0);
  const other = Number(data.other_charges ?? data.otherCharges ?? 0);
  const total = rent + elec + other;
  const today = new Date().toISOString().slice(0, 10);
  const billingMonth = data.billing_month || data.billingMonth || null;
  let invoiceNumber: string | null = null;
  try {
    const numMonth = /^\d{4}-\d{2}$/.test(String(billingMonth)) ? String(billingMonth) : today.slice(0, 7);
    const [yy, mm] = numMonth.split("-").map(Number);
    const fyStart = mm >= 4 ? yy : yy - 1;
    const fy = `${String(fyStart).slice(-2)}-${String(fyStart + 1).slice(-2)}`;
    const mmStr = numMonth.split("-")[1];
    const props: any[] = await safeList(supabase.from("properties").select("property_name").eq("id", propertyId).limit(1));
    const abbr = String(props[0]?.property_name || "UNKNO").replace(/\s+/g, "").slice(0, 5).toUpperCase().padEnd(5, "X");
    const existingInv: any[] = await safeList(supabase.from("invoices").select("id").eq("organization_id", ORG_ID).eq("property_id", propertyId));
    const running = existingInv.length + 1;
    invoiceNumber = `${abbr}/${fy}/${mmStr}/${String(running).padStart(5, "0")}`;
  } catch (e: any) { console.warn("[createInvoice] numbering failed:", e?.message); }
  const payload: any = {
    organization_id: ORG_ID, tenant_id: tenantId, allotment_id: allotmentId, property_id: propertyId,
    apartment_id: apartmentId, bed_id: bedId, billing_month: billingMonth,
    rent_amount: rent, electricity_amount: elec, other_charges: other, total_amount: total,
    due_date: data.due_date || data.dueDate || null, invoice_date: today, status: "pending", invoice_number: invoiceNumber,
  };
  const { data: row, error } = await supabase.from("invoices").insert(payload).select().single();
  if (error) throw new Error(error.message);
  const charges: Array<[string, number]> = [["rent", rent], ["electricity", elec], ["other_charges", other]];
  for (const [lineType, amount] of charges) {
    if (amount > 0) {
      try { await insertRow("invoice_line_items", { invoice_id: (row as any).id, line_type: lineType, amount, description: lineType }); }
      catch (e: any) { console.warn(`[createInvoice] line_item ${lineType} failed:`, e?.message); }
    }
  }
  return row;
}

export async function recordPayment(args: any) {
  const data = args;
  const invoiceId = data.invoice_id || data.invoiceId || null;
  const amount = Number(data.amount ?? data.amountPaid ?? 0);
  if (!amount || amount <= 0) throw new Error("Payment amount must be greater than 0");
  let tenantId = data.tenant_id || data.tenantId || null;
  let allotmentId = data.tenant_allotment_id || data.allotmentId || null;
  let propertyId = data.property_id || data.propertyId || null;
  if (invoiceId && (!tenantId || !allotmentId)) {
    const { data: inv, error: invErr } = await supabase.from("invoices").select("tenant_id, allotment_id, property_id").eq("id", invoiceId).eq("organization_id", ORG_ID).maybeSingle();
    if (invErr) throw new Error(invErr.message);
    tenantId = tenantId || (inv as any)?.tenant_id || null;
    allotmentId = allotmentId || (inv as any)?.allotment_id || null;
    propertyId = propertyId || (inv as any)?.property_id || null;
  }
  if (!tenantId || !allotmentId) throw new Error("Could not resolve tenant/allotment for receipt");
  const paymentDate = data.payment_date || data.paymentDate || new Date().toISOString().slice(0, 10);
  try {
    const refNum = String(data.reference_number ?? data.referenceNumber ?? "").trim();
    if (refNum) {
      const dupRef: any[] = await safeList(supabase.from("receipts").select("id, receipt_number, reference_number").eq("organization_id", ORG_ID).eq("reference_number", refNum).eq("is_deleted", false).limit(1));
      if (dupRef[0]) return { ok: false, duplicate: true, reason: `Duplicate payment — reference/UTR "${refNum}" is already used (receipt ${dupRef[0].receipt_number ?? "—"}).` };
    }
    const dupFp: any[] = await safeList(supabase.from("receipts").select("id, receipt_number").eq("organization_id", ORG_ID).eq("tenant_id", tenantId).eq("payment_date", paymentDate).eq("amount_paid", amount).eq("is_deleted", false).limit(1));
    if (dupFp[0]) return { ok: false, duplicate: true, reason: `Duplicate payment — this tenant already has a payment of ${amount} on ${paymentDate} (receipt ${dupFp[0].receipt_number ?? "—"}).` };
  } catch (e: any) { console.warn("[recordPayment] dup check failed, allowing:", e?.message); }
  let receiptNumber: string | null = null;
  try {
    const { data: rn, error: rnErr } = await supabase.rpc("next_receipt_number", { p_org: ORG_ID, p_property: propertyId, p_date: paymentDate });
    if (!rnErr && rn) receiptNumber = rn as string;
  } catch { /* DB default */ }
  const payload: any = {
    organization_id: ORG_ID, tenant_id: tenantId, tenant_allotment_id: allotmentId,
    amount_paid: amount, payment_date: paymentDate,
    payment_mode: data.payment_mode || data.paymentMode || null,
    reference_number: data.reference_number || data.referenceNumber || null,
    bank_account_id: data.bank_account_id || data.bankAccountId || null,
    receipt_number: receiptNumber,
  };
  const { data: row, error } = await supabase.from("receipts").insert(payload).select().single();
  if (error) {
    if ((error as any).code === "23505" || /duplicate key|unique constraint/i.test(error.message || "")) {
      return { ok: false, duplicate: true, reason: "Duplicate payment — this receipt already exists (unique constraint)." };
    }
    throw new Error(error.message);
  }
  return row;
}

export async function fetchOutstandingRecipients() {
  const dues: any[] = await safeList(
    supabase.from("v_tenant_current_dues")
      .select("tenant_id, ar_balance")
      .eq("organization_id", ORG_ID)
      .order("tenant_id", { ascending: true })
      .range(0, 99999)
  );
  const tenantIds = [...new Set(dues.map((d) => d.tenant_id).filter(Boolean))] as string[];
  if (tenantIds.length === 0) return [];
  const tenantNames = new Map<string, string>();
  const tenantPhones = new Map<string, string>();
  const tenantsMissingPhone = new Set<string>();
  const CHUNK = 200;
  for (let i = 0; i < tenantIds.length; i += CHUNK) {
    const slice = tenantIds.slice(i, i + CHUNK);
    const tRows: any[] = await safeList(
      supabase.from("tenants").select("id, full_name, phone").eq("organization_id", ORG_ID).in("id", slice)
    );
    for (const t of tRows) {
      tenantNames.set(t.id, t.full_name || "Tenant");
      if (hasUsablePhone(t.phone)) tenantPhones.set(t.id, String(t.phone));
      else tenantsMissingPhone.add(t.id);
    }
  }
  for (const id of tenantIds) if (!tenantNames.has(id)) tenantsMissingPhone.add(id);
  const recipients = selectOutstandingRecipients(dues as any, tenantNames, tenantsMissingPhone);
  return recipients.map((r) => ({ ...r, phone: tenantPhones.get(r.tenant_id) || null }));
}

export async function getInvoiceDetail(invoiceId: string) {
  const [lineItems, ebShares] = await Promise.all([
    safeList(supabase.from("invoice_line_items").select("id, invoice_id, line_type, amount, description, metadata, created_at").eq("invoice_id", invoiceId).order("created_at", { ascending: true })),
    safeList(supabase.from("eb_tenant_shares").select("*").eq("invoice_id", invoiceId)),
  ]);
  return { lineItems, ebShares };
}
export async function listAdjustments() {
  const rows: any[] = await safeList(
    supabase.from("tenant_adjustments")
      .select("id, adjustment_date, adjustment_type, category, amount, reason, reference_number, billing_month, tenant_id, allotment_id, property_id, apartment_id, bed_id, is_locked, created_at")
      .eq("organization_id", ORG_ID)
      .or("is_deleted.is.null,is_deleted.eq.false")
      .order("adjustment_date", { ascending: false })
  );
  const tenantIds = [...new Set(rows.map((r) => r.tenant_id).filter(Boolean))];
  const propertyIds = [...new Set(rows.map((r) => r.property_id).filter(Boolean))];
  const tenants: any[] = tenantIds.length ? await safeList(supabase.from("tenants").select("id, full_name").eq("organization_id", ORG_ID).in("id", tenantIds)) : [];
  const props: any[] = propertyIds.length ? await safeList(supabase.from("properties").select("id, property_name").eq("organization_id", ORG_ID).in("id", propertyIds)) : [];
  const tName = new Map<string, string>(); for (const t of tenants) tName.set(t.id, t.full_name);
  const pName = new Map<string, string>(); for (const p of props) pName.set(p.id, p.property_name);
  return rows.map((r) => ({
    id: r.id, adjustmentDate: r.adjustment_date || null, adjustmentType: r.adjustment_type || "credit_note",
    category: r.category || "others", amount: Number(r.amount ?? 0), reason: r.reason || "",
    referenceNumber: r.reference_number || "", billingMonth: r.billing_month || "",
    tenantId: r.tenant_id, tenantName: tName.get(r.tenant_id) || "Unknown",
    propertyName: pName.get(r.property_id) || "", isLocked: !!r.is_locked,
  }));
}
export async function getDepositSettlements() {
  const rows: any[] = await safeList(
    supabase.from("deposit_settlements")
      .select("id, tenant_id, allotment_id, deposit_amount, pending_rent, pending_eb, pending_late_fees, damages, other_deductions, total_deductions, refund_amount, settlement_date, status, notes, is_deleted")
      .eq("organization_id", ORG_ID).or("is_deleted.is.null,is_deleted.eq.false")
      .order("settlement_date", { ascending: false })
  );
  const tenantIds = [...new Set(rows.map((r) => r.tenant_id).filter(Boolean))];
  const tenants: any[] = tenantIds.length ? await safeList(supabase.from("tenants").select("id, full_name").eq("organization_id", ORG_ID).in("id", tenantIds)) : [];
  const tName = new Map<string, string>(); for (const t of tenants) tName.set(t.id, t.full_name);
  return rows.map((r) => {
    const totalDed = Number(r.total_deductions ?? ((Number(r.pending_rent) || 0) + (Number(r.pending_eb) || 0) + (Number(r.pending_late_fees) || 0) + (Number(r.damages) || 0) + (Number(r.other_deductions) || 0)));
    const refund = Number(r.refund_amount ?? (Number(r.deposit_amount) || 0) - totalDed);
    return {
      id: r.id, tenantName: tName.get(r.tenant_id) || "Unknown", allotmentId: r.allotment_id,
      depositAmount: Number(r.deposit_amount ?? 0), pendingRent: Number(r.pending_rent ?? 0), pendingEB: Number(r.pending_eb ?? 0),
      pendingLateFees: Number(r.pending_late_fees ?? 0), damages: Number(r.damages ?? 0), otherDeductions: Number(r.other_deductions ?? 0),
      totalDeductions: totalDed, refundAmount: refund, status: r.status || "settled", settlementDate: r.settlement_date || null, notes: r.notes || "",
    };
  });
}
export async function getExitReconciliationWorklist() {
  const rows: any[] = await safeList(
    supabase.from("v_exit_reconciliation_worklist").select("*").eq("organization_id", ORG_ID)
  );
  return rows.map((r) => {
    const duesNow = Number(r.dues_now ?? 0);
    const duesAfter = Math.round(duesNow);
    const depositHeld = Number(r.deposit_held ?? 0);
    const refund = Math.max(Math.round(depositHeld - Math.max(duesAfter, 0)), 0);
    return {
      allotmentId: r.allotment_id, tenantId: r.tenant_id, tenantName: r.tenant_name || "Unknown",
      propertyName: r.property_name || "", bedLabel: r.bed_label || r.bed_code || `${r.apartment_code || ""}-${r.bed_code || ""}`,
      actualExitDate: r.actual_exit_date || null, duesNow, depositHeld, ebAlready: Number(r.eb_already ?? 0),
      exitChargeAlready: Number(r.exit_charge_already ?? 0), settlementStatus: r.settlement_status || "", duesAfter, refund,
    };
  });
}
export async function getGstFiledWorkings() {
  const rows: any[] = await safeList(
    supabase.from("gst_monthly_workings").select("id, month, year, generated_at, generated_by, summary_json, rcm_json")
      .eq("organization_id", ORG_ID).order("year", { ascending: false }).order("month", { ascending: false })
  );
  return rows.map((r) => ({
    id: r.id, month: r.month, year: r.year, generatedAt: r.generated_at || null,
    summary: r.summary_json || {}, rcm: r.rcm_json || {},
  }));
}
export async function getTenantLedger(args: { allotmentId?: string; tenantId?: string }) {
  const { allotmentId, tenantId } = args;
  let q = supabase.from("v_tenant_ledger")
    .select("tenant_id, allotment_id, entry_date, posted_at, journal_entry_id, is_reversal_of, source_table, description, account_code, account_name, debit, credit, running_balance")
    .eq("organization_id", ORG_ID).order("entry_date", { ascending: true }).order("posted_at", { ascending: true });
  if (allotmentId) q = q.eq("allotment_id", allotmentId);
  else if (tenantId) q = q.eq("tenant_id", tenantId);
  const rows: any[] = await safeList(q);
  const reversedJe = new Set(rows.map((r) => r.is_reversal_of).filter(Boolean));
  const clean = rows.filter((r) => !r.is_reversal_of && !reversedJe.has(r.journal_entry_id));
  let totalCharges = 0, totalPayments = 0;
  for (const r of clean) { totalCharges += Number(r.debit) || 0; totalPayments += Number(r.credit) || 0; }
  const last = clean.length ? clean[clean.length - 1] : null;
  return {
    entries: clean.map((r) => ({
      entryDate: r.entry_date, accountCode: r.account_code, accountName: r.account_name, sourceTable: r.source_table,
      description: r.description, debit: Number(r.debit) || 0, credit: Number(r.credit) || 0, runningBalance: Number(r.running_balance) || 0,
    })),
    summary: { totalCharges, totalPayments, outstandingDue: last ? Number(last.running_balance) || 0 : (totalCharges - totalPayments) },
  };
}
export async function getTrialBalance(from: string, to: string) {
  const { data, error } = await supabase.rpc("get_trial_balance_detailed", { p_org: ORG_ID, p_from: from, p_to: to });
  if (error) throw new Error(error.message || JSON.stringify(error));
  const rows: any[] = Array.isArray(data) ? data : [];
  let periodDebit = 0, periodCredit = 0, cumDebit = 0, cumCredit = 0;
  for (const r of rows) {
    periodDebit += Number(r.total_debit) || 0; periodCredit += Number(r.total_credit) || 0;
    cumDebit += Number(r.cum_total_debit) || 0; cumCredit += Number(r.cum_total_credit) || 0;
  }
  return {
    rows: rows.map((r) => ({
      accountId: r.account_id, code: r.code, name: r.name, accountType: r.account_type, normalBalance: r.normal_balance, depth: Number(r.depth) || 0,
      periodDebit: Number(r.total_debit) || 0, periodCredit: Number(r.total_credit) || 0, periodBalance: Number(r.balance) || 0,
      cumDebit: Number(r.cum_total_debit) || 0, cumCredit: Number(r.cum_total_credit) || 0, cumBalance: Number(r.cum_balance) || 0,
    })),
    periodTotals: { debit: periodDebit, credit: periodCredit },
    asOfTotals: { debit: cumDebit, credit: cumCredit },
  };
}
export async function getProfitability(fyStartYear?: number) {
  const now = new Date();
  const fy = fyStartYear ?? (now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1);
  const fromDate = `${fy}-04-01`, toDate = `${fy + 1}-03-31`;
  const [invoices, expenses, ownerPays, apts, props] = await Promise.all([
    fetchAllPages((f, t) => supabase.from("invoices").select("property_id, total_amount, invoice_date, is_deleted").eq("organization_id", ORG_ID).or("is_deleted.is.null,is_deleted.eq.false").gte("invoice_date", fromDate).lte("invoice_date", toDate).range(f, t)),
    safeList(supabase.from("expenses").select("property_id, amount, expense_date").eq("organization_id", ORG_ID).gte("expense_date", fromDate).lte("expense_date", toDate)),
    safeList(supabase.from("owner_payments").select("apartment_id, escalated_amount, bill_date").eq("organization_id", ORG_ID).gte("bill_date", fromDate).lte("bill_date", toDate)),
    safeList(supabase.from("apartments").select("id, property_id").eq("organization_id", ORG_ID)),
    safeList(supabase.from("properties").select("id, property_name").eq("organization_id", ORG_ID)),
  ]);
  const aptProp = new Map<string, string>(); for (const a of apts as any[]) aptProp.set(a.id, a.property_id);
  const acc = new Map<string, { revenue: number; expense: number; rentalCost: number }>();
  const bump = (pid: string) => (acc.get(pid) || (acc.set(pid, { revenue: 0, expense: 0, rentalCost: 0 }), acc.get(pid)!));
  for (const i of invoices as any[]) { if (i.property_id) bump(i.property_id).revenue += Number(i.total_amount) || 0; }
  for (const e of expenses as any[]) { if (e.property_id) bump(e.property_id).expense += Number(e.amount) || 0; }
  for (const o of ownerPays as any[]) { const pid = aptProp.get(o.apartment_id); if (pid) bump(pid).rentalCost += Number(o.escalated_amount) || 0; }
  const pName = new Map<string, string>(); for (const p of props as any[]) pName.set(p.id, p.property_name);
  const rows = [...acc.entries()].map(([pid, v2]) => {
    const profit = v2.revenue - v2.expense - v2.rentalCost;
    return { propertyId: pid, propertyName: pName.get(pid) || "Unknown", revenue: v2.revenue, expense: v2.expense, rentalCost: v2.rentalCost, profit, margin: v2.revenue > 0 ? (profit / v2.revenue) * 100 : 0 };
  }).sort((a, b) => b.revenue - a.revenue);
  const totals = rows.reduce((s, r) => ({ revenue: s.revenue + r.revenue, expense: s.expense + r.expense, rentalCost: s.rentalCost + r.rentalCost, profit: s.profit + r.profit }), { revenue: 0, expense: 0, rentalCost: 0, profit: 0 });
  return { fyLabel: `${fy}-${String((fy + 1) % 100).padStart(2, "0")}`, rows, totals };
}

export async function previewBills(month: string, propertyId?: string) {
  const { previewBills: pv } = await import("./billing");
  return pv(month, propertyId);
}
export async function generateBills(month: string, propertyId?: string, allotmentIds?: string[]) {
  const { generateBills: gb } = await import("./billing");
  return gb(month, propertyId, allotmentIds);
}

export async function listExpenseCategories() {
  return safeList(
    supabase.from("expense_categories").select("id, key, label, is_active, sort_order").eq("organization_id", ORG_ID).order("sort_order", { ascending: true })
  );
}
export async function saveExpenseCategory(args: { id?: string; key?: string; label: string; isActive?: boolean }) {
  const { id, key, label, isActive } = args;
  const trimmed = (label || "").trim();
  if (!trimmed) throw new Error("Display label is required.");
  if (id) {
    const patch: any = { label: trimmed };
    if (isActive !== undefined) patch.is_active = isActive;
    const { data, error } = await supabase.from("expense_categories").update(patch).eq("id", id).eq("organization_id", ORG_ID).select();
    if (error) throw new Error(error.message);
    return data?.[0];
  }
  const k = (key && key.trim() ? key : trimmed).toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  if (!k) throw new Error("Category key is required.");
  const { data, error } = await supabase.from("expense_categories").insert({ organization_id: ORG_ID, key: k, label: trimmed, sort_order: 0, is_active: true }).select();
  if (error) throw new Error(error.message);
  return data?.[0];
}
export async function deleteExpenseCategory(_id: string) {
  return deleteDisabledResult();
}

export async function getPendingDues() {
  const rows: any[] = await safeList(
    supabase.from("v_tenant_current_dues").select("net_dues, ar_balance").eq("organization_id", ORG_ID)
  );
  let pending = 0;
  for (const r of rows) {
    const due = Number(r.net_dues ?? r.ar_balance ?? 0);
    if (due > 0) pending += due;
  }
  return { totalPending: Math.round(pending) };
}

export async function listBillingTenants() {
  const allots: any[] = await safeList(
    supabase.from("tenant_allotments")
      .select("id, tenant_id, property_id, apartment_id, bed_id, staying_status, monthly_rental, created_at")
      .eq("organization_id", ORG_ID)
      .in("staying_status", ["Staying", "On-Notice"])
      .order("created_at", { ascending: false })
  );
  const tenantIds = [...new Set(allots.map((a) => a.tenant_id).filter(Boolean))];
  const bedIds = [...new Set(allots.map((a) => a.bed_id).filter(Boolean))];
  const tenants: any[] = tenantIds.length ? await safeList(supabase.from("tenants").select("id, full_name").eq("organization_id", ORG_ID).in("id", tenantIds)) : [];
  const beds: any[] = bedIds.length ? await safeList(supabase.from("beds").select("id, bed_code").in("id", bedIds)) : [];
  const tName = new Map<string, string>(); for (const t of tenants) tName.set(t.id, t.full_name);
  const bCode = new Map<string, string>(); for (const b of beds) bCode.set(b.id, b.bed_code);
  const seen = new Set<string>();
  const out: any[] = [];
  for (const a of allots) {
    if (!a.tenant_id || seen.has(a.tenant_id)) continue;
    seen.add(a.tenant_id);
    out.push({
      tenantId: a.tenant_id, allotmentId: a.id, tenantName: tName.get(a.tenant_id) || "Unknown",
      bedCode: bCode.get(a.bed_id) || "", propertyId: a.property_id, apartmentId: a.apartment_id,
      bedId: a.bed_id, monthlyRent: Number(a.monthly_rental) || 0, status: "active",
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ELECTRICITY
// ═══════════════════════════════════════════════════════════════════════════════

export async function listReadings(billingMonth?: string) {
  const { listReadings: fn } = await import("./electricity");
  return fn(billingMonth);
}

export async function addReading(args: any) {
  const { addReading: fn } = await import("./electricity");
  return fn(args);
}

export async function listEbRates() {
  const { listEbRates: fn } = await import("./electricity");
  return fn();
}

export async function saveEbRate(data: any) {
  const { saveEbRate: fn } = await import("./electricity");
  return fn(data);
}

export async function deleteEbRate(id: string) {
  const { deleteEbRate: fn } = await import("./electricity");
  return fn(id);
}

export async function listApartmentsForEB(propertyId: string, billingMonth: string) {
  const { listApartmentsForEB: fn } = await import("./electricity");
  return fn(propertyId, billingMonth);
}

export async function bulkSaveReadings(args: {
  propertyId: string; billingMonth: string; unitCost: number; rows: any[];
}) {
  const { bulkSaveReadings: fn } = await import("./electricity");
  return fn(args);
}

export async function lockReadings(propertyId: string, billingMonth: string, lock: boolean) {
  const { lockReadings: fn } = await import("./electricity");
  return fn(propertyId, billingMonth, lock);
}

export async function scanMeterReading(imageUrl: string): Promise<{
  reading_value: number | null; apartment_code: string | null;
  confidence: string; unit: string; error: string | null;
}> {
  const fail = (error: string) => ({ reading_value: null, apartment_code: null, confidence: "low", unit: "kWh", error });
  if (!imageUrl) return fail("imageUrl is required");
  try {
    // Pre-existing Supabase edge function (Gemini vision) — call it directly.
    const { data, error } = await supabase.functions.invoke("scan-meter-reading", { body: { imageUrl } });
    if (error) return fail(error.message || "OCR service error");
    return (data as any) || fail("No response from OCR service");
  } catch (e: any) {
    return fail(e?.message || "OCR request failed");
  }
}

// Upload a meter photo to the shared `documents/meter-photos` bucket (the same path
// the web app uses) via the working owners.uploadDocument action, and return its
// public URL. Replaces the old uploadTicketPhoto path, which went through the no-op
// supabase storage stub and always returned null.
export async function uploadMeterPhoto(base64?: string | null): Promise<string | null> {
  if (!base64) return null;
  try {
    const { data, error } = await supabase.functions.invoke("upload_document", {
      body: { base64, fileName: `meter_${Date.now()}.jpg`, folder: "meter-photos", contentType: "image/jpeg" },
    });
    if (error) { console.warn("[uploadMeterPhoto]", error.message); return null; }
    return (data as any)?.url || null;
  } catch (e) {
    console.warn("[uploadMeterPhoto]", (e as any)?.message);
    return null;
  }
}

// Generic document/photo upload via the upload_document edge function.
export async function uploadDocument(base64: string, fileName: string, folder?: string, contentType?: string): Promise<string | null> {
  if (!base64) return null;
  try {
    const { data, error } = await supabase.functions.invoke("upload_document", {
      body: { base64, fileName, folder: folder || "owners", contentType: contentType || "image/jpeg" },
    });
    if (error) { console.warn("[uploadDocument]", error.message); return null; }
    return (data as any)?.url || null;
  } catch (e) {
    console.warn("[uploadDocument]", (e as any)?.message);
    return null;
  }
}

export async function getEBAnalytics(propertyId?: string) {
  const { getEBAnalytics: fn } = await import("./electricity");
  return fn(propertyId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TICKETS
// ═══════════════════════════════════════════════════════════════════════════════

export async function fetchTickets(role: string, userId?: string, tenantId?: string) {
  return client.action(api.tickets.listTickets, { role, userId, tenantId });
}

export async function createTicket(args: any) {
  return client.action(api.tickets.createTicket, { data: args });
}

export async function updateTicketAsset(ticketId: string, assetId: string | null) {
  const { error } = await supabase.from("maintenance_tickets")
    .update({ asset_id: assetId, updated_at: new Date().toISOString() })
    .eq("id", ticketId).eq("organization_id", ORG_ID);
  if (error) throw new Error(error.message);
  let linked_asset: any = null;
  if (assetId) {
    const { data: asset } = await supabase.from("assets").select("id, asset_code, brand, model, condition").eq("organization_id", ORG_ID).eq("id", assetId).single();
    if (asset) linked_asset = { id: asset.id, asset_code: asset.asset_code, label: [asset.brand, asset.model].filter(Boolean).join(" ") || asset.asset_code, condition: asset.condition || null };
  }
  return { success: true, asset_id: assetId, linked_asset };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS — TEAM MEMBERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getTeamMembers() {
  return safeList(
    supabase.from("team_members").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false })
  );
}

// Org member profiles (id / full_name / email) — used for name dropdowns (e.g. Audit Logs "Performed by")
export async function getOrgProfiles() {
  return safeList(supabase.from("profiles").select("id, full_name, phone, email").eq("organization_id", ORG_ID));
}

export async function createTeamMember(data: any) {
  return insertRow("team_members", { ...data, status: data.status || "active" });
}

export async function updateTeamMember(id: string, data: any) {
  return updateRow("team_members", id, data);
}

export async function deleteTeamMember(_id: string) {
  return deleteDisabledResult();
}

// Team departments (real CRUD) + org tickets for Performance tab
export async function listTeamDepartments() {
  return safeList(
    supabase.from("team_departments").select("*").eq("organization_id", ORG_ID).order("name", { ascending: true })
  );
}
export async function createTeamDepartment(data: any) {
  return insertRow("team_departments", { ...data });
}
export async function updateTeamDepartment(id: string, data: any) {
  return updateRow("team_departments", id, data);
}
export async function deleteTeamDepartment(_id: string) {
  return deleteDisabledResult();
}
export async function listOrgTickets() {
  return safeList(
    supabase.from("maintenance_tickets").select("id, assigned_to, status").eq("organization_id", ORG_ID)
  );
}

// Team payments & attendance (real persistence — replace getAll/insertRow stubs)
export async function listTeamPayments() {
  return safeList(
    supabase.from("team_payments").select("*").eq("organization_id", ORG_ID).order("payment_date", { ascending: false })
  );
}
export async function listSalaryBills(memberId?: string) {
  let q = supabase.from("team_salary_bills").select("*").eq("organization_id", ORG_ID);
  if (memberId) q = q.eq("team_member_id", memberId);
  return safeList(q.order("month", { ascending: false }));
}
export async function setSalaryBillStatus(id: string, status: string) {
  return updateRow("team_salary_bills", id, { status });
}

export async function createTeamPayment(data: any) {
  return insertRow("team_payments", { ...data });
}

export async function updateTeamPayment(id: string, data: any) {
  return updateRow("team_payments", id, data);
}

export async function deleteTeamPayment(_id: string) {
  return deleteDisabledResult();
}

export async function listTeamAttendance() {
  return safeList(
    supabase.from("team_attendance").select("*").eq("organization_id", ORG_ID).order("date", { ascending: false })
  );
}

export async function generateSalaryBills(month: string, workingDays?: number) {
  const { summarizeMonthAttendance, capPresentDays, payrollMonthRange, DEFAULT_SALARY_WORKING_DAYS } = await import("./payroll");
  const wd = workingDays ?? DEFAULT_SALARY_WORKING_DAYS;
  const { start, end } = payrollMonthRange(month);
  const [members, attendance] = await Promise.all([
    safeList(supabase.from("team_members").select("id, salary_amount, joining_date, exit_date, status").eq("organization_id", ORG_ID)),
    safeList(supabase.from("team_attendance").select("team_member_id, date, status").eq("organization_id", ORG_ID).gte("date", start).lte("date", end)),
  ]);
  const attByMember = new Map<string, { date?: string | null; status?: string | null }[]>();
  for (const a of attendance as any[]) {
    if (!a.team_member_id) continue;
    const list = attByMember.get(a.team_member_id) || [];
    list.push({ date: a.date, status: a.status });
    attByMember.set(a.team_member_id, list);
  }
  let created = 0, updated = 0, skippedPaid = 0, skippedApproved = 0, skippedEmpty = 0, failed = 0, membersConsidered = 0;
  const now = new Date();
  for (const m of members as any[]) {
    const base = Number(m.salary_amount) || 0;
    const active = String(m.status || "").toLowerCase() === "active";
    if (!active || base <= 0) continue;
    membersConsidered += 1;
    try {
      const rows = attByMember.get(m.id) || [];
      const summary = summarizeMonthAttendance(rows, month, now, m.joining_date, m.exit_date);
      const existingList = await safeList(
        supabase.from("team_salary_bills").select("id, status, advance_deducted, other_deductions")
          .eq("organization_id", ORG_ID).eq("team_member_id", m.id).eq("month", month)
      );
      const existing: any = (existingList as any[])[0];
      const existingStatus = String(existing?.status || "").toLowerCase();
      if (existingStatus === "paid") { skippedPaid += 1; continue; }
      if (existingStatus === "approved") { skippedApproved += 1; continue; }
      if (!existing && summary.recordedDays === 0) { skippedEmpty += 1; continue; }
      const present_days = capPresentDays(summary.presentUnits, wd);
      const advance_deducted = Number(existing?.advance_deducted ?? 0);
      const other_deductions = Number(existing?.other_deductions ?? 0);
      const notes = `Auto from attendance (${summary.recordedDays} days, ${summary.absentDays} absent)`;
      if (existing?.id) {
        const { error } = await supabase.from("team_salary_bills")
          .update({ working_days: wd, present_days, base_salary: base, advance_deducted, other_deductions, notes })
          .eq("id", existing.id).eq("organization_id", ORG_ID).neq("status", "paid");
        if (error) throw error;
        updated += 1;
      } else {
        const { error } = await supabase.from("team_salary_bills")
          .insert({ organization_id: ORG_ID, team_member_id: m.id, month, working_days: wd, present_days, base_salary: base, advance_deducted, other_deductions, notes, status: "draft" });
        if (error) throw error;
        created += 1;
      }
    } catch (e) { failed += 1; console.warn("[generateSalaryBills] member", m.id, (e as any)?.message || e); }
  }
  return { month, created, updated, skippedPaid, skippedApproved, skippedEmpty, failed, membersConsidered };
}

export async function createTeamAttendance(data: any) {
  return insertRow("team_attendance", { ...data });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS — USERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listUsersForSettings() {
  const [members, userRoles] = await Promise.all([
    safeList(supabase.from("team_members").select("*").eq("organization_id", ORG_ID).order("created_at", { ascending: false })),
    safeList(supabase.from("user_roles").select("user_id, role")),
  ]);
  const roleByKey: Record<string, string> = {};
  userRoles.forEach((r: any) => { if (r.user_id) roleByKey[r.user_id] = r.role; });
  return members.map((u: any) => ({
    id: u.id, user_id: u.user_id || null,
    name: `${u.first_name || ""} ${u.last_name || ""}`.trim() || u.name || "",
    phone: u.phone || "", email: u.email || undefined,
    role: (u.user_id && roleByKey[u.user_id]) || roleByKey[u.id] || "technician",
    isActive: u.status !== "inactive", specialties: u.specialties || undefined,
  }));
}

export async function addUserForSettings(args: { name: string; phone: string; email?: string; role: string; specialties?: string[] }) {
  const cleanedPhone = args.phone.replace(/\s+/g, "").replace(/^\+/, "");
  const existing = await safeList(supabase.from("team_members").select("id").eq("phone", cleanedPhone).eq("organization_id", ORG_ID).limit(1));
  if (existing.length > 0) throw new Error("User with this phone already exists");
  const parts = args.name.trim().split(" ");
  const row: any = await insertRow("team_members", {
    first_name: parts[0] || args.name, last_name: parts.slice(1).join(" ") || "",
    phone: cleanedPhone, email: args.email || null, status: "active", specialties: args.specialties || null,
  });
  if (args.role && row.id) {
    await supabase.from("user_roles").insert({ user_id: row.id, role: args.role });
  }
  return row.id;
}

export async function updateUserForSettings(userId: string, args: any) {
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
  if (args.role !== undefined) {
    const { data: member } = await supabase.from("team_members").select("user_id").eq("id", userId).maybeSingle();
    const roleKey = (member as any)?.user_id || userId;
    const existing = await safeList(supabase.from("user_roles").select("id").eq("user_id", roleKey).limit(1));
    if (existing.length > 0) await supabase.from("user_roles").update({ role: args.role }).eq("user_id", roleKey);
    else await supabase.from("user_roles").insert({ user_id: roleKey, role: args.role });
  }
  return { success: true };
}

export async function updateProfile(args: { userId: string; name: string; email?: string; organizationName?: string }) {
  const parts = args.name.trim().split(" ");
  await updateRow("team_members", args.userId, {
    first_name: parts[0] || args.name, last_name: parts.slice(1).join(" ") || "", email: args.email || undefined,
  });
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS — BED RATES
// ═══════════════════════════════════════════════════════════════════════════════

export async function listBedRates(propertyId?: string) {
  let q = supabase.from("bed_rates").select("*").eq("organization_id", ORG_ID);
  if (propertyId) q = q.eq("property_id", propertyId);
  return safeList(q.order("from_date", { ascending: false }));
}

export async function createBedRate(args: any) {
  const row: any = await insertRow("bed_rates", {
    property_id: args.propertyId, bed_type: args.bedType, toilet_type: args.toiletType,
    monthly_rate: args.monthlyRate, from_date: toISODate(args.fromDate), to_date: toISODate(args.toDate),
  });
  return row.id;
}

export async function updateBedRate(id: string, args: any) {
  const d: Record<string, any> = {};
  if (args.bedType !== undefined) d.bed_type = args.bedType;
  if (args.toiletType !== undefined) d.toilet_type = args.toiletType;
  if (args.monthlyRate !== undefined) d.monthly_rate = args.monthlyRate;
  if (args.fromDate !== undefined) d.from_date = toISODate(args.fromDate);
  if (args.toDate !== undefined) d.to_date = toISODate(args.toDate);
  if (Object.keys(d).length > 0) await updateRow("bed_rates", id, d);
  return { success: true };
}

export async function deleteBedRate(_id: string) {
  return deleteDisabledResult();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS — LABELS, PERMISSIONS, ORG
// ═══════════════════════════════════════════════════════════════════════════════

export async function listApartmentLabels() {
  return safeList(supabase.from("apartment_labels").select("*").eq("organization_id", ORG_ID));
}

export async function createApartmentLabel(args: { label: string; description?: string }) {
  return insertRow("apartment_labels", { label: args.label, description: args.description || null });
}

export async function deleteApartmentLabel(_id: string) {
  return deleteDisabledResult();
}

export async function getPermissions(role: string) {
  return safeList(supabase.from("role_permissions").select("*").eq("organization_id", ORG_ID).eq("role", role));
}

export async function setPermissions(role: string, permissions: { module: string; can_create: boolean; can_read: boolean; can_update: boolean; can_delete: boolean }[]) {
  for (const perm of permissions) {
    const existing = await safeList(
      supabase.from("role_permissions").select("id").eq("organization_id", ORG_ID).eq("role", role).eq("module", perm.module).limit(1)
    );
    if (existing.length > 0) {
      await updateRow("role_permissions", existing[0].id, {
        can_create: perm.can_create, can_read: perm.can_read, can_update: perm.can_update, can_delete: perm.can_delete,
        updated_at: new Date().toISOString(),
      });
    } else {
      await insertRow("role_permissions", {
        organization_id: ORG_ID, role, module: perm.module,
        can_create: perm.can_create, can_read: perm.can_read, can_update: perm.can_update, can_delete: perm.can_delete,
      });
    }
  }
  return { success: true };
}

export async function getOrgSettings() {
  // Org settings live on the `organizations` row (PK id = ORG_ID); no org_settings table.
  const rows = await safeList(
    supabase.from("organizations").select("*").eq("id", ORG_ID).limit(1)
  );
  if (rows.length > 0) {
    const r: any = rows[0];
    return {
      costApprovalThreshold: r.ticket_auto_approve_threshold ?? 5000,
      organizationName: r.organization_name || "Vishful Spaces LLP",
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
}

export async function updateOrgSettings(args: any) {
  const updates: Record<string, any> = {};
  if (args.costApprovalThreshold !== undefined) updates.ticket_auto_approve_threshold = args.costApprovalThreshold;
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
  if (Object.keys(updates).length > 0) await updateRow("organizations", ORG_ID, updates);
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORTS (proxy to Convex)
// ═══════════════════════════════════════════════════════════════════════════════

export async function getMaintenanceReport(startDate: string, endDate: string) {
  return client.action(api.reports.getMaintenanceReport, { startDate, endDate });
}

export async function getOccupancyReport() {
  return client.action(api.reports.getOccupancyReport, {});
}
// ─── REPORTS period helpers (ported from convex/reports.ts) ──────────────────
type ReportingPeriod = "current_fy" | "last_fy" | "last_2fy" | "last_5y" | "from_beginning";
function rptFYStartYear(date: Date = new Date()): number {
  return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
}
function rptPeriodDateRange(period: ReportingPeriod): { from: Date; to: Date } {
  const today = new Date();
  const fyStartYear = rptFYStartYear(today);
  switch (period) {
    case "last_fy": return { from: new Date(fyStartYear - 1, 3, 1), to: new Date(fyStartYear, 2, 31) };
    case "last_2fy": return { from: new Date(fyStartYear - 2, 3, 1), to: today };
    case "last_5y": { const d = new Date(today); d.setFullYear(d.getFullYear() - 5); return { from: d, to: today }; }
    case "from_beginning": return { from: new Date(2020, 0, 1), to: today };
    case "current_fy":
    default: return { from: new Date(fyStartYear, 3, 1), to: today };
  }
}
function rptFmtMonth(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function rptFmtDay(d: Date): string { return `${rptFmtMonth(d)}-${String(d.getDate()).padStart(2, "0")}`; }
function rptInPeriod(dateStr: string | null | undefined, from: Date, to: Date): boolean {
  if (!dateStr) return false;
  const key = dateStr.slice(0, 7);
  return key >= rptFmtMonth(from) && key <= rptFmtMonth(to);
}
function rptMetricsRpcArgs(period: ReportingPeriod, from: Date, to: Date): any {
  const presetMap: Record<string, string> = { current_fy: "current_fy", last_fy: "last_fy", from_beginning: "all_time" };
  const args: any = { p_organization_id: ORG_ID };
  if (presetMap[period]) args.p_period = presetMap[period];
  else { args.p_period = "custom"; args.p_from = rptFmtDay(from); args.p_to = rptFmtDay(to); }
  return args;
}
const RPT_TERMINAL = new Set(["completed", "closed", "cancelled"]);

export async function getReportsSummary(period: string) {
  const { from, to } = rptPeriodDateRange((period || "current_fy") as ReportingPeriod);
  const [invoices, receipts, expenses, allotments, apartments, beds, tickets, settlements, adjustments] = await Promise.all([
    fetchAllPages((f, t) => supabase.from("invoices").select("*").eq("organization_id", ORG_ID).eq("is_deleted", false).range(f, t)),
    fetchAllPages((f, t) => supabase.from("receipts").select("*").eq("organization_id", ORG_ID).eq("is_deleted", false).range(f, t)),
    safeList(supabase.from("expenses").select("*").eq("organization_id", ORG_ID)),
    fetchAllPages((f, t) => supabase.from("tenant_allotments").select("tenant_id,bed_id,staying_status").eq("organization_id", ORG_ID).range(f, t)),
    safeList(supabase.from("apartments").select("id,property_id,status").eq("organization_id", ORG_ID)),
    safeList(supabase.from("beds").select("id,apartment_id,status").eq("organization_id", ORG_ID)),
    safeList(supabase.from("maintenance_tickets").select("id,status,created_at").eq("organization_id", ORG_ID)),
    safeList(supabase.from("deposit_settlements").select("*").eq("organization_id", ORG_ID)),
    safeList(supabase.from("tenant_adjustments").select("*").eq("organization_id", ORG_ID)),
  ]);
  const inRange = (d: string | null | undefined) => rptInPeriod(d, from, to);
  let acct: any = {};
  try {
    const { data: rpcData, error: rpcErr } = await supabase.rpc("get_universal_metrics_v2", rptMetricsRpcArgs((period || "current_fy") as ReportingPeriod, from, to));
    if (rpcErr) throw rpcErr;
    const payload = Array.isArray(rpcData) ? rpcData[0] : rpcData;
    acct = payload?.accounting || {};
  } catch (rpcE: any) {
    console.warn("[reports] get_universal_metrics_v2 failed, using fallback:", rpcE?.message);
  }
  const rpcEmpty = !acct || Object.keys(acct).length === 0;
  const fb = rpcEmpty ? computeAccountingMetrics(invoices, receipts, expenses, adjustments, settlements, inRange) : null;
  const pInvoices = invoices.filter((i: any) => inRange(i.billing_month || i.invoice_date));
  const totalRentalRevenue = pInvoices.reduce((s: number, i: any) => s + Number(i.rent_amount || 0), 0);
  const totalInvoiced = Number(acct.totalRevenue ?? fb?.totalInvoiced ?? 0);
  const totalEbCharged = Number(acct.totalEbCharged ?? pInvoices.reduce((s: number, i: any) => s + Number(i.electricity_amount || 0), 0));
  const totalCollections = Number(acct.totalCollections ?? fb?.totalCollections ?? 0);
  const depositCollections = Number(acct.depositCollections ?? fb?.depositCollections ?? 0);
  const totalCollectionsWithoutDeposit = Number(acct.totalCollectionsWithoutDeposit ?? fb?.totalCollectionsWithoutDeposit ?? 0);
  const totalRefundsGiven = Number(acct.totalRefundsGiven ?? fb?.totalRefundsGiven ?? 0);
  const totalPendingCollection = Number(acct.totalPendingCollection ?? fb?.totalPendingCollection ?? 0);
  const totalExpenses = Number(acct.totalExpenses ?? fb?.totalExpenses ?? 0);
  const totalProfit = Number(acct.totalProfit ?? fb?.totalProfit ?? 0);
  const activeIds = new Set<string>(); const bookedIds = new Set<string>(); const allIds = new Set<string>();
  for (const a of allotments as any[]) {
    if (!a.tenant_id) continue;
    allIds.add(a.tenant_id);
    if (a.staying_status === "Staying" || a.staying_status === "On-Notice") activeIds.add(a.tenant_id);
    else if (a.staying_status === "Booked") bookedIds.add(a.tenant_id);
  }
  const liveBeds = mFilterLiveBeds(beds, apartments);
  const ps = computePropertyStatus(liveBeds, allotments);
  const pTickets = (tickets as any[]).filter((t: any) => rptInPeriod(t.created_at, from, to));
  const ticketClosed = pTickets.filter((t: any) => RPT_TERMINAL.has((t.status || "").toLowerCase())).length;
  return {
    period,
    accounting: {
      totalRentalRevenue, totalEbCharged, totalInvoiced,
      totalCollections, totalCollectionsWithoutDeposit, depositCollections,
      totalRefundsGiven, totalPendingCollection, totalExpenses, totalProfit,
    },
    tenants: { totalUniqueTenants: allIds.size, activeTenants: activeIds.size, bookedTenants: bookedIds.size },
    propertyStatus: { total: ps.total, occupied: ps.occupied, vacant: ps.vacant, booked: ps.booked, notice: ps.notice, occupancyPct: ps.occupancyPct },
    tickets: { total: pTickets.length, open: pTickets.length - ticketClosed, closed: ticketClosed, needsTenantApproval: pTickets.filter((t: any) => t.status === "pending_tenant_approval").length },
  };
}
export async function getOccupancyDetail() {
  return client.action((api as any).reports.getOccupancyDetail, {});
}
export async function getPropertyPnL(period: string) {
  const { from, to } = rptPeriodDateRange((period || "current_fy") as ReportingPeriod);
  const [properties, apartments, beds, invoices, expenses, allotments] = await Promise.all([
    safeList(supabase.from("properties").select("*").eq("organization_id", ORG_ID)),
    safeList(supabase.from("apartments").select("id,property_id,status").eq("organization_id", ORG_ID)),
    safeList(supabase.from("beds").select("id,apartment_id,status,bed_lifecycle_status").eq("organization_id", ORG_ID)),
    fetchAllPages((f, t) => supabase.from("invoices").select("*").eq("organization_id", ORG_ID).eq("is_deleted", false).range(f, t)),
    safeList(supabase.from("expenses").select("*").eq("organization_id", ORG_ID)),
    safeList(supabase.from("tenant_allotments").select("bed_id,staying_status").eq("organization_id", ORG_ID).in("staying_status", ["Staying", "On-Notice", "Booked"])),
  ]);
  const liveBedsAll = mFilterLiveBeds(beds, apartments);
  return properties.map((prop: any) => {
    const propAptIds = apartments.filter((a: any) => a.property_id === prop.id).map((a: any) => a.id);
    const propInvoices = invoices.filter((i: any) => i.property_id === prop.id && rptInPeriod(i.billing_month || i.invoice_date, from, to));
    const revenue = propInvoices.reduce((s: number, i: any) => s + Number(i.total_amount || 0), 0);
    const rentRevenue = propInvoices.reduce((s: number, i: any) => s + Number(i.rent_amount || 0), 0);
    const ebBilled = propInvoices.reduce((s: number, i: any) => s + Number(i.electricity_amount || 0), 0);
    const propExpenses = expenses.filter((e: any) => e.property_id === prop.id && rptInPeriod(e.expense_date || e.billing_month, from, to));
    const totalExpense = propExpenses.reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
    const ebActual = propExpenses.filter((e: any) => (e.cat?.key || e.category) === "eb_actual").reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
    const propAptIdSet = new Set(propAptIds);
    const propLiveBeds = liveBedsAll.filter((b: any) => propAptIdSet.has(b.apartment_id));
    const pps = computePropertyStatus(propLiveBeds, allotments);
    const occupiedBeds = pps.occupied + pps.notice;
    const profit = revenue - totalExpense;
    return {
      id: prop.id, property_name: prop.property_name || prop.name || prop.code || "Unknown",
      revenue, rentRevenue, ebBilled, ebActual, totalExpense, profit,
      totalBeds: pps.total, occupiedBeds, occupancy: pps.occupancyPct,
      ebVariance: ebBilled - ebActual, revPerBed: occupiedBeds > 0 ? Math.round(revenue / occupiedBeds) : 0,
    };
  });
}
export async function getBedProfitability(period: string) {
  const { from, to } = rptPeriodDateRange((period || "current_fy") as ReportingPeriod);
  const [beds, apartments, properties, invoices, expenses] = await Promise.all([
    safeList(supabase.from("beds").select("*").eq("organization_id", ORG_ID)),
    safeList(supabase.from("apartments").select("*").eq("organization_id", ORG_ID)),
    safeList(supabase.from("properties").select("*").eq("organization_id", ORG_ID)),
    fetchAllPages((f, t) => supabase.from("invoices").select("*").eq("organization_id", ORG_ID).eq("is_deleted", false).range(f, t)),
    safeList(supabase.from("expenses").select("*").eq("organization_id", ORG_ID)),
  ]);
  const liveBeds = mFilterLiveBeds(beds, apartments);
  return liveBeds.map((bed: any) => {
    const apt = apartments.find((a: any) => a.id === bed.apartment_id);
    const prop = apt ? properties.find((p: any) => p.id === apt.property_id) : null;
    const revenue = invoices.filter((i: any) => i.bed_id === bed.id && rptInPeriod(i.billing_month || i.invoice_date, from, to)).reduce((s: number, i: any) => s + Number(i.total_amount || 0), 0);
    const directCost = expenses.filter((e: any) => e.bed_id === bed.id && rptInPeriod(e.expense_date || e.billing_month, from, to)).reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
    const propBeds = apt ? liveBeds.filter((b: any) => { const bApt = apartments.find((a: any) => a.id === b.apartment_id); return bApt && bApt.property_id === apt.property_id; }) : [];
    const sharedCost = (prop ? expenses.filter((e: any) => e.property_id === prop.id && !e.apartment_id && !e.bed_id && rptInPeriod(e.expense_date || e.billing_month, from, to)).reduce((s: number, e: any) => s + Number(e.amount || 0), 0) : 0) / (propBeds.length || 1);
    const profit = revenue - directCost - sharedCost;
    return {
      bed_code: bed.bed_code || bed.code || "—", bed_type: bed.bed_type || "—",
      property_name: prop?.property_name || prop?.name || "—", apartment_code: apt?.apartment_code || apt?.code || "—",
      revenue, totalCost: Math.round(directCost + sharedCost), profit: Math.round(profit), isLoss: profit < 0,
    };
  }).sort((a: any, b: any) => b.revenue - a.revenue);
}
export async function getEBReconciliation(period: string) {
  const { from, to } = rptPeriodDateRange((period || "current_fy") as ReportingPeriod);
  const [properties, invoices, expenses] = await Promise.all([
    safeList(supabase.from("properties").select("*").eq("organization_id", ORG_ID)),
    fetchAllPages((f, t) => supabase.from("invoices").select("*").eq("organization_id", ORG_ID).eq("is_deleted", false).range(f, t)),
    safeList(supabase.from("expenses").select("*").eq("organization_id", ORG_ID)),
  ]);
  return properties.map((prop: any) => {
    const propInvoices = invoices.filter((i: any) => i.property_id === prop.id && rptInPeriod(i.billing_month || i.invoice_date, from, to));
    const ebBilled = propInvoices.reduce((s: number, i: any) => s + Number(i.electricity_amount || 0), 0);
    const ebActual = expenses.filter((e: any) => e.property_id === prop.id && (e.cat?.key || e.category) === "eb_actual" && rptInPeriod(e.expense_date || e.billing_month, from, to)).reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
    const variance = ebBilled - ebActual;
    return {
      property_name: prop.property_name || prop.name || prop.code || "Unknown",
      ebBilled, ebActual, variance, variancePct: ebActual > 0 ? Math.round((variance / ebActual) * 100) : 0,
    };
  }).filter((r: any) => r.ebBilled > 0 || r.ebActual > 0);
}
export async function listScopedProperties() {
  return client.action((api as any).reports.listScopedProperties, {});
}
export async function getAvailabilityData(propertyId: string) {
  return client.action((api as any).reports.getAvailabilityData, { propertyId });
}

export async function getRevenueReport(billingMonth: string) {
  return client.action(api.reports.getRevenueReport, { billingMonth });
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOGS / WHATSAPP LOGS / MARKET AI (proxy to Convex)
// ═══════════════════════════════════════════════════════════════════════════════

export async function listAuditLogs(args: {
  page?: number; pageSize?: number; tableName?: string;
  action?: string; performedBy?: string; from?: string; to?: string;
} = {}) {
  return client.action((api as any).auditlogs.listAuditLogs, args);
}

export async function listWhatsappJobs(args: { jobType?: string; limit?: number } = {}) {
  return client.action((api as any).whatsapplogs.listWhatsappJobs, args);
}
export async function listWhatsappJobDeliveries(jobId: string) {
  return client.action((api as any).whatsapplogs.listJobDeliveries, { jobId });
}
export async function searchWhatsappDeliveries(term: string) {
  return client.action((api as any).whatsapplogs.searchWhatsappDeliveries, { term });
}
export async function resendWhatsappDelivery(deliveryId: string) {
  return client.action((api as any).whatsapplogs.resendDelivery, { deliveryId });
}
export async function updateTenantPhoneAndResend(tenantId: string, newPhone: string, deliveryId: string) {
  return client.action((api as any).whatsapplogs.updateTenantPhoneAndResend, { tenantId, newPhone, deliveryId });
}
export async function resendAllFailedWhatsappDeliveries(jobId: string) {
  return client.action((api as any).whatsapplogs.resendAllFailed, { jobId });
}
export async function resumeWhatsappJob(jobId: string) {
  return client.action((api as any).whatsapplogs.resumeJob, { jobId });
}

export async function getMarketCompetitors(args: { limit?: number } = {}) {
  return client.action((api as any).market.getMarketCompetitors, args);
}
export async function getExpansionOpportunities() {
  return client.action((api as any).market.getExpansionOpportunities, {});
}
export async function triggerMarketScan() {
  return client.action((api as any).market.triggerMarketScan, {});
}
export async function retryMarketIntel() {
  return client.action((api as any).market.retryMarketIntel, {});
}
// Tracked-locality CRUD (Market Settings tab)
export async function getTrackedLocalities() {
  return client.action((api as any).market.getTrackedLocalities, {});
}
export async function upsertTrackedLocality(localityName: string, city: string) {
  return client.action((api as any).market.upsertTrackedLocality, { localityName, city });
}
export async function toggleTrackedLocality(trackingId: string) {
  return client.action((api as any).market.toggleTrackedLocality, { trackingId });
}
export async function removeTrackedLocality(trackingId: string) {
  return client.action((api as any).market.removeTrackedLocality, { trackingId });
}
export async function toggleCityWideScan(city: string) {
  return client.action((api as any).market.toggleCityWideScan, { city });
}
export async function getMarketSummary() {
  return client.action((api as any).market.getMarketSummary, {});
}
export async function getMarketBenchmark() {
  return client.action((api as any).market.getMarketBenchmark, {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC CRUD (kept for backward compatibility)
// ═══════════════════════════════════════════════════════════════════════════════

export async function getAll(table: string, _orgScoped = true): Promise<any[]> {
  // Fallback — specific functions above should be used instead
  console.warn(`[supabaseService] getAll('${table}') called — use specific functions instead`);
  return [];
}

export async function getFiltered(table: string, filters: Record<string, any>, _orgScoped = true): Promise<any[]> {
  console.warn(`[supabaseService] getFiltered('${table}') called — use specific functions instead`);
  return [];
}

export async function getPropertyPerformanceData(propertyId: string) {
  const [allotments, tickets, apartments, beds, invoices, property] = await Promise.all([
    safeList(supabase.from('tenant_allotments')
      .select('id, tenant_id, bed_id, apartment_id, property_id, staying_status, onboarding_date, actual_exit_date, estimated_exit_date, notice_date, monthly_rental, tenants(full_name,phone)')
      .eq('organization_id', ORG_ID).eq('property_id', propertyId).not('onboarding_date', 'is', null)),
    safeList(supabase.from('maintenance_tickets')
      .select('id, apartment_id, created_at, status').eq('organization_id', ORG_ID).eq('property_id', propertyId)),
    safeList(supabase.from('apartments')
      .select('id, apartment_code, status, end_date, start_date, floor_number').eq('organization_id', ORG_ID).eq('property_id', propertyId)),
    safeList(supabase.from('beds')
      .select('id, apartment_id, bed_type, toilet_type, status, bed_lifecycle_status').eq('organization_id', ORG_ID)),
    safeList(supabase.from('invoices')
      .select('id, bed_id, apartment_id, total_amount, rent_amount, billing_month, status, property_id').eq('organization_id', ORG_ID).eq('property_id', propertyId)),
    (async () => {
      try {
        const { data } = await supabase.from('properties')
          .select('id, property_name, start_date, kyc_qr_code, address, city')
          .eq('id', propertyId).eq('organization_id', ORG_ID).single();
        return data;
      } catch { return null; }
    })(),
  ]);
  const aptIds = new Set(apartments.map((a: any) => a.id));
  const propBeds = beds.filter((b: any) => aptIds.has(b.apartment_id));
  return { allotments, tickets, apartments, beds: propBeds, invoices, property };
}

export async function getBedHistory(bedId: string) {
  const [allotments, invoices] = await Promise.all([
    safeList(supabase.from('tenant_allotments')
      .select('id, tenant_id, onboarding_date, actual_exit_date, staying_status, tenants(full_name, phone)')
      .eq('bed_id', bedId).eq('organization_id', ORG_ID).order('onboarding_date', { ascending: true })),
    safeList(supabase.from('invoices')
      .select('amount_paid, tenant_id').eq('bed_id', bedId).eq('organization_id', ORG_ID)),
  ]);
  return { allotments, invoices };
}

export async function createApartmentFull(propertyId: string, data: any) {
  return createApartment({ propertyId, name: data.apartment_code || '', status: data.status || 'live', data });
}

export async function listAllocations() {
  // No embedded joins — fetch plainly then stitch (mirrors convex port).
  const allocs = await safeList(
    supabase.from("asset_allocations")
      .select("id, asset_id, allocation_type, property_id, apartment_id, bed_id, allocated_date, created_at")
      .eq("organization_id", ORG_ID)
      .order("created_at", { ascending: false })
  );
  if (!allocs.length) return [];
  const assetIds = [...new Set(allocs.map((a: any) => a.asset_id).filter(Boolean))];
  const propIds  = [...new Set(allocs.map((a: any) => a.property_id).filter(Boolean))];
  const aptIds   = [...new Set(allocs.map((a: any) => a.apartment_id).filter(Boolean))];
  const bedIds   = [...new Set(allocs.map((a: any) => a.bed_id).filter(Boolean))];
  const [assetsRows, propRows, aptRows, bedRows] = await Promise.all([
    assetIds.length ? safeList(supabase.from("assets").select("id, asset_code, brand, model, purchase_price, asset_type_id").in("id", assetIds)) : Promise.resolve([]),
    propIds.length  ? safeList(supabase.from("properties").select("id, property_name").in("id", propIds)) : Promise.resolve([]),
    aptIds.length   ? safeList(supabase.from("apartments").select("id, apartment_code").in("id", aptIds)) : Promise.resolve([]),
    bedIds.length   ? safeList(supabase.from("beds").select("id, bed_code").in("id", bedIds)) : Promise.resolve([]),
  ]);
  const typeIds = [...new Set((assetsRows as any[]).map((a: any) => a.asset_type_id).filter(Boolean))];
  const typeRows = typeIds.length ? await safeList(supabase.from("asset_types").select("id, name, category_id").in("id", typeIds)) : [];
  const catIds = [...new Set((typeRows as any[]).map((t: any) => t.category_id).filter(Boolean))];
  const catRows = catIds.length ? await safeList(supabase.from("asset_categories").select("id, name").in("id", catIds)) : [];
  const typeMap = Object.fromEntries((typeRows as any[]).map((t: any) => [t.id, t]));
  const catMap: Record<string, string> = Object.fromEntries((catRows as any[]).map((c: any) => [c.id, c.name]));
  const assetMap = Object.fromEntries((assetsRows as any[]).map((a: any) => {
    const t = typeMap[a.asset_type_id];
    return [a.id, {
      asset_code: a.asset_code, brand: a.brand, model: a.model, purchase_price: a.purchase_price,
      asset_types: t ? { name: t.name, asset_categories: { name: catMap[t.category_id] || null } } : null,
    }];
  }));
  const propMap = Object.fromEntries((propRows as any[]).map((p: any) => [p.id, { property_name: p.property_name }]));
  const aptMap  = Object.fromEntries((aptRows  as any[]).map((a: any) => [a.id, { apartment_code: a.apartment_code }]));
  const bedMap  = Object.fromEntries((bedRows  as any[]).map((b: any) => [b.id, { bed_code: b.bed_code }]));
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
}
// Bed-scoped allocation lookup — returns only the requesting bed's asset
// allocation (or null), not the whole org's allocations table.
export async function getAllocationForBed(bedId: string) {
  const { data: alloc } = (await supabase
    .from("asset_allocations")
    .select("id, asset_id, allocation_type, bed_id")
    .eq("organization_id", ORG_ID).eq("allocation_type", "bed").eq("bed_id", bedId)
    .maybeSingle()) as any;
  if (!alloc?.asset_id) return null;
  const { data: asset } = (await supabase
    .from("assets").select("id, asset_code, brand, model")
    .eq("organization_id", ORG_ID).eq("id", alloc.asset_id).maybeSingle()) as any;
  if (!asset) return null;
  return {
    asset_id: alloc.asset_id,
    assets: { brand: asset.brand ?? null, model: asset.model ?? null, asset_code: asset.asset_code ?? null },
  };
}
export async function updateVendor(vendorId: string, data: any) {
  const patch: any = {};
  for (const k of ["vendor_name","contact_person","phone","email","address","gst_number","pan_number","status"]) {
    if (data[k] !== undefined) patch[k] = data[k];
  }
  const { error } = await supabase.from("vendors").update(patch).eq("id", vendorId).eq("organization_id", ORG_ID);
  if (error) throw new Error(error.message);
  return { success: true };
}
export async function deleteVendor(_vendorId: string) {
  return deleteDisabledResult();
}
export async function updateVendorRating(vendorId: string, rating: number) {
  const { error } = await supabase.from("vendors").update({ vendor_rating: rating }).eq("id", vendorId).eq("organization_id", ORG_ID);
  if (error) throw new Error(error.message);
  return { success: true };
}
export async function createCategory(name: string) {
  return insertRow("asset_categories", { name, created_at: new Date().toISOString() });
}

export async function getAssetDetail(assetId: string) {
  const [assetRes, allocRes, maintRes, payRes, moveRes, ticketRes] = await Promise.all([
    supabase.from("assets")
      .select("*, asset_types(name, expected_life_months, asset_categories(name)), vendors(vendor_name, phone, email, gst_number)")
      .eq("id", assetId).single(),
    supabase.from("asset_allocations")
      .select("*, properties(property_name), apartments(apartment_code), beds(bed_code)")
      .eq("asset_id", assetId).order("created_at", { ascending: false }),
    supabase.from("asset_maintenance_logs").select("*").eq("asset_id", assetId).order("maintenance_date", { ascending: false }),
    supabase.from("asset_payments").select("*, vendors(vendor_name)").eq("asset_id", assetId).order("payment_date", { ascending: false }),
    supabase.from("asset_movements").select("*").eq("asset_id", assetId).order("move_date", { ascending: false }),
    supabase.from("maintenance_tickets")
      .select("id, ticket_number, status, priority, created_at, resolved_at, closure_cost, description, issue_types(name)")
      .eq("asset_id", assetId).order("created_at", { ascending: false }),
  ]);
  const a: any = assetRes.data;
  if (!a) return null;
  const allocList = allocRes.data || [];
  const alloc: any = allocList[0] || null;
  const maintenance = maintRes.data || [];
  const payments = payRes.data || [];
  const movements = moveRes.data || [];
  const totalPaid = payments.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
  const balanceDue = Math.max(0, (Number(a.purchase_price) || 0) - totalPaid);
  let warrantyExpiry: string | null = a.warranty_expiry || null;
  if (!warrantyExpiry && a.purchase_date && a.warranty_months) {
    const d = new Date(a.purchase_date); d.setMonth(d.getMonth() + a.warranty_months);
    warrantyExpiry = d.toISOString().split("T")[0];
  }
  const warrantyActive = warrantyExpiry ? new Date(warrantyExpiry) > new Date() : false;
  const warrantyMonthsLeft = warrantyExpiry
    ? Math.max(0, Math.round((new Date(warrantyExpiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30))) : 0;
  const expectedLife = a.asset_types?.expected_life_months;
  const ageMonths = a.purchase_date
    ? Math.round((Date.now() - new Date(a.purchase_date).getTime()) / (1000 * 60 * 60 * 24 * 30)) : 0;
  const lifetimePercent = expectedLife ? Math.min(100, Math.round((ageMonths / expectedLife) * 100)) : null;
  return {
    id: a.id, assetCode: a.asset_code || "", qrCode: a.qr_code || "",
    typeName: a.asset_types?.name || "Unknown",
    categoryName: (a.asset_types as any)?.asset_categories?.name || "Unknown",
    expectedLifeMonths: expectedLife ?? null,
    brand: a.brand ?? null, model: a.model ?? null, serialNumber: a.serial_number ?? null,
    purchaseDate: a.purchase_date ?? null,
    purchasePrice: a.purchase_price != null ? Number(a.purchase_price) : null,
    condition: a.condition || "new", status: a.status || "available",
    warrantyMonths: a.warranty_months ?? null, warrantyExpiry, warrantyActive, warrantyMonthsLeft,
    invoiceNumber: a.invoice_number ?? null, invoiceDate: a.invoice_date ?? null,
    invoiceUrl: a.invoice_url ?? null, productPhotoUrl: a.product_photo_url ?? null,
    notes: a.notes ?? null, vendorNameManual: a.vendor_name_manual ?? null,
    vendor: a.vendors ? {
      name: (a.vendors as any).vendor_name, phone: (a.vendors as any).phone || null,
      email: (a.vendors as any).email || null, gst: (a.vendors as any).gst_number || null,
    } : null,
    allocation: alloc ? {
      type: alloc.allocation_type, property: alloc.properties?.property_name || null,
      apartment: alloc.apartments?.apartment_code || null, bed: alloc.beds?.bed_code || null,
      date: alloc.allocated_date || alloc.created_at || null,
    } : null,
    ageMonths, lifetimePercent,
    maintenance: maintenance.map((m: any) => ({
      id: m.id, date: m.maintenance_date, type: m.maintenance_type, issue: m.issue || null,
      vendor: m.vendor || null, cost: m.repair_cost ? Number(m.repair_cost) : 0,
      nextDue: m.next_service_due || null, notes: m.notes || null,
    })),
    totalMaintenanceCost: maintenance.reduce((s: number, m: any) => s + (Number(m.repair_cost) || 0), 0),
    payments: payments.map((p: any) => ({
      id: p.id, date: p.payment_date, amount: Number(p.amount) || 0, mode: p.payment_mode || null,
      reference: p.reference_number || null, vendor: (p.vendors as any)?.vendor_name || null,
      proofUrl: p.payment_proof_url || null, notes: p.notes || null,
    })),
    totalPaid, balanceDue,
    movements: movements.map((m: any) => ({
      id: m.id, date: m.move_date, from: m.from_location || null, to: m.to_location || null,
      reason: m.reason || null, movedBy: m.moved_by || null,
    })),
    allocations: allocList.map((al: any) => ({
      id: al.id, type: al.allocation_type, property: al.properties?.property_name || null,
      apartment: al.apartments?.apartment_code || null, bed: al.beds?.bed_code || null,
      date: al.allocated_date || al.created_at || null,
    })),
    tickets: (ticketRes.data || []).map((t: any) => ({
      id: t.id, ticketNumber: t.ticket_number || null, status: t.status || "open",
      priority: t.priority || null, issueType: (t.issue_types as any)?.name || null,
      cost: t.closure_cost != null ? Number(t.closure_cost) : 0,
      description: t.description || null, createdAt: t.created_at || null, resolvedAt: t.resolved_at || null,
    })),
  };
}

// ── Asset payments ──
export async function listAssetPayments(assetId: string) {
  return client.action((api as any).assets.listAssetPayments, { assetId });
}
export async function recordAssetPayment(data: any) {
  const { data: row, error } = await supabase.from("asset_payments").insert({
    organization_id: ORG_ID, asset_id: data.assetId, vendor_id: data.vendorId || null,
    payment_date: data.paymentDate, amount: data.amount, payment_mode: data.paymentMode || null,
    bank_account_id: data.bankAccountId || null, reference_number: data.referenceNumber || null,
    payment_proof_url: data.proofUrl || null, notes: data.notes || null,
  }).select().single();
  if (error) throw new Error(`Record payment failed: ${error.message}`);
  return row;
}
export async function deleteAssetPayment(_paymentId: string) {
  return deleteDisabledResult();
}
export async function listAssetPaymentStatus() {
  const rows = await fetchAllPages((from, to) =>
    supabase.from("v_asset_payment_status")
      .select("asset_id, asset_code, vendor_name, supplier_id, invoice_number, invoice_date, purchase_date, purchase_price, total_paid, balance_due, payment_count, last_payment_date, status")
      .eq("organization_id", ORG_ID)
      .order("purchase_date", { ascending: false })
      .range(from, to)
  );
  return rows.map((r: any) => ({
    assetId: r.asset_id, assetCode: r.asset_code || "", vendorName: r.vendor_name || null,
    supplierId: r.supplier_id || null, invoiceNumber: r.invoice_number || null, invoiceDate: r.invoice_date || null,
    purchaseDate: r.purchase_date || null, purchasePrice: Number(r.purchase_price) || 0,
    totalPaid: Number(r.total_paid) || 0, balanceDue: Number(r.balance_due) || 0,
    paymentCount: Number(r.payment_count) || 0, lastPaymentDate: r.last_payment_date || null,
    status: r.status || "unpaid",
  }));
}
export async function listAssetBankAccounts() {
  const rows = await safeList(
    supabase.from("organization_bank_accounts")
      .select("id, bank_name, account_number, ifsc_code, is_primary, status")
      .eq("organization_id", ORG_ID).eq("status", "active")
      .order("is_primary", { ascending: false })
  );
  return rows.map((b: any) => ({
    id: b.id, bankName: b.bank_name || "Bank", accountNumber: b.account_number || "",
    ifsc: b.ifsc_code || "", isPrimary: !!b.is_primary,
  }));
}
export async function listBrands() {
  const rows = await safeList(
    supabase.from("asset_brands").select("id, name").eq("organization_id", ORG_ID).order("name")
  );
  return rows.map((b: any) => ({ id: b.id, name: b.name }));
}
export async function createBrand(name: string) {
  return insertRow("asset_brands", { name });
}
export async function listVendorRemarks(vendorId: string) {
  return safeList(
    supabase.from("vendor_remarks").select("*").eq("vendor_id", vendorId).eq("organization_id", ORG_ID).order("created_at", { ascending: false })
  );
}
export async function addVendorRemark(data: any) {
  return insertRow("vendor_remarks", {
    vendor_id: data.vendorId,
    remark_type: data.remark_type || "neutral",
    severity: data.severity || "medium",
    title: data.title,
    description: data.description || null,
  });
}
export async function listForecasts() {
  const rows = await safeList(
    supabase.from("replacement_forecasts")
      .select("id, asset_id, expected_replacement_date, replacement_cost, urgency_level")
      .eq("organization_id", ORG_ID)
      .order("expected_replacement_date", { ascending: true })
  );
  if (!rows.length) return [];
  const assetIds = [...new Set(rows.map((r: any) => r.asset_id).filter(Boolean))];
  const assetsRows = assetIds.length ? await safeList(
    supabase.from("assets").select("id, asset_code, asset_type_id").in("id", assetIds)
  ) : [];
  const typeIds = [...new Set((assetsRows as any[]).map((a: any) => a.asset_type_id).filter(Boolean))];
  const typeRows = typeIds.length ? await safeList(supabase.from("asset_types").select("id, name").in("id", typeIds)) : [];
  const typeMap: Record<string, string> = Object.fromEntries((typeRows as any[]).map((t: any) => [t.id, t.name]));
  const assetMap = Object.fromEntries((assetsRows as any[]).map((a: any) => [a.id, { code: a.asset_code, type: typeMap[a.asset_type_id] || null }]));
  return rows.map((r: any) => ({
    id: r.id,
    assetCode: assetMap[r.asset_id]?.code || null,
    typeName: assetMap[r.asset_id]?.type || null,
    expectedReplacementDate: r.expected_replacement_date,
    replacementCost: Number(r.replacement_cost) || 0,
    urgency: r.urgency_level || null,
  }));
}
export async function listProperties() {
  return listPropertiesEnriched();
}
// ── Asset movements ──
export async function listAssetMovements(assetId: string) {
  const rows = await safeList(
    supabase.from("asset_movements").select("*").eq("asset_id", assetId).eq("organization_id", ORG_ID).order("move_date", { ascending: false })
  );
  return rows.map((m: any) => ({
    id: m.id, assetId: m.asset_id, date: m.move_date,
    from: m.from_location || null, to: m.to_location || null,
    reason: m.reason || null, movedBy: m.moved_by || null,
  }));
}
export async function recordAssetMovement(data: any) {
  const { data: row, error } = await supabase.from("asset_movements").insert({
    organization_id: ORG_ID, asset_id: data.assetId, move_date: data.moveDate,
    from_location: data.fromLocation || null, to_location: data.toLocation || null,
    reason: data.reason || null, moved_by: data.movedBy || null,
  }).select().single();
  if (error) throw new Error(`Record movement failed: ${error.message}`);
  return row;
}
// ── Asset type update/delete ──
export async function updateAssetType(typeId: string, data: any) {
  const update: Record<string, any> = {};
  if (data.name !== undefined) update.name = data.name;
  if (data.categoryId !== undefined) update.category_id = data.categoryId;
  if (data.expectedLifeMonths !== undefined) update.expected_life_months = data.expectedLifeMonths;
  if (data.replacementCostEstimate !== undefined) update.replacement_cost_estimate = data.replacementCostEstimate;
  if (Object.keys(update).length > 0) await updateRow("asset_types", typeId, update);
  return { success: true };
}
export async function deleteAssetType(_typeId: string) {
  return deleteDisabledResult();
}

export async function listEbPayments() {
  const { listEbPayments: fn } = await import("./electricity");
  return fn();
}
export async function saveEbPayment(data: any) {
  return client.action((api as any).electricity.saveEbPayment, { data });
}
export async function loadCurrentEb(propertyId: string) {
  return client.action((api as any).electricity.loadCurrentEb, { propertyId });
}
export async function saveEbMonitoring(rows: any[]) {
  return client.action((api as any).electricity.saveEbMonitoring, { rows });
}
export async function deleteEbPayment(id: string) {
  return client.action((api as any).electricity.deleteEbPayment, { id });
}
export async function loadEbPayBulkRows(propertyId: string, billDate: string) {
  return client.action((api as any).electricity.loadEbPayBulkRows, { propertyId, billDate });
}

// ─── Settings extras ──────────────────────────────────────────────────────────
export async function getUniversalMetrics(period: string) {
  return client.action((api as any).reports.getUniversalMetrics, { period });
}


// ─── Analytics data ───────────────────────────────────────────────────────────

export async function listExpenses() {
  const rows = await safeList(
    supabase.from("expenses")
      .select("id, category_id, property_id, vendor_id, description, amount, expense_date, billing_month, receipt_url, data_source, created_at")
      .eq("organization_id", ORG_ID).order("expense_date", { ascending: false })
  );
  const catIds = [...new Set(rows.map((r: any) => r.category_id).filter(Boolean))];
  const propIds = [...new Set(rows.map((r: any) => r.property_id).filter(Boolean))];
  const venIds = [...new Set(rows.map((r: any) => r.vendor_id).filter(Boolean))];
  const [cats, props, vens] = await Promise.all([
    catIds.length ? safeList(supabase.from("expense_categories").select("id, label").eq("organization_id", ORG_ID).in("id", catIds)) : Promise.resolve([]),
    propIds.length ? safeList(supabase.from("properties").select("id, property_name").eq("organization_id", ORG_ID).in("id", propIds)) : Promise.resolve([]),
    venIds.length ? safeList(supabase.from("vendors").select("id, vendor_name").in("id", venIds)) : Promise.resolve([]),
  ]);
  const catLabel = new Map<string, string>(); for (const c of cats as any[]) catLabel.set(c.id, c.label);
  const propName = new Map<string, string>(); for (const p of props as any[]) propName.set(p.id, p.property_name);
  const venName = new Map<string, string>(); for (const vv of vens as any[]) venName.set(vv.id, vv.vendor_name);
  return rows.map((row: any) => ({
    id: row.id, categoryId: row.category_id || null,
    category: row.category_id ? (catLabel.get(row.category_id) || null) : null,
    propertyName: propName.get(row.property_id) || "", vendorName: venName.get(row.vendor_id) || "",
    description: row.description || null, amount: Number(row.amount ?? 0),
    expense_date: row.expense_date || null, billingMonth: row.billing_month || "",
    receiptUrl: row.receipt_url || null, locked: row.data_source === "locked", created_at: row.created_at || null,
  }));
}

export async function listReceipts() {
  const rows = await fetchAllPages((from, to) =>
    supabase.from("receipts")
      .select("id, tenant_id, tenant_allotment_id, amount_paid, base_amount, processing_fee, payment_mode, reference_number, payment_date, receipt_type, created_at")
      .eq("organization_id", ORG_ID).order("created_at", { ascending: false }).range(from, to)
  );
  return rows.map((row: any) => ({
    id: row.id, tenant_id: row.tenant_id || null, tenant_allotment_id: row.tenant_allotment_id || null,
    amount_paid: row.amount_paid ?? 0, base_amount: row.base_amount ?? 0, processing_fee: row.processing_fee ?? 0,
    payment_mode: row.payment_mode || null, reference_number: row.reference_number || null,
    payment_date: row.payment_date || null, receipt_type: row.receipt_type || null, created_at: row.created_at || null,
  }));
}

export async function listOwnerPayments() {
  const rows = await safeList(
    supabase.from("owner_payments")
      .select("id, owner_id, apartment_id, base_amount, escalated_amount, bill_date, due_date, payment_month, status, paid_date, payment_mode, reference_number, notes, created_at")
      .eq("organization_id", ORG_ID).order("bill_date", { ascending: false })
  );
  const ownerIds = [...new Set(rows.map((r: any) => r.owner_id).filter(Boolean))];
  const aptIds = [...new Set(rows.map((r: any) => r.apartment_id).filter(Boolean))];
  const [owners, apts] = await Promise.all([
    ownerIds.length ? safeList(supabase.from("owners").select("id, full_name").eq("organization_id", ORG_ID).in("id", ownerIds)) : Promise.resolve([]),
    aptIds.length ? safeList(supabase.from("apartments").select("id, apartment_code, property_id").eq("organization_id", ORG_ID).in("id", aptIds)) : Promise.resolve([]),
  ]);
  const oName = new Map<string, string>(); for (const o of owners as any[]) oName.set(o.id, o.full_name);
  const aCode = new Map<string, string>(); for (const a of apts as any[]) aCode.set(a.id, a.apartment_code);
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((row: any) => {
    const stored = String(row.status || "").toLowerCase();
    const computedStatus = stored === "paid" ? "paid" : (row.due_date && row.due_date < today ? "overdue" : "pending");
    return {
      id: row.id, owner_id: row.owner_id || null, ownerName: oName.get(row.owner_id) || "Unknown",
      apartmentCode: aCode.get(row.apartment_id) || "", amount: Number(row.escalated_amount ?? 0),
      billDate: row.bill_date || null, dueDate: row.due_date || null, paymentMonth: row.payment_month || "",
      status: computedStatus, payment_date: row.paid_date || null, payment_mode: row.payment_mode || null,
      referenceNumber: row.reference_number || "", notes: row.notes || null, created_at: row.created_at || null,
    };
  });
}

export async function listFlatReadings() {
  return client.action((api as any).electricity.listFlatReadings, {});
}

/**
 * Fetches all data needed by AnalyticsScreen in one parallel call.
 * Uses Promise.allSettled so a failing optional action never wipes core data.
 */
export async function getAnalyticsData() {
  const ok = <T>(r: { status: string; value?: T; reason?: any }): T | undefined =>
    r.status === 'fulfilled' ? r.value : undefined;

  const [
    rProps, rApts, rBeds, rAllots,
    rInvs, rFlat, rExp, rRec, rOwn,
  ] = await allSettled([
    listPropertiesEnriched(),
    listApartments(),
    listBeds({}),
    listAllotments(),
    listInvoices({}),
    listFlatReadings().catch(() => []),
    listExpenses().catch(() => []),
    listReceipts().catch(() => []),
    listOwnerPayments().catch(() => []),
  ]);

  [rProps, rApts, rBeds, rAllots, rInvs, rFlat, rExp, rRec, rOwn]
    .forEach((r, i) => {
      if (r.status === 'rejected')
        console.warn(`[getAnalyticsData] slot ${i} failed:`, (r as any).reason?.message);
    });

  return {
    properties:    (ok(rProps)  as any[]) ?? [],
    apartments:    (ok(rApts)   as any[]) ?? [],
    beds:          (ok(rBeds)   as any[]) ?? [],
    allotments:    (ok(rAllots) as any[]) ?? [],
    invoices:      (ok(rInvs)   as any[]) ?? [],
    flatReadings:  (ok(rFlat)   as any[]) ?? [],
    expenses:      (ok(rExp)    as any[]) ?? [],
    receipts:      (ok(rRec)    as any[]) ?? [],
    ownerPayments: (ok(rOwn)    as any[]) ?? [],
  };
}

// ─── Assets: direct Supabase REST fallback ────────────────────────────────────
// Used when the Convex assets module hasn't been deployed yet.
// Queries Supabase REST API directly using the user's auth JWT + anon key,
// bypassing Convex entirely so data always loads.

const SB_URL  = SUPABASE_URL  || 'https://slljsigvfaxngpjaajjd.supabase.co';
const SB_ANON = SUPABASE_ANON_KEY || '';
const SB_ORG  = CFG_ORG_ID || '00000000-0000-0000-0000-000000000001';

const SB_PAGE_SIZE = 1000; // Supabase PostgREST max rows per request

async function sbFetch(path: string, authToken: string): Promise<any[]> {
  // Paginate using limit+offset query params only.
  // Do NOT use Range/Range-Unit headers — they are unreliable on iOS/React Native
  // (mobile HTTP stacks can mangle them causing 206 or silent failures).
  const all: any[] = [];
  let offset = 0;
  const sep = path.includes('?') ? '&' : '?';

  while (true) {
    const url = `${SB_URL}/rest/v1/${path}${sep}limit=${SB_PAGE_SIZE}&offset=${offset}`;
    try {
      const res = await fetch(url, {
        headers: {
          'apikey': SB_ANON,
          'Authorization': `Bearer ${authToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn('[sbFetch] HTTP', res.status, path.split('?')[0], text.slice(0, 200));
        break;
      }
      const json = await res.json();
      const rows: any[] = Array.isArray(json) ? json : [];
      console.log(`[sbFetch] ${path.split('?')[0]} offset=${offset} got=${rows.length}`);
      all.push(...rows);
      if (rows.length < SB_PAGE_SIZE) break; // last page — no more data
      offset += SB_PAGE_SIZE;
    } catch (e: any) {
      console.warn('[sbFetch] Network error', path.split('?')[0], e?.message);
      break;
    }
  }

  console.log(`[sbFetch] TOTAL ${path.split('?')[0]} = ${all.length} rows`);
  return all;
}

// Explicit column list — only columns confirmed to exist from createAsset/updateAsset
export async function listAssetsFallback(authToken: string): Promise<any[]> {
  // Use select=* (same as web app) — no explicit column list to avoid
  // "column does not exist" errors from schema differences.
  // No limit/offset/Range — mirrors getAssetStatsFallback which returns 1700 rows.
  const assets = await sbFetch(
    `assets?organization_id=eq.${SB_ORG}&select=*`,
    authToken,
  );
  console.log('[listAssets] fetched', assets.length, 'assets via select=*');

  if (!assets.length) return [];

  const [types, cats, allocs, bedsRaw, aptsRaw, propsRaw, vendors] = await Promise.all([
    sbFetch(`asset_types?select=id,name,category_id`, authToken),
    sbFetch(`asset_categories?select=id,name`, authToken),
    sbFetch(`asset_allocations?organization_id=eq.${SB_ORG}&select=asset_id,allocation_type,apartment_id,property_id,bed_id`, authToken),
    sbFetch(`beds?select=id,bed_code`, authToken),
    sbFetch(`apartments?select=id,apartment_code`, authToken),
    sbFetch(`properties?organization_id=eq.${SB_ORG}&select=id,property_name`, authToken),
    sbFetch(`vendors?organization_id=eq.${SB_ORG}&select=id,vendor_name`, authToken),
  ]);

  const typeMap   = Object.fromEntries((types    as any[]).map((t: any) => [t.id, t]));
  const catMap    = Object.fromEntries((cats     as any[]).map((c: any) => [c.id, c.name]));
  const allocMap  = Object.fromEntries((allocs   as any[]).map((a: any) => [a.asset_id, a]));
  const bedMap    = Object.fromEntries((bedsRaw  as any[]).map((b: any) => [b.id, b.bed_code        || '']));
  const aptMap    = Object.fromEntries((aptsRaw  as any[]).map((a: any) => [a.id, a.apartment_code  || '']));
  const propMap   = Object.fromEntries((propsRaw as any[]).map((p: any) => [p.id, p.property_name   || '']));
  const vendorMap = Object.fromEntries((vendors  as any[]).map((v: any) => [v.id, v.vendor_name     || '']));

  return (assets as any[]).map((a: any) => {
    const t     = typeMap[a.asset_type_id] || {};
    const alloc = allocMap[a.id];
    return {
      _id:              a.id,
      _creationTime:    new Date(a.created_at || 0).getTime(),
      assetCode:        a.asset_code || '',
      qrCode:           a.qr_code   || `https://vishful.co.in/vista/asset?id=${a.id}&code=${encodeURIComponent(a.asset_code || '')}` ,
      typeName:         t.name      || 'Unknown',
      categoryName:     catMap[t.category_id] || 'Unknown',
      brand:            a.brand            ?? undefined,
      model:            a.model            ?? undefined,
      purchaseDate:     a.purchase_date    ?? undefined,
      purchasePrice:    a.purchase_price   != null ? Number(a.purchase_price) : undefined,
      condition:        a.condition        || 'new',
      status:           a.status           || 'available',
      warrantyExpiry:   a.warranty_expiry  ?? undefined,
      warrantyMonths:   a.warranty_months  ?? undefined,
      invoiceNumber:    a.invoice_number   ?? undefined,
      invoiceDate:      a.invoice_date     ?? undefined,
      serialNumber:     a.serial_number    ?? undefined,
      notes:            a.notes            ?? undefined,
      vendorId:         a.vendor_id        ?? undefined,
      vendorName:       vendorMap[a.vendor_id] || undefined,
      locationName:     (() => {
        if (!alloc) return undefined;
        if (alloc.allocation_type === 'bed') {
          const aptName = aptMap[alloc.apartment_id] || '';
          const bedName = bedMap[alloc.bed_id] || '';
          return aptName && bedName ? `${aptName} - ${bedName}` : bedName || aptName || undefined;
        }
        if (alloc.allocation_type === 'apartment') return aptMap[alloc.apartment_id] || undefined;
        if (alloc.allocation_type === 'property')  return propMap[alloc.property_id] || undefined;
        return undefined;
      })(),
      apartmentId:      alloc?.apartment_id ?? undefined,
    };
  });
}

export async function getAssetStatsFallback(authToken: string): Promise<any> {
  const assets = await sbFetch(
    `assets?organization_id=eq.${SB_ORG}&select=id,purchase_price,warranty_expiry,status,asset_type_id`,
    authToken,
  );
  if (!assets.length) return { totalAssets: 0, totalInvestment: 0, inWarranty: 0, needsMaintenance: 0, byCategory: [] };

  const now  = new Date().toISOString().split('T')[0];
  const types = await sbFetch('asset_types?select=id,name,category_id', authToken);
  const cats  = await sbFetch('asset_categories?select=id,name', authToken);
  const catNameMap  = Object.fromEntries((cats  as any[]).map((c: any) => [c.id, c.name]));
  const typeToCat   = Object.fromEntries((types as any[]).map((t: any) => [t.id, catNameMap[t.category_id] || 'Unknown']));

  const catCount: Record<string, number> = {};
  let totalInvestment = 0;
  let inWarranty      = 0;
  let needsMaintenance = 0;

  for (const a of assets as any[]) {
    totalInvestment  += Number(a.purchase_price || 0);
    if (a.warranty_expiry && a.warranty_expiry > now) inWarranty++;
    if (a.status === 'maintenance') needsMaintenance++;
    const cat = typeToCat[a.asset_type_id] || 'Unknown';
    catCount[cat] = (catCount[cat] || 0) + 1;
  }

  return {
    totalAssets:      assets.length,
    totalInvestment,  inWarranty,  needsMaintenance,
    byCategory:       Object.entries(catCount).map(([name, count]) => ({ name, count })),
  };
}

export async function listCategoriesFallback(authToken: string): Promise<any[]> {
  const cats  = await sbFetch('asset_categories?select=id,name', authToken);
  const types = await sbFetch('asset_types?select=category_id', authToken);
  const typeCounts: Record<string, number> = {};
  (types as any[]).forEach((t: any) => { typeCounts[t.category_id] = (typeCounts[t.category_id] || 0) + 1; });
  return (cats as any[]).map((c: any) => ({ _id: c.id, name: c.name, typeCount: typeCounts[c.id] || 0 }));
}

export async function listTypesFallback(authToken: string): Promise<any[]> {
  const [types, cats] = await Promise.all([
    sbFetch('asset_types?select=id,name,category_id,expected_life_months,replacement_cost_estimate', authToken),
    sbFetch('asset_categories?select=id,name', authToken),
  ]);
  const catNameMap = Object.fromEntries((cats as any[]).map((c: any) => [c.id, c.name]));
  return (types as any[]).map((t: any) => ({
    _id:                      t.id,
    name:                     t.name,
    categoryId:               t.category_id,
    categoryName:             catNameMap[t.category_id] || 'Unknown',
    expectedLifeMonths:       t.expected_life_months       ?? undefined,
    replacementCostEstimate:  t.replacement_cost_estimate  ?? undefined,
  }));
}

export async function listVendorsFallback(authToken: string): Promise<any[]> {
  const rows = await sbFetch(`vendors?organization_id=eq.${SB_ORG}&order=vendor_name`, authToken);
  return (rows as any[]).map((v: any) => ({
    id: v.id, name: v.vendor_name || '', contactPerson: v.contact_person ?? undefined,
    phone: v.phone ?? undefined, email: v.email ?? undefined,
    address: v.address ?? undefined, status: v.status || 'active',
  }));
}

export async function sendOnboardingKycWhatsapp(allotmentId: string, registrationData: any) {
  return client.action((api as any).tenants.sendOnboardingKycWhatsapp, { allotmentId, registrationData });
}
export async function getOnboardingRegistrationData(allotmentId: string) {
  return client.action((api as any).tenants.getOnboardingRegistrationData, { allotmentId });
}

export async function sendAnnouncementWhatsapp(title: string, content: string, priority?: string, imageUrl?: string | null) {
  return client.action((api as any).anouncements.sendAnnouncementWhatsapp, { title, content, priority, imageUrl });
}
export async function uploadAnnouncementImage(base64: string, contentType?: string, ext?: string) {
  return client.action((api as any).anouncements.uploadAnnouncementImage, { base64, contentType, ext });
}
export async function deleteAnnouncementImage(imageUrl: string | null | undefined) {
  return client.action((api as any).anouncements.deleteAnnouncementImage, { imageUrl: imageUrl ?? null });
}
export async function listAnnouncements() {
  return client.action((api as any).anouncements.listAnnouncements, {});
}
export async function getCostApprovers() {
  return client.action((api as any).tickets.getCostApprovers, {});
}
export async function createAnnouncement(args: { title: string; content: string; priority?: string; imageUrl?: string | null; isPublished?: boolean; createdBy?: string | null }) {
  return client.action((api as any).anouncements.createAnnouncement, args);
}
export async function updateAnnouncement(args: { id: string; title?: string; content?: string; priority?: string; imageUrl?: string | null; isPublished?: boolean }) {
  return client.action((api as any).anouncements.updateAnnouncement, args);
}
export async function deleteAnnouncement(id: string) {
  return client.action((api as any).anouncements.deleteAnnouncement, { id });
}

// ─── PROPERTY IMAGES ──────────────────────────────────────────────────────────
export async function listPropertyImages(propertyId: string) {
  return safeList(supabase.from('property_images').select('*').eq('property_id', propertyId).order('display_order', { ascending: true }));
}

export async function addPropertyImage(args: { propertyId: string; imageUrl: string; caption?: string | null; isCover?: boolean }) {
  const existing = await safeList(supabase.from('property_images').select('display_order').eq('property_id', args.propertyId));
  const maxOrder = existing.reduce((m: number, r: any) => Math.max(m, r.display_order ?? -1), -1);
  const row = await insertRow('property_images', {
    property_id: args.propertyId,
    image_url: args.imageUrl,
    caption: args.caption ?? null,
    display_order: maxOrder + 1,
    is_cover: args.isCover ?? (existing.length === 0),
  });
  return row.id;
}

export async function deletePropertyImage(_id: string) {
  return deleteDisabledResult();
}

export async function setPropertyImageCover(id: string, propertyId: string) {
  await supabase.from('property_images').update({ is_cover: false }).eq('property_id', propertyId);
  const { error } = await supabase.from('property_images').update({ is_cover: true }).eq('id', id);
  if (error) throw new Error(error.message);
  return { success: true };
}
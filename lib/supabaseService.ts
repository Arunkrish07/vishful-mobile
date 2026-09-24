/**
 * supabaseService.ts
 *
 * Frontend API layer — routes ALL data operations through Convex actions.
 * Convex actions use Supabase service role key server-side.
 * No direct Supabase calls from the client.
 */
import { client, api } from "./convexApi";
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

export async function sendOtp(phone: string): Promise<{ success: boolean; message?: string; reason?: string }> {
  return client.action(api.otpAuth.sendOtp, { phone });
}

export async function verifyOtpAndLogin(phone: string, otp: string): Promise<{
  success: boolean;
  token?: string;
  refreshToken?: string;
  user?: { userId: string; userName: string; phone: string; role: string; organizationId: string; organizationName: string; supabaseUserId?: string | null };
  reason?: string;
  message?: string;
}> {
  return client.action(api.otpAuth.verifyOtpAndLogin, { phone, otp });
}

// Exchange a stored refresh token for a fresh access token. Returns { success:false }
// on any failure so the caller can fall back to logging out.
export async function refreshSession(refreshToken: string): Promise<{ success: boolean; token?: string; refreshToken?: string }> {
  if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.trim().length === 0) {
    return { success: false };
  }
  try {
    return await client.action(api.otpAuth.refreshSession, { refreshToken });
  } catch (e: any) {
    console.warn('[supabaseService] refreshSession error:', e?.message);
    return { success: false };
  }
}

export async function getSession(token: string): Promise<{
  valid: boolean;
  userId?: string; userName?: string; phone?: string;
  role?: string; organizationId?: string; organizationName?: string;
} | null> {
  // Defensive: only send non-empty string tokens
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    console.warn('[supabaseService] getSession called with invalid token:', typeof token);
    return { valid: false };
  }
  try {
    return await client.action(api.otpAuth.getSession, { token });
  } catch (e: any) {
    console.warn('[supabaseService] getSession error:', e?.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

export async function getDashboardData() {
  return client.action(api.dashboard.getStats, {});
}
export async function getBedTenantDiscrepancies(): Promise<{ bed: number; tenant: number }> {
  return client.action((api as any).tenants.getBedTenantDiscrepancies, {});
}
export async function issueKycToken(propertyId: string, token: string): Promise<{ ok: boolean; qr?: string | null; propertyName?: string | null; reused?: boolean; error?: string }> {
  return client.action((api as any).tenants.issueKycToken, { propertyId, token });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROPERTIES
// ═══════════════════════════════════════════════════════════════════════════════

export async function listPropertiesEnriched() {
  return client.action(api.properties.listProperties, {});
}

export async function createProperty(args: { name: string; address?: string; city?: string; status: string }) {
  return client.action(api.properties.createProperty, args);
}

export async function updateProperty(id: string, updates: Record<string, any>) {
  return client.action(api.properties.updateProperty, { id, updates });
}

export async function deleteProperty(id: string) {
  return client.action(api.properties.removeProperty, { id });
}

// ═══════════════════════════════════════════════════════════════════════════════
// APARTMENTS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listApartments(propertyId?: string) {
  return client.action(api.properties.listApartments, { propertyId });
}

export async function createApartment(args: { propertyId: string; name: string; floor?: string; status: string }) {
  return client.action(api.properties.createApartment, args);
}

export async function updateApartment(id: string, updates: any) {
  return client.action((api as any).properties.updateApartment, { id, updates });
}

export async function deleteApartment(id: string) {
  return client.action((api as any).properties.deleteApartment, { id });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BEDS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listBeds(args: { apartmentId?: string; propertyId?: string }) {
  return client.action(api.properties.listBeds, args);
}

export async function createBed(args: { propertyId: string; apartmentId: string; type: string; toiletType: string; monthlyRent: number; status: string }) {
  return client.action(api.properties.createBed, args);
}

export async function updateBed(id: string, updates: any) {
  return client.action((api as any).properties.updateBed, { id, updates });
}

export async function deleteBed(id: string) {
  return client.action((api as any).properties.deleteBed, { id });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TENANTS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listTenantsEnriched() {
  return client.action(api.tenants.listTenants, {});
}

export async function createTenant(args: any) {
  return client.action(api.tenants.createTenant, { data: args });
}

export async function updateTenant(id: string, args: any) {
  return client.action(api.tenants.updateTenant, { id, data: args });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TENANT LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

export async function listStays(tenantId?: string) {
  return client.action(api.tenants.listStays, { tenantId });
}

export async function listAllotments() {
  return client.action(api.tenants.listAllotments, {});
}

export async function createAllotment(args: any) {
  return client.action(api.tenants.createAllotment, { data: args });
}

export async function updateAllotmentStatus(args: { allotmentId: string; status: string; bedId?: string; tenantId?: string }) {
  return client.action(api.tenants.updateAllotmentStatus, args);
}

export async function recordNotice(args: { allotmentId: string; tenantId: string; bedId: string; exitDate: string; notes?: string }) {
  return client.action(api.tenants.recordNotice, args);
}

export async function getTenantNotices(tenantId: string) {
  return client.action(api.tenants.listNotices, {}) as Promise<any[]>;
}

export async function switchRoom(args: any) {
  return client.action(api.tenants.switchRoom, { data: args });
}

export async function deleteAllotment(allotmentId: string, bedId?: string) {
  return client.action(api.tenants.removeAllotment, { allotmentId, bedId });
}

export async function createBooking(args: any) {
  return client.action(api.tenants.createBooking, { data: args });
}

export async function listBookings() {
  return client.action(api.tenants.listBookings, {});
}

export async function createTestTenant() {
  return client.action(api.tenants.createTestTenant, {});
}

export async function submitKYCForm(args: any) {
  return client.action(api.tenants.submitKYCForm, { data: args });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TENANT PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

export async function getTenantProfile(phone: string) {
  return client.action(api.tenants.getTenantProfile, { phone });
}

export async function getTenantLocation(phone: string) {
  return client.action(api.tenants.getTenantLocation, { phone });
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
  return client.action(api.tenants.getTenantDetails, { phone }) as any;
}
export async function updateTenantKyc(phone: string, fields: Record<string, any>): Promise<{ ok: boolean; tenantId?: string; error?: string }> {
  return client.action((api as any).tenants.updateTenantKyc, { phone, fields });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ASSETS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listCategories() {
  return client.action(api.assets.listCategories, {});
}

export async function listTypes(categoryId?: string) {
  return client.action(api.assets.listTypes, { categoryId });
}

export async function listAssets(status?: string) {
  return client.action(api.assets.listAssets, { status });
}

// Maintenance tickets linked to assets (grouped client-side by asset_id)
export async function listAssetMaintenance() {
  return client.action((api as any).assets.listAssetMaintenance, {});
}

export async function getAssetStats() {
  return client.action(api.assets.getAssetStats, {});
}

export async function createAssetType(args: any) {
  return client.action(api.assets.createAssetType, { data: args });
}

export async function createAsset(args: any) {
  return client.action(api.assets.createAsset, { data: args });
}

export async function updateAsset(assetId: string, args: any) {
  return client.action(api.assets.updateAsset, { assetId, data: args });
}

export async function deleteAsset(assetId: string) {
  return client.action(api.assets.removeAsset, { assetId });
}

export async function allocateAsset(args: { assetId: string; allocationType: string; propertyId?: string; apartmentId?: string; bedIds?: string[] }) {
  return client.action(api.assets.allocateAsset, { data: args });
}

export async function deallocateAsset(assetId: string) {
  return client.action(api.assets.deallocateAsset, { assetId });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VENDORS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listVendors() {
  return client.action(api.assets.listVendors, {});
}

export async function createVendor(args: any) {
  return client.action(api.assets.createVendor, { data: args });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNTING
// ═══════════════════════════════════════════════════════════════════════════════

export async function listInvoices(args: { status?: string; tenantId?: string } = {}) {
  return client.action(api.accounting.listInvoices, args);
}

export async function createInvoice(args: any) {
  return client.action(api.accounting.createInvoice, { data: args });
}

export async function recordPayment(args: any) {
  return client.action(api.accounting.recordPayment, { data: args });
}

export async function fetchOutstandingRecipients() {
  return client.action((api as any).accounting.fetchOutstandingRecipients, {});
}

export async function getInvoiceDetail(invoiceId: string) {
  return client.action((api as any).accounting.getInvoiceDetail, { invoiceId });
}
export async function listAdjustments() {
  return client.action((api as any).accounting.listAdjustments, {});
}
export async function getDepositSettlements() {
  return client.action((api as any).accounting.getDepositSettlements, {});
}
export async function getExitReconciliationWorklist() {
  return client.action((api as any).accounting.getExitReconciliationWorklist, {});
}
export async function getGstFiledWorkings() {
  return client.action((api as any).accounting.getGstFiledWorkings, {});
}
export async function getTenantLedger(args: { allotmentId?: string; tenantId?: string }) {
  return client.action((api as any).accounting.getTenantLedger, args);
}
export async function getTrialBalance(from: string, to: string) {
  return client.action((api as any).accounting.getTrialBalance, { from, to });
}
export async function getProfitability(fyStartYear?: number) {
  return client.action((api as any).accounting.getProfitability, { fyStartYear });
}

export async function previewBills(month: string, propertyId?: string) {
  return client.action((api as any).billing.previewBills, { month, propertyId });
}
export async function generateBills(month: string, propertyId?: string, allotmentIds?: string[]) {
  return client.action((api as any).billing.generateBills, { month, propertyId, allotmentIds });
}

export async function listExpenseCategories() {
  return client.action((api as any).settings.listExpenseCategories, {});
}
export async function saveExpenseCategory(args: { id?: string; key?: string; label: string; isActive?: boolean }) {
  return client.action((api as any).settings.saveExpenseCategory, args);
}
export async function deleteExpenseCategory(id: string) {
  return client.action((api as any).settings.deleteExpenseCategory, { id });
}

export async function getPendingDues() {
  return client.action(api.accounting.getPendingDues, {});
}

export async function listBillingTenants() {
  return client.action(api.accounting.listBillingTenants, {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// ELECTRICITY
// ═══════════════════════════════════════════════════════════════════════════════

export async function listReadings(billingMonth?: string) {
  return client.action(api.electricity.listReadings, { billingMonth });
}

export async function addReading(args: any) {
  return client.action(api.electricity.addReading, { data: args });
}

export async function listEbRates() {
  return client.action((api as any).electricity.listEbRates, {});
}

export async function saveEbRate(data: any) {
  return client.action((api as any).electricity.saveEbRate, { data });
}

export async function deleteEbRate(id: string) {
  return client.action((api as any).electricity.deleteEbRate, { id });
}

export async function listApartmentsForEB(propertyId: string, billingMonth: string) {
  return client.action((api as any).electricity.listApartmentsForEB, { propertyId, billingMonth });
}

export async function bulkSaveReadings(args: {
  propertyId: string; billingMonth: string; unitCost: number; rows: any[];
}) {
  return client.action((api as any).electricity.bulkSaveReadings, { data: args });
}

export async function lockReadings(propertyId: string, billingMonth: string, lock: boolean) {
  return client.action((api as any).electricity.lockReadings, { propertyId, billingMonth, lock });
}

export async function scanMeterReading(imageUrl: string): Promise<{
  reading_value: number | null; apartment_code: string | null;
  confidence: string; unit: string; error: string | null;
}> {
  return client.action((api as any).electricity.scanMeterReading, { imageUrl });
}

// Upload a meter photo to the shared `documents/meter-photos` bucket (the same path
// the web app uses) via the working owners.uploadDocument action, and return its
// public URL. Replaces the old uploadTicketPhoto path, which went through the no-op
// supabase storage stub and always returned null.
export async function uploadMeterPhoto(base64?: string | null): Promise<string | null> {
  if (!base64) return null;
  try {
    const res: any = await client.action((api as any).owners.uploadDocument, {
      base64,
      fileName: `meter_${Date.now()}.jpg`,
      folder: "meter-photos",
      contentType: "image/jpeg",
    });
    return res?.url || null;
  } catch (e) {
    console.warn("[uploadMeterPhoto]", (e as any)?.message);
    return null;
  }
}

export async function getEBAnalytics(propertyId?: string) {
  return client.action((api as any).electricity.getEBAnalytics, { propertyId });
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
  return client.action((api as any).tickets.updateTicketAsset, { ticketId, assetId });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS — TEAM MEMBERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getTeamMembers() {
  return client.action(api.settings.getTeamMembers, {});
}

// Org member profiles (id / full_name / email) — used for name dropdowns (e.g. Audit Logs "Performed by")
export async function getOrgProfiles() {
  return client.action((api as any).settings.getOrgProfiles, {});
}

export async function createTeamMember(data: any) {
  return client.action(api.settings.createTeamMember, { data });
}

export async function updateTeamMember(id: string, data: any) {
  return client.action(api.settings.updateTeamMember, { id, data });
}

export async function deleteTeamMember(id: string) {
  return client.action(api.settings.deleteTeamMember, { id });
}

// Team departments (real CRUD) + org tickets for Performance tab
export async function listTeamDepartments() {
  return client.action((api as any).settings.listTeamDepartments, {});
}
export async function createTeamDepartment(data: any) {
  return client.action((api as any).settings.createTeamDepartment, { data });
}
export async function updateTeamDepartment(id: string, data: any) {
  return client.action((api as any).settings.updateTeamDepartment, { id, data });
}
export async function deleteTeamDepartment(id: string) {
  return client.action((api as any).settings.deleteTeamDepartment, { id });
}
export async function listOrgTickets() {
  return client.action((api as any).settings.listOrgTickets, {});
}

// Team payments & attendance (real persistence — replace getAll/insertRow stubs)
export async function listTeamPayments() {
  return client.action(api.settings.listTeamPayments, {});
}
export async function listSalaryBills(memberId?: string) {
  return client.action((api as any).settings.listSalaryBills, memberId ? { memberId } : {});
}
export async function setSalaryBillStatus(id: string, status: string) {
  return client.action((api as any).settings.setSalaryBillStatus, { id, status });
}

export async function createTeamPayment(data: any) {
  return client.action(api.settings.createTeamPayment, { data });
}

export async function updateTeamPayment(id: string, data: any) {
  return client.action(api.settings.updateTeamPayment, { id, data });
}

export async function deleteTeamPayment(id: string) {
  return client.action(api.settings.deleteTeamPayment, { id });
}

export async function listTeamAttendance() {
  return client.action(api.settings.listTeamAttendance, {});
}

export async function generateSalaryBills(month: string, workingDays?: number) {
  return client.action((api as any).settings.generateSalaryBills, { month, workingDays });
}

export async function createTeamAttendance(data: any) {
  return client.action(api.settings.createTeamAttendance, { data });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS — USERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listUsersForSettings() {
  return client.action(api.settings.listUsersForSettings, {});
}

export async function addUserForSettings(args: { name: string; phone: string; email?: string; role: string; specialties?: string[] }) {
  return client.action(api.settings.addUserForSettings, args);
}

export async function updateUserForSettings(userId: string, args: any) {
  return client.action(api.settings.updateUserForSettings, { userId, data: args });
}

export async function updateProfile(args: { userId: string; name: string; email?: string; organizationName?: string }) {
  return client.action(api.settings.updateProfile, args);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS — BED RATES
// ═══════════════════════════════════════════════════════════════════════════════

export async function listBedRates(propertyId?: string) {
  return client.action(api.settings.listBedRates, { propertyId });
}

export async function createBedRate(args: any) {
  return client.action(api.settings.createBedRate, { data: args });
}

export async function updateBedRate(id: string, args: any) {
  return client.action(api.settings.updateBedRate, { id, data: args });
}

export async function deleteBedRate(id: string) {
  return client.action(api.settings.deleteBedRate, { id });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS — LABELS, PERMISSIONS, ORG
// ═══════════════════════════════════════════════════════════════════════════════

export async function listApartmentLabels() {
  return client.action(api.settings.listApartmentLabels, {});
}

export async function createApartmentLabel(args: { label: string; description?: string }) {
  return client.action(api.settings.createApartmentLabel, args);
}

export async function deleteApartmentLabel(id: string) {
  return client.action(api.settings.deleteApartmentLabel, { id });
}

export async function getPermissions(role: string) {
  return client.action(api.settings.getPermissions, { role });
}

export async function setPermissions(role: string, permissions: { module: string; can_create: boolean; can_read: boolean; can_update: boolean; can_delete: boolean }[]) {
  return client.action(api.settings.setPermissions, { role, permissions });
}

export async function getOrgSettings() {
  return client.action(api.settings.getOrgSettings, {});
}

export async function updateOrgSettings(args: { costApprovalThreshold?: number }) {
  return client.action(api.settings.updateOrgSettings, args);
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
export async function getReportsSummary(period: string) {
  return client.action((api as any).reports.getReportsSummary, { period });
}
export async function getOccupancyDetail() {
  return client.action((api as any).reports.getOccupancyDetail, {});
}
export async function getPropertyPnL(period: string) {
  return client.action((api as any).reports.getPropertyPnL, { period });
}
export async function getBedProfitability(period: string) {
  return client.action((api as any).reports.getBedProfitability, { period });
}
export async function getEBReconciliation(period: string) {
  return client.action((api as any).reports.getEBReconciliation, { period });
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

export async function insertRow(table: string, data: any): Promise<any> {
  console.warn(`[supabaseService] insertRow('${table}') called — use specific functions instead`);
  return data;
}

export async function updateRow(table: string, id: string, data: any): Promise<any> {
  console.warn(`[supabaseService] updateRow('${table}') called — use specific functions instead`);
  return data;
}

export async function deleteRow(table: string, id: string): Promise<boolean> {
  console.warn(`[supabaseService] deleteRow('${table}') called — use specific functions instead`);
  return true;
}
export async function getPropertyPerformanceData(propertyId: string) {
  return client.action((api as any).properties.getPropertyPerformanceData, { propertyId });
}

export async function getBedHistory(bedId: string) {
  return client.action((api as any).properties.getBedHistory, { bedId });
}

export async function createApartmentFull(propertyId: string, data: any) {
  return client.action((api as any).properties.createApartment, { propertyId, name: data.apartment_code || '', status: data.status || 'live', data });
}

export async function listAllocations() {
  return client.action((api as any).assets.listAllocations, {});
}
// Bed-scoped allocation lookup — returns only the requesting bed's asset
// allocation (or null), not the whole org's allocations table.
export async function getAllocationForBed(bedId: string) {
  return client.action((api as any).assets.getAllocationForBed, { bedId });
}
export async function updateVendor(vendorId: string, data: any) {
  return client.action((api as any).assets.updateVendor, { vendorId, data });
}
export async function deleteVendor(vendorId: string) {
  return client.action((api as any).assets.deleteVendor, { vendorId });
}
export async function updateVendorRating(vendorId: string, rating: number) {
  return client.action((api as any).assets.updateVendorRating, { vendorId, rating });
}
export async function createCategory(name: string) {
  return client.action((api as any).assets.createCategory, { name });
}

export async function getAssetDetail(assetId: string) {
  return client.action((api as any).assets.getAssetDetail, { assetId });
}

// ── Asset payments ──
export async function listAssetPayments(assetId: string) {
  return client.action((api as any).assets.listAssetPayments, { assetId });
}
export async function recordAssetPayment(data: any) {
  return client.action((api as any).assets.recordAssetPayment, { data });
}
export async function deleteAssetPayment(paymentId: string) {
  return client.action((api as any).assets.deleteAssetPayment, { paymentId });
}
export async function listAssetPaymentStatus() {
  return client.action((api as any).assets.listAssetPaymentStatus, {});
}
export async function listAssetBankAccounts() {
  return client.action((api as any).assets.listAssetBankAccounts, {});
}
export async function listBrands() {
  return client.action((api as any).assets.listBrands, {});
}
export async function createBrand(name: string) {
  return client.action((api as any).assets.createBrand, { name });
}
export async function listVendorRemarks(vendorId: string) {
  return client.action((api as any).assets.listVendorRemarks, { vendorId });
}
export async function addVendorRemark(data: any) {
  return client.action((api as any).assets.addVendorRemark, { data });
}
export async function listForecasts() {
  return client.action((api as any).assets.listForecasts, {});
}
export async function listProperties() {
  return client.action((api as any).properties.listProperties, {});
}
// ── Asset movements ──
export async function listAssetMovements(assetId: string) {
  return client.action((api as any).assets.listAssetMovements, { assetId });
}
export async function recordAssetMovement(data: any) {
  return client.action((api as any).assets.recordAssetMovement, { data });
}
// ── Asset type update/delete ──
export async function updateAssetType(typeId: string, data: any) {
  return client.action((api as any).assets.updateAssetType, { typeId, data });
}
export async function deleteAssetType(typeId: string) {
  return client.action((api as any).assets.deleteAssetType, { typeId });
}

export async function listEbPayments() {
  return client.action((api as any).electricity.listEbPayments, {});
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
  return client.action((api as any).accounting.listExpenses, {});
}

export async function listReceipts() {
  return client.action((api as any).accounting.listReceipts, {});
}

export async function listOwnerPayments() {
  return client.action((api as any).accounting.listOwnerPayments, {});
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
  return client.action((api as any).properties.listPropertyImages, { propertyId });
}

export async function addPropertyImage(args: { propertyId: string; imageUrl: string; caption?: string | null; isCover?: boolean }) {
  return client.action((api as any).properties.addPropertyImage, args);
}

export async function deletePropertyImage(id: string) {
  return client.action((api as any).properties.deletePropertyImage, { id });
}

export async function setPropertyImageCover(id: string, propertyId: string) {
  return client.action((api as any).properties.setPropertyImageCover, { id, propertyId });
}
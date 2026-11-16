/**
 * Reports API — thin wrapper that delegates to the direct-Supabase hub
 * (lib/supabaseService.ts). No Convex. Kept for backward-compat call sites
 * that pass an orgId first arg (ignored — the hub is org-scoped internally).
 */
import * as sb from "../supabaseService";

export async function getReportsSummary(_orgId: string, period: string): Promise<any> {
  return sb.getReportsSummary(period);
}

export async function getPropertyPnL(_orgId: string, period: string): Promise<any> {
  return sb.getPropertyPnL(period);
}

export async function getBedProfitability(_orgId: string, period: string): Promise<any> {
  return sb.getBedProfitability(period);
}

export async function getEBReconciliation(_orgId: string, period: string): Promise<any> {
  return sb.getEBReconciliation(period);
}

export async function getOccupancyDetail(_orgId: string): Promise<any> {
  return sb.getOccupancyDetail();
}

// ── Legacy helpers kept for backward compat ──────────────────────────────────

export async function getMaintenanceReport(_orgId: string, startDate: string, endDate: string) {
  return sb.getMaintenanceReport(startDate, endDate);
}

export async function getOccupancyReport(_orgId: string) {
  return sb.getOccupancyDetail();
}

export async function getRevenueReport(_orgId: string, billingMonth: string) {
  return sb.getRevenueReport(billingMonth);
}

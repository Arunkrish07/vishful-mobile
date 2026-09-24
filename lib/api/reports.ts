/**
 * Reports API — routes through Convex actions.
 * Mirrors the web app's Reports section: KPI summary, P&L, bed profitability,
 * EB reconciliation, occupancy detail, and tenant summary.
 */
import { client, api } from "../convexApi";

export async function getReportsSummary(
  _orgId: string,
  period: string
): Promise<any> {
  return client.action(api.reports.getReportsSummary, { period });
}

export async function getPropertyPnL(
  _orgId: string,
  period: string
): Promise<any> {
  return client.action(api.reports.getPropertyPnL, { period });
}

export async function getBedProfitability(
  _orgId: string,
  period: string
): Promise<any> {
  return client.action(api.reports.getBedProfitability, { period });
}

export async function getEBReconciliation(
  _orgId: string,
  period: string
): Promise<any> {
  return client.action(api.reports.getEBReconciliation, { period });
}

export async function getOccupancyDetail(_orgId: string): Promise<any> {
  return client.action(api.reports.getOccupancyDetail, {});
}

// ── Legacy helpers kept for backward compat ──────────────────────────────────

export async function getMaintenanceReport(
  _orgId: string,
  startDate: string,
  endDate: string
) {
  return client.action(api.reports.getMaintenanceReport, { startDate, endDate });
}

export async function getOccupancyReport(_orgId: string) {
  return client.action(api.reports.getOccupancyDetail, {});
}

export async function getRevenueReport(_orgId: string, billingMonth: string) {
  return client.action(api.reports.getRevenueReport, { billingMonth });
}
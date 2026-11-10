/**
 * "Outstanding Dues" recipient selection — who currently owes money and how
 * much, drawn from the LEDGER (not invoices.status, which drifts after
 * adjustments/credit-notes and CLAUDE.md forbids trusting). Verbatim port of
 * the web app's selectOutstandingRecipients. Pure, zero imports — testable and
 * safe for both the Convex and RN bundles.
 */

/** Settlement statuses that mean "still owes money on this invoice". */
export const OUTSTANDING_SETTLEMENT_STATUSES = ['unpaid', 'partial'] as const;

export type OutstandingReminderRecipient = {
  tenant_id: string;
  tenant_name: string;
  /** Signed ledger AR at selection time; always > 0 for a recipient. */
  pending_amount: number;
  /** Unpaid/partial invoices behind the reminder. 0 when none back the balance. */
  invoice_count: number;
  /** False when the tenant record has no usable mobile number. */
  has_phone: boolean;
  /**
   * Ticked by default when at least one unpaid/partial invoice backs the
   * balance AND there is a phone. Balances with no invoice behind them (an
   * adjustment, opening balance, or FIFO-settled credit on another allotment)
   * still surface, unticked, so a real debt is never silently dropped.
   */
  auto_selected: boolean;
};

export type SettlementRow = {
  invoice_id?: string | null;
  tenant_id?: string | null;
  settlement_status?: string | null;
  amount_outstanding?: number | null;
};

export type DuesRow = { tenant_id?: string | null; ar_balance?: number | null };

export function selectOutstandingRecipients(
  dues: DuesRow[],
  tenantNames: Map<string, string>,
  /** Tenants with no usable mobile number. Listed, but never ticked. */
  tenantsMissingPhone: Set<string> = new Set(),
  /**
   * Optional invoice-settlement rows. The web ticks only balances backed by an
   * unpaid/partial invoice. On mobile the settlement view (v_invoice_settlement_status)
   * is unreliable via the service-role client, so this is usually omitted; when it
   * is, every reachable ower is ticked (auto_selected = has_phone). When settlement
   * rows ARE supplied, web parity is restored (ticked = invoice-backed AND reachable).
   */
  settlements?: SettlementRow[],
): OutstandingReminderRecipient[] {
  const invoiceCountByTenant = new Map<string, number>();
  for (const row of settlements ?? []) {
    if (!row.tenant_id) continue;
    const status = String(row.settlement_status ?? '').toLowerCase();
    if (!OUTSTANDING_SETTLEMENT_STATUSES.includes(status as 'unpaid' | 'partial')) continue;
    if (Number(row.amount_outstanding || 0) <= 0.5) continue;
    invoiceCountByTenant.set(row.tenant_id, (invoiceCountByTenant.get(row.tenant_id) || 0) + 1);
  }
  const haveSettlementData = (settlements?.length ?? 0) > 0;

  const arByTenant = new Map<string, number>();
  for (const row of dues) {
    if (!row.tenant_id) continue;
    arByTenant.set(row.tenant_id, (arByTenant.get(row.tenant_id) || 0) + Number(row.ar_balance || 0));
  }

  const out: OutstandingReminderRecipient[] = [];
  for (const [tenantId, arTotal] of arByTenant) {
    const pending = Math.round(arTotal * 100) / 100;
    // Signed: a tenant in credit is negative and must not be chased.
    if (pending <= 0.5) continue;
    const invoiceCount = invoiceCountByTenant.get(tenantId) ?? 0;
    const hasPhone = !tenantsMissingPhone.has(tenantId);
    out.push({
      tenant_id: tenantId,
      tenant_name: tenantNames.get(tenantId) || 'Tenant',
      pending_amount: pending,
      invoice_count: invoiceCount,
      has_phone: hasPhone,
      auto_selected: hasPhone && (haveSettlementData ? invoiceCount > 0 : true),
    });
  }

  out.sort((a, b) =>
    a.auto_selected === b.auto_selected
      ? b.pending_amount - a.pending_amount
      : Number(b.auto_selected) - Number(a.auto_selected),
  );
  return out;
}

/** `17077` → `₹17,077` — matches the amount the edge function's template sends. */
export function formatPendingAmount(amount: number): string {
  return `₹${Math.round(Number(amount) || 0).toLocaleString('en-IN')}`;
}

/** A phone has a usable number only if it carries at least 10 digits. */
export function hasUsablePhone(phone: string | null | undefined): boolean {
  return String(phone ?? '').replace(/\D/g, '').length >= 10;
}

/** Prefilled WhatsApp/SMS reminder text for a single tenant. */
export function buildReminderMessage(tenantName: string, amount: number, orgName: string): string {
  const who = (tenantName || '').trim() || 'there';
  return (
    `Hello ${who}, this is a gentle payment reminder from ${orgName}. ` +
    `Our records show an outstanding balance of ${formatPendingAmount(amount)}. ` +
    `Kindly clear it at your earliest convenience. Please ignore this message if you have already paid. Thank you.`
  );
}

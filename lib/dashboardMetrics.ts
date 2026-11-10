// ============================================================
// dashboardMetrics.ts
// Direct Supabase REST calls for web-parity dashboard data that
// the Convex getStats/getExtendedStats actions don't return.
//
// These endpoints are callable with the public ANON key (same key
// the web app uses) — verified against get_universal_metrics_v2,
// get_universal_metrics_series and v_tenant_current_dues. No Supabase
// auth session is required for them, so the mobile app can call them
// directly (unlike get_tenant_punctuality / raw invoices+receipts,
// which are RLS-protected and still need the Convex service role).
// ============================================================
import { SUPABASE_URL, SUPABASE_ANON_KEY, ORG_ID } from './config';

const REST = `${SUPABASE_URL}/rest/v1`;
const HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
};

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(id) };
}

export type Accounting = {
  totalRevenue: number;
  totalExpenses: number;
  totalProfit: number;
  profitMarginPct: number;
  totalCollections: number;
  totalPendingCollection: number;
  totalDepositsHeld: number;
  totalEbCharged: number;
  [k: string]: any;
};

// period: 'this_month' | 'last_month' | 'current_fy' | 'last_fy' | 'all_time'
//         | { from: 'YYYY-MM-DD'; to: 'YYYY-MM-DD' }
export async function getMetricsV2(
  period: string | { from: string; to: string },
): Promise<Accounting | null> {
  const body: any = { p_organization_id: ORG_ID };
  if (typeof period === 'object') {
    body.p_period = 'custom';
    body.p_from = period.from;
    body.p_to = period.to;
  } else {
    body.p_period = period;
  }
  const t = withTimeout(15000);
  try {
    const r = await fetch(`${REST}/rpc/get_universal_metrics_v2`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
      signal: t.signal,
    });
    if (!r.ok) return null;
    const data = await r.json();
    return (data?.accounting ?? null) as Accounting | null;
  } catch {
    return null;
  } finally {
    t.done();
  }
}

// Receivables (money tenants owe us) / payables (money we owe tenants),
// summed from the v_tenant_current_dues view — matches the web's
// useTenantDuesTotals() "Pending dues" tile.
export async function getDuesTotals(): Promise<{ receivables: number; payables: number }> {
  const t = withTimeout(15000);
  try {
    const r = await fetch(
      `${REST}/v_tenant_current_dues?select=net_dues&organization_id=eq.${ORG_ID}`,
      { headers: HEADERS, signal: t.signal },
    );
    if (!r.ok) return { receivables: 0, payables: 0 };
    const rows: Array<{ net_dues: number | string }> = await r.json();
    let receivables = 0;
    let payables = 0;
    for (const row of rows) {
      const v = Number(row.net_dues) || 0;
      if (v > 0) receivables += v;
      else payables += -v;
    }
    return { receivables, payables };
  } catch {
    return { receivables: 0, payables: 0 };
  } finally {
    t.done();
  }
}

// Resolve a period key (or custom range) into concrete YYYY-MM-DD dates,
// mirroring convex/dashboard.ts + the web AccountingPeriodSelector.
function getFYStartYear(d = new Date()): number {
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function resolvePeriodRange(
  period?: string,
  customFrom?: string,
  customTo?: string,
): { from: string; to: string } {
  if (period === 'custom' && customFrom && customTo) return { from: customFrom, to: customTo };
  const fy = getFYStartYear();
  const today = new Date();
  switch (period) {
    case 'last_fy':        return { from: `${fy - 1}-04-01`, to: `${fy}-03-31` };
    // Multi-FY ranges mirror convex/dashboard.ts resolveRange (2 FYs back → today; 5 years back → today).
    case 'last_2fy':       return { from: `${fy - 2}-04-01`, to: ymd(today) };
    case 'last_5y': {      const d = new Date(today); d.setFullYear(d.getFullYear() - 5); return { from: ymd(d), to: ymd(today) }; }
    case 'from_beginning': return { from: '2020-01-01', to: ymd(today) };
    case 'current_fy':
    default:               return { from: `${fy}-04-01`, to: `${fy + 1}-03-31` };
  }
}

export type Punctuality = {
  onTimeTenants: number;
  lateTenants: number;
  unpaidTenants: number;
  unpaidInvoices: number;
  invoicedTenants: number;
  collectionRatePct: number;
  awesome: Array<{ name: string; months: number; occupiedMonths: number; pct: number }>;
  stars: Array<{ name: string; months: number; occupiedMonths: number; pct: number }>;
  [k: string]: any;
};

// Tenant punctuality (On-time / Late / Unpaid + Awesome/Star customer lists).
// This RPC is RLS-protected — it returns 0 for the anon key — so it MUST be
// called with the logged-in user's Supabase access token (useAuth().token,
// which convex/otpAuth.ts issues from a real Supabase Auth sign-in).
export async function getTenantPunctuality(
  accessToken: string | null | undefined,
  period?: string,
  customFrom?: string,
  customTo?: string,
): Promise<Punctuality | null> {
  if (!accessToken) return null;
  const { from, to } = resolvePeriodRange(period, customFrom, customTo);
  const t = withTimeout(15000);
  try {
    const r = await fetch(`${REST}/rpc/get_tenant_punctuality`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`, // user's session, not anon → passes RLS
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_organization_id: ORG_ID, p_from: from, p_to: to }),
      signal: t.signal,
    });
    if (!r.ok) return null;
    return (await r.json()) as Punctuality;
  } catch {
    return null;
  } finally {
    t.done();
  }
}

// Convenience: hero "Revenue this month" + month-over-month trend %,
// plus the current deposits-held balance — all from the same RPC the
// web KpiHeroCard uses (p_period this_month / last_month).
export async function getHeroMonthly(): Promise<{
  revenueThisMonth: number;
  revenueLastMonth: number;
  momPct: number | null;
  depositsHeld: number;
} | null> {
  const [tm, lm] = await Promise.all([getMetricsV2('this_month'), getMetricsV2('last_month')]);
  if (!tm && !lm) return null;
  const revenueThisMonth = Number(tm?.totalRevenue ?? 0);
  const revenueLastMonth = Number(lm?.totalRevenue ?? 0);
  const momPct =
    revenueLastMonth > 0
      ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100)
      : null;
  return {
    revenueThisMonth,
    revenueLastMonth,
    momPct,
    depositsHeld: Number(tm?.totalDepositsHeld ?? 0),
  };
}

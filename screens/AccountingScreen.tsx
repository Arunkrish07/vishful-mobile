import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, Alert, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { colors, spacing, borderRadius, fontSize, glass } from '../lib/theme';
import { Button, Input, Badge, EmptyState, LoadingScreen, PickerSelect, GlassBackground, DateField, SearchField, IconBtnSolid } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { Ionicons } from '@expo/vector-icons';
import { useMountedRef, isAbortError } from '../lib/safeAsync';
import { fetchBankAccounts } from '../services/ticketService';

// ── design tokens (web dashboard parity — see DASH in DashboardScreen.tsx) ──
const ACC = {
  ink: '#0F172A',
  ink2: '#64748B',
  ink3: '#94A3B8',
  line: '#EEF1F6',
  soft: '#F8FAFC',
  purple: '#2563EB',
  pillInactiveBg: '#F1F3F9',
  good: '#16A34A',
  goodBg: '#DCFCE7',
  warn: '#EA580C',
  warnBg: '#FFEDD5',
  bad: '#DC2626',
  badBg: '#FEE2E2',
  info: '#1D4ED8',
  infoBg: '#EEF3FF',
};

const statusColor = (s: string) => {
  switch (s) { case 'paid': return ACC.good; case 'sent': return ACC.info;
    case 'partial': return ACC.warn; case 'overdue': return ACC.bad; default: return ACC.ink2; }
};

// ── period labels (web parity with Reports.tsx / ReportsScreen) ──
const PERIODS: { key: string; label: string }[] = [
  { key: 'current_fy',     label: 'Current FY' },
  { key: 'last_fy',        label: 'Last FY' },
  { key: 'last_2fy',       label: 'Last 2 FYs' },
  { key: 'last_5y',        label: 'Last 5 Years' },
  { key: 'from_beginning', label: 'Since Beginning' },
];

// compact money formatter for KPI/report tiles (screen uses "Rs" prefix)
const fmtMoney = (v: number) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 100000) return `Rs ${(n / 100000).toFixed(2)}L`;
  if (Math.abs(n) >= 1000) return `Rs ${(n / 1000).toFixed(1)}K`;
  return `Rs ${Math.round(n).toLocaleString('en-IN')}`;
};

const SECTIONS = [
  { key: 'invoices', label: 'Invoices' },
  { key: 'receipts', label: 'Receipts' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'payments', label: 'Rental Payments' },
  { key: 'reports',  label: 'Reports' },
];

// run a fetch, swallow errors → fallback value (keeps one bad action from
// wiping the rest of the screen); data is org-scoped server-side.
async function safeCall<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { const r = await fn(); return (r as any) ?? fallback; } catch { return fallback; }
}

function KpiTile({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <View style={styles.kpiTile}>
      <Text style={[styles.kpiValue, color ? { color } : null]}>{value}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
    </View>
  );
}

export default function AccountingScreen() {
  const { token } = useAuth();
  const mounted = useMountedRef();

  const [invoices, setInvoices] = useState<any[] | null>(null);
  const [stays, setStays] = useState<any[]>([]);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  // section switcher + period scoping (parity with web Accounting.tsx)
  const [section, setSection] = useState('invoices');
  const [period, setPeriod] = useState('current_fy');
  const [periodOpen, setPeriodOpen] = useState(false);
  const [reportsTab, setReportsTab] = useState<'pnl' | 'beds' | 'eb'>('pnl');

  // period-scoped summary + reports
  const [summary, setSummary] = useState<any>(null);
  const [pnl, setPnl] = useState<any[]>([]);
  const [bedProfit, setBedProfit] = useState<any[]>([]);
  const [ebRecon, setEbRecon] = useState<any[]>([]);

  // read-only ledgers
  const [receipts, setReceipts] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [ownerPayments, setOwnerPayments] = useState<any[]>([]);

  const [showAdd, setShowAdd] = useState(false);
  const [showPay, setShowPay] = useState<any>(null);
  const [tenantId, setTenantId] = useState('');
  const [month, setMonth] = useState('');
  const [rent, setRent] = useState('');
  const [elec, setElec] = useState('0');
  const [other, setOther] = useState('0');
  const [dueDate, setDueDate] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payMode, setPayMode] = useState('cash');
  const [payRef, setPayRef] = useState('');
  const [payBank, setPayBank] = useState('');
  const [bankAccounts, setBankAccounts] = useState<any[]>([]);
  // Standalone collection (a payment not tied to one specific invoice — the
  // ledger trigger FIFO-allocates it across the tenant's outstanding invoices).
  const [showCollect, setShowCollect] = useState(false);
  const [colTenant, setColTenant] = useState('');
  const [colAmount, setColAmount] = useState('');
  const [colDate, setColDate] = useState('');
  const [colMode, setColMode] = useState('cash');
  const [colRef, setColRef] = useState('');
  const [colBank, setColBank] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!token) return;
    setInvoices(null);
    Promise.all([
      sb.listInvoices(),
      sb.listBillingTenants(),
      sb.getPendingDues(),
    ]).then(([inv, s, dues]: any) => {
      if (!mounted.current) return;
      setInvoices(inv ?? []);
      setStays(s ?? []);
      setPendingTotal(dues?.totalPending ?? 0);
    }).catch((e: any) => {
      if (!mounted.current || isAbortError(e)) return;
      setInvoices([]);
      setStays([]);
      setPendingTotal(0);
    });
  }, [token, refreshKey]);

  // Period-scoped Financial Overview + Reports. Reloads when period changes.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      const [s, p, bp, eb] = await Promise.all([
        safeCall<any>(() => sb.getReportsSummary(period), null),
        safeCall<any[]>(() => sb.getPropertyPnL(period), []),
        safeCall<any[]>(() => sb.getBedProfitability(period), []),
        safeCall<any[]>(() => sb.getEBReconciliation(period), []),
      ]);
      if (cancelled || !mounted.current) return;
      setSummary(s || null);
      setPnl(Array.isArray(p) ? p : []);
      setBedProfit(Array.isArray(bp) ? bp : []);
      setEbRecon(Array.isArray(eb) ? eb : []);
    })();
    return () => { cancelled = true; };
  }, [token, period, refreshKey]);

  // Read-only ledgers (org-scoped, not period-scoped by their wrappers).
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      const [rc, ex, op, ba] = await Promise.all([
        safeCall<any[]>(() => sb.listReceipts(), []),
        safeCall<any[]>(() => sb.listExpenses(), []),
        safeCall<any[]>(() => sb.listOwnerPayments(), []),
        safeCall<any[]>(() => fetchBankAccounts(), []),
      ]);
      if (cancelled || !mounted.current) return;
      setReceipts(Array.isArray(rc) ? rc : []);
      setExpenses(Array.isArray(ex) ? ex : []);
      setOwnerPayments(Array.isArray(op) ? op : []);
      setBankAccounts(Array.isArray(ba) ? ba : []);
    })();
    return () => { cancelled = true; };
  }, [token, refreshKey]);

  const handleCreate = async () => {
    if (!tenantId || !month) { Alert.alert('Error', 'Select tenant and billing month'); return; }
    const activeStay = stays.find((s: any) => s.tenantId === tenantId && s.status === 'active');
    if (!activeStay) { Alert.alert('Error', 'Tenant has no active stay'); return; }
    // listBillingTenants now returns the real monthly_rental, so default to it when
    // the rent field is left blank; a manual entry still overrides.
    const rentAmount = Number(rent) || Number(activeStay.monthlyRent) || 0;
    if (!rentAmount || rentAmount <= 0) { Alert.alert('Error', 'Enter a rent amount greater than 0'); return; }
    setLoading(true);
    try {
      await sb.createInvoice({
        token: token!,
        tenantId,
        allotmentId: activeStay.allotmentId,
        propertyId: activeStay.propertyId,
        apartmentId: activeStay.apartmentId,
        bedId: activeStay.bedId,
        billingMonth: month,
        rentAmount,
        electricityAmount: Number(elec) || 0,
        otherCharges: Number(other) || 0,
        // Web parity: default due date is the 7th of the billing month (not now+7d).
        dueDate: dueDate || (/^\d{4}-\d{2}$/.test(month) ? `${month}-07` : new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]),
      });
      setShowAdd(false);
      setTenantId(''); setMonth(''); setRent(''); setElec('0'); setOther('0');
      setRefreshKey((k: number) => k + 1);
    } catch (e: any) { Alert.alert('Error', e.message); }
    setLoading(false);
  };

  const handlePayment = async () => {
    if (!payAmount || !showPay) return;
    const balance = Number(showPay.totalAmount || 0) - Number(showPay.paidAmount || 0);
    const amt = Number(payAmount);
    if (!(amt > 0)) { Alert.alert('Invalid amount', 'Enter a payment amount greater than 0.'); return; }
    if (amt > balance + 0.01) { Alert.alert('Amount too high', `Payment cannot exceed the outstanding balance of Rs ${balance.toLocaleString('en-IN')}.`); return; }
    if (payMode !== 'cash' && bankAccounts.length > 0 && !payBank) {
      Alert.alert('Bank required', 'Select the receiving bank account for a non-cash payment.'); return;
    }
    setLoading(true);
    try {
      const res = await sb.recordPayment({
        token: token!,
        invoiceId: showPay._id,
        paymentDate: new Date().toISOString().split('T')[0],
        paymentMode: payMode,
        amountPaid: amt,
        referenceNumber: payRef.trim() || null,
        bankAccountId: payBank || null,
      });
      if (res?.ok === false) { Alert.alert('Duplicate payment', res.reason || 'This payment looks like a duplicate and was not recorded.'); return; }
      setShowPay(null); setPayAmount(''); setPayRef(''); setPayBank('');
      setRefreshKey((k: number) => k + 1);
    } catch (e: any) { Alert.alert('Error', e.message); }
    setLoading(false);
  };

  // Standalone collection — a payment recorded against a tenant (allotment)
  // rather than one specific invoice. recordPayment inserts a receipt and the
  // ledger trigger FIFO-allocates it across the tenant's outstanding invoices.
  const handleAddCollection = async () => {
    const stay = stays.find((s: any) => s.tenantId === colTenant && s.status === 'active');
    if (!stay) { Alert.alert('Error', 'Select a tenant with an active stay.'); return; }
    const amt = Number(colAmount);
    if (!(amt > 0)) { Alert.alert('Invalid amount', 'Enter a collection amount greater than 0.'); return; }
    if (colMode !== 'cash' && bankAccounts.length > 0 && !colBank) {
      Alert.alert('Bank required', 'Select the receiving bank account for a non-cash payment.'); return;
    }
    setLoading(true);
    try {
      const res = await sb.recordPayment({
        token: token!,
        tenantId: colTenant,
        allotmentId: stay.allotmentId,
        propertyId: stay.propertyId,
        paymentDate: colDate || new Date().toISOString().split('T')[0],
        paymentMode: colMode,
        amountPaid: amt,
        referenceNumber: colRef.trim() || null,
        bankAccountId: colBank || null,
      });
      if (res?.ok === false) { Alert.alert('Duplicate payment', res.reason || 'This payment looks like a duplicate and was not recorded.'); return; }
      setShowCollect(false); setColTenant(''); setColAmount(''); setColRef(''); setColBank('');
      setRefreshKey((k: number) => k + 1);
    } catch (e: any) { Alert.alert('Error', e.message); }
    setLoading(false);
  };

  if (!invoices) return <LoadingScreen />;

  const filtered = (filter === 'all' ? invoices : invoices.filter((i: any) => i.status === filter))
    .filter((i: any) => {
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return [i.invoiceNumber, i.tenantName, i.propertyName, i.billingMonth, i.status]
        .filter(Boolean).some((v: any) => String(v).toLowerCase().includes(q));
    });
  const activeStays = stays.filter((s: any) => s.status === 'active');
  const tenantOpts = activeStays.map((s: any) => ({ label: `${s.tenantName} (${s.bedCode})`, value: s.tenantId }));
  const payModes = [
    { label: 'Cash', value: 'cash' },
    { label: 'UPI', value: 'upi' },
    { label: 'Bank Transfer', value: 'bank' },
    { label: 'Card', value: 'card' },
  ];
  const bankOpts = bankAccounts.map((b: any) => ({
    label: `${b.bank_name || 'Bank'}${b.account_number ? ` ····${String(b.account_number).slice(-4)}` : ''}`,
    value: b.id,
  }));

  // Canonical AR from v_tenant_current_dues (see getPendingDues) — not a client-side invoice sum.
  const totalPending = pendingTotal;

  // getReportsSummary returns { accounting, tenants, propertyStatus, tickets };
  // tolerate a flat shape too.
  const acc = (summary?.accounting ?? summary ?? {}) as any;
  const periodLabel = PERIODS.find(p => p.key === period)?.label || 'Current FY';

  // Receipts carry only tenant_id / tenant_allotment_id — resolve a display
  // name from the already-loaded billing tenants.
  const tenantNameFor = (r: any) => {
    const st = stays.find((s: any) => s.allotmentId && s.allotmentId === r.tenant_allotment_id)
      || stays.find((s: any) => s.tenantId && s.tenantId === r.tenant_id);
    return st?.tenantName || r.receipt_type || 'Payment';
  };

  return (
    <GlassBackground style={{ backgroundColor: '#FFFFFF' }}>
    <SafeAreaView style={{ flex: 1 }} edges={['top']}>
      <View style={[glass.header, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, backgroundColor: '#FFFFFF', borderBottomColor: ACC.line }]}>
        <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center', marginRight: 10 }}>
          <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 }}>Accounts</Text>
        </View>
        <TouchableOpacity onPress={() => setPeriodOpen(true)} style={styles.periodBtn}>
          <Text style={styles.periodBtnText} numberOfLines={1}>{periodLabel}</Text>
          <Ionicons name="chevron-down" size={13} color={colors.primary} />
        </TouchableOpacity>
        <IconBtnSolid onPress={() => setShowAdd(true)} />
      </View>
      {totalPending > 0 && (
        <View style={styles.pendingBanner}>
          <Ionicons name="alert-circle" size={18} color={ACC.bad} />
          <Text style={styles.pendingText}>Pending: Rs {totalPending.toLocaleString()}</Text>
        </View>
      )}

      {/* Section switcher */}
      <ScrollView horizontal style={styles.filters} showsHorizontalScrollIndicator={false}>
        {SECTIONS.map(s => (
          <TouchableOpacity key={s.key} style={[styles.filterChip, section === s.key && styles.filterActive]} onPress={() => setSection(s.key)}>
            <Text style={[styles.filterText, { textTransform: 'none' }, section === s.key && styles.filterTextActive]}>{s.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.xl, paddingBottom: 100 }}>
        {/* Financial Overview (period-scoped) */}
        <View style={{ marginBottom: spacing.lg }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm }}>
            <Text style={styles.sectionHeading}>Financial Overview</Text>
            <Text style={styles.sectionSub}>{periodLabel}</Text>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <KpiTile label="Total Invoiced" value={fmtMoney(acc.totalInvoiced || 0)} />
            <KpiTile label="Collections" value={fmtMoney(acc.totalCollections || 0)} color={ACC.good} />
            <KpiTile label="Expenses" value={fmtMoney(acc.totalExpenses || 0)} color={ACC.bad} />
            <KpiTile label="Profit" value={fmtMoney(acc.totalProfit || 0)} color={(acc.totalProfit || 0) >= 0 ? ACC.good : ACC.bad} />
            <KpiTile label="Deposits" value={fmtMoney(acc.depositCollections || 0)} color={colors.primary} />
            <KpiTile label="Pending Dues" value={fmtMoney(acc.totalPendingCollection || 0)} color={colors.primary} />
          </View>
        </View>

        {/* ── INVOICES ── */}
        {section === 'invoices' && (<>
          <View style={{ marginBottom: spacing.sm }}>
            <SearchField value={search} onChangeText={setSearch} placeholder="Search invoices..." />
          </View>
          <ScrollView horizontal style={{ marginBottom: spacing.md, maxHeight: 44 }} showsHorizontalScrollIndicator={false}>
            {['all', 'sent', 'partial', 'paid', 'overdue'].map(f => (
              <TouchableOpacity key={f} style={[styles.filterChip, filter === f && styles.filterActive]} onPress={() => setFilter(f)}>
                <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>{f}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          {filtered.length === 0 ? (
            <EmptyState title="No Invoices" subtitle="Create invoices for tenant billing" icon="receipt-outline" />
          ) : filtered.map((inv: any) => (
            <TouchableOpacity key={inv._id} style={styles.card} onPress={() => setShowPay(inv)}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={styles.invNum}>{inv.invoiceNumber}</Text>
                <Badge text={inv.status} color={statusColor(inv.status)} />
              </View>
              <Text style={styles.cardTitle}>{inv.tenantName}</Text>
              <Text style={styles.cardSub}>{inv.billingMonth} | {inv.propertyName}</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                <View>
                  <Text style={styles.cardSub}>Rent: Rs {inv.rentAmount}</Text>
                  {inv.electricityAmount > 0 && <Text style={styles.cardSub}>Elec: Rs {inv.electricityAmount}</Text>}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: ACC.ink }}>Rs {inv.totalAmount}</Text>
                  {inv.paidAmount > 0 && <Text style={{ fontSize: fontSize.sm, color: ACC.good, fontWeight: '600' }}>Paid: Rs {inv.paidAmount}</Text>}
                </View>
              </View>
            </TouchableOpacity>
          ))}
        </>)}

        {/* ── RECEIPTS + Add Collection ── */}
        {section === 'receipts' && (<>
          <View style={{ marginBottom: spacing.md }}>
            <Button
              title="Add Collection"
              icon="add-circle-outline"
              onPress={() => { setColDate(new Date().toISOString().split('T')[0]); setShowCollect(true); }}
            />
          </View>
          {receipts.length === 0 ? (
            <EmptyState title="No Receipts" subtitle="Recorded payments will appear here" icon="cash-outline" />
          ) : receipts.map((r: any) => (
            <View key={r.id} style={styles.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={styles.cardTitle} numberOfLines={1}>{tenantNameFor(r)}</Text>
                <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: ACC.good }}>Rs {Number(r.amount_paid || 0).toLocaleString('en-IN')}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
                <Text style={styles.cardSub}>{r.payment_date ? formatDate(r.payment_date) : '—'}{r.payment_mode ? ` · ${String(r.payment_mode).toUpperCase()}` : ''}</Text>
                {!!r.reference_number && <Text style={styles.cardSub} numberOfLines={1}>Ref: {r.reference_number}</Text>}
              </View>
            </View>
          ))}
        </>)}

        {/* ── EXPENSES (read-only) ── */}
        {section === 'expenses' && (
          expenses.length === 0 ? (
            <EmptyState title="No Expenses" subtitle="Recorded expenses will appear here" icon="receipt-outline" />
          ) : expenses.map((e: any) => (
            <View key={e.id} style={styles.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={styles.cardTitle} numberOfLines={1}>{e.category || 'Expense'}</Text>
                <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: ACC.bad }}>Rs {Number(e.amount || 0).toLocaleString('en-IN')}</Text>
              </View>
              {!!e.description && <Text style={styles.cardSub} numberOfLines={2}>{e.description}</Text>}
              <Text style={styles.cardSub}>{e.expense_date ? formatDate(e.expense_date) : '—'}</Text>
            </View>
          ))
        )}

        {/* ── RENTAL PAYMENTS / owner payouts (read-only) ── */}
        {section === 'payments' && (
          ownerPayments.length === 0 ? (
            <EmptyState title="No Rental Payments" subtitle="Owner payouts will appear here" icon="wallet-outline" />
          ) : ownerPayments.map((p: any) => (
            <View key={p.id ?? p._id ?? p.created_at} style={styles.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={styles.cardTitle} numberOfLines={1}>{p.owner_name || p.property_name || p.owner_id || 'Owner Payout'}</Text>
                <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: colors.primary }}>Rs {Number(p.amount || 0).toLocaleString('en-IN')}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
                <Text style={styles.cardSub}>{p.payment_date ? formatDate(p.payment_date) : (p.created_at ? formatDate(p.created_at) : '—')}{p.payment_mode ? ` · ${String(p.payment_mode).toUpperCase()}` : ''}</Text>
                {!!p.notes && <Text style={styles.cardSub} numberOfLines={1}>{p.notes}</Text>}
              </View>
            </View>
          ))
        )}

        {/* ── REPORTS (period-scoped) ── */}
        {section === 'reports' && (<>
          <ScrollView horizontal style={{ marginBottom: spacing.md, maxHeight: 44 }} showsHorizontalScrollIndicator={false}>
            {([['pnl', 'Property P&L'], ['beds', 'Bed Profitability'], ['eb', 'EB Reconciliation']] as const).map(([k, lbl]) => (
              <TouchableOpacity key={k} style={[styles.filterChip, reportsTab === k && styles.filterActive]} onPress={() => setReportsTab(k as any)}>
                <Text style={[styles.filterText, { textTransform: 'none' }, reportsTab === k && styles.filterTextActive]}>{lbl}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {reportsTab === 'pnl' && (
            pnl.length === 0 ? <EmptyState title="No P&L Data" subtitle="No property P&L for this period" icon="stats-chart-outline" />
            : pnl.map((p: any) => (
              <View key={p.id} style={styles.card}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <Text style={styles.cardTitle} numberOfLines={1}>{p.property_name}</Text>
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.primary }}>{p.occupancy}% occ</Text>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <KpiTile label="Revenue" value={fmtMoney(p.revenue)} color={ACC.good} />
                  <KpiTile label="Expenses" value={fmtMoney(p.totalExpense)} color={ACC.bad} />
                  <KpiTile label="Profit" value={fmtMoney(p.profit)} color={p.profit >= 0 ? ACC.good : ACC.bad} />
                  <KpiTile label="Rev / Bed" value={fmtMoney(p.revPerBed)} color={colors.primary} />
                </View>
              </View>
            ))
          )}

          {reportsTab === 'beds' && (
            bedProfit.length === 0 ? <EmptyState title="No Bed Data" subtitle="No bed profitability for this period" icon="bed-outline" />
            : bedProfit.map((b: any, i: number) => (
              <View key={i} style={styles.card}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardTitle}>{b.apartment_code} · {b.bed_code}</Text>
                    <Text style={styles.cardSub}>{b.property_name}</Text>
                  </View>
                  <Badge text={fmtMoney(b.profit)} color={b.isLoss ? ACC.bad : ACC.good} />
                </View>
                <View style={{ flexDirection: 'row', gap: 20, marginTop: 8 }}>
                  <View><Text style={styles.cardSub}>Revenue</Text><Text style={{ fontSize: fontSize.md, fontWeight: '800', color: ACC.good }}>{fmtMoney(b.revenue)}</Text></View>
                  <View><Text style={styles.cardSub}>Cost</Text><Text style={{ fontSize: fontSize.md, fontWeight: '800', color: ACC.bad }}>{fmtMoney(b.totalCost)}</Text></View>
                </View>
              </View>
            ))
          )}

          {reportsTab === 'eb' && (
            ebRecon.length === 0 ? <EmptyState title="No EB Data" subtitle="No EB reconciliation for this period" icon="flash-outline" />
            : ebRecon.map((e: any, i: number) => (
              <View key={i} style={styles.card}>
                <Text style={[styles.cardTitle, { marginBottom: 8 }]} numberOfLines={1}>{e.property_name}</Text>
                <View style={{ flexDirection: 'row', gap: 18 }}>
                  <View><Text style={styles.cardSub}>Billed</Text><Text style={{ fontSize: fontSize.md, fontWeight: '800', color: ACC.good }}>{fmtMoney(e.ebBilled)}</Text></View>
                  <View><Text style={styles.cardSub}>Actual</Text><Text style={{ fontSize: fontSize.md, fontWeight: '800', color: colors.primary }}>{fmtMoney(e.ebActual)}</Text></View>
                  <View><Text style={styles.cardSub}>Variance</Text><Text style={{ fontSize: fontSize.md, fontWeight: '800', color: e.variance >= 0 ? ACC.good : ACC.bad }}>{e.variance >= 0 ? '+' : ''}{fmtMoney(e.variance)} ({e.variancePct}%)</Text></View>
                </View>
              </View>
            ))
          )}
        </>)}
      </ScrollView>

      {/* Period selector modal */}
      <Modal visible={periodOpen} transparent animationType="fade" onRequestClose={() => setPeriodOpen(false)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setPeriodOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(30,18,48,0.45)', justifyContent: 'center', padding: 32 }}>
          <View style={{ backgroundColor: '#FFFFFF', borderRadius: 18, overflow: 'hidden' }}>
            <Text style={{ fontSize: 15, fontWeight: '800', color: ACC.ink, padding: 16, borderBottomWidth: 1, borderBottomColor: ACC.line }}>Select Period</Text>
            {PERIODS.map(p => (
              <TouchableOpacity key={p.key} onPress={() => { setPeriod(p.key); setPeriodOpen(false); }}
                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: ACC.line }}>
                <Text style={{ fontSize: 14, fontWeight: period === p.key ? '800' : '500', color: period === p.key ? colors.primary : ACC.ink }}>{p.label}</Text>
                {period === p.key && <Ionicons name="checkmark" size={18} color={colors.primary} />}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Create Invoice */}
      <Modal visible={showAdd} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={[glass.header, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg }]}>
            <TouchableOpacity onPress={() => setShowAdd(false)}>
              <Text style={{ color: colors.danger }}>Cancel</Text>
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text }}>New Invoice</Text>
            <View style={{ width: 50 }} />
          </View>
          <ScrollView style={{ padding: spacing.xl }}>
            <PickerSelect label="Tenant" value={tenantId} options={tenantOpts} onSelect={setTenantId} />
            <Input label="Billing Month (YYYY-MM)" value={month} onChangeText={setMonth} placeholder="2025-01" />
            <Input label="Rent Amount" value={rent} onChangeText={setRent} placeholder="Monthly rent" keyboardType="numeric" />
            <Input label="Electricity Amount" value={elec} onChangeText={setElec} placeholder="0" keyboardType="numeric" />
            <Input label="Other Charges" value={other} onChangeText={setOther} placeholder="0" keyboardType="numeric" />
            <View style={{ marginBottom: 14 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: ACC.ink2, marginBottom: 6 }}>Due Date</Text>
              <DateField value={dueDate} onChange={setDueDate} />
            </View>
            <Button title="Create Invoice" onPress={handleCreate} loading={loading} icon="receipt-outline" />
          </ScrollView>
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* Record Payment */}
      <Modal visible={!!showPay} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={[glass.header, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg }]}>
            <TouchableOpacity onPress={() => setShowPay(null)}>
              <Text style={{ color: colors.danger }}>Close</Text>
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text }}>{showPay?.invoiceNumber}</Text>
            <View style={{ width: 50 }} />
          </View>
          {showPay && (
            <ScrollView style={{ padding: spacing.xl }}>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryLabel}>Total Amount</Text>
                <Text style={styles.summaryValue}>Rs {showPay.totalAmount}</Text>
                <Text style={styles.summaryLabel}>Paid</Text>
                <Text style={[styles.summaryValue, { color: ACC.good }]}>Rs {showPay.paidAmount}</Text>
                <Text style={styles.summaryLabel}>Balance</Text>
                <Text style={[styles.summaryValue, { color: ACC.bad }]}>Rs {showPay.totalAmount - showPay.paidAmount}</Text>
              </View>
              {showPay.status !== 'paid' && (
                <>
                  <Input label="Amount" value={payAmount} onChangeText={setPayAmount}
                    placeholder={String(showPay.totalAmount - showPay.paidAmount)} keyboardType="numeric" />
                  <PickerSelect label="Payment Mode" value={payMode} options={payModes} onSelect={setPayMode} />
                  {bankOpts.length > 0 && (
                    <PickerSelect
                      label={payMode !== 'cash' ? 'Bank Account *' : 'Bank Account'}
                      value={payBank} options={bankOpts} onSelect={setPayBank}
                    />
                  )}
                  <Input label="Reference No. (UTR / txn ref)" value={payRef} onChangeText={setPayRef} placeholder="Optional — bank/UPI reference" />
                  <Button title="Record Payment" onPress={handlePayment} loading={loading} icon="cash-outline" />
                </>
              )}
            </ScrollView>
          )}
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* Add Collection — standalone payment (FIFO-allocated across invoices) */}
      <Modal visible={showCollect} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={[glass.header, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg }]}>
            <TouchableOpacity onPress={() => setShowCollect(false)}>
              <Text style={{ color: colors.danger }}>Cancel</Text>
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text }}>Add Collection</Text>
            <View style={{ width: 50 }} />
          </View>
          <ScrollView style={{ padding: spacing.xl }}>
            <PickerSelect label="Tenant" value={colTenant} options={tenantOpts} onSelect={setColTenant} />
            <Input label="Amount" value={colAmount} onChangeText={setColAmount} placeholder="Amount received" keyboardType="numeric" />
            <View style={{ marginBottom: 14 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: ACC.ink2, marginBottom: 6 }}>Payment Date</Text>
              <DateField value={colDate} onChange={setColDate} />
            </View>
            <PickerSelect label="Payment Mode" value={colMode} options={payModes} onSelect={setColMode} />
            {bankOpts.length > 0 && (
              <PickerSelect
                label={colMode !== 'cash' ? 'Bank Account *' : 'Bank Account'}
                value={colBank} options={bankOpts} onSelect={setColBank}
              />
            )}
            <Input label="Reference No. (UTR / txn ref)" value={colRef} onChangeText={setColRef} placeholder="Optional — bank/UPI reference" />
            <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: 14 }}>
              Allocated automatically across the tenant's outstanding invoices (oldest first).
            </Text>
            <Button title="Record Collection" onPress={handleAddCollection} loading={loading} icon="cash-outline" />
          </ScrollView>
        </SafeAreaView>
        </GlassBackground>
      </Modal>
    </SafeAreaView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: spacing.xl, paddingVertical: spacing.lg,
  },
  title: { fontSize: fontSize.xl, fontWeight: '700', color: colors.text },
  addBtn: { width: 40, height: 40, borderRadius: 14, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    shadowColor: colors.primary, shadowOpacity: 0.4, shadowRadius: 10, elevation: 5 },
  pendingBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: ACC.badBg, borderWidth: 1, borderColor: '#FECACA',
    borderRadius: 14, padding: spacing.md, marginHorizontal: spacing.xl, marginTop: spacing.sm,
  },
  pendingText: { fontSize: fontSize.sm, color: ACC.bad, fontWeight: '700' },
  filters: { backgroundColor: '#FFFFFF', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, maxHeight: 50,
    borderBottomWidth: 1, borderBottomColor: ACC.line },
  filterChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: ACC.pillInactiveBg, marginRight: 8,
    borderWidth: 1, borderColor: ACC.pillInactiveBg },
  filterActive: { backgroundColor: ACC.purple, borderColor: ACC.purple },
  filterText: { fontSize: fontSize.sm, color: ACC.ink2, textTransform: 'capitalize', fontWeight: '600' },
  filterTextActive: { color: colors.white, fontWeight: '700' },
  card: {
    backgroundColor: '#FFFFFF', borderRadius: 16, padding: spacing.lg,
    marginBottom: spacing.md, borderWidth: 1, borderColor: ACC.line,
    shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
  invNum: { fontSize: fontSize.xs, fontWeight: '700', color: colors.primary },
  cardTitle: { fontSize: fontSize.md, fontWeight: '800', color: ACC.ink },
  cardSub: { fontSize: fontSize.sm, color: ACC.ink2 },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: ACC.line,
  },
  summaryCard: {
    backgroundColor: '#FFFFFF', borderRadius: 16, padding: spacing.xl, marginBottom: spacing.xl,
    borderWidth: 1, borderColor: ACC.line,
    shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
  summaryLabel: { fontSize: fontSize.sm, color: ACC.ink2, marginTop: 8 },
  summaryValue: { fontSize: fontSize.xl, fontWeight: '800', color: ACC.ink },
  periodBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 11, paddingVertical: 8,
    borderRadius: 999, backgroundColor: '#fff', borderWidth: 1, borderColor: ACC.line, marginRight: 8, maxWidth: 130,
  },
  periodBtnText: { fontSize: 12, fontWeight: '700', color: colors.primary, flexShrink: 1 },
  sectionHeading: { fontSize: 17, fontWeight: '800', color: ACC.ink },
  sectionSub: { fontSize: fontSize.sm, fontWeight: '700', color: colors.primary },
  kpiTile: {
    flexGrow: 1, flexBasis: '30%', minWidth: '30%', backgroundColor: '#FFFFFF', borderRadius: 16,
    padding: spacing.md, borderWidth: 1, borderColor: ACC.line,
    shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
  kpiValue: { fontSize: fontSize.md, fontWeight: '800', color: ACC.ink, letterSpacing: -0.3 },
  kpiLabel: { fontSize: fontSize.xs, color: ACC.ink2, marginTop: 2 },
});
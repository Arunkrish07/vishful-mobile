import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, Alert, Image, Linking, Platform, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { colors, spacing, borderRadius, fontSize, glass } from '../lib/theme';
import { Button, Input, Badge, EmptyState, LoadingScreen, PickerSelect, GlassBackground, DateField, SearchField, IconBtnSolid } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { Ionicons } from '@expo/vector-icons';
import { useMountedRef, isAbortError } from '../lib/safeAsync';
import { fetchBankAccounts } from '../services/ticketService';
import { buildReminderMessage, formatPendingAmount } from '../lib/outstandingReminders';
import { shareInvoicePdf, shareReceiptPdf } from '../lib/invoicePdf';

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
  { key: 'billing',  label: 'Generate Bills' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'receipts', label: 'Receipts' },
  { key: 'adjustments', label: 'Adjustments' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'payments', label: 'Rental Payments' },
  { key: 'settlements', label: 'Settlements' },
  { key: 'exit_recon', label: 'Exit Recon' },
  { key: 'gst', label: 'GST' },
  { key: 'ledger', label: 'Tenant Ledger' },
  { key: 'trial_balance', label: 'Trial Balance' },
  { key: 'reports',  label: 'Reports' },
];

// Last N calendar months as "yyyy-MM" (newest first), for the billing picker.
function recentBillingMonths(n: number): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

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
  // Outstanding Dues — ledger-backed reminder audience (read-only preview).
  const [showOutstanding, setShowOutstanding] = useState(false);
  const [outstanding, setOutstanding] = useState<any[]>([]);
  const [outstandingLoading, setOutstandingLoading] = useState(false);
  const [orgName, setOrgName] = useState('Vishful Spaces LLP');
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);
  // Generate Bills (billing) tab
  const billMonths = React.useMemo(() => recentBillingMonths(4), []);
  const [billMonth, setBillMonth] = useState<string>(() => recentBillingMonths(1)[0]);
  const [billPreviews, setBillPreviews] = useState<any[] | null>(null);
  const [billLoading, setBillLoading] = useState(false);
  const [billGenerating, setBillGenerating] = useState(false);
  // Invoice detail (read-only, web parity)
  const [invDetail, setInvDetail] = useState<{ inv: any; lineItems: any[]; ebShares: any[] } | null>(null);
  const [invDetailLoading, setInvDetailLoading] = useState(false);
  // Adjustments (read-only, web parity)
  const [adjustments, setAdjustments] = useState<any[] | null>(null);
  const [adjLoading, setAdjLoading] = useState(false);
  const [adjType, setAdjType] = useState<'all' | 'credit_note' | 'debit_note'>('all');
  // Settlements / Exit-recon / GST / Trial balance (read-only, web parity)
  const [settlements, setSettlements] = useState<any[] | null>(null);
  const [exitRecon, setExitRecon] = useState<any[] | null>(null);
  const [gstFiled, setGstFiled] = useState<any[] | null>(null);
  const [trialBal, setTrialBal] = useState<any | null>(null);
  const [secLoading, setSecLoading] = useState(false);
  const [ledgerTenant, setLedgerTenant] = useState('');
  const [ledger, setLedger] = useState<any | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  // Adjustments load when its tab opens.
  useEffect(() => {
    if (section !== 'adjustments' || adjustments !== null) return;
    let cancelled = false;
    setAdjLoading(true);
    (async () => {
      try {
        const rows: any = await sb.listAdjustments();
        if (!cancelled && mounted.current) setAdjustments(Array.isArray(rows) ? rows : []);
      } catch { if (!cancelled && mounted.current) setAdjustments([]); }
      finally { if (!cancelled && mounted.current) setAdjLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [section, adjustments]);

  // Load the read-only accounting sections on demand (Settlements/Exit/GST/Trial Balance).
  useEffect(() => {
    let cancelled = false;
    const need = (
      (section === 'settlements' && settlements === null) ||
      (section === 'exit_recon' && exitRecon === null) ||
      (section === 'gst' && gstFiled === null) ||
      (section === 'trial_balance' && trialBal === null)
    );
    if (!need) return;
    setSecLoading(true);
    (async () => {
      try {
        if (section === 'settlements') { const r: any = await sb.getDepositSettlements(); if (!cancelled) setSettlements(Array.isArray(r) ? r : []); }
        else if (section === 'exit_recon') { const r: any = await sb.getExitReconciliationWorklist(); if (!cancelled) setExitRecon(Array.isArray(r) ? r : []); }
        else if (section === 'gst') { const r: any = await sb.getGstFiledWorkings(); if (!cancelled) setGstFiled(Array.isArray(r) ? r : []); }
        else if (section === 'trial_balance') {
          const now = new Date(); const fyStartY = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
          const r: any = await sb.getTrialBalance(`${fyStartY}-04-01`, `${fyStartY + 1}-03-31`);
          if (!cancelled) setTrialBal(r || { rows: [], periodTotals: { debit: 0, credit: 0 }, asOfTotals: { debit: 0, credit: 0 } });
        }
      } catch {
        if (!cancelled) {
          if (section === 'settlements') setSettlements([]); else if (section === 'exit_recon') setExitRecon([]);
          else if (section === 'gst') setGstFiled([]); else if (section === 'trial_balance') setTrialBal({ rows: [], periodTotals: { debit: 0, credit: 0 }, asOfTotals: { debit: 0, credit: 0 } });
        }
      } finally { if (!cancelled) setSecLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [section, settlements, exitRecon, gstFiled, trialBal]);

  // Org name for PDF headers — loaded once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s: any = await sb.getOrgSettings();
        if (!cancelled && mounted.current && s?.organizationName) setOrgName(String(s.organizationName));
      } catch { /* keep default */ }
    })();
    return () => { cancelled = true; };
  }, []);

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

  // Outstanding Dues — ledger-backed audience of who currently owes money.
  const openOutstanding = async () => {
    setShowOutstanding(true);
    setOutstandingLoading(true);
    try {
      const [rows, org]: [any, any] = await Promise.all([
        sb.fetchOutstandingRecipients(),
        sb.getOrgSettings().catch(() => null),
      ]);
      if (!mounted.current) return;
      setOutstanding(Array.isArray(rows) ? rows : []);
      if (org?.organizationName) setOrgName(String(org.organizationName));
    } catch (e: any) {
      if (mounted.current && !isAbortError(e)) { setOutstanding([]); Alert.alert('Outstanding Dues', e?.message || 'Could not load outstanding dues.'); }
    } finally {
      if (mounted.current) setOutstandingLoading(false);
    }
  };

  // Open the phone's WhatsApp (falls back to SMS) with a prefilled reminder.
  const remindOnWhatsApp = async (rec: any) => {
    const digits = String(rec?.phone || '').replace(/\D/g, '');
    if (digits.length < 10) { Alert.alert('No phone', `No mobile number on file for ${rec?.tenant_name || 'this tenant'}.`); return; }
    const e164 = digits.length === 10 ? `91${digits}` : digits; // assume India when no country code
    const text = buildReminderMessage(rec?.tenant_name || '', Number(rec?.pending_amount) || 0, orgName);
    const wa = `https://wa.me/${e164}?text=${encodeURIComponent(text)}`;
    try {
      const ok = await Linking.canOpenURL(wa);
      if (ok) { await Linking.openURL(wa); return; }
      await Linking.openURL(`sms:${e164}${Platform.OS === 'ios' ? '&' : '?'}body=${encodeURIComponent(text)}`);
    } catch {
      Alert.alert('Could not open WhatsApp', 'No messaging app is available to send the reminder.');
    }
  };

  const shareInv = async (inv: any) => {
    setPdfBusy(inv._id || inv.id);
    try { await shareInvoicePdf(inv, orgName); }
    catch (e: any) { Alert.alert('Invoice PDF', e?.message || 'Could not generate the invoice PDF.'); }
    finally { if (mounted.current) setPdfBusy(null); }
  };
  const shareRcpt = async (r: any) => {
    setPdfBusy(r.id);
    try { await shareReceiptPdf(r, tenantNameFor(r), orgName); }
    catch (e: any) { Alert.alert('Receipt PDF', e?.message || 'Could not generate the receipt PDF.'); }
    finally { if (mounted.current) setPdfBusy(null); }
  };

  const loadBillPreview = async () => {
    setBillLoading(true);
    try {
      const rows: any = await sb.previewBills(billMonth);
      if (mounted.current) setBillPreviews(Array.isArray(rows) ? rows : []);
    } catch (e: any) {
      if (mounted.current && !isAbortError(e)) { setBillPreviews([]); Alert.alert('Preview', e?.message || 'Could not build the billing preview.'); }
    } finally {
      if (mounted.current) setBillLoading(false);
    }
  };

  const doGenerateBills = () => {
    const n = billPreviews?.length || 0;
    if (!n) { Alert.alert('Nothing to generate', 'Run a preview first.'); return; }
    Alert.alert(
      'Generate bills',
      `This will create/replace ${n} invoice${n === 1 ? '' : 's'} for ${monthLabel(billMonth)}. Existing invoices for these tenants this month are replaced. Continue?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Generate', style: 'default', onPress: async () => {
          setBillGenerating(true);
          try {
            const r: any = await sb.generateBills(billMonth);
            Alert.alert('Bills generated', `Created/updated ${r?.count ?? 0} invoice${(r?.count ?? 0) === 1 ? '' : 's'} for ${monthLabel(billMonth)}.`);
            setBillPreviews(null);
            setRefreshKey((k: number) => k + 1);
          } catch (e: any) {
            Alert.alert('Generate failed', e?.message || 'Could not generate bills.');
          } finally {
            if (mounted.current) setBillGenerating(false);
          }
        } },
      ],
    );
  };

  const openLedger = async (tenantId: string) => {
    if (!tenantId) { setLedger(null); return; }
    setLedger(null); setLedgerLoading(true);
    try {
      const d: any = await sb.getTenantLedger({ tenantId });
      if (mounted.current) setLedger(d || { entries: [], summary: {} });
    } catch {
      if (mounted.current) setLedger({ entries: [], summary: {} });
    } finally {
      if (mounted.current) setLedgerLoading(false);
    }
  };

  const openInvoiceDetail = async (inv: any) => {
    setInvDetail({ inv, lineItems: [], ebShares: [] });
    setInvDetailLoading(true);
    try {
      const d: any = await sb.getInvoiceDetail(inv.id);
      if (mounted.current) setInvDetail({ inv, lineItems: d?.lineItems || [], ebShares: d?.ebShares || [] });
    } catch {
      if (mounted.current) setInvDetail({ inv, lineItems: [], ebShares: [] });
    } finally {
      if (mounted.current) setInvDetailLoading(false);
    }
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
        {section === 'billing' && (<>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.md }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {billMonths.map(mo => {
                const active = billMonth === mo;
                return (
                  <TouchableOpacity key={mo} onPress={() => { setBillMonth(mo); setBillPreviews(null); }}
                    style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 99, backgroundColor: active ? ACC.purple : '#F1F3F9' }}>
                    <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>{monthLabel(mo)}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
          <Button title={billLoading ? 'Building preview…' : 'Preview Bills'} icon="calculator-outline" onPress={loadBillPreview} loading={billLoading} />
          {billPreviews !== null && !billLoading && (
            billPreviews.length === 0 ? (
              <EmptyState title="No eligible tenants" subtitle={`No bills to generate for ${monthLabel(billMonth)}`} icon="document-text-outline" />
            ) : (
              <View style={{ marginTop: spacing.md }}>
                <View style={{ backgroundColor: '#EEF3FF', borderRadius: 14, padding: 12, marginBottom: 10 }}>
                  <Text style={{ fontSize: fontSize.sm, color: ACC.ink2 }}>{billPreviews.length} invoice{billPreviews.length === 1 ? '' : 's'} · {monthLabel(billMonth)}</Text>
                  <Text style={{ fontSize: fontSize.lg, fontWeight: '900', color: ACC.ink, marginTop: 2 }}>
                    Total {fmtMoney(billPreviews.reduce((s: number, p: any) => s + (Number(p.total) || 0), 0))}
                  </Text>
                  <Text style={{ fontSize: 11, color: ACC.ink2, marginTop: 2 }}>
                    Rent {fmtMoney(billPreviews.reduce((s: number, p: any) => s + (Number(p.rent_amount) || 0), 0))} · EB {fmtMoney(billPreviews.reduce((s: number, p: any) => s + (Number(p.eb_amount) || 0), 0))}
                  </Text>
                </View>
                <Button title={billGenerating ? 'Generating…' : `Generate ${billPreviews.length} Bills`} icon="checkmark-done-outline" onPress={doGenerateBills} loading={billGenerating} />
                <View style={{ height: 10 }} />
                {billPreviews.map((p: any) => {
                  const st = String(p.staying_status || '').toLowerCase();
                  const stCfg = st.includes('notice') ? { bg: '#FFEDD5', c: '#EA580C', label: 'On Notice' }
                    : st === 'exited' ? { bg: '#FEE2E2', c: '#DC2626', label: 'Vacated' }
                    : { bg: '#DCFCE7', c: '#16A34A', label: 'Staying' };
                  return (
                    <View key={p.allotment_id} style={styles.card}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <View style={{ flex: 1, paddingRight: 8 }}>
                          <Text style={styles.cardTitle} numberOfLines={1}>{p.tenant_name}</Text>
                          <Text style={styles.cardSub}>{p.apartment_code}-{p.bed_code} · {p.stay_days}/{p.total_days_in_month} days</Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: ACC.ink }}>{fmtMoney(p.total)}</Text>
                          <View style={{ backgroundColor: stCfg.bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, marginTop: 3 }}>
                            <Text style={{ fontSize: 10, fontWeight: '800', color: stCfg.c }}>{stCfg.label}</Text>
                          </View>
                        </View>
                      </View>
                      <View style={{ flexDirection: 'row', gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
                        <Text style={styles.cardSub}>Rent {fmtMoney(p.rent_amount)}</Text>
                        {Number(p.eb_amount) > 0 && <Text style={styles.cardSub}>EB {fmtMoney(p.eb_amount)}</Text>}
                        {Number(p.estimated_eb_amount) > 0 && <Text style={styles.cardSub}>Est. EB {fmtMoney(p.estimated_eb_amount)}</Text>}
                        {Number(p.exit_charges) > 0 && <Text style={[styles.cardSub, { color: '#DC2626' }]}>Exit {fmtMoney(p.exit_charges)}</Text>}
                      </View>
                    </View>
                  );
                })}
              </View>
            )
          )}
        </>)}

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
          {filtered.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing.md }}>
              {([
                ['Rental', filtered.reduce((s: number, i: any) => s + (Number(i.rentAmount) || 0), 0), ACC.ink],
                ['EB', filtered.reduce((s: number, i: any) => s + (Number(i.electricityAmount) || 0) + (Number(i.estimatedEb) || 0), 0), colors.primary],
                ['Other', filtered.reduce((s: number, i: any) => s + (Number(i.otherCharges) || 0) + (Number(i.lateFee) || 0), 0), ACC.ink2],
                ['Total', filtered.reduce((s: number, i: any) => s + (Number(i.totalAmount) || 0), 0), ACC.good],
              ] as const).map(([label, val, col]) => (
                <View key={label} style={{ flexGrow: 1, minWidth: '46%', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: ACC.line, padding: 10 }}>
                  <Text style={{ fontSize: 10, color: ACC.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</Text>
                  <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: col as string, marginTop: 2 }}>{fmtMoney(val as number)}</Text>
                </View>
              ))}
              <Text style={{ width: '100%', fontSize: 11, color: ACC.ink2 }}>{filtered.length} invoice{filtered.length === 1 ? '' : 's'} (filtered)</Text>
            </View>
          )}
          {filtered.length === 0 ? (
            <EmptyState title="No Invoices" subtitle="Create invoices for tenant billing" icon="receipt-outline" />
          ) : filtered.map((inv: any) => (
            <TouchableOpacity key={inv._id} style={styles.card} onPress={() => openInvoiceDetail(inv)}>
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
                  {inv.estimatedEb > 0 && <Text style={styles.cardSub}>Est. EB: Rs {inv.estimatedEb}</Text>}
                  {inv.lateFee > 0 && <Text style={[styles.cardSub, { color: '#DC2626' }]}>Late fee: Rs {inv.lateFee}</Text>}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: ACC.ink }}>Rs {inv.totalAmount}</Text>
                  {inv.paidAmount > 0 && <Text style={{ fontSize: fontSize.sm, color: ACC.good, fontWeight: '600' }}>Paid: Rs {inv.paidAmount}</Text>}
                </View>
              </View>
              <TouchableOpacity
                onPress={() => shareInv(inv)}
                disabled={pdfBusy === (inv._id || inv.id)}
                style={{ marginTop: 10, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, paddingHorizontal: 12, borderRadius: borderRadius.md, borderWidth: 1, borderColor: ACC.line }}>
                {pdfBusy === (inv._id || inv.id)
                  ? <ActivityIndicator size="small" color={ACC.purple} />
                  : <><Ionicons name="download-outline" size={15} color={ACC.purple} /><Text style={{ color: ACC.purple, fontWeight: '700', fontSize: fontSize.sm }}>PDF</Text></>}
              </TouchableOpacity>
            </TouchableOpacity>
          ))}
        </>)}

        {/* ── RECEIPTS + Add Collection ── */}
        {section === 'receipts' && (<>
          <View style={{ marginBottom: spacing.md, flexDirection: 'row', gap: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Button
                title="Add Collection"
                icon="add-circle-outline"
                onPress={() => { setColDate(new Date().toISOString().split('T')[0]); setShowCollect(true); }}
              />
            </View>
            <TouchableOpacity
              onPress={openOutstanding}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, borderRadius: borderRadius.md, borderWidth: 1, borderColor: ACC.line, backgroundColor: '#fff' }}>
              <Ionicons name="notifications-outline" size={16} color={ACC.purple} />
              <Text style={{ color: ACC.purple, fontWeight: '700', fontSize: fontSize.sm }}>Outstanding</Text>
            </TouchableOpacity>
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
              <TouchableOpacity
                onPress={() => shareRcpt(r)}
                disabled={pdfBusy === r.id}
                style={{ marginTop: 10, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, paddingHorizontal: 12, borderRadius: borderRadius.md, borderWidth: 1, borderColor: ACC.line }}>
                {pdfBusy === r.id
                  ? <ActivityIndicator size="small" color={ACC.good} />
                  : <><Ionicons name="download-outline" size={15} color={ACC.good} /><Text style={{ color: ACC.good, fontWeight: '700', fontSize: fontSize.sm }}>Receipt PDF</Text></>}
              </TouchableOpacity>
            </View>
          ))}
        </>)}

        {/* ── ADJUSTMENTS (credit/debit notes, read-only) ── */}
        {section === 'adjustments' && (
          adjLoading || adjustments === null ? (
            <ActivityIndicator color={ACC.purple} style={{ marginTop: 30 }} />
          ) : (() => {
            const cr = adjustments.filter((a: any) => a.adjustmentType === 'credit_note').reduce((s: number, a: any) => s + (Number(a.amount) || 0), 0);
            const db = adjustments.filter((a: any) => a.adjustmentType === 'debit_note').reduce((s: number, a: any) => s + (Number(a.amount) || 0), 0);
            const shown = adjType === 'all' ? adjustments : adjustments.filter((a: any) => a.adjustmentType === adjType);
            return (
              <>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: spacing.md }}>
                  <View style={{ flex: 1, backgroundColor: '#ECFDF5', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#BBF7D0' }}>
                    <Text style={{ fontSize: 10, color: '#16A34A', textTransform: 'uppercase' }}>Credits</Text>
                    <Text style={{ fontSize: fontSize.md, fontWeight: '900', color: '#16A34A' }}>{fmtMoney(cr)}</Text>
                  </View>
                  <View style={{ flex: 1, backgroundColor: '#FEF2F2', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#FECACA' }}>
                    <Text style={{ fontSize: 10, color: '#DC2626', textTransform: 'uppercase' }}>Debits</Text>
                    <Text style={{ fontSize: fontSize.md, fontWeight: '900', color: '#DC2626' }}>{fmtMoney(db)}</Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: spacing.md }}>
                  {([['all', 'All'], ['credit_note', 'Credits'], ['debit_note', 'Debits']] as const).map(([k, lbl]) => (
                    <TouchableOpacity key={k} style={[styles.filterChip, adjType === k && styles.filterActive]} onPress={() => setAdjType(k as any)}>
                      <Text style={[styles.filterText, { textTransform: 'none' }, adjType === k && styles.filterTextActive]}>{lbl}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {shown.length === 0 ? (
                  <EmptyState title="No adjustments" subtitle="Credit and debit notes appear here" icon="swap-horizontal-outline" />
                ) : shown.map((a: any) => {
                  const isCredit = a.adjustmentType === 'credit_note';
                  return (
                    <View key={a.id} style={styles.card}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <View style={{ flex: 1, paddingRight: 8 }}>
                          <Text style={styles.cardTitle} numberOfLines={1}>{a.tenantName}</Text>
                          <Text style={styles.cardSub}>{a.adjustmentDate ? formatDate(a.adjustmentDate) : '—'} · {String(a.category).replace(/_/g, ' ')}{a.referenceNumber ? ` · ${a.referenceNumber}` : ''}</Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: isCredit ? '#16A34A' : '#DC2626' }}>{isCredit ? '+' : '−'} {fmtMoney(a.amount)}</Text>
                          <View style={{ backgroundColor: isCredit ? '#DCFCE7' : '#FEE2E2', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, marginTop: 3 }}>
                            <Text style={{ fontSize: 10, fontWeight: '800', color: isCredit ? '#16A34A' : '#DC2626' }}>{isCredit ? 'Credit' : 'Debit'}</Text>
                          </View>
                        </View>
                      </View>
                      {!!a.reason && <Text style={[styles.cardSub, { marginTop: 6 }]} numberOfLines={2}>{a.reason}</Text>}
                    </View>
                  );
                })}
              </>
            );
          })()
        )}

        {/* ── SETTLEMENTS (deposit settlements, read-only) ── */}
        {section === 'settlements' && (
          secLoading || settlements === null ? <ActivityIndicator color={ACC.purple} style={{ marginTop: 30 }} /> :
          settlements.length === 0 ? <EmptyState title="No settlements" subtitle="Deposit settlements appear here" icon="wallet-outline" /> : (
            <>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: spacing.md }}>
                <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: ACC.line }}>
                  <Text style={{ fontSize: 10, color: ACC.ink2, textTransform: 'uppercase' }}>Total Deposits</Text>
                  <Text style={{ fontSize: fontSize.md, fontWeight: '900', color: ACC.ink }}>{fmtMoney(settlements.reduce((s: number, x: any) => s + (Number(x.depositAmount) || 0), 0))}</Text>
                </View>
                <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: ACC.line }}>
                  <Text style={{ fontSize: 10, color: ACC.ink2, textTransform: 'uppercase' }}>Total Refunds</Text>
                  <Text style={{ fontSize: fontSize.md, fontWeight: '900', color: ACC.good }}>{fmtMoney(settlements.reduce((s: number, x: any) => s + Math.max(Number(x.refundAmount) || 0, 0), 0))}</Text>
                </View>
              </View>
              {settlements.map((x: any) => {
                const payable = Number(x.refundAmount) < 0;
                return (
                  <View key={x.id} style={styles.card}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View style={{ flex: 1, paddingRight: 8 }}>
                        <Text style={styles.cardTitle} numberOfLines={1}>{x.tenantName}</Text>
                        <Text style={styles.cardSub}>{x.settlementDate ? formatDate(x.settlementDate) : '—'} · {x.status}</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={{ fontSize: 10, color: ACC.ink3 }}>{payable ? 'Amount Payable' : 'Refund'}</Text>
                        <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: payable ? '#DC2626' : ACC.good }}>{fmtMoney(Math.abs(x.refundAmount))}</Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                      <Text style={styles.cardSub}>Deposit {fmtMoney(x.depositAmount)}</Text>
                      <Text style={styles.cardSub}>Deductions {fmtMoney(x.totalDeductions)}</Text>
                      {x.damages > 0 && <Text style={styles.cardSub}>Damages {fmtMoney(x.damages)}</Text>}
                    </View>
                  </View>
                );
              })}
            </>
          )
        )}

        {/* ── EXIT RECONCILIATION (worklist, read-only) ── */}
        {section === 'exit_recon' && (
          secLoading || exitRecon === null ? <ActivityIndicator color={ACC.purple} style={{ marginTop: 30 }} /> :
          exitRecon.length === 0 ? <EmptyState title="All exits reconciled" subtitle="No pending exit settlements" icon="checkmark-done-outline" /> : (
            <>
              <Text style={{ fontSize: fontSize.sm, color: ACC.ink2, marginBottom: spacing.md }}>{exitRecon.length} unsettled exit{exitRecon.length === 1 ? '' : 's'}</Text>
              {exitRecon.map((x: any) => (
                <View key={x.allotmentId} style={styles.card}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ flex: 1, paddingRight: 8 }}>
                      <Text style={styles.cardTitle} numberOfLines={1}>{x.tenantName}</Text>
                      <Text style={styles.cardSub}>{x.bedLabel} · exited {x.actualExitDate ? formatDate(x.actualExitDate) : '—'}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ fontSize: 10, color: ACC.ink3 }}>Suggested refund</Text>
                      <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: ACC.good }}>{fmtMoney(x.refund)}</Text>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                    <Text style={styles.cardSub}>Dues {fmtMoney(x.duesNow)}</Text>
                    <Text style={styles.cardSub}>Deposit {fmtMoney(x.depositHeld)}</Text>
                    {!!x.settlementStatus && <Text style={styles.cardSub}>{x.settlementStatus}</Text>}
                  </View>
                </View>
              ))}
            </>
          )
        )}

        {/* ── GST (filed workings, read-only) ── */}
        {section === 'gst' && (
          secLoading || gstFiled === null ? <ActivityIndicator color={ACC.purple} style={{ marginTop: 30 }} /> :
          gstFiled.length === 0 ? <EmptyState title="No filed GST workings" subtitle="Monthly GST filings appear here" icon="document-text-outline" /> : (
            gstFiled.map((g: any) => {
              const s = g.summary || {};
              return (
                <View key={g.id} style={styles.card}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={styles.cardTitle}>{new Date(g.year, (g.month || 1) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</Text>
                    <Text style={{ fontSize: 10, color: ACC.ink3 }}>{g.generatedAt ? formatDate(g.generatedAt) : ''}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
                    <Text style={styles.cardSub}>Taxable {fmtMoney(s.taxableAmount || 0)}</Text>
                    <Text style={styles.cardSub}>Exempt {fmtMoney(s.exemptAmount || 0)}</Text>
                    <Text style={[styles.cardSub, { color: ACC.ink, fontWeight: '700' }]}>GST {fmtMoney(s.gstAmount5 || 0)}</Text>
                    {(s.rcmGstAmount || 0) > 0 && <Text style={styles.cardSub}>RCM {fmtMoney(s.rcmGstAmount)}</Text>}
                  </View>
                </View>
              );
            })
          )
        )}

        {/* ── TENANT LEDGER (v_tenant_ledger, read-only) ── */}
        {section === 'ledger' && (
          <>
            <PickerSelect label="Tenant" value={ledgerTenant} options={tenantOpts} onSelect={(v: string) => { setLedgerTenant(v); openLedger(v); }} />
            {!ledgerTenant ? <Text style={{ color: colors.textTertiary, textAlign: 'center', marginTop: 24 }}>Select a tenant to view their ledger.</Text> :
             ledgerLoading || !ledger ? <ActivityIndicator color={ACC.purple} style={{ marginTop: 24 }} /> : (
              <>
                <View style={{ flexDirection: 'row', gap: 8, marginVertical: spacing.md, flexWrap: 'wrap' }}>
                  {[['Charges', ledger.summary?.totalCharges, ACC.ink], ['Payments', ledger.summary?.totalPayments, ACC.good], ['Outstanding', ledger.summary?.outstandingDue, (Number(ledger.summary?.outstandingDue) || 0) > 0 ? '#DC2626' : ACC.good]].map(([k, val, col]) => (
                    <View key={k as string} style={{ flexGrow: 1, minWidth: '30%', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: ACC.line, padding: 10 }}>
                      <Text style={{ fontSize: 10, color: ACC.ink2, textTransform: 'uppercase' }}>{k}</Text>
                      <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: col as string }}>{fmtMoney(Math.abs(Number(val) || 0))}</Text>
                    </View>
                  ))}
                </View>
                {(ledger.entries || []).length === 0 ? <Text style={{ color: colors.textTertiary, textAlign: 'center' }}>No ledger entries.</Text> :
                  (ledger.entries || []).map((e: any, i: number) => (
                    <View key={i} style={[styles.card, { paddingVertical: 10 }]}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <View style={{ flex: 1, paddingRight: 8 }}>
                          <Text style={{ fontSize: 12, fontWeight: '700', color: ACC.ink }} numberOfLines={1}>{e.description || e.accountName}</Text>
                          <Text style={{ fontSize: 10, color: ACC.ink3 }}>{e.entryDate ? formatDate(e.entryDate) : ''} · {e.accountCode} {e.accountName}</Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          {e.debit > 0 && <Text style={{ fontSize: 12, color: '#DC2626' }}>Dr {fmtMoney(e.debit)}</Text>}
                          {e.credit > 0 && <Text style={{ fontSize: 12, color: ACC.good }}>Cr {fmtMoney(e.credit)}</Text>}
                          <Text style={{ fontSize: 11, fontWeight: '700', color: ACC.ink }}>{fmtMoney(e.runningBalance)}</Text>
                        </View>
                      </View>
                    </View>
                  ))}
              </>
             )}
          </>
        )}

        {/* ── TRIAL BALANCE (RPC, read-only) ── */}
        {section === 'trial_balance' && (
          secLoading || trialBal === null ? <ActivityIndicator color={ACC.purple} style={{ marginTop: 30 }} /> :
          (trialBal.rows || []).length === 0 ? <EmptyState title="No trial balance" subtitle="No journal accounts for this period" icon="calculator-outline" /> : (
            <>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: spacing.md }}>
                {[['Period', trialBal.periodTotals], ['As-of', trialBal.asOfTotals]].map(([lbl, t]: any) => {
                  const bal = Math.abs((Number(t.debit) || 0) - (Number(t.credit) || 0)) < 1;
                  return (
                    <View key={lbl} style={{ flex: 1, backgroundColor: bal ? '#ECFDF5' : '#FEF2F2', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: bal ? '#BBF7D0' : '#FECACA' }}>
                      <Text style={{ fontSize: 10, color: bal ? '#16A34A' : '#DC2626', textTransform: 'uppercase' }}>{lbl} {bal ? 'balanced' : 'imbalanced'}</Text>
                      <Text style={{ fontSize: 11, color: ACC.ink2 }}>Dr {fmtMoney(t.debit)} · Cr {fmtMoney(t.credit)}</Text>
                    </View>
                  );
                })}
              </View>
              <View style={{ backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: ACC.line, overflow: 'hidden' }}>
                {(trialBal.rows || []).map((r: any, i: number) => {
                  const isIE = r.accountType === 'INCOME' || r.accountType === 'EXPENSE';
                  const bal = isIE ? r.periodBalance : r.cumBalance;
                  return (
                    <View key={r.accountId || i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, paddingHorizontal: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: '#F1F5F9', paddingLeft: 12 + (Number(r.depth) || 0) * 10 }}>
                      <Text style={{ flex: 1, fontSize: 12, color: (Number(r.depth) || 0) === 0 ? ACC.ink : ACC.ink2, fontWeight: (Number(r.depth) || 0) === 0 ? '800' : '500' }} numberOfLines={1}>{r.code} {r.name}</Text>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: Number(bal) < 0 ? '#DC2626' : ACC.ink }}>{fmtMoney(bal)}</Text>
                    </View>
                  );
                })}
              </View>
            </>
          )
        )}

        {/* ── EXPENSES (read-only) ── */}
        {section === 'expenses' && (
          expenses.length === 0 ? (
            <EmptyState title="No Expenses" subtitle="Recorded expenses will appear here" icon="receipt-outline" />
          ) : (<>
            <View style={{ backgroundColor: '#FEF2F2', borderRadius: 14, padding: 12, marginBottom: spacing.md }}>
              <Text style={{ fontSize: 10, color: '#DC2626', textTransform: 'uppercase' }}>Total Expenses ({expenses.length})</Text>
              <Text style={{ fontSize: fontSize.lg, fontWeight: '900', color: '#DC2626' }}>{fmtMoney(expenses.reduce((s: number, e: any) => s + (Number(e.amount) || 0), 0))}</Text>
            </View>
            {expenses.map((e: any) => (
              <View key={e.id} style={styles.card}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={styles.cardTitle} numberOfLines={1}>{e.category || 'Expense'}{e.locked ? ' 🔒' : ''}</Text>
                  <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: ACC.bad }}>{fmtMoney(e.amount)}</Text>
                </View>
                {!!e.description && <Text style={styles.cardSub} numberOfLines={2}>{e.description}</Text>}
                <Text style={styles.cardSub}>{e.expense_date ? formatDate(e.expense_date) : '—'}{e.propertyName ? ` · ${e.propertyName}` : ''}{e.vendorName ? ` · ${e.vendorName}` : ''}</Text>
              </View>
            ))}
          </>)
        )}

        {/* ── RENTAL PAYMENTS / owner payouts (read-only) ── */}
        {section === 'payments' && (
          ownerPayments.length === 0 ? (
            <EmptyState title="No Rental Payments" subtitle="Owner payouts will appear here" icon="wallet-outline" />
          ) : (<>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing.md }}>
              {([
                ['Billed', ownerPayments.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0), ACC.ink],
                ['Received', ownerPayments.filter((p: any) => p.status === 'paid').reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0), ACC.good],
                ['Outstanding', ownerPayments.filter((p: any) => p.status !== 'paid').reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0), '#DC2626'],
              ] as const).map(([lbl, val, col]) => (
                <View key={lbl} style={{ flexGrow: 1, minWidth: '30%', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: ACC.line, padding: 10 }}>
                  <Text style={{ fontSize: 10, color: ACC.ink2, textTransform: 'uppercase' }}>{lbl}</Text>
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: col as string }}>{fmtMoney(val as number)}</Text>
                </View>
              ))}
            </View>
            {ownerPayments.map((p: any) => {
              const stCfg = p.status === 'paid' ? { bg: '#DCFCE7', c: '#16A34A' } : p.status === 'overdue' ? { bg: '#FEE2E2', c: '#DC2626' } : { bg: '#FEF3C7', c: '#B45309' };
              return (
                <View key={p.id ?? p.created_at} style={styles.card}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ flex: 1, paddingRight: 8 }}>
                      <Text style={styles.cardTitle} numberOfLines={1}>{p.ownerName}{p.apartmentCode ? ` · ${p.apartmentCode}` : ''}</Text>
                      <Text style={styles.cardSub}>{p.paymentMonth || (p.billDate ? formatDate(p.billDate) : '—')}{p.dueDate ? ` · due ${formatDate(p.dueDate)}` : ''}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: colors.primary }}>{fmtMoney(p.amount)}</Text>
                      <View style={{ backgroundColor: stCfg.bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, marginTop: 3 }}>
                        <Text style={{ fontSize: 10, fontWeight: '800', color: stCfg.c, textTransform: 'capitalize' }}>{p.status}</Text>
                      </View>
                    </View>
                  </View>
                </View>
              );
            })}
          </>)
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

      {/* Outstanding Dues — ledger-backed reminder audience (read-only preview) */}
      <Modal visible={showOutstanding} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={[glass.header, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg }]}>
            <TouchableOpacity onPress={() => setShowOutstanding(false)}>
              <Text style={{ color: colors.danger }}>Close</Text>
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text }}>Outstanding Dues</Text>
            <View style={{ width: 50 }} />
          </View>
          {outstandingLoading ? (
            <ActivityIndicator color={ACC.purple} style={{ marginTop: 40 }} />
          ) : outstanding.length === 0 ? (
            <EmptyState title="All clear" subtitle="No tenant currently owes money on the ledger." icon="checkmark-done-outline" />
          ) : (
            <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 60 }}>
              <Text style={{ fontSize: fontSize.sm, color: ACC.ink2, marginBottom: spacing.md }}>
                {outstanding.length} tenant{outstanding.length === 1 ? '' : 's'} owe {formatPendingAmount(outstanding.reduce((s: number, r: any) => s + (Number(r.pending_amount) || 0), 0))} (ledger balance). Tap a row to send a WhatsApp reminder.
              </Text>
              {outstanding.map((r: any) => (
                <View key={r.tenant_id} style={[styles.card, { opacity: r.auto_selected ? 1 : 0.7 }]}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ flex: 1, paddingRight: 8 }}>
                      <Text style={styles.cardTitle} numberOfLines={1}>{r.tenant_name}</Text>
                      <Text style={styles.cardSub}>
                        {r.has_phone ? (r.phone || 'Reachable') : 'No phone number on file'}
                      </Text>
                    </View>
                    <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: ACC.purple }}>{formatPendingAmount(r.pending_amount)}</Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => remindOnWhatsApp(r)}
                    disabled={!r.has_phone}
                    style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9, borderRadius: borderRadius.md, backgroundColor: r.has_phone ? '#25D366' : ACC.line }}>
                    <Ionicons name="logo-whatsapp" size={16} color={r.has_phone ? '#fff' : ACC.ink3} />
                    <Text style={{ color: r.has_phone ? '#fff' : ACC.ink3, fontWeight: '700', fontSize: fontSize.sm }}>{r.has_phone ? 'Remind on WhatsApp' : 'No phone number'}</Text>
                  </TouchableOpacity>
                </View>
              ))}
              <Text style={{ fontSize: fontSize.xs, color: ACC.ink3, marginTop: spacing.md }}>
                Audience is drawn from the tenant ledger (current dues), not invoice status. Tenants in credit or square never appear. Rows without a phone number are dimmed and can't be messaged.
              </Text>
            </ScrollView>
          )}
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* Invoice detail (read-only, web parity) */}
      <Modal visible={invDetail !== null} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={[glass.header, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg }]}>
            <TouchableOpacity onPress={() => setInvDetail(null)}>
              <Text style={{ color: colors.danger }}>Close</Text>
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text }} numberOfLines={1}>{invDetail?.inv?.invoiceNumber || 'Invoice'}</Text>
            <View style={{ width: 44 }} />
          </View>
          {invDetail && (
            <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 80 }}>
              {(() => { const iv = invDetail.inv; return (
                <>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md }}>
                    <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: ACC.ink }}>{iv.tenantName}</Text>
                    <Badge text={iv.status} color={statusColor(iv.status)} />
                  </View>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: spacing.lg }}>
                    {[['Month', iv.billingMonth], ['Due', iv.dueDate ? formatDate(iv.dueDate) : '—'], ['Property', iv.propertyName || '—'], ['Type', iv.invoiceType || 'regular']].map(([k, val]) => (
                      <View key={k as string} style={{ minWidth: '44%' }}>
                        <Text style={{ fontSize: 10, color: ACC.ink3, textTransform: 'uppercase' }}>{k}</Text>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: ACC.ink }}>{String(val)}</Text>
                      </View>
                    ))}
                  </View>

                  <Text style={{ fontSize: 12, fontWeight: '800', color: ACC.ink2, marginBottom: 6 }}>LINE ITEMS</Text>
                  {invDetailLoading ? <ActivityIndicator color={ACC.purple} style={{ marginVertical: 12 }} /> : (invDetail.lineItems || []).length === 0 ? (
                    <Text style={{ fontSize: 12, color: ACC.ink3, marginBottom: 12 }}>No stored line items for this invoice.</Text>
                  ) : (
                    <View style={{ backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: ACC.line, marginBottom: spacing.lg, overflow: 'hidden' }}>
                      {invDetail.lineItems.map((li: any, i: number) => (
                        <View key={li.id || i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: '#F1F5F9' }}>
                          <View style={{ flex: 1, paddingRight: 8 }}>
                            <Text style={{ fontSize: 12, fontWeight: '700', color: ACC.ink, textTransform: 'capitalize' }}>{String(li.line_type || '').replace(/_/g, ' ')}</Text>
                            {!!li.description && <Text style={{ fontSize: 11, color: ACC.ink2 }} numberOfLines={2}>{li.description}</Text>}
                          </View>
                          <Text style={{ fontSize: 13, fontWeight: '700', color: ACC.ink }}>{fmtMoney(li.amount)}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  <Text style={{ fontSize: 12, fontWeight: '800', color: ACC.ink2, marginBottom: 6 }}>SUMMARY</Text>
                  <View style={{ backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: ACC.line, padding: 12, marginBottom: spacing.lg }}>
                    {[
                      ['Rent', iv.rentAmount], ['Actual EB', iv.electricityAmount], ['Estimated EB', iv.estimatedEb],
                      ['Late Fee', iv.lateFee], ['Other Charges', iv.otherCharges],
                    ].filter(([, val]) => Number(val) > 0).map(([k, val]) => (
                      <View key={k as string} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 }}>
                        <Text style={{ fontSize: 13, color: ACC.ink2 }}>{k}</Text>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: ACC.ink }}>{fmtMoney(val as number)}</Text>
                      </View>
                    ))}
                    <View style={{ height: 1, backgroundColor: ACC.line, marginVertical: 6 }} />
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: ACC.ink }}>Total</Text>
                      <Text style={{ fontSize: 16, fontWeight: '900', color: ACC.ink }}>{fmtMoney(iv.totalAmount)}</Text>
                    </View>
                    {iv.paidAmount > 0 && (
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                        <Text style={{ fontSize: 13, color: ACC.good }}>Paid</Text>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: ACC.good }}>− {fmtMoney(iv.paidAmount)}</Text>
                      </View>
                    )}
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: ACC.bad }}>Balance Due</Text>
                      <Text style={{ fontSize: 16, fontWeight: '900', color: ACC.bad }}>{fmtMoney(iv.balance ?? Math.max((iv.totalAmount || 0) - (iv.paidAmount || 0), 0))}</Text>
                    </View>
                  </View>

                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Button title="Download PDF" icon="download-outline" onPress={() => { const inv = iv; setInvDetail(null); shareInv(inv); }} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button title="Record Payment" icon="cash-outline" onPress={() => { const inv = iv; setInvDetail(null); setShowPay(inv); }} />
                    </View>
                  </View>
                </>
              ); })()}
            </ScrollView>
          )}
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
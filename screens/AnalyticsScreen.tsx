/**
 * AnalyticsScreen.tsx — clone of web src/pages/Analytics.tsx (all 4 tabs).
 * Tabs: Bed Performance · EB Analytics · Predictive · Cash Flow.
 * One data fetch (sb.getAnalyticsData) → all computations client-side,
 * exactly mirroring the web's per-tab useMemo logic.
 */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, Modal, RefreshControl, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import * as sb from '../lib/supabaseService';
import { GlassBackground } from '../components/shared';

// ── date helpers (replace date-fns; all yyyy-MM based) ──
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthLabel = (m: string) => { const [y, mo] = m.split('-').map(Number); return `${MON[(mo || 1) - 1]} ${String(y).slice(2)}`; };
const lastNMonths = (n: number) => {
  const now = new Date(); const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(ym(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  return out;
};
const nextNMonths = (n: number) => {
  const now = new Date(); const out: string[] = [];
  for (let i = 1; i <= n; i++) out.push(ym(new Date(now.getFullYear(), now.getMonth() + i, 1)));
  return out;
};
const monthStart = (m: string) => new Date(m + '-01T00:00:00');
const monthEnd = (m: string) => { const d = monthStart(m); return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59); };

// ── fmt ──
const fmtAmt = (v: number) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 10000000) return `₹${(n / 10000000).toFixed(2)}Cr`;
  if (Math.abs(n) >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  if (Math.abs(n) >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
};

// ── linear regression (web parity) ──
function linearRegression(values: number[]): { slope: number; intercept: number } {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] || 0 };
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  const num = values.reduce((s, y, x) => s + (x - xMean) * (y - yMean), 0);
  const den = values.reduce((s, _, x) => s + (x - xMean) ** 2, 0);
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: yMean - slope * xMean };
}

// ── shared UI ──
function SummaryCard({ value, label, color, icon }: { value: string | number; label: string; color?: string; icon?: any }) {
  return (
    <View style={{ flex: 1, minWidth: '30%', backgroundColor: '#fff', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#E5E7EB' }}>
      {!!icon && <Ionicons name={icon} size={16} color={color || '#2563EB'} style={{ marginBottom: 4 }} />}
      <Text style={{ fontSize: 17, fontWeight: '900', color: color || '#111827' }}>{value}</Text>
      <Text style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>{label}</Text>
    </View>
  );
}

// dual-series monthly bar chart (e.g. collected vs paid, revenue vs expense)
function DualBars({ data, aKey, bKey, aLabel, bLabel, aColor, bColor }: any) {
  if (!data?.length) return <Text style={{ color: '#6B7280', textAlign: 'center', marginVertical: 16 }}>No data</Text>;
  const max = Math.max(1, ...data.map((d: any) => Math.max(Math.abs(d[aKey] || 0), Math.abs(d[bKey] || 0))));
  return (
    <View>
      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: aColor }} /><Text style={{ fontSize: 11, color: '#556274' }}>{aLabel}</Text></View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: bColor }} /><Text style={{ fontSize: 11, color: '#556274' }}>{bLabel}</Text></View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 140, gap: 10, paddingHorizontal: 4 }}>
          {data.map((d: any, i: number) => (
            <View key={i} style={{ alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
              <View style={{ flexDirection: 'row', gap: 2, alignItems: 'flex-end', height: 110 }}>
                <View style={{ width: 12, height: Math.max(3, (Math.abs(d[aKey] || 0) / max) * 108), backgroundColor: aColor, borderRadius: 3 }} />
                <View style={{ width: 12, height: Math.max(3, (Math.abs(d[bKey] || 0) / max) * 108), backgroundColor: bColor, borderRadius: 3 }} />
              </View>
              <Text style={{ fontSize: 8, color: '#6B7280', marginTop: 4 }}>{d.label}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

// single-series line/bar for trend (occupancy %, units), with predicted segment dimmed
function TrendBars({ data, valueKey, suffix }: { data: any[]; valueKey: string; suffix?: string }) {
  if (!data?.length) return <Text style={{ color: '#6B7280', textAlign: 'center', marginVertical: 12 }}>No data</Text>;
  const max = Math.max(1, ...data.map((d: any) => d[valueKey] || 0));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 120, gap: 8, paddingHorizontal: 4 }}>
        {data.map((d: any, i: number) => (
          <View key={i} style={{ alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
            <Text style={{ fontSize: 8, fontWeight: '700', color: d.predicted ? '#2563EB' : '#2563EB', marginBottom: 2 }}>{d[valueKey]}{suffix || ''}</Text>
            <View style={{ width: 16, height: Math.max(4, (d[valueKey] / max) * 90), backgroundColor: d.predicted ? '#2563EB' : '#2563EB', borderRadius: 3, opacity: d.predicted ? 0.55 : 0.85 }} />
            <Text style={{ fontSize: 8, color: '#6B7280', marginTop: 3 }}>{d.label}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
// ═══════════════════════════════════════════════════════════════════════════
//  MAIN SCREEN
// ═══════════════════════════════════════════════════════════════════════════
const TABS = [
  { key: 'bed_performance', label: 'Bed Performance', icon: 'bar-chart-outline' },
  { key: 'eb_analytics',    label: 'EB Analytics',    icon: 'flash-outline' },
  { key: 'predictive',      label: 'Predictive',      icon: 'trending-up-outline' },
  { key: 'cash_flow',       label: 'Cash Flow',       icon: 'wallet-outline' },
];

export default function AnalyticsScreen() {
  const navigation = useNavigation<any>();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState('bed_performance');
  const [propertyFilter, setPropertyFilter] = useState('all');
  const [propOpen, setPropOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'revenue' | 'occupancy' | 'avg_monthly'>('revenue');

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try { const d = await sb.getAnalyticsData(); setData(d); }
    catch { setData(null); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const properties  = data?.properties  || [];
  const apartments  = data?.apartments  || [];
  const beds        = data?.beds        || [];
  const allotments  = data?.allotments  || [];
  const invoices    = data?.invoices    || [];
  const expenses    = data?.expenses    || [];
  const receipts    = data?.receipts    || [];
  const ownerPayments = data?.ownerPayments || [];
  const flatReadings  = data?.flatReadings  || [];

  const months12 = useMemo(() => lastNMonths(12), []);
  const propName = (id: string) => properties.find((p: any) => (p.id || p._id) === id)?.property_name || properties.find((p: any) => (p.id || p._id) === id)?.name || 'All Properties';

  // helper: an apartment's property id (handles both shapes)
  const aptPropId = (a: any) => a.property_id ?? a.propertyId;
  const bedAptId  = (b: any) => b.apartment_id ?? b.apartmentId;

  // helper: LIVE beds only — bed.status Live AND apartment.status Live (web parity, item 10)
  const liveAptIds = useMemo(
    () => new Set(apartments.filter((a: any) => String(a.status || '').toLowerCase() === 'live').map((a: any) => a.id || a._id)),
    [apartments],
  );
  const isLiveBed = (bed: any) =>
    String(bed.status || '').toLowerCase() === 'live' && liveAptIds.has(bedAptId(bed));

  // ── BED PERFORMANCE ──
  const bedData = useMemo(() => {
    return beds
      .filter((bed: any) => {
        if (!isLiveBed(bed)) return false;
        const apt = apartments.find((a: any) => (a.id || a._id) === bedAptId(bed));
        if (!apt) return false;
        if (propertyFilter !== 'all' && aptPropId(apt) !== propertyFilter) return false;
        return true;
      })
      .map((bed: any) => {
        const apt = apartments.find((a: any) => (a.id || a._id) === bedAptId(bed));
        const prop = apt ? properties.find((p: any) => (p.id || p._id) === aptPropId(apt)) : null;
        const bedId = bed.id || bed._id;
        const bedInvoices = invoices.filter((i: any) => i.bed_id === bedId || i.bedId === bedId);
        const totalRevenue = bedInvoices.reduce((s: number, i: any) => s + Number(i.total_amount ?? i.totalAmount ?? 0), 0);
        const rentRevenue  = bedInvoices.reduce((s: number, i: any) => s + Number(i.rent_amount ?? i.rentAmount ?? 0), 0);
        const ebRevenue    = bedInvoices.reduce((s: number, i: any) => s + Number(i.electricity_amount ?? i.electricityAmount ?? 0), 0);
        const monthlyStatus = months12.map((month) => {
          const ms = monthStart(month); const me = monthEnd(month);
          const occupied = allotments.some((a: any) => {
            const aBed = a.bed_id ?? a.bedId;
            if (aBed !== bedId) return false;
            const onb = a.onboarding_date ?? a.onboardingDate;
            if (!onb) return false;
            const start = new Date(onb);
            const exit = a.exitDate ? new Date(a.exitDate) : new Date();
            return !(start > me) && !(exit < ms);
          });
          return { month, occupied };
        });
        const occupiedMonths = monthlyStatus.filter((m) => m.occupied).length;
        const occupancyPct = months12.length ? Math.round((occupiedMonths / months12.length) * 100) : 0;
        const avgMonthly = occupiedMonths > 0 ? Math.round(totalRevenue / occupiedMonths) : 0;
        const active = allotments.find((a: any) => (a.bed_id ?? a.bedId) === bedId && ['staying', 'on-notice', 'booked'].includes(String(a.staying_status ?? a.stayingStatus ?? '').toLowerCase()));
        return {
          id: bedId, bedCode: bed.bed_code ?? bed.code ?? '—', aptCode: apt?.apartment_code ?? apt?.code ?? '—',
          propName: prop?.property_name ?? prop?.name ?? '—', totalRevenue, rentRevenue, ebRevenue,
          occupancyPct, avgMonthly, currentStatus: active ? (active.staying_status ?? active.stayingStatus) : 'Vacant',
        };
      })
      .filter((b: any) => {
        if (!search) return true; const q = search.toLowerCase();
        return b.bedCode.toLowerCase().includes(q) || b.aptCode.toLowerCase().includes(q) || b.propName.toLowerCase().includes(q);
      })
      .sort((a: any, b: any) => sortBy === 'revenue' ? b.totalRevenue - a.totalRevenue : sortBy === 'occupancy' ? b.occupancyPct - a.occupancyPct : b.avgMonthly - a.avgMonthly);
  }, [beds, apartments, properties, allotments, invoices, propertyFilter, search, sortBy, months12]);

  const bedSummary = useMemo(() => ({
    totalRevenue: bedData.reduce((s: number, b: any) => s + b.totalRevenue, 0),
    avgOccupancy: bedData.length ? Math.round(bedData.reduce((s: number, b: any) => s + b.occupancyPct, 0) / bedData.length) : 0,
    vacantBeds: bedData.filter((b: any) => b.currentStatus === 'Vacant').length,
  }), [bedData]);

  // ── EB ANALYTICS ──
  const ebMonthly = useMemo(() => months12.map((month) => {
    const monthInvoices = invoices.filter((i: any) => {
      const bm = (i.billing_month ?? i.billingMonth ?? '').slice(0, 7);
      if (bm !== month) return false;
      if (propertyFilter !== 'all' && (i.property_id ?? i.propertyId) !== propertyFilter) return false;
      return true;
    });
    const ebCollected = monthInvoices.reduce((s: number, i: any) => s + Number(i.electricity_amount ?? i.electricityAmount ?? 0), 0);
    const monthExpenses = expenses.filter((e: any) => {
      const em = (e.billing_month ?? e.expense_date ?? e.expenseDate ?? '').slice(0, 7);
      if (em !== month) return false;
      const catKey = e.category ?? '';
      if (!String(catKey).includes('eb_actual') && !String(catKey).includes('electricity')) return false;
      if (propertyFilter !== 'all' && (e.property_id ?? e.propertyId) !== propertyFilter) return false;
      return true;
    });
    const ebPaid = monthExpenses.reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
    return { month, label: monthLabel(month), ebCollected, ebPaid, variance: ebCollected - ebPaid };
  }), [months12, invoices, expenses, propertyFilter]);

  const ebSummary = useMemo(() => {
    const totalCollected = ebMonthly.reduce((s, m) => s + m.ebCollected, 0);
    const totalPaid = ebMonthly.reduce((s, m) => s + m.ebPaid, 0);
    return { totalCollected, totalPaid, totalVariance: totalCollected - totalPaid };
  }, [ebMonthly]);

  // ── PREDICTIVE ──
  const hist6 = useMemo(() => lastNMonths(6), []);
  const next3 = useMemo(() => nextNMonths(3), []);
  const occForecast = useMemo(() => {
    const fp = propertyFilter === 'all' ? properties : properties.filter((p: any) => (p.id || p._id) === propertyFilter);
    return fp.map((prop: any) => {
      const pid = prop.id || prop._id;
      const propApts = apartments.filter((a: any) => aptPropId(a) === pid);
      const propBeds = beds.filter((b: any) => isLiveBed(b) && propApts.some((a: any) => (a.id || a._id) === bedAptId(b)));
      const totalBeds = propBeds.length;
      if (totalBeds === 0) return null;
      const histOcc = hist6.map((month) => {
        const ms = monthStart(month); const me = monthEnd(month);
        const occupied = propBeds.filter((bed: any) => allotments.some((a: any) => {
          if ((a.bed_id ?? a.bedId) !== (bed.id || bed._id)) return false;
          const onb = a.onboarding_date ?? a.onboardingDate; if (!onb) return false;
          const s = new Date(onb); const e = a.exitDate ? new Date(a.exitDate) : new Date();
          return !(s > me) && !(e < ms);
        })).length;
        return { month, label: monthLabel(month), value: Math.round((occupied / totalBeds) * 100), predicted: false };
      });
      const { slope, intercept } = linearRegression(histOcc.map((h) => h.value));
      const forecasted = next3.map((month, i) => ({ month, label: monthLabel(month), value: Math.max(0, Math.min(100, Math.round(intercept + slope * (hist6.length + i)))), predicted: true }));
      const trend = slope > 2 ? 'improving' : slope < -2 ? 'declining' : 'stable';
      return { propName: prop.property_name ?? prop.name, totalBeds, currentOcc: histOcc[histOcc.length - 1]?.value || 0, nextMonthOcc: forecasted[0]?.value || 0, trend, chartData: [...histOcc, ...forecasted] };
    }).filter(Boolean) as any[];
  }, [properties, apartments, beds, allotments, hist6, next3, propertyFilter]);

  const ebForecast = useMemo(() => {
    const fp = propertyFilter === 'all' ? properties : properties.filter((p: any) => (p.id || p._id) === propertyFilter);
    return fp.map((prop: any) => {
      const pid = prop.id || prop._id;
      const histEB = hist6.map((month) => {
        const readings = flatReadings.filter((r: any) => (r.propertyId ?? r.property_id) === pid && (r.billingMonth ?? r.billing_month ?? '').slice(0, 7) === month);
        const totalUnits = readings.reduce((s: number, r: any) => s + Number(r.unitsConsumed ?? r.units_consumed ?? 0), 0);
        return { month, label: monthLabel(month), value: totalUnits, predicted: false };
      });
      const { slope, intercept } = linearRegression(histEB.map((h) => h.value));
      const forecastedEB = next3.map((month, i) => ({ month, label: monthLabel(month), value: Math.max(0, Math.round(intercept + slope * (hist6.length + i))), predicted: true }));
      const totalHist = histEB.reduce((s, h) => s + h.value, 0);
      if (totalHist === 0) return null;
      return { propName: prop.property_name ?? prop.name, chartData: [...histEB, ...forecastedEB] };
    }).filter(Boolean) as any[];
  }, [properties, flatReadings, hist6, next3, propertyFilter]);

  // ── CASH FLOW ──
  const depositsHeld = useMemo(() => allotments
    .filter((a: any) => ['staying', 'on-notice', 'booked'].includes(String(a.staying_status ?? a.stayingStatus ?? '').toLowerCase()))
    .reduce((s: number, a: any) => s + Number(a.deposit_paid ?? a.depositPaid ?? 0), 0), [allotments]);

  const cashMonthly = useMemo(() => {
    let cumulative = 0;
    return months12.map((month) => {
      const monthReceipts = receipts.filter((r: any) => {
        const rm = (r.payment_date ?? r.paymentDate ?? r.created_at ?? r.createdAt ?? '').slice(0, 7);
        if (rm !== month) return false;
        if (propertyFilter !== 'all') {
          const al = allotments.find((a: any) => (a.id || a._id) === (r.tenant_allotment_id ?? r.tenantAllotmentId));
          if (al && (al.property_id ?? al.propertyId) !== propertyFilter) return false;
        }
        return true;
      });
      const revenue = monthReceipts.reduce((s: number, r: any) => s + Number(r.amount_paid ?? r.amountPaid ?? 0), 0);
      const monthExpenses = expenses.filter((e: any) => {
        const em = (e.expense_date ?? e.expenseDate ?? '').slice(0, 7);
        if (em !== month) return false;
        if (propertyFilter !== 'all' && (e.property_id ?? e.propertyId) !== propertyFilter) return false;
        return true;
      });
      const totalExpenses = monthExpenses.reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
      const monthOwner = ownerPayments.filter((op: any) => {
        const pm = (op.payment_date ?? op.paymentDate ?? '').slice(0, 7);
        return pm === month;
      });
      const totalOwnerPayouts = monthOwner.reduce((s: number, op: any) => s + Number(op.amount || 0), 0);
      const netCashFlow = revenue - totalExpenses - totalOwnerPayouts;
      cumulative += netCashFlow;
      return { month, label: monthLabel(month), revenue, expenses: totalExpenses, ownerPayouts: totalOwnerPayouts, netCashFlow, cumulative };
    });
  }, [months12, receipts, expenses, ownerPayments, allotments, propertyFilter]);

  const cashSummary = useMemo(() => ({
    totalRevenue: cashMonthly.reduce((s, m) => s + m.revenue, 0),
    totalExpenses: cashMonthly.reduce((s, m) => s + m.expenses, 0),
    totalOwnerPayouts: cashMonthly.reduce((s, m) => s + m.ownerPayouts, 0),
    netCashFlow: cashMonthly.reduce((s, m) => s + m.netCashFlow, 0),
  }), [cashMonthly]);

  if (loading && !refreshing) {
    return (
      <GlassBackground>
        <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color="#2563EB" /><Text style={{ marginTop: 12, color: '#556274' }}>Loading analytics…</Text>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  const trendColor = (t: string) => t === 'improving' ? '#16a34a' : t === 'declining' ? '#DC2626' : '#2563EB';
  const trendIcon = (t: string) => t === 'improving' ? 'trending-up' : t === 'declining' ? 'trending-down' : 'remove';

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center', marginRight: 10 }}>
              <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
            </View>
            <View>
              <Text style={{ fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 }}>Analytics</Text>
              <Text style={{ fontSize: 13, color: '#6B7280', fontWeight: '500', marginTop: 2 }}>Revenue & occupancy trends</Text>
            </View>
          </View>
          <TouchableOpacity onPress={() => setPropOpen(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: '#E5E7EB', maxWidth: 150 }}>
            <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: '700', color: '#2563EB', flexShrink: 1 }}>{propertyFilter === 'all' ? 'All Properties' : propName(propertyFilter)}</Text>
            <Ionicons name="chevron-down" size={13} color="#2563EB" />
          </TouchableOpacity>
        </View>

        {/* Tab bar */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 46 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 8, alignItems: 'center' }}>
          {TABS.map((t) => (
            <TouchableOpacity key={t.key} onPress={() => setTab(t.key)} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: tab === t.key ? '#2563EB' : 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: tab === t.key ? '#2563EB' : 'rgba(37,99,235,0.15)' }}>
              <Ionicons name={t.icon as any} size={14} color={tab === t.key ? '#fff' : '#2563EB'} />
              <Text style={{ fontSize: 12, fontWeight: '700', color: tab === t.key ? '#fff' : '#2563EB' }}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#2563EB" />}>

          {/* ── BED PERFORMANCE ── */}
          {tab === 'bed_performance' && (<>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <SummaryCard value={fmtAmt(bedSummary.totalRevenue)} label="Total Revenue" color="#16a34a" icon="cash-outline" />
              <SummaryCard value={`${bedSummary.avgOccupancy}%`} label="Avg Occupancy" color="#2563EB" icon="bed-outline" />
              <SummaryCard value={bedSummary.vacantBeds} label="Vacant Beds" color="#2563EB" icon="alert-circle-outline" />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#E5E7EB', paddingHorizontal: 10, marginBottom: 10 }}>
              <Ionicons name="search-outline" size={16} color="#6B7280" />
              <TextInput value={search} onChangeText={setSearch} placeholder="Search bed, apartment, property…" placeholderTextColor="#6B7280" style={{ flex: 1, paddingVertical: 10, paddingLeft: 6, fontSize: 14, color: '#111827' }} />
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {([['revenue', 'Revenue'], ['occupancy', 'Occupancy']] as const).map(([k, lbl]) => (
                  <TouchableOpacity key={k} onPress={() => setSortBy(k as any)} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: sortBy === k ? '#2563EB' : 'rgba(37,99,235,0.1)' }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: sortBy === k ? '#fff' : '#2563EB' }}>{lbl}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
            {bedData.length === 0 ? <Text style={{ color: '#6B7280', textAlign: 'center', marginTop: 24 }}>No beds found</Text>
              : bedData.map((b: any) => (
                <View key={b.id} style={{ backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#E5E7EB' }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827' }}>{b.aptCode} · {b.bedCode}</Text>
                      <Text style={{ fontSize: 11, color: '#6B7280' }}>{b.propName}</Text>
                    </View>
                    <View style={{ backgroundColor: b.currentStatus === 'Vacant' ? '#FEE2E2' : '#DCFCE7', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
                      <Text style={{ fontSize: 10, fontWeight: '800', color: b.currentStatus === 'Vacant' ? '#DC2626' : '#16a34a' }}>{b.currentStatus}</Text>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 14, marginTop: 8 }}>
                    <View><Text style={{ fontSize: 9, color: '#6B7280' }}>Revenue</Text><Text style={{ fontSize: 13, fontWeight: '700', color: '#16a34a' }}>{fmtAmt(b.totalRevenue)}</Text></View>
                    <View><Text style={{ fontSize: 9, color: '#6B7280' }}>Occupancy</Text><Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>{b.occupancyPct}%</Text></View>
                    <View><Text style={{ fontSize: 9, color: '#6B7280' }}>Avg/mo</Text><Text style={{ fontSize: 13, fontWeight: '700', color: '#111827' }}>{fmtAmt(b.avgMonthly)}</Text></View>
                  </View>
                </View>
              ))}
          </>)}

          {/* ── EB ANALYTICS ── */}
          {tab === 'eb_analytics' && (<>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <SummaryCard value={fmtAmt(ebSummary.totalCollected)} label="EB Collected" color="#16a34a" icon="flash-outline" />
              <SummaryCard value={fmtAmt(ebSummary.totalPaid)} label="EB Paid" color="#2563EB" icon="card-outline" />
              <SummaryCard value={fmtAmt(ebSummary.totalVariance)} label="Variance" color={ebSummary.totalVariance >= 0 ? '#16a34a' : '#DC2626'} icon="swap-vertical-outline" />
            </View>
            <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#E5E7EB' }}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827', marginBottom: 10 }}>EB Collected vs Paid (12 mo)</Text>
              <DualBars data={ebMonthly} aKey="ebCollected" bKey="ebPaid" aLabel="Collected" bLabel="Paid" aColor="#16a34a" bColor="#2563EB" />
            </View>
            <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#E5E7EB' }}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827', marginBottom: 8 }}>Monthly Variance</Text>
              {ebMonthly.filter((m) => m.ebCollected || m.ebPaid).map((m) => (
                <View key={m.month} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderTopWidth: 1, borderTopColor: 'rgba(37,99,235,0.06)' }}>
                  <Text style={{ fontSize: 12, color: '#556274' }}>{m.label}</Text>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: m.variance >= 0 ? '#16a34a' : '#DC2626' }}>{m.variance >= 0 ? '+' : ''}{fmtAmt(m.variance)}</Text>
                </View>
              ))}
            </View>
          </>)}

          {/* ── PREDICTIVE ── */}
          {tab === 'predictive' && (<>
            <Text style={{ fontSize: 13, fontWeight: '800', color: '#556274', marginBottom: 8 }}>Occupancy Forecast (3 mo)</Text>
            {occForecast.length === 0 ? <Text style={{ color: '#6B7280', textAlign: 'center', marginVertical: 16 }}>No occupancy data</Text>
              : occForecast.map((f: any, i: number) => (
                <View key={i} style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#E5E7EB' }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827', flex: 1 }}>{f.propName}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: trendColor(f.trend) + '18', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}>
                      <Ionicons name={trendIcon(f.trend) as any} size={12} color={trendColor(f.trend)} />
                      <Text style={{ fontSize: 10, fontWeight: '800', color: trendColor(f.trend), textTransform: 'capitalize' }}>{f.trend}</Text>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 16, marginBottom: 10 }}>
                    <View><Text style={{ fontSize: 9, color: '#6B7280' }}>Current</Text><Text style={{ fontSize: 14, fontWeight: '800', color: '#2563EB' }}>{f.currentOcc}%</Text></View>
                    <View><Text style={{ fontSize: 9, color: '#6B7280' }}>Next Month</Text><Text style={{ fontSize: 14, fontWeight: '800', color: '#2563EB' }}>{f.nextMonthOcc}%</Text></View>
                    <View><Text style={{ fontSize: 9, color: '#6B7280' }}>Beds</Text><Text style={{ fontSize: 14, fontWeight: '800', color: '#111827' }}>{f.totalBeds}</Text></View>
                  </View>
                  <TrendBars data={f.chartData} valueKey="value" suffix="%" />
                </View>
              ))}
            {ebForecast.length > 0 && (<>
              <Text style={{ fontSize: 13, fontWeight: '800', color: '#556274', marginTop: 4, marginBottom: 8 }}>EB Units Forecast (3 mo)</Text>
              {ebForecast.map((f: any, i: number) => (
                <View key={i} style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#E5E7EB' }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827', marginBottom: 10 }}>{f.propName}</Text>
                  <TrendBars data={f.chartData} valueKey="value" suffix="u" />
                </View>
              ))}
            </>)}
            <Text style={{ fontSize: 10, color: '#6B7280', textAlign: 'center', marginTop: 4 }}>Orange bars are linear-regression forecasts</Text>
          </>)}

          {/* ── CASH FLOW ── */}
          {tab === 'cash_flow' && (<>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <SummaryCard value={fmtAmt(cashSummary.totalRevenue)} label="Revenue (12mo)" color="#16a34a" icon="trending-up-outline" />
              <SummaryCard value={fmtAmt(cashSummary.totalExpenses)} label="Expenses" color="#DC2626" icon="trending-down-outline" />
              <SummaryCard value={fmtAmt(cashSummary.totalOwnerPayouts)} label="Owner Payouts" color="#2563EB" icon="people-outline" />
              <SummaryCard value={fmtAmt(cashSummary.netCashFlow)} label="Net Cash Flow" color={cashSummary.netCashFlow >= 0 ? '#16a34a' : '#DC2626'} icon="wallet-outline" />
              <SummaryCard value={fmtAmt(depositsHeld)} label="Deposits Held" color="#2563EB" icon="lock-closed-outline" />
            </View>
            <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#E5E7EB' }}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827', marginBottom: 10 }}>Revenue vs Expenses (12 mo)</Text>
              <DualBars data={cashMonthly} aKey="revenue" bKey="expenses" aLabel="Revenue" bLabel="Expenses" aColor="#16a34a" bColor="#DC2626" />
            </View>
            <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#E5E7EB' }}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827', marginBottom: 8 }}>Net Cash Flow by Month</Text>
              {cashMonthly.filter((m) => m.revenue || m.expenses || m.ownerPayouts).map((m) => (
                <View key={m.month} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 7, borderTopWidth: 1, borderTopColor: 'rgba(37,99,235,0.06)' }}>
                  <Text style={{ fontSize: 12, color: '#556274' }}>{m.label}</Text>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: m.netCashFlow >= 0 ? '#16a34a' : '#DC2626' }}>{m.netCashFlow >= 0 ? '+' : ''}{fmtAmt(m.netCashFlow)}</Text>
                    <Text style={{ fontSize: 9, color: '#6B7280' }}>cum: {fmtAmt(m.cumulative)}</Text>
                  </View>
                </View>
              ))}
            </View>
          </>)}
        </ScrollView>

        {/* Property filter modal */}
        <Modal visible={propOpen} transparent animationType="fade" onRequestClose={() => setPropOpen(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setPropOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(30,18,48,0.45)', justifyContent: 'center', padding: 28 }}>
            <View style={{ backgroundColor: '#fff', borderRadius: 18, maxHeight: '70%' }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: '#111827', padding: 16, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>Filter by Property</Text>
              <ScrollView>
                <TouchableOpacity onPress={() => { setPropertyFilter('all'); setPropOpen(false); }} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(37,99,235,0.05)' }}>
                  <Text style={{ fontSize: 14, fontWeight: propertyFilter === 'all' ? '800' : '500', color: propertyFilter === 'all' ? '#2563EB' : '#111827' }}>All Properties</Text>
                  {propertyFilter === 'all' && <Ionicons name="checkmark" size={18} color="#2563EB" />}
                </TouchableOpacity>
                {properties.map((p: any) => {
                  const pid = p.id || p._id;
                  return (
                    <TouchableOpacity key={pid} onPress={() => { setPropertyFilter(pid); setPropOpen(false); }} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(37,99,235,0.05)' }}>
                      <Text style={{ fontSize: 14, fontWeight: propertyFilter === pid ? '800' : '500', color: propertyFilter === pid ? '#2563EB' : '#111827' }}>{p.property_name || p.name}</Text>
                      {propertyFilter === pid && <Ionicons name="checkmark" size={18} color="#2563EB" />}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </TouchableOpacity>
        </Modal>
      </SafeAreaView>
    </GlassBackground>
  );
}
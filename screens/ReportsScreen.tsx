/**
 * ReportsScreen.tsx — exact clone of web src/pages/Reports.tsx.
 * Period selector → 5 summary KPI cards → 8 detailed KPI cards →
 * 3 tabs (Occupancy / Tickets / Tenants).
 * Data: sb.getReportsSummary(period) — same shape as web useUniversalMetrics:
 *   { accounting, tenants, propertyStatus, tickets }
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, Modal, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import * as sb from '../lib/supabaseService';
import { GlassBackground } from '../components/shared';

// ── period labels (web parity) ──
const PERIODS: { key: string; label: string }[] = [
  { key: 'current_fy',     label: 'Current FY' },
  { key: 'last_fy',        label: 'Last FY' },
  { key: 'last_2fy',       label: 'Last 2 FYs' },
  { key: 'last_5y',        label: 'Last 5 Years' },
  { key: 'from_beginning', label: 'Since Beginning' },
];

// ── fmtLacs (web parity) ──
const fmtLacs = (v: number) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 100000) return `₹${(n / 100000).toFixed(2)} Lacs`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
};

const EMPTY = {
  accounting: {
    totalRentalRevenue: 0, totalEbCharged: 0, totalInvoiced: 0,
    totalCollections: 0, totalCollectionsWithoutDeposit: 0, depositCollections: 0,
    totalRefundsGiven: 0, totalPendingCollection: 0, totalExpenses: 0, totalProfit: 0,
  },
  tenants: { totalUniqueTenants: 0, activeTenants: 0, bookedTenants: 0 },
  propertyStatus: { total: 0, occupied: 0, vacant: 0, booked: 0, notice: 0, occupancyPct: 0 },
  tickets: { total: 0, open: 0, closed: 0, needsTenantApproval: 0 },
};

// ── design tokens (Dashboard parity) ──
const RPT = {
  bg: '#FFFFFF',
  soft: '#F8FAFC',
  ink: '#0F172A',
  ink2: '#64748B',
  ink3: '#94A3B8',
  blue: '#2563EB',
  purple: '#2563EB',
  line: '#EEF1F6',
  good: '#16A34A', goodBg: '#DCFCE7',
  warn: '#EA580C', warnBg: '#FFEDD5',
  bad: '#DC2626', badBg: '#FEE2E2',
  info: '#1D4ED8', infoBg: '#EEF3FF',
};
const cardShadow = { shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } } as const;

function KpiCard({ value, label, color, big }: { value: string | number; label: string; color?: string; big?: boolean }) {
  return (
    <View style={{ flex: 1, minWidth: '30%', backgroundColor: RPT.bg, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: RPT.line, ...cardShadow }}>
      <Text style={{ fontSize: big ? 20 : 16, fontWeight: '800', letterSpacing: -0.3, color: color || RPT.ink }}>{value}</Text>
      <Text style={{ fontSize: 11, color: RPT.ink2, marginTop: 2 }}>{label}</Text>
    </View>
  );
}
function StatBox({ value, label, color }: { value: string | number; label: string; color?: string }) {
  return (
    <View style={{ flex: 1, minWidth: '22%', backgroundColor: RPT.soft, borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: RPT.line }}>
      <Text style={{ fontSize: 20, fontWeight: '800', letterSpacing: -0.3, color: color || RPT.ink }}>{value}</Text>
      <Text style={{ fontSize: 10, color: RPT.ink2, marginTop: 2, textAlign: 'center' }}>{label}</Text>
    </View>
  );
}

export default function ReportsScreen() {
  const navigation = useNavigation<any>();
  const [period, setPeriod] = useState('current_fy');
  const [periodOpen, setPeriodOpen] = useState(false);
  const [data, setData] = useState<any>(EMPTY);
  const [pnl, setPnl] = useState<any[]>([]);
  const [bedProfit, setBedProfit] = useState<any[]>([]);
  const [ebRecon, setEbRecon] = useState<any[]>([]);
  const [occDetail, setOccDetail] = useState<any[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<'occupancy' | 'pnl' | 'beds' | 'eb' | 'tickets' | 'tenants'>('occupancy');

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const [r, p, bp, eb, occ] = await Promise.all([
        sb.getReportsSummary(period),
        sb.getPropertyPnL(period),
        sb.getBedProfitability(period),
        sb.getEBReconciliation(period),
        sb.getOccupancyDetail(),
      ]);
      setData(r || EMPTY);
      setPnl(Array.isArray(p) ? p : []);
      setBedProfit(Array.isArray(bp) ? bp : []);
      setEbRecon(Array.isArray(eb) ? eb : []);
      setOccDetail(Array.isArray(occ) ? occ : []);
      setError(false);
    } catch {
      setData(EMPTY);
      setPnl([]); setBedProfit([]); setEbRecon([]); setOccDetail([]);
      setError(true);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [period]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { load(); }, [period]);

  const a = data.accounting || EMPTY.accounting;
  const t = data.tenants || EMPTY.tenants;
  const ps = data.propertyStatus || EMPTY.propertyStatus;
  const tk = data.tickets || EMPTY.tickets;
  const periodLabel = PERIODS.find(p => p.key === period)?.label || 'Current FY';

  if (loading && !refreshing) {
    return (
      <GlassBackground>
        <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={RPT.blue} />
          <Text style={{ marginTop: 12, color: RPT.ink2 }}>Loading reports…</Text>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center', marginRight: 10 }}>
              <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
            </View>
            <View>
              <Text style={{ fontSize: 22, fontWeight: '800', color: RPT.ink, letterSpacing: -0.4 }}>Reports</Text>
              <Text style={{ fontSize: 13, color: RPT.ink2, fontWeight: '500', marginTop: 2 }}>Portfolio health snapshots</Text>
            </View>
          </View>
          <TouchableOpacity onPress={() => setPeriodOpen(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, backgroundColor: RPT.bg, borderWidth: 1, borderColor: RPT.line, ...cardShadow }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: RPT.blue }}>{periodLabel}</Text>
            <Ionicons name="chevron-down" size={14} color={RPT.blue} />
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#2563EB" />}
        >
          {error ? (
            <View style={{ backgroundColor: RPT.bg, borderRadius: 16, padding: 24, borderWidth: 1, borderColor: 'rgba(220,38,38,0.25)', alignItems: 'center', marginTop: 8, ...cardShadow }}>
              <Ionicons name="cloud-offline-outline" size={48} color={RPT.bad} />
              <Text style={{ fontSize: 15, fontWeight: '800', color: RPT.ink, marginTop: 12 }}>Couldn't load reports</Text>
              <Text style={{ fontSize: 12, color: RPT.ink2, marginTop: 4, textAlign: 'center' }}>Data is unavailable right now. Check your connection and try again.</Text>
              <TouchableOpacity onPress={() => load()} style={{ marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: RPT.blue, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12 }}>
                <Ionicons name="refresh" size={16} color="#fff" />
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (<>
          {/* Summary KPI cards (5) */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <KpiCard big value={t.activeTenants} label="Active Tenants" />
            <KpiCard big value={`${ps.occupancyPct}%`} label="Occupancy Rate" />
            <KpiCard big value={fmtLacs(a.totalInvoiced)} label="Total Revenue" />
            <KpiCard big value={fmtLacs(a.totalPendingCollection)} label="Pending Collection" color="#2563EB" />
            <KpiCard big value={tk.open} label="Active Tickets" />
          </View>

          {/* Detailed KPI cards (8) */}
          <Text style={{ fontSize: 13, fontWeight: '800', color: RPT.ink2, marginBottom: 8, marginLeft: 2 }}>Financial Detail</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            <KpiCard value={fmtLacs(a.totalRentalRevenue)} label="Rental Revenue" />
            <KpiCard value={fmtLacs(a.totalEbCharged)} label="EB Charged" />
            <KpiCard value={fmtLacs(a.totalCollections)} label="Total Collections" />
            <KpiCard value={fmtLacs(a.totalCollectionsWithoutDeposit)} label="Collections (excl. Deposits)" />
            <KpiCard value={fmtLacs(a.depositCollections)} label="Deposit Collections" />
            <KpiCard value={fmtLacs(a.totalRefundsGiven)} label="Refunds Given" />
            <KpiCard value={fmtLacs(a.totalExpenses)} label="Total Expenses" />
            <KpiCard value={fmtLacs(a.totalProfit)} label="Profit" color={a.totalProfit >= 0 ? RPT.good : RPT.bad} />
          </View>

          {/* Tabs */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }} contentContainerStyle={{ gap: 8 }}>
            {([
              { k: 'occupancy', label: 'Occupancy' },
              { k: 'pnl', label: 'Property P&L' },
              { k: 'beds', label: 'Bed Profitability' },
              { k: 'eb', label: 'EB Reconciliation' },
              { k: 'tickets', label: 'Tickets' },
              { k: 'tenants', label: 'Tenants' },
            ] as const).map(x => (
              <TouchableOpacity key={x.k} onPress={() => setTab(x.k as any)}
                style={{ paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999, backgroundColor: tab === x.k ? RPT.purple : '#F1F3F9' }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: tab === x.k ? '#fff' : RPT.ink2 }}>{x.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Occupancy tab */}
          {tab === 'occupancy' && (<>
            <View style={{ backgroundColor: RPT.bg, borderRadius: 16, padding: 24, borderWidth: 1, borderColor: RPT.line, alignItems: 'center', ...cardShadow }}>
              <Ionicons name="bar-chart-outline" size={56} color="rgba(37,99,235,0.18)" />
              <Text style={{ fontSize: 34, fontWeight: '800', letterSpacing: -0.5, color: RPT.ink, marginTop: 12 }}>{ps.occupancyPct}%</Text>
              <Text style={{ fontSize: 14, color: RPT.ink2 }}>Current Occupancy</Text>
              <Text style={{ fontSize: 13, color: RPT.ink2, marginTop: 8 }}>{ps.occupied} / {ps.total} beds occupied</Text>
              <View style={{ flexDirection: 'row', gap: 18, marginTop: 14 }}>
                <Text style={{ fontSize: 13, color: RPT.ink2 }}>Booked: <Text style={{ fontWeight: '800', color: RPT.blue }}>{ps.booked}</Text></Text>
                <Text style={{ fontSize: 13, color: RPT.ink2 }}>Notice: <Text style={{ fontWeight: '800', color: RPT.blue }}>{ps.notice}</Text></Text>
                <Text style={{ fontSize: 13, color: RPT.ink2 }}>Vacant: <Text style={{ fontWeight: '800', color: RPT.good }}>{ps.vacant}</Text></Text>
              </View>
            </View>
            {occDetail.length > 0 && (
              <View style={{ marginTop: 12 }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: RPT.ink2, marginBottom: 8, marginLeft: 2 }}>By Property</Text>
                {occDetail.map((o: any, i: number) => (
                  <View key={i} style={{ backgroundColor: RPT.bg, borderRadius: 16, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: RPT.line, ...cardShadow }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: RPT.ink, flex: 1 }} numberOfLines={1}>{o.propertyName}</Text>
                      <Text style={{ fontSize: 15, fontWeight: '800', color: RPT.blue }}>{o.occupancyPct}%</Text>
                    </View>
                    <Text style={{ fontSize: 12, color: RPT.ink2, marginTop: 2 }}>{o.occupied} / {o.totalBeds} occupied</Text>
                    <View style={{ flexDirection: 'row', gap: 16, marginTop: 8 }}>
                      <Text style={{ fontSize: 12, color: RPT.ink2 }}>Booked: <Text style={{ fontWeight: '800', color: RPT.blue }}>{o.booked}</Text></Text>
                      <Text style={{ fontSize: 12, color: RPT.ink2 }}>Notice: <Text style={{ fontWeight: '800', color: RPT.blue }}>{o.notice}</Text></Text>
                      <Text style={{ fontSize: 12, color: RPT.ink2 }}>Vacant: <Text style={{ fontWeight: '800', color: RPT.good }}>{o.vacant}</Text></Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </>)}

          {/* Property P&L tab */}
          {tab === 'pnl' && (
            pnl.length === 0 ? <Text style={{ color: RPT.ink2, textAlign: 'center', marginTop: 24 }}>No P&L data for this period</Text>
            : pnl.map((p: any) => (
              <View key={p.id} style={{ backgroundColor: RPT.bg, borderRadius: 16, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: RPT.line, ...cardShadow }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <Text style={{ fontSize: 15, fontWeight: '800', color: RPT.ink, flex: 1 }} numberOfLines={1}>{p.property_name}</Text>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: RPT.blue }}>{p.occupancy}% occ</Text>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <StatBox value={fmtLacs(p.revenue)} label="Revenue" />
                  <StatBox value={fmtLacs(p.totalExpense)} label="Expenses" color={RPT.bad} />
                  <StatBox value={fmtLacs(p.profit)} label="Profit" color={p.profit >= 0 ? RPT.good : RPT.bad} />
                  <StatBox value={fmtLacs(p.revPerBed)} label="Rev / Bed" color={RPT.blue} />
                </View>
              </View>
            ))
          )}

          {/* Bed Profitability tab */}
          {tab === 'beds' && (
            bedProfit.length === 0 ? <Text style={{ color: RPT.ink2, textAlign: 'center', marginTop: 24 }}>No bed profitability data</Text>
            : bedProfit.map((b: any, i: number) => (
              <View key={i} style={{ backgroundColor: RPT.bg, borderRadius: 16, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: RPT.line, ...cardShadow }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: RPT.ink }}>{b.apartment_code} · {b.bed_code}</Text>
                    <Text style={{ fontSize: 11, color: RPT.ink2 }}>{b.property_name}</Text>
                  </View>
                  <View style={{ backgroundColor: b.isLoss ? RPT.badBg : RPT.goodBg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: b.isLoss ? RPT.bad : RPT.good }}>{fmtLacs(b.profit)}</Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 16, marginTop: 8 }}>
                  <View><Text style={{ fontSize: 9, color: RPT.ink2 }}>Revenue</Text><Text style={{ fontSize: 13, fontWeight: '700', color: RPT.good }}>{fmtLacs(b.revenue)}</Text></View>
                  <View><Text style={{ fontSize: 9, color: RPT.ink2 }}>Cost</Text><Text style={{ fontSize: 13, fontWeight: '700', color: RPT.bad }}>{fmtLacs(b.totalCost)}</Text></View>
                </View>
              </View>
            ))
          )}

          {/* EB Reconciliation tab */}
          {tab === 'eb' && (
            ebRecon.length === 0 ? <Text style={{ color: RPT.ink2, textAlign: 'center', marginTop: 24 }}>No EB data for this period</Text>
            : ebRecon.map((e: any, i: number) => (
              <View key={i} style={{ backgroundColor: RPT.bg, borderRadius: 16, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: RPT.line, ...cardShadow }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: RPT.ink, marginBottom: 8 }} numberOfLines={1}>{e.property_name}</Text>
                <View style={{ flexDirection: 'row', gap: 16 }}>
                  <View><Text style={{ fontSize: 9, color: RPT.ink2 }}>Billed</Text><Text style={{ fontSize: 13, fontWeight: '700', color: RPT.good }}>{fmtLacs(e.ebBilled)}</Text></View>
                  <View><Text style={{ fontSize: 9, color: RPT.ink2 }}>Actual</Text><Text style={{ fontSize: 13, fontWeight: '700', color: RPT.blue }}>{fmtLacs(e.ebActual)}</Text></View>
                  <View><Text style={{ fontSize: 9, color: RPT.ink2 }}>Variance</Text><Text style={{ fontSize: 13, fontWeight: '700', color: e.variance >= 0 ? RPT.good : RPT.bad }}>{e.variance >= 0 ? '+' : ''}{fmtLacs(e.variance)} ({e.variancePct}%)</Text></View>
                </View>
              </View>
            ))
          )}

          {/* Tickets tab */}
          {tab === 'tickets' && (
            <View style={{ backgroundColor: RPT.bg, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: RPT.line, ...cardShadow }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: RPT.ink, marginBottom: 14 }}>Ticket Summary</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <StatBox value={tk.total} label="Total" />
                <StatBox value={tk.open} label="Open" color={RPT.bad} />
                <StatBox value={tk.closed} label="Closed" color={RPT.good} />
                <StatBox value={tk.needsTenantApproval} label="Needs Approval" color={RPT.blue} />
              </View>
            </View>
          )}

          {/* Tenants tab */}
          {tab === 'tenants' && (
            <View style={{ backgroundColor: RPT.bg, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: RPT.line, ...cardShadow }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: RPT.ink, marginBottom: 14 }}>Tenant Summary</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <StatBox value={t.totalUniqueTenants} label="Total Tenants" />
                <StatBox value={t.activeTenants} label="Active (Staying + Notice)" color={RPT.good} />
                <StatBox value={t.bookedTenants} label="Booked" color={RPT.blue} />
              </View>
            </View>
          )}
          </>)}
        </ScrollView>

        {/* Period selector modal */}
        <Modal visible={periodOpen} transparent animationType="fade" onRequestClose={() => setPeriodOpen(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setPeriodOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', padding: 32 }}>
            <View style={{ backgroundColor: RPT.bg, borderRadius: 18, overflow: 'hidden' }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: RPT.ink, padding: 16, borderBottomWidth: 1, borderBottomColor: RPT.line }}>Select Period</Text>
              {PERIODS.map(p => (
                <TouchableOpacity key={p.key} onPress={() => { setPeriod(p.key); setPeriodOpen(false); }}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: RPT.line }}>
                  <Text style={{ fontSize: 14, fontWeight: period === p.key ? '800' : '500', color: period === p.key ? RPT.blue : RPT.ink }}>{p.label}</Text>
                  {period === p.key && <Ionicons name="checkmark" size={18} color={RPT.blue} />}
                </TouchableOpacity>
              ))}
            </View>
          </TouchableOpacity>
        </Modal>
      </SafeAreaView>
    </GlassBackground>
  );
}
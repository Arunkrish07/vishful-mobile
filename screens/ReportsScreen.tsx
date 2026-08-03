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

function KpiCard({ value, label, color, big }: { value: string | number; label: string; color?: string; big?: boolean }) {
  return (
    <View style={{ flex: 1, minWidth: '30%', backgroundColor: '#fff', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: 'rgba(123,47,190,0.1)' }}>
      <Text style={{ fontSize: big ? 20 : 16, fontWeight: '900', color: color || '#1E1230' }}>{value}</Text>
      <Text style={{ fontSize: 11, color: '#9B8BAE', marginTop: 2 }}>{label}</Text>
    </View>
  );
}
function StatBox({ value, label, color }: { value: string | number; label: string; color?: string }) {
  return (
    <View style={{ flex: 1, minWidth: '22%', backgroundColor: 'rgba(123,47,190,0.05)', borderRadius: 12, padding: 14, alignItems: 'center' }}>
      <Text style={{ fontSize: 20, fontWeight: '900', color: color || '#1E1230' }}>{value}</Text>
      <Text style={{ fontSize: 10, color: '#9B8BAE', marginTop: 2, textAlign: 'center' }}>{label}</Text>
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
          <ActivityIndicator size="large" color="#7B2FBE" />
          <Text style={{ marginTop: 12, color: '#5C4B70' }}>Loading reports…</Text>
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
              <Text style={{ fontSize: 22, fontWeight: '900', color: '#1E1230' }}>Reports</Text>
              <Text style={{ fontSize: 12, color: '#9B8BAE' }}>Analytics and insights</Text>
            </View>
          </View>
          <TouchableOpacity onPress={() => setPeriodOpen(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: 'rgba(123,47,190,0.2)' }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: '#7B2FBE' }}>{periodLabel}</Text>
            <Ionicons name="chevron-down" size={14} color="#7B2FBE" />
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#7B2FBE" />}
        >
          {error ? (
            <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 24, borderWidth: 1, borderColor: 'rgba(220,38,38,0.25)', alignItems: 'center', marginTop: 8 }}>
              <Ionicons name="cloud-offline-outline" size={48} color="#DC2626" />
              <Text style={{ fontSize: 15, fontWeight: '800', color: '#1E1230', marginTop: 12 }}>Couldn't load reports</Text>
              <Text style={{ fontSize: 12, color: '#9B8BAE', marginTop: 4, textAlign: 'center' }}>Data is unavailable right now. Check your connection and try again.</Text>
              <TouchableOpacity onPress={() => load()} style={{ marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#7B2FBE', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12 }}>
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
            <KpiCard big value={fmtLacs(a.totalPendingCollection)} label="Pending Collection" color="#E8841A" />
            <KpiCard big value={tk.open} label="Active Tickets" />
          </View>

          {/* Detailed KPI cards (8) */}
          <Text style={{ fontSize: 13, fontWeight: '800', color: '#5C4B70', marginBottom: 8, marginLeft: 2 }}>Financial Detail</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            <KpiCard value={fmtLacs(a.totalRentalRevenue)} label="Rental Revenue" />
            <KpiCard value={fmtLacs(a.totalEbCharged)} label="EB Charged" />
            <KpiCard value={fmtLacs(a.totalCollections)} label="Total Collections" />
            <KpiCard value={fmtLacs(a.totalCollectionsWithoutDeposit)} label="Collections (excl. Deposits)" />
            <KpiCard value={fmtLacs(a.depositCollections)} label="Deposit Collections" />
            <KpiCard value={fmtLacs(a.totalRefundsGiven)} label="Refunds Given" />
            <KpiCard value={fmtLacs(a.totalExpenses)} label="Total Expenses" />
            <KpiCard value={fmtLacs(a.totalProfit)} label="Profit" color={a.totalProfit >= 0 ? '#16a34a' : '#DC2626'} />
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
                style={{ paddingHorizontal: 16, paddingVertical: 9, borderRadius: 20, backgroundColor: tab === x.k ? '#7B2FBE' : 'rgba(123,47,190,0.1)' }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: tab === x.k ? '#fff' : '#7B2FBE' }}>{x.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Occupancy tab */}
          {tab === 'occupancy' && (<>
            <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 24, borderWidth: 1, borderColor: 'rgba(123,47,190,0.1)', alignItems: 'center' }}>
              <Ionicons name="bar-chart-outline" size={56} color="rgba(123,47,190,0.18)" />
              <Text style={{ fontSize: 34, fontWeight: '900', color: '#1E1230', marginTop: 12 }}>{ps.occupancyPct}%</Text>
              <Text style={{ fontSize: 14, color: '#9B8BAE' }}>Current Occupancy</Text>
              <Text style={{ fontSize: 13, color: '#5C4B70', marginTop: 8 }}>{ps.occupied} / {ps.total} beds occupied</Text>
              <View style={{ flexDirection: 'row', gap: 18, marginTop: 14 }}>
                <Text style={{ fontSize: 13, color: '#5C4B70' }}>Booked: <Text style={{ fontWeight: '800', color: '#7B2FBE' }}>{ps.booked}</Text></Text>
                <Text style={{ fontSize: 13, color: '#5C4B70' }}>Notice: <Text style={{ fontWeight: '800', color: '#E8841A' }}>{ps.notice}</Text></Text>
                <Text style={{ fontSize: 13, color: '#5C4B70' }}>Vacant: <Text style={{ fontWeight: '800', color: '#16a34a' }}>{ps.vacant}</Text></Text>
              </View>
            </View>
            {occDetail.length > 0 && (
              <View style={{ marginTop: 12 }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: '#5C4B70', marginBottom: 8, marginLeft: 2 }}>By Property</Text>
                {occDetail.map((o: any, i: number) => (
                  <View key={i} style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(123,47,190,0.1)' }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: '#1E1230', flex: 1 }} numberOfLines={1}>{o.propertyName}</Text>
                      <Text style={{ fontSize: 15, fontWeight: '900', color: '#7B2FBE' }}>{o.occupancyPct}%</Text>
                    </View>
                    <Text style={{ fontSize: 12, color: '#9B8BAE', marginTop: 2 }}>{o.occupied} / {o.totalBeds} occupied</Text>
                    <View style={{ flexDirection: 'row', gap: 16, marginTop: 8 }}>
                      <Text style={{ fontSize: 12, color: '#5C4B70' }}>Booked: <Text style={{ fontWeight: '800', color: '#7B2FBE' }}>{o.booked}</Text></Text>
                      <Text style={{ fontSize: 12, color: '#5C4B70' }}>Notice: <Text style={{ fontWeight: '800', color: '#E8841A' }}>{o.notice}</Text></Text>
                      <Text style={{ fontSize: 12, color: '#5C4B70' }}>Vacant: <Text style={{ fontWeight: '800', color: '#16a34a' }}>{o.vacant}</Text></Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </>)}

          {/* Property P&L tab */}
          {tab === 'pnl' && (
            pnl.length === 0 ? <Text style={{ color: '#9B8BAE', textAlign: 'center', marginTop: 24 }}>No P&L data for this period</Text>
            : pnl.map((p: any) => (
              <View key={p.id} style={{ backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(123,47,190,0.1)' }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <Text style={{ fontSize: 15, fontWeight: '800', color: '#1E1230', flex: 1 }} numberOfLines={1}>{p.property_name}</Text>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#7B2FBE' }}>{p.occupancy}% occ</Text>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <StatBox value={fmtLacs(p.revenue)} label="Revenue" />
                  <StatBox value={fmtLacs(p.totalExpense)} label="Expenses" color="#DC2626" />
                  <StatBox value={fmtLacs(p.profit)} label="Profit" color={p.profit >= 0 ? '#16a34a' : '#DC2626'} />
                  <StatBox value={fmtLacs(p.revPerBed)} label="Rev / Bed" color="#7B2FBE" />
                </View>
              </View>
            ))
          )}

          {/* Bed Profitability tab */}
          {tab === 'beds' && (
            bedProfit.length === 0 ? <Text style={{ color: '#9B8BAE', textAlign: 'center', marginTop: 24 }}>No bed profitability data</Text>
            : bedProfit.map((b: any, i: number) => (
              <View key={i} style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(123,47,190,0.1)' }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: '#1E1230' }}>{b.apartment_code} · {b.bed_code}</Text>
                    <Text style={{ fontSize: 11, color: '#9B8BAE' }}>{b.property_name}</Text>
                  </View>
                  <View style={{ backgroundColor: b.isLoss ? '#FEE2E2' : '#DCFCE7', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: b.isLoss ? '#DC2626' : '#16a34a' }}>{fmtLacs(b.profit)}</Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 16, marginTop: 8 }}>
                  <View><Text style={{ fontSize: 9, color: '#9B8BAE' }}>Revenue</Text><Text style={{ fontSize: 13, fontWeight: '700', color: '#16a34a' }}>{fmtLacs(b.revenue)}</Text></View>
                  <View><Text style={{ fontSize: 9, color: '#9B8BAE' }}>Cost</Text><Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>{fmtLacs(b.totalCost)}</Text></View>
                </View>
              </View>
            ))
          )}

          {/* EB Reconciliation tab */}
          {tab === 'eb' && (
            ebRecon.length === 0 ? <Text style={{ color: '#9B8BAE', textAlign: 'center', marginTop: 24 }}>No EB data for this period</Text>
            : ebRecon.map((e: any, i: number) => (
              <View key={i} style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(123,47,190,0.1)' }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: '#1E1230', marginBottom: 8 }} numberOfLines={1}>{e.property_name}</Text>
                <View style={{ flexDirection: 'row', gap: 16 }}>
                  <View><Text style={{ fontSize: 9, color: '#9B8BAE' }}>Billed</Text><Text style={{ fontSize: 13, fontWeight: '700', color: '#16a34a' }}>{fmtLacs(e.ebBilled)}</Text></View>
                  <View><Text style={{ fontSize: 9, color: '#9B8BAE' }}>Actual</Text><Text style={{ fontSize: 13, fontWeight: '700', color: '#E8841A' }}>{fmtLacs(e.ebActual)}</Text></View>
                  <View><Text style={{ fontSize: 9, color: '#9B8BAE' }}>Variance</Text><Text style={{ fontSize: 13, fontWeight: '700', color: e.variance >= 0 ? '#16a34a' : '#DC2626' }}>{e.variance >= 0 ? '+' : ''}{fmtLacs(e.variance)} ({e.variancePct}%)</Text></View>
                </View>
              </View>
            ))
          )}

          {/* Tickets tab */}
          {tab === 'tickets' && (
            <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: 'rgba(123,47,190,0.1)' }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: '#1E1230', marginBottom: 14 }}>Ticket Summary</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <StatBox value={tk.total} label="Total" />
                <StatBox value={tk.open} label="Open" color="#DC2626" />
                <StatBox value={tk.closed} label="Closed" color="#16a34a" />
                <StatBox value={tk.needsTenantApproval} label="Needs Approval" color="#E8841A" />
              </View>
            </View>
          )}

          {/* Tenants tab */}
          {tab === 'tenants' && (
            <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: 'rgba(123,47,190,0.1)' }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: '#1E1230', marginBottom: 14 }}>Tenant Summary</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <StatBox value={t.totalUniqueTenants} label="Total Tenants" />
                <StatBox value={t.activeTenants} label="Active (Staying + Notice)" color="#16a34a" />
                <StatBox value={t.bookedTenants} label="Booked" color="#7B2FBE" />
              </View>
            </View>
          )}
          </>)}
        </ScrollView>

        {/* Period selector modal */}
        <Modal visible={periodOpen} transparent animationType="fade" onRequestClose={() => setPeriodOpen(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setPeriodOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(30,18,48,0.45)', justifyContent: 'center', padding: 32 }}>
            <View style={{ backgroundColor: '#fff', borderRadius: 18, overflow: 'hidden' }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: '#1E1230', padding: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(123,47,190,0.1)' }}>Select Period</Text>
              {PERIODS.map(p => (
                <TouchableOpacity key={p.key} onPress={() => { setPeriod(p.key); setPeriodOpen(false); }}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(123,47,190,0.05)' }}>
                  <Text style={{ fontSize: 14, fontWeight: period === p.key ? '800' : '500', color: period === p.key ? '#7B2FBE' : '#1E1230' }}>{p.label}</Text>
                  {period === p.key && <Ionicons name="checkmark" size={18} color="#7B2FBE" />}
                </TouchableOpacity>
              ))}
            </View>
          </TouchableOpacity>
        </Modal>
      </SafeAreaView>
    </GlassBackground>
  );
}
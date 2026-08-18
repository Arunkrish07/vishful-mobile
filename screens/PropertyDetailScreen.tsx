import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, Alert, TextInput, Linking, Share, Image, RefreshControl } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { uploadTicketPhoto } from '../services/ticketService';
import QRCodeStyled from 'react-native-qrcode-styled';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { colors, spacing, borderRadius, fontSize, glass } from '../lib/theme';
import { Button, Input, Badge, EmptyState, LoadingScreen, PickerSelect, StatCard, GlassBackground, GlassHeader, DateField } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { Ionicons } from '@expo/vector-icons';
import { useMountedRef, isAbortError } from '../lib/safeAsync';
import { useQuery } from '@tanstack/react-query';

// ─── Indigo / slate design tokens ─────────────────────────────────────────
const VBRAND = {
  purple: '#2563EB', purpleDeep: '#1D4ED8', orange: '#4F46E5',
  ink900: '#111827', ink700: '#374151', ink600: '#6B7280', ink500: '#6B7280', ink400: '#9CA3AF',
  surface: '#FFFFFF',
  cardBorder: '#E5E7EB',
  soft: '#EFF6FF',
  shadow: '#0F172A',
};

const STATUS_OPTS = [
  { label: 'Live', value: 'live' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Inactive', value: 'inactive' },
  { label: 'Exited', value: 'exited' },
  { label: 'Signed', value: 'signed' },
];
const BED_TYPES = [
  { label: 'Single', value: 'single' },
  { label: 'Double', value: 'double' },
  { label: 'Triple', value: 'triple' },
  { label: 'Quad', value: 'quad' },
];
const TOILET_TYPES = [
  { label: 'Attached', value: 'attached' },
  { label: 'Common', value: 'common' },
];

const statusColor = (s: string) => {
  switch (s) {
    case 'live': return colors.success;
    case 'in_progress': return colors.warning;
    case 'inactive': return colors.textTertiary;
    default: return colors.primary;
  }
};

const GENDER_OPTIONS = [
  { label: 'Male', value: 'Male' },
  { label: 'Female', value: 'Female' },
  { label: 'Mixed', value: 'Mixed' },
  { label: 'Any', value: 'Any' },
];
const APT_TYPES = [
  { label: '1BHK', value: '1BHK' },
  { label: '2BHK', value: '2BHK' },
  { label: '3BHK', value: '3BHK' },
  { label: 'Studio', value: 'Studio' },
  { label: 'PG Room', value: 'PG Room' },
];
const EB_CONN_TYPES = [
  { label: 'LT (Low Tension)', value: 'LT' },
  { label: 'HT (High Tension)', value: 'HT' },
  { label: 'Metered', value: 'Metered' },
];

const blankAptForm = {
  apartment_code: '', floor_number: '', apartment_type: '', size_sqft: '',
  gender_allowed: '', status: 'live', signing_date: '', start_date: '', end_date: '',
  eb_card_number: '', eb_consumer_number: '', eb_connection_type: 'LT',
  property_tax_id: '', property_tax_amount: '', water_tax_id: '', water_tax_amount: '',
};

// ─── Occupancy inception helpers (exact match of web BedHistoryDialog logic) ─

function getInceptionDate(aptStartDate: string | null | undefined, propStartDate: string | null | undefined): Date {
  const dates: Date[] = [];
  if (aptStartDate) { try { dates.push(new Date(aptStartDate)); } catch (_) {} }
  if (propStartDate) { try { dates.push(new Date(propStartDate)); } catch (_) {} }
  if (!dates.length) return new Date(2023, 3, 1); // fallback Apr 2023
  return new Date(Math.max(...dates.map(d => d.getTime())));
}

function clampedStayDays(onboardingDate: string | null, exitDate: string | null, stayingStatus: string | null, inception: Date): number {
  const today = new Date();
  const rawStart = onboardingDate ? new Date(onboardingDate) : null;
  const end = exitDate ? new Date(exitDate) : (stayingStatus === 'Exited' ? null : today);
  if (!rawStart || !end) return 0;
  const start = rawStart < inception ? inception : rawStart;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86400000));
}

function getOccupancyColor(pct: number): string {
  if (pct >= 75) return '#22C55E';
  if (pct >= 50) return '#EAB308';
  if (pct >= 30) return '#F97316';
  return '#EF4444';
}

// ─── Performance period helpers ──────────────────────────────────────────────

const PERIODS = [
  { label: 'Current FY',   value: 'current_fy'  },
  { label: 'Last FY',      value: 'last_fy'     },
  { label: 'Last 2 Years', value: 'last_2fy'    },
  { label: 'Last 5 Years', value: 'last_5y'     },
  { label: 'Custom',       value: 'custom'      },
];

function getPeriodRange(period: string): { from: Date; to: Date } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based
  if (period === 'this_month') {
    return { from: new Date(y, m, 1), to: new Date(y, m + 1, 0) };
  }
  if (period === 'this_quarter') {
    const qStart = Math.floor(m / 3) * 3;
    return { from: new Date(y, qStart, 1), to: new Date(y, qStart + 3, 0) };
  }
  if (period === 'this_year') {
    return { from: new Date(y, 0, 1), to: new Date(y, 11, 31) };
  }
  // Indian FY runs Apr–Mar. The FY the current date sits in starts in year fyY.
  const fyY = m >= 3 ? y : y - 1;
  if (period === 'last_fy') {
    // The single previous financial year.
    return { from: new Date(fyY - 1, 3, 1), to: new Date(fyY, 2, 31) };
  }
  if (period === 'last_2fy' || period === 'last_2_years') {
    // Trailing 2 years up to today.
    return { from: new Date(y - 2, m, now.getDate()), to: now };
  }
  if (period === 'last_5y' || period === 'last_5_years') {
    // Trailing 5 years up to today.
    return { from: new Date(y - 5, m, now.getDate()), to: now };
  }
  if (period === 'from_beginning' || period === 'all_time') {
    return { from: new Date(2000, 0, 1), to: now };
  }
  // current_fy (default) — Indian FY: Apr–Mar.
  return { from: new Date(fyY, 3, 1), to: new Date(fyY + 1, 2, 31) };
}


// ─── Discrepancy helpers (mirror web BedHistoryDialog overlap logic) ─────────
// A bed/tenant with 2+ active allotments is only a discrepancy when their
// occupancy windows actually OVERLAP. A dated handover/swap (outgoing exit ≤
// incoming onboarding) is NOT flagged. Missing dates widen the window so they
// stay flagged, and `dateGaps` explains which date is missing.
const DISC_ACTIVE_STATUSES = ['Staying', 'On-Notice', 'Booked'];

function getAllotmentEffectiveExitDate(a: any): string | null {
  if (a?.actual_exit_date && String(a.actual_exit_date).trim()) return a.actual_exit_date;
  if (a?.estimated_exit_date && String(a.estimated_exit_date).trim()) return a.estimated_exit_date;
  if (a?.notice_date && String(a.notice_date).trim()) return a.notice_date;
  return null;
}

function allotmentWindow(a: any): { start: number; end: number } {
  const startStr = a?.onboarding_date;
  const endStr = getAllotmentEffectiveExitDate(a);
  const start = startStr && String(startStr).trim() ? new Date(startStr).getTime() : Number.NEGATIVE_INFINITY;
  const end = endStr && String(endStr).trim() ? new Date(endStr).getTime() : Number.POSITIVE_INFINITY;
  return { start, end };
}

function allotmentDateGap(a: any): string | null {
  const who = a?.tenants?.full_name || a?.staying_status || 'Tenant';
  const hasOnboarding = a?.onboarding_date && String(a.onboarding_date).trim();
  const hasExit = !!getAllotmentEffectiveExitDate(a);
  if (!hasOnboarding && !hasExit) return `${who}: no onboarding and no exit/notice date`;
  if (!hasOnboarding) return `${who}: no onboarding date`;
  if (!hasExit) return `${who}: open-ended — no exit/notice date`;
  return null;
}

function collectDateGaps(allots: any[]): string[] {
  return allots.map(allotmentDateGap).filter((g: any): g is string => !!g);
}

// Same-day turnover is a clean handover: earlier.end === later.start does NOT
// overlap (strict `<`).
function hasOverlappingPair(allots: any[]): boolean {
  const wins = allots.map(allotmentWindow);
  for (let i = 0; i < wins.length; i++) {
    for (let j = i + 1; j < wins.length; j++) {
      if (wins[i].start < wins[j].end && wins[j].start < wins[i].end) return true;
    }
  }
  return false;
}

// ─── Discrepancies Tab Component ─────────────────────────────────────────────
function DiscrepanciesTab({ discrepancies, colors, fontSize, spacing, styles, beds }: any) {
  const { bedDisc, tenantDisc, contractDisc } = discrepancies;
            const totalIssues = bedDisc.length + tenantDisc.length + contractDisc.length;
            const fmtDate = (d: string | null | undefined) => formatDate(d, '—');
            return <>
                {/* Summary banner */}
                <View style={{
                  backgroundColor: totalIssues > 0 ? '#FFEBEE' : '#E8F5E9',
                  borderRadius: 12, padding: 12, marginBottom: 14,
                  flexDirection: 'row', alignItems: 'center', gap: 8,
                  borderWidth: 1, borderColor: totalIssues > 0 ? '#FFCDD2' : '#C8E6C9',
                }}>
                  <Ionicons
                    name={totalIssues > 0 ? 'warning' : 'checkmark-circle'}
                    size={18}
                    color={totalIssues > 0 ? '#C62828' : '#2E7D32'}
                  />
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: totalIssues > 0 ? '#C62828' : '#2E7D32', flex: 1 }}>
                    {totalIssues > 0 ? `${totalIssues} issue${totalIssues > 1 ? 's' : ''} found` : 'No discrepancies — all clear!'}
                  </Text>
                </View>
  
                {/* ── 1. Beds with multiple active tenants ── */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <Ionicons name="warning-outline" size={16} color="#C62828" />
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#111827' }}>
                    Beds with Multiple Active Tenants ({bedDisc.length})
                  </Text>
                </View>
                <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, marginBottom: 10 }}>
                  These beds have 2+ active tenants whose stay dates overlap. Dated handovers (one exits before the next moves in) are not shown.
                </Text>
                {bedDisc.length === 0 ? (
                  <View style={[styles.card, { backgroundColor: '#F0FDF4', borderColor: '#BBF7D0', marginBottom: 16 }]}>
                    <Text style={{ fontSize: fontSize.sm, color: '#2E7D32', textAlign: 'center' }}>No bed-level discrepancies found.</Text>
                  </View>
                ) : bedDisc.map((disc: any) => (
                  <View key={disc.bedId} style={[styles.card, { borderColor: '#FFCDD2', borderWidth: 1.5, marginBottom: 8 }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <View style={styles.codeBadge}><Text style={styles.codeBadgeText}>{disc.aptName}-{disc.bedCode}</Text></View>
                      <View style={{ backgroundColor: '#FFEBEE', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: '#C62828' }}>{disc.allots.length} active</Text>
                      </View>
                    </View>
                    {disc.allots.map((a: any, i: number) => (
                      <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: colors.border }}>
                        <Text style={{ fontSize: fontSize.xs, color: '#111827', fontWeight: '600', flex: 1 }}>
                          {a.tenants?.full_name || '—'}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                          <View style={{ backgroundColor: '#FFEBEE', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                            <Text style={{ fontSize: 9, fontWeight: '700', color: '#C62828' }}>{a.staying_status}</Text>
                          </View>
                          <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>{fmtDate(a.onboarding_date)}</Text>
                        </View>
                      </View>
                    ))}
                    {disc.dateGaps && disc.dateGaps.length > 0 && (
                      <View style={{ marginTop: 6, backgroundColor: '#FFF8E1', borderRadius: 6, padding: 6 }}>
                        {disc.dateGaps.map((g: string, gi: number) => (
                          <Text key={gi} style={{ fontSize: 10, color: '#8B6914' }}>⚠ {g}</Text>
                        ))}
                      </View>
                    )}
                  </View>
                ))}
  
                {/* ── 2. Tenants with multiple active beds ── */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, marginBottom: 8 }}>
                  <Ionicons name="warning-outline" size={16} color="#C62828" />
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#111827' }}>
                    Tenants with Multiple Active Beds ({tenantDisc.length})
                  </Text>
                </View>
                <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, marginBottom: 10 }}>
                  These tenants hold 2+ beds whose stay dates overlap. Dated swaps (exit one before onboarding the next) are not shown.
                </Text>
                {tenantDisc.length === 0 ? (
                  <View style={[styles.card, { backgroundColor: '#F0FDF4', borderColor: '#BBF7D0', marginBottom: 16 }]}>
                    <Text style={{ fontSize: fontSize.sm, color: '#2E7D32', textAlign: 'center' }}>No tenant-level discrepancies found.</Text>
                  </View>
                ) : tenantDisc.map((disc: any) => (
                  <View key={disc.tenantId} style={[styles.card, { borderColor: '#FFCDD2', borderWidth: 1.5, marginBottom: 8 }]}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                      <View>
                        <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#111827' }}>{disc.tenantName}</Text>
                        {disc.phone ? <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>{disc.phone}</Text> : null}
                      </View>
                      <View style={{ backgroundColor: '#FFEBEE', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: '#C62828' }}>{disc.allots.length} beds</Text>
                      </View>
                    </View>
                    {disc.allots.map((a: any, i: number) => (
                      <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: colors.border }}>
                        <Text style={{ fontSize: fontSize.xs, fontWeight: '600', color: '#111827' }}>
                          {a.onboarding_date ? fmtDate(a.onboarding_date) : a.bed_id ? a.bed_id.slice(0, 8) : '—'}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 6 }}>
                          <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>({a.staying_status})</Text>
                          <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>{fmtDate(a.onboarding_date)}</Text>
                        </View>
                      </View>
                    ))}
                    {disc.dateGaps && disc.dateGaps.length > 0 && (
                      <View style={{ marginTop: 6, backgroundColor: '#FFF8E1', borderRadius: 6, padding: 6 }}>
                        {disc.dateGaps.map((g: string, gi: number) => (
                          <Text key={gi} style={{ fontSize: 10, color: '#8B6914' }}>⚠ {g}</Text>
                        ))}
                      </View>
                    )}
                </View>
              ))}

              {/* ── 3. Contract expired apartments ── */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, marginBottom: 8 }}>
                <Ionicons name="warning-outline" size={16} color="#E65100" />
                <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#111827' }}>
                  Contract Expired — Renewal Required ({contractDisc.length})
                </Text>
              </View>
              <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, marginBottom: 10 }}>
                These apartments are Live but their contract end date has passed. Renewal needed.
              </Text>
              {contractDisc.length === 0 ? (
                <View style={[styles.card, { backgroundColor: '#F0FDF4', borderColor: '#BBF7D0' }]}>
                  <Text style={{ fontSize: fontSize.sm, color: '#2E7D32', textAlign: 'center' }}>No contract expiry issues found.</Text>
                </View>
              ) : contractDisc.map((a: any) => (
                <View key={a.id} style={[styles.card, { borderColor: '#FFE0B2', borderWidth: 1.5, marginBottom: 8 }]}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View>
                      <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#111827' }}>{a.apartment_code}</Text>
                      {a.floor_number != null && <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>Floor {a.floor_number}</Text>}
                    </View>
                    <View>
                      <View style={{ backgroundColor: '#FFF3E0', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: '#E65100' }}>Expired</Text>
                      </View>
                      <Text style={{ fontSize: fontSize.xs, color: '#E65100', marginTop: 2, textAlign: 'right' }}>
                        {fmtDate(a.end_date)}
                      </Text>
                    </View>
                  </View>
                </View>
              ))}
            </>;
}

export default function PropertyDetailScreen({ route, navigation }: any) {
  const { propertyId, propertyName, initialTab } = route.params;
  const { token } = useAuth();
  
  
  
  
  
  
  
  

  const [apartments, setApartments] = useState<any[] | null>(null);
  const [beds, setBeds] = useState<any[] | null>(null);
  const [assets, setAssets] = useState<any[]>([]);
  const [assetCostMap, setAssetCostMap] = useState<Record<string, number>>({});
  const [assetCountMap, setAssetCountMap] = useState<Record<string, number>>({});
  const [bedCostMap, setBedCostMap] = useState<Record<string, number>>({});
  // ── Per-apartment Assets panel (current allocated assets) ───────────────────
  const [assetPanelApt, setAssetPanelApt] = useState<any>(null);
  const [expandedAssetId, setExpandedAssetId] = useState<string | null>(null);
  const [showAddApt, setShowAddApt] = useState(false);
  const [showAddBed, setShowAddBed] = useState(false);
  const [showRateModal, setShowRateModal] = useState(false);
  // ── Dedicated bed rates (fetched separately from beds) ──────────────────────
  const [bedRates, setBedRates]           = useState<any[]>([]);
  const [rateSearch, setRateSearch]       = useState('');
  const [editRateTarget, setEditRateTarget] = useState<any>(null);
  const [showEditRate, setShowEditRate]   = useState(false);
  const [editRateType,   setEditRateType]   = useState('single');
  const [editRateToilet, setEditRateToilet] = useState('common');
  const [editRateAmount, setEditRateAmount] = useState('');
  const [editRateFrom,   setEditRateFrom]   = useState('');
  const [editRateTo,     setEditRateTo]     = useState('');
  // ── Photos ───────────────────────────────────────────────────────────────────
  const [propertyImages, setPropertyImages] = useState<any[]>([]);
  const [showPhotoAdd,   setShowPhotoAdd]  = useState(false);
  const [photoUrl,       setPhotoUrl]      = useState('');
  const [photoCaption,   setPhotoCaption]  = useState('');
  const [photoLoading,   setPhotoLoading]  = useState(false);
  const [rateBedId, setRateBedId] = useState('');
  const [rateAmount, setRateAmount] = useState('');
  const [rateDate, setRateDate] = useState('');
  const [rateToDate, setRateToDate] = useState('');
  const [aptName, setAptName] = useState('');
  const [aptFloor, setAptFloor] = useState('');
  const [aptStatus, setAptStatus] = useState('live');
  const [bedAptId, setBedAptId] = useState('');
  const [bedType, setBedType] = useState('single');
  const [bedToilet, setBedToilet] = useState('common');
  const [bedRent, setBedRent] = useState('');
  const [bedStatus, setBedStatus] = useState('live');
  const [loading, setLoading] = useState(false);
  const [activeView, setActiveView] = useState<'apartments' | 'beds' | 'rates' | 'discrepancies' | 'photos'>(initialTab || 'apartments');
  const [search, setSearch] = useState('');
  const [liveOnly, setLiveOnly] = useState(false);
  // Custom reporting-period range (used when occupancyPeriod === 'custom').
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [showCustomRange, setShowCustomRange] = useState(false);

  // ── Performance data for star ratings ──────────────────────────────────────
  const [perfAllotments, setPerfAllotments] = useState<any[]>([]);
  const [perfTickets,    setPerfTickets]    = useState<any[]>([]);
  const [perfInvoices,   setPerfInvoices]   = useState<any[]>([]);
  const [perfApartments, setPerfApartments] = useState<any[]>([]);
  const [perfProperty,   setPerfProperty]   = useState<any>(null);
  const [occupancyPeriod, setOccupancyPeriod] = useState('current_fy');

  // ── Analytics view ──────────────────────────────────────────────────────────
  const [showAnalytics, setShowAnalytics] = useState(false);

  // ── KYC QR ─────────────────────────────────────────────────────────────────
  const [kycQrOpen, setKycQrOpen] = useState(false);

  // ── Bed History ─────────────────────────────────────────────────────────────
  const [bedHistoryBed,    setBedHistoryBed]    = useState<any>(null);
  const [bedHistoryData,   setBedHistoryData]   = useState<any>(null);
  const [bedHistoryLoading, setBedHistoryLoading] = useState(false);

  // ── Beds tab search + filter ────────────────────────────────────────────────
  const [bedSearch,       setBedSearch]       = useState('');
  const [bedStatusFilter, setBedStatusFilter] = useState<'all' | 'occupied' | 'vacant'>('all');

  // ── Full Add Apartment form ─────────────────────────────────────────────────
  const [aptFormFull, setAptFormFull] = useState<any>(blankAptForm);
  const [expandedApts, setExpandedApts] = useState<Set<string>>(new Set());
  // Edit bed state
  const [showEditBed, setShowEditBed] = useState(false);
  const [editBedTarget, setEditBedTarget] = useState<any>(null);
  const [editBedType, setEditBedType] = useState('single');
  const [editBedToilet, setEditBedToilet] = useState('common');
  const [editBedStatus, setEditBedStatus] = useState('live');
  // Edit apartment state
  const [showEditApt, setShowEditApt] = useState(false);
  const [editAptTarget, setEditAptTarget] = useState<any>(null);
  const [editAptForm, setEditAptForm] = useState<any>({});

  const mounted = useMountedRef();
  const [aptMenuId, setAptMenuId] = useState<string | null>(null);

  // ── Cache-first load via React Query (persisted → instant open) ───────────
  // One query holds the whole property-detail payload (core + rates + images +
  // performance); each property is its own cache entry. The result is synced
  // into the existing state below, so all render code and the optimistic
  // add/edit/delete handlers keep working unchanged.
  const detailQuery = useQuery({
    queryKey: ['propertyDetail', propertyId],
    enabled: !!token,
    queryFn: async () => {
      let aptList: any[] = [], bedList: any[] = [], assetList: any[] = [];
      const costMap: Record<string, number> = {};
      const countMap: Record<string, number> = {};
      const bedMap: Record<string, number> = {};
      try {
        const [a, b, ast, allocs]: any = await Promise.all([
          sb.listApartments(propertyId),
          sb.listBeds({ propertyId }),
          sb.listAssets().catch(() => []),
          sb.listAllocations().catch(() => []),
        ]);
        aptList = a ?? []; bedList = b ?? []; assetList = ast ?? [];
        // Per-apartment + per-bed asset cost/count maps from allocations
        // (listAssets has no bed_id, so per-bed cost comes from asset_allocations).
        const aptIdSet = new Set(aptList.map((x: any) => x._id));
        const bedIdSet = new Set(bedList.map((x: any) => x._id));
        for (const al of (allocs || [])) {
          const inProp =
            (al.apartment_id && aptIdSet.has(al.apartment_id)) ||
            (al.bed_id && bedIdSet.has(al.bed_id)) ||
            al.property_id === propertyId;
          if (!inProp) continue;
          const price = Number(al.assets?.purchase_price) || 0;
          if (al.apartment_id) {
            costMap[al.apartment_id] = (costMap[al.apartment_id] || 0) + price;
            countMap[al.apartment_id] = (countMap[al.apartment_id] || 0) + 1;
          }
          if (al.allocation_type === 'bed' && al.bed_id) {
            bedMap[al.bed_id] = (bedMap[al.bed_id] || 0) + price;
          }
        }
      } catch { /* core failed — render empty rather than error */ }

      const [rates, images, perf] = await Promise.all([
        sb.listBedRates(propertyId).then((r: any) => r ?? []).catch(() => []),
        sb.listPropertyImages(propertyId).then((i: any) => i ?? []).catch(() => []),
        sb.getPropertyPerformanceData(propertyId).then((dd: any) => dd).catch(() => null),
      ]);

      return {
        apartments: aptList, beds: bedList, assets: assetList,
        assetCostMap: costMap, assetCountMap: countMap, bedCostMap: bedMap,
        bedRates: rates, propertyImages: images,
        perfAllotments: perf?.allotments || [],
        perfTickets:    perf?.tickets    || [],
        perfInvoices:   perf?.invoices   || [],
        perfApartments: perf?.apartments || [],
        perfProperty:   perf?.property   || null,
      };
    },
  });

  // Sync the (possibly cached) payload into local state.
  useEffect(() => {
    const d = detailQuery.data;
    if (!d) return;
    setApartments(d.apartments);
    setBeds(d.beds);
    setAssets(d.assets);
    setAssetCostMap(d.assetCostMap);
    setAssetCountMap(d.assetCountMap);
    setBedCostMap(d.bedCostMap);
    setBedRates(d.bedRates);
    setPropertyImages(d.propertyImages);
    setPerfAllotments(d.perfAllotments);
    setPerfTickets(d.perfTickets);
    setPerfInvoices(d.perfInvoices);
    setPerfApartments(d.perfApartments);
    setPerfProperty(d.perfProperty);
  }, [detailQuery.data]);

  // Mutations trigger a refetch. setRefreshKey is kept as a shim so every
  // existing `setRefreshKey(k => k + 1)` call site works untouched.
  const refresh = () => { detailQuery.refetch(); };
  const setRefreshKey = (_?: any) => { detailQuery.refetch(); };

  const handleAddBed = async () => {
    if (!bedAptId) { Alert.alert('Error', 'Apartment is required'); return; }
    if (!bedRent.trim()) { Alert.alert('Error', 'Unit Number is required'); return; }
    setLoading(true);
    try {
      await sb.createBed({
        propertyId, apartmentId: bedAptId,
        unitNumber: bedRent.trim(),
        type: bedType as any, toiletType: bedToilet as any,
        monthlyRent: 0, status: bedStatus as any,
      });
      setShowAddBed(false);
      setBedRent('');
      setRefreshKey((k: number) => k + 1);
    } catch (e: any) { Alert.alert('Error', e.message); }
    setLoading(false);
  };

  const handleUpdateRate = async () => {
    if (!rateBedId) { Alert.alert('Error', 'Select a bed'); return; }
    if (!rateAmount) { Alert.alert('Error', 'Enter a rate'); return; }

    const selectedBed = (beds || []).find((b: any) => b._id === rateBedId);
    if (!selectedBed) { Alert.alert('Error', 'Bed not found'); return; }

    setLoading(true);
    try {
      await sb.createBedRate({
        propertyId,
        // Store lowercase to match the edit path + avoid mixed-casing rows
        // (getCurrentRate compares case-insensitively, but keep DB consistent).
        bedType: String(selectedBed.type || '').toLowerCase(),
        toiletType: String(selectedBed.toiletType || 'common').toLowerCase(),
        monthlyRate: Number(rateAmount),
        fromDate: rateDate || new Date().toISOString().split('T')[0],
        toDate: rateToDate || '2099-12-31',
      });
      setShowRateModal(false);
      setRateBedId(''); setRateAmount(''); setRateDate(''); setRateToDate('');
      setRefreshKey((k: number) => k + 1);
      Alert.alert('Success', 'Bed rate created successfully');
    } catch (e: any) { Alert.alert('Error', e.message); }
    setLoading(false);
  };

  // ── Rate edit / delete handlers ─────────────────────────────────────────────
  const openEditRate = (r: any) => {
    setEditRateTarget(r);
    setEditRateType(r.bed_type || 'single');
    setEditRateToilet(r.toilet_type || 'common');
    setEditRateAmount(String(r.monthly_rate || ''));
    setEditRateFrom(r.from_date || '');
    setEditRateTo(r.to_date || '');
    setShowEditRate(true);
  };

  const handleEditRate = async () => {
    if (!editRateTarget) return;
    setLoading(true);
    try {
      await sb.updateBedRate(editRateTarget.id, {
        bedType: editRateType, toiletType: editRateToilet,
        monthlyRate: Number(editRateAmount),
        fromDate: editRateFrom, toDate: editRateTo,
      });
      setShowEditRate(false);
      setEditRateTarget(null);
      const rates: any = await sb.listBedRates(propertyId);
      setBedRates(rates ?? []);
    } catch (e: any) { Alert.alert('Error', e.message); }
    setLoading(false);
  };

  const handleDeleteRate = (r: any) => {
    Alert.alert('Delete Rate', `Remove this rate (${r.bed_type} · ₹${r.monthly_rate}/mo)?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await sb.deleteBedRate(r.id);
          setBedRates(prev => prev.filter(x => x.id !== r.id));
        } catch (e: any) { Alert.alert('Error', e.message); }
      }},
    ]);
  };

  // ── Photo handlers ────────────────────────────────────────────────────────
  const handleAddPhoto = async () => {
    if (!photoUrl.trim()) { Alert.alert('Required', 'Enter an image URL'); return; }
    setPhotoLoading(true);
    try {
      await sb.addPropertyImage({
        propertyId, imageUrl: photoUrl.trim(),
        caption: photoCaption.trim() || null,
        isCover: propertyImages.length === 0,
      });
      const imgs: any = await sb.listPropertyImages(propertyId);
      setPropertyImages(imgs ?? []);
      setPhotoUrl(''); setPhotoCaption(''); setShowPhotoAdd(false);
    } catch (e: any) { Alert.alert('Error', e.message); }
    setPhotoLoading(false);
  };

  // Pick an image from the device, upload it to storage, then register it.
  const handlePickAndUploadPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { Alert.alert('Permission Required', 'Please allow access to your photo library.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images' as any, quality: 0.7, base64: true });
    if (result.canceled || !result.assets?.[0]) return;
    const a = result.assets[0];
    setPhotoLoading(true);
    try {
      const url = await uploadTicketPhoto(a.uri, a.base64 ?? undefined, a.mimeType ?? 'image/jpeg');
      if (!url) throw new Error('Upload failed — please try again.');
      await sb.addPropertyImage({
        propertyId, imageUrl: url, caption: null,
        isCover: propertyImages.length === 0,
      });
      const imgs: any = await sb.listPropertyImages(propertyId);
      setPropertyImages(imgs ?? []);
    } catch (e: any) { Alert.alert('Error', e.message); }
    setPhotoLoading(false);
  };

  const handleDeletePhoto = (id: string) => {
    Alert.alert('Delete Photo', 'Remove this photo?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await sb.deletePropertyImage(id);
          setPropertyImages(prev => prev.filter(img => img.id !== id));
        } catch (e: any) { Alert.alert('Error', e.message); }
      }},
    ]);
  };

  const handleSetCover = async (id: string) => {
    try {
      await sb.setPropertyImageCover(id, propertyId);
      const imgs: any = await sb.listPropertyImages(propertyId);
      setPropertyImages(imgs ?? []);
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  // ── Star rating + occupancy helpers (exact match of web getApartmentStarBreakdown) ─

  const starPeriodRange = useMemo(() => {
    if (occupancyPeriod === 'custom') {
      const from = customFrom ? new Date(customFrom) : new Date(2000, 0, 1);
      const to   = customTo   ? new Date(customTo)   : new Date();
      return { from, to };
    }
    return getPeriodRange(occupancyPeriod);
  }, [occupancyPeriod, customFrom, customTo]);

  const getAptOccupancy = useCallback((aptId: string): number => {
    const { from, to } = starPeriodRange;
    const aptBeds = (beds || []).filter((b: any) =>
      (b.apartmentId || b.apartment_id) === aptId && (b.status || '').toLowerCase() === 'live'
    );
    if (!aptBeds.length) return 0;
    const daysInPeriod = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86400000) + 1);
    const capacityBedDays = aptBeds.length * daysInPeriod;
    const aptBedIds = new Set(aptBeds.map((b: any) => b._id || b.id));
    const aptRecord = perfApartments.find((pa: any) => pa.id === aptId);
    const inception = getInceptionDate(aptRecord?.start_date, perfProperty?.start_date);
    let occupiedBedDays = 0;
    perfAllotments.forEach((a: any) => {
      if (!aptBedIds.has(a.bed_id)) return;
      if (!['Staying', 'On-Notice', 'Exited'].includes(a.staying_status)) return;
      if (!a.onboarding_date) return;
      const rawStart = new Date(a.onboarding_date);
      const exitDate = a.actual_exit_date ? new Date(a.actual_exit_date) : (a.staying_status === 'Exited' ? null : new Date());
      if (!exitDate) return;
      const effStart = rawStart < inception ? inception : rawStart;
      const clampedStart = new Date(Math.max(effStart.getTime(), from.getTime()));
      const clampedEnd   = new Date(Math.min(exitDate.getTime(), to.getTime()));
      const days = Math.max(0, Math.ceil((clampedEnd.getTime() - clampedStart.getTime()) / 86400000) + 1);
      occupiedBedDays += days;
    });
    return Math.min(100, Math.round((occupiedBedDays / capacityBedDays) * 100));
  }, [perfAllotments, perfApartments, perfProperty, beds, starPeriodRange]);

  const getAptRevenue = useCallback((aptId: string): { actual: number; possible: number } => {
    const { from, to } = starPeriodRange;
    const actual = perfInvoices
      .filter((inv: any) => inv.apartment_id === aptId && inv.billing_month)
      .reduce((s: number, inv: any) => {
        const d = new Date(inv.billing_month + '-01');
        return (d >= from && d <= to) ? s + Number(inv.total_amount || inv.rent_amount || 0) : s;
      }, 0);
    // possible = live beds × avg rate × fractional months
    const aptBeds = (beds || []).filter((b: any) => (b.apartmentId || b.apartment_id) === aptId && (b.status || '').toLowerCase() === 'live');
    const months = Math.max(1, (to.getTime() - from.getTime()) / (30.44 * 86400000));
    const possible = aptBeds.reduce((s: number, b: any) => s + (b.currentRate || b.monthlyRent || 0), 0) * months;
    return { actual, possible };
  }, [perfInvoices, beds, starPeriodRange]);

  const getAptStarBreakdown = useCallback((aptId: string) => {
    const { from, to } = starPeriodRange;
    const occ = getAptOccupancy(aptId);
    const { actual, possible } = getAptRevenue(aptId);
    const revPct = possible > 1 ? Math.min(100, (actual / possible) * 100) : 100;

    const toEnd = new Date(to); toEnd.setHours(23, 59, 59, 999);
    const propTK = perfTickets.filter((t: any) => {
      if (!t.created_at) return false;
      const d = new Date(t.created_at);
      return d >= from && d <= toEnd;
    });
    const aptTK = propTK.filter((t: any) => t.apartment_id === aptId);
    const ticketShare = propTK.length > 0 ? (aptTK.length / propTK.length) * 100 : 0;
    const ticketScore = Math.max(0, 100 - ticketShare);

    const wOcc     = 0.5  * occ;
    const wRev     = 0.25 * revPct;
    const wTickets = 0.25 * ticketScore;
    const composite = wOcc + wRev + wTickets;
    const stars = composite >= 80 ? 5 : composite >= 70 ? 4 : 3;

    return { stars, composite, occ, revPct, ticketScore, wOcc, wRev, wTickets,
             aptTickets: aptTK.length, propTickets: propTK.length, ticketShare };
  }, [getAptOccupancy, getAptRevenue, perfTickets, starPeriodRange]);

  // ── Discrepancies (mirrors web findBedDiscrepancies / findTenantDiscrepancies) ─
  // Only flags genuine OVERLAPS; dated handovers/swaps are excluded.

  const discrepancies = useMemo(() => {
    if (!perfAllotments.length) return { bedDisc: [], tenantDisc: [], contractDisc: [] };
    const active = perfAllotments.filter((a: any) => DISC_ACTIVE_STATUSES.includes(a.staying_status));

    // 1. Beds with 2+ active allotments whose occupancy windows OVERLAP.
    const bedMap: Record<string, any[]> = {};
    active.forEach((a: any) => {
      if (!a.bed_id) return;
      (bedMap[a.bed_id] = bedMap[a.bed_id] || []).push(a);
    });
    const bedDisc = Object.entries(bedMap)
      .filter(([, allots]) => allots.length >= 2 && hasOverlappingPair(allots))
      .map(([bedId, allots]) => {
        const bed = (beds || []).find((b: any) => (b._id || b.id) === bedId);
        return {
          bedId,
          bedCode: bed?.code || bedId,
          aptName: bed?.apartmentName || '?',
          allots,
          dateGaps: collectDateGaps(allots),
        };
      });

    // 2. Tenants with 2+ active beds whose windows OVERLAP.
    const tenantMap: Record<string, any[]> = {};
    active.forEach((a: any) => {
      if (!a.tenant_id) return;
      (tenantMap[a.tenant_id] = tenantMap[a.tenant_id] || []).push(a);
    });
    const tenantDisc = Object.entries(tenantMap)
      .filter(([, allots]) => allots.length >= 2 && hasOverlappingPair(allots))
      .map(([tenantId, allots]) => ({
        tenantId,
        tenantName: allots[0]?.tenants?.full_name || tenantId,
        phone: allots[0]?.tenants?.phone || '',
        allots,
        dateGaps: collectDateGaps(allots),
      }));

    // 3. Apartments: Live but contract end_date passed.
    const now = new Date();
    const contractDisc = perfApartments.filter((a: any) =>
      (a.status || '').toLowerCase() === 'live' &&
      a.end_date &&
      new Date(a.end_date) < now
    );

    return { bedDisc, tenantDisc, contractDisc };
  }, [perfAllotments, perfApartments, beds]);

  const filteredApartments = useMemo(() => {
    if (!apartments) return [];
    let sorted = [...apartments].sort((a: any, b: any) => (a.code || '').localeCompare(b.code || ''));
    if (liveOnly) sorted = sorted.filter((a: any) => (a.status || '').toLowerCase() === 'live');
    if (!search) return sorted;
    const q = search.toLowerCase();
    return sorted.filter((a: any) =>
      (a.code || '').toLowerCase().includes(q) ||
      (a.name || '').toLowerCase().includes(q) ||
      (a.status || '').toLowerCase().includes(q)
    );
  }, [apartments, search, liveOnly]);

  const filteredBeds = useMemo(() => {
    if (!beds) return [];
    const sorted = [...beds].sort((a: any, b: any) =>
      (a.apartmentName || '').localeCompare(b.apartmentName || '') || (a.code || '').localeCompare(b.code || '')
    );
    if (!search) return sorted;
    const q = search.toLowerCase();
    return sorted.filter((b: any) =>
      (b.code || '').toLowerCase().includes(q) ||
      (b.apartmentName || '').toLowerCase().includes(q) ||
      (b.type || '').toLowerCase().includes(q) ||
      (b.status || '').toLowerCase().includes(q)
    );
  }, [beds, search]);

  if (!apartments || !beds) return <LoadingScreen />;

  const aptOptions = apartments.map((a: any) => ({ label: a.code, value: a._id }));
  const liveAptCount = apartments.filter((a: any) => (a.status || '').toLowerCase() === 'live').length;
  const liveBedCount = (beds || []).filter((b: any) => (b.status || '').toLowerCase() === 'live').length;
  const bedPickerOptions = (beds || []).map((b: any) => ({ label: `${b.code} (${b.apartmentName})`, value: b._id }));

  const getAptAssetsCost = (aptId: string) => {
    if (assetCostMap[aptId] !== undefined) return assetCostMap[aptId];
    return assets
      .filter((a: any) => a.apartmentId === aptId && (a.status || '').toLowerCase() === 'allocated')
      .reduce((sum: number, a: any) => sum + (Number(a.purchasePrice) || 0), 0);
  };

  const getAptBeds = (aptId: string) => {
    return (beds || []).filter((b: any) => b.apartmentId === aptId);
  };

  // ── Per-apartment Assets panel data ────────────────────────────────────────
  // Assets that belong to this apartment, matched by asset code (`VH-…-A11-…`).
  // We use the fully-paginated `assets` list (listAssets) rather than
  // `listAllocations`, which the backend caps at 1000 rows — so an apartment's
  // allocations often fall outside that window and the panel would show nothing.
  const getApartmentAssetsNow = (apt: any) => {
    if (!apt?.code) return { rows: [] as any[], total: 0, count: 0 };
    const marker = `-${apt.code}-`;
    const rows = (assets || [])
      .filter((a: any) => (a.assetCode || '').includes(marker))
      .map((a: any) => {
        const fullPrice = Number(a.purchasePrice) || 0;
        return {
          assetId: a._id,
          code: a.assetCode || '—',
          typeName: a.typeName || 'Asset',
          brand: a.brand, model: a.model,
          condition: (a.condition || 'new'), status: a.status,
          fullPrice, share: fullPrice, asset: a,
        };
      })
      .sort((x: any, y: any) => String(x.code).localeCompare(String(y.code)));
    const total = rows.reduce((s: number, r: any) => s + r.share, 0);
    return { rows, total, count: rows.length };
  };

  // ₹ with Indian digit grouping.
  const money = (n: any) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
  // Colour for an asset condition/status pill.
  const conditionColor = (c: string) => {
    switch ((c || '').toLowerCase()) {
      case 'good': case 'excellent': return '#10B981';
      case 'new': return VBRAND.purple;
      case 'fair': return '#F59E0B';
      case 'poor': case 'damaged': case 'retired': case 'disposed': return '#DC2626';
      default: return VBRAND.ink400;
    }
  };

  // Per-bed revenue from period-filtered invoices
  const getBedRevenue = (bedId: string): number => {
    const { from, to } = starPeriodRange;
    return perfInvoices
      .filter((inv: any) => inv.bed_id === bedId && inv.billing_month)
      .reduce((s: number, inv: any) => {
        const d = new Date(inv.billing_month + '-01');
        return (d >= from && d <= to) ? s + Number(inv.total_amount || inv.rent_amount || 0) : s;
      }, 0);
  };

  const toggleApt = (id: string) => {
    setExpandedApts(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const openEditBed = (b: any) => {
    setEditBedTarget(b);
    setEditBedType(b.type || 'single');
    setEditBedToilet(b.toiletType || 'common');
    setEditBedStatus(b.status || 'live');
    setShowEditBed(true);
  };

  const handleEditBed = async () => {
    if (!editBedTarget) return;
    setLoading(true);
    try {
      await sb.updateBed(editBedTarget._id, {
        bed_type: editBedType, toilet_type: editBedToilet, status: editBedStatus,
      });
      setShowEditBed(false);
      setRefreshKey((k: number) => k + 1);
    } catch (e: any) { Alert.alert('Error', e.message); }
    setLoading(false);
  };

  const handleDeleteBed = (b: any) => {
    Alert.alert('Delete Bed', `Remove bed "${b.code}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await sb.deleteBed(b._id);
          setRefreshKey((k: number) => k + 1);
        } catch (e: any) { Alert.alert('Error', e.message); }
      }},
    ]);
  };

  const handleDeleteApt = (a: any) => {
    Alert.alert('Delete Apartment', `Remove "${a.code}"? All beds will also be deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await sb.deleteApartment(a._id);
          setRefreshKey((k: number) => k + 1);
        } catch (e: any) { Alert.alert('Error', e.message); }
      }},
    ]);
  };

  const genderBadge = (label: string | undefined) => {
    if (!label) return null;
    const lower = (label || '').toLowerCase();
    const color = lower.includes('male') && !lower.includes('female') ? '#3B82F6'
      : lower.includes('female') ? '#EC4899' : '#8B5CF6';
    return (
      <View style={{ backgroundColor: color + '18', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 }}>
        <Text style={{ fontSize: 11, fontWeight: '600', color, textTransform: 'capitalize' }}>{label}</Text>
      </View>
    );
  };

  return (
    <GlassBackground>
    <SafeAreaView style={{ flex: 1 }} edges={['top']}>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <GlassHeader style={{ paddingHorizontal: 0, paddingVertical: 0 }}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={{
            width: 40, height: 40, borderRadius: 12,
            backgroundColor: '#FFFFFF',
            borderWidth: 1, borderColor: '#E5E7EB',
            alignItems: 'center', justifyContent: 'center',
            marginRight: 12,
          }}
        >
          <Ionicons name="arrow-back" size={20} color={VBRAND.ink900} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{propertyName}</Text>
          <Text style={{ fontSize: 13, color: VBRAND.ink600, fontWeight: '500', marginTop: 2 }}>
            Property details
          </Text>
        </View>
        {/* Analytics button */}
        <TouchableOpacity
          onPress={() => setShowAnalytics(true)}
          activeOpacity={0.85}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 5,
            backgroundColor: '#EFF6FF', borderRadius: 999,
            paddingHorizontal: 12, paddingVertical: 8, marginRight: 8,
            borderWidth: 1, borderColor: '#C7D2FE',
          }}
        >
          <Ionicons name="bar-chart-outline" size={14} color={VBRAND.purple} />
          <Text style={{ fontSize: 11, fontWeight: '800', color: VBRAND.purpleDeep, letterSpacing: 0.3 }}>Analytics</Text>
        </TouchableOpacity>
        {/* KYC QR button */}
        <TouchableOpacity
          onPress={() => setKycQrOpen(true)}
          activeOpacity={0.85}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 5,
            backgroundColor: '#EFF6FF', borderRadius: 999,
            paddingHorizontal: 12, paddingVertical: 8,
            borderWidth: 1, borderColor: '#C7D2FE',
          }}
        >
          <Ionicons name="qr-code-outline" size={14} color={VBRAND.purple} />
          <Text style={{ fontSize: 11, fontWeight: '800', color: VBRAND.purpleDeep, letterSpacing: 0.3 }}>KYC</Text>
        </TouchableOpacity>
      </View>
      </GlassHeader>

      {/* ── Search Bar ─────────────────────────────────────────────── */}
      <View style={{ paddingHorizontal: 18, paddingBottom: 12 }}>
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={18} color={VBRAND.ink400} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder={`Search ${activeView}…`}
            placeholderTextColor={VBRAND.ink400}
          />
          {search.length > 0 && (
            <TouchableOpacity
              onPress={() => setSearch('')}
              style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center' }}
            >
              <Ionicons name="close" size={13} color={VBRAND.purple} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 100, paddingTop: 4 }} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={detailQuery.isRefetching} onRefresh={refresh} tintColor={VBRAND.purple} />}>
        {/* ── Stat Tiles ─────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
          <View style={{
            flex: 1,
            backgroundColor: VBRAND.surface,
            borderRadius: 14, padding: 14,
            borderWidth: 0.5, borderColor: VBRAND.cardBorder,
            shadowColor: VBRAND.shadow, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
          }}>
            <View style={{
              width: 32, height: 32, borderRadius: 10,
              backgroundColor: '#EFF6FF',
              alignItems: 'center', justifyContent: 'center', marginBottom: 10,
            }}>
              <Ionicons name="grid-outline" size={16} color={VBRAND.purple} />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
              <Text style={{ fontSize: 24, fontWeight: '900', color: '#10B981', letterSpacing: -0.5 }}>
                {liveAptCount}
              </Text>
              <Text style={{ fontSize: 13, fontWeight: '800', color: VBRAND.ink400 }}>
                /{apartments.length}
              </Text>
            </View>
            <Text style={{ fontSize: 11, fontWeight: '700', color: VBRAND.ink500, marginTop: 2, letterSpacing: 0.3, textTransform: 'uppercase' }}>
              Live Apartments
            </Text>
          </View>
          <View style={{
            flex: 1,
            backgroundColor: VBRAND.surface,
            borderRadius: 14, padding: 14,
            borderWidth: 0.5, borderColor: VBRAND.cardBorder,
            shadowColor: VBRAND.shadow, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
          }}>
            <View style={{
              width: 32, height: 32, borderRadius: 10,
              backgroundColor: 'rgba(232,132,26,0.14)',
              alignItems: 'center', justifyContent: 'center', marginBottom: 10,
            }}>
              <Ionicons name="bed-outline" size={16} color={VBRAND.orange} />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
              <Text style={{ fontSize: 24, fontWeight: '900', color: '#10B981', letterSpacing: -0.5 }}>
                {liveBedCount}
              </Text>
              <Text style={{ fontSize: 13, fontWeight: '800', color: VBRAND.ink400 }}>
                /{(beds || []).length}
              </Text>
            </View>
            <Text style={{ fontSize: 11, fontWeight: '700', color: VBRAND.ink500, marginTop: 2, letterSpacing: 0.3, textTransform: 'uppercase' }}>
              Live Beds
            </Text>
          </View>
        </View>

        {/* View Toggle */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.viewToggle}
          contentContainerStyle={{ gap: 4, padding: 4, alignItems: 'center' }}
        >
          {(['apartments', 'beds', 'rates', 'discrepancies', 'photos'] as const).map(tab => {
            const discCount = tab === 'discrepancies'
              ? discrepancies.bedDisc.length + discrepancies.tenantDisc.length + discrepancies.contractDisc.length
              : 0;
            const tabIcon = tab === 'apartments' ? 'grid-outline'
              : tab === 'beds' ? 'bed-outline'
              : tab === 'rates' ? 'cash-outline'
              : tab === 'photos' ? 'camera-outline'
              : 'warning-outline';
            const tabLabel = tab === 'apartments' ? 'Apts'
              : tab === 'beds' ? 'Beds'
              : tab === 'rates' ? 'Rates'
              : tab === 'photos' ? 'Photos'
              : 'Issues';
            const badgeCount = tab === 'discrepancies' ? discCount
              : tab === 'photos' ? propertyImages.length
              : 0;
            return (
              <TouchableOpacity
                key={tab}
                style={[styles.toggleBtn, activeView === tab && styles.toggleBtnActive]}
                onPress={() => setActiveView(tab)}
              >
                <Ionicons
                  name={tabIcon}
                  size={14}
                  color={activeView === tab ? colors.white : tab === 'discrepancies' && discCount > 0 ? '#C62828' : colors.primary}
                />
                <Text numberOfLines={1} style={[styles.toggleText, activeView === tab && styles.toggleTextActive,
                  tab === 'discrepancies' && discCount > 0 && activeView !== tab ? { color: '#C62828' } : {}]}>
                  {tabLabel}{badgeCount > 0 ? ` (${badgeCount})` : ''}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* ── APARTMENTS TAB ── */}
        {activeView === 'apartments' ? (
          <>
            {/* Period selector */}
            <View style={{ marginBottom: 14 }}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                {PERIODS.map(p => {
                  const active = occupancyPeriod === p.value;
                  const label = (p.value === 'custom' && active && customFrom)
                    ? `${customFrom} → ${customTo || '…'}`
                    : p.label;
                  return (
                    <TouchableOpacity
                      key={p.value}
                      onPress={() => p.value === 'custom' ? setShowCustomRange(true) : setOccupancyPeriod(p.value)}
                      activeOpacity={0.85}
                      style={{
                        paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
                        borderWidth: 0.5,
                        borderColor: active ? VBRAND.purple : '#EFF6FF',
                        backgroundColor: active ? VBRAND.purple : '#FFFFFF',
                      }}
                    >
                      <Text style={{ fontSize: 11, fontWeight: '800', color: active ? '#fff' : VBRAND.purpleDeep }}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            <View style={styles.sectionHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={styles.sectionTitle}>Apartments</Text>
                <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: '#EFF6FF' }}>
                  <Text style={{ fontSize: 11, fontWeight: '800', color: VBRAND.purpleDeep }}>{filteredApartments.length}</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {/* Live Only toggle */}
                <TouchableOpacity
                  onPress={() => setLiveOnly(v => !v)}
                  activeOpacity={0.85}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 5,
                    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
                    borderWidth: 0.5,
                    borderColor: liveOnly ? '#10B981' : '#EFF6FF',
                    backgroundColor: liveOnly ? 'rgba(16,185,129,0.12)' : '#FFFFFF',
                  }}
                >
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: liveOnly ? '#10B981' : VBRAND.ink400 }} />
                  <Text style={{ fontSize: 11, fontWeight: '800', color: liveOnly ? '#059669' : VBRAND.ink500, letterSpacing: 0.2 }}>Live Only</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.addSmall} onPress={() => setShowAddApt(true)} activeOpacity={0.85}>
                  <Ionicons name="add" size={14} color={VBRAND.purple} />
                  <Text style={{ color: VBRAND.purpleDeep, fontWeight: '800', fontSize: 11, letterSpacing: 0.3 }}>ADD</Text>
                </TouchableOpacity>
              </View>
            </View>

            {filteredApartments.length === 0 ? (
              <EmptyState title="No Apartments" subtitle={search ? 'No matches found' : 'Add apartments to this property'} icon="grid-outline" />
            ) : filteredApartments.map((a: any) => {
              const aptBedList = getAptBeds(a._id);
              const liveBedCt   = aptBedList.filter((b: any) => (b.status || '').toLowerCase() === 'live').length;
              const occupiedCt  = aptBedList.filter((b: any) => b.isOccupied).length;
              const assetsCost  = getAptAssetsCost(a._id);
              const { from: pFrom, to: pTo } = starPeriodRange;
              const aptRev = perfInvoices
                .filter((inv: any) => inv.apartment_id === a._id && inv.billing_month)
                .reduce((s: number, inv: any) => {
                  const d = new Date(inv.billing_month + '-01');
                  return (d >= pFrom && d <= pTo) ? s + Number(inv.total_amount || inv.rent_amount || 0) : s;
                }, 0);
              const starBk = (perfAllotments.length > 0) ? getAptStarBreakdown(a._id) : null;
              const isExpanded = expandedApts.has(a._id);

              return (
                <View key={a._id} style={[styles.card, { padding: 0, overflow: 'hidden' }]}>

                  {/* ── Apartment header row ────────────────────────────── */}
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() => toggleApt(a._id)}
                    style={{ paddingHorizontal: 14, paddingTop: 14 }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      {/* Chevron */}
                      <Ionicons
                        name={isExpanded ? 'chevron-down' : 'chevron-forward'}
                        size={16}
                        color={VBRAND.purple}
                      />

                      {/* Code + Status */}
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <Text style={{ fontSize: 16, fontWeight: '900', color: VBRAND.ink900, letterSpacing: -0.2 }}>{a.code}</Text>
                          {a.type ? <Text style={{ fontSize: 11, color: VBRAND.ink500, fontWeight: '600' }}>{a.type}</Text> : null}
                          {a.floor ? <Text style={{ fontSize: 11, color: VBRAND.ink400 }}>Fl {a.floor}</Text> : null}
                          {genderBadge(a.label)}
                        </View>
                        {/* Key metrics inline */}
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6 }}>
                          {/* Beds */}
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <Ionicons name="bed-outline" size={12} color={VBRAND.ink400} />
                            <Text style={{ fontSize: 12, fontWeight: '700', color: VBRAND.ink700 }}>
                              {occupiedCt}/{aptBedList.length}
                            </Text>
                          </View>
                          {/* Occupancy bar */}
                          {starBk ? (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                              <View style={{ flex: 1, height: 6, backgroundColor: '#EDE9F5', borderRadius: 99, overflow: 'hidden' }}>
                                <View style={{ height: 6, width: `${starBk.occ}%` as any, backgroundColor: starBk.occ >= 80 ? '#10B981' : starBk.occ >= 50 ? '#F59E0B' : '#EF4444', borderRadius: 99 }} />
                              </View>
                              <Text style={{ fontSize: 13, fontWeight: '900', color: starBk.occ >= 80 ? '#10B981' : starBk.occ >= 50 ? '#F59E0B' : '#EF4444', minWidth: 38, textAlign: 'right' }}>
                                {starBk.occ}%
                              </Text>
                            </View>
                          ) : null}
                        </View>
                      </View>

                      {/* Stars + Status + Menu */}
                      <View style={{ alignItems: 'flex-end', gap: 6 }}>
                        {/* Status badge */}
                        <View style={{ backgroundColor: a.status === 'live' ? 'rgba(16,185,129,0.12)' : 'rgba(107,114,128,0.12)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                          <Text style={{ fontSize: 10, fontWeight: '800', color: a.status === 'live' ? '#059669' : '#6B7280', textTransform: 'capitalize' }}>
                            {(a.status || '').replace('_', '-')}
                          </Text>
                        </View>
                        {/* Star row */}
                        {starBk ? (
                          <View style={{ flexDirection: 'row', gap: 1 }}>
                            {[1,2,3,4,5].map(s => (
                              <Ionicons key={s} name={s <= starBk.stars ? 'star' : 'star-outline'} size={12} color={s <= starBk.stars ? '#F59E0B' : '#D1D5DB'} />
                            ))}
                          </View>
                        ) : null}
                        {/* Action menu */}
                        <TouchableOpacity
                          onPress={() => setAptMenuId(aptMenuId === a._id ? null : a._id)}
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                        >
                          <Ionicons name="ellipsis-horizontal" size={18} color={VBRAND.ink400} />
                        </TouchableOpacity>
                      </View>
                    </View>

                    {/* Inline apt menu */}
                    {aptMenuId === a._id ? (
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, paddingTop: 10, borderTopWidth: 0.5, borderTopColor: '#E5E7EB' }}>
                        <TouchableOpacity
                          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8, backgroundColor: '#EFF6FF', borderRadius: 10 }}
                          onPress={() => {
                            setAptMenuId(null);
                            setEditAptTarget(a);
                            setEditAptForm({
                              ...blankAptForm,
                              apartment_code: a.code,
                              floor_number: a.floor != null ? String(a.floor) : '',
                              apartment_type: a.type || '',
                              gender_allowed: a.label || a.genderAllowed || '',
                              status: a.status || 'live',
                              size_sqft: a.sizeSqft != null ? String(a.sizeSqft) : '',
                              signing_date: a.signing_date || '',
                              start_date: a.start_date || '',
                              end_date: a.end_date || '',
                              eb_card_number: a.eb_card_number || '',
                              eb_consumer_number: a.eb_consumer_number || '',
                              eb_connection_type: a.eb_connection_type || 'LT',
                              property_tax_id: a.property_tax_id || '',
                              property_tax_amount: a.property_tax_amount != null ? String(a.property_tax_amount) : '',
                              water_tax_id: a.water_tax_id || '',
                              water_tax_amount: a.water_tax_amount != null ? String(a.water_tax_amount) : '',
                            });
                            setShowEditApt(true);
                          }}
                        >
                          <Ionicons name="create-outline" size={14} color={VBRAND.purple} />
                          <Text style={{ fontSize: 11, fontWeight: '700', color: VBRAND.purple }}>Edit</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8, backgroundColor: 'rgba(220,38,38,0.08)', borderRadius: 10 }}
                          onPress={() => { setAptMenuId(null); handleDeleteApt(a); }}
                        >
                          <Ionicons name="trash-outline" size={14} color="#DC2626" />
                          <Text style={{ fontSize: 11, fontWeight: '700', color: '#DC2626' }}>Delete</Text>
                        </TouchableOpacity>
                      </View>
                    ) : null}
                  </TouchableOpacity>

                  {/* Summary metrics strip — sibling of the toggle so the Assets
                      tile is its own reliable tap target (not swallowed by toggle). */}
                  <View style={{ paddingHorizontal: 14, paddingBottom: 14 }}>
                    <View style={{ flexDirection: 'row', gap: 0, marginTop: 10, paddingTop: 10, borderTopWidth: 0.5, borderTopColor: '#E5E7EB' }}>
                      {[
                        { lbl: 'Beds', val: `${liveBedCt}/${aptBedList.length}`, color: VBRAND.purple, onPress: undefined as undefined | (() => void) },
                        { lbl: 'Occupied', val: String(occupiedCt), color: '#E65100', onPress: undefined },
                        { lbl: 'Assets', val: `₹${assetsCost > 0 ? (assetsCost/1000).toFixed(0)+'k' : '0'}`, color: '#F59E0B',
                          onPress: () => { setExpandedAssetId(null); setAssetPanelApt(a); } },
                        { lbl: 'Revenue', val: `₹${aptRev > 0 ? (aptRev/1000).toFixed(0)+'k' : '0'}`, color: '#10B981', onPress: undefined },
                      ].map((m, i) => {
                        const Cell: any = m.onPress ? TouchableOpacity : View;
                        return (
                          <Cell key={m.lbl} onPress={m.onPress} activeOpacity={0.7}
                            style={{ flex: 1, alignItems: 'center', borderRightWidth: i < 3 ? 0.5 : 0, borderRightColor: '#E5E7EB' }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                              <Text style={{ fontSize: 13, fontWeight: '900', color: m.color }}>{m.val}</Text>
                              {m.onPress ? <Ionicons name="chevron-forward" size={11} color={m.color} /> : null}
                            </View>
                            <Text style={{ fontSize: 9, color: VBRAND.ink400, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 }}>{m.lbl}</Text>
                          </Cell>
                        );
                      })}
                    </View>
                  </View>

                  {/* ── Expanded: Bed rows (exact web flow) ─────────────── */}
                  {isExpanded && aptBedList.length > 0 && (
                    <View style={{ borderTopWidth: 0.5, borderTopColor: '#E5E7EB' }}>
                      {/* Bed column headers */}
                      <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#EFF6FF' }}>
                        <Text style={{ fontSize: 9, fontWeight: '800', color: VBRAND.ink400, textTransform: 'uppercase', letterSpacing: 0.6, width: 70 }}>Bed</Text>
                        <Text style={{ fontSize: 9, fontWeight: '800', color: VBRAND.ink400, textTransform: 'uppercase', letterSpacing: 0.6, flex: 1 }}>Type</Text>
                        <Text style={{ fontSize: 9, fontWeight: '800', color: VBRAND.ink400, textTransform: 'uppercase', letterSpacing: 0.6, width: 60, textAlign: 'right' }}>Value</Text>
                        <Text style={{ fontSize: 9, fontWeight: '800', color: VBRAND.ink400, textTransform: 'uppercase', letterSpacing: 0.6, width: 60, textAlign: 'right' }}>Rev</Text>
                        <Text style={{ fontSize: 9, fontWeight: '800', color: VBRAND.ink400, textTransform: 'uppercase', letterSpacing: 0.6, width: 56, textAlign: 'right' }}>Status</Text>
                        <Text style={{ fontSize: 9, fontWeight: '800', color: VBRAND.ink400, textTransform: 'uppercase', letterSpacing: 0.6, width: 42, textAlign: 'center' }}>Act.</Text>
                      </View>

                      {aptBedList.map((b: any, bi: number) => {
                        const bedCost = bedCostMap[b._id] || 0;
                        const bedRev  = getBedRevenue(b._id);
                        const isLive  = (b.status || '').toLowerCase() === 'live';
                        return (
                          <View
                            key={b._id}
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              paddingHorizontal: 14,
                              paddingVertical: 10,
                              borderTopWidth: bi > 0 ? 0.5 : 0,
                              borderTopColor: '#E5E7EB',
                              backgroundColor: b.isOccupied ? 'rgba(16,185,129,0.03)' : 'transparent',
                            }}
                          >
                            {/* Bed code */}
                            <View style={{ width: 70 }}>
                              <View style={{ backgroundColor: '#EFF6FF', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, alignSelf: 'flex-start' }}>
                                <Text style={{ fontSize: 11, fontWeight: '800', color: VBRAND.purpleDeep, letterSpacing: 0.3 }}>{b.code}</Text>
                              </View>
                            </View>

                            {/* Type · Toilet */}
                            <Text style={{ flex: 1, fontSize: 11, color: VBRAND.ink600, fontWeight: '500' }} numberOfLines={1}>
                              {b.type ? b.type.charAt(0).toUpperCase() + b.type.slice(1) : '—'}
                              {b.toiletType ? ` · ${b.toiletType.charAt(0).toUpperCase() + b.toiletType.slice(1)}` : ''}
                            </Text>

                            {/* Value */}
                            <Text style={{ fontSize: 11, fontWeight: '700', color: '#F59E0B', width: 60, textAlign: 'right' }}>
                              {bedCost > 0 ? `₹${(bedCost/1000).toFixed(0)}k` : '—'}
                            </Text>

                            {/* Rev */}
                            <Text style={{ fontSize: 11, fontWeight: '700', color: '#10B981', width: 60, textAlign: 'right' }}>
                              {bedRev > 0 ? `₹${(bedRev/1000).toFixed(0)}k` : '—'}
                            </Text>

                            {/* Status */}
                            <View style={{ width: 56, alignItems: 'flex-end' }}>
                              <View style={{ backgroundColor: isLive ? 'rgba(16,185,129,0.12)' : 'rgba(107,114,128,0.12)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                                <Text style={{ fontSize: 9, fontWeight: '800', color: isLive ? '#059669' : '#6B7280' }}>
                                  {isLive ? 'Live' : (b.status || 'Off').replace(/_/g, '-').slice(0,7)}
                                </Text>
                              </View>
                            </View>

                            {/* Actions */}
                            <View style={{ width: 42, flexDirection: 'row', justifyContent: 'flex-end', gap: 2 }}>
                              <TouchableOpacity
                                onPress={() => {
                                  setBedHistoryBed(b);
                                  setBedHistoryLoading(true);
                                  sb.getBedHistory(b._id || b.id)
                                    .then((data: any) => { setBedHistoryData(data); setBedHistoryLoading(false); })
                                    .catch(() => { setBedHistoryData(null); setBedHistoryLoading(false); });
                                }}
                                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                                style={{ padding: 4, borderRadius: 6, backgroundColor: '#EFF6FF' }}
                              >
                                <Ionicons name="time-outline" size={14} color={VBRAND.purple} />
                              </TouchableOpacity>
                              <TouchableOpacity
                                onPress={() => {
                                  Alert.alert(
                                    b.code,
                                    `${b.type} · ${b.toiletType}`,
                                    [
                                      { text: 'Edit Bed', onPress: () => openEditBed(b) },
                                      { text: 'Delete Bed', style: 'destructive', onPress: () => handleDeleteBed(b) },
                                      { text: 'Cancel', style: 'cancel' },
                                    ]
                                  );
                                }}
                                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                                style={{ padding: 4, borderRadius: 6, backgroundColor: '#EFF6FF' }}
                              >
                                <Ionicons name="ellipsis-horizontal" size={14} color={VBRAND.ink500} />
                              </TouchableOpacity>
                            </View>
                          </View>
                        );
                      })}

                      {/* Add bed shortcut */}
                      <TouchableOpacity
                        onPress={() => { setBedAptId(a._id); setShowAddBed(true); }}
                        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderTopWidth: 0.5, borderTopColor: '#E5E7EB', backgroundColor: '#EFF6FF' }}
                        activeOpacity={0.7}
                      >
                        <Ionicons name="add-circle-outline" size={14} color={VBRAND.purple} />
                        <Text style={{ fontSize: 11, fontWeight: '700', color: VBRAND.purple }}>Add Bed to {a.code}</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {isExpanded && aptBedList.length === 0 && (
                    <View style={{ borderTopWidth: 0.5, borderTopColor: '#E5E7EB', padding: 16, alignItems: 'center', flexDirection: 'row', gap: 10 }}>
                      <Text style={{ fontSize: 12, color: VBRAND.ink400, flex: 1 }}>No beds in this apartment yet.</Text>
                      <TouchableOpacity
                        onPress={() => { setBedAptId(a._id); setShowAddBed(true); }}
                        style={{ backgroundColor: VBRAND.purple, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}
                      >
                        <Text style={{ fontSize: 11, fontWeight: '700', color: '#fff' }}>+ Add Bed</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              );
            })}
          </>
        ) : activeView === 'beds' ? (
          /* ── BEDS TAB ── */
          <>
            <View style={styles.sectionHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={styles.sectionTitle}>Beds</Text>
                <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: 'rgba(232,132,26,0.14)' }}>
                  <Text style={{ fontSize: 11, fontWeight: '800', color: VBRAND.orange }}>{filteredBeds.length}</Text>
                </View>
              </View>
              <TouchableOpacity style={styles.addSmall} onPress={() => setShowAddBed(true)} activeOpacity={0.85}>
                <Ionicons name="add" size={14} color={VBRAND.purple} />
                <Text style={{ color: VBRAND.purpleDeep, fontWeight: '800', fontSize: 11, letterSpacing: 0.3 }}>ADD</Text>
              </TouchableOpacity>
            </View>

            {/* ── Beds search + status filter (mirrors web) ──────────────── */}
            <View style={{ marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FFFFFF', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(229,231,235,0.8)', paddingHorizontal: 12, height: 40, marginBottom: 8 }}>
                <Ionicons name="search-outline" size={15} color={colors.textTertiary} />
                <TextInput value={bedSearch} onChangeText={setBedSearch} placeholder="Search beds, apartments…" placeholderTextColor={colors.textTertiary} style={{ flex: 1, fontSize: fontSize.sm, color: colors.text }} />
                {bedSearch.length > 0 && <TouchableOpacity onPress={() => setBedSearch('')}><Ionicons name="close-circle" size={15} color={colors.textTertiary} /></TouchableOpacity>}
              </View>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {(['all', 'staying', 'on-notice', 'booked', 'vacant'] as const).map(f => (
                  <TouchableOpacity key={f} onPress={() => setBedStatusFilter(f as any)} style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 99, borderWidth: 1.5, borderColor: bedStatusFilter === f ? colors.primary : colors.border, backgroundColor: bedStatusFilter === f ? colors.primary : '#FFFFFF' }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: bedStatusFilter === f ? colors.white : colors.primary, textTransform: 'capitalize' }}>{f === 'on-notice' ? 'Notice' : f}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {filteredBeds.filter((b: any) => {
              const matchSearch = !bedSearch || [b.code, b.apartmentName, b.type, b.toiletType, b.tenantName].some(v => v && String(v).toLowerCase().includes(bedSearch.toLowerCase()));
              const bs = String(b.bedStatus || (b.isOccupied ? '' : 'vacant')).toLowerCase();
              const matchStatus = bedStatusFilter === 'all' || bs === bedStatusFilter;
              return matchSearch && matchStatus;
            }).length === 0 ? (
              <EmptyState title="No Beds" subtitle="No beds match your filters" icon="bed-outline" />
            ) : filteredBeds.filter((b: any) => {
              const matchSearch = !bedSearch || [b.code, b.apartmentName, b.type, b.toiletType, b.tenantName].some(v => v && String(v).toLowerCase().includes(bedSearch.toLowerCase()));
              const bs = String(b.bedStatus || (b.isOccupied ? '' : 'vacant')).toLowerCase();
              const matchStatus = bedStatusFilter === 'all' || bs === bedStatusFilter;
              return matchSearch && matchStatus;
            }).map((b: any) => {
              // Compute bed occupancy % from perf data (mirrors web getPropOccupancyStats)
              const aptRecord = perfApartments.find((pa: any) => pa.id === (b.apartmentId || b.apartment_id));
              const inception = getInceptionDate(aptRecord?.start_date, perfProperty?.start_date);
              const today = new Date();
              const totalDays = Math.max(1, Math.floor((today.getTime() - inception.getTime()) / 86400000));
              let occupiedDays = 0;
              perfAllotments.forEach((a: any) => {
                if (a.bed_id !== (b._id || b.id)) return;
                occupiedDays += clampedStayDays(a.onboarding_date, a.actual_exit_date, a.staying_status, inception);
              });
              const bedOccPct = Math.min(100, Math.round((occupiedDays / totalDays) * 100));
              const occColor = getOccupancyColor(bedOccPct);
              return (
              <TouchableOpacity key={b._id} style={styles.card} activeOpacity={0.85} onPress={async () => {
                setBedHistoryBed(b);
                setBedHistoryLoading(true);
                try {
                  const data = await sb.getBedHistory(b._id || b.id);
                  setBedHistoryData(data);
                } catch (_) { setBedHistoryData(null); }
                setBedHistoryLoading(false);
              }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: 4 }}>
                      <View style={styles.codeBadge}><Text style={styles.codeBadgeText}>{b.code}</Text></View>
                      {(() => {
                        const bs = String(b.bedStatus || (b.isOccupied ? 'Occupied' : 'Vacant'));
                        const bsl = bs.toLowerCase();
                        const bsColor = bsl === 'staying' ? colors.success
                          : bsl === 'on-notice' ? colors.warning
                          : bsl === 'booked' ? colors.primary
                          : bsl === 'exited' ? colors.textTertiary
                          : colors.textTertiary; // vacant
                        return <Badge text={bs === 'vacant' ? 'Vacant' : bs} color={bsColor} />;
                      })()}
                    </View>
                    <Text style={styles.cardSub}>{b.apartmentName} · {b.type} · {b.toiletType}</Text>
                    {b.tenantName && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                        <Ionicons name="person-outline" size={12} color={colors.textTertiary} />
                        <Text style={[styles.cardSub, { color: colors.primary }]}>{b.tenantName}</Text>
                      </View>
                    )}
                    {(() => {
                      const directBedCost = bedCostMap[b._id] || 0;
                      if (directBedCost > 0) {
                        return (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                            <Ionicons name="cube-outline" size={12} color={colors.warning} />
                            <Text style={{ fontSize: fontSize.xs, fontWeight: '600', color: colors.warning }}>
                              Asset Cost: ₹{directBedCost.toLocaleString('en-IN')}
                            </Text>
                          </View>
                        );
                      }
                      const aptId = b.apartmentId || b.apartment_id;
                      const aptCost = aptId ? getAptAssetsCost(aptId) : 0;
                      const bedsInApt = aptId ? getAptBeds(aptId).length : 1;
                      const costPerBed = bedsInApt > 0 ? Math.round(aptCost / bedsInApt) : 0;
                      return costPerBed > 0 ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                          <Ionicons name="cube-outline" size={12} color={colors.warning} />
                          <Text style={{ fontSize: fontSize.xs, fontWeight: '600', color: colors.warning }}>
                            Cost Share: ₹{costPerBed.toLocaleString('en-IN')}
                          </Text>
                        </View>
                      ) : null;
                    })()}
                  </View>
                  {/* Right: occupancy % only — rates are in the Rates tab */}
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    {perfAllotments.length > 0 && (
                      <View style={{ alignItems: 'center', width: 56 }}>
                        <View style={{ width: 56, height: 6, backgroundColor: '#EDE9F5', borderRadius: 99, overflow: 'hidden' }}>
                          <View style={{ height: 6, width: `${bedOccPct}%` as any, backgroundColor: occColor, borderRadius: 99 }} />
                        </View>
                        <Text style={{ fontSize: 16, fontWeight: '900', color: occColor, marginTop: 4 }}>{bedOccPct}%</Text>
                        <Text style={{ fontSize: 9, color: colors.textTertiary }}>occ.</Text>
                      </View>
                    )}
                    <View style={{ backgroundColor: b.isOccupied ? 'rgba(230,81,0,0.1)' : 'rgba(46,125,50,0.1)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                      <Text style={{ fontSize: 10, fontWeight: '800', color: b.isOccupied ? '#E65100' : '#2E7D32' }}>
                        {b.isOccupied ? 'Occupied' : 'Vacant'}
                      </Text>
                    </View>
                  </View>
                </View>
                {/* Tap hint */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 6, gap: 4 }}>
                  <Ionicons name="time-outline" size={11} color={colors.textTertiary} />
                  <Text style={{ fontSize: 10, color: colors.textTertiary }}>Tap for bed history</Text>
                </View>
              </TouchableOpacity>
            )})}
          </>

        ) : activeView === 'rates' ? (
          /* ── BED RATES TAB — full CRUD ── */
          <>
            {/* Search + Add */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Bed Rates ({bedRates.length})</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FFFFFF', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(229,231,235,0.8)', paddingHorizontal: 12, height: 40 }}>
                <Ionicons name="search-outline" size={15} color={colors.textTertiary} />
                <TextInput
                  value={rateSearch}
                  onChangeText={setRateSearch}
                  placeholder="Search by bed type…"
                  placeholderTextColor={colors.textTertiary}
                  style={{ flex: 1, fontSize: fontSize.sm, color: colors.text }}
                />
                {rateSearch.length > 0 && (
                  <TouchableOpacity onPress={() => setRateSearch('')}>
                    <Ionicons name="close-circle" size={15} color={colors.textTertiary} />
                  </TouchableOpacity>
                )}
              </View>
            </View>

            {bedRates.length === 0 ? (
              <View style={[styles.card, { alignItems: 'center', paddingVertical: 32 }]}>
                <Ionicons name="cash-outline" size={36} color={VBRAND.purple} style={{ opacity: 0.4 }} />
                <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 10, fontWeight: '600' }}>No rates configured yet</Text>
                <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary, marginTop: 4, textAlign: 'center' }}>Tap + below to add a bed rate for this property</Text>
              </View>
            ) : bedRates
              .filter((r: any) => !rateSearch || (r.bed_type || '').toLowerCase().includes(rateSearch.toLowerCase()) || (r.toilet_type || '').toLowerCase().includes(rateSearch.toLowerCase()))
              .map((r: any) => {
                const today = new Date().toISOString().split('T')[0];
                const isActive = r.from_date <= today && (!r.to_date || r.to_date >= today);
                const fmtD = (d: string | null) => d ? formatDate(d, 'Open') : 'Open';
                return (
                  <View key={r.id} style={[styles.card, { marginBottom: 10 }]}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <View style={{ flex: 1 }}>
                        {/* Bed type + toilet type */}
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                          <View style={styles.rateTag}><Text style={styles.rateTagText}>{r.bed_type || '—'}</Text></View>
                          <View style={styles.rateTag}><Text style={styles.rateTagText}>{r.toilet_type || '—'}</Text></View>
                          <View style={{ backgroundColor: isActive ? 'rgba(46,125,50,0.1)' : 'rgba(107,114,128,0.1)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                            <Text style={{ fontSize: 10, fontWeight: '800', color: isActive ? '#2E7D32' : '#6B7280' }}>
                              {isActive ? 'Active' : 'Inactive'}
                            </Text>
                          </View>
                        </View>
                        {/* Rate */}
                        <Text style={{ fontSize: 22, fontWeight: '900', color: VBRAND.orange, letterSpacing: -0.5 }}>
                          ₹{Number(r.monthly_rate || 0).toLocaleString('en-IN')}
                          <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textTertiary }}>/month</Text>
                        </Text>
                        {/* Dates */}
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
                          <Ionicons name="calendar-outline" size={12} color={colors.textTertiary} />
                          <Text style={{ fontSize: 11, color: colors.textTertiary, fontWeight: '500' }}>
                            {fmtD(r.from_date)} → {fmtD(r.to_date)}
                          </Text>
                        </View>
                      </View>
                      {/* Edit / Delete actions */}
                      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                        <TouchableOpacity
                          onPress={() => openEditRate(r)}
                          style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Ionicons name="create-outline" size={17} color={VBRAND.purple} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleDeleteRate(r)}
                          style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: 'rgba(220,38,38,0.08)', alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Ionicons name="trash-outline" size={17} color="#DC2626" />
                        </TouchableOpacity>
                      </View>
                    </View>
                  </View>
                );
              })}
          </>
        ) : activeView === 'discrepancies' ? (
          <DiscrepanciesTab discrepancies={discrepancies} colors={colors} fontSize={fontSize} spacing={spacing} styles={styles} beds={beds} />
        ) : activeView === 'photos' ? (
          /* ── PHOTOS TAB ── */
          <>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Property Photos ({propertyImages.length})</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity
                  style={styles.addSmall}
                  onPress={handlePickAndUploadPhoto}
                  disabled={photoLoading}
                  activeOpacity={0.85}
                >
                  <Ionicons name="cloud-upload-outline" size={14} color={VBRAND.purple} />
                  <Text style={{ color: VBRAND.purpleDeep, fontWeight: '800', fontSize: 11, letterSpacing: 0.3 }}>{photoLoading ? '…' : 'UPLOAD'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.addSmall}
                  onPress={() => setShowPhotoAdd(true)}
                  activeOpacity={0.85}
                >
                  <Ionicons name="link-outline" size={14} color={VBRAND.purple} />
                  <Text style={{ color: VBRAND.purpleDeep, fontWeight: '800', fontSize: 11, letterSpacing: 0.3 }}>URL</Text>
                </TouchableOpacity>
              </View>
            </View>

            {propertyImages.length === 0 ? (
              <View style={[styles.card, { alignItems: 'center', paddingVertical: 36 }]}>
                <View style={{ width: 64, height: 64, borderRadius: 14, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                  <Ionicons name="images-outline" size={28} color={VBRAND.purple} />
                </View>
                <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: '#111827', marginBottom: 4 }}>No photos yet</Text>
                <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, textAlign: 'center', marginBottom: 16 }}>
                  Add photos to showcase this property
                </Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity
                    onPress={handlePickAndUploadPhoto}
                    disabled={photoLoading}
                    style={{ backgroundColor: VBRAND.purple, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 10 }}
                  >
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>{photoLoading ? 'Uploading…' : '+ Upload Photo'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setShowPhotoAdd(true)}
                    style={{ backgroundColor: '#EFF6FF', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 }}
                  >
                    <Text style={{ color: VBRAND.purpleDeep, fontWeight: '700', fontSize: 13 }}>From URL</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                {propertyImages.map((img: any) => (
                  <View
                    key={img.id}
                    style={{
                      width: '47%', flexGrow: 1,
                      backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 14,
                      overflow: 'hidden', borderWidth: 0.5, borderColor: '#E5E7EB',
                      shadowColor: '#0F172A', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
                    }}
                  >
                    {/* Cover badge */}
                    {img.is_cover && (
                      <View style={{ position: 'absolute', top: 8, left: 8, zIndex: 10, backgroundColor: '#F59E0B', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Ionicons name="star" size={10} color="#fff" />
                        <Text style={{ fontSize: 9, fontWeight: '800', color: '#fff' }}>Cover</Text>
                      </View>
                    )}
                    {/* Actual property image */}
                    {img.image_url ? (
                      <Image
                        source={{ uri: img.image_url }}
                        style={{ width: '100%', aspectRatio: 1, backgroundColor: '#EFF6FF' }}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={{ width: '100%', aspectRatio: 1, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center', padding: 10 }}>
                        <Ionicons name="image-outline" size={32} color={VBRAND.purple} style={{ opacity: 0.4 }} />
                      </View>
                    )}
                    {/* Caption */}
                    {img.caption ? (
                      <Text style={{ fontSize: 11, color: '#111827', fontWeight: '500', padding: 8, paddingBottom: 4 }} numberOfLines={1}>{img.caption}</Text>
                    ) : null}
                    {/* Actions */}
                    <View style={{ flexDirection: 'row', borderTopWidth: 0.5, borderTopColor: '#E5E7EB' }}>
                      {!img.is_cover && (
                        <TouchableOpacity
                          onPress={() => handleSetCover(img.id)}
                          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8, borderRightWidth: 0.5, borderRightColor: '#E5E7EB' }}
                        >
                          <Ionicons name="star-outline" size={13} color="#F59E0B" />
                          <Text style={{ fontSize: 10, fontWeight: '700', color: '#F59E0B' }}>Cover</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity
                        onPress={() => handleDeletePhoto(img.id)}
                        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8 }}
                      >
                        <Ionicons name="trash-outline" size={13} color="#DC2626" />
                        <Text style={{ fontSize: 10, fontWeight: '700', color: '#DC2626' }}>Delete</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </>
        ) : null}
      </ScrollView>

      {/* FAB for rates tab */}
      {activeView === 'rates' && (
        <TouchableOpacity
          activeOpacity={0.88}
          onPress={() => setShowRateModal(true)}
          style={{
            position: 'absolute', bottom: 24, right: 20, width: 60, height: 60, borderRadius: 30,
            shadowColor: VBRAND.purple, shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 12,
          }}
        >
          <LinearGradient
            colors={[VBRAND.purpleDeep, VBRAND.purple]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' }}
          >
            <Ionicons name="add" size={28} color="#fff" />
          </LinearGradient>
        </TouchableOpacity>
      )}

      {/* Add Apartment Modal replaced by full-form version below — see FULL ADD APARTMENT MODAL */}

      {/* Add Bed Modal */}
      <Modal visible={showAddBed} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setShowAddBed(false)}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Add Bed</Text>
            <View style={{ width: 50 }} />
          </View>
          <ScrollView style={{ padding: spacing.xl }}>
            <PickerSelect label="Apartment *" value={bedAptId} options={aptOptions} onSelect={setBedAptId} />
            <Input
              label="Unit Number *"
              value={bedRent}
              onChangeText={setBedRent}
              placeholder="e.g. B1, Unit 201, Room 5"
            />
            <PickerSelect label="Bed Type" value={bedType} options={BED_TYPES} onSelect={setBedType} />
            <PickerSelect label="Toilet Type" value={bedToilet} options={TOILET_TYPES} onSelect={setBedToilet} />
            <PickerSelect label="Status" value={bedStatus} options={STATUS_OPTS} onSelect={setBedStatus} />
            <Button title="Create Bed" onPress={handleAddBed} loading={loading} />
          </ScrollView>
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* Update Rate Modal */}
      <Modal visible={showRateModal} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setShowRateModal(false)}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Add Bed Rate</Text>
            <View style={{ width: 50 }} />
          </View>
          <ScrollView style={{ padding: spacing.xl }}>
            <PickerSelect label="Select Bed" value={rateBedId} options={bedPickerOptions} onSelect={setRateBedId} />
            <Input label="Monthly Rate (₹)" value={rateAmount} onChangeText={setRateAmount} placeholder="0" keyboardType="numeric" />
            <View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#6B7280', marginBottom: 6 }}>From Date</Text><DateField value={rateDate} onChange={setRateDate} /></View>
            <View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#6B7280', marginBottom: 6 }}>To Date</Text><DateField value={rateToDate} onChange={setRateToDate} /></View>
            <Button title="Save Rate" onPress={handleUpdateRate} loading={loading} />
          </ScrollView>
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* ── BED HISTORY MODAL (mirrors web BedHistoryDialog) ───────────────── */}
      <Modal visible={!!bedHistoryBed} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { setBedHistoryBed(null); setBedHistoryData(null); }}>
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => { setBedHistoryBed(null); setBedHistoryData(null); }}>
              <Text style={styles.modalCancel}>Close</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>
              {bedHistoryBed?.apartmentName}-{bedHistoryBed?.code} — History
            </Text>
            <View style={{ width: 50 }} />
          </View>
          <ScrollView style={{ padding: spacing.xl }}>
            {bedHistoryLoading ? (
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <LoadingScreen />
              </View>
            ) : !bedHistoryData ? (
              <EmptyState title="No History" subtitle="No allotment data found for this bed" icon="bed-outline" />
            ) : (() => {
              const aptRecord = perfApartments.find((pa: any) => pa.id === (bedHistoryBed?.apartmentId || bedHistoryBed?.apartment_id));
              const inception = getInceptionDate(aptRecord?.start_date, perfProperty?.start_date);
              const today = new Date();
              const revenueByTenant: Record<string, number> = {};
              (bedHistoryData.invoices || []).forEach((inv: any) => {
                revenueByTenant[inv.tenant_id] = (revenueByTenant[inv.tenant_id] || 0) + (inv.amount_paid || 0);
              });
              const rows = (bedHistoryData.allotments || []).map((a: any) => ({
                ...a,
                stayDays: clampedStayDays(a.onboarding_date, a.actual_exit_date, a.staying_status, inception),
                revenue: revenueByTenant[a.tenant_id] || 0,
              }));
              const totalDays = Math.max(1, Math.floor((today.getTime() - inception.getTime()) / 86400000));
              const totalOccupied = rows.reduce((s: number, r: any) => s + r.stayDays, 0);
              const overallPct = Math.min(100, Math.round((totalOccupied / totalDays) * 100));
              const totalRevenue = rows.reduce((s: number, r: any) => s + r.revenue, 0);
              const occColor = getOccupancyColor(overallPct);
              const fmtD = (d: string | null) => formatDate(d, '—');
              const statusColor = (s: string) => s === 'Staying' ? '#2E7D32' : s === 'On-Notice' ? '#E65100' : s === 'Exited' ? '#C62828' : s === 'Booked' ? '#1565C0' : '#9CA3AF';

              return (
                <>
                  {/* Summary stats */}
                  <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                    <View style={{ flex: 1, backgroundColor: '#F0EBF8', borderRadius: 12, padding: 12, alignItems: 'center' }}>
                      <View style={{ width: 44, height: 44, borderRadius: 99, backgroundColor: '#EDE9F5', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
                        <Text style={{ fontSize: 18, fontWeight: '900', color: occColor }}>{overallPct}%</Text>
                      </View>
                      <View style={{ width: '100%', height: 6, backgroundColor: '#D8CCF0', borderRadius: 99, overflow: 'hidden', marginBottom: 4 }}>
                        <View style={{ height: 6, width: `${overallPct}%` as any, backgroundColor: occColor, borderRadius: 99 }} />
                      </View>
                      <Text style={{ fontSize: 10, color: '#2563EB', fontWeight: '700' }}>Overall Occupancy</Text>
                      <Text style={{ fontSize: 9, color: colors.textTertiary }}>{totalOccupied} / {totalDays} days</Text>
                    </View>
                    <View style={{ flex: 1, gap: 8 }}>
                      <View style={{ backgroundColor: '#E8F5E9', borderRadius: 10, padding: 10, alignItems: 'center' }}>
                        <Text style={{ fontSize: 16, fontWeight: '800', color: '#2E7D32' }}>{rows.length}</Text>
                        <Text style={{ fontSize: 9, color: '#2E7D32', fontWeight: '600' }}>Total Tenants</Text>
                      </View>
                      <View style={{ backgroundColor: '#E3F2FD', borderRadius: 10, padding: 10, alignItems: 'center' }}>
                        <Text style={{ fontSize: 14, fontWeight: '800', color: '#1565C0' }}>₹{totalRevenue.toLocaleString('en-IN')}</Text>
                        <Text style={{ fontSize: 9, color: '#1565C0', fontWeight: '600' }}>Total Revenue</Text>
                      </View>
                    </View>
                  </View>

                  {/* Allotment history table */}
                  {rows.length === 0 ? (
                    <View style={{ backgroundColor: '#F0FDF4', borderRadius: 12, padding: 20, alignItems: 'center' }}>
                      <Text style={{ fontSize: fontSize.sm, color: '#2E7D32' }}>No tenants allotted yet.</Text>
                    </View>
                  ) : rows.map((a: any, idx: number) => (
                    <View key={a.id} style={{ backgroundColor: '#FFFFFF', borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#E5E7EB' }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <View style={{ width: 24, height: 24, borderRadius: 99, backgroundColor: '#EDE9F5', alignItems: 'center', justifyContent: 'center' }}>
                            <Text style={{ fontSize: 11, fontWeight: '700', color: '#2563EB' }}>{idx + 1}</Text>
                          </View>
                          <View>
                            <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#111827' }}>{a.tenants?.full_name || '—'}</Text>
                            {a.tenants?.phone ? <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary }}>{a.tenants.phone}</Text> : null}
                          </View>
                        </View>
                        <View style={{ backgroundColor: statusColor(a.staying_status) + '20', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: statusColor(a.staying_status) + '40' }}>
                          <Text style={{ fontSize: 10, fontWeight: '700', color: statusColor(a.staying_status) }}>{a.staying_status || '—'}</Text>
                        </View>
                      </View>
                      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
                        <View><Text style={{ fontSize: 9, color: colors.textTertiary, textTransform: 'uppercase', fontWeight: '600' }}>Onboarded</Text><Text style={{ fontSize: fontSize.xs, fontWeight: '600', color: '#111827' }}>{fmtD(a.onboarding_date)}</Text></View>
                        <View><Text style={{ fontSize: 9, color: colors.textTertiary, textTransform: 'uppercase', fontWeight: '600' }}>Exit</Text><Text style={{ fontSize: fontSize.xs, fontWeight: '600', color: '#111827' }}>{fmtD(a.actual_exit_date)}</Text></View>
                        <View><Text style={{ fontSize: 9, color: colors.textTertiary, textTransform: 'uppercase', fontWeight: '600' }}>Stay Days</Text><Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#2563EB' }}>{a.stayDays}</Text></View>
                        <View><Text style={{ fontSize: 9, color: colors.textTertiary, textTransform: 'uppercase', fontWeight: '600' }}>Revenue</Text><Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#2E7D32' }}>₹{a.revenue.toLocaleString('en-IN')}</Text></View>
                      </View>
                    </View>
                  ))}
                </>
              );
            })()}
          </ScrollView>
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* ── ANALYTICS MODAL ─────────────────────────────────────────────────── */}
      <Modal visible={showAnalytics} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowAnalytics(false)}>
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          {/* Header */}
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setShowAnalytics(false)}>
              <Text style={styles.modalCancel}>Close</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>{propertyName} — Analytics</Text>
            <View style={{ width: 50 }} />
          </View>

          <ScrollView style={{ padding: spacing.xl }} showsVerticalScrollIndicator={false}>

            {/* ── Period selector ──────────────────────────────────────────── */}
            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 10, color: '#9CA3AF', fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
                Reporting Period
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                {[
                  { value: 'current_fy',    label: 'Current FY' },
                  { value: 'last_fy',       label: 'Last FY'    },
                  { value: 'last_2fy',      label: 'Last 2 FY'  },
                  { value: 'last_5y',       label: '5 Years'    },
                  { value: 'from_beginning',label: 'All Time'   },
                ].map(opt => (
                  <TouchableOpacity
                    key={opt.value}
                    onPress={() => setOccupancyPeriod(opt.value)}
                    style={{
                      paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999,
                      backgroundColor: occupancyPeriod === opt.value ? '#2563EB' : '#FFFFFF',
                      borderWidth: 1,
                      borderColor: occupancyPeriod === opt.value ? '#2563EB' : '#EFF6FF',
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '700', color: occupancyPeriod === opt.value ? '#fff' : '#2563EB' }}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            {/* ── KPI grid ─────────────────────────────────────────────────── */}
            {(() => {
              const liveBedCount  = (beds || []).filter((b: any) => (b.status || '').toLowerCase() === 'live').length;
              const totalBedCount = (beds || []).length;
              const aptCount      = (apartments || []).length;
              const occupiedBeds  = (beds || []).filter((b: any) => b.isOccupied).length;
              const activeTenants = perfAllotments.filter((a: any) => ['Staying','On-Notice','Booked'].includes(a.staying_status)).length;
              const occRate       = liveBedCount > 0 ? Math.round((occupiedBeds / liveBedCount) * 100) : 0;
              // Period-filtered revenue
              const { from, to } = starPeriodRange;
              const periodRevenue = perfInvoices.reduce((s: number, inv: any) => {
                if (!inv.billing_month) return s;
                const d = new Date(inv.billing_month + '-01');
                return (d >= from && d <= to) ? s + Number(inv.total_amount || inv.rent_amount || 0) : s;
              }, 0);
              const avgPerBed = liveBedCount > 0 ? Math.round(periodRevenue / Math.max(1, liveBedCount)) : 0;
              const KPIs = [
                { label: 'Apartments',      value: String(aptCount),                              icon: 'grid-outline',       color: '#2563EB', bg: '#F3E5F5' },
                { label: 'Live / Total',    value: `${liveBedCount}/${totalBedCount}`,            icon: 'bed-outline',        color: '#2E7D32', bg: '#E8F5E9' },
                { label: 'Active Tenants',  value: String(activeTenants),                        icon: 'people-outline',     color: '#1565C0', bg: '#E3F2FD' },
                { label: 'Occupancy',       value: `${occRate}%`,                                icon: 'stats-chart-outline',color: '#E65100', bg: '#FFF3E0' },
                { label: 'Period Revenue',  value: `₹${periodRevenue.toLocaleString('en-IN')}`,  icon: 'cash-outline',       color: '#2E7D32', bg: '#E8F5E9' },
                { label: 'Avg Rev / Bed',   value: `₹${avgPerBed.toLocaleString('en-IN')}`,      icon: 'trending-up-outline',color: '#2563EB', bg: '#F3E5F5' },
              ];
              return (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                  {KPIs.map(k => (
                    <View key={k.label} style={{
                      width: '47%', flexGrow: 1,
                      backgroundColor: k.bg, borderRadius: 16, padding: 14,
                      borderWidth: 0.5, borderColor: k.color + '30',
                    }}>
                      <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: k.color + '20', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
                        <Ionicons name={k.icon as any} size={18} color={k.color} />
                      </View>
                      <Text style={{ fontSize: 20, fontWeight: '900', color: k.color, letterSpacing: -0.5 }}>{k.value}</Text>
                      <Text style={{ fontSize: 10, color: k.color, fontWeight: '700', marginTop: 3, textTransform: 'uppercase', letterSpacing: 0.3 }}>{k.label}</Text>
                    </View>
                  ))}
                </View>
              );
            })()}

            {/* ── Apartments summary ───────────────────────────────────────── */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: colors.text, letterSpacing: -0.2 }}>
                Apartments Summary
              </Text>
              <Text style={{ fontSize: 11, fontWeight: '600', color: '#9CA3AF' }}>
                {(apartments || []).length} total
              </Text>
            </View>

            {(apartments || []).length === 0 ? (
              <View style={{ backgroundColor: '#FFFFFF', borderRadius: 12, padding: 20, alignItems: 'center' }}>
                <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary }}>No apartments yet.</Text>
              </View>
            ) : (apartments || []).map((a: any) => {
              const aptBedList = getAptBeds(a._id);
              const liveBeds   = aptBedList.filter((b: any) => (b.status || '').toLowerCase() === 'live');
              const occupied   = aptBedList.filter((b: any) => b.isOccupied);
              const { from, to } = starPeriodRange;
              const aptRevenue = perfInvoices
                .filter((inv: any) => inv.apartment_id === a._id && inv.billing_month)
                .reduce((s: number, inv: any) => {
                  const d = new Date(inv.billing_month + '-01');
                  return (d >= from && d <= to) ? s + Number(inv.total_amount || inv.rent_amount || 0) : s;
                }, 0);
              const starBk  = perfAllotments.length > 0 ? getAptStarBreakdown(a._id) : null;
              const occPct  = starBk ? starBk.occ : 0;
              const occColor = getOccupancyColor(occPct);
              const aptActiveTenants = perfAllotments.filter((al: any) =>
                aptBedList.some((b: any) => b._id === al.bed_id) &&
                ['Staying','On-Notice','Booked'].includes(al.staying_status)
              ).length;
              return (
                <View key={a._id} style={{
                  backgroundColor: '#FFFFFF', borderRadius: 16, padding: 14,
                  marginBottom: 10, borderWidth: 0.5, borderColor: '#E5E7EB',
                  shadowColor: '#0F172A', shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
                }}>
                  {/* Top row */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                        <Text style={{ fontSize: 16, fontWeight: '800', color: '#111827' }}>{a.code}</Text>
                        {genderBadge(a.label)}
                      </View>
                      <Text style={{ fontSize: 11, color: '#9CA3AF', fontWeight: '500' }}>
                        {[a.type, a.floor ? `Fl ${a.floor}` : null].filter(Boolean).join(' · ') || 'No details'}
                      </Text>
                    </View>
                    {/* Stars */}
                    {starBk ? (
                      <View style={{ alignItems: 'flex-end', gap: 2 }}>
                        <View style={{ flexDirection: 'row', gap: 2 }}>
                          {[1,2,3,4,5].map(s => (
                            <Ionicons key={s} name={s <= starBk.stars ? 'star' : 'star-outline'} size={14} color={s <= starBk.stars ? '#F59E0B' : '#D1D5DB'} />
                          ))}
                        </View>
                        <Text style={{ fontSize: 9, color: '#9CA3AF', fontWeight: '600' }}>{starBk.composite.toFixed(0)}% score</Text>
                      </View>
                    ) : null}
                  </View>

                  {/* Metrics row */}
                  <View style={{ flexDirection: 'row', gap: 0, borderTopWidth: 0.5, borderTopColor: '#E5E7EB', paddingTop: 10 }}>
                    {[
                      { lbl: 'Beds', val: `${liveBeds.length}/${aptBedList.length}`, color: '#2563EB' },
                      { lbl: 'Occupied', val: String(occupied.length), color: '#E65100' },
                      { lbl: 'Tenants', val: String(aptActiveTenants), color: '#1565C0' },
                      { lbl: 'Revenue', val: aptRevenue > 0 ? `₹${(aptRevenue/1000).toFixed(0)}k` : '₹0', color: '#2E7D32' },
                    ].map((m, i) => (
                      <View key={m.lbl} style={{ flex: 1, alignItems: 'center', borderRightWidth: i < 3 ? 0.5 : 0, borderRightColor: '#E5E7EB' }}>
                        <Text style={{ fontSize: 14, fontWeight: '800', color: m.color }}>{m.val}</Text>
                        <Text style={{ fontSize: 9, color: '#9CA3AF', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.3 }}>{m.lbl}</Text>
                      </View>
                    ))}
                  </View>

                  {/* Occupancy bar */}
                  {starBk ? (
                    <View style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={{ flex: 1, height: 6, backgroundColor: '#EDE9F5', borderRadius: 99, overflow: 'hidden' }}>
                        <View style={{ height: 6, width: `${occPct}%` as any, backgroundColor: occColor, borderRadius: 99 }} />
                      </View>
                      <Text style={{ fontSize: 12, fontWeight: '800', color: occColor, minWidth: 36, textAlign: 'right' }}>{occPct}%</Text>
                    </View>
                  ) : null}
                </View>
              );
            })}

            <View style={{ height: 40 }} />
          </ScrollView>
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* ── KYC QR MODAL ─────────────────────────────────────────────────────── */}
      <Modal visible={kycQrOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setKycQrOpen(false)}>
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          {/* Header with gradient */}
          <LinearGradient
            colors={['#1D4ED8', '#2563EB']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 20 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 10, color: '#FFFFFF', fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 4 }}>
                  KYC Registration
                </Text>
                <Text style={{ fontSize: 20, fontWeight: '900', color: '#fff', letterSpacing: -0.4 }} numberOfLines={1}>
                  {propertyName}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setKycQrOpen(false)}
                style={{ width: 36, height: 36, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' }}
              >
                <Ionicons name="close" size={20} color="#fff" />
              </TouchableOpacity>
            </View>
          </LinearGradient>

          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
            {(() => {
              const kycQrCode = perfProperty?.kyc_qr_code;
              const appBaseUrl = 'https://app.vishful.in';
              const kycUrl = kycQrCode ? `${appBaseUrl}/kyc?qr=${encodeURIComponent(kycQrCode)}` : '';

              if (!kycQrCode) {
                return (
                  <View style={{ alignItems: 'center', paddingVertical: 40, gap: 16 }}>
                    <View style={{ width: 80, height: 80, borderRadius: 24, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#E5E7EB' }}>
                      <Ionicons name="qr-code-outline" size={36} color="#6366F1" />
                    </View>
                    <Text style={{ fontSize: 16, fontWeight: '800', color: '#111827', textAlign: 'center' }}>
                      No KYC QR Issued Yet
                    </Text>
                    <Text style={{ fontSize: 13, color: '#9CA3AF', textAlign: 'center', lineHeight: 20, paddingHorizontal: 16 }}>
                      {"Generate a KYC QR code from the web app dashboard.\nGo to Properties > select this property > tap KYC QR."}
                    </Text>
                    <View style={{ backgroundColor: '#EFF6FF', borderRadius: 14, padding: 14, width: '100%', borderWidth: 1, borderColor: '#E5E7EB' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Ionicons name="information-circle-outline" size={16} color="#6366F1" />
                        <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>How it works</Text>
                      </View>
                      <Text style={{ fontSize: 11, color: '#6B7280', marginTop: 6, lineHeight: 18 }}>
                        The KYC QR links tenants to a secure registration form. Once issued via the web app, the QR appears here and can be shared or printed.
                      </Text>
                    </View>
                  </View>
                );
              }

              return (
                <>
                  {/* QR Code card */}
                  <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 20, alignItems: 'center', marginBottom: 16, borderWidth: 0.5, borderColor: '#E5E7EB', shadowColor: '#0F172A', shadowOpacity: 0.08, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }}>
                    <QRCodeStyled
                      data={kycUrl}
                      style={{ width: 220, height: 220 }}
                      padding={10}
                      pieceSize={7}
                      color="#111827"
                      outerEyesOptions={{ topLeft: { borderRadius: 12 }, topRight: { borderRadius: 12 }, bottomLeft: { borderRadius: 12 } }}
                      innerEyesOptions={{ borderRadius: 6 }}
                    />
                    <View style={{ marginTop: 12, alignItems: 'center', gap: 2 }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827', letterSpacing: -0.2 }}>{propertyName}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#10B981' }} />
                        <Text style={{ fontSize: 11, fontWeight: '600', color: '#10B981' }}>KYC QR Active</Text>
                      </View>
                    </View>
                  </View>

                  {/* URL display */}
                  <View style={{ backgroundColor: '#FFFFFF', borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 0.5, borderColor: '#E5E7EB' }}>
                    <Text style={{ fontSize: 10, fontWeight: '800', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>
                      KYC Registration URL
                    </Text>
                    <Text style={{ fontSize: 11, color: '#6B7280', lineHeight: 18, fontWeight: '500' }} selectable>
                      {kycUrl}
                    </Text>
                  </View>

                  {/* Action buttons */}
                  <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
                    <TouchableOpacity
                      onPress={async () => {
                        await Clipboard.setStringAsync(kycUrl);
                        Alert.alert('Copied', 'KYC URL copied to clipboard.');
                      }}
                      style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#EFF6FF', borderRadius: 14, paddingVertical: 14, borderWidth: 1, borderColor: '#E5E7EB' }}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="copy-outline" size={18} color="#6366F1" />
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>Copy URL</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={() => Share.share({ message: `KYC Registration — ${propertyName}\n${kycUrl}`, title: `KYC QR — ${propertyName}` })}
                      style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(232,132,26,0.08)', borderRadius: 14, paddingVertical: 14, borderWidth: 1, borderColor: 'rgba(232,132,26,0.25)' }}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="share-outline" size={18} color="#6366F1" />
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>Share</Text>
                    </TouchableOpacity>
                  </View>

                  {/* Open in browser */}
                  <TouchableOpacity
                    onPress={() => Linking.openURL(kycUrl).catch(() => Alert.alert('Error', 'Could not open link'))}
                    activeOpacity={0.88}
                    style={{ borderRadius: 14, overflow: 'hidden' }}
                  >
                    <LinearGradient
                      colors={['#2563EB', '#2563EB']}
                      start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 15 }}
                    >
                      <Ionicons name="open-outline" size={18} color="#fff" />
                      <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff', letterSpacing: 0.2 }}>Open KYC Link</Text>
                    </LinearGradient>
                  </TouchableOpacity>

                  {/* Info note */}
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 14, padding: 12, backgroundColor: '#EFF6FF', borderRadius: 12, borderWidth: 0.5, borderColor: '#E5E7EB' }}>
                    <Ionicons name="shield-checkmark-outline" size={14} color="#6366F1" style={{ marginTop: 1 }} />
                    <Text style={{ flex: 1, fontSize: 11, color: '#9CA3AF', lineHeight: 17, fontWeight: '500' }}>
                      This QR token is static and secure — it does not expose the raw property ID. Rotate the QR from the web app if needed.
                    </Text>
                  </View>
                </>
              );
            })()}
          </ScrollView>
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* ── EDIT RATE MODAL ─────────────────────────────────────────────────── */}
      <Modal visible={showEditRate} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowEditRate(false)}>
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setShowEditRate(false)}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Edit Bed Rate</Text>
            <TouchableOpacity onPress={handleEditRate} disabled={loading}>
              <Text style={[styles.modalCancel, { color: VBRAND.purple, fontWeight: '800' }]}>
                {loading ? 'Saving…' : 'Save'}
              </Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={{ padding: spacing.xl }}>
            <PickerSelect label="Bed Type" value={editRateType} options={BED_TYPES} onSelect={setEditRateType} />
            <PickerSelect label="Toilet Type" value={editRateToilet} options={TOILET_TYPES} onSelect={setEditRateToilet} />
            <Input
              label="Monthly Rate (₹) *"
              value={editRateAmount}
              onChangeText={setEditRateAmount}
              placeholder="e.g. 8000"
              keyboardType="numeric"
            />
            <View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#6B7280', marginBottom: 6 }}>From Date</Text><DateField value={editRateFrom} onChange={setEditRateFrom} /></View>
            <View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#6B7280', marginBottom: 6 }}>To Date</Text><DateField value={editRateTo} onChange={setEditRateTo} /></View>
          </ScrollView>
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* ── ADD PHOTO MODAL ──────────────────────────────────────────────────── */}
      {/* ── PER-APARTMENT ASSETS PANEL (Previous / Now / Future) ─────────────── */}
      <Modal
        visible={!!assetPanelApt}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setAssetPanelApt(null)}
      >
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          {(() => {
            const apt = assetPanelApt;
            if (!apt) return null;
            const nowData = getApartmentAssetsNow(apt);

            const AssetRow = (row: any) => {
              const expanded = expandedAssetId === row.assetId;
              const a = row.asset || {};
              const showShare = row.share != null && row.fullPrice > 0 && Math.round(row.share) !== Math.round(row.fullPrice);
              return (
                <View key={row.assetId} style={{ backgroundColor: VBRAND.surface, borderRadius: 12, borderWidth: 0.5, borderColor: VBRAND.cardBorder, marginBottom: 8, overflow: 'hidden' }}>
                  <TouchableOpacity activeOpacity={0.8} onPress={() => setExpandedAssetId(expanded ? null : row.assetId)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 }}>
                    <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={14} color={VBRAND.purple} />
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <Text style={{ fontWeight: '800', fontSize: 12, color: VBRAND.ink900 }}>{row.code}</Text>
                        <View style={{ backgroundColor: conditionColor(row.condition) + '22', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
                          <Text style={{ fontSize: 9, fontWeight: '800', color: conditionColor(row.condition), textTransform: 'capitalize' }}>{row.condition}</Text>
                        </View>
                      </View>
                      <Text style={{ fontSize: 11, color: VBRAND.ink500, marginTop: 2 }} numberOfLines={1}>
                        {row.typeName}{row.brand ? ` · ${row.brand}` : ''}{row.model ? ` ${row.model}` : ''}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ fontWeight: '800', fontSize: 12, color: VBRAND.ink900 }}>{money(row.share != null ? row.share : row.fullPrice)}</Text>
                      {showShare ? <Text style={{ fontSize: 10, color: VBRAND.ink400 }}>of {money(row.fullPrice)}</Text> : null}
                    </View>
                  </TouchableOpacity>
                  {expanded ? (
                    <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 4, borderTopWidth: 0.5, borderTopColor: '#E5E7EB', paddingTop: 10 }}>
                      {([
                        ['Type', row.typeName],
                        ['Brand / Model', [row.brand, row.model].filter(Boolean).join(' ') || '—'],
                        ['Serial', a.serialNumber || '—'],
                        ['Status', a.status || '—'],
                        ['Purchase date', a.purchaseDate || '—'],
                        ['Purchase price', row.fullPrice ? money(row.fullPrice) : '—'],
                        ['Warranty until', a.warrantyExpiry || '—'],
                        ['Vendor', a.vendorName || a.vendorNameManual || '—'],
                      ] as [string, any][]).map(([k, v]) => (
                        <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                          <Text style={{ fontSize: 11, color: VBRAND.ink400 }}>{k}</Text>
                          <Text style={{ fontSize: 11, color: VBRAND.ink700, fontWeight: '600', maxWidth: '62%', textAlign: 'right' }} numberOfLines={1}>{String(v)}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            };

            const empty = (icon: any, title: string, sub: string) => (
              <View style={{ alignItems: 'center', paddingVertical: 48 }}>
                <View style={{ width: 56, height: 56, borderRadius: 14, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                  <Ionicons name={icon} size={26} color={VBRAND.purple} />
                </View>
                <Text style={{ fontSize: 14, fontWeight: '800', color: VBRAND.ink900 }}>{title}</Text>
                <Text style={{ fontSize: 12, color: VBRAND.ink400, marginTop: 4, textAlign: 'center' }}>{sub}</Text>
              </View>
            );

            return (
              <>
                {/* Header */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 16, backgroundColor: VBRAND.purple }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Ionicons name="cube-outline" size={18} color="#fff" />
                    <Text style={{ fontSize: 16, fontWeight: '900', color: '#fff' }}>Assets — {apt.code}</Text>
                  </View>
                  <TouchableOpacity onPress={() => setAssetPanelApt(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close" size={22} color="#fff" />
                  </TouchableOpacity>
                </View>

                {/* Total value */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: '#E5E7EB' }}>
                  <View>
                    <Text style={{ fontSize: 12, fontWeight: '800', color: VBRAND.ink700, textTransform: 'uppercase', letterSpacing: 0.4 }}>Total Asset Value</Text>
                    <Text style={{ fontSize: 11, color: VBRAND.ink400, marginTop: 2 }}>{nowData.count} assets</Text>
                  </View>
                  <Text style={{ fontSize: 18, fontWeight: '900', color: VBRAND.purpleDeep }}>{money(nowData.total)}</Text>
                </View>

                {/* Content — current assets in this apartment */}
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
                  {nowData.rows.length ? nowData.rows.map(AssetRow) : empty('cube-outline', 'No assets', 'No assets are currently allocated to this apartment.')}
                </ScrollView>
              </>
            );
          })()}
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* ── CUSTOM REPORTING-PERIOD RANGE ────────────────────────────────────── */}
      <Modal visible={showCustomRange} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowCustomRange(false)}>
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setShowCustomRange(false)}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Custom Range</Text>
            <View style={{ width: 50 }} />
          </View>
          <ScrollView style={{ padding: spacing.xl }}>
            <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, marginBottom: 16, lineHeight: 18 }}>
              Pick a start and end date. Revenue, occupancy and asset figures will use this range.
            </Text>
            <Input label="From (YYYY-MM-DD)" value={customFrom} onChangeText={setCustomFrom} placeholder="2024-04-01" />
            <Input label="To (YYYY-MM-DD)" value={customTo} onChangeText={setCustomTo} placeholder="2025-03-31" />
            <Button
              title="Apply Range"
              onPress={() => {
                if (!customFrom.trim() || !customTo.trim()) { Alert.alert('Required', 'Enter both start and end dates.'); return; }
                if (isNaN(new Date(customFrom).getTime()) || isNaN(new Date(customTo).getTime())) { Alert.alert('Invalid', 'Use YYYY-MM-DD format.'); return; }
                if (new Date(customFrom) > new Date(customTo)) { Alert.alert('Invalid', 'Start date must be on or before end date.'); return; }
                setOccupancyPeriod('custom');
                setShowCustomRange(false);
              }}
              disabled={!customFrom.trim() || !customTo.trim()}
            />
          </ScrollView>
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      <Modal visible={showPhotoAdd} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowPhotoAdd(false)}>
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setShowPhotoAdd(false)}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Add Photo</Text>
            <View style={{ width: 50 }} />
          </View>
          <ScrollView style={{ padding: spacing.xl }}>
            <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, marginBottom: 16, lineHeight: 18 }}>
              Paste a public image URL (JPG, PNG, WEBP). The image will be stored in the property gallery.
            </Text>
            <Input
              label="Image URL *"
              value={photoUrl}
              onChangeText={setPhotoUrl}
              placeholder="https://example.com/photo.jpg"
            />
            <Input
              label="Caption (optional)"
              value={photoCaption}
              onChangeText={setPhotoCaption}
              placeholder="e.g. Living room, Rooftop view"
            />
            {/* Format badges */}
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 20, marginTop: 4 }}>
              {['JPG', 'PNG', 'WEBP'].map(fmt => (
                <View key={fmt} style={{ backgroundColor: '#EFF6FF', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: VBRAND.purple }}>{fmt}</Text>
                </View>
              ))}
            </View>
            <Button title={photoLoading ? 'Adding…' : 'Add Photo'} onPress={handleAddPhoto} loading={photoLoading} disabled={!photoUrl.trim()} />
          </ScrollView>
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* ── EDIT BED MODAL ──────────────────────────────────────────────────── */}
      <Modal visible={showEditBed} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowEditBed(false)}>
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setShowEditBed(false)}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Edit Bed — {editBedTarget?.code}</Text>
            <TouchableOpacity onPress={handleEditBed} disabled={loading}>
              <Text style={[styles.modalCancel, { color: VBRAND.purple, fontWeight: '800' }]}>
                {loading ? '…' : 'Save'}
              </Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={{ padding: spacing.xl }}>
            <PickerSelect label="Bed Type" value={editBedType} options={BED_TYPES} onSelect={setEditBedType} />
            <PickerSelect label="Toilet Type" value={editBedToilet} options={TOILET_TYPES} onSelect={setEditBedToilet} />
            <PickerSelect label="Status" value={editBedStatus} options={STATUS_OPTS} onSelect={setEditBedStatus} />
          </ScrollView>
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* ── EDIT APARTMENT MODAL ─────────────────────────────────────────────── */}
      <Modal visible={showEditApt} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowEditApt(false)}>
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setShowEditApt(false)}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Edit Apartment — {editAptTarget?.code}</Text>
            <TouchableOpacity
              disabled={loading}
              onPress={async () => {
                if (!editAptForm.apartment_code?.trim()) { Alert.alert('Required', 'Apartment code is required'); return; }
                setLoading(true);
                try {
                  await sb.updateApartment(editAptTarget._id, {
                    apartment_code: editAptForm.apartment_code,
                    floor_number: editAptForm.floor_number ? parseInt(editAptForm.floor_number) : null,
                    apartment_type: editAptForm.apartment_type || null,
                    gender_allowed: editAptForm.gender_allowed || null,
                    status: editAptForm.status,
                    size_sqft: editAptForm.size_sqft ? parseFloat(editAptForm.size_sqft) : null,
                    signing_date: editAptForm.signing_date || null,
                    start_date: editAptForm.start_date || null,
                    end_date: editAptForm.end_date || null,
                    eb_card_number: editAptForm.eb_card_number || null,
                    eb_consumer_number: editAptForm.eb_consumer_number || null,
                    eb_connection_type: editAptForm.eb_connection_type || null,
                    property_tax_id: editAptForm.property_tax_id || null,
                    property_tax_amount: editAptForm.property_tax_amount ? parseFloat(editAptForm.property_tax_amount) : null,
                    water_tax_id: editAptForm.water_tax_id || null,
                    water_tax_amount: editAptForm.water_tax_amount ? parseFloat(editAptForm.water_tax_amount) : null,
                  });
                  setShowEditApt(false);
                  setRefreshKey((k: number) => k + 1);
                } catch (e: any) { Alert.alert('Error', e.message); }
                setLoading(false);
              }}
            >
              <Text style={[styles.modalCancel, { color: VBRAND.purple, fontWeight: '800' }]}>
                {loading ? '…' : 'Save'}
              </Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={{ padding: spacing.xl }}>
            <Input label="Apartment Code *" value={editAptForm.apartment_code || ''} onChangeText={v => setEditAptForm({ ...editAptForm, apartment_code: v })} placeholder="e.g. A-101" />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><Input label="Floor" value={editAptForm.floor_number || ''} onChangeText={v => setEditAptForm({ ...editAptForm, floor_number: v })} keyboardType="numeric" placeholder="e.g. 2" /></View>
              <View style={{ flex: 1 }}><Input label="Size (sq.ft)" value={editAptForm.size_sqft || ''} onChangeText={v => setEditAptForm({ ...editAptForm, size_sqft: v })} keyboardType="numeric" placeholder="0" /></View>
            </View>
            <PickerSelect label="Type" value={editAptForm.apartment_type || ''} options={APT_TYPES} onSelect={v => setEditAptForm({ ...editAptForm, apartment_type: v })} />
            <PickerSelect label="Gender" value={editAptForm.gender_allowed || ''} options={GENDER_OPTIONS} onSelect={v => setEditAptForm({ ...editAptForm, gender_allowed: v })} />
            <PickerSelect label="Status" value={editAptForm.status || 'live'} options={STATUS_OPTS} onSelect={v => setEditAptForm({ ...editAptForm, status: v })} />

            <Text style={{ fontSize: 12, fontWeight: '800', color: VBRAND.purple, letterSpacing: 0.5, marginTop: 8, marginBottom: 10, textTransform: 'uppercase' }}>Contract Dates</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#6B7280', marginBottom: 6 }}>Signing Date</Text><DateField value={editAptForm.signing_date || ''} onChange={v => setEditAptForm({ ...editAptForm, signing_date: v })} /></View></View>
              <View style={{ flex: 1 }}><View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#6B7280', marginBottom: 6 }}>Active Date</Text><DateField value={editAptForm.start_date || ''} onChange={v => setEditAptForm({ ...editAptForm, start_date: v })} /></View></View>
              <View style={{ flex: 1 }}><View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#6B7280', marginBottom: 6 }}>End Date</Text><DateField value={editAptForm.end_date || ''} onChange={v => setEditAptForm({ ...editAptForm, end_date: v })} /></View></View>
            </View>

            <Text style={{ fontSize: 12, fontWeight: '800', color: VBRAND.purple, letterSpacing: 0.5, marginTop: 8, marginBottom: 10, textTransform: 'uppercase' }}>EB (Electricity) Details</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><Input label="EB Card Number" value={editAptForm.eb_card_number || ''} onChangeText={v => setEditAptForm({ ...editAptForm, eb_card_number: v })} placeholder="Card No." /></View>
              <View style={{ flex: 1 }}><Input label="Consumer Number" value={editAptForm.eb_consumer_number || ''} onChangeText={v => setEditAptForm({ ...editAptForm, eb_consumer_number: v })} placeholder="Consumer No." /></View>
            </View>
            <PickerSelect label="Connection Type" value={editAptForm.eb_connection_type || ''} options={EB_CONN_TYPES} onSelect={v => setEditAptForm({ ...editAptForm, eb_connection_type: v })} />

            <Text style={{ fontSize: 12, fontWeight: '800', color: VBRAND.purple, letterSpacing: 0.5, marginTop: 8, marginBottom: 10, textTransform: 'uppercase' }}>Tax Details</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><Input label="Property Tax ID" value={editAptForm.property_tax_id || ''} onChangeText={v => setEditAptForm({ ...editAptForm, property_tax_id: v })} /></View>
              <View style={{ flex: 1 }}><Input label="Tax Amount (₹)" value={editAptForm.property_tax_amount || ''} onChangeText={v => setEditAptForm({ ...editAptForm, property_tax_amount: v })} keyboardType="numeric" /></View>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><Input label="Water Tax ID" value={editAptForm.water_tax_id || ''} onChangeText={v => setEditAptForm({ ...editAptForm, water_tax_id: v })} /></View>
              <View style={{ flex: 1 }}><Input label="Water Tax Amount (₹)" value={editAptForm.water_tax_amount || ''} onChangeText={v => setEditAptForm({ ...editAptForm, water_tax_amount: v })} keyboardType="numeric" /></View>
            </View>
            <View style={{ height: 40 }} />
          </ScrollView>
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* ── FULL ADD APARTMENT MODAL (mirrors web renderAptFormFields) ────────── */}
      <Modal visible={showAddApt} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowAddApt(false)}>
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => { setShowAddApt(false); setAptFormFull(blankAptForm); }}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Add Apartment</Text>
            <View style={{ width: 50 }} />
          </View>
          <ScrollView style={{ padding: spacing.xl }}>
            {/* Core fields */}
            <Input label="Apartment Number *" value={aptFormFull.apartment_code} onChangeText={v => setAptFormFull({ ...aptFormFull, apartment_code: v })} placeholder="e.g. A-101" />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><Input label="Floor Number" value={aptFormFull.floor_number} onChangeText={v => setAptFormFull({ ...aptFormFull, floor_number: v })} placeholder="e.g. 2" keyboardType="numeric" /></View>
              <View style={{ flex: 1 }}><Input label="Size (sq.ft)" value={aptFormFull.size_sqft} onChangeText={v => setAptFormFull({ ...aptFormFull, size_sqft: v })} placeholder="0" keyboardType="numeric" /></View>
            </View>
            <PickerSelect label="Apartment Type" value={aptFormFull.apartment_type} options={APT_TYPES} onSelect={v => setAptFormFull({ ...aptFormFull, apartment_type: v })} />
            <PickerSelect label="Gender Allowed" value={aptFormFull.gender_allowed} options={GENDER_OPTIONS} onSelect={v => setAptFormFull({ ...aptFormFull, gender_allowed: v })} />
            <PickerSelect label="Status" value={aptFormFull.status} options={STATUS_OPTS} onSelect={v => setAptFormFull({ ...aptFormFull, status: v })} />
            {/* Dates */}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#6B7280', marginBottom: 6 }}>Signing Date</Text><DateField value={aptFormFull.signing_date} onChange={v => setAptFormFull({ ...aptFormFull, signing_date: v })} /></View></View>
              <View style={{ flex: 1 }}><View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#6B7280', marginBottom: 6 }}>Active Date</Text><DateField value={aptFormFull.start_date} onChange={v => setAptFormFull({ ...aptFormFull, start_date: v })} /></View></View>
              <View style={{ flex: 1 }}><View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#6B7280', marginBottom: 6 }}>End Date</Text><DateField value={aptFormFull.end_date} onChange={v => setAptFormFull({ ...aptFormFull, end_date: v })} /></View></View>
            </View>
            {/* EB Connection */}
            <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1, marginTop: 12, marginBottom: 6 }}>EB Connection Details</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><Input label="EB Card Number" value={aptFormFull.eb_card_number} onChangeText={v => setAptFormFull({ ...aptFormFull, eb_card_number: v })} placeholder="Card No." /></View>
              <View style={{ flex: 1 }}><Input label="Consumer Number" value={aptFormFull.eb_consumer_number} onChangeText={v => setAptFormFull({ ...aptFormFull, eb_consumer_number: v })} placeholder="Consumer No." /></View>
            </View>
            <PickerSelect label="Connection Type" value={aptFormFull.eb_connection_type} options={EB_CONN_TYPES} onSelect={v => setAptFormFull({ ...aptFormFull, eb_connection_type: v })} />
            {/* Tax */}
            <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1, marginTop: 12, marginBottom: 6 }}>Tax &amp; Utilities</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><Input label="Property Tax ID" value={aptFormFull.property_tax_id} onChangeText={v => setAptFormFull({ ...aptFormFull, property_tax_id: v })} /></View>
              <View style={{ flex: 1 }}><Input label="Tax Amount (₹)" value={aptFormFull.property_tax_amount} onChangeText={v => setAptFormFull({ ...aptFormFull, property_tax_amount: v })} keyboardType="numeric" /></View>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><Input label="Water Tax ID" value={aptFormFull.water_tax_id} onChangeText={v => setAptFormFull({ ...aptFormFull, water_tax_id: v })} /></View>
              <View style={{ flex: 1 }}><Input label="Water Tax Amount (₹)" value={aptFormFull.water_tax_amount} onChangeText={v => setAptFormFull({ ...aptFormFull, water_tax_amount: v })} keyboardType="numeric" /></View>
            </View>
            <Button
              title="Create Apartment"
              loading={loading}
              onPress={async () => {
                if (!aptFormFull.apartment_code) { Alert.alert('Required', 'Apartment number is required'); return; }
                setLoading(true);
                try {
                  await sb.createApartmentFull(propertyId, aptFormFull);
                  setShowAddApt(false);
                  setAptFormFull(blankAptForm);
                  setRefreshKey((k: number) => k + 1);
                  Alert.alert('Success', 'Apartment created.');
                } catch (e: any) { Alert.alert('Error', e.message); }
                setLoading(false);
              }}
            />
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
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 18, paddingTop: 8, paddingBottom: 14,
  },
  title: { fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 },
  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 10, paddingHorizontal: 2,
  },
  sectionTitle: {
    fontSize: 12, fontWeight: '800', color: '#9CA3AF',
    letterSpacing: 1, textTransform: 'uppercase',
  },
  addSmall: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    borderWidth: 0.5, borderColor: '#E5E7EB',
  },
  // Unified white panel card
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#0F172A',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  cardCode: { fontSize: 11, fontWeight: '800', color: '#2563EB', marginBottom: 2, letterSpacing: 0.4 },
  cardTitle: { fontSize: 15, fontWeight: '800', color: '#111827', letterSpacing: -0.2 },
  cardSub: { fontSize: 12, fontWeight: '500', color: '#9CA3AF' },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 18, paddingVertical: 14,
    borderBottomWidth: 0.5, borderBottomColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  modalCancel: { fontSize: 14, fontWeight: '600', color: '#9CA3AF' },
  modalTitle: { fontSize: 16, fontWeight: '800', color: '#111827', letterSpacing: -0.2 },
  modalContent: { padding: 18, paddingBottom: 40 },
  // Segmented control
  viewToggle: {
    marginBottom: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 0.5, borderColor: '#E5E7EB',
    shadowColor: '#0F172A', shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
  },
  toggleBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 9, paddingHorizontal: 16, borderRadius: 10,
  },
  toggleBtnActive: {
    backgroundColor: '#EFF6FF',
  },
  toggleText: { fontSize: 12, fontWeight: '700', color: '#6B7280', letterSpacing: 0.2 },
  toggleTextActive: { color: '#1D4ED8' },
  aptMetrics: {
    flexDirection: 'row', gap: 14, marginTop: 12,
    paddingTop: 12, borderTopWidth: 0.5, borderTopColor: '#E5E7EB',
    flexWrap: 'wrap',
  },
  aptMetric: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  aptMetricText: { fontSize: 12, fontWeight: '800', color: '#111827', letterSpacing: -0.1 },
  aptMetricSub: { fontSize: 11, fontWeight: '600', color: '#9CA3AF' },
  // Refined search pill
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#FFFFFF', borderRadius: 999,
    paddingHorizontal: 14, height: 46,
    borderWidth: 1, borderColor: '#E5E7EB',
  },
  searchInput: { flex: 1, fontSize: 14, color: '#111827', height: 46, fontWeight: '500' },
  codeBadge: {
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
    borderWidth: 0.5, borderColor: '#E5E7EB',
  },
  codeBadgeText: { fontSize: 11, fontWeight: '800', color: '#1D4ED8', letterSpacing: 0.4 },
  rateTag: {
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
    borderWidth: 0.5, borderColor: '#E5E7EB',
  },
  rateTagText: { fontSize: 11, fontWeight: '700', color: '#6B7280', textTransform: 'capitalize', letterSpacing: 0.2 },
  fab: {
    position: 'absolute', bottom: 24, right: 20, width: 58, height: 58,
    borderRadius: 29, backgroundColor: '#2563EB',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#0F172A', shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10,
  },
});
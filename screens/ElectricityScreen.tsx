/**
 * ElectricityScreen.tsx
 * Full feature parity with web Electricity page:
 *  - Grouped readings (billing_month × property)
 *  - Expand row → apartment-level detail with trend arrows
 *  - Lock / Unlock readings
 *  - Edit month (bulk edit existing readings)
 *  - Add Reading (bulk entry per apartment)
 *  - EB Rates CRUD
 *  - KPI summary cards
 *
 * Tables used: electricity_readings, eb_rates, apartments, properties
 * No new tables or columns added.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Modal, TextInput,
  Alert, ActivityIndicator, FlatList, RefreshControl, StyleSheet, Image,
  Dimensions, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { DrawerActions, useFocusEffect, useNavigation } from '@react-navigation/native';
import { useAuth } from '../lib/auth';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { LoadingScreen, DateField, IconBtnSolid } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { useMountedRef, isAbortError } from '../lib/safeAsync';
import * as sb from '../lib/supabaseService';
import { fetchBankAccounts } from '../services/ticketService';
import { computeEbSlabBill, EB_DANGER_THRESHOLD } from '../lib/ebSlab';
import { fetchVisibleTabKeys, filterTabs } from '../lib/tabPermissions';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtAmt = (v: number) =>
  `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(v))}`;

const fmtUnits = (v: number) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(v);

function fmtDate(s: string | null | undefined) {
  if (!s) return '—';
  try {
    const d = new Date(s);
    return formatDate(d, '');
  } catch { return s; }
}

/** Last 12 months as "MMM-yy" e.g. "Mar-26" */
function getLast12Months(): string[] {
  const months: string[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(
      d.toLocaleString('en-US', { month: 'short' }) + '-' +
      String(d.getFullYear()).slice(2)
    );
  }
  return months; // most-recent first
}

/** Trend arrow — red up is bad (more units), green down is good */
function TrendArrow({ current, previous }: { current: number; previous: number | null }) {
  if (previous === null || previous === 0) return null;
  const diff = current - previous;
  const pct = Math.round((Math.abs(diff) / previous) * 100);
  if (diff === 0) return <Text style={{ fontSize: 10, color: colors.textTertiary }}> —</Text>;
  if (diff > 0) return <Text style={{ fontSize: 10, color: colors.danger }}> ↑{pct}%</Text>;
  return <Text style={{ fontSize: 10, color: colors.success }}> ↓{pct}%</Text>;
}

// ─── Shared UI ────────────────────────────────────────────────────────────────

function Card({ children, style }: { children: React.ReactNode; style?: any }) {
  return (
    <View style={[S.card, style]}>{children}</View>
  );
}

function SectionLabel({ text }: { text: string }) {
  return (
    <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#2563EB',
      letterSpacing: 1.1, textTransform: 'uppercase', marginBottom: 8, marginTop: 4 }}>
      {text}
    </Text>
  );
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
      <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, flex: 1 }}>{label}</Text>
      <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: valueColor || colors.text, maxWidth: '60%', textAlign: 'right' }}>{value}</Text>
    </View>
  );
}

function Pill({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <View style={{ backgroundColor: bg, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color }}>{label}</Text>
    </View>
  );
}

// ─── TABS ─────────────────────────────────────────────────────────────────────

// ─── DatePickerField ──────────────────────────────────────────────────────────
// Inline date picker — no external library. Shows a calendar modal on tap.
// value: 'YYYY-MM-DD' string | ''    onChange: (v: string) => void
function DatePickerField({ label, value, onChange, required, placeholder }: {
  label: string; value: string; onChange: (v: string) => void;
  required?: boolean; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const today = new Date();
  const [viewYear, setViewYear]   = useState(value ? parseInt(value.slice(0, 4)) : today.getFullYear());
  const [viewMonth, setViewMonth] = useState(value ? parseInt(value.slice(5, 7)) - 1 : today.getMonth());

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DAYS   = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  const getDaysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
  const getFirstDay    = (y: number, m: number) => new Date(y, m, 1).getDay();

  const handleSelect = (day: number) => {
    const mm = String(viewMonth + 1).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    onChange(`${viewYear}-${mm}-${dd}`);
    setOpen(false);
  };

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };

  const fmtDisplay = (v: string) => (v ? formatDate(v, '') : '');

  const days = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDay(viewYear, viewMonth);
  const selectedDay = value && value.slice(0, 7) === `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}`
    ? parseInt(value.slice(8, 10)) : 0;

  return (
    <>
      <View style={{ marginBottom: 12 }}>
        {label ? (
          <Text style={{ fontSize: 10, fontWeight: '700', color: '#64748B', letterSpacing: 0.5, marginBottom: 5 }}>
            {label.toUpperCase()}{required ? ' *' : ''}
          </Text>
        ) : null}
        <TouchableOpacity
          onPress={() => {
            if (value) {
              setViewYear(parseInt(value.slice(0, 4)));
              setViewMonth(parseInt(value.slice(5, 7)) - 1);
            }
            setOpen(true);
          }}
          style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderWidth: 1.5, borderColor: value ? '#2563EB' : 'rgba(37,99,235,0.2)', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, gap: 8 }}
        >
          <Ionicons name="calendar-outline" size={16} color={value ? '#2563EB' : '#94A3B8'} />
          <Text style={{ flex: 1, fontSize: 14, color: value ? '#0F172A' : '#94A3B8', fontWeight: value ? '600' : '400' }}>
            {value ? fmtDisplay(value) : (placeholder || 'Select date')}
          </Text>
          {value ? (
            <TouchableOpacity onPress={() => onChange('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={16} color="#94A3B8" />
            </TouchableOpacity>
          ) : <Ionicons name="chevron-down" size={14} color="#94A3B8" />}
        </TouchableOpacity>
      </View>

      {/* Calendar Modal */}
      <Modal visible={open} transparent animationType="fade">
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', alignItems: 'center' }} activeOpacity={1} onPress={() => setOpen(false)}>
          <TouchableOpacity activeOpacity={1} style={{ backgroundColor: '#fff', borderRadius: 20, padding: 20, width: Dimensions.get('window').width - 48, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 20, elevation: 12 }}>
            {/* Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <TouchableOpacity onPress={prevMonth} style={{ padding: 6 }}>
                <Ionicons name="chevron-back" size={20} color="#2563EB" />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { setViewYear(today.getFullYear()); setViewMonth(today.getMonth()); }}>
                <Text style={{ fontSize: 16, fontWeight: '800', color: '#0F172A' }}>
                  {MONTHS[viewMonth]} {viewYear}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={nextMonth} style={{ padding: 6 }}>
                <Ionicons name="chevron-forward" size={20} color="#2563EB" />
              </TouchableOpacity>
            </View>
            {/* Year quick-jump */}
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
              {[viewYear - 1, viewYear, viewYear + 1].map(y => (
                <TouchableOpacity key={y} onPress={() => setViewYear(y)}
                  style={{ paddingHorizontal: 12, paddingVertical: 4, borderRadius: 99, backgroundColor: y === viewYear ? '#2563EB' : '#EFF6FF' }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: y === viewYear ? '#fff' : '#2563EB' }}>{y}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {/* Day headers */}
            <View style={{ flexDirection: 'row', marginBottom: 6 }}>
              {DAYS.map(d => (
                <Text key={d} style={{ flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '700', color: '#94A3B8' }}>{d}</Text>
              ))}
            </View>
            {/* Day grid */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {Array.from({ length: firstDay }).map((_, i) => (
                <View key={`e${i}`} style={{ width: `${100 / 7}%` }} />
              ))}
              {Array.from({ length: days }, (_, i) => i + 1).map(day => {
                const isSelected = day === selectedDay;
                const isToday = day === today.getDate() && viewMonth === today.getMonth() && viewYear === today.getFullYear();
                return (
                  <TouchableOpacity key={day} onPress={() => handleSelect(day)}
                    style={{ width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <View style={{
                      width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
                      backgroundColor: isSelected ? '#2563EB' : isToday ? '#EFF6FF' : 'transparent',
                      borderWidth: isToday && !isSelected ? 1.5 : 0,
                      borderColor: '#2563EB',
                    }}>
                      <Text style={{ fontSize: 13, fontWeight: isSelected || isToday ? '800' : '400', color: isSelected ? '#fff' : isToday ? '#2563EB' : '#0F172A' }}>{day}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
            {/* Today button */}
            <TouchableOpacity onPress={() => { setViewYear(today.getFullYear()); setViewMonth(today.getMonth()); handleSelect(today.getDate()); }}
              style={{ marginTop: 14, backgroundColor: '#EFF6FF', borderRadius: 10, padding: 10, alignItems: 'center' }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>Today</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const TABS = [
  { key: 'readings',    label: 'Meter Readings', icon: 'flash-outline'       },
  { key: 'current-eb',  label: 'Current EB',     icon: 'speedometer-outline' },
  { key: 'rates',       label: 'EB Rates',       icon: 'pricetag-outline'    },
  { key: 'eb-payments', label: 'EB Payments',    icon: 'card-outline'        },
  { key: 'eb-profit',   label: 'EB Profit',      icon: 'trending-up-outline' },
  { key: 'analytics',   label: 'Analytics',      icon: 'bar-chart-outline'   },
];

// ─── Period filter helpers (mirrors web AccountingPeriodSelector) ─────────────
const PERIOD_OPTS = [
  { key: 'current_fy',   label: 'Current FY'   },
  { key: 'last_fy',      label: 'Last FY'       },
  { key: 'this_month',   label: 'This Month'    },
  { key: 'this_quarter', label: 'This Quarter'  },
  { key: 'last_month',   label: 'Last Month'    },
];

function getFYRange(year: number) {
  // Indian FY: Apr 1 → Mar 31
  return { from: new Date(year, 3, 1), to: new Date(year + 1, 2, 31) };
}

function isInPeriod(dateStr: string | null | undefined, period: string): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr + '-01');
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  const yr = now.getFullYear();
  const mo = now.getMonth(); // 0-based

  const fyYear = mo >= 3 ? yr : yr - 1; // current FY starts Apr

  if (period === 'current_fy') {
    const { from, to } = getFYRange(fyYear);
    return d >= from && d <= to;
  }
  if (period === 'last_fy') {
    const { from, to } = getFYRange(fyYear - 1);
    return d >= from && d <= to;
  }
  if (period === 'this_month') {
    return d.getFullYear() === yr && d.getMonth() === mo;
  }
  if (period === 'last_month') {
    const lm = new Date(yr, mo - 1, 1);
    return d.getFullYear() === lm.getFullYear() && d.getMonth() === lm.getMonth();
  }
  if (period === 'this_quarter') {
    const qStart = Math.floor(mo / 3) * 3;
    const from = new Date(yr, qStart, 1);
    const to   = new Date(yr, qStart + 3, 0);
    return d >= from && d <= to;
  }
  return true;
}

// Parse "MMM-yy" billing_month to "yyyy-MM" for period checks
function billingMonthToYM(m: string | null | undefined): string | null {
  if (!m) return null;
  try {
    const [mon, yr] = m.split('-');
    const months: Record<string, string> = {
      Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
      Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12',
    };
    const mm = months[mon];
    if (!mm) return null;
    const year = parseInt(yr) + 2000;
    return `${year}-${mm}`;
  } catch { return null; }
}

// Short month label "MMMyy" from a 'YYYY-MM-DD' date string, e.g. "Feb26"
function mmmYY(s: string | null | undefined): string {
  if (!s) return '';
  try {
    // Parse the Y/M explicitly to avoid UTC→local day shifts on date-only strings
    const y = parseInt(s.slice(0, 4));
    const m = parseInt(s.slice(5, 7)) - 1;
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (isNaN(y) || isNaN(m) || m < 0 || m > 11) return s;
    return MON[m] + String(y).slice(2);
  } catch { return s; }
}

// "YYYY-MM" → display label "MMM yy" (e.g. "2026-08" → "Aug 26"), for EB Profit rows.
function ymLabel(ym: string): string {
  const y = parseInt(ym.slice(0, 4));
  const m = parseInt(ym.slice(5, 7)) - 1;
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (isNaN(y) || isNaN(m) || m < 0 || m > 11) return ym;
  return `${MON[m]} ${String(y).slice(2)}`;
}

// List of "YYYY-MM" calendar months from start..end (inclusive), for apportioning a
// bi-monthly EB board bill across the months it spans (matches the web EB Profit calc).
function ymsBetween(startDate: string, endDate: string): string[] {
  if (!startDate || !endDate || startDate.length < 7 || endDate.length < 7) return [];
  let y = parseInt(startDate.slice(0, 4)), m = parseInt(startDate.slice(5, 7));
  const ey = parseInt(endDate.slice(0, 4)), em = parseInt(endDate.slice(5, 7));
  if ([y, m, ey, em].some(isNaN)) return [];
  const out: string[] = [];
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard++ < 120) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// Derive a billing period (calendar-month bounds) from a 'YYYY-MM-DD' bill date.
// Mirrors how the single-payment form carries an explicit period — here we infer
// the month that contains the chosen bill date. Returns '' pair on bad input.
function monthPeriodFromDate(dateStr: string | null | undefined): { start: string; end: string } {
  if (!dateStr || dateStr.length < 7) return { start: '', end: '' };
  try {
    const y = parseInt(dateStr.slice(0, 4));
    const m = parseInt(dateStr.slice(5, 7)); // 1-based
    if (isNaN(y) || isNaN(m) || m < 1 || m > 12) return { start: '', end: '' };
    const ym = dateStr.slice(0, 7);
    const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last day of this month
    return { start: `${ym}-01`, end: `${ym}-${String(lastDay).padStart(2, '0')}` };
  } catch { return { start: '', end: '' }; }
}

// ─── MAIN SCREEN ──────────────────────────────────────────────────────────────

export default function ElectricityScreen() {
  const nav = useNavigation() as any;
  const { token, user } = useAuth();
  const mounted = useMountedRef();

  const [activeTab, setActiveTab] = useState('readings');
  const [visibleTabKeys, setVisibleTabKeys] = useState<Set<string> | null>(null);
  const [groups, setGroups] = useState<any[] | null>(null);
  const [ebRates, setEbRates] = useState<any[]>([]);
  const [properties, setProperties] = useState<any[]>([]);
  const [bankAccounts, setBankAccounts] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  // ── Bulk add/edit modal state ─────────────────────────────────────────────
  const [addOpen, setAddOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [selProperty, setSelProperty] = useState('');
  const [selMonth, setSelMonth] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [bulkRows, setBulkRows] = useState<any[]>([]);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isLocked, setIsLocked] = useState(false);

  // ── EB Rate modal state ───────────────────────────────────────────────────
  const [rateOpen, setRateOpen] = useState(false);
  const [rateForm, setRateForm] = useState({ id: '', property_id: '', unit_cost: '', from_date: '', to_date: '' });
  const [rateSaving, setRateSaving] = useState(false);

  const [locking, setLocking] = useState<string | null>(null);

  // ── Period filter state ──────────────────────────────────────────────────
  const [periodFilter, setPeriodFilter] = useState('current_fy');

  // ── Lightbox state for viewing meter photos ───────────────────────────────
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // ── Meter photo state (per row in Add Reading modal) ─────────────────────
  const [meterPhotoUris, setMeterPhotoUris] = useState<Record<number, { uri: string; base64?: string } | null>>({});
  const [scanningIdx, setScanningIdx] = useState<number | null>(null);
  const [bulkScanBusy, setBulkScanBusy] = useState(false);

  // Recognise a meter reading from an uploaded photo URL and fill the row.
  const scanAndFill = async (idx: number, imageUrl: string) => {
    try {
      setScanningIdx(idx);
      const res: any = await sb.scanMeterReading(imageUrl);
      if (res?.error) { Alert.alert('Meter Scan', String(res.error)); return; }
      const val = res?.reading_value;
      if (val != null && !isNaN(Number(val))) {
        setBulkRows(prev => prev.map((r, i) => i === idx ? { ...r, reading_end: String(Math.round(Number(val))) } : r));
      } else {
        Alert.alert('Meter Scan', 'Could not read the value automatically — please type it in.');
      }
    } catch (e: any) {
      Alert.alert('Meter Scan failed', e?.message || 'Please try again.');
    } finally {
      setScanningIdx(null);
    }
  };

  // Pick MANY photos at once, upload + recognise each, and match by apartment code.
  const bulkScanPhotos = async () => {
    const IP = await import('expo-image-picker') as any;
    const { status } = await IP.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { Alert.alert('Permission needed'); return; }
    const r = await IP.launchImageLibraryAsync({
      mediaTypes: 'images' as any, quality: 0.8, base64: true,
      allowsMultipleSelection: true, selectionLimit: 0,
    });
    if (r.canceled || !r.assets?.length) return;
    setBulkScanBusy(true);
    try {
      // meter photos now upload via sb.uploadMeterPhoto (documents/meter-photos bucket)
      const rows = [...bulkRows];
      let matched = 0, unmatched = 0, failed = 0;
      for (const asset of r.assets) {
        try {
          const url = await sb.uploadMeterPhoto(asset.base64);
          if (!url) { failed++; continue; }
          const res: any = await sb.scanMeterReading(url);
          const code = String(res?.apartment_code || '').trim().toLowerCase();
          const val = res?.reading_value;
          const idx = code ? rows.findIndex((row) => String(row.apartment_code || '').trim().toLowerCase() === code) : -1;
          if (idx >= 0) {
            rows[idx] = {
              ...rows[idx], meter_photo_url: url,
              ...(val != null && !isNaN(Number(val)) ? { reading_end: String(Math.round(Number(val))) } : {}),
            };
            matched++;
          } else {
            unmatched++;
          }
        } catch { failed++; }
      }
      setBulkRows(rows);
      Alert.alert('Bulk Scan Complete', `Matched & filled: ${matched}\nApartment not matched: ${unmatched}\nFailed: ${failed}`);
    } finally {
      setBulkScanBusy(false);
    }
  };

  const pickMeterPhoto = async (idx: number) => {
    const IP = await import('expo-image-picker') as any;
    Alert.alert('Meter Photo', 'Choose source', [
      {
        text: 'Camera',
        onPress: async () => {
          const { status } = await IP.requestCameraPermissionsAsync();
          if (status !== 'granted') { Alert.alert('Permission needed'); return; }
          const r = await IP.launchCameraAsync({ quality: 0.8, base64: true });
          if (!r.canceled && r.assets[0]) {
            setMeterPhotoUris(prev => ({ ...prev, [idx]: { uri: r.assets[0].uri, base64: r.assets[0].base64 } }));
            // Upload immediately
            try {
              // meter photos now upload via sb.uploadMeterPhoto (documents/meter-photos bucket)
              const url = await sb.uploadMeterPhoto(r.assets[0].base64);
              if (url) { setBulkRows(prev => prev.map((row, i) => i === idx ? { ...row, meter_photo_url: url } : row)); await scanAndFill(idx, url); }
            } catch { /* photo saved locally, will retry on save */ }
          }
        },
      },
      {
        text: 'Gallery',
        onPress: async () => {
          const { status } = await IP.requestMediaLibraryPermissionsAsync();
          if (status !== 'granted') { Alert.alert('Permission needed'); return; }
          const r = await IP.launchImageLibraryAsync({ mediaTypes: 'images' as any, quality: 0.8, base64: true });
          if (!r.canceled && r.assets[0]) {
            setMeterPhotoUris(prev => ({ ...prev, [idx]: { uri: r.assets[0].uri, base64: r.assets[0].base64 } }));
            try {
              // meter photos now upload via sb.uploadMeterPhoto (documents/meter-photos bucket)
              const url = await sb.uploadMeterPhoto(r.assets[0].base64);
              if (url) { setBulkRows(prev => prev.map((row, i) => i === idx ? { ...row, meter_photo_url: url } : row)); await scanAndFill(idx, url); }
            } catch { /* saved locally */ }
          }
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };
  const [ebPayments,       setEbPayments]       = useState<any[]>([]);
  // ── Current EB (live slab statement from last reading → today's reading) ──
  const [currentEbProperty, setCurrentEbProperty] = useState('');
  const [currentEbRows,     setCurrentEbRows]     = useState<any[]>([]);
  const [currentEbLoading,  setCurrentEbLoading]  = useState(false);
  const [currentEbSaving,   setCurrentEbSaving]   = useState(false);

  const loadCurrentEb = useCallback(async (propertyId: string) => {
    if (!propertyId) { setCurrentEbRows([]); return; }
    setCurrentEbLoading(true);
    try {
      const rows = await sb.loadCurrentEb(propertyId);
      if (mounted.current) setCurrentEbRows(Array.isArray(rows) ? rows : []);
    } catch { if (mounted.current) setCurrentEbRows([]); }
    finally { if (mounted.current) setCurrentEbLoading(false); }
  }, [mounted]);

  const handleSaveCurrentEb = useCallback(async () => {
    const toSave = currentEbRows
      .filter((r: any) => r.currentReading !== '' && r.currentReading != null && !isNaN(parseFloat(String(r.currentReading))))
      .map((r: any) => {
        const units = Math.max(0, (parseFloat(String(r.currentReading)) || 0) - (Number(r.startReading) || 0));
        const bill = computeEbSlabBill(units);
        return {
          propertyId: currentEbProperty,
          apartmentId: r.apartmentId,
          startReading: Number(r.startReading) || 0,
          startMonth: r.startMonth || null,
          currentReading: parseFloat(String(r.currentReading)) || 0,
          unitsConsumed: units,
          ebAmount: bill.total,
          isDanger: bill.isDanger,
          existingId: r.existingId || null,
          photoUrl: r.photoUrl || null,
        };
      });
    if (!toSave.length) { Alert.alert('Nothing to save', 'Enter at least one current reading first.'); return; }
    setCurrentEbSaving(true);
    try {
      await sb.saveEbMonitoring(toSave);
      Alert.alert('Saved', `${toSave.length} monitoring reading(s) saved for today.`);
      await loadCurrentEb(currentEbProperty);
    } catch (e: any) { Alert.alert('Save failed', e?.message || 'Could not save readings.'); }
    finally { setCurrentEbSaving(false); }
  }, [currentEbRows, currentEbProperty, loadCurrentEb]);
  const [expandedEbGroup,  setExpandedEbGroup]  = useState<string | null>(null);

  // ── Period filter derived values (must be after all state declarations) ───
  const groupsInPeriod = useMemo(() => {
    return (groups || []).filter((g: any) => {
      const ym = billingMonthToYM(g.billing_month);
      return ym ? isInPeriod(ym, periodFilter) : false;
    });
  }, [groups, periodFilter]);

  const ebPaymentsInPeriod = useMemo(() => {
    return (ebPayments || []).filter((p: any) => {
      const d = p.bill_date;
      return d ? isInPeriod(d.slice(0, 7), periodFilter) : false;
    });
  }, [ebPayments, periodFilter]);

  const totalUnitsFiltered    = useMemo(() => groupsInPeriod.reduce((s: number, g: any) => s + (g.total_units  || 0), 0), [groupsInPeriod]);
  const totalCostFiltered     = useMemo(() => groupsInPeriod.reduce((s: number, g: any) => s + (g.total_amount || 0), 0), [groupsInPeriod]);
  const totalReadingsFiltered = useMemo(() => groupsInPeriod.reduce((s: number, g: any) => s + (g.readings?.length || 0), 0), [groupsInPeriod]);
  const totalEbPaidFiltered   = useMemo(() => ebPaymentsInPeriod.reduce((s: number, p: any) => s + Number(p.bill_amount || 0), 0), [ebPaymentsInPeriod]);

  // EB Profit per month: collected (readings units×cost, from group totals) minus paid
  // (eb_payments bill amounts; a bi-monthly bill is split evenly across the months it
  // spans). Mirrors the web EB Profit tab exactly. Keyed by "YYYY-MM" (sorts chrono).
  const ebProfitRows = useMemo(() => {
    const map: Record<string, { ym: string; collected: number; paid: number }> = {};
    const bump = (ym: string) => (map[ym] ||= { ym, collected: 0, paid: 0 });
    for (const g of groupsInPeriod as any[]) {
      const ym = billingMonthToYM(g.billing_month);
      if (ym) bump(ym).collected += Number(g.total_amount || 0);
    }
    for (const p of ebPaymentsInPeriod as any[]) {
      const amt = Number(p.bill_amount || 0);
      if (p.billing_period_start && p.billing_period_end) {
        const yms = ymsBetween(p.billing_period_start, p.billing_period_end);
        if (yms.length) { const per = amt / yms.length; for (const ym of yms) bump(ym).paid += per; }
        else { const ym = (p.bill_date || '').slice(0, 7); if (ym) bump(ym).paid += amt; }
      } else {
        const ym = (p.bill_date || '').slice(0, 7);
        if (ym) bump(ym).paid += amt;
      }
    }
    return Object.values(map)
      .map((r) => ({ ...r, profit: r.collected - r.paid }))
      .sort((a, b) => b.ym.localeCompare(a.ym));
  }, [groupsInPeriod, ebPaymentsInPeriod]);

  // Group EB payments by property + billing period so the list shows one summed
  // collapsible row per cycle (e.g. "Feb26 – Apr26"), expandable into each payment.
  // Presentation only — mirrors web Electricity ebPaymentGroups.
  const ebPaymentGroups = useMemo(() => {
    const map = new Map<string, any>();
    for (const p of (ebPayments || []) as any[]) {
      const start = p.billing_period_start || '';
      const end = p.billing_period_end || '';
      const key = `${p.property_id}|${start}|${end}`;
      let g = map.get(key);
      if (!g) {
        const periodLabel = start && end
          ? `${mmmYY(start)} – ${mmmYY(end)}`
          : (p.bill_date ? mmmYY(p.bill_date) : 'No period');
        g = {
          key,
          property_name: p.property_name || p.name || '—',
          periodLabel,
          sortDate: start || p.bill_date || '',
          payments: [] as any[],
          total: 0,
        };
        map.set(key, g);
      }
      g.payments.push(p);
      g.total += Number(p.bill_amount || 0);
    }
    return Array.from(map.values()).sort((a, b) => String(b.sortDate || '').localeCompare(String(a.sortDate || '')));
  }, [ebPayments]);
  const [paymentOpen,      setPaymentOpen]      = useState(false);
  const [paymentForm,      setPaymentForm]      = useState({ id: '', property_id: '', bill_date: '', bill_amount: '', payment_date: '', payment_mode: '', reference_number: '', bank_account_id: '', billing_period_start: '', billing_period_end: '', notes: '' });
  const [paymentSaving,    setPaymentSaving]    = useState(false);
  // Bulk EB payment entry
  const [bulkPayOpen,      setBulkPayOpen]      = useState(false);
  const [bulkPayProperty,  setBulkPayProperty]  = useState('');
  const [bulkPayBillDate,  setBulkPayBillDate]  = useState('');
  const [bulkPayDate,      setBulkPayDate]      = useState('');
  const [bulkPayMode,      setBulkPayMode]      = useState('');
  const [bulkPayBankId,    setBulkPayBankId]    = useState('');
  const [bulkPayRows,      setBulkPayRows]      = useState<any[]>([]);
  const [bulkPayLoading,   setBulkPayLoading]   = useState(false);
  const [bulkPaySaving,    setBulkPaySaving]    = useState(false);

  const PAYMENT_MODES = ['Cash', 'UPI', 'NEFT', 'RTGS', 'Cheque', 'Online'];

  // ── Analytics state ───────────────────────────────────────────────────────
  const [analytics, setAnalytics] = useState<any | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsFilter, setAnalyticsFilter] = useState('all');
  const [drillMonth, setDrillMonth] = useState<string | null>(null);

  const monthOptions = useMemo(() => getLast12Months(), []);

  // ── Analytics filter ref — avoids stale closure in useCallback ──────────
  const analyticsFilterRef = useRef('all');
  analyticsFilterRef.current = analyticsFilter;

  // ── Fetch analytics ───────────────────────────────────────────────────────
  const fetchAnalytics = useCallback(async (propFilter?: string) => {
    const filter = propFilter ?? analyticsFilterRef.current;
    if (!mounted.current) return;
    setAnalyticsLoading(true);
    try {
      const result: any = await sb.getEBAnalytics(filter === 'all' ? undefined : filter);
      if (!mounted.current) return;
      setAnalytics(result);
    } catch (e: any) {
      if (!mounted.current || isAbortError(e)) return;
      setAnalytics(null);
    } finally {
      if (mounted.current) setAnalyticsLoading(false);
    }
  }, []); // stable — filter read from ref at call time

  // ── Fetch all ─────────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    if (!token) return;
    try {
      // Each fetch is independent — failure in readings must not block properties
      const [g, rates, props, payments, banks] = await Promise.all([
        sb.listReadings().catch(() => []) as Promise<any[]>,
        sb.listEbRates().catch(() => []) as Promise<any[]>,
        sb.listPropertiesEnriched().catch(() => []) as Promise<any[]>,
        sb.listEbPayments().catch(() => []) as Promise<any[]>,
        fetchBankAccounts().catch(() => []) as Promise<any[]>,
      ]);
      if (!mounted.current) return;
      setGroups(g ?? []);
      setEbRates(rates ?? []);
      setProperties(props ?? []);
      setEbPayments(payments ?? []);
      setBankAccounts(banks ?? []);
    } catch (e: any) {
      if (!mounted.current || isAbortError(e)) return;
      // Still try to load properties even if overall fetch fails
      sb.listPropertiesEnriched().then(props => {
        if (mounted.current) setProperties(props ?? []);
      }).catch(() => {});
    }
  }, [token]);

  // Tab permissions
  useEffect(() => {
    fetchVisibleTabKeys(user?.role || '', 'Electricity').then(keys => {
      if (mounted.current) setVisibleTabKeys(keys);
    });
  }, [user?.role]);

  // Load properties immediately — no token needed (public org data)
  useEffect(() => {
    sb.listPropertiesEnriched()
      .then(props => { if (mounted.current) setProperties(props ?? []); })
      .catch(() => {});
  }, []);

  // fetchAll on focus (token-gated). fetchAnalytics is stable (empty deps) so safe to include.
  useFocusEffect(useCallback(() => { fetchAll(); fetchAnalytics(); }, [fetchAll]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  }, [fetchAll]);

  // ── Auto-fill unit cost from eb_rates when property/month changes ─────────
  const autoFillRate = useCallback((propertyId: string, month: string) => {
    if (!propertyId || !month || !ebRates.length) return;
    // parse "MMM-yy" → date string
    try {
      const parts = month.split('-');
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const mIdx = months.findIndex(m => m === parts[0]);
      if (mIdx < 0) return;
      const year = 2000 + parseInt(parts[1]);
      const dateStr = `${year}-${String(mIdx + 1).padStart(2, '0')}-01`;

      const propRates = ebRates.filter((r: any) =>
        r.property_id === propertyId && r.from_date <= dateStr &&
        (!r.to_date || r.to_date >= dateStr)
      );
      const globalRates = ebRates.filter((r: any) =>
        !r.property_id && r.from_date <= dateStr && (!r.to_date || r.to_date >= dateStr)
      );
      const match = propRates[0] || globalRates[0];
      if (match) setUnitCost(String(match.unit_cost));
    } catch {}
  }, [ebRates]);

  // ── Load bulk rows ─────────────────────────────────────────────────────────
  const loadBulkRows = useCallback(async (propertyId: string, month: string) => {
    if (!propertyId || !month) return;
    setBulkLoading(true);
    try {
      const result: any = await sb.listApartmentsForEB(propertyId, month);
      if (!mounted.current) return;
      setBulkRows(result.rows ?? []);
      setIsLocked(result.is_locked ?? false);
      setIsEditMode(result.rows?.some((r: any) => r.is_existing) ?? false);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setBulkLoading(false);
    }
  }, []);

  const handlePropertySelect = useCallback((pid: string) => {
    setSelProperty(pid);
    autoFillRate(pid, selMonth);
    if (selMonth) loadBulkRows(pid, selMonth);
  }, [selMonth, autoFillRate, loadBulkRows]);

  const handleMonthSelect = useCallback((month: string) => {
    setSelMonth(month);
    autoFillRate(selProperty, month);
    if (selProperty) loadBulkRows(selProperty, month);
  }, [selProperty, autoFillRate, loadBulkRows]);

  const updateRow = (idx: number, val: string) => {
    setBulkRows(prev => prev.map((r, i) => i === idx ? { ...r, reading_end: val } : r));
  };

  // ── Open edit for existing group ──────────────────────────────────────────
  const openEditGroup = (group: any) => {
    if (group.is_locked) {
      Alert.alert('Locked', 'These readings are locked and cannot be edited.');
      return;
    }
    setSelProperty(group.property_id);
    setSelMonth(group.billing_month);
    setUnitCost(String(group.unit_cost));
    const rows = group.readings.map((r: any) => ({
      id: r.id,
      apartment_id: r.apartment_id,
      apartment_code: r.apartment_code,
      eb_meter_number: r.eb_meter_number,
      previous_reading: r.reading_start,
      reading_end: r.reading_end,
      meter_photo_url: r.meter_photo_url,
      is_existing: true,
    }));
    rows.sort((a: any, b: any) =>
      a.apartment_code.localeCompare(b.apartment_code, undefined, { numeric: true })
    );
    setBulkRows(rows);
    setIsEditMode(true);
    setIsLocked(false);
    setMeterPhotoUris({});
    setAddOpen(true);
  };

  // ── Save bulk ─────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!selProperty || !selMonth || !unitCost) {
      Alert.alert('Error', 'Select property, month and enter unit cost');
      return;
    }
    const valid = bulkRows.filter(r => r.reading_end !== null && r.reading_end !== '' && !isNaN(parseFloat(String(r.reading_end))));
    if (valid.length === 0) {
      Alert.alert('Error', 'Enter at least one reading');
      return;
    }
    setSaving(true);
    try {
      const result: any = await sb.bulkSaveReadings({
        propertyId: selProperty,
        billingMonth: selMonth,
        unitCost: parseFloat(unitCost),
        rows: bulkRows,
      });
      Alert.alert('Success', `${result.saved} reading(s) saved`);
      setAddOpen(false);
      resetBulkForm();
      fetchAll();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setSaving(false);
    }
  };

  const resetBulkForm = () => {
    setSelProperty(''); setSelMonth(''); setUnitCost('');
    setBulkRows([]); setIsEditMode(false); setIsLocked(false);
  };

  // ── Lock/Unlock ───────────────────────────────────────────────────────────
  const handleLock = async (group: any) => {
    const action = group.is_locked ? 'unlock' : 'lock';
    Alert.alert(`${action.charAt(0).toUpperCase() + action.slice(1)} Readings`,
      `Are you sure you want to ${action} ${group.billing_month} readings for ${group.property_name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: action.charAt(0).toUpperCase() + action.slice(1),
          style: group.is_locked ? 'default' : 'destructive',
          onPress: async () => {
            setLocking(group.key);
            try {
              await sb.lockReadings(group.property_id, group.billing_month, !group.is_locked);
              fetchAll();
            } catch (e: any) { Alert.alert('Error', e.message); }
            finally { setLocking(null); }
          },
        },
      ]
    );
  };

  // ── EB Rate CRUD ──────────────────────────────────────────────────────────
  const handleSaveRate = async () => {
    if (!rateForm.unit_cost || !rateForm.from_date) {
      Alert.alert('Error', 'Unit cost and from date are required');
      return;
    }
    setRateSaving(true);
    try {
      await sb.saveEbRate(rateForm);
      Alert.alert('Success', rateForm.id ? 'Rate updated' : 'Rate created');
      setRateOpen(false);
      setRateForm({ id: '', property_id: '', unit_cost: '', from_date: '', to_date: '' });
      fetchAll();
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setRateSaving(false); }
  };

  const handleDeleteRate = (id: string) => {
    Alert.alert('Delete Rate', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await sb.deleteEbRate(id);
            fetchAll();
          } catch (e: any) { Alert.alert('Error', e.message); }
        },
      },
    ]);
  };

  // ── EB Payment handlers ───────────────────────────────────────────────────
  const handleSavePayment = async () => {
    if (!paymentForm.property_id || !paymentForm.bill_date || !paymentForm.bill_amount) {
      Alert.alert('Required', 'Property, bill date and bill amount are required');
      return;
    }
    if (paymentForm.payment_mode && paymentForm.payment_mode !== 'Cash' && bankAccounts.length > 0 && !paymentForm.bank_account_id) {
      Alert.alert('Bank required', 'Select the receiving bank account for a non-cash payment.');
      return;
    }
    setPaymentSaving(true);
    try {
      await sb.saveEbPayment(paymentForm);
      Alert.alert('Success', paymentForm.id ? 'Payment updated' : 'Payment added');
      setPaymentOpen(false);
      setPaymentForm({ id: '', property_id: '', bill_date: '', bill_amount: '', payment_date: '', payment_mode: '', reference_number: '', bank_account_id: '', billing_period_start: '', billing_period_end: '', notes: '' });
      fetchAll();
    } catch (e: any) { Alert.alert('Error', e.message); }
    setPaymentSaving(false);
  };

  const handleDeletePayment = (id: string) => {
    Alert.alert('Delete Payment', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try { await sb.deleteEbPayment(id); fetchAll(); }
        catch (e: any) { Alert.alert('Error', e.message); }
      }},
    ]);
  };

  const loadBulkPayRows = async (propertyId: string, billDate: string) => {
    if (!propertyId) return;
    setBulkPayLoading(true);
    try {
      const rows = await sb.loadEbPayBulkRows(propertyId, billDate || '');
      setBulkPayRows(rows || []);
    } catch (e: any) { Alert.alert('Error', e.message); }
    setBulkPayLoading(false);
  };

  const handleSaveBulkPayments = async () => {
    if (!bulkPayProperty || !bulkPayBillDate) {
      Alert.alert('Required', 'Property and bill date are required');
      return;
    }
    const toSave = bulkPayRows.filter(r => r.bill_amount && parseFloat(r.bill_amount) > 0);
    if (!toSave.length) { Alert.alert('Error', 'Enter at least one bill amount'); return; }
    if (bulkPayMode && bulkPayMode !== 'Cash' && bankAccounts.length > 0 && !bulkPayBankId) {
      Alert.alert('Bank required', 'Select the receiving bank account for a non-cash payment.'); return;
    }
    setBulkPaySaving(true);
    try {
      // Derive the billing period from the chosen bill date's calendar month so the
      // bulk save persists billing_period_start/end (the single-payment form already
      // carries these; the backend saveEbPayment stores them).
      const { start: periodStart, end: periodEnd } = monthPeriodFromDate(bulkPayBillDate);
      for (const row of toSave) {
        await sb.saveEbPayment({
          id: row.existing_id || '',
          property_id: bulkPayProperty,
          apartment_id: row.apartment_id,
          bill_date: bulkPayBillDate,
          bill_amount: row.bill_amount,
          payment_date: bulkPayDate || null,
          payment_mode: bulkPayMode || null,
          reference_number: row.reference_number || null,
          bank_account_id: bulkPayBankId || null,
          billing_period_start: periodStart || null,
          billing_period_end: periodEnd || null,
        });
      }
      Alert.alert('Success', `${toSave.length} payment(s) saved`);
      setBulkPayOpen(false);
      setBulkPayProperty(''); setBulkPayBillDate(''); setBulkPayDate(''); setBulkPayMode(''); setBulkPayBankId('');
      setBulkPayRows([]);
      fetchAll();
    } catch (e: any) { Alert.alert('Error', e.message); }
    setBulkPaySaving(false);
  };

  // ── KPI totals ────────────────────────────────────────────────────────────
  const totalUnits = useMemo(() =>
    (groups ?? []).reduce((s, g) => s + g.total_units, 0), [groups]);
  const totalCost = useMemo(() =>
    (groups ?? []).reduce((s, g) => s + g.total_amount, 0), [groups]);
  const totalReadings = useMemo(() =>
    (groups ?? []).reduce((s, g) => s + g.readings.length, 0), [groups]);
  const totalEbPaid = useMemo(() =>
    ebPayments.reduce((s, p) => s + Number(p.bill_amount || 0), 0), [ebPayments]);

  // ── Previous month lookup for trend arrows ────────────────────────────────
  const prevMonthMap = useMemo(() => {
    const map: Record<string, any> = {};
    (groups ?? []).forEach(g => {
      map[`${g.billing_month}__${g.property_id}`] = g;
    });
    return map;
  }, [groups]);

  const getPrev = (billingMonth: string, propertyId: string) => {
    // Parse "MMM-yy" and subtract 1 month
    try {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const [mon, yr] = billingMonth.split('-');
      const mIdx = months.findIndex(m => m === mon);
      const year = 2000 + parseInt(yr);
      const prev = new Date(year, mIdx - 1, 1);
      const prevStr = months[prev.getMonth()] + '-' + String(prev.getFullYear()).slice(2);
      return prevMonthMap[`${prevStr}__${propertyId}`] || null;
    } catch { return null; }
  };

  if (!groups) return <LoadingScreen />;

  const propName = (id: string) => {
    const p = properties.find((p: any) => p.id === id || p._id === id);
    return p?.property_name || p?.name || '—';
  };

  // ─── RENDER READINGS TAB ───────────────────────────────────────────────────
  const renderCurrentEb = () => {
    const rowsComputed = currentEbRows.map((r: any) => {
      const cur = parseFloat(String(r.currentReading));
      const hasCur = r.currentReading !== '' && r.currentReading != null && !isNaN(cur);
      const units = hasCur ? Math.max(0, cur - (Number(r.startReading) || 0)) : 0;
      const bill = computeEbSlabBill(units);
      // Advance payable only when the bill crosses ₹19,000: (bill − 18,000) rounded to nearest ₹1,000 (web parity).
      const advance = hasCur && bill.total > 19000 ? Math.round((bill.total - 18000) / 1000) * 1000 : 0;
      return { ...r, hasCur, units, bill, advance };
    });
    const totalAmount = rowsComputed.reduce((s: number, r: any) => s + (r.hasCur ? r.bill.total : 0), 0);
    const anyDanger = rowsComputed.some((r: any) => r.hasCur && r.bill.isDanger);
    const enteredCount = rowsComputed.filter((r: any) => r.hasCur).length;
    return (
      <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 120 }}>
        <SectionLabel text="Property" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.lg }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {properties.map((p: any) => {
              const pid = p._id || p.id;
              const active = currentEbProperty === pid;
              return (
                <TouchableOpacity key={pid} onPress={() => { setCurrentEbProperty(pid); loadCurrentEb(pid); }}
                  style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 99, backgroundColor: active ? '#2563EB' : '#F1F3F9' }}>
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>{p.property_name || p.name || ''}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>

        {!currentEbProperty ? (
          <Text style={{ color: colors.textTertiary, textAlign: 'center', marginTop: 30 }}>Select a property to load its meters.</Text>
        ) : currentEbLoading ? (
          <ActivityIndicator color="#2563EB" style={{ marginTop: 30 }} />
        ) : rowsComputed.length === 0 ? (
          <Text style={{ color: colors.textTertiary, textAlign: 'center', marginTop: 30 }}>No live apartments with meters for this property.</Text>
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
              <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#EEF1F6' }}>
                <Text style={{ fontSize: 11, color: colors.textSecondary }}>Estimated total ({enteredCount}/{rowsComputed.length})</Text>
                <Text style={{ fontSize: 18, fontWeight: '900', color: anyDanger ? '#DC2626' : '#2563EB' }}>₹{Math.round(totalAmount).toLocaleString('en-IN')}</Text>
              </View>
              {anyDanger && (
                <View style={{ justifyContent: 'center', backgroundColor: '#FEF2F2', borderRadius: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: '#FECACA' }}>
                  <Text style={{ fontSize: 12, fontWeight: '800', color: '#DC2626' }}>⚠ Danger</Text>
                  <Text style={{ fontSize: 9, color: '#DC2626' }}>{'>'} ₹{EB_DANGER_THRESHOLD.toLocaleString('en-IN')}</Text>
                </View>
              )}
            </View>

            {rowsComputed.map((r: any, idx: number) => (
              <View key={r.apartmentId} style={{ backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: r.hasCur && r.bill.isDanger ? '#FECACA' : '#EEF1F6' }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <View style={{ flex: 1, paddingRight: 8 }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: '#0F172A' }}>{r.apartmentCode}</Text>
                    <Text style={{ fontSize: 10, color: colors.textTertiary }}>{r.ebMeterNumber ? `Meter ${r.ebMeterNumber} · ` : ''}Start {r.startReading}{r.startMonth ? ` (${r.startMonth})` : ''}</Text>
                  </View>
                  {r.hasCur && (
                    <View style={{ alignItems: 'flex-end', backgroundColor: r.bill.isDanger ? '#FEF2F2' : '#ECFDF5', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
                      <Text style={{ fontSize: 13, fontWeight: '800', color: r.bill.isDanger ? '#DC2626' : '#059669' }}>₹{Math.round(r.bill.total).toLocaleString('en-IN')}</Text>
                      <Text style={{ fontSize: 9, color: r.bill.isDanger ? '#DC2626' : '#059669' }}>{r.units} units</Text>
                    </View>
                  )}
                </View>
                {r.hasCur && r.advance > 0 && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', backgroundColor: '#FFFBEB', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 8, borderWidth: 1, borderColor: '#FDE68A' }}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: '#B45309' }}>Advance payable ₹{r.advance.toLocaleString('en-IN')}</Text>
                  </View>
                )}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontSize: 12, color: colors.textSecondary }}>Current reading</Text>
                  <TextInput
                    style={[S.input, { flex: 1, marginBottom: 0 }]}
                    value={String(r.currentReading ?? '')}
                    onChangeText={(v: string) => setCurrentEbRows((prev: any[]) => prev.map((x: any, i: number) => i === idx ? { ...x, currentReading: v.replace(/[^0-9.]/g, '') } : x))}
                    placeholder={`≥ ${r.startReading}`}
                    keyboardType="numeric"
                    placeholderTextColor={colors.textTertiary}
                  />
                </View>
              </View>
            ))}

            <Text style={{ fontSize: 11, color: colors.textTertiary, marginBottom: 10 }}>
              Slab-rate estimate (TN telescopic). Saved snapshots are for monitoring only and don't affect billing.
            </Text>
            <TouchableOpacity style={[S.saveBtn, { backgroundColor: '#2563EB' }, currentEbSaving && { opacity: 0.5 }]} onPress={handleSaveCurrentEb} disabled={currentEbSaving}>
              {currentEbSaving ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>Save Today's Readings</Text>}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    );
  };

  const renderReadings = () => (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 60 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#2563EB" />}
    >
      {/* Period filter (mirrors web AccountingPeriodSelector) */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.md }}>
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 2 }}>
          {PERIOD_OPTS.map(opt => {
            const active = periodFilter === opt.key;
            return (
              <TouchableOpacity
                key={opt.key}
                onPress={() => setPeriodFilter(opt.key)}
                style={{
                  paddingHorizontal: 14, paddingVertical: 7, borderRadius: 99,
                  backgroundColor: active ? '#2563EB' : '#F1F3F9',
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>

      {/* KPI Cards — horizontal scroll so large numbers never wrap */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.lg }}>
        <View style={{ flexDirection: 'row', gap: spacing.sm, paddingRight: spacing.sm }}>
          <View style={{ width: 110 }}>
            <Card>
              <Ionicons name="flash-outline" size={16} color={colors.warning} />
              <Text style={S.kpiVal} numberOfLines={1} adjustsFontSizeToFit>{fmtUnits(totalUnitsFiltered)}</Text>
              <Text style={S.kpiLabel}>Total Units</Text>
            </Card>
          </View>
          <View style={{ width: 120 }}>
            <Card>
              <Ionicons name="cash-outline" size={16} color="#2563EB" />
              <Text style={S.kpiVal} numberOfLines={1} adjustsFontSizeToFit>{fmtAmt(totalCostFiltered)}</Text>
              <Text style={S.kpiLabel}>Total Billed</Text>
            </Card>
          </View>
          <View style={{ width: 100 }}>
            <Card>
              <Ionicons name="reader-outline" size={16} color={colors.success} />
              <Text style={S.kpiVal} numberOfLines={1} adjustsFontSizeToFit>{totalReadingsFiltered}</Text>
              <Text style={S.kpiLabel}>Readings</Text>
            </Card>
          </View>
          <View style={{ width: 110 }}>
            <Card>
              <Ionicons name="arrow-up-circle-outline" size={16} color={colors.danger} />
              <Text style={S.kpiVal} numberOfLines={1} adjustsFontSizeToFit>{fmtAmt(totalEbPaidFiltered)}</Text>
              <Text style={S.kpiLabel}>EB Paid</Text>
            </Card>
          </View>
        </View>
      </ScrollView>

      {/* Add Payment shortcut */}
      <TouchableOpacity
        onPress={() => { setPaymentForm({ id: '', property_id: '', bill_date: '', bill_amount: '', payment_date: '', payment_mode: '', reference_number: '', bank_account_id: '', billing_period_start: '', billing_period_end: '', notes: '' }); setPaymentOpen(true); }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-end', marginBottom: spacing.md, backgroundColor: '#FFFFFF', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: '#EEF1F6' }}
      >
        <Ionicons name="add" size={15} color="#2563EB" />
        <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>Add Payment</Text>
      </TouchableOpacity>

      {groupsInPeriod.length === 0 ? (
        <Card style={{ alignItems: 'center', paddingVertical: 32 }}>
          <Ionicons name="flash-outline" size={36} color="#C4B5A0" />
          <Text style={{ color: colors.textTertiary, marginTop: 8 }}>
            {groups.length > 0 ? `No readings for ${PERIOD_OPTS.find(p => p.key === periodFilter)?.label}` : 'No readings recorded'}
          </Text>
        </Card>
      ) : groupsInPeriod.map(group => {
        const prev = getPrev(group.billing_month, group.property_id);
        const expanded = expandedKey === group.key;
        return (
          <View key={group.key} style={{ marginBottom: spacing.sm }}>
            {/* Group header row */}
            <Card style={{ marginBottom: 0 }}>
              <TouchableOpacity
                onPress={() => setExpandedKey(expanded ? null : group.key)}
                activeOpacity={0.7}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: colors.text }}>{group.billing_month}</Text>
                      {group.is_locked && (
                        <Pill label="Locked" color="#EA580C" bg="#FFEDD5" />
                      )}
                    </View>
                    <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary }}>{group.property_name}</Text>
                    <View style={{ flexDirection: 'row', gap: 16, marginTop: 6 }}>
                      <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>
                        <Text style={{ fontWeight: '700', color: colors.text }}>{fmtUnits(group.total_units)}</Text> units
                        <TrendArrow current={group.total_units} previous={prev?.total_units ?? null} />
                      </Text>
                      <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>
                        <Text style={{ fontWeight: '700', color: '#2563EB' }}>{fmtAmt(group.total_amount)}</Text>
                      </Text>
                      <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>₹{group.unit_cost.toFixed(2)}/unit</Text>
                    </View>
                  </View>

                  {/* Action buttons */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <TouchableOpacity
                      onPress={() => handleLock(group)}
                      style={S.iconBtn}
                      disabled={locking === group.key}
                    >
                      {locking === group.key
                        ? <ActivityIndicator size="small" color="#2563EB" />
                        : <Ionicons
                            name={group.is_locked ? 'lock-closed' : 'lock-open-outline'}
                            size={16}
                            color={group.is_locked ? '#EA580C' : colors.textTertiary}
                          />
                      }
                    </TouchableOpacity>
                    {!group.is_locked && (
                      <TouchableOpacity onPress={() => openEditGroup(group)} style={S.iconBtn}>
                        <Ionicons name="pencil-outline" size={16} color={colors.textTertiary} />
                      </TouchableOpacity>
                    )}
                    <Ionicons
                      name={expanded ? 'chevron-up' : 'chevron-down'}
                      size={18} color={colors.textTertiary}
                    />
                  </View>
                </View>
              </TouchableOpacity>

              {/* Expanded apartment details */}
              {expanded && (
                <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: '#EEF1F6', paddingTop: 10 }}>
                  <View style={{ flexDirection: 'row', marginBottom: 6 }}>
                    <Text style={[S.th, { flex: 1.2 }]}>Apt</Text>
                    <Text style={[S.th, { flex: 1, textAlign: 'right' }]}>Prev</Text>
                    <Text style={[S.th, { flex: 1, textAlign: 'right' }]}>Current</Text>
                    <Text style={[S.th, { flex: 0.8, textAlign: 'right' }]}>Units</Text>
                    <Text style={[S.th, { flex: 1, textAlign: 'right' }]}>Amount</Text>
                    <Text style={[S.th, { flex: 0.6, textAlign: 'center' }]}>Photo</Text>
                  </View>
                  {group.readings
                    .slice()
                    .sort((a: any, b: any) =>
                      a.apartment_code.localeCompare(b.apartment_code, undefined, { numeric: true })
                    )
                    .map((r: any) => {
                      const prevApt = prev?.readings?.find((pr: any) => pr.apartment_id === r.apartment_id);
                      return (
                        <View key={r.id} style={{ flexDirection: 'row', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: 'rgba(37,99,235,0.05)' }}>
                          <View style={{ flex: 1.2 }}>
                            <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: colors.text }}>{r.apartment_code}</Text>
                            {r.eb_meter_number ? (
                              <Text style={{ fontSize: 9, color: colors.textTertiary }}>{r.eb_meter_number}</Text>
                            ) : null}
                          </View>
                          <Text style={[S.td, { flex: 1, textAlign: 'right' }]}>{Math.round(r.reading_start).toLocaleString('en-IN')}</Text>
                          <Text style={[S.td, { flex: 1, textAlign: 'right' }]}>{Math.round(r.reading_end).toLocaleString('en-IN')}</Text>
                          <View style={{ flex: 0.8, alignItems: 'flex-end' }}>
                            <Text style={[S.td, { fontWeight: '700' }]}>
                              {Math.round(r.units_consumed).toLocaleString('en-IN')}
                            </Text>
                            <TrendArrow current={r.units_consumed} previous={prevApt?.units_consumed ?? null} />
                          </View>
                          <Text style={[S.td, { flex: 1, textAlign: 'right', color: '#2563EB', fontWeight: '700' }]}>
                            {fmtAmt(r.amount)}
                          </Text>
                          {/* Meter photo */}
                          <View style={{ flex: 0.6, alignItems: 'center', justifyContent: 'center' }}>
                            {r.meter_photo_url ? (
                              <TouchableOpacity
                                onPress={() => setLightboxUrl(r.meter_photo_url)}
                                style={{ backgroundColor: 'rgba(37,99,235,0.1)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 }}
                              >
                                <Text style={{ fontSize: 9, fontWeight: '700', color: '#2563EB' }}>View</Text>
                              </TouchableOpacity>
                            ) : (
                              <Text style={{ fontSize: 9, color: colors.textTertiary }}>—</Text>
                            )}
                          </View>
                        </View>
                      );
                    })}
                </View>
              )}
            </Card>
          </View>
        );
      })}
    </ScrollView>
  );

  // ─── RENDER EB PAYMENTS TAB ───────────────────────────────────────────────
  const renderEbPayments = () => (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 60 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#2563EB" />}
    >
      {/* Action buttons */}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: spacing.md }}>
        <TouchableOpacity
          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 10 }}
          onPress={() => { setPaymentForm({ id: '', property_id: '', bill_date: '', bill_amount: '', payment_date: '', payment_mode: '', reference_number: '', bank_account_id: '', billing_period_start: '', billing_period_end: '', notes: '' }); setPaymentOpen(true); }}
        >
          <Ionicons name="add" size={16} color="#fff" />
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Add Payment</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#FFFFFF', borderRadius: 12, paddingVertical: 10, borderWidth: 1, borderColor: '#EEF1F6' }}
          onPress={() => { setBulkPayProperty(''); setBulkPayBillDate(''); setBulkPayDate(''); setBulkPayMode(''); setBulkPayRows([]); setBulkPayOpen(true); }}
        >
          <Ionicons name="list-outline" size={16} color="#2563EB" />
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>Bulk Entry</Text>
        </TouchableOpacity>
      </View>

      {/* KPI */}
      <Card style={{ marginBottom: spacing.md, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View>
          <Text style={S.kpiVal}>{fmtAmt(totalEbPaid)}</Text>
          <Text style={S.kpiLabel}>Total EB Paid</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[S.kpiVal, { color: totalCost > totalEbPaid ? colors.danger : colors.success }]}>
            {totalCost > totalEbPaid ? '−' : '+'}{fmtAmt(Math.abs(totalCost - totalEbPaid))}
          </Text>
          <Text style={S.kpiLabel}>{totalCost > totalEbPaid ? 'Underpaid vs Billed' : 'Overpaid vs Billed'}</Text>
        </View>
      </Card>

      {ebPayments.length === 0 ? (
        <Card style={{ alignItems: 'center', paddingVertical: 32 }}>
          <Ionicons name="card-outline" size={36} color="#C4B5A0" />
          <Text style={{ color: colors.textTertiary, marginTop: 8 }}>No EB payments recorded</Text>
        </Card>
      ) : ebPaymentGroups.map((g: any) => {
        const expanded = expandedEbGroup === g.key;
        return (
          <Card key={g.key} style={{ marginBottom: spacing.sm }}>
            {/* Group header — property + billing cycle + summed total */}
            <TouchableOpacity onPress={() => setExpandedEbGroup(expanded ? null : g.key)} activeOpacity={0.7}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: colors.text }}>{g.periodLabel}</Text>
                  <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2 }}>
                    {g.property_name} · {g.payments.length} payment{g.payments.length === 1 ? '' : 's'}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: '#2563EB' }}>{fmtAmt(g.total)}</Text>
                  <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textTertiary} />
                </View>
              </View>
            </TouchableOpacity>

            {/* Expanded — individual payments in this cycle (edit / delete intact) */}
            {expanded && (
              <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: '#EEF1F6', paddingTop: 10, gap: 10 }}>
                {g.payments.map((p: any) => (
                  <View key={p.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottomWidth: 1, borderBottomColor: 'rgba(37,99,235,0.05)', paddingBottom: 8 }}>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: '#2563EB' }}>
                          {fmtAmt(p.bill_amount)}
                        </Text>
                        {p.payment_mode && (
                          <View style={{ backgroundColor: 'rgba(37,99,235,0.1)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                            <Text style={{ fontSize: 10, fontWeight: '700', color: '#2563EB' }}>{p.payment_mode}</Text>
                          </View>
                        )}
                      </View>
                      <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary }}>{p.property_name || p.name || ""}</Text>
                      <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary, marginTop: 3 }}>
                        Bill: {fmtDate(p.bill_date)}
                        {p.payment_date ? `  ·  Paid: ${fmtDate(p.payment_date)}` : ''}
                      </Text>
                      {p.reference_number ? (
                        <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary }}>Ref: {p.reference_number}</Text>
                      ) : null}
                      {p.billing_period_start ? (
                        <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary }}>
                          Period: {fmtDate(p.billing_period_start)} → {fmtDate(p.billing_period_end)}
                        </Text>
                      ) : null}
                      {p.notes ? <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary, marginTop: 2 }}>{p.notes}</Text> : null}
                    </View>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <TouchableOpacity style={S.iconBtn} onPress={() => {
                        setPaymentForm({ id: p.id, property_id: p.property_id, bill_date: p.bill_date, bill_amount: String(p.bill_amount), payment_date: p.payment_date || '', payment_mode: p.payment_mode || '', reference_number: p.reference_number || '', bank_account_id: p.bank_account_id || '', billing_period_start: p.billing_period_start || '', billing_period_end: p.billing_period_end || '', notes: p.notes || '' });
                        setPaymentOpen(true);
                      }}>
                        <Ionicons name="pencil-outline" size={16} color={colors.textTertiary} />
                      </TouchableOpacity>
                      <TouchableOpacity style={[S.iconBtn, { backgroundColor: 'rgba(220,38,38,0.08)' }]} onPress={() => handleDeletePayment(p.id)}>
                        <Ionicons name="trash-outline" size={16} color={colors.danger} />
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </Card>
        );
      })}
    </ScrollView>
  );

  // ─── RENDER ANALYTICS TAB ─────────────────────────────────────────────────
  const renderEbProfit = () => {
    const tot = ebProfitRows.reduce(
      (a, r) => ({ collected: a.collected + r.collected, paid: a.paid + r.paid, profit: a.profit + r.profit }),
      { collected: 0, paid: 0, profit: 0 },
    );
    const money = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
    return (
      <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 120, gap: 12 }}>
        <View style={{ backgroundColor:'#EEF3FF', borderRadius:16, padding:12, flexDirection:'row', alignItems:'flex-start', gap:8 }}>
          <Ionicons name="trending-up-outline" size={16} color="#1D4ED8" style={{ marginTop:1 }} />
          <Text style={{ flex:1, fontSize:12, color:'#64748B', lineHeight:18 }}>
            EB Profit = collected from tenants (units × rate) − paid to the board. Bi-monthly board bills are split across the months they cover.
          </Text>
        </View>
        {ebProfitRows.length === 0 ? (
          <View style={{ alignItems:'center', paddingVertical:40, gap:8 }}>
            <Ionicons name="trending-up-outline" size={28} color="#B9A8CE" />
            <Text style={{ fontSize:13, color:'#7A6A8E' }}>No EB data for this period.</Text>
          </View>
        ) : (
          <View style={{ backgroundColor:'#FFFFFF', borderRadius:16, borderWidth:1, borderColor:'#EEF1F6', overflow:'hidden' }}>
            <View style={{ flexDirection:'row', backgroundColor:'#F8FAFC', paddingVertical:10, paddingHorizontal:12 }}>
              <Text style={{ flex:1.2, fontSize:11, fontWeight:'700', color:'#64748B' }}>MONTH</Text>
              <Text style={{ flex:1, fontSize:11, fontWeight:'700', color:'#64748B', textAlign:'right' }}>COLLECTED</Text>
              <Text style={{ flex:1, fontSize:11, fontWeight:'700', color:'#64748B', textAlign:'right' }}>PAID</Text>
              <Text style={{ flex:1, fontSize:11, fontWeight:'700', color:'#64748B', textAlign:'right' }}>PROFIT</Text>
            </View>
            {ebProfitRows.map((r) => (
              <View key={r.ym} style={{ flexDirection:'row', paddingVertical:11, paddingHorizontal:12, borderTopWidth:1, borderTopColor:'#F1F5F9' }}>
                <Text style={{ flex:1.2, fontSize:13, fontWeight:'700', color:'#0F172A' }}>{ymLabel(r.ym)}</Text>
                <Text style={{ flex:1, fontSize:13, color:'#334155', textAlign:'right' }}>{money(r.collected)}</Text>
                <Text style={{ flex:1, fontSize:13, color:'#334155', textAlign:'right' }}>{money(r.paid)}</Text>
                <Text style={{ flex:1, fontSize:13, fontWeight:'700', textAlign:'right', color: r.profit >= 0 ? '#16A34A' : '#DC2626' }}>{money(r.profit)}</Text>
              </View>
            ))}
            <View style={{ flexDirection:'row', paddingVertical:12, paddingHorizontal:12, borderTopWidth:2, borderTopColor:'#E2E8F0', backgroundColor:'#F8FAFC' }}>
              <Text style={{ flex:1.2, fontSize:13, fontWeight:'800', color:'#0F172A' }}>Total</Text>
              <Text style={{ flex:1, fontSize:13, fontWeight:'700', color:'#0F172A', textAlign:'right' }}>{money(tot.collected)}</Text>
              <Text style={{ flex:1, fontSize:13, fontWeight:'700', color:'#0F172A', textAlign:'right' }}>{money(tot.paid)}</Text>
              <Text style={{ flex:1, fontSize:13, fontWeight:'800', textAlign:'right', color: tot.profit >= 0 ? '#16A34A' : '#DC2626' }}>{money(tot.profit)}</Text>
            </View>
          </View>
        )}
      </ScrollView>
    );
  };

  const renderAnalytics = () => {
    if (analyticsLoading || !analytics) {
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: 60 }}>
          <ActivityIndicator size="large" color="#2563EB" />
          <Text style={{ color: '#64748B', marginTop: 12, fontSize: fontSize.sm }}>Loading analytics…</Text>
        </View>
      );
    }

    const { monthlyData, aptBreakdownByMonth, totalCollected, totalPaid, totalVariance, profitableMonths } = analytics;
    const analyticsProps: any[] = analytics.properties || properties;

    return (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 60 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await fetchAnalytics(); setRefreshing(false); }} tintColor="#2563EB" />}
      >
        {/* KPI Cards */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg }}>
          <View style={{ flex: 1, minWidth: 140 }}>
            <Card>
              <Ionicons name="arrow-down-circle-outline" size={16} color="#2563EB" />
              <Text style={S.kpiVal}>{fmtAmt(totalCollected)}</Text>
              <Text style={S.kpiLabel}>EB Collected (12m)</Text>
            </Card>
          </View>
          <View style={{ flex: 1, minWidth: 140 }}>
            <Card>
              <Ionicons name="arrow-up-circle-outline" size={16} color={colors.warning} />
              <Text style={S.kpiVal}>{fmtAmt(totalPaid)}</Text>
              <Text style={S.kpiLabel}>EB Actual Cost (12m)</Text>
            </Card>
          </View>
          <View style={{ flex: 1, minWidth: 140 }}>
            <Card>
              <Ionicons name={totalVariance >= 0 ? 'trending-up-outline' : 'trending-down-outline'} size={16} color={totalVariance >= 0 ? '#16A34A' : '#DC2626'} />
              <Text style={[S.kpiVal, { color: totalVariance >= 0 ? '#16A34A' : '#DC2626' }]}>
                {totalVariance >= 0 ? '+' : ''}{fmtAmt(totalVariance)}
              </Text>
              <Text style={S.kpiLabel}>Net EB Variance</Text>
              <View style={{ marginTop: 4 }}>
                <Pill label={totalVariance >= 0 ? 'Profitable' : 'At a Loss'} color={totalVariance >= 0 ? '#16A34A' : '#DC2626'} bg={totalVariance >= 0 ? '#DCFCE7' : '#FEE2E2'} />
              </View>
            </Card>
          </View>
          <View style={{ flex: 1, minWidth: 140 }}>
            <Card>
              <Ionicons name="calendar-outline" size={16} color="#2563EB" />
              <Text style={S.kpiVal}>{profitableMonths}<Text style={{ fontSize: fontSize.sm, color: '#64748B' }}> / 12</Text></Text>
              <Text style={S.kpiLabel}>Profitable Months</Text>
            </Card>
          </View>
        </View>

        {/* Property filter */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.lg }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[{ id: 'all', property_name: 'All Properties' }, ...analyticsProps].map((p: any) => {
              const active = analyticsFilter === p.id;
              return (
                <TouchableOpacity key={p.id}
                  onPress={() => {
                    setAnalyticsFilter(p.id);
                    setDrillMonth(null);
                    fetchAnalytics(p.id);
                  }}
                  style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 99,
                    backgroundColor: active ? '#2563EB' : '#F1F3F9' }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>{p.property_name || p.name || ""}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>

        {/* Monthly bar visual */}
        <Card style={{ marginBottom: spacing.lg }}>
          <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: '#0F172A', marginBottom: 4 }}>Monthly EB: Collected vs Actual Cost</Text>
          <Text style={{ fontSize: fontSize.xs, color: '#64748B', marginBottom: 12 }}>🟣 Collected  ⬜ Actual Cost</Text>
          {monthlyData.map((m: any) => {
            const maxVal = Math.max(...monthlyData.map((x: any) => Math.max(x.ebCollected, x.ebPaid)), 1);
            const collectedW = (m.ebCollected / maxVal) * 100;
            const paidW = (m.ebPaid / maxVal) * 100;
            const hasData = m.ebCollected > 0 || m.ebPaid > 0;
            return (
              <View key={m.month} style={{ marginBottom: 10 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#0F172A' }}>{m.month}</Text>
                  {hasData && (
                    <Text style={{ fontSize: 10, fontWeight: '700', color: m.variance >= 0 ? colors.success : colors.danger }}>
                      {m.variance >= 0 ? '+' : ''}{fmtAmt(m.variance)}
                    </Text>
                  )}
                </View>
                {hasData ? (
                  <>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                      <View style={{ width: `${collectedW}%` as any, height: 8, borderRadius: 99, backgroundColor: '#2563EB' }} />
                      <Text style={{ fontSize: 9, color: '#64748B' }}>{fmtAmt(m.ebCollected)}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <View style={{ width: `${paidW}%` as any, height: 8, borderRadius: 99, backgroundColor: '#94A3B8' }} />
                      <Text style={{ fontSize: 9, color: '#64748B' }}>{fmtAmt(m.ebPaid)}</Text>
                    </View>
                  </>
                ) : (
                  <Text style={{ fontSize: 10, color: '#94A3B8' }}>No data</Text>
                )}
              </View>
            );
          })}
        </Card>

        {/* Monthly P&L table */}
        <Card style={{ marginBottom: spacing.lg }}>
          <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: '#0F172A', marginBottom: 12 }}>Monthly EB P&L</Text>
          {/* Header */}
          <View style={{ flexDirection: 'row', marginBottom: 6 }}>
            <Text style={[S.th, { flex: 1 }]}>Month</Text>
            <Text style={[S.th, { flex: 1.2, textAlign: 'right' }]}>Collected</Text>
            <Text style={[S.th, { flex: 1.2, textAlign: 'right' }]}>Actual</Text>
            <Text style={[S.th, { flex: 1, textAlign: 'right' }]}>Variance</Text>
            <Text style={[S.th, { flex: 0.8, textAlign: 'center' }]}>Detail</Text>
          </View>
          {monthlyData.map((m: any) => {
            const hasData = m.ebCollected > 0 || m.ebPaid > 0;
            const isDrilled = drillMonth === m.month;
            const drillRows: any[] = aptBreakdownByMonth?.[m.month] || [];
            return (
              <View key={m.month}>
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6,
                  borderBottomWidth: 1, borderBottomColor: 'rgba(37,99,235,0.05)' }}>
                  <Text style={{ flex: 1, fontSize: fontSize.xs, fontWeight: '700', color: '#0F172A' }}>{m.month}</Text>
                  <Text style={{ flex: 1.2, fontSize: fontSize.xs, textAlign: 'right', color: '#0F172A' }}>
                    {hasData ? fmtAmt(m.ebCollected) : '—'}
                  </Text>
                  <Text style={{ flex: 1.2, fontSize: fontSize.xs, textAlign: 'right', color: '#0F172A' }}>
                    {hasData ? fmtAmt(m.ebPaid) : '—'}
                  </Text>
                  <Text style={{ flex: 1, fontSize: fontSize.xs, textAlign: 'right', fontWeight: '700',
                    color: hasData ? (m.variance >= 0 ? colors.success : colors.danger) : '#64748B' }}>
                    {hasData ? `${m.variance >= 0 ? '+' : ''}${fmtAmt(m.variance)}` : '—'}
                  </Text>
                  <TouchableOpacity
                    style={{ flex: 0.8, alignItems: 'center' }}
                    onPress={() => setDrillMonth(isDrilled ? null : m.month)}
                    disabled={!hasData}
                  >
                    {hasData ? (
                      <Ionicons name={isDrilled ? 'chevron-up' : 'chevron-down'} size={14} color="#2563EB" />
                    ) : (
                      <Text style={{ fontSize: 10, color: '#94A3B8' }}>—</Text>
                    )}
                  </TouchableOpacity>
                </View>

                {/* Apartment drill-down */}
                {isDrilled && drillRows.length > 0 && (
                  <View style={{ backgroundColor: 'rgba(37,99,235,0.03)', borderRadius: 10, padding: 10, marginVertical: 6 }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#2563EB', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
                      Apartment Breakdown — {m.month}
                    </Text>
                    {/* Sub-header */}
                    <View style={{ flexDirection: 'row', marginBottom: 4 }}>
                      <Text style={[S.th, { flex: 1 }]}>Apt</Text>
                      <Text style={[S.th, { flex: 0.8, textAlign: 'right' }]}>Units</Text>
                      <Text style={[S.th, { flex: 1.1, textAlign: 'right' }]}>Actual</Text>
                      <Text style={[S.th, { flex: 1.1, textAlign: 'right' }]}>Collected</Text>
                      <Text style={[S.th, { flex: 1, textAlign: 'right' }]}>Variance</Text>
                    </View>
                    {drillRows.map((apt: any) => (
                      <View key={apt.aptCode} style={{ flexDirection: 'row', paddingVertical: 5,
                        borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#0F172A' }}>{apt.aptCode}</Text>
                          <Text style={{ fontSize: 9, color: '#64748B' }}>{apt.propName}</Text>
                        </View>
                        <Text style={{ flex: 0.8, fontSize: fontSize.xs, textAlign: 'right', color: '#0F172A' }}>
                          {apt.unitsConsumed}
                        </Text>
                        <Text style={{ flex: 1.1, fontSize: fontSize.xs, textAlign: 'right', color: '#0F172A' }}>
                          {fmtAmt(apt.ebActualCost)}
                        </Text>
                        <Text style={{ flex: 1.1, fontSize: fontSize.xs, textAlign: 'right', color: '#0F172A' }}>
                          {fmtAmt(apt.ebCollected)}
                        </Text>
                        <Text style={{ flex: 1, fontSize: fontSize.xs, textAlign: 'right', fontWeight: '700',
                          color: apt.variance >= 0 ? colors.success : colors.danger }}>
                          {apt.variance >= 0 ? '+' : ''}{fmtAmt(apt.variance)}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            );
          })}
        </Card>
      </ScrollView>
    );
  };

  // ─── RENDER EB RATES TAB ───────────────────────────────────────────────────
  const renderRates = () => (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 60 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#2563EB" />}
    >
      <TouchableOpacity
        style={S.addRateBtn}
        onPress={() => {
          setRateForm({ id: '', property_id: '', unit_cost: '', from_date: '', to_date: '' });
          setRateOpen(true);
        }}
      >
        <Ionicons name="add" size={18} color="#fff" />
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: fontSize.sm }}>Add EB Rate</Text>
      </TouchableOpacity>

      {ebRates.length === 0 ? (
        <Card style={{ alignItems: 'center', paddingVertical: 32 }}>
          <Ionicons name="settings-outline" size={36} color="#C4B5A0" />
          <Text style={{ color: colors.textTertiary, marginTop: 8 }}>No EB rates configured</Text>
        </Card>
      ) : ebRates.map((rate: any) => (
        <Card key={rate.id} style={{ marginBottom: spacing.sm }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: '#2563EB' }}>
                ₹{parseFloat(rate.unit_cost).toFixed(2)}/unit
              </Text>
              <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 }}>
                {rate.property_name}
              </Text>
              <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary, marginTop: 4 }}>
                {fmtDate(rate.from_date)} → {rate.to_date ? fmtDate(rate.to_date) : 'Ongoing'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <TouchableOpacity
                style={S.iconBtn}
                onPress={() => {
                  setRateForm({
                    id: rate.id,
                    property_id: rate.property_id || '',
                    unit_cost: String(rate.unit_cost),
                    from_date: rate.from_date,
                    to_date: rate.to_date || '',
                  });
                  setRateOpen(true);
                }}
              >
                <Ionicons name="pencil-outline" size={16} color={colors.textTertiary} />
              </TouchableOpacity>
              <TouchableOpacity style={[S.iconBtn, { backgroundColor: 'rgba(220,38,38,0.08)' }]}
                onPress={() => handleDeleteRate(rate.id)}>
                <Ionicons name="trash-outline" size={16} color={colors.danger} />
              </TouchableOpacity>
            </View>
          </View>
        </Card>
      ))}
    </ScrollView>
  );

  // ─── MAIN RENDER ──────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1 , backgroundColor: '#FFFFFF'}}>
      <SafeAreaView style={{ flex: 1 }}>

        {/* Header */}
        <View style={{ paddingHorizontal: spacing.xl, paddingTop: 12, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center' }}>
              <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
            </View>
            <View>
              <Text style={{ fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 }}>Electricity</Text>
              <Text style={{ fontSize: 13, color: '#64748B', fontWeight: '500', marginTop: 2 }}>Meter readings, rates and cost sharing</Text>
            </View>
          </View>
          {activeTab === 'readings' && (
            <IconBtnSolid
              onPress={() => {
                resetBulkForm();
                setAddOpen(true);
              }}
            />
          )}
        </View>

        {/* Tab bar — horizontal scroll, fixed height so tabs don't stretch */}
        <View style={{ height: 40, marginBottom: 8 }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: 8, alignItems: 'center', flexDirection: 'row' }}
          >
            {filterTabs(TABS, visibleTabKeys).map(tab => {
              const active = activeTab === tab.key;
              return (
                <TouchableOpacity
                  key={tab.key}
                  onPress={() => setActiveTab(tab.key)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5,
                    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 99,
                    backgroundColor: active ? '#2563EB' : '#F1F3F9' }}
                >
                  <Ionicons name={tab.icon as any} size={13} color={active ? '#fff' : '#64748B'} />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>{tab.label}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {/* Tab content */}
        {activeTab === 'readings' ? renderReadings() : activeTab === 'current-eb' ? renderCurrentEb() : activeTab === 'eb-payments' ? renderEbPayments() : activeTab === 'eb-profit' ? renderEbProfit() : activeTab === 'analytics' ? renderAnalytics() : renderRates()}

      </SafeAreaView>

      {/* ── Bulk Add/Edit Modal ─────────────────────────────────────────────── */}
      <Modal visible={addOpen} animationType="slide" presentationStyle="pageSheet">
        <View style={{ flex: 1 , backgroundColor: '#FFFFFF'}}>
          <SafeAreaView style={{ flex: 1 }}>
            {/* Modal header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              paddingHorizontal: spacing.xl, paddingVertical: spacing.lg,
              borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>
              <TouchableOpacity onPress={() => { setAddOpen(false); resetBulkForm(); }}>
                <Text style={{ color: colors.danger, fontSize: fontSize.md }}>Cancel</Text>
              </TouchableOpacity>
              <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#0F172A' }}>
                {isEditMode ? 'Edit Readings' : 'Add Readings'}
              </Text>
              <View style={{ width: 60 }} />
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.xl, paddingBottom: 60 }}>

              {/* Property picker */}
              <SectionLabel text="Property *" />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.lg }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {properties.map((p: any) => {
                    const pid = p._id || p.id;
                    const active = selProperty === pid;
                    return (
                      <TouchableOpacity key={pid}
                        onPress={() => handlePropertySelect(pid)}
                        style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 99,
                          backgroundColor: active ? '#2563EB' : '#F1F3F9' }}>
                        <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>
                          {p.property_name || p.name || ""}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>

              {/* Month picker */}
              <SectionLabel text="Billing Month *" />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.lg }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {monthOptions.map(m => {
                    const active = selMonth === m;
                    return (
                      <TouchableOpacity key={m}
                        onPress={() => handleMonthSelect(m)}
                        style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 99,
                          backgroundColor: active ? '#2563EB' : '#F1F3F9' }}>
                        <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>{m}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>

              {/* Unit cost */}
              <SectionLabel text="Unit Cost (₹/unit) *" />
              <TextInput
                style={S.input}
                value={unitCost}
                onChangeText={setUnitCost}
                placeholder="Auto-filled from EB rates"
                placeholderTextColor={colors.textTertiary}
                keyboardType="numeric"
              />
              {unitCost ? (
                <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, marginBottom: spacing.lg }}>
                  ₹{parseFloat(unitCost || '0').toFixed(2)}/unit
                </Text>
              ) : <View style={{ marginBottom: spacing.lg }} />}

              {/* Locked warning */}
              {isLocked && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8,
                  backgroundColor: 'rgba(230,81,0,0.08)', borderRadius: 12, padding: 12, marginBottom: 12 }}>
                  <Ionicons name="lock-closed" size={16} color="#E65100" />
                  <Text style={{ fontSize: fontSize.sm, color: '#EA580C', flex: 1 }}>
                    This month's readings are locked and cannot be modified.
                  </Text>
                </View>
              )}

              {/* Bulk rows */}
              {bulkLoading ? (
                <ActivityIndicator color="#2563EB" style={{ marginTop: 24 }} />
              ) : bulkRows.length === 0 && selProperty && selMonth ? (
                <View style={{ alignItems: 'center', paddingVertical: 32 }}>
                  <Ionicons name="home-outline" size={36} color="#C4B5A0" />
                  <Text style={{ color: colors.textTertiary, marginTop: 8 }}>
                    No live apartments found for this property in {selMonth}
                  </Text>
                </View>
              ) : bulkRows.length > 0 ? (
                <>
                  <SectionLabel text="Apartment Readings" />
                  {!isLocked && (
                    <TouchableOpacity
                      onPress={bulkScanPhotos}
                      disabled={bulkScanBusy}
                      style={{
                        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                        backgroundColor: 'rgba(37,99,235,0.1)', borderWidth: 1, borderColor: 'rgba(37,99,235,0.35)',
                        borderRadius: 12, paddingVertical: 12, marginBottom: 12,
                      }}
                    >
                      {bulkScanBusy
                        ? <ActivityIndicator size="small" color="#2563EB" />
                        : <Ionicons name="scan-outline" size={18} color="#2563EB" />}
                      <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#2563EB' }}>
                        {bulkScanBusy ? 'Scanning photos…' : 'Bulk Scan Meter Photos'}
                      </Text>
                    </TouchableOpacity>
                  )}
                  {bulkRows.map((row, idx) => {
                    const readEnd = parseFloat(String(row.reading_end));
                    const consumption = !isNaN(readEnd) && row.reading_end !== null && row.reading_end !== ''
                      ? readEnd - row.previous_reading : null;
                    return (
                      <View key={row.apartment_id} style={[S.bulkRow, consumption !== null && consumption < 0 && { borderColor: colors.danger }]}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <View>
                            <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: '#0F172A' }}>{row.apartment_code}</Text>
                            {row.eb_meter_number ? (
                              <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary }}>{row.eb_meter_number}</Text>
                            ) : null}
                          </View>
                          {consumption !== null && (
                            <View style={{ alignItems: 'flex-end' }}>
                              <Text style={{ fontSize: fontSize.sm, fontWeight: '700',
                                color: consumption < 0 ? colors.danger : colors.success }}>
                                {consumption < 0 ? '⚠' : '✓'} {Math.round(consumption)} units
                              </Text>
                              {unitCost ? (
                                <Text style={{ fontSize: fontSize.xs, color: '#2563EB', fontWeight: '700' }}>
                                  {fmtAmt(consumption * parseFloat(unitCost))}
                                </Text>
                              ) : null}
                            </View>
                          )}
                        </View>
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 10, color: colors.textTertiary, marginBottom: 3 }}>PREV READING</Text>
                            <View style={[S.input, { backgroundColor: 'rgba(240,234,224,0.5)', justifyContent: 'center' }]}>
                              <Text style={{ color: colors.textSecondary, fontSize: fontSize.sm }}>
                                {Math.round(row.previous_reading).toLocaleString('en-IN')}
                              </Text>
                            </View>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 10, color: colors.textTertiary, marginBottom: 3 }}>CURRENT READING *</Text>
                            <TextInput
                              style={S.input}
                              value={row.reading_end !== null && row.reading_end !== undefined ? String(row.reading_end) : ''}
                              onChangeText={(v) => updateRow(idx, v)}
                              placeholder="Enter reading"
                              placeholderTextColor={colors.textTertiary}
                              keyboardType="numeric"
                              editable={!isLocked}
                            />
                          </View>
                          {/* Meter photo upload — camera in Add flow, view after attached */}
                          <View style={{ alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 2 }}>
                            <TouchableOpacity
                              onPress={() => {
                                if (row.meter_photo_url) {
                                  Alert.alert('Meter Photo', 'What would you like to do?', [
                                    { text: 'View Photo', onPress: () => setLightboxUrl(row.meter_photo_url) },
                                    { text: 'Remove', style: 'destructive', onPress: () => setBulkRows(prev => prev.map((r, i) => i === idx ? { ...r, meter_photo_url: null } : r)) },
                                    { text: 'Cancel', style: 'cancel' },
                                  ]);
                                } else {
                                  pickMeterPhoto(idx);
                                }
                              }}
                              style={{
                                width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                                backgroundColor: row.meter_photo_url ? 'rgba(34,197,94,0.15)' : 'rgba(37,99,235,0.1)',
                                borderWidth: 1, borderColor: row.meter_photo_url ? '#22C55E' : 'rgba(37,99,235,0.3)',
                              }}
                            >
                              <Ionicons
                                name={row.meter_photo_url ? 'eye-outline' : 'camera-outline'}
                                size={17}
                                color={row.meter_photo_url ? '#22C55E' : '#2563EB'}
                              />
                            </TouchableOpacity>
                            <Text style={{ fontSize: 8, color: row.meter_photo_url ? '#22C55E' : colors.textTertiary, marginTop: 2, textAlign: 'center' }}>
                              {scanningIdx === idx ? 'Scanning…' : row.meter_photo_url ? 'View' : 'Photo'}
                            </Text>
                          </View>
                        </View>
                      </View>
                    );
                  })}
                </>
              ) : null}

              {/* Save button */}
              {bulkRows.length > 0 && (
                <TouchableOpacity
                  style={[S.saveBtn, (saving || isLocked) && { opacity: 0.5 }]}
                  onPress={handleSave}
                  disabled={saving || isLocked}
                >
                  {saving
                    ? <ActivityIndicator color="#fff" />
                    : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>
                        {isEditMode ? 'Update Readings' : 'Save All Readings'}
                      </Text>
                  }
                </TouchableOpacity>
              )}
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>

      {/* ── METER PHOTO LIGHTBOX ─────────────────────────────────────────── */}
      <Modal visible={!!lightboxUrl} transparent animationType="fade">
        <TouchableOpacity
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' }}
          activeOpacity={1}
          onPress={() => setLightboxUrl(null)}
        >
          {/* Close button */}
          <TouchableOpacity
            onPress={() => setLightboxUrl(null)}
            style={{ position: 'absolute', top: 52, right: 20, zIndex: 10, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' }}
          >
            <Ionicons name="close" size={22} color="#fff" />
          </TouchableOpacity>

          {/* Header */}
          <View style={{ position: 'absolute', top: 56, left: 20, right: 70 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>Meter Photo</Text>
            <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 2 }} numberOfLines={1}>{lightboxUrl}</Text>
          </View>

          {/* Image */}
          {lightboxUrl ? (
            <Image
              source={{ uri: lightboxUrl }}
              style={{ width: Dimensions.get('window').width - 32, height: Dimensions.get('window').height * 0.65, borderRadius: 12 }}
              resizeMode="contain"
            />
          ) : null}

          {/* Footer label */}
          <View style={{ position: 'absolute', bottom: 52, alignItems: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 }}>
              <Ionicons name="camera-outline" size={14} color="rgba(255,255,255,0.7)" />
              <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>Tap outside to close</Text>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── EB Rate Modal ───────────────────────────────────────────────────── */}
      <Modal visible={rateOpen} animationType="slide" presentationStyle="pageSheet">
        <View style={{ flex: 1 , backgroundColor: '#FFFFFF'}}>
          <SafeAreaView style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              paddingHorizontal: spacing.xl, paddingVertical: spacing.lg,
              borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>
              <TouchableOpacity onPress={() => setRateOpen(false)}>
                <Text style={{ color: colors.danger, fontSize: fontSize.md }}>Cancel</Text>
              </TouchableOpacity>
              <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#0F172A' }}>
                {rateForm.id ? 'Edit EB Rate' : 'Add EB Rate'}
              </Text>
              <View style={{ width: 60 }} />
            </View>

            <ScrollView style={{ padding: spacing.xl }}>
              <SectionLabel text="Property (blank = all properties)" />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.lg }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {[{ id: '', property_name: 'All Properties' }, ...properties].map((p: any) => {
                    const pid = p._id || p.id;
                    const active = (rateForm.property_id || '') === pid;
                    return (
                      <TouchableOpacity key={pid || 'all'}
                        onPress={() => setRateForm(f => ({ ...f, property_id: pid }))}
                        style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 99,
                          backgroundColor: active ? '#2563EB' : '#F1F3F9' }}>
                        <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>
                          {p.property_name || p.name || ""}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>

              <SectionLabel text="Unit Cost (₹) *" />
              <TextInput
                style={[S.input, { marginBottom: spacing.lg }]}
                value={rateForm.unit_cost}
                onChangeText={v => setRateForm(f => ({ ...f, unit_cost: v }))}
                placeholder="e.g. 8.50"
                placeholderTextColor={colors.textTertiary}
                keyboardType="numeric"
              />

              <SectionLabel text="From Date *" />
              <View style={{ marginBottom: spacing.lg }}>
                <DateField value={rateForm.from_date} onChange={v => setRateForm(f => ({ ...f, from_date: v }))} />
              </View>

              <SectionLabel text="To Date (blank = ongoing)" />
              <View style={{ marginBottom: spacing.xl }}>
                <DateField value={rateForm.to_date} onChange={v => setRateForm(f => ({ ...f, to_date: v }))} placeholder="Leave blank for ongoing" />
              </View>

              <TouchableOpacity
                style={[S.saveBtn, rateSaving && { opacity: 0.5 }]}
                onPress={handleSaveRate}
                disabled={rateSaving}
              >
                {rateSaving
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>
                      {rateForm.id ? 'Update Rate' : 'Create Rate'}
                    </Text>
                }
              </TouchableOpacity>
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
      {/* ── Add / Edit Payment Modal ─────────────────────────────────────── */}
      <Modal visible={paymentOpen} animationType="slide" presentationStyle="pageSheet">
        <View style={{ flex: 1, backgroundColor: '#FFFFFF' }}>
          <SafeAreaView style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>
              <TouchableOpacity onPress={() => setPaymentOpen(false)}>
                <Text style={{ color: colors.danger, fontSize: fontSize.md }}>Cancel</Text>
              </TouchableOpacity>
              <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#0F172A' }}>
                {paymentForm.id ? 'Edit Payment' : 'Add EB Payment'}
              </Text>
              <View style={{ width: 60 }} />
            </View>
            <ScrollView style={{ padding: spacing.xl }}>
              <SectionLabel text="Property *" />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.lg }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {properties.map((p: any) => {
                    const pid = p._id || p.id;
                    const active = paymentForm.property_id === pid;
                    return (
                      <TouchableOpacity key={pid} onPress={() => setPaymentForm(f => ({ ...f, property_id: pid }))}
                        style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 99, backgroundColor: active ? '#2563EB' : '#F1F3F9' }}>
                        <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>{p.property_name || p.name || ""}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>
              {/* Bill Date + Bill Amount side by side (mirrors web layout) */}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <DatePickerField label="Bill Date" required value={paymentForm.bill_date} onChange={v => setPaymentForm(f => ({ ...f, bill_date: v }))} />
                </View>
                <View style={{ flex: 1 }}>
                  <SectionLabel text="Bill Amount (₹) *" />
                  <TextInput style={[S.input, { marginBottom: spacing.lg }]} value={paymentForm.bill_amount} onChangeText={v => setPaymentForm(f => ({ ...f, bill_amount: v }))} placeholder="0.00" keyboardType="numeric" placeholderTextColor={colors.textTertiary} />
                </View>
              </View>

              {/* Payment Date + Mode side by side (mirrors web layout) */}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <DatePickerField label="Payment Date" value={paymentForm.payment_date} onChange={v => setPaymentForm(f => ({ ...f, payment_date: v }))} placeholder="Leave blank if unpaid" />
                </View>
                <View style={{ flex: 1 }}>
                  <SectionLabel text="Payment Mode" />
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: spacing.lg }}>
                    {PAYMENT_MODES.map(m => {
                      const active = paymentForm.payment_mode === m;
                      return (
                        <TouchableOpacity key={m} onPress={() => setPaymentForm(f => ({ ...f, payment_mode: active ? '' : m }))}
                          style={{ paddingHorizontal: 9, paddingVertical: 5, borderRadius: 99, backgroundColor: active ? '#2563EB' : '#F1F3F9' }}>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>{m}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              </View>

              {bankAccounts.length > 0 && (
                <>
                  <SectionLabel text={paymentForm.payment_mode && paymentForm.payment_mode !== 'Cash' ? 'Bank Account *' : 'Bank Account'} />
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.lg }}>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {bankAccounts.map((b: any) => {
                        const active = paymentForm.bank_account_id === b.id;
                        return (
                          <TouchableOpacity key={b.id} onPress={() => setPaymentForm(f => ({ ...f, bank_account_id: active ? '' : b.id }))}
                            style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 99, backgroundColor: active ? '#2563EB' : '#F1F3F9' }}>
                            <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>
                              {b.bank_name}{b.account_number ? ` ····${String(b.account_number).slice(-4)}` : ''}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </ScrollView>
                </>
              )}

              <SectionLabel text="Reference Number" />
              <TextInput style={[S.input, { marginBottom: spacing.lg }]} value={paymentForm.reference_number} onChangeText={v => setPaymentForm(f => ({ ...f, reference_number: v }))} placeholder="Transaction ref / UTR / Cheque no." placeholderTextColor={colors.textTertiary} />

              {/* Billing Period Start + End side by side (mirrors web layout) */}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <DatePickerField label="Period Start" value={paymentForm.billing_period_start} onChange={v => setPaymentForm(f => ({ ...f, billing_period_start: v }))} />
                </View>
                <View style={{ flex: 1 }}>
                  <DatePickerField label="Period End" value={paymentForm.billing_period_end} onChange={v => setPaymentForm(f => ({ ...f, billing_period_end: v }))} />
                </View>
              </View>

              <SectionLabel text="Notes" />
              <TextInput style={[S.input, { marginBottom: spacing.xl, minHeight: 70, textAlignVertical: 'top' }]} value={paymentForm.notes} onChangeText={v => setPaymentForm(f => ({ ...f, notes: v }))} placeholder="Any notes…" placeholderTextColor={colors.textTertiary} multiline />
              <TouchableOpacity style={[S.saveBtn, { backgroundColor: '#2563EB' }, paymentSaving && { opacity: 0.5 }]} onPress={handleSavePayment} disabled={paymentSaving}>
                {paymentSaving ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>{paymentForm.id ? 'Update Payment' : 'Save Payment'}</Text>}
              </TouchableOpacity>
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>

      {/* ── Bulk EB Payment Entry Modal ───────────────────────────────────── */}
      <Modal visible={bulkPayOpen} animationType="slide" presentationStyle="pageSheet">
        <View style={{ flex: 1, backgroundColor: '#FFFFFF' }}>
          <SafeAreaView style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>
              <TouchableOpacity onPress={() => setBulkPayOpen(false)}>
                <Text style={{ color: colors.danger, fontSize: fontSize.md }}>Cancel</Text>
              </TouchableOpacity>
              <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#0F172A' }}>Bulk EB Payments</Text>
              <View style={{ width: 60 }} />
            </View>
            <ScrollView style={{ padding: spacing.xl }} contentContainerStyle={{ paddingBottom: 60 }}>
              <SectionLabel text="Property *" />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.lg }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {properties.map((p: any) => {
                    const pid = p._id || p.id;
                    const active = bulkPayProperty === pid;
                    return (
                      <TouchableOpacity key={pid} onPress={() => { setBulkPayProperty(pid); loadBulkPayRows(pid, bulkPayBillDate); }}
                        style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 99, backgroundColor: active ? '#2563EB' : '#F1F3F9' }}>
                        <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>{p.property_name || p.name || ""}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>
              <DatePickerField label="Bill Date" required value={bulkPayBillDate} onChange={v => { setBulkPayBillDate(v); if (bulkPayProperty) loadBulkPayRows(bulkPayProperty, v); }} />
              <View style={{ marginBottom: spacing.lg }} />
              <DatePickerField label="Payment Date" value={bulkPayDate} onChange={setBulkPayDate} placeholder="Leave blank if unpaid" />
              <SectionLabel text="Payment Mode" />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.lg }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {PAYMENT_MODES.map(m => {
                    const active = bulkPayMode === m;
                    return (
                      <TouchableOpacity key={m} onPress={() => setBulkPayMode(active ? '' : m)}
                        style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99, backgroundColor: active ? '#2563EB' : '#F1F3F9' }}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>{m}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>

              {bankAccounts.length > 0 && (
                <>
                  <SectionLabel text={bulkPayMode && bulkPayMode !== 'Cash' ? 'Bank Account *' : 'Bank Account'} />
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.lg }}>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {bankAccounts.map((b: any) => {
                        const active = bulkPayBankId === b.id;
                        return (
                          <TouchableOpacity key={b.id} onPress={() => setBulkPayBankId(active ? '' : b.id)}
                            style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99, backgroundColor: active ? '#2563EB' : '#F1F3F9' }}>
                            <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>
                              {b.bank_name}{b.account_number ? ` ····${String(b.account_number).slice(-4)}` : ''}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </ScrollView>
                </>
              )}

              {bulkPayLoading ? (
                <ActivityIndicator color="#2563EB" style={{ marginTop: 24 }} />
              ) : bulkPayRows.length > 0 ? (
                <>
                  <SectionLabel text="Bill Amounts per Apartment" />
                  {bulkPayRows.map((row, idx) => (
                    <View key={row.apartment_id} style={[S.bulkRow, { marginBottom: 8 }]}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: '#0F172A' }}>{row.apartment_code}</Text>
                        {row.existing_id && <Pill label="Existing" color="#16A34A" bg="#DCFCE7" />}
                      </View>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <View style={{ flex: 2 }}>
                          <Text style={{ fontSize: 10, color: colors.textTertiary, marginBottom: 3 }}>BILL AMOUNT (₹)</Text>
                          <TextInput
                            style={S.input}
                            value={row.bill_amount}
                            onChangeText={v => setBulkPayRows(prev => prev.map((r, i) => i === idx ? { ...r, bill_amount: v } : r))}
                            placeholder="0"
                            placeholderTextColor={colors.textTertiary}
                            keyboardType="numeric"
                          />
                        </View>
                        <View style={{ flex: 2 }}>
                          <Text style={{ fontSize: 10, color: colors.textTertiary, marginBottom: 3 }}>REFERENCE NO.</Text>
                          <TextInput
                            style={S.input}
                            value={row.reference_number}
                            onChangeText={v => setBulkPayRows(prev => prev.map((r, i) => i === idx ? { ...r, reference_number: v } : r))}
                            placeholder="Optional"
                            placeholderTextColor={colors.textTertiary}
                          />
                        </View>
                      </View>
                    </View>
                  ))}
                  <TouchableOpacity style={[S.saveBtn, { backgroundColor: '#2563EB', marginTop: 8 }, bulkPaySaving && { opacity: 0.5 }]} onPress={handleSaveBulkPayments} disabled={bulkPaySaving}>
                    {bulkPaySaving ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>Save All Payments</Text>}
                  </TouchableOpacity>
                </>
              ) : bulkPayProperty ? (
                <View style={{ alignItems: 'center', paddingVertical: 32 }}>
                  <Text style={{ color: colors.textTertiary }}>No live apartments found for this property</Text>
                </View>
              ) : null}
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF', borderRadius: 16,
    borderWidth: 1, borderColor: '#EEF1F6',
    padding: 14, marginBottom: 10,
    shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
  kpiVal: { fontSize: fontSize.lg, fontWeight: '800', color: '#0F172A', marginTop: 4, letterSpacing: -0.3 },
  kpiLabel: { fontSize: fontSize.xs, color: '#64748B', marginTop: 2 },
  th: { fontSize: 10, fontWeight: '700', color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.5 },
  td: { fontSize: fontSize.xs, color: '#0F172A' },
  iconBtn: {
    width: 32, height: 32, borderRadius: 10,
    backgroundColor: '#EFF6FF',
    alignItems: 'center', justifyContent: 'center',
  },
  menuBtn: {
    width: 38, height: 38, borderRadius: 99,
    backgroundColor: '#EFF6FF',
    alignItems: 'center', justifyContent: 'center',
  },
  fab: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: '#2563EB',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#0F172A', shadowOpacity: 0.15, shadowRadius: 10, elevation: 5,
  },
  addRateBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#2563EB', borderRadius: 12,
    paddingHorizontal: 16, paddingVertical: 10,
    alignSelf: 'flex-end', marginBottom: 12,
  },
  input: {
    backgroundColor: '#FFFFFF', borderRadius: 12,
    borderWidth: 1.5, borderColor: '#EEF1F6',
    paddingHorizontal: 14, paddingVertical: 10,
    fontSize: fontSize.md, color: '#0F172A',
    marginBottom: 0,
  },
  bulkRow: {
    backgroundColor: '#FFFFFF', borderRadius: 16,
    borderWidth: 1, borderColor: '#EEF1F6',
    padding: 14, marginBottom: 10,
  },
  saveBtn: {
    backgroundColor: '#2563EB', borderRadius: 12,
    paddingVertical: 14, alignItems: 'center',
    marginTop: 8,
    shadowColor: '#0F172A', shadowOpacity: 0.12, shadowRadius: 10, elevation: 4,
  },
});
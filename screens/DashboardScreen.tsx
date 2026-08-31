import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TouchableOpacity,
  Dimensions, Image, Animated, StyleSheet, Modal, TextInput,
  TouchableWithoutFeedback, ActivityIndicator, StatusBar, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Path, Circle, Line as SvgLine, Defs,
  LinearGradient as SvgGradient, Stop,
} from 'react-native-svg';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { spacing, fontSize, mobile, colors as themeColors, shadows } from '../lib/theme';
import { LoadingScreen, DateField } from '../components/shared';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { fetchTickets } from '../services/ticketService';
import { client, api } from '../lib/convexApi';
import { getHeroMonthly, getDuesTotals, getTenantPunctuality } from '../lib/dashboardMetrics';
import { useQuery } from '@tanstack/react-query';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ─── Tokens (web dashboard parity) ───────────────────────────────────────────
const DASH = {
  bg: '#FFFFFF',
  ink: '#0F172A',
  ink2: '#64748B',
  ink3: '#94A3B8',
  indigo: '#6A2C90',
  brandSub: '#556274',
  blue: '#1856FF',
  blueInk: '#1240C7',
  blueSoft: '#EEF3FF',
  line: '#E2E8F0',
  panelBorder: '#DFE6F3',
  good: '#16A34A',
  goodBg: '#DCFCE7',
  warn: '#EA580C',
  warnBg: '#FFEDD5',
  bad: '#DC2626',
  badBg: '#FEE2E2',
  ok: '#CA8A04',
  soft: '#F8FAFC',
  finHero: '#F0F4FC',
  attnDark: '#2449BD',
  padX: 16,
};

const BRAND = {
  purple: mobile.accent,
  purpleDeep: mobile.brandDeep,
  orange: mobile.accentStrong,
  ink900: themeColors.text,
  ink500: themeColors.textSecondary,
  ink400: themeColors.textTertiary,
  ink300: '#CBD5E1',
  surface: themeColors.background,
  panel: themeColors.surface,
  panelBorder: themeColors.border,
  divider: themeColors.border,
  soft: mobile.brandSoft,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtINR(n: number): string {
  if (Math.abs(n) >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (Math.abs(n) >= 1000) return `₹${(n / 1000).toFixed(1)}k`;
  return `₹${n.toLocaleString('en-IN')}`;
}

function fmtDate(s?: string): string {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning.';
  if (h < 17) return 'Good afternoon.';
  return 'Good evening.';
}

/** Web period presets (+ custom for mobile power users). */
const PERIODS: { key: string; label: string }[] = [
  { key: 'current_fy', label: 'Current FY' },
  { key: 'last_fy', label: 'Last FY' },
  { key: 'last_6m', label: 'Last 6 months' },
  { key: 'this_month', label: 'This month' },
  { key: 'custom', label: 'Custom Range' },
];

function periodLabel(key: string, from?: string, to?: string): string {
  if (key === 'custom') {
    if (from && to) {
      const f = from.split('-').reverse().slice(0, 2).join('/');
      const t = to.split('-').reverse().slice(0, 2).join('/');
      return `${f} – ${t}`;
    }
    return 'Custom Range';
  }
  return PERIODS.find(p => p.key === key)?.label || 'Current FY';
}

/** Map UI period keys to API args (Convex + punctuality RPC). */
function toApiPeriod(period: string, customFrom: string, customTo: string) {
  const today = new Date();
  if (period === 'this_month') {
    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    return { period: 'custom', customFrom: ymd(from), customTo: ymd(today) };
  }
  if (period === 'last_6m') {
    const from = new Date(today);
    from.setMonth(from.getMonth() - 6);
    return { period: 'custom', customFrom: ymd(from), customTo: ymd(today) };
  }
  return { period, customFrom, customTo };
}

// ─── Panel chrome ────────────────────────────────────────────────────────────
function Panel({
  title, right, children, darkHead,
}: {
  title: string; right?: string; children: React.ReactNode; darkHead?: boolean;
}) {
  return (
    <View style={[styles.panel, darkHead && styles.panelAttention]}>
      {darkHead ? (
        <LinearGradient
          colors={['#6A2C90', '#4E2069'] as const}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.panelHeadDark}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name="alert-circle" size={16} color="#fff" />
            <Text style={styles.panelTitleDark}>{title}</Text>
          </View>
        </LinearGradient>
      ) : (
        <View style={styles.panelHead}>
          <Text style={styles.panelTitle}>{title}</Text>
          {right ? <Text style={styles.panelRight}>{right}</Text> : null}
        </View>
      )}
      <View style={styles.panelBody}>{children}</View>
    </View>
  );
}

function OccupancyRing({ pct, size = 88 }: { pct: number; size?: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const stroke = 8;
  const inner = size - stroke * 2;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          position: 'absolute', width: size, height: size, borderRadius: size / 2,
          borderWidth: stroke, borderColor: '#E8EEF8',
        }}
      />
      {/* Approximate ring using 4 arcs via border colors */}
      <View
        style={{
          position: 'absolute', width: size, height: size, borderRadius: size / 2,
          borderWidth: stroke,
          borderTopColor: clamped > 12 ? DASH.blue : '#E8EEF8',
          borderRightColor: clamped > 37 ? DASH.blue : '#E8EEF8',
          borderBottomColor: clamped > 62 ? DASH.blue : '#E8EEF8',
          borderLeftColor: clamped > 87 ? DASH.blue : '#E8EEF8',
          transform: [{ rotate: '-45deg' }],
        }}
      />
      <View
        style={{
          width: inner, height: inner, borderRadius: inner / 2,
          backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: 22, fontWeight: '800', color: DASH.ink, letterSpacing: -0.5 }}>
          {clamped}%
        </Text>
      </View>
    </View>
  );
}

function MiniSpark({ values, light }: { values: number[]; light?: boolean }) {
  if (!values.length) return null;
  const max = Math.max(...values, 1);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 36 }}>
      {values.map((v, i) => (
        <View
          key={i}
          style={{
            width: 6,
            height: Math.max(4, (v / max) * 36),
            borderRadius: 3,
            backgroundColor: light
              ? (i === values.length - 1 ? '#FFFFFF' : 'rgba(255,255,255,0.45)')
              : (i === values.length - 1 ? DASH.blue : '#A5B4FC'),
          }}
        />
      ))}
    </View>
  );
}

// ─── Tooltip bubble ──────────────────────────────────────────────────────────
function Tooltip({ label, value, x, y, visible }: { label: string; value: string; x: number; y: number; visible: boolean }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(anim, { toValue: visible ? 1 : 0, useNativeDriver: true, speed: 22, bounciness: 8 }).start();
  }, [visible]);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: Math.max(0, x - 36),
        top: Math.max(0, y - 44),
        opacity: anim,
        transform: [{ scale: anim }],
        backgroundColor: BRAND.purpleDeep,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 4,
        zIndex: 99,
        minWidth: 72,
        alignItems: 'center',
        shadowColor: '#000',
        shadowOpacity: 0.18,
        shadowRadius: 6,
        elevation: 6,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: '800', color: '#fff' }}>{value}</Text>
      <Text style={{ fontSize: 9, color: 'rgba(255,255,255,0.7)', marginTop: 1 }}>{label}</Text>
      <View style={{
        position: 'absolute', bottom: -5, left: 36 - 5, width: 10, height: 10,
        backgroundColor: BRAND.purpleDeep, transform: [{ rotate: '45deg' }], borderRadius: 2,
      }} />
    </Animated.View>
  );
}

// ─── Mini bar chart ──────────────────────────────────────────────────────────
function MiniBarChart({
  data, valueKey, color = BRAND.orange, height = 72,
}: { data: { label: string; [k: string]: any }[]; valueKey: string; color?: string; height?: number }) {
  const anims = useRef(data.map(() => new Animated.Value(0))).current;
  const [tooltip, setTooltip] = useState<{ idx: number; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!data || data.length === 0) return;
    Animated.stagger(60, anims.map(a =>
      Animated.spring(a, { toValue: 1, useNativeDriver: false, speed: 14, bounciness: 6 })
    )).start();
  }, [data.length]);

  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map((d) => d[valueKey] || 0), 1);
  const BAR_WIDTH_RATIO = 0.62;

  return (
    <View style={{ position: 'relative' }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height, gap: 8, paddingHorizontal: 4 }}>
        {data.map((d, i) => {
          const pct = (d[valueKey] || 0) / max;
          const isPeak = pct > 0.85;
          const barH = Math.max(4, pct * height * 0.9);
          const animatedH = anims[i]?.interpolate({
            inputRange: [0, 1], outputRange: [0, barH],
          }) ?? barH;

          return (
            <TouchableOpacity
              key={i}
              activeOpacity={0.85}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}
              onPress={() => {
                setTooltip(prev => prev?.idx === i ? null : {
                  idx: i,
                  x: (i + 0.5) * ((SCREEN_WIDTH - 80) / data.length),
                  y: Math.max(0, height - barH - 8),
                });
              }}
            >
              <Animated.View style={{ width: '100%', alignItems: 'center', justifyContent: 'flex-end', height: animatedH }}>
                <LinearGradient
                  colors={
                    tooltip?.idx === i
                      ? [BRAND.purple, BRAND.purpleDeep]
                      : isPeak
                        ? [BRAND.purple, BRAND.orange]
                        : [`${color}CC`, `${color}66`]
                  }
                  start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
                  style={{ width: `${BAR_WIDTH_RATIO * 100}%`, height: '100%', borderRadius: 6 }}
                />
              </Animated.View>
            </TouchableOpacity>
          );
        })}
      </View>
      {tooltip !== null && (
        <Tooltip
          visible
          label={data[tooltip.idx]?.label ?? ''}
          value={fmtINR(data[tooltip.idx]?.[valueKey] || 0)}
          x={tooltip.x}
          y={tooltip.y}
        />
      )}
      <View style={{ flexDirection: 'row', marginTop: 6, paddingHorizontal: 4 }}>
        {data.map((d, i) => (
          <Text
            key={i}
            style={{
              flex: 1, fontSize: 10,
              color: tooltip?.idx === i ? BRAND.purple : BRAND.ink400,
              fontWeight: tooltip?.idx === i ? '800' : '600',
              textAlign: 'center',
            }}
            numberOfLines={1}
          >
            {d.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

// ─── Mini line chart ─────────────────────────────────────────────────────────
function MiniLineChart({
  data, valueKey, color = BRAND.purple, height = 60,
}: { data: { label: string; [k: string]: any }[]; valueKey: string; color?: string; height?: number }) {
  const drawAnim = useRef(new Animated.Value(0)).current;
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!data || data.length < 2) return;
    drawAnim.setValue(0);
    Animated.timing(drawAnim, { toValue: 1, duration: 900, useNativeDriver: false }).start();
  }, [data.length]);

  if (!data || data.length < 2) return null;

  const max = Math.max(...data.map((d) => d[valueKey] || 0), 1);
  const min = Math.min(...data.map((d) => d[valueKey] || 0));
  const range = Math.max(max - min, 1);
  const W = SCREEN_WIDTH - 80;
  const step = W / Math.max(data.length - 1, 1);
  const THICK = 2.5;
  const DOT_R = 5;
  const yFor = (val: number) => height - ((val - min) / range) * height * 0.85;

  const segments = data.slice(1).map((d, i) => {
    const x1 = i * step;
    const y1 = yFor(data[i][valueKey] || 0);
    const x2 = (i + 1) * step;
    const y2 = yFor(d[valueKey] || 0);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    const ang = Math.atan2(dy, dx) * (180 / Math.PI);
    const cx = (x1 + x2) / 2 - len / 2;
    const cy = (y1 + y2) / 2 - THICK / 2;
    return { len, ang, cx, cy, idx: i };
  });

  return (
    <View style={{ height: height + 24 }}>
      <View style={{ height, position: 'relative' }}>
        {segments.map((s, i) => {
          const segStart = i / segments.length;
          const segEnd = (i + 1) / segments.length;
          const opacity = drawAnim.interpolate({
            inputRange: [segStart, Math.min(segEnd, 1)],
            outputRange: [0, 1],
            extrapolate: 'clamp',
          });
          return (
            <Animated.View
              key={`seg-${i}`}
              style={{
                position: 'absolute', left: s.cx, top: s.cy,
                width: s.len, height: THICK,
                backgroundColor: activeIdx === i || activeIdx === i + 1 ? BRAND.orange : color,
                borderRadius: 2,
                transform: [{ rotate: `${s.ang}deg` }],
                opacity,
              }}
            />
          );
        })}
        {data.map((d, i) => {
          const x = i * step;
          const y = yFor(d[valueKey] || 0);
          const active = activeIdx === i;
          return (
            <TouchableOpacity
              key={`dot-${i}`}
              activeOpacity={0.7}
              onPress={() => setActiveIdx(prev => prev === i ? null : i)}
              style={{
                position: 'absolute',
                left: x - DOT_R * (active ? 1.6 : 1),
                top: y - DOT_R * (active ? 1.6 : 1),
                width: DOT_R * (active ? 3.2 : 2),
                height: DOT_R * (active ? 3.2 : 2),
                borderRadius: DOT_R * (active ? 1.6 : 1),
                backgroundColor: active ? BRAND.orange : color,
                borderWidth: active ? 2 : 1.5,
                borderColor: '#fff',
                zIndex: 10,
              }}
            />
          );
        })}
        {activeIdx !== null && (
          <Tooltip
            visible
            label={data[activeIdx]?.label ?? ''}
            value={fmtINR(data[activeIdx]?.[valueKey] || 0)}
            x={activeIdx * step}
            y={yFor(data[activeIdx]?.[valueKey] || 0)}
          />
        )}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
        {data.map((d, i) => (
          <Text key={i} style={{ fontSize: 9, color: activeIdx === i ? BRAND.purple : BRAND.ink400, fontWeight: activeIdx === i ? '800' : '600' }}>
            {d.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

// ─── Smooth SVG helpers (reference-parity charts) ────────────────────────────
/** Catmull-Rom → cubic-bezier so the revenue line reads as a smooth curve. */
function smoothLinePath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return pts.length === 1 ? `M ${pts[0].x} ${pts[0].y}` : '';
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

/** Reference "Revenue trend" card chart: gradient area + smooth line + endpoint dot. */
function RevenueTrendChart({
  values, labels, width, height = 132,
}: { values: number[]; labels: string[]; width: number; height?: number }) {
  if (values.length < 2 || width <= 0) return null;
  const padTop = 16, padBottom = 4, padLeft = 2, padRight = 6;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(max - min, 1);
  const stepX = chartW / (values.length - 1);
  const pts = values.map((v, i) => ({
    x: padLeft + i * stepX,
    y: padTop + chartH - ((v - min) / range) * chartH,
  }));
  const linePath = smoothLinePath(pts);
  const last = pts[pts.length - 1];
  const baseY = padTop + chartH;
  const areaPath = `${linePath} L ${last.x} ${baseY} L ${pts[0].x} ${baseY} Z`;
  return (
    <View>
      <Svg width={width} height={height}>
        <Defs>
          <SvgGradient id="revArea" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#6A2C90" stopOpacity={0.22} />
            <Stop offset="1" stopColor="#6A2C90" stopOpacity={0} />
          </SvgGradient>
        </Defs>
        <Path d={areaPath} fill="url(#revArea)" />
        <SvgLine
          x1={last.x} y1={padTop - 8} x2={last.x} y2={baseY}
          stroke="#C7D2FE" strokeWidth={1} strokeDasharray="3 3"
        />
        <Path
          d={linePath} fill="none" stroke="#6A2C90" strokeWidth={2.5}
          strokeLinecap="round" strokeLinejoin="round"
        />
        <Circle cx={last.x} cy={last.y} r={8} fill="#6A2C90" fillOpacity={0.16} />
        <Circle cx={last.x} cy={last.y} r={4.5} fill="#fff" stroke="#6A2C90" strokeWidth={2.5} />
      </Svg>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 }}>
        {labels.map((l, i) => (
          <Text key={i} style={[styles.trendAxis, i === labels.length - 1 && { color: DASH.ink }]}>{l}</Text>
        ))}
      </View>
    </View>
  );
}

/** Reference occupancy widget: concentric multi-ring donut with a centred headline. */
function MultiRingDonut({
  rings, size = 116, center, sub,
}: { rings: { pct: number; color: string }[]; size?: number; center: string; sub?: string }) {
  const stroke = 8;
  const gap = 3;
  const cx = size / 2, cy = size / 2;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size}>
        {rings.map((ring, i) => {
          const r = size / 2 - stroke / 2 - i * (stroke + gap);
          if (r <= 4) return null;
          const c = 2 * Math.PI * r;
          const dash = (Math.max(0, Math.min(100, ring.pct)) / 100) * c;
          return (
            <React.Fragment key={i}>
              <Circle cx={cx} cy={cy} r={r} stroke="#EEF2F8" strokeWidth={stroke} fill="none" />
              <Circle
                cx={cx} cy={cy} r={r} stroke={ring.color} strokeWidth={stroke} fill="none"
                strokeDasharray={`${dash} ${c - dash}`} strokeLinecap="round"
                transform={`rotate(-90 ${cx} ${cy})`}
              />
            </React.Fragment>
          );
        })}
      </Svg>
      <View style={{ position: 'absolute', alignItems: 'center' }}>
        <Text style={styles.donutCenter}>{center}</Text>
        {sub ? <Text style={styles.donutSub}>{sub}</Text> : null}
      </View>
    </View>
  );
}

// ─── Period Selector Modal ────────────────────────────────────────────────────
function PeriodModal({
  visible, onClose, period, customFrom, customTo, onSelectPreset, onApplyCustom,
}: {
  visible: boolean; onClose: () => void; period: string;
  customFrom: string; customTo: string;
  onSelectPreset: (key: string) => void;
  onApplyCustom: (from: string, to: string) => void;
}) {
  const [showCustom, setShowCustom] = useState(period === 'custom');
  const [from, setFrom] = useState(customFrom);
  const [to, setTo] = useState(customTo);

  useEffect(() => {
    if (visible) {
      setShowCustom(period === 'custom');
      setFrom(customFrom || '');
      setTo(customTo || '');
    }
  }, [visible]);

  const validDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const applyCustom = () => {
    if (!validDate(from) || !validDate(to)) return;
    onApplyCustom(from, to);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={{ flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', padding: 28 }}>
          <TouchableWithoutFeedback>
            <View style={{ backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', maxWidth: 320, alignSelf: 'center', width: '100%' }}>
              <View style={{ backgroundColor: '#6A2C90', paddingHorizontal: 16, paddingVertical: 12 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>Period</Text>
              </View>

              {!showCustom ? (
                <View style={{ paddingVertical: 4 }}>
                  {PERIODS.map((p) => (
                    <TouchableOpacity
                      key={p.key}
                      onPress={() => { if (p.key === 'custom') setShowCustom(true); else onSelectPreset(p.key); }}
                      style={{
                        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                        paddingHorizontal: 16, paddingVertical: 12,
                        backgroundColor: period === p.key ? '#EEF2FF' : '#fff',
                        marginHorizontal: 6, marginVertical: 2, borderRadius: 10,
                        borderWidth: period === p.key ? 1 : 0, borderColor: '#C7D2FE',
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: period === p.key ? '700' : '500', color: period === p.key ? DASH.blueInk : DASH.ink }}>
                        {p.label}
                      </Text>
                      {period === p.key && <Ionicons name="checkmark" size={18} color={DASH.indigo} />}
                      {p.key === 'custom' && period !== 'custom' && <Ionicons name="chevron-forward" size={16} color={DASH.ink3} />}
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                <View style={{ padding: 16 }}>
                  <TouchableOpacity onPress={() => setShowCustom(false)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 14 }}>
                    <Ionicons name="chevron-back" size={16} color={DASH.blue} />
                    <Text style={{ fontSize: 13, fontWeight: '700', color: DASH.blue }}>Back to presets</Text>
                  </TouchableOpacity>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: DASH.ink2, marginBottom: 4 }}>From</Text>
                  <View style={{ marginBottom: 12 }}>
                    <DateField value={from} onChange={setFrom} placeholder="Select start date" />
                  </View>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: DASH.ink2, marginBottom: 4 }}>To</Text>
                  <View style={{ marginBottom: 16 }}>
                    <DateField value={to} onChange={setTo} placeholder="Select end date" />
                  </View>
                  <TouchableOpacity
                    onPress={applyCustom}
                    disabled={!validDate(from) || !validDate(to)}
                    style={{
                      backgroundColor: (validDate(from) && validDate(to)) ? DASH.blue : '#CBD5E1',
                      borderRadius: 12, paddingVertical: 13, alignItems: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>Apply Custom Range</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function DashboardScreen() {
  const { user, token, logout } = useAuth();
  const navigation = useNavigation();

  const confirmSignOut = () => {
    Alert.alert(
      user?.userName ? `Sign out of ${user.userName}?` : 'Sign out?',
      'You’ll need your mobile number to sign back in.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => logout() },
      ],
    );
  };

  const [periodOpen, setPeriodOpen] = useState(false);
  const [period, setPeriod] = useState<string>('current_fy');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [trendRange, setTrendRange] = useState<3 | 6 | 12>(6);

  // Ask AI modal state
  const [aiOpen, setAiOpen] = useState(false);
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiAnswer, setAiAnswer] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');

  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(20)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 480, useNativeDriver: true }),
      Animated.timing(slideUp, { toValue: 0, duration: 520, useNativeDriver: true }),
    ]).start();
  }, []);

  const EMPTY_DASHBOARD = {
    totalProperties: 0, totalTenants: 0, totalBeds: 0,
    vacantBeds: 0, occupiedBeds: 0, liveBeds: 0, liveApartments: 0,
    monthlyRevenue: 0, pendingPayments: 0,
    electricityPending: 0, occupancyByProperty: [],
  };

  const EMPTY_EXTENDED = {
    financials: {
      totalRevenue: 0, totalExpenses: 0, totalProfit: 0,
      pendingAmount: 0, operationalCollections: 0,
      ebBilled: 0, ebPaid: 0, ebMargin: 0, revPerBed: 0,
    },
    financialSeries: [],
    bedTypeOccupancy: [],
    needsAttention: [],
    tenantPayments: { paidOnOrBefore7th: 0, starCustomers: [] },
    announcements: [],
  };

  const dashboardQuery = useQuery({
    queryKey: ['dashboard', period, customFrom, customTo],
    enabled: !!token,
    queryFn: async () => {
      const apiPeriod = toApiPeriod(period, customFrom, customTo);
      const extArgs = apiPeriod.period === 'custom'
        ? { period: 'custom', customFrom: apiPeriod.customFrom, customTo: apiPeriod.customTo }
        : { period: apiPeriod.period };

      const [data, tickets, ext, hero, dues, punc, disc] = await Promise.all([
        sb.getDashboardData(),
        fetchTickets('admin').catch(() => []),
        client.action(api.dashboard.getExtendedStats, extArgs).catch(() => EMPTY_EXTENDED),
        getHeroMonthly().catch(() => null),
        getDuesTotals().catch(() => null),
        getTenantPunctuality(token!, apiPeriod.period, apiPeriod.customFrom, apiPeriod.customTo).catch(() => null),
        sb.getBedTenantDiscrepancies().catch(() => ({ bed: 0, tenant: 0 })),
      ]);
      return {
        stats: data ?? EMPTY_DASHBOARD,
        tickets: tickets || [],
        extended: ext ?? EMPTY_EXTENDED,
        heroMonthly: hero,
        duesTotals: dues,
        punctuality: punc,
        discrepancies: disc ?? { bed: 0, tenant: 0 },
      };
    },
  });

  const stats = dashboardQuery.data?.stats ?? null;
  const tickets: any[] = dashboardQuery.data?.tickets ?? [];
  const extended = dashboardQuery.data?.extended ?? null;
  const heroMonthly = dashboardQuery.data?.heroMonthly ?? null;
  const duesTotals = dashboardQuery.data?.duesTotals ?? null;
  const punctuality = dashboardQuery.data?.punctuality ?? null;
  const discrepancies = (dashboardQuery.data as any)?.discrepancies ?? { bed: 0, tenant: 0 };
  const isRefreshing = dashboardQuery.isRefetching;
  const isBackgroundUpdating = dashboardQuery.isFetching && !!dashboardQuery.data;

  const { refetch } = dashboardQuery;
  useFocusEffect(React.useCallback(() => { refetch(); }, [refetch]));
  useFocusEffect(
    React.useCallback(() => {
      StatusBar.setBarStyle('dark-content');
      return () => StatusBar.setBarStyle('dark-content');
    }, [])
  );

  const onRefresh = useCallback(() => { refetch(); }, [refetch]);

  if (!stats) return <LoadingScreen />;

  const fin = extended?.financials ?? EMPTY_EXTENDED.financials;
  const finSeries: any[] = extended?.financialSeries ?? [];
  const bedTypes: any[] = extended?.bedTypeOccupancy ?? [];
  const needsAtt: any[] = extended?.needsAttention ?? [];
  const tenantPay = extended?.tenantPayments ?? { paidOnOrBefore7th: 0, starCustomers: [] };

  const ps = extended?.propertyStatus ?? null;
  const totalBedsLive = ps?.total ?? stats.liveBeds ?? 0;
  const occupiedBedsV = ps?.occupied ?? stats.occupiedBeds ?? 0;
  const noticeBedsV = ps?.notice ?? stats.noticeBeds ?? 0;
  const bookedBedsV = ps?.booked ?? stats.bookedBeds ?? 0;
  const vacantBedsV = ps?.vacant ?? Math.max(0, totalBedsLive - occupiedBedsV - noticeBedsV - bookedBedsV);
  const occupancyPct = ps?.occupancyPct != null
    ? Math.round(Number(ps.occupancyPct))
    : Math.round(((occupiedBedsV + noticeBedsV) / Math.max(1, totalBedsLive)) * 100);
  // "Month" bed-days occupancy (reads higher than point-in-time) — distinct from the headline.
  const monthOcc = (extended as any)?.monthOccupancy ?? null;
  const monthOccRaw = monthOcc?.occupancyPct ?? monthOcc?.occupancy_rate ?? null;
  const monthOccPct = monthOccRaw != null ? Math.round(Number(monthOccRaw) * 10) / 10 : occupancyPct;
  // Pure occupied fill (excludes on-notice) — the innermost donut ring.
  const occupiedFillPct = Math.round((occupiedBedsV / Math.max(1, totalBedsLive)) * 100);

  const depositsHeldV = fin.depositCollections ?? heroMonthly?.depositsHeld ?? 0;
  const pendingDuesV = (fin.pendingAmount ?? 0) > 0
    ? fin.pendingAmount
    : (duesTotals?.receivables ?? 0);

  const punc = punctuality ?? null;
  const onTimeV = punc?.onTimeTenants ?? tenantPay.paidOnOrBefore7th ?? 0;
  const lateV = punc?.lateTenants ?? 0;
  const unpaidV = punc?.unpaidTenants ?? 0;
  const unpaidInvoicesV = punc?.unpaidInvoices ?? 0;
  const invoicedV = punc?.invoicedTenants ?? 0;
  const collRateV = punc?.collectionRatePct != null ? Math.round(Number(punc.collectionRatePct)) : null;
  const awesomeList: any[] = Array.isArray(punc?.awesome) ? punc.awesome : [];
  const starList: any[] = Array.isArray(punc?.stars) ? punc.stars : (tenantPay.starCustomers ?? []);

  const revenueHeadline = heroMonthly?.revenueThisMonth ?? fin.operationalCollections ?? fin.totalRevenue ?? stats.monthlyRevenue ?? 0;
  const momPct = heroMonthly?.momPct;
  const sparkVals = finSeries.slice(-6).map((d: any) => Number(d.revenue || 0));

  // Revenue-trend card (reference): one smooth line, 3M/6M/12M window on the revenue series.
  const trendSeries = finSeries.slice(-trendRange);
  const trendValues = trendSeries.map((d: any) => Number(d.revenue || 0));
  const trendLabels = trendSeries.length
    ? [
        trendSeries[0]?.label ?? '',
        trendSeries[Math.floor((trendSeries.length - 1) / 2)]?.label ?? '',
        trendSeries[trendSeries.length - 1]?.label ?? '',
      ]
    : [];
  const trendEndLabel = trendSeries[trendSeries.length - 1]?.label ?? '';
  const TREND_W = SCREEN_WIDTH - DASH.padX * 2 - 24 - 28; // scroll padX·2 · panel body pad·2 · card pad·2
  // Per-card mini sparklines — only where a real monthly series exists (no fabrication).
  const revenueSpark = finSeries.slice(-8).map((d: any) => Number(d.revenue || 0));
  const expensesSpark = finSeries.slice(-8).map((d: any) => Number(d.expenses || 0));

  const profitMargin = fin.totalRevenue > 0
    ? Math.round((fin.totalProfit / fin.totalRevenue) * 100)
    : 0;
  const ebMarginPct = fin.ebBilled > 0
    ? Math.round((fin.ebMargin / fin.ebBilled) * 100)
    : 0;

  // Action queue — mirror web chip labels, driven by live ticket statuses
  const tenantApprovalN = tickets.filter(t => t.status === 'pending_tenant_approval').length;
  const costApprovalN = tickets.filter(t => t.status === 'waiting_for_cost_approval').length;
  const adminApprovalN = tickets.filter(t => t.status === 'pending_admin_approval').length;
  const openTicketsN = tickets.filter(t => !['closed', 'completed', 'cancelled'].includes(t.status)).length;
  const actionChips = [
    { id: 'tenant', label: 'Tenant approval', count: tenantApprovalN || openTicketsN, icon: 'ticket-outline' as const, route: 'Tickets' },
    { id: 'multi-bed', label: 'Beds with multiple active tenants', count: discrepancies.bed || 0, icon: 'warning-outline' as const, route: 'Tenants' },
    { id: 'multi-tenant', label: 'Tenants with multiple active beds', count: discrepancies.tenant || 0, icon: 'warning-outline' as const, route: 'Tenants' },
    { id: 'cost', label: 'Cost approval', count: costApprovalN, icon: 'cash-outline' as const, route: 'Tickets' },
    { id: 'admin', label: 'Admin approval', count: adminApprovalN, icon: 'shield-checkmark-outline' as const, route: 'Tickets' },
  ].filter(c => c.count > 0 || ['tenant', 'cost', 'admin'].includes(c.id));
  const actionOpenSum = actionChips.reduce((s, c) => s + c.count, 0);

  const go = (route: string) => {
    try { (navigation as any).navigate(route); } catch { /* noop */ }
  };

  const announcements: any[] = Array.isArray(extended?.announcements) ? extended!.announcements : [];

  // KPI snapshot fed to the AI assistant so it can reason about live figures.
  const kpiContext = [
    `Period: ${periodLabel(period, customFrom, customTo)}`,
    `Occupancy: ${occupancyPct}% (${occupiedBedsV} occupied, ${bookedBedsV} booked, ${noticeBedsV} on notice, ${vacantBedsV} vacant of ${totalBedsLive} live beds)`,
    `Revenue this month: ${fmtINR(revenueHeadline)}${momPct != null ? ` (${momPct >= 0 ? '+' : ''}${momPct}% vs last month)` : ''}`,
    `Total revenue (period): ${fmtINR(fin.totalRevenue)}`,
    `Total expenses: ${fmtINR(fin.totalExpenses)}`,
    `Net profit: ${fmtINR(fin.totalProfit)} (margin ${profitMargin}%)`,
    `Pending dues: ${fmtINR(pendingDuesV)}`,
    `Deposits held: ${fmtINR(depositsHeldV)}`,
    `Collection rate by 7th: ${collRateV != null ? `${collRateV}%` : 'n/a'}`,
    `Tenant payments: ${onTimeV} cleared by 7th, ${lateV} cleared after 7th, ${unpaidV} unpaid`,
    `EB margin: ${ebMarginPct}% · Avg revenue per bed: ₹${Math.round(fin.revPerBed ?? 0).toLocaleString('en-IN')}`,
    `Open action items: ${actionOpenSum}`,
  ].join('\n');

  const askAi = async () => {
    const q = aiQuestion.trim();
    if (!q || aiLoading) return;
    setAiLoading(true);
    setAiError('');
    setAiAnswer('');
    try {
      const { client: convexClient, api: convexApi } = await import('../lib/convexApi') as any;
      const composed = `Here is my current dashboard snapshot:\n${kpiContext}\n\nQuestion: ${q}`;
      const res = await convexClient.action((convexApi as any).aiAssistant.askAssistant, { question: composed, history: [] });
      setAiAnswer((res && res.answer) ? String(res.answer) : 'No response.');
    } catch (e: any) {
      setAiError('Could not reach the AI assistant. Please try again.');
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: DASH.bg }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* Sticky header — brand | period + avatar (no bell — web parity) */}
        <View style={styles.topBar}>
          <View style={styles.brandRow}>
            <Image
              source={require('../assets/vishful-logo-DPK24n8p.webp')}
              style={styles.markImg}
            />
            <Text style={styles.brandName}>Vishful</Text>
          </View>

          <View style={styles.dashActions}>
            {isBackgroundUpdating && <ActivityIndicator size="small" color={DASH.blue} />}
            <TouchableOpacity
              style={styles.avatar}
              activeOpacity={0.75}
              onPress={confirmSignOut}
              accessibilityRole="button"
              accessibilityLabel="Account — tap to sign out"
            >
              <Text style={styles.avatarText}>
                {(user?.userName || 'V')[0].toUpperCase()}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <Animated.ScrollView
          style={{ flex: 1, opacity: fadeIn, transform: [{ translateY: slideUp }] }}
          contentContainerStyle={{ paddingHorizontal: DASH.padX, paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={DASH.blue} />}
        >
          {/* Command deck */}
          <View style={styles.commandDeck}>
            <View style={styles.dashTitleRow}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.deckGreeting}>{timeGreeting()}</Text>
                <Text style={styles.deckSub}>Here is what needs your attention today.</Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 8 }}>
                <TouchableOpacity style={styles.periodPill} activeOpacity={0.75} onPress={() => setPeriodOpen(true)}>
                  <Ionicons name="calendar-outline" size={14} color={DASH.blue} />
                  <Text style={styles.periodPillText} numberOfLines={1}>
                    {periodLabel(period, customFrom, customTo)}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={styles.askAiBtn}
                  onPress={() => { setAiError(''); setAiOpen(true); }}
                >
                  <Ionicons name="sparkles" size={12} color="#fff" />
                  <Text style={styles.askAiText}>Ask AI</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Action queue */}
            <View style={styles.attentionBanner}>
              <View style={styles.attentionTop}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Ionicons name="flash" size={14} color={DASH.ink} />
                  <Text style={styles.attentionTitle}>Action queue</Text>
                </View>
                <View style={styles.warnBadge}>
                  <Text style={styles.warnBadgeText}>{actionOpenSum} open</Text>
                </View>
              </View>
              <View style={{ gap: 8 }}>
                {actionChips.map((chip) => (
                  <TouchableOpacity
                    key={chip.id}
                    style={styles.attnRow}
                    activeOpacity={0.8}
                    onPress={() => go(chip.route)}
                  >
                    <View style={styles.attnRowIco}>
                      <Ionicons name={chip.icon} size={16} color={DASH.blue} />
                    </View>
                    <Text style={styles.attnRowLabel} numberOfLines={2}>{chip.label}</Text>
                    <View style={styles.attnRowCount}>
                      <Text style={styles.attnRowCountText}>{chip.count}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={DASH.ink3} />
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>

          {/* ── Financials ── */}
          <Panel title="Financials">
            <LinearGradient
              colors={['#6A2C90', '#4E2069'] as const}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.finHero}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.finHeroLabel}>Revenue this month</Text>
                <Text style={styles.finHeroBig}>{fmtINR(revenueHeadline)}</Text>
                {momPct != null && (
                  <Text style={styles.finHeroDelta}>
                    {momPct >= 0 ? '+' : ''}{momPct}% vs last month
                  </Text>
                )}
              </View>
              <MiniSpark values={sparkVals.length ? sparkVals : [1, 2, 1.5, 2.2, 1.8, 2.5]} light />
            </LinearGradient>

            <View style={styles.finGrid}>
              {[
                { label: 'Revenue', value: fmtINR(fin.totalRevenue), tone: 'indigo' as const, icon: 'wallet-outline' as const, spark: revenueSpark, delta: momPct },
                { label: 'Expenses', value: fmtINR(fin.totalExpenses), tone: 'rose' as const, icon: 'trending-up-outline' as const, spark: expensesSpark, delta: undefined },
                { label: 'Pending dues', value: fmtINR(pendingDuesV), tone: 'amber' as const, icon: 'calendar-outline' as const, spark: [] as number[], delta: undefined },
                { label: 'Deposits held', value: fmtINR(depositsHeldV), tone: 'green' as const, icon: 'arrow-down-circle-outline' as const, spark: [] as number[], delta: undefined },
              ].map((c) => {
                const tone = {
                  indigo: { bg: '#F3ECF9', fg: '#6A2C90' },
                  rose: { bg: '#FFF1F2', fg: '#BE123C' },
                  amber: { bg: '#FFFBEB', fg: '#B45309' },
                  green: { bg: '#F0FDF4', fg: '#15803D' },
                }[c.tone];
                const hasSpark = c.spark.length >= 2;
                const hasDelta = c.delta != null;
                return (
                  <View key={c.label} style={styles.finCard}>
                    <View style={styles.finCardTop}>
                      <View style={[styles.finCardIco, { backgroundColor: tone.bg }]}>
                        <Ionicons name={c.icon} size={18} color={tone.fg} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.mutedSm} numberOfLines={1}>{c.label}</Text>
                        <Text style={styles.finVal} numberOfLines={1}>{c.value}</Text>
                      </View>
                    </View>
                    {(hasSpark || hasDelta) && (
                      <View style={styles.finCardBottom}>
                        {hasDelta ? (
                          <Text style={[styles.finDelta, { color: (c.delta as number) >= 0 ? DASH.good : DASH.bad }]}>
                            {(c.delta as number) >= 0 ? '+' : ''}{c.delta}%
                          </Text>
                        ) : <View />}
                        {hasSpark ? <MiniSpark values={c.spark.slice(-8)} /> : null}
                      </View>
                    )}
                  </View>
                );
              })}
            </View>

            <View style={styles.ringRow}>
              {[
                { label: 'Collection rate', sub: 'by 7th', value: collRateV != null ? `${collRateV}%` : '—' },
                { label: 'Profit margin', sub: periodLabel(period, customFrom, customTo), value: `${profitMargin}%` },
                { label: 'EB margin', sub: 'electricity', value: `${ebMarginPct}%` },
                { label: 'Avg rev / bed / mo', sub: 'live beds', value: `₹${Math.round(fin.revPerBed ?? 0).toLocaleString('en-IN')}` },
              ].map((r) => (
                <View key={r.label} style={styles.ringStat}>
                  <Text style={styles.ringVal}>{r.value}</Text>
                  <Text style={styles.ringLabel}>{r.label}</Text>
                  <Text style={styles.mutedSm}>{r.sub}</Text>
                </View>
              ))}
            </View>

            {trendValues.length >= 2 && (
              <View style={styles.trendCard}>
                <View style={styles.trendTop}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.trendLabel}>Revenue trend</Text>
                    <Text style={styles.trendBig}>{fmtINR(revenueHeadline)}</Text>
                  </View>
                  <View style={styles.trendToggle}>
                    {([3, 6, 12] as const).map((r) => (
                      <TouchableOpacity
                        key={r}
                        onPress={() => setTrendRange(r)}
                        activeOpacity={0.8}
                        style={[styles.trendSeg, trendRange === r && styles.trendSegOn]}
                      >
                        <Text style={[styles.trendSegText, trendRange === r && styles.trendSegTextOn]}>{r}M</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
                {momPct != null && (
                  <View style={styles.trendDeltaRow}>
                    <View style={[styles.trendDeltaPill, momPct < 0 && { backgroundColor: DASH.badBg }]}>
                      <Ionicons
                        name={momPct >= 0 ? 'trending-up' : 'trending-down'}
                        size={12}
                        color={momPct >= 0 ? DASH.good : DASH.bad}
                      />
                      <Text style={[styles.trendDeltaText, momPct < 0 && { color: DASH.bad }]}>
                        {momPct >= 0 ? '+' : ''}{momPct}%
                      </Text>
                    </View>
                    {!!trendEndLabel && <Text style={styles.mutedSm}>{trendEndLabel}</Text>}
                  </View>
                )}
                <RevenueTrendChart values={trendValues} labels={trendLabels} width={TREND_W} />
              </View>
            )}
          </Panel>

          {/* ── Occupancy ── */}
          <Panel title="Occupancy">
            <View style={styles.occTop}>
              <MultiRingDonut
                rings={[
                  { pct: occupancyPct, color: DASH.blue },
                  { pct: monthOccPct, color: DASH.good },
                  { pct: occupiedFillPct, color: '#F59E0B' },
                ]}
                center={`${occupancyPct}%`}
                sub="Current"
              />
              <View style={styles.occList}>
                <View style={styles.occNumRow}>
                  <Text style={styles.occNumVal}>{occupancyPct}%</Text>
                  <Text style={styles.occNumLbl}>Current</Text>
                </View>
                <View style={styles.occNumRow}>
                  <Text style={styles.occNumVal}>{monthOccPct}%</Text>
                  <Text style={styles.occNumLbl}>Month</Text>
                </View>
                {bedTypes.slice(0, 4).map((b: any) => {
                  const p = Number(b.pct) || 0;
                  const col = p >= 95 ? DASH.good : p >= 80 ? DASH.warn : DASH.bad;
                  return (
                    <View key={b.type} style={styles.occTypeRow}>
                      <Text style={styles.occTypeName} numberOfLines={1}>{b.type}</Text>
                      <Text style={[styles.occTypePct, { color: col }]}>{p}%</Text>
                    </View>
                  );
                })}
              </View>
            </View>

            <View style={styles.statusStrip}>
              {[
                { label: 'Occupied', value: occupiedBedsV, color: DASH.good },
                { label: 'Booked', value: bookedBedsV, color: DASH.blue },
                { label: 'Notice', value: noticeBedsV, color: DASH.warn },
                { label: 'Vacant', value: vacantBedsV, color: DASH.ink3 },
              ].map((s) => (
                <View key={s.label} style={styles.statusCell}>
                  <Text style={[styles.statusVal, { color: s.color }]}>{s.value}</Text>
                  <Text style={styles.statusLbl}>{s.label}</Text>
                </View>
              ))}
            </View>
            <Text style={[styles.mutedSm, { marginTop: 10 }]}>Total live: {totalBedsLive}</Text>
          </Panel>

          {/* ── Tenant payments ── */}
          <Panel title="Tenant payments">
            <View style={styles.payRow}>
              <View style={[styles.payCard, styles.payGood]}>
                <Text style={styles.payStrong}>{onTimeV}</Text>
                <Text style={styles.paySpan}>Cleared by 7th</Text>
              </View>
              <View style={[styles.payCard, styles.payWarn]}>
                <Text style={styles.payStrong}>{lateV}</Text>
                <Text style={styles.paySpan}>Cleared after 7th</Text>
              </View>
              <View style={[styles.payCard, styles.payBad]}>
                <Text style={styles.payStrong}>{unpaidV}</Text>
                <Text style={styles.paySpan}>Owing {unpaidInvoicesV} invoices</Text>
              </View>
            </View>
            <Text style={[styles.mutedSm, { marginTop: 10 }]}>
              {invoicedV} tenants involved in {periodLabel(period, customFrom, customTo)}
              {collRateV != null ? ` · Collection rate ${collRateV}%` : ''}.
            </Text>
          </Panel>

          {/* ── Awesome customers ── */}
          {awesomeList.length > 0 && (
            <Panel title="Awesome customers" right={`By 1st · ${awesomeList.length}`}>
              {awesomeList.slice(0, 8).map((t: any, i: number) => (
                <View key={`aw-${i}`} style={styles.custHit}>
                  <Text style={styles.rank}>{i + 1}</Text>
                  <Text style={styles.custName} numberOfLines={1}>{t.name}</Text>
                  <Text style={styles.mutedSm}>{t.months} / {t.occupiedMonths} mo</Text>
                  <Text style={[styles.score, styles.scoreGood]}>{t.pct}%</Text>
                </View>
              ))}
            </Panel>
          )}

          {/* ── Star customers ── */}
          {starList.length > 0 && (
            <Panel title="Star customers" right={`By 7th · ${starList.length}`}>
              {starList.slice(0, 8).map((t: any, i: number) => {
                const months = t.months ?? t.firstCount ?? 0;
                const occupied = t.occupiedMonths ?? t.paidMonths ?? 0;
                const pct = t.pct != null ? Number(t.pct) : (occupied > 0 ? Math.round((months / occupied) * 100) : 0);
                return (
                  <View key={`st-${i}`} style={styles.custHit}>
                    <Text style={styles.rank}>{i + 1}</Text>
                    <Text style={styles.custName} numberOfLines={1}>{t.name}</Text>
                    <Text style={styles.mutedSm}>{months} / {occupied} mo</Text>
                    <Text style={[styles.score, pct >= 95 ? styles.scoreGood : styles.scoreOk]}>{pct}%</Text>
                  </View>
                );
              })}
            </Panel>
          )}

          {/* ── Needs Attention ── */}
          {needsAtt.length > 0 && (
            <Panel title="Needs Attention" darkHead>
              <Text style={[styles.mutedSm, { marginBottom: 10 }]}>Lowest occupancy apartments</Text>
              <View style={styles.unitGrid}>
                {needsAtt.map((a: any) => (
                  <View key={a.id} style={styles.unitCard}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.unitCode} numberOfLines={1}>{a.code}</Text>
                      <Text style={styles.mutedSm} numberOfLines={1}>{a.propertyName}</Text>
                    </View>
                    <View style={styles.unitRight}>
                      <Text style={[styles.unitPct, { color: a.occupancyPct < 70 ? DASH.bad : DASH.good }]}>
                        {a.occupancyPct}%
                      </Text>
                      <Text style={styles.mutedSm}>{a.occupiedBeds}/{a.totalBeds}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </Panel>
          )}

          {/* ── Announcements ── */}
          <Panel title="Announcements" right={announcements.length ? `${announcements.length} recent` : undefined}>
            {announcements.length === 0 ? (
              <Text style={styles.mutedSm}>No announcements yet.</Text>
            ) : (
              announcements.slice(0, 5).map((a: any, i: number) => {
                const pr = String(a?.priority || 'normal').toLowerCase();
                const tone = (pr === 'high' || pr === 'urgent')
                  ? { bg: DASH.badBg, fg: DASH.bad }
                  : pr === 'low'
                    ? { bg: DASH.soft, fg: DASH.ink2 }
                    : { bg: DASH.blueSoft, fg: DASH.blueInk };
                return (
                  <View
                    key={a?.id ?? i}
                    style={[styles.annRow, i === Math.min(announcements.length, 5) - 1 && { borderBottomWidth: 0 }]}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <Text style={styles.annTitle} numberOfLines={1}>{a?.title || 'Untitled'}</Text>
                      <View style={[styles.annBadge, { backgroundColor: tone.bg }]}>
                        <Text style={[styles.annBadgeText, { color: tone.fg }]}>{pr}</Text>
                      </View>
                    </View>
                    {!!a?.content && <Text style={styles.annBody} numberOfLines={2}>{a.content}</Text>}
                    {!!a?.published_at && <Text style={[styles.mutedSm, { marginTop: 4 }]}>{fmtDate(a.published_at)}</Text>}
                  </View>
                );
              })
            )}
          </Panel>

          <View style={{ height: spacing.lg }} />
        </Animated.ScrollView>
      </SafeAreaView>

      <PeriodModal
        visible={periodOpen}
        onClose={() => setPeriodOpen(false)}
        period={period}
        customFrom={customFrom}
        customTo={customTo}
        onSelectPreset={(k) => { setPeriod(k); setPeriodOpen(false); }}
        onApplyCustom={(f, t) => { setCustomFrom(f); setCustomTo(t); setPeriod('custom'); setPeriodOpen(false); }}
      />

      {/* Ask AI modal */}
      <Modal visible={aiOpen} transparent animationType="fade" onRequestClose={() => setAiOpen(false)}>
        <TouchableWithoutFeedback onPress={() => setAiOpen(false)}>
          <View style={{ flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', padding: 24 }}>
            <TouchableWithoutFeedback>
              <View style={{ backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', maxWidth: 400, width: '100%', alignSelf: 'center' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: DASH.blue, paddingHorizontal: 16, paddingVertical: 12 }}>
                  <Ionicons name="sparkles" size={16} color="#fff" />
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff', flex: 1 }}>Ask AI about your dashboard</Text>
                  <TouchableOpacity onPress={() => setAiOpen(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close" size={20} color="#fff" />
                  </TouchableOpacity>
                </View>

                <View style={{ padding: 16 }}>
                  <TextInput
                    value={aiQuestion}
                    onChangeText={setAiQuestion}
                    placeholder="e.g. Which figures should I worry about this month?"
                    placeholderTextColor={DASH.ink3}
                    multiline
                    style={{
                      minHeight: 64, maxHeight: 120,
                      borderWidth: 1, borderColor: DASH.line, borderRadius: 12,
                      paddingHorizontal: 12, paddingVertical: 10,
                      fontSize: 14, color: DASH.ink, textAlignVertical: 'top',
                      backgroundColor: DASH.soft,
                    }}
                  />

                  {(aiLoading || !!aiAnswer || !!aiError) && (
                    <View style={{
                      marginTop: 12, borderRadius: 12, padding: 12,
                      backgroundColor: DASH.finHero, borderWidth: 1, borderColor: DASH.panelBorder,
                    }}>
                      {aiLoading ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <ActivityIndicator size="small" color={DASH.blue} />
                          <Text style={styles.mutedSm}>Thinking…</Text>
                        </View>
                      ) : aiError ? (
                        <Text style={{ fontSize: 13, color: DASH.bad, fontWeight: '600' }}>{aiError}</Text>
                      ) : (
                        <ScrollView style={{ maxHeight: 220 }}>
                          <Text style={{ fontSize: 14, color: DASH.ink, lineHeight: 20 }}>{aiAnswer}</Text>
                        </ScrollView>
                      )}
                    </View>
                  )}

                  <TouchableOpacity
                    onPress={askAi}
                    disabled={aiLoading || !aiQuestion.trim()}
                    activeOpacity={0.85}
                    style={{
                      marginTop: 14, borderRadius: 12, paddingVertical: 13, alignItems: 'center',
                      flexDirection: 'row', justifyContent: 'center', gap: 6,
                      backgroundColor: (aiLoading || !aiQuestion.trim()) ? '#CBD5E1' : DASH.blue,
                    }}
                  >
                    <Ionicons name="sparkles" size={14} color="#fff" />
                    <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>{aiLoading ? 'Asking…' : 'Ask'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: DASH.line,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  markImg: { width: 42, height: 42, resizeMode: 'contain' },
  brandName: {
    fontSize: 20, fontWeight: '800', letterSpacing: -0.3, color: '#7C3AED',
  },
  brandTag: {
    fontSize: 10, color: DASH.brandSub, letterSpacing: 0.8, fontWeight: '700',
    textTransform: 'uppercase', marginTop: 1,
  },
  dashActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  periodPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderWidth: 1, borderColor: DASH.line,
    maxWidth: 140, minHeight: 36,
  },
  periodPillText: { fontSize: 12, fontWeight: '600', color: DASH.blueInk, flexShrink: 1 },
  avatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: DASH.line,
  },
  avatarText: { fontSize: 12, fontWeight: '700', color: DASH.blueInk },

  commandDeck: {
    paddingTop: 18, paddingBottom: 8,
  },
  dashTitleRow: {
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    marginBottom: 18, gap: 12,
  },
  deckGreeting: {
    fontSize: 26, fontWeight: '800', color: DASH.ink,
    letterSpacing: -0.6, maxWidth: 240,
  },
  deckSub: {
    fontSize: 13, color: '#475569', marginTop: 4, lineHeight: 18,
  },
  askAiBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    backgroundColor: DASH.blue, minHeight: 28,
  },
  askAiText: { fontSize: 12, fontWeight: '700', color: '#fff' },

  attentionBanner: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderWidth: 1, borderColor: DASH.line,
    borderRadius: 18, padding: 12,
  },
  attentionTop: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 10,
  },
  attentionTitle: { fontSize: 13, fontWeight: '700', color: DASH.ink },
  warnBadge: {
    backgroundColor: '#FFFBEB', borderWidth: 1, borderColor: '#FDE68A',
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
  },
  warnBadgeText: { fontSize: 11, fontWeight: '700', color: '#92400E' },
  attnRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 11,
    borderRadius: 12, backgroundColor: '#F6F8FC',
    borderWidth: 1, borderColor: '#EEF2F7',
  },
  attnRowIco: {
    width: 30, height: 30, borderRadius: 8,
    backgroundColor: DASH.blueSoft, alignItems: 'center', justifyContent: 'center',
  },
  attnRowLabel: { flex: 1, fontSize: 13, fontWeight: '700', color: DASH.ink },
  attnRowCount: {
    minWidth: 24, height: 22, paddingHorizontal: 7, borderRadius: 999,
    backgroundColor: DASH.blueSoft, alignItems: 'center', justifyContent: 'center',
  },
  attnRowCountText: { fontSize: 12, fontWeight: '800', color: DASH.blueInk },

  panel: {
    backgroundColor: '#fff',
    borderRadius: 18, borderWidth: 1, borderColor: '#EEF1F6',
    marginBottom: 12, overflow: 'hidden',
    ...shadows.card,
  },
  panelAttention: { borderColor: '#C7D2FE' },
  panelHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4,
  },
  panelHeadDark: {
    paddingHorizontal: 14, paddingVertical: 12,
  },
  panelTitle: { fontSize: 17, fontWeight: '800', color: DASH.ink },
  panelTitleDark: { fontSize: 16, fontWeight: '700', color: '#fff' },
  panelRight: { fontSize: 12, fontWeight: '600', color: DASH.ink2 },
  panelBody: { padding: 12, paddingTop: 8 },

  mutedSm: { fontSize: 12, color: DASH.ink2, fontWeight: '500' },
  finHero: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderRadius: 18, padding: 18, marginBottom: 12, overflow: 'hidden',
  },
  finHeroLabel: { fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.82)' },
  finHeroBig: { fontSize: 32, fontWeight: '800', color: '#FFFFFF', letterSpacing: -0.6, marginTop: 4 },
  finHeroDelta: { fontSize: 12, fontWeight: '700', color: '#86EFAC', marginTop: 6 },
  finBig: { fontSize: 30, fontWeight: '800', color: DASH.ink, letterSpacing: -0.6, marginTop: 2 },
  delta: { fontSize: 12, fontWeight: '700', marginTop: 4 },
  deltaUp: { color: '#15803D' },
  deltaDown: { color: '#B91C1C' },

  finGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  finCard: {
    width: '47%', flexGrow: 1,
    borderRadius: 16, padding: 14, minHeight: 104,
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EEF1F6',
    shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
  finCardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  finCardIco: {
    width: 38, height: 38, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  finVal: { fontSize: 18, fontWeight: '800', color: DASH.ink, marginTop: 2, letterSpacing: -0.3 },
  finCardBottom: {
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    marginTop: 12, minHeight: 20,
  },
  finDelta: { fontSize: 12, fontWeight: '800' },

  ringRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  ringStat: {
    width: '47%', flexGrow: 1,
    borderRadius: 12, padding: 12,
    backgroundColor: '#fff', borderWidth: 1, borderColor: DASH.line,
  },
  ringVal: { fontSize: 20, fontWeight: '800', color: DASH.ink, letterSpacing: -0.4 },
  ringLabel: { fontSize: 12, fontWeight: '600', color: DASH.ink, marginTop: 2 },
  chartHead: { fontSize: 12, fontWeight: '700', color: DASH.ink, marginBottom: 8 },

  occTop: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  occStats: { flex: 1, gap: 6 },
  occPill: {
    flexDirection: 'row', alignItems: 'baseline', gap: 8,
    backgroundColor: DASH.soft, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8,
    borderWidth: 1, borderColor: DASH.line,
  },
  occPillStrong: { fontSize: 18, fontWeight: '800', color: DASH.ink },
  occPillSpan: { fontSize: 12, color: DASH.ink2, fontWeight: '600' },
  typeHit: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 4, paddingHorizontal: 4,
  },
  typeName: { fontSize: 12, color: DASH.ink2, fontWeight: '600', flex: 1 },
  typePct: { fontSize: 12, fontWeight: '800', color: DASH.ink },

  statusStrip: {
    flexDirection: 'row', marginTop: 14, gap: 6,
    backgroundColor: DASH.soft, borderRadius: 12, padding: 10,
    borderWidth: 1, borderColor: DASH.line,
  },
  statusCell: { flex: 1, alignItems: 'center' },
  statusVal: { fontSize: 16, fontWeight: '800' },
  statusLbl: { fontSize: 10, color: DASH.ink2, fontWeight: '600', marginTop: 2 },

  payRow: { flexDirection: 'row', gap: 8 },
  payCard: {
    flex: 1, minHeight: 92, borderRadius: 13, padding: 12,
    justifyContent: 'center', borderWidth: 1,
  },
  payGood: { backgroundColor: DASH.goodBg, borderColor: '#BBF7D0' },
  payWarn: { backgroundColor: DASH.warnBg, borderColor: '#FED7AA' },
  payBad: { backgroundColor: DASH.badBg, borderColor: '#FECACA' },
  payStrong: { fontSize: 24, fontWeight: '800', color: DASH.ink, letterSpacing: -0.5 },
  paySpan: { fontSize: 11, fontWeight: '600', color: DASH.ink2, marginTop: 4 },

  custHit: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    minHeight: 52, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: DASH.line,
  },
  rank: {
    width: 22, textAlign: 'center', fontSize: 13, fontWeight: '800', color: DASH.ink3,
  },
  custName: { flex: 1, fontSize: 13, fontWeight: '600', color: DASH.ink },
  score: { fontSize: 13, fontWeight: '800', minWidth: 38, textAlign: 'right' },
  scoreGood: { color: DASH.good },
  scoreOk: { color: DASH.ok },

  unitGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  unitCard: {
    width: '47%', flexGrow: 1,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: DASH.soft, borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: DASH.line, minHeight: 64,
  },
  unitCode: { fontSize: 14, fontWeight: '700', color: DASH.ink },
  unitRight: { alignItems: 'flex-end' },
  unitPct: { fontSize: 16, fontWeight: '800' },

  annRow: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: DASH.line,
  },
  annTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: DASH.ink },
  annBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  annBadgeText: { fontSize: 10, fontWeight: '800', textTransform: 'capitalize' },
  annBody: { fontSize: 12, color: DASH.ink2, lineHeight: 17 },

  // ── Revenue trend card ──
  trendCard: {
    marginTop: 14, borderRadius: 16, padding: 14,
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EEF1F6',
    shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
  trendTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  trendLabel: { fontSize: 12, fontWeight: '600', color: DASH.ink2 },
  trendBig: { fontSize: 24, fontWeight: '800', color: DASH.ink, letterSpacing: -0.5, marginTop: 2 },
  trendToggle: {
    flexDirection: 'row', backgroundColor: '#F1F3F9', borderRadius: 999, padding: 3, gap: 2,
  },
  trendSeg: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999 },
  trendSegOn: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#0F172A', shadowOpacity: 0.08, shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  trendSegText: { fontSize: 12, fontWeight: '700', color: DASH.ink3 },
  trendSegTextOn: { color: '#6A2C90' },
  trendDeltaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  trendDeltaPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: DASH.goodBg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3,
  },
  trendDeltaText: { fontSize: 12, fontWeight: '800', color: DASH.good },
  trendAxis: { fontSize: 10, color: DASH.ink3, fontWeight: '600' },

  // ── Occupancy multi-ring + list ──
  donutCenter: { fontSize: 20, fontWeight: '800', color: DASH.ink, letterSpacing: -0.5 },
  donutSub: { fontSize: 10, color: DASH.ink2, fontWeight: '600', marginTop: 1 },
  occList: { flex: 1, gap: 6 },
  occNumRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EEF1F6',
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9,
    shadowColor: '#0F172A', shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
  },
  occNumVal: { fontSize: 17, fontWeight: '800', color: DASH.ink, letterSpacing: -0.3 },
  occNumLbl: { fontSize: 12, color: DASH.ink2, fontWeight: '600' },
  occTypeRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EEF1F6',
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8,
  },
  occTypeName: { fontSize: 13, color: DASH.ink, fontWeight: '600', flex: 1 },
  occTypePct: { fontSize: 13, fontWeight: '800' },
});

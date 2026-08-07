import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TouchableOpacity,
  Dimensions, Image, Animated, StyleSheet, Modal, PanResponder,
  TouchableWithoutFeedback, TextInput, ActivityIndicator, Platform, StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient as SvgRadialGradient, Stop, Rect } from 'react-native-svg';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/ThemeContext';
import { spacing, fontSize, borderRadius, glass } from '../lib/theme';
import { StatCard, LoadingScreen, GlassBackground, DateField } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { Ionicons } from '@expo/vector-icons';
import { DrawerActions, useNavigation, useFocusEffect } from '@react-navigation/native';
import { useMountedRef, isAbortError } from '../lib/safeAsync';
import { fetchTickets, STATUS_CONFIG, PRIORITY_CONFIG } from '../services/ticketService';
import { client, api } from '../lib/convexApi';
import { getHeroMonthly, getDuesTotals, getTenantPunctuality } from '../lib/dashboardMetrics';
import { useQuery } from '@tanstack/react-query';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ─── Brand palette (Vishful) ─────────────────────────────────────────────────
const BRAND = {
  purple: '#7B2FBE',
  purpleDeep: '#3D1A6E',
  orange: '#E8841A',
  ink900: '#1E1230',
  ink500: '#7B6B90',
  ink400: '#9B8BAE',
  ink300: '#BFB1CE',
  surface: '#FAF7FC',
  panel: 'rgba(255,255,255,0.78)',
  panelBorder: 'rgba(255,255,255,0.55)',
  divider: 'rgba(224,213,234,0.4)',
};

// ─── Dusk identity (shared with LoginScreen) — the twilight header band ────────
const DUSK = {
  plumNight: '#1C0E36',
  plumMid:   '#2C1751',
  duskMauve: '#45256E',
  ember:     '#F0871E',
  emberGlow: '#FFC073',
  warmWhite: '#FBF4EC',
  mauveHaze: '#C6B4DE',
  mauveDim:  '#9A88B6',
};
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const BAND_H = 470; // height of the twilight band that fades into the light canvas

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtINR(n: number): string {
  if (Math.abs(n) >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (Math.abs(n) >= 1000)   return `₹${(n / 1000).toFixed(1)}k`;
  return `₹${n.toLocaleString('en-IN')}`;
}

function todayLabel(): string {
  return new Date().toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short' });
}

function greetingName(name?: string): string {
  if (!name) return 'there';
  return String(name).split(' ')[0];
}

// ─── Period presets (match web AccountingPeriodSelector full list) ────────────
const PERIODS: { key: string; label: string }[] = [
  { key: 'current_fy',     label: 'Current FY' },
  { key: 'last_fy',        label: 'Last FY' },
  { key: 'last_2fy',       label: 'Last 2 FYs' },
  { key: 'last_5y',        label: 'Last 5 Years' },
  { key: 'from_beginning', label: 'Since Beginning' },
  { key: 'custom',         label: 'Custom Range' },
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

// ─── Section label ────────────────────────────────────────────────────────────
function SectionLabel({ children, action }: { children: string; action?: React.ReactNode }) {
  return (
    <View style={styles.sectionH}>
      <Text style={styles.sectionTitle}>{children}</Text>
      {action ? <View>{action}</View> : null}
    </View>
  );
}

// ─── Card wrapper ─────────────────────────────────────────────────────────────
function DashCard({ children, style }: { children: React.ReactNode; style?: object }) {
  return <View style={[styles.dashCard, style]}>{children}</View>;
}

function CardTitle({ icon, children }: { icon: any; children: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 }}>
      <Ionicons name={icon} size={15} color={BRAND.purple} />
      <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: BRAND.ink900 }}>{children}</Text>
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
      <View style={{ position: 'absolute', bottom: -5, left: 36 - 5, width: 10, height: 10,
        backgroundColor: BRAND.purpleDeep, transform: [{ rotate: '45deg' }], borderRadius: 2 }} />
    </Animated.View>
  );
}

// ─── Mini bar chart — animated + interactive ─────────────────────────────────
function MiniBarChart({
  data, valueKey, color = BRAND.orange, height = 72,
}: { data: { label: string; [k: string]: any }[]; valueKey: string; color?: string; height?: number }) {
  const anims = useRef(data.map(() => new Animated.Value(0))).current;
  const [tooltip, setTooltip] = useState<{ idx: number; x: number; y: number } | null>(null);
  const containerRef = useRef<View>(null);

  useEffect(() => {
    if (!data || data.length === 0) return;
    // Staggered bar grow-in animation
    Animated.stagger(60, anims.map(a =>
      Animated.spring(a, { toValue: 1, useNativeDriver: false, speed: 14, bounciness: 6 })
    )).start();
  }, [data.length]);

  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map((d) => d[valueKey] || 0), 1);

  const BAR_WIDTH_RATIO = 0.62;

  return (
    <View ref={containerRef} style={{ position: 'relative' }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height, gap: 8, paddingHorizontal: 4 }}>
        {data.map((d, i) => {
          const pct    = (d[valueKey] || 0) / max;
          const isPeak = pct > 0.85;
          const barH   = Math.max(4, pct * height * 0.9);

          const animatedH = anims[i]?.interpolate({
            inputRange: [0, 1], outputRange: [0, barH],
          }) ?? barH;

          return (
            <TouchableOpacity
              key={i}
              activeOpacity={0.85}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}
              onPress={(e) => {
                const tx = e.nativeEvent.pageX;
                const ty = e.nativeEvent.pageY;
                containerRef.current?.measure((_fx, _fy, _w, _h, px, py) => {
                  setTooltip(tooltip?.idx === i ? null : {
                    idx: i,
                    x: (i + 0.5) * ((SCREEN_WIDTH - 80) / data.length),
                    y: height - barH - 8,
                  });
                });
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
      {/* Tooltip */}
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
          <Text key={i} style={{ flex: 1, fontSize: 10, color: tooltip?.idx === i ? BRAND.purple : BRAND.ink400, fontWeight: tooltip?.idx === i ? '800' : '600', textAlign: 'center' }} numberOfLines={1}>
            {d.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

// ─── Mini line chart — animated + interactive ─────────────────────────────────
function MiniLineChart({
  data, valueKey, color = BRAND.purple, height = 60,
}: { data: { label: string; [k: string]: any }[]; valueKey: string; color?: string; height?: number }) {
  const drawAnim    = useRef(new Animated.Value(0)).current;
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!data || data.length < 2) return;
    drawAnim.setValue(0);
    Animated.timing(drawAnim, { toValue: 1, duration: 900, useNativeDriver: false }).start();
  }, [data.length]);

  if (!data || data.length < 2) return null;

  const max    = Math.max(...data.map((d) => d[valueKey] || 0), 1);
  const min    = Math.min(...data.map((d) => d[valueKey] || 0));
  const range  = Math.max(max - min, 1);
  const W      = SCREEN_WIDTH - 80;
  const step   = W / Math.max(data.length - 1, 1);
  const THICK  = 2.5;
  const DOT_R  = 5;

  const yFor = (val: number) => height - ((val - min) / range) * height * 0.85;

  const segments = data.slice(1).map((d, i) => {
    const x1  = i * step;
    const y1  = yFor(data[i][valueKey] || 0);
    const x2  = (i + 1) * step;
    const y2  = yFor(d[valueKey] || 0);
    const dx  = x2 - x1;
    const dy  = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    const ang = Math.atan2(dy, dx) * (180 / Math.PI);
    const cx  = (x1 + x2) / 2 - len / 2;
    const cy  = (y1 + y2) / 2 - THICK / 2;
    return { x1, y1, x2, y2, len, ang, cx, cy, idx: i };
  });

  return (
    <View style={{ height: height + 24 }}>
      <View style={{ height, position: 'relative' }}>

        {/* Animated line segments */}
        {segments.map((s, i) => {
          const segStart = i / segments.length;
          const segEnd   = (i + 1) / segments.length;
          const opacity  = drawAnim.interpolate({
            inputRange:  [segStart, Math.min(segEnd, 1)],
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

        {/* Tappable dots */}
        {data.map((d, i) => {
          const x   = i * step;
          const y   = yFor(d[valueKey] || 0);
          const active = activeIdx === i;
          return (
            <TouchableOpacity
              key={`dot-${i}`}
              activeOpacity={0.7}
              onPress={() => setActiveIdx(prev => prev === i ? null : i)}
              style={{
                position: 'absolute',
                left: x - DOT_R * (active ? 1.6 : 1),
                top:  y - DOT_R * (active ? 1.6 : 1),
                width:  DOT_R * (active ? 3.2 : 2),
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

        {/* Tooltip for active dot */}
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

// ─── Notification Modal ───────────────────────────────────────────────────────
function NotificationModal({
  visible, onClose, announcements,
}: { visible: boolean; onClose: () => void; announcements: any[] }) {
  const slideAnim = useRef(new Animated.Value(300)).current;
  const fadeAnim  = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, speed: 18, bounciness: 4 }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, { toValue: 300, duration: 220, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  const PRIORITY_BADGE: Record<string, { bg: string; color: string; icon: string }> = {
    urgent:    { bg: '#FEE2E2', color: '#DC2626', icon: 'alert-circle' },
    important: { bg: '#FEF3C7', color: '#D97706', icon: 'warning' },
    normal:    { bg: '#EDE9FE', color: '#7B2FBE', icon: 'information-circle' },
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <Animated.View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', opacity: fadeAnim }}>
          <TouchableWithoutFeedback>
            <Animated.View
              style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                backgroundColor: '#FAF7FC',
                borderTopLeftRadius: 24, borderTopRightRadius: 24,
                maxHeight: '80%',
                transform: [{ translateY: slideAnim }],
                shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, elevation: 12,
              }}
            >
              {/* Handle */}
              <View style={{ alignItems: 'center', paddingTop: 12, paddingBottom: 4 }}>
                <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(123,47,190,0.2)' }} />
              </View>

              {/* Header */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(123,47,190,0.1)' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: '#EDE9FE', alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="notifications" size={18} color={BRAND.purple} />
                  </View>
                  <View>
                    <Text style={{ fontSize: 16, fontWeight: '800', color: BRAND.ink900 }}>Notifications</Text>
                    <Text style={{ fontSize: 11, color: BRAND.ink400 }}>
                      {announcements.length} announcement{announcements.length !== 1 ? 's' : ''}
                    </Text>
                  </View>
                </View>
                <TouchableOpacity
                  onPress={onClose}
                  style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(123,47,190,0.08)', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Ionicons name="close" size={18} color={BRAND.ink500} />
                </TouchableOpacity>
              </View>

              {/* List */}
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }}
                showsVerticalScrollIndicator={false}
              >
                {announcements.length === 0 ? (
                  <View style={{ alignItems: 'center', paddingTop: 48 }}>
                    <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#EDE9FE', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                      <Ionicons name="notifications-off-outline" size={28} color={BRAND.purple} />
                    </View>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: BRAND.ink900 }}>All caught up!</Text>
                    <Text style={{ fontSize: 13, color: BRAND.ink400, marginTop: 4 }}>No announcements right now.</Text>
                  </View>
                ) : announcements.map((a: any, i: number) => {
                  const cfg = PRIORITY_BADGE[a.priority] || PRIORITY_BADGE.normal;
                  return (
                    <View
                      key={a.id || i}
                      style={{
                        backgroundColor: '#fff',
                        borderRadius: 16, padding: 14,
                        borderWidth: 1, borderColor: 'rgba(123,47,190,0.1)',
                        shadowColor: BRAND.purple, shadowOpacity: 0.04, shadowRadius: 8, elevation: 1,
                      }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: cfg.bg, alignItems: 'center', justifyContent: 'center' }}>
                          <Ionicons name={cfg.icon as any} size={16} color={cfg.color} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <View style={{ backgroundColor: cfg.bg, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 }}>
                              <Text style={{ fontSize: 9, fontWeight: '800', color: cfg.color, letterSpacing: 0.4 }}>
                                {(a.priority || 'normal').toUpperCase()}
                              </Text>
                            </View>
                            {a.published_at && (
                              <Text style={{ fontSize: 10, color: BRAND.ink400 }}>
                                {formatDate(a.published_at, '')}
                              </Text>
                            )}
                          </View>
                        </View>
                      </View>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: BRAND.ink900, marginBottom: 4 }}>{a.title}</Text>
                      {!!a.content && (
                        <Text style={{ fontSize: 13, color: BRAND.ink500, lineHeight: 18 }}>{a.content}</Text>
                      )}
                    </View>
                  );
                })}
              </ScrollView>
            </Animated.View>
          </TouchableWithoutFeedback>
        </Animated.View>
      </TouchableWithoutFeedback>
    </Modal>
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
        <View style={{ flex: 1, backgroundColor: 'rgba(30,18,48,0.45)', justifyContent: 'center', padding: 28 }}>
          <TouchableWithoutFeedback>
            <View style={{ backgroundColor: '#fff', borderRadius: 20, overflow: 'hidden' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(123,47,190,0.1)' }}>
                <Text style={{ fontSize: 16, fontWeight: '800', color: BRAND.ink900 }}>Select Period</Text>
                <TouchableOpacity onPress={onClose} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(123,47,190,0.08)', alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="close" size={16} color={BRAND.ink500} />
                </TouchableOpacity>
              </View>

              {!showCustom ? (
                <View style={{ paddingVertical: 4 }}>
                  {PERIODS.map((p) => (
                    <TouchableOpacity
                      key={p.key}
                      onPress={() => { if (p.key === 'custom') setShowCustom(true); else onSelectPreset(p.key); }}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(123,47,190,0.05)' }}
                    >
                      <Text style={{ fontSize: 14, fontWeight: period === p.key ? '800' : '500', color: period === p.key ? BRAND.purple : BRAND.ink900 }}>{p.label}</Text>
                      {period === p.key && <Ionicons name="checkmark" size={18} color={BRAND.purple} />}
                      {p.key === 'custom' && period !== 'custom' && <Ionicons name="chevron-forward" size={16} color={BRAND.ink400} />}
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                <View style={{ padding: 18 }}>
                  <TouchableOpacity onPress={() => setShowCustom(false)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 14 }}>
                    <Ionicons name="chevron-back" size={16} color={BRAND.purple} />
                    <Text style={{ fontSize: 13, fontWeight: '700', color: BRAND.purple }}>Back to presets</Text>
                  </TouchableOpacity>

                  <Text style={{ fontSize: 12, fontWeight: '700', color: BRAND.ink500, marginBottom: 4 }}>From</Text>
                  <View style={{ marginBottom: 12 }}>
                    <DateField value={from} onChange={setFrom} placeholder="Select start date" />
                  </View>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: BRAND.ink500, marginBottom: 4 }}>To</Text>
                  <View style={{ marginBottom: 16 }}>
                    <DateField value={to} onChange={setTo} placeholder="Select end date" />
                  </View>
                  <TouchableOpacity
                    onPress={applyCustom}
                    disabled={!validDate(from) || !validDate(to)}
                    style={{ backgroundColor: (validDate(from) && validDate(to)) ? BRAND.purple : '#C4B5D8', borderRadius: 12, paddingVertical: 13, alignItems: 'center' }}
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
  const { user, token } = useAuth();
  const { colors }      = useTheme();
  const navigation      = useNavigation();
  const mounted         = useMountedRef();

  const [notifModalVisible, setNotifModalVisible] = useState(false);

  // ── Period filter (matches web AccountingPeriodSelector) ──
  const [periodOpen, setPeriodOpen] = useState(false);
  const [period, setPeriod] = useState<string>('current_fy');   // preset key or 'custom'
  const [customFrom, setCustomFrom] = useState<string>('');     // YYYY-MM-DD
  const [customTo, setCustomTo] = useState<string>('');

  // entrance animation
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

  // ── Cache-first data via React Query ──────────────────────────────────────
  // One query holds the whole dashboard payload. The cache is persisted to
  // AsyncStorage (see lib/queryClient), so on open we render last-known data
  // instantly and refresh in the background. Each period is its own cache key.
  const dashboardQuery = useQuery({
    queryKey: ['dashboard', period, customFrom, customTo],
    enabled: !!token,
    queryFn: async () => {
      const [data, assets, tickets, ext, hero, dues, punc] = await Promise.all([
        sb.getDashboardData(),
        sb.listAssets().catch(() => []),
        fetchTickets('admin').catch(() => []),
        client.action(api.dashboard.getExtendedStats, period === 'custom' ? { period, customFrom, customTo } : { period }).catch(() => EMPTY_EXTENDED),
        getHeroMonthly().catch(() => null),
        getDuesTotals().catch(() => null),
        getTenantPunctuality(token!, period, customFrom, customTo).catch(() => null),
      ]);
      const now = new Date().toISOString().split('T')[0];
      const assetList = assets || [];
      const inWarranty = assetList.filter((a: any) => a.warrantyExpiry && a.warrantyExpiry > now).length;
      const expired    = assetList.filter((a: any) => a.warrantyExpiry && a.warrantyExpiry <= now).length;
      const noInfo     = assetList.length - inWarranty - expired;
      return {
        stats:         data ?? EMPTY_DASHBOARD,
        recentTickets: (tickets || []).slice(0, 5),
        extended:      ext ?? EMPTY_EXTENDED,
        heroMonthly:   hero,
        duesTotals:    dues,
        punctuality:   punc,
        warrantyStats: { inWarranty, expired, noInfo },
      };
    },
  });

  // Derived views of the cached payload (existing variable names preserved).
  const stats         = dashboardQuery.data?.stats ?? null;
  const recentTickets: any[] = dashboardQuery.data?.recentTickets ?? [];
  const extended      = dashboardQuery.data?.extended ?? null;
  const heroMonthly   = dashboardQuery.data?.heroMonthly ?? null;
  const duesTotals    = dashboardQuery.data?.duesTotals ?? null;
  const punctuality   = dashboardQuery.data?.punctuality ?? null;
  const warrantyStats = dashboardQuery.data?.warrantyStats ?? { inWarranty: 0, expired: 0, noInfo: 0 };
  const isRefreshing         = dashboardQuery.isRefetching;
  const isBackgroundUpdating = dashboardQuery.isFetching && !!dashboardQuery.data;

  // Refresh on returning to the screen (refetch is stable; the initial mount
  // fetch and this focus refetch dedupe into one request).
  const { refetch } = dashboardQuery;
  useFocusEffect(
    React.useCallback(() => { refetch(); }, [refetch])
  );

  // Light status-bar icons over the dark twilight header; revert on leaving.
  useFocusEffect(
    React.useCallback(() => {
      StatusBar.setBarStyle('light-content');
      return () => StatusBar.setBarStyle('dark-content');
    }, [])
  );

  const onRefresh = useCallback(() => { refetch(); }, [refetch]);

  // First-ever launch (no persisted cache yet) shows the splash; afterwards the
  // cache renders instantly and we never blank the screen again.
  if (!stats) return <LoadingScreen />;

  const occupancy: any[]     = stats.occupancyByProperty || [];
  const fin                   = extended?.financials ?? EMPTY_EXTENDED.financials;
  const finSeries: any[]      = extended?.financialSeries ?? [];
  const bedTypes: any[]       = extended?.bedTypeOccupancy ?? [];
  const needsAtt: any[]       = extended?.needsAttention ?? [];
  const tenantPay             = extended?.tenantPayments ?? { paidOnOrBefore7th: 0, starCustomers: [] };
  const announcements: any[]  = extended?.announcements ?? [];

  // Occupancy & bed counts — prefer the ledger-RPC snapshot (matches web exactly),
  // fall back to getStats if the RPC snapshot is unavailable.
  const ps                    = extended?.propertyStatus ?? null;
  const totalBedsLive         = ps?.total ?? stats.liveBeds ?? 0;
  const occupiedBedsV         = ps?.occupied ?? stats.occupiedBeds ?? 0;
  const noticeBedsV           = ps?.notice ?? stats.noticeBeds ?? 0;
  const liveBeds              = totalBedsLive;
  // Web occupancy = (occupied + notice) / total
  const occupancyPct          = ps?.occupancyPct != null
    ? Math.round(Number(ps.occupancyPct))
    : Math.round(((occupiedBedsV + noticeBedsV) / Math.max(1, totalBedsLive)) * 100);
  // Active tenants (web parity = tenants.activeTenants from the ledger RPC).
  // Fall back to the lifecycle "Staying" count — NEVER the raw totalTenants row
  // count (that includes historical/exited tenants and reads as e.g. "1000").
  const activeTenantsV        = extended?.rpcTenants?.activeTenants ?? stats.lifecycle?.staying ?? 0;
  const activeTicketsV        = extended?.rpcTickets?.activeCount ?? recentTickets.length;

  // ── Hero + tiles — all driven by the period-aware `fin` (extended financials)
  //    so the whole card follows the selected period filter. `duesTotals`/
  //    `heroMonthly` remain only as fallbacks when the period fetch is empty.
  const depositsHeldV = fin.depositCollections ?? heroMonthly?.depositsHeld ?? 0;
  const pendingDuesV  = (fin.pendingAmount ?? 0) > 0
    ? fin.pendingAmount
    : (duesTotals?.receivables ?? 0);

  // ── Tenant punctuality (web parity) — authenticated get_tenant_punctuality RPC.
  //    Falls back to the (approximate) Convex-computed values if unavailable.
  const punc         = punctuality ?? null;
  const onTimeV      = punc?.onTimeTenants ?? tenantPay.paidOnOrBefore7th ?? 0;
  const lateV        = punc?.lateTenants ?? 0;
  const unpaidV      = punc?.unpaidTenants ?? 0;
  const invoicedV    = punc?.invoicedTenants ?? 0;
  const collRateV    = punc?.collectionRatePct != null ? Math.round(Number(punc.collectionRatePct)) : null;
  const awesomeList: any[] = Array.isArray(punc?.awesome) ? punc.awesome : [];
  const starList: any[]    = Array.isArray(punc?.stars) ? punc.stars : (tenantPay.starCustomers ?? []);

  const PRIORITY_BADGE: Record<string, { bg: string; color: string }> = {
    urgent:    { bg: '#fee2e2', color: '#dc2626' },
    important: { bg: '#fef3c7', color: '#d97706' },
    normal:    { bg: '#f1f5f9', color: '#64748b' },
  };

  return (
    <View style={{ flex: 1, backgroundColor: DUSK.plumNight }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* ── Top bar (logo centered) ── */}
        <View style={styles.topBar}>
          {/* Brand lockup — flame mark + wordmark, left-aligned (sidebar retired) */}
          <View style={styles.brandRow}>
            <View style={styles.markClip}>
              <Image
                source={require('../assets/vishful-logo-DPK24n8p.webp')}
                style={styles.markImg}
              />
            </View>
            <Text style={styles.brandName}>VISHFUL</Text>
          </View>

          <TouchableOpacity style={styles.iconBtn} activeOpacity={0.7} onPress={() => setNotifModalVisible(true)}>
            <Ionicons name="notifications-outline" size={20} color={DUSK.warmWhite} />
            {announcements.length > 0 && (
              <View style={[styles.notifDot, { minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center' }]}>
                <Text style={{ fontSize: 9, fontWeight: '900', color: '#fff' }}>
                  {announcements.length > 9 ? '9+' : announcements.length}
                </Text>
              </View>
            )}
            {announcements.length === 0 && <View style={styles.notifDot} />}
          </TouchableOpacity>
        </View>

        <Animated.ScrollView
          style={{ flex: 1, backgroundColor: BRAND.surface, opacity: fadeIn, transform: [{ translateY: slideUp }] }}
          contentContainerStyle={{ padding: 18, paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={DUSK.ember} />}
        >
          {/* Twilight band — scrolls with the header, then resolves to the light canvas */}
          <View pointerEvents="none" style={styles.duskBand}>
            <LinearGradient
              colors={[DUSK.plumNight, DUSK.plumMid, DUSK.duskMauve, BRAND.surface]}
              locations={[0, 0.42, 0.72, 1]}
              style={StyleSheet.absoluteFill}
            />
            {/* Signature: ember bloom, the warm light carried over from sign-in */}
            <View style={{ position: 'absolute', top: 30, left: 18, right: 0 }}>
              <Svg width={SCREEN_WIDTH} height={300}>
                <Defs>
                  <SvgRadialGradient id="dashEmber" cx="50%" cy="38%" rx="58%" ry="48%">
                    <Stop offset="0%" stopColor={DUSK.emberGlow} stopOpacity={0.4} />
                    <Stop offset="38%" stopColor={DUSK.ember} stopOpacity={0.15} />
                    <Stop offset="100%" stopColor={DUSK.ember} stopOpacity={0} />
                  </SvgRadialGradient>
                </Defs>
                <Rect x={0} y={0} width={SCREEN_WIDTH} height={300} fill="url(#dashEmber)" />
              </Svg>
            </View>
          </View>

          {/* ── Greeting block (on the twilight band) ── */}
          <View style={{ marginBottom: 18 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 11, color: DUSK.mauveHaze, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase' }}>
                {todayLabel()}
              </Text>
              {isBackgroundUpdating && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <ActivityIndicator size="small" color={DUSK.emberGlow} />
                  <Text style={{ fontSize: 10, color: DUSK.mauveHaze, fontWeight: '600' }}>Updating…</Text>
                </View>
              )}
            </View>
            <Text style={{ fontSize: 32, fontWeight: '900', color: DUSK.warmWhite, letterSpacing: -0.8, marginTop: 3 }}>
              Hi {greetingName(user?.userName)}<Text style={{ color: DUSK.ember }}>.</Text>
            </Text>
            <Text style={{ fontSize: 13, color: DUSK.mauveHaze, marginTop: 5 }}>
              {stats.totalProperties} properties · {activeTicketsV} tickets need attention
            </Text>
            {/* Period selector */}
            <TouchableOpacity
              onPress={() => setPeriodOpen(true)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 12, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.20)' }}
            >
              <Ionicons name="calendar-outline" size={13} color={DUSK.emberGlow} />
              <Text style={{ fontSize: 12, fontWeight: '800', color: DUSK.warmWhite }}>{periodLabel(period, customFrom, customTo)}</Text>
              <Ionicons name="chevron-down" size={12} color={DUSK.mauveHaze} />
            </TouchableOpacity>
          </View>

          {/* ── Hero gradient card: collected this period (dusk→ember focal) ── */}
          <View style={styles.heroShadow}>
            <LinearGradient
              colors={['#4A2472', '#8340A8', DUSK.ember]}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={styles.heroCard}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.heroLabel}>Collected · {periodLabel(period, customFrom, customTo)}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: 6 }}>
                    <Text style={styles.heroAmount}>{fmtINR(fin.operationalCollections ?? fin.totalRevenue ?? stats.monthlyRevenue ?? 0)}</Text>
                  </View>
                </View>
                <View style={styles.heroIconWrap}>
                  <Ionicons name="wallet-outline" size={22} color="#fff" />
                </View>
              </View>

              <View style={styles.heroPillRow}>
                <View style={styles.heroPill}>
                  <Text style={styles.heroPillLbl}>Pending</Text>
                  <Text style={styles.heroPillVal}>{fmtINR(fin.pendingAmount || stats.pendingPayments || 0)}</Text>
                </View>
                <View style={styles.heroPill}>
                  <Text style={styles.heroPillLbl}>Profit</Text>
                  <Text style={styles.heroPillVal}>{fmtINR(fin.totalProfit || 0)}</Text>
                </View>
                <View style={styles.heroPill}>
                  <Text style={styles.heroPillLbl}>Beds</Text>
                  <Text style={styles.heroPillVal}>
                    {occupiedBedsV}/{totalBedsLive}
                  </Text>
                </View>
              </View>
            </LinearGradient>
          </View>

          {/* ── Announcements ── */}
          {announcements.length > 0 && (
            <>
              <SectionLabel>Announcements</SectionLabel>
              <DashCard>
                {announcements.slice(0, 3).map((a: any, i: number) => {
                  const pCfg = PRIORITY_BADGE[a.priority] || PRIORITY_BADGE.normal;
                  return (
                    <View
                      key={a.id}
                      style={{
                        padding: 12, borderRadius: 12,
                        borderWidth: 1, borderColor: BRAND.divider,
                        marginBottom: i < Math.min(announcements.length, 3) - 1 ? 8 : 0,
                        backgroundColor: 'rgba(255,255,255,0.55)',
                      }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <View style={{ backgroundColor: pCfg.bg, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 }}>
                          <Text style={{ fontSize: 9, fontWeight: '800', color: pCfg.color, letterSpacing: 0.4 }}>
                            {a.priority?.toUpperCase()}
                          </Text>
                        </View>
                        {a.published_at && (
                          <Text style={{ fontSize: 9, color: BRAND.ink400 }}>
                            {formatDate(a.published_at, '')}
                          </Text>
                        )}
                      </View>
                      <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: BRAND.ink900 }}>{a.title}</Text>
                      <Text style={{ fontSize: fontSize.xs, color: BRAND.ink500, marginTop: 2 }} numberOfLines={2}>
                        {a.content}
                      </Text>
                    </View>
                  );
                })}
              </DashCard>
            </>
          )}

          {/* ── Financials ── */}
          <SectionLabel>Financials (Last 6 Months)</SectionLabel>
          <DashCard>
            {/* KPI grid */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
              {[
                { label: 'Revenue',      value: fmtINR(fin.totalRevenue),           color: BRAND.ink900 },
                { label: 'Expenses',     value: fmtINR(fin.totalExpenses),          color: '#DC2626' },
                { label: 'Collections',  value: fmtINR(fin.operationalCollections), color: '#2E7D32' },
                { label: 'Pending Dues', value: fmtINR(pendingDuesV),               color: '#D97706' },
                { label: 'Deposits Held',value: fmtINR(depositsHeldV),              color: BRAND.purple },
                { label: 'Profit',       value: fmtINR(fin.totalProfit),            color: fin.totalProfit >= 0 ? '#2E7D32' : '#DC2626' },
                { label: 'EB Profit',    value: fmtINR(fin.ebMargin),               color: fin.ebMargin >= 0 ? '#2E7D32' : '#DC2626' },
                { label: 'Rev / Bed',    value: `₹${(fin.revPerBed ?? 0).toLocaleString('en-IN')}`, color: BRAND.ink900 },
              ].map((item) => (
                <View key={item.label} style={styles.kpiTile}>
                  <Text style={{ fontSize: 9, color: BRAND.ink400, marginBottom: 3, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                    {item.label}
                  </Text>
                  <Text style={{ fontSize: 15, fontWeight: '900', color: item.color, letterSpacing: -0.3 }}>{item.value}</Text>
                </View>
              ))}
            </View>

            {finSeries.length > 0 && (
              <>
                <Text style={styles.miniHead}>Monthly Profitability</Text>
                <MiniLineChart data={finSeries} valueKey="profit" color={BRAND.purple} height={60} />
                <Text style={[styles.miniHead, { marginTop: 18 }]}>Revenue Trend</Text>
                <MiniBarChart data={finSeries} valueKey="revenue" color={BRAND.orange} height={72} />
              </>
            )}
          </DashCard>

          {/* ── Occupancy by Bed Type ── */}
          {bedTypes.length > 0 && (
            <>
              <SectionLabel>Bed Type Occupancy</SectionLabel>
              <DashCard>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                  {bedTypes.slice(0, 6).map((b: any) => (
                    <View key={b.type} style={styles.kpiTile}>
                      <Text style={{ fontSize: 9, color: BRAND.ink400, marginBottom: 3, fontWeight: '700' }} numberOfLines={1}>
                        {b.type}
                      </Text>
                      <Text style={{ fontSize: 20, fontWeight: '900', color: BRAND.ink900, letterSpacing: -0.4 }}>{b.pct}%</Text>
                      <Text style={{ fontSize: 9, color: BRAND.ink400 }}>{b.total} beds</Text>
                    </View>
                  ))}
                </View>
              </DashCard>
            </>
          )}

          {/* ── Tenant Payments (web parity: On-time / Late / Unpaid + Awesome & Star) ── */}
          <SectionLabel>Tenant Payments</SectionLabel>
          <DashCard>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
              <View style={[styles.payTile, { backgroundColor: 'rgba(46,125,50,0.06)', borderColor: 'rgba(46,125,50,0.18)' }]}>
                <Text style={styles.payTileLbl}>On time (≤7th)</Text>
                <Text style={[styles.payTileVal, { color: '#2E7D32' }]}>{onTimeV}</Text>
                <Text style={styles.payTileSub}>Cleared by the 7th</Text>
              </View>
              <View style={[styles.payTile, { backgroundColor: 'rgba(217,119,6,0.06)', borderColor: 'rgba(217,119,6,0.18)' }]}>
                <Text style={styles.payTileLbl}>Later ({'>'}7th)</Text>
                <Text style={[styles.payTileVal, { color: '#D97706' }]}>{lateV}</Text>
                <Text style={styles.payTileSub}>Cleared after the 7th</Text>
              </View>
              <View style={[styles.payTile, { backgroundColor: 'rgba(220,38,38,0.06)', borderColor: 'rgba(220,38,38,0.18)' }]}>
                <Text style={styles.payTileLbl}>Unpaid</Text>
                <Text style={[styles.payTileVal, { color: '#DC2626' }]}>{unpaidV}</Text>
                <Text style={styles.payTileSub}>{punc?.unpaidInvoices ?? 0} invoices owing</Text>
              </View>
            </View>

            <Text style={{ fontSize: 11, color: BRAND.ink500, marginBottom: 4 }}>
              {invoicedV} tenants invoiced{collRateV != null ? ` · Collection rate ${collRateV}%` : ''}
            </Text>

            {awesomeList.length > 0 && (
              <>
                <Text style={[styles.miniHead, { marginTop: 12 }]}>🏆 Awesome Customers · by 1st</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    {awesomeList.map((t: any, i: number) => (
                      <View key={`aw-${i}`} style={{ minWidth: 160, backgroundColor: 'rgba(46,125,50,0.06)', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: 'rgba(46,125,50,0.18)' }}>
                        <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: BRAND.ink900 }} numberOfLines={1}>{t.name}</Text>
                        <Text style={{ fontSize: 10, color: BRAND.ink500, marginTop: 4 }}>
                          <Text style={{ fontWeight: '800', color: '#2E7D32' }}>{t.months}</Text> / {t.occupiedMonths} mo
                        </Text>
                        <Text style={{ fontSize: 10, color: BRAND.ink400 }}>{t.pct}% punctual</Text>
                      </View>
                    ))}
                  </View>
                </ScrollView>
              </>
            )}

            {starList.length > 0 && (
              <>
                <Text style={[styles.miniHead, { marginTop: 16 }]}>⭐ Star Customers · by 7th</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    {starList.map((t: any, i: number) => (
                      <View key={`st-${i}`} style={{ minWidth: 160, backgroundColor: 'rgba(123,47,190,0.06)', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: 'rgba(123,47,190,0.18)' }}>
                        <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: BRAND.ink900 }} numberOfLines={1}>{t.name}</Text>
                        <Text style={{ fontSize: 10, color: BRAND.ink500, marginTop: 4 }}>
                          <Text style={{ fontWeight: '800', color: BRAND.purple }}>{t.months ?? t.firstCount ?? 0}</Text> / {t.occupiedMonths ?? t.paidMonths ?? 0} mo
                        </Text>
                        {t.pct != null && <Text style={{ fontSize: 10, color: BRAND.ink400 }}>{t.pct}% punctual</Text>}
                      </View>
                    ))}
                  </View>
                </ScrollView>
              </>
            )}
          </DashCard>

          {/* ── Needs Attention ── */}
          {needsAtt.length > 0 && (
            <>
              <SectionLabel>Needs Attention</SectionLabel>
              <DashCard>
                <Text style={{ fontSize: 11, color: BRAND.ink400, marginBottom: 10 }}>
                  Apartments needing occupancy focus
                </Text>
                {needsAtt.map((a: any, i: number) => (
                  <View
                    key={a.id}
                    style={[
                      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, gap: 10 },
                      i < needsAtt.length - 1 && { borderBottomWidth: 1, borderBottomColor: BRAND.divider },
                    ]}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: BRAND.ink900 }} numberOfLines={1}>
                        {a.code}
                      </Text>
                      <Text style={{ fontSize: 10, color: BRAND.ink400, marginTop: 2 }} numberOfLines={1}>{a.propertyName}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ fontSize: 17, fontWeight: '900', color: a.occupancyPct < 70 ? '#DC2626' : '#2E7D32', letterSpacing: -0.3 }}>
                        {a.occupancyPct}%
                      </Text>
                      <Text style={{ fontSize: 9, color: BRAND.ink400 }}>{a.occupiedBeds}/{a.totalBeds} occupied</Text>
                    </View>
                  </View>
                ))}
              </DashCard>
            </>
          )}

          {/* ── Occupancy by Property ── */}
          <SectionLabel>Occupancy by Property</SectionLabel>
          {occupancy.length === 0 ? (
            <DashCard>
              <Text style={{ fontSize: fontSize.sm, color: BRAND.ink400, textAlign: 'center', paddingVertical: spacing.lg }}>
                No properties found
              </Text>
            </DashCard>
          ) : (
            <DashCard>
              {occupancy.map((p: any, i: number) => (
                <View
                  key={p.id}
                  style={[
                    { paddingVertical: 12 },
                    i < occupancy.length - 1 && { borderBottomWidth: 1, borderBottomColor: BRAND.divider },
                  ]}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: BRAND.ink900 }} numberOfLines={1}>
                      {p.name}
                    </Text>
                    <Text style={{ fontSize: fontSize.xs, color: BRAND.ink500, fontWeight: '600' }}>
                      {p.occupiedBeds}/{p.totalBeds} beds
                    </Text>
                  </View>
                  <View style={{ height: 8, backgroundColor: 'rgba(0,0,0,0.06)', borderRadius: 999, overflow: 'hidden' }}>
                    <LinearGradient
                      colors={
                        p.occupancyRate >= 90 ? ['#DC2626', '#F87171'] :
                        p.occupancyRate >= 60 ? [BRAND.orange, '#FFB05A'] : ['#22C55E', '#86EFAC']
                      }
                      start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                      style={{ height: 8, width: `${p.occupancyRate}%`, borderRadius: 999 }}
                    />
                  </View>
                  <Text style={{ fontSize: fontSize.xs, color: BRAND.ink400, marginTop: 4, fontWeight: '600' }}>
                    {p.occupancyRate}% occupied
                  </Text>
                </View>
              ))}
            </DashCard>
          )}

          {/* ── Asset Warranty ── */}
          <SectionLabel>Asset Warranty</SectionLabel>
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <StatCard title="In Warranty"  value={warrantyStats.inWarranty} icon="shield-checkmark-outline" color={colors.success} />
            </View>
            <View style={{ flex: 1 }}>
              <StatCard title="Expired"      value={warrantyStats.expired}    icon="alert-circle-outline"     color={colors.danger} />
            </View>
          </View>
          <StatCard title="No Warranty Info" value={warrantyStats.noInfo} icon="help-circle-outline" color={colors.textTertiary} />

          {/* ── Recent Tickets ── */}
          {recentTickets.length > 0 && (
            <>
              <SectionLabel>Recent Tickets</SectionLabel>
              {recentTickets.map((t: any) => {
                const isClosed = ['closed', 'completed'].includes(t.status);
                const overdue  = !isClosed && t.sla_deadline && new Date(t.sla_deadline) < new Date();
                const stripe   = isClosed ? colors.success : overdue ? colors.danger : colors.primary;
                return (
                  <TouchableOpacity
                    key={t.id}
                    style={styles.ticketCard}
                    activeOpacity={0.85}
                    onPress={() => { try { (navigation as any).navigate('Tickets'); } catch {} }}
                  >
                    <View style={[styles.ticketStripe, { backgroundColor: stripe }]} />
                    <View style={{ flex: 1, paddingLeft: 14 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text style={{ fontSize: 12, fontWeight: '800', color: colors.primary }}>{t.ticket_number || 'Ticket'}</Text>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textSecondary, textTransform: 'capitalize' }}>{String(t.status || '').replace(/_/g, ' ')}</Text>
                      </View>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginTop: 3 }} numberOfLines={1}>{t.issue_type || 'Maintenance Issue'}</Text>
                      {t.property_name ? <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 2 }} numberOfLines={1}>{t.property_name}</Text> : null}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </>
          )}

          <View style={{ height: 40 }} />
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

      <NotificationModal
        visible={notifModalVisible}
        onClose={() => setNotifModalVisible(false)}
        announcements={announcements}
      />
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  blob: { position: 'absolute', width: 300, height: 300, borderRadius: 999, opacity: 0.55 },
  duskBand: { position: 'absolute', top: -18, left: -18, right: -18, height: BAND_H },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingTop: 8, paddingBottom: 12,
  },
  iconBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  // Brand lockup — flame mark (clipped above the baked wordmark, ~0.7 ratio) + name
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  markClip: { width: 50, height: 36, overflow: 'hidden', alignItems: 'center' },
  markImg: { width: 50, height: 56, resizeMode: 'contain' },
  brandName: { fontSize: 18, fontWeight: '800', letterSpacing: 3, color: DUSK.warmWhite },
  notifDot: {
    position: 'absolute', top: 9, right: 11, width: 7, height: 7, borderRadius: 999,
    backgroundColor: DUSK.emberGlow, borderWidth: 1.5, borderColor: DUSK.plumMid,
  },
  // Hero
  heroShadow: {
    borderRadius: 22, marginBottom: 16,
    shadowColor: BRAND.purple, shadowOpacity: 0.32, shadowRadius: 20, shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  heroCard: {
    borderRadius: 22, padding: 18, overflow: 'hidden',
  },
  heroLabel: {
    color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '700',
    letterSpacing: 0.8, textTransform: 'uppercase',
  },
  heroAmount: {
    color: '#fff', fontSize: 33, fontWeight: '800', letterSpacing: -0.5, fontFamily: MONO,
  },
  heroDelta: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.22)', borderRadius: 999,
    paddingHorizontal: 8, paddingVertical: 3, marginLeft: 10, marginBottom: 4,
  },
  heroIconWrap: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  heroPillRow: {
    flexDirection: 'row', gap: 8, marginTop: 16,
  },
  heroPill: {
    flex: 1, backgroundColor: 'rgba(255,255,255,0.16)',
    borderRadius: 12, padding: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)',
  },
  heroPillLbl: { color: 'rgba(255,255,255,0.78)', fontSize: 10, fontWeight: '700', letterSpacing: 0.4 },
  heroPillVal: { color: '#fff', fontSize: 14, fontWeight: '800', marginTop: 3 },

  // Stat rail
  statRail: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 4,
  },
  statCard: {
    width: '48%', flexGrow: 1,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: BRAND.panel,
    borderRadius: 16, padding: 12,
    borderWidth: 0.5, borderColor: BRAND.panelBorder,
    shadowColor: BRAND.purpleDeep, shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
  statIco: {
    width: 38, height: 38, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  statNum: { fontSize: 19, fontWeight: '900', color: BRAND.ink900, letterSpacing: -0.5 },
  statLbl: { fontSize: 10, color: BRAND.ink500, fontWeight: '700', marginTop: 1 },

  // Section header
  sectionH: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 22, marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 11, fontWeight: '800', color: BRAND.ink400,
    letterSpacing: 1.2, textTransform: 'uppercase',
  },

  // Card
  dashCard: {
    borderRadius: 18,
    backgroundColor: BRAND.panel,
    padding: 16, marginBottom: 12,
    shadowColor: BRAND.purpleDeep, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 3,
    borderWidth: 0.5, borderColor: BRAND.panelBorder,
  },

  // KPI tile (for financials grid + bed type)
  kpiTile: {
    width: '30%', flexGrow: 1,
    backgroundColor: 'rgba(123,47,190,0.05)',
    borderRadius: 12, padding: 10,
    borderWidth: 0.5, borderColor: 'rgba(123,47,190,0.1)',
  },

  miniHead: { fontSize: 11, fontWeight: '800', color: BRAND.ink900, marginBottom: 8, letterSpacing: 0.3, textTransform: 'uppercase' },

  // Payments
  payTile: {
    flex: 1, borderRadius: 14, padding: 14, borderWidth: 1,
  },
  payTileLbl: { fontSize: 10, color: BRAND.ink500, fontWeight: '700', letterSpacing: 0.4 },
  payTileVal: { fontSize: 28, fontWeight: '900', marginTop: 4, letterSpacing: -0.6 },
  payTileSub: { fontSize: 9, color: BRAND.ink400, marginTop: 2, fontWeight: '600' },

  // Ticket
  ticketCard: {
    flexDirection: 'row',
    backgroundColor: BRAND.panel,
    borderRadius: 16, marginBottom: 10,
    padding: 14, paddingLeft: 0,
    borderWidth: 0.5, borderColor: BRAND.panelBorder,
    shadowColor: BRAND.purpleDeep, shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 3 },
  },
  ticketStripe: {
    width: 4, borderTopLeftRadius: 16, borderBottomLeftRadius: 16, marginRight: 0,
  },
});
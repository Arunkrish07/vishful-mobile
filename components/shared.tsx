import React, { useRef, useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet,
  ActivityIndicator, ScrollView, Modal, Platform,
  Animated as RNAnimated, Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useTheme } from '../lib/ThemeContext';
import { spacing, borderRadius, fontSize, glass, animation } from '../lib/theme';

// ─── Date helpers (inlined so no separate module is needed) ───────────────────
// Display format across the app is dd-MMM-yy (e.g. 26-Jun-25); stored/transport
// format stays ISO yyyy-MM-dd.
export const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];
export const WEEKDAYS_SHORT = ['Su','Mo','Tu','We','Th','Fr','Sa'];

export function parseToDate(value: any): Date | null {
  if (!value && value !== 0) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') { const d = new Date(value); return isNaN(d.getTime()) ? null : d; }
  const s = String(value).trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) { const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])); return isNaN(d.getTime()) ? null : d; }
  const dmy = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/](\d{2,4})$/);
  if (dmy) {
    const mi = MONTHS_SHORT.findIndex((m) => m.toLowerCase() === dmy[2].slice(0, 3).toLowerCase());
    if (mi >= 0) { const yr = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]); const d = new Date(yr, mi, Number(dmy[1])); return isNaN(d.getTime()) ? null : d; }
  }
  const num = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (num) { const yr = num[3].length === 2 ? 2000 + Number(num[3]) : Number(num[3]); const d = new Date(yr, Number(num[2]) - 1, Number(num[1])); return isNaN(d.getTime()) ? null : d; }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
const _pad = (n: number) => String(n).padStart(2, '0');
export function formatDate(value: any, fallback = '—'): string {
  const d = parseToDate(value);
  if (!d) return fallback;
  return `${_pad(d.getDate())}-${MONTHS_SHORT[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
}
export function formatDateFull(value: any, fallback = '—'): string {
  const d = parseToDate(value);
  if (!d) return fallback;
  return `${_pad(d.getDate())}-${MONTHS_SHORT[d.getMonth()]}-${d.getFullYear()}`;
}
export function toISODate(value: any): string {
  const d = parseToDate(value);
  if (!d) return '';
  return `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
}
export function todayISO(): string { return toISODate(new Date()); }

/** Background wrapper for all screens */
export function GlassBackground({ children, style }: { children: React.ReactNode; style?: any }) {
  return (
    <View style={[{ flex: 1, backgroundColor: '#F7F3F9' }, style]}>
      {children}
    </View>
  );
}

/** Frosted glass header */
export function GlassHeader({ children, style }: { children: React.ReactNode; style?: any }) {
  if (Platform.OS === 'ios') {
    return (
      <BlurView intensity={60} tint="light" style={[{ overflow: 'hidden' }, style]}>
        <View style={[{
          paddingHorizontal: spacing.xl,
          paddingVertical: spacing.lg,
          borderBottomWidth: 0.5,
          borderBottomColor: 'rgba(255,255,255,0.35)',
        }]}>
          {children}
        </View>
      </BlurView>
    );
  }
  return (
    <View style={[glass.header, { paddingHorizontal: spacing.xl, paddingVertical: spacing.lg }, style]}>
      {children}
    </View>
  );
}

/** Frosted glass card with blur effect */
export function GlassCard({ children, style }: { children: React.ReactNode; style?: any }) {
  if (Platform.OS === 'ios') {
    return (
      <BlurView
        intensity={35}
        tint="light"
        style={[{
          borderRadius: 20,
          overflow: 'hidden',
          marginBottom: 12,
          shadowColor: '#3D1A6E',
          shadowOpacity: 0.05,
          shadowRadius: 20,
          shadowOffset: { width: 0, height: 8 },
        }, style]}
      >
        <View style={{
          padding: 16,
          backgroundColor: 'rgba(255,255,255,0.3)',
          borderWidth: 0.5,
          borderColor: 'rgba(255,255,255,0.45)',
          borderRadius: 20,
        }}>
          {children}
        </View>
      </BlurView>
    );
  }
  return (
    <View style={[glass.card, style]}>
      {children}
    </View>
  );
}

export function StatCard({ title, value, icon, color, subtitle }: {
  title: string; value: string | number; icon: string; color?: string; subtitle?: string;
}) {
  const { colors } = useTheme();
  const accent = color || colors.primary;
  return (
    <View style={{
      ...glass.card,
      padding: spacing.lg,
    }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <Text style={{
            fontSize: fontSize.xs, color: colors.textTertiary,
            fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6,
          }}>{title}</Text>
          <Text style={{
            fontSize: fontSize.xxl, fontWeight: '800', color: colors.text, letterSpacing: -0.5,
          }}>{value}</Text>
          {subtitle && <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary, marginTop: 2 }}>{subtitle}</Text>}
        </View>
        <View style={{
          width: 42, height: 42, borderRadius: 13,
          backgroundColor: accent + '12', alignItems: 'center', justifyContent: 'center',
        }}>
          <Ionicons name={icon as any} size={20} color={accent} />
        </View>
      </View>
      <View style={{ height: 3, backgroundColor: accent + '12', borderRadius: 2, marginTop: spacing.md }}>
        <View style={{ height: 3, width: '60%', backgroundColor: accent, borderRadius: 2, opacity: 0.7 }} />
      </View>
    </View>
  );
}

export function Button({ title, onPress, variant = 'primary', loading, icon, disabled, style }: {
  title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'outline';
  loading?: boolean; icon?: string; disabled?: boolean; style?: any;
}) {
  const { colors } = useTheme();
  const scaleAnim = useRef(new RNAnimated.Value(1)).current;
  const bgColor = variant === 'primary' ? colors.primary : variant === 'danger' ? colors.danger : variant === 'outline' ? 'transparent' : 'rgba(255,255,255,0.65)';
  const textColor = variant === 'outline' ? colors.primary : variant === 'secondary' ? colors.text : colors.white;

  const handlePressIn = () => {
    RNAnimated.spring(scaleAnim, { toValue: animation.pressScale, useNativeDriver: false, damping: 18, stiffness: 180 }).start();
  };
  const handlePressOut = () => {
    RNAnimated.spring(scaleAnim, { toValue: 1, useNativeDriver: false, damping: 18, stiffness: 180 }).start();
  };

  return (
    <RNAnimated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={loading || disabled}
        activeOpacity={0.85}
        style={[{
          height: 52, borderRadius: 16,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: bgColor,
          borderWidth: variant === 'outline' ? 1.5 : 0,
          borderColor: variant === 'outline' ? colors.primary : bgColor,
          opacity: disabled ? 0.45 : 1,
          shadowColor: variant === 'primary' ? colors.primary : variant === 'danger' ? colors.danger : '#000',
          shadowOpacity: (variant === 'primary' || variant === 'danger') ? 0.3 : 0,
          shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: (variant === 'primary' || variant === 'danger') ? 6 : 0,
          flexDirection: 'row', gap: 8,
        }, style]}
      >
        {loading ? <ActivityIndicator color={textColor} size="small" /> : (
          <>
            {icon && <Ionicons name={icon as any} size={18} color={textColor} />}
            <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: textColor, letterSpacing: 0.1 }}>{title}</Text>
          </>
        )}
      </TouchableOpacity>
    </RNAnimated.View>
  );
}

export function Input({ label, value, onChangeText, placeholder, keyboardType, multiline, secureTextEntry, icon, autoCapitalize }: {
  label?: string; value: string; onChangeText: (t: string) => void; placeholder?: string;
  keyboardType?: any; multiline?: boolean; secureTextEntry?: boolean; icon?: string; autoCapitalize?: any;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ marginBottom: spacing.lg }}>
      {label && (
        <Text style={{
          fontSize: fontSize.xs, fontWeight: '600', color: colors.textSecondary,
          letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6,
        }}>{label}</Text>
      )}
      <View style={{
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.6)',
        borderRadius: 14, borderWidth: 1, borderColor: 'rgba(224,213,234,0.5)',
        paddingHorizontal: spacing.md,
      }}>
        {icon && <Ionicons name={icon as any} size={18} color={colors.textTertiary} style={{ marginRight: 8 }} />}
        <TextInput
          style={[{
            flex: 1, height: 50,
            fontSize: fontSize.md, color: colors.text,
          }, multiline && { height: 80, textAlignVertical: 'top', paddingVertical: spacing.md }]}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          keyboardType={keyboardType}
          multiline={multiline}
          secureTextEntry={secureTextEntry}
          autoCapitalize={autoCapitalize}
        />
      </View>
    </View>
  );
}

export function Badge({ text, color }: { text: string; color?: string }) {
  const { colors } = useTheme();
  const accent = color || colors.primary;
  return (
    <View style={{
      backgroundColor: accent + '12', paddingHorizontal: 10, paddingVertical: 3,
      borderRadius: 999, borderWidth: 0.5, borderColor: accent + '20',
    }}>
      <Text style={{ fontSize: 11, fontWeight: '600', color: accent, letterSpacing: 0.2 }}>{text}</Text>
    </View>
  );
}

export function ListItem({ title, subtitle, right, onPress, icon }: {
  title: string; subtitle?: string; right?: React.ReactNode; onPress?: () => void; icon?: string;
}) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      style={{
        ...glass.card,
        flexDirection: 'row', alignItems: 'center',
        padding: spacing.lg, marginBottom: spacing.sm,
      }}
      onPress={onPress} disabled={!onPress}
    >
      {icon && (
        <View style={{
          width: 40, height: 40, borderRadius: 12,
          backgroundColor: colors.primary + '12', alignItems: 'center', justifyContent: 'center', marginRight: spacing.md,
        }}>
          <Ionicons name={icon as any} size={20} color={colors.primary} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.text }}>{title}</Text>
        {subtitle && <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 }}>{subtitle}</Text>}
      </View>
      {right}
      {onPress && <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />}
    </TouchableOpacity>
  );
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md }}>
      <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text }}>{title}</Text>
      {action && (
        <TouchableOpacity onPress={onAction}>
          <Text style={{ fontSize: fontSize.sm, color: colors.primary, fontWeight: '600' }}>{action}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export function EmptyState({ title, subtitle, icon }: { title: string; subtitle?: string; icon?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: 56 }}>
      <View style={{
        width: 68, height: 68, borderRadius: 20,
        backgroundColor: 'rgba(123,47,190,0.08)', alignItems: 'center', justifyContent: 'center',
        marginBottom: spacing.lg,
      }}>
        <Ionicons name={(icon as any) || 'file-tray-outline'} size={30} color={colors.textTertiary} />
      </View>
      <Text style={{ fontSize: fontSize.lg, fontWeight: '600', color: colors.textSecondary }}>{title}</Text>
      {subtitle && <Text style={{ fontSize: fontSize.sm, color: colors.textTertiary, marginTop: spacing.xs, textAlign: 'center', maxWidth: 260, lineHeight: 20 }}>{subtitle}</Text>}
    </View>
  );
}

export function LoadingScreen() {
  const pulseAnim = useRef(new RNAnimated.Value(1)).current;

  useEffect(() => {
    const pulse = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(pulseAnim, { toValue: 1.05, duration: 1200, useNativeDriver: false }),
        RNAnimated.timing(pulseAnim, { toValue: 1, duration: 1200, useNativeDriver: false }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [pulseAnim]);

  return (
    <View style={{ flex: 1, backgroundColor: '#F7F3F9', alignItems: 'center', justifyContent: 'center' }}>
      <RNAnimated.View style={{ transform: [{ scale: pulseAnim }] }}>
        <Image
          source={require('../assets/vishful-logo-DPK24n8p.webp')}
          style={{ width: 100, height: 100, resizeMode: 'contain' }}
        />
      </RNAnimated.View>
      <Text style={{ fontSize: 22, fontWeight: '900', color: '#1E1230', marginTop: 12, letterSpacing: 1 }}>
        <Text style={{ color: '#7B2FBE' }}>VISH</Text>
        <Text style={{ color: '#E8841A' }}>FUL</Text>
      </Text>
      <Text style={{ fontSize: 10, color: '#5C4B70', letterSpacing: 2.5, marginTop: 4 }}>STAY | BELONG | SUCCEED</Text>
      <ActivityIndicator size="small" color="#E8841A" style={{ marginTop: 28 }} />
    </View>
  );
}

export function PickerSelect({ label, value, options, onSelect }: {
  label?: string; value: string; options: { label: string; value: string }[]; onSelect: (v: string) => void;
}) {
  const { colors } = useTheme();
  const [visible, setVisible] = React.useState(false);
  const selected = options.find(o => o.value === value);
  return (
    <View style={{ marginBottom: spacing.lg }}>
      {label && (
        <Text style={{
          fontSize: fontSize.xs, fontWeight: '600', color: colors.textSecondary,
          letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6,
        }}>{label}</Text>
      )}
      <TouchableOpacity
        style={{
          backgroundColor: 'rgba(255,255,255,0.6)',
          borderWidth: 1, borderColor: 'rgba(224,213,234,0.5)', borderRadius: 14,
          paddingHorizontal: spacing.md, height: 50, justifyContent: 'center',
          flexDirection: 'row', alignItems: 'center',
        }}
        onPress={() => setVisible(true)}
      >
        <Text style={{ color: selected ? colors.text : colors.textTertiary, fontSize: fontSize.md, flex: 1 }}>
          {selected?.label || 'Select...'}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.textTertiary} />
      </TouchableOpacity>
      <Modal visible={visible} transparent animationType="slide">
        <TouchableOpacity
          style={{ flex: 1, backgroundColor: 'rgba(30,18,48,0.4)', justifyContent: 'flex-end' }}
          onPress={() => setVisible(false)}
          activeOpacity={1}
        >
          <View style={{
            backgroundColor: '#F7F3F9',
            borderTopLeftRadius: 24, borderTopRightRadius: 24,
            padding: spacing.xl, paddingBottom: 40,
          }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: spacing.lg }} />
            <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text, marginBottom: spacing.lg, textAlign: 'center' }}>
              {label || 'Select'}
            </Text>
            <ScrollView style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false}>
              {options.map(o => (
                <TouchableOpacity
                  key={o.value}
                  style={[{
                    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                    paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderRadius: 12,
                    marginBottom: 2,
                  }, o.value === value && { backgroundColor: colors.primary + '12' }]}
                  onPress={() => { onSelect(o.value); setVisible(false); }}
                >
                  <Text style={{ fontSize: fontSize.md, color: colors.text }}>{o.label}</Text>
                  {o.value === value && <Ionicons name="checkmark" size={20} color={colors.primary} />}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}
// ─── DateField — cross-platform date picker (no native dependency) ────────────
// Displays the value as dd-MMM-yy and opens a pure-JS calendar. Emits ISO
// yyyy-MM-dd via onChange so stored values stay backend-compatible.
export function DateField({
  value, onChange, placeholder = 'Select date', disabled, minYear, maxYear,
}: {
  value?: string | null;
  onChange: (iso: string) => void;
  placeholder?: string;
  disabled?: boolean;
  minYear?: number;
  maxYear?: number;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Date>(() => parseToDate(value) || new Date());

  const openPicker = () => {
    if (disabled) return;
    setView(parseToDate(value) || new Date());
    setOpen(true);
  };

  const selected = parseToDate(value);
  const today = new Date();
  const y = view.getFullYear();
  const m = view.getMonth();
  const firstWeekday = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const sameDay = (d: number, ref: Date | null) =>
    !!ref && ref.getFullYear() === y && ref.getMonth() === m && ref.getDate() === d;

  const shift = (months: number, years = 0) =>
    setView(new Date(y + years, m + months, 1));

  const pick = (d: number) => {
    onChange(toISODate(new Date(y, m, d)));
    setOpen(false);
  };

  const purple = '#7B2FBE';
  const ink = colors?.text || '#1E1230';
  const muted = colors?.textSecondary || '#9B8BAE';

  return (
    <>
      <TouchableOpacity
        onPress={openPicker}
        activeOpacity={0.7}
        style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          borderWidth: 1, borderColor: 'rgba(123,47,190,0.25)', borderRadius: 12,
          paddingHorizontal: 14, paddingVertical: 12,
          backgroundColor: disabled ? 'rgba(240,234,224,0.4)' : 'rgba(255,255,255,0.6)',
        }}
      >
        <Text style={{ fontSize: fontSize.sm, color: selected ? ink : muted }}>
          {selected ? formatDate(value) : placeholder}
        </Text>
        <Ionicons name="calendar-outline" size={18} color={purple} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setOpen(false)}
          style={{ flex: 1, backgroundColor: 'rgba(30,18,48,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 }}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{
            width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 18, padding: 16,
          }}>
            {/* Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <View style={{ flexDirection: 'row', gap: 4 }}>
                <DateNavBtn icon="chevron-back" onPress={() => shift(0, -1)} small />
                <DateNavBtn icon="chevron-back-outline" onPress={() => shift(-1)} />
              </View>
              <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: ink }}>
                {MONTHS_LONG[m]} {y}
              </Text>
              <View style={{ flexDirection: 'row', gap: 4 }}>
                <DateNavBtn icon="chevron-forward-outline" onPress={() => shift(1)} />
                <DateNavBtn icon="chevron-forward" onPress={() => shift(0, 1)} small />
              </View>
            </View>

            {/* Weekday row */}
            <View style={{ flexDirection: 'row', marginBottom: 4 }}>
              {WEEKDAYS_SHORT.map((w) => (
                <Text key={w} style={{ flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '700', color: muted }}>{w}</Text>
              ))}
            </View>

            {/* Day grid */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {cells.map((d, i) => {
                const isSel = d != null && sameDay(d, selected);
                const isToday = d != null && sameDay(d, today);
                return (
                  <View key={i} style={{ width: `${100 / 7}%`, aspectRatio: 1, padding: 2 }}>
                    {d != null ? (
                      <TouchableOpacity
                        onPress={() => pick(d)}
                        style={{
                          flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 10,
                          backgroundColor: isSel ? purple : 'transparent',
                          borderWidth: isToday && !isSel ? 1 : 0, borderColor: purple,
                        }}
                      >
                        <Text style={{ fontSize: fontSize.sm, fontWeight: isSel ? '800' : '500', color: isSel ? '#fff' : ink }}>{d}</Text>
                      </TouchableOpacity>
                    ) : <View style={{ flex: 1 }} />}
                  </View>
                );
              })}
            </View>

            {/* Footer */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}>
              <TouchableOpacity onPress={() => { onChange(''); setOpen(false); }}>
                <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: muted }}>Clear</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { onChange(toISODate(new Date())); setOpen(false); }}>
                <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: purple }}>Today</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setOpen(false)}>
                <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: ink }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

function DateNavBtn({ icon, onPress, small }: { icon: any; onPress: () => void; small?: boolean }) {
  return (
    <TouchableOpacity onPress={onPress} style={{
      width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(123,47,190,0.08)',
    }}>
      <Ionicons name={icon} size={small ? 14 : 18} color="#7B2FBE" />
    </TouchableOpacity>
  );
}
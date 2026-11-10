import React from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LC } from './tokens';

export function LifecycleCard({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return (
    <View style={[{ backgroundColor: LC.cardBg, borderRadius: LC.cardRadius, padding: LC.cardPad, marginBottom: 12 }, LC.cardShadow, style]}>
      {children}
    </View>
  );
}

export function PrimaryButton({ title, icon, onPress, loading, disabled, small }: any) {
  return (
    <Pressable onPress={onPress} disabled={disabled || loading}
      style={{ backgroundColor: disabled ? '#93B4FB' : LC.blue, borderRadius: 10, paddingVertical: small ? 8 : 12,
        paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, flex: small ? 1 : undefined }}>
      {loading ? <ActivityIndicator color="#fff" /> : icon ? <Ionicons name={icon} size={16} color="#fff" /> : null}
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: small ? 13 : 15 }}>{title}</Text>
    </Pressable>
  );
}

export function OutlineButton({ title, icon, onPress, tone = 'neutral', small }: any) {
  const map: any = {
    neutral: { bg: '#fff', fg: LC.ink, bd: LC.border },
    danger:  { bg: LC.redBg, fg: LC.red, bd: '#FCA5A5' },
    success: { bg: '#ECFDF5', fg: LC.green, bd: '#86EFAC' },
  };
  const c = map[tone];
  return (
    <Pressable onPress={onPress}
      style={{ backgroundColor: c.bg, borderColor: c.bd, borderWidth: 1, borderRadius: 10,
        paddingVertical: small ? 8 : 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1 }}>
      {icon ? <Ionicons name={icon} size={15} color={c.fg} /> : null}
      <Text style={{ color: c.fg, fontWeight: '700', fontSize: small ? 13 : 14 }}>{title}</Text>
    </Pressable>
  );
}

export function SearchField({ value, onChangeText, placeholder }: any) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F3F6', borderRadius: 10, paddingHorizontal: 12, height: 40, marginBottom: 12 }}>
      <Ionicons name="search-outline" size={16} color={LC.muted} />
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={LC.muted}
        style={{ flex: 1, marginLeft: 8, fontSize: 14, color: LC.ink }} />
      {value ? (
        <Pressable onPress={() => onChangeText('')} hitSlop={8}>
          <Ionicons name="close-circle" size={16} color={LC.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function KpiTile({ label, value, valueColor }: any) {
  return (
    <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 10, borderWidth: 1, borderColor: LC.border }}>
      <Text style={{ fontSize: 9, fontWeight: '700', color: LC.muted, letterSpacing: 0.5 }}>{label}</Text>
      <Text style={{ fontSize: 15, fontWeight: '800', color: valueColor || LC.ink, marginTop: 4 }}>{value}</Text>
    </View>
  );
}

export function InfoLine({ parts }: { parts: Array<{ text: string; color?: string; bold?: boolean }> }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 6 }}>
      {parts.map((p, i) => (
        <Text key={i} style={{ fontSize: 12, color: p.color || LC.muted, fontWeight: p.bold ? '700' : '500' }}>{p.text}</Text>
      ))}
    </View>
  );
}

export function AvatarInitial({ name }: { name: string }) {
  const ch = (name || '?').trim().charAt(0).toUpperCase();
  return (
    <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: '#EEF2FF', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: LC.blue, fontWeight: '800', fontSize: 14 }}>{ch}</Text>
    </View>
  );
}

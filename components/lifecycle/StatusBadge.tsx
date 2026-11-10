import React from 'react';
import { View, Text } from 'react-native';
import { BADGE, BadgeKind } from './tokens';

export function StatusBadge({ kind, label }: { kind: BadgeKind; label?: string }) {
  const b = BADGE[kind];
  return (
    <View style={{ backgroundColor: b.bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color: b.fg }}>{label ?? b.text}</Text>
    </View>
  );
}

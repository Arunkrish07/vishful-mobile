// ─── FloatingNav ──────────────────────────────────────────────────────────────
// Shared presentational floating bottom navigation used by every role
// (admin / technician / tenant). Style: a frosted white rounded bar floating
// above content; every slot is EQUAL WIDTH so nothing shifts when the active tab
// changes — the active tab simply fills with a solid brand-blue pill (white icon
// + label) in place. Purely presentational: the caller owns navigation state and
// supplies `activeKey` + `onSelect`.

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export type FloatingNavItem = {
  key: string;          // stable id (usually the route name)
  label: string;        // shown under the icon
  icon: string;         // Ionicons name
  activeIcon?: string;  // optional filled variant shown when active
};

const PALETTE = {
  barBg: 'rgba(255,255,255,0.97)',
  chip: '#2563EB',
  idle: '#8A94A6',
  shadow: '#0F172A',
};

export default function FloatingNav({
  items,
  activeKey,
  onSelect,
  bottomInset = 10,
  style,
}: {
  items: FloatingNavItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  bottomInset?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: Math.max(bottomInset, 10) }, style]}
    >
      <View style={styles.bar}>
        {items.map((item) => {
          const on = item.key === activeKey;
          return (
            <TouchableOpacity
              key={item.key}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              accessibilityState={on ? { selected: true } : {}}
              activeOpacity={0.85}
              onPress={() => onSelect(item.key)}
              style={[styles.item, on && styles.itemOn]}
            >
              <Ionicons
                name={(on ? item.activeIcon || item.icon : item.icon) as any}
                size={20}
                color={on ? '#FFFFFF' : PALETTE.idle}
              />
              <Text numberOfLines={1} style={[styles.label, on && styles.labelOn]}>
                {item.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 900,
    elevation: 20,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PALETTE.barBg,
    borderRadius: 26,
    paddingHorizontal: 6,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.05)',
    shadowColor: PALETTE.shadow,
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
  },
  // Every slot is an equal-width column — the active state never changes width.
  item: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 2,
    borderRadius: 16,
    minHeight: 48,
  },
  itemOn: {
    backgroundColor: PALETTE.chip,
  },
  label: {
    marginTop: 3,
    fontSize: 10,
    fontWeight: '600',
    color: PALETTE.idle,
    letterSpacing: 0.1,
  },
  labelOn: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
});

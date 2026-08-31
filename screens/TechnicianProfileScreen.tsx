import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../lib/auth';
import { colors, spacing, fontSize, glass, borderRadius } from '../lib/theme';
import { GlassBackground, Badge } from '../components/shared';
import { Ionicons } from '@expo/vector-icons';
import { fetchTickets, Ticket, STATUS_CONFIG } from '../services/ticketService';

export default function TechnicianProfileScreen() {
  const { user, token, logout } = useAuth();
  const [rawTickets, setRawTickets] = useState<Ticket[] | null>(null);

  useEffect(() => {
    if (!user?.supabaseUserId) return;
    fetchTickets('technician', user.supabaseUserId)
      .then(setRawTickets)
      .catch((e) => console.warn('[TechnicianProfile] fetch error:', e.message));
  }, [user?.supabaseUserId]);

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Logout', style: 'destructive', onPress: () => logout() },
    ]);
  };

  // Compute stats
  const stats = React.useMemo(() => {
    if (!rawTickets) return { total: 0, completed: 0, active: 0, avgResolution: 'N/A' };
    const total = rawTickets.length;
    const completed = rawTickets.filter((t: any) => ['completed', 'closed'].includes(t.status)).length;
    const active = rawTickets.filter((t: any) => !['completed', 'closed'].includes(t.status)).length;

    // Calculate average resolution time
    const resolved = rawTickets.filter((t: any) => t.resolved_at && t.created_at);
    let avgResolution = 'N/A';
    if (resolved.length > 0) {
      const totalMs = resolved.reduce((sum: number, t: any) => sum + (new Date(t.resolved_at).getTime() - new Date(t.created_at).getTime()), 0);
      const avgHours = totalMs / resolved.length / (1000 * 60 * 60);
      avgResolution = avgHours < 24
        ? `${Math.round(avgHours)}h`
        : `${Math.round(avgHours / 24)}d`;
    }

    return { total, completed, active, avgResolution };
  }, [rawTickets]);

  const initials = (user?.userName || 'T')[0].toUpperCase();

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 100 }}>
          {/* Profile Card */}
          <View style={[glass.card, {
            alignItems: 'center', paddingVertical: spacing.xxl,
            borderRadius: 18, borderColor: '#EEF1F6',
            shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
          }]}>
            <View style={{
              width: 80, height: 80, borderRadius: 40,
              backgroundColor: '#6A2C90', alignItems: 'center', justifyContent: 'center',
              shadowColor: '#6A2C90', shadowOpacity: 0.25, shadowRadius: 14, elevation: 6,
              marginBottom: spacing.lg,
            }}>
              <Text style={{ fontSize: 32, fontWeight: '800', color: '#fff' }}>{initials}</Text>
            </View>
            <Text style={{ fontSize: fontSize.xl, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 }}>
              {user?.userName || 'Technician'}
            </Text>
            <Text style={{ fontSize: fontSize.sm, color: '#64748B', marginTop: 4 }}>
              {user?.phone || ''}
            </Text>
            <View style={{ marginTop: spacing.md }}>
              <Badge text="Technician" color="#1D4ED8" />
            </View>
            <Text style={{ fontSize: fontSize.xs, color: '#94A3B8', marginTop: spacing.sm }}>
              {user?.organizationName || 'Vishful Spaces LLP'}
            </Text>
          </View>

          {/* Performance Stats */}
          <Text style={{ fontSize: 17, fontWeight: '800', color: '#0F172A', marginBottom: spacing.md, marginTop: spacing.md }}>
            Performance
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md }}>
            {[
              { label: 'Total', value: stats.total, color: '#1D4ED8', bg: '#EEF3FF', icon: 'layers-outline' },
              { label: 'Active', value: stats.active, color: '#6A2C90', bg: '#F3ECF9', icon: 'construct-outline' },
              { label: 'Done', value: stats.completed, color: '#16A34A', bg: '#DCFCE7', icon: 'checkmark-circle-outline' },
              { label: 'Avg Time', value: stats.avgResolution, color: '#EA580C', bg: '#FFEDD5', icon: 'time-outline' },
            ].map(s => (
              <View key={s.label} style={[glass.card, {
                flex: 1, alignItems: 'center', padding: spacing.md, marginBottom: 0,
                borderRadius: 16, borderColor: '#EEF1F6',
                shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
              }]}>
                <View style={{
                  width: 32, height: 32, borderRadius: 10, backgroundColor: s.bg,
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <Ionicons name={s.icon as any} size={16} color={s.color} />
                </View>
                <Text style={{ fontSize: fontSize.xl, fontWeight: '800', color: '#0F172A', marginTop: 6, letterSpacing: -0.3 }}>
                  {s.value}
                </Text>
                <Text style={{ fontSize: 10, color: '#94A3B8', marginTop: 2 }}>{s.label}</Text>
              </View>
            ))}
          </View>

          {/* Status Breakdown */}
          <View style={[glass.card, { borderRadius: 18, borderColor: '#EEF1F6', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }]}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: '#94A3B8', letterSpacing: 1.5, marginBottom: spacing.md }}>
              STATUS BREAKDOWN
            </Text>
            {[
              // Canonical status keys (from services/ticketService STATUS_CONFIG),
              // ordered by ticket lifecycle. Only non-zero rows render.
              'assigned', 'in_progress', 'waiting_for_parts', 'waiting_for_cost_approval',
              'pending_tenant_approval', 'pending_admin_approval', 'reassigned', 'reopened',
              'on_hold', 'completed', 'closed', 'cancelled',
            ].map(status => {
              const cfg = STATUS_CONFIG[status];
              if (!cfg) return null;
              const count = rawTickets?.filter((t: any) => t.status === status).length || 0;
              if (count === 0) return null;
              return (
                <View key={status} style={{
                  flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                  paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#EEF1F6',
                }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: cfg.color }} />
                    <Text style={{ fontSize: fontSize.sm, color: '#0F172A' }}>{cfg.label}</Text>
                  </View>
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: cfg.color }}>{count}</Text>
                </View>
              );
            })}
          </View>

          {/* Logout */}
          <TouchableOpacity
            style={[glass.card, {
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
              gap: 8, paddingVertical: 16, marginTop: spacing.md,
              borderRadius: 12, borderWidth: 1, borderColor: '#FEE2E2', backgroundColor: '#FFFFFF',
              shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
            }]}
            onPress={handleLogout}
          >
            <Ionicons name="log-out-outline" size={20} color="#DC2626" />
            <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: '#DC2626' }}>Logout</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}
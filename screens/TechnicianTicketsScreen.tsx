import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl,
  ActivityIndicator, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { GlassBackground } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/ThemeContext';
import { glass, spacing, borderRadius, fontSize } from '../lib/theme';
import { fetchTickets, Ticket, STATUS_CONFIG, PRIORITY_CONFIG } from '../services/ticketService';

const FILTER_OPTIONS = [
  { key: 'active', label: 'Active', statuses: ['assigned', 'in_progress', 'waiting_for_parts', 'waiting_for_cost_approval'] },
  { key: 'pending', label: 'Pending Approval', statuses: ['pending_tenant_approval', 'pending_admin_approval'] },
  { key: 'closed', label: 'Closed', statuses: ['closed', 'completed'] },
  { key: 'all', label: 'All', statuses: [] },
];

export default function TechnicianTicketsScreen({ navigation }: any) {
  const { colors } = useTheme();
  const { user } = useAuth();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('active');

  const load = useCallback(async () => {
    try {
      const data = await fetchTickets('technician', user?.supabaseUserId || user?.userId);
      setTickets(data);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const filtered = tickets.filter(t => {
    const opt = FILTER_OPTIONS.find(o => o.key === filter);
    if (!opt || opt.statuses.length === 0) return true;
    return opt.statuses.includes(t.status);
  });

  const activeCount = tickets.filter(t =>
    ['assigned', 'in_progress', 'waiting_for_parts', 'waiting_for_cost_approval'].includes(t.status)
  ).length;

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* Header */}
        <View style={[glass.header, {
          flexDirection: 'row', alignItems: 'center',
          paddingHorizontal: spacing.xl, paddingVertical: spacing.lg,
        }]}>
          <View style={{
            width: 36, height: 36, borderRadius: 11, backgroundColor: '#E8841A',
            alignItems: 'center', justifyContent: 'center', marginRight: 12,
          }}>
            <Ionicons name="hammer-outline" size={20} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary, fontWeight: '600' }}>MY WORK</Text>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: colors.text }}>Assigned Tickets</Text>
          </View>
          {activeCount > 0 && (
            <View style={{ backgroundColor: '#FEF3C7', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text style={{ fontSize: fontSize.xs, fontWeight: '800', color: '#D97706' }}>{activeCount} active</Text>
            </View>
          )}
        </View>

        {/* Filters */}
        <ScrollView
          horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingVertical: spacing.md, gap: 10 }}
        >
          {FILTER_OPTIONS.map(opt => {
            const cnt = opt.statuses.length === 0 ? tickets.length : tickets.filter(t => opt.statuses.includes(t.status)).length;
            const active = filter === opt.key;
            return (
              <TouchableOpacity
                key={opt.key}
                onPress={() => setFilter(opt.key)}
                style={{
                  paddingHorizontal: 18,
                  paddingVertical: 12,
                  borderRadius: 999,
                  backgroundColor: active ? '#E8841A' : 'rgba(255,255,255,0.85)',
                  borderWidth: 1.5,
                  borderColor: active ? '#E8841A' : 'rgba(224,213,234,0.6)',
                  minWidth: 72,
                  alignItems: 'center',
                  shadowColor: active ? '#E8841A' : '#1E1230',
                  shadowOpacity: active ? 0.18 : 0.04,
                  shadowRadius: active ? 8 : 4,
                  shadowOffset: { width: 0, height: 2 },
                  elevation: active ? 3 : 1,
                }}
              >
                <Text style={{
                  fontSize: fontSize.sm,
                  fontWeight: active ? '800' : '600',
                  color: active ? '#fff' : '#5C4B70',
                }}>
                  {opt.label}
                </Text>
                {cnt > 0 && (
                  <View style={{
                    marginTop: 4,
                    backgroundColor: active ? 'rgba(255,255,255,0.3)' : 'rgba(232,132,26,0.12)',
                    borderRadius: 999,
                    paddingHorizontal: 7,
                    paddingVertical: 1,
                  }}>
                    <Text style={{
                      fontSize: 11,
                      fontWeight: '800',
                      color: active ? '#fff' : '#E8841A',
                    }}>{cnt}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {loading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color="#E8841A" />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: spacing.xl, paddingBottom: 100, gap: 12 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#E8841A']} />}
          >
            {filtered.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 60 }}>
                <Ionicons name="checkmark-done-circle-outline" size={56} color={colors.textTertiary} />
                <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text, marginTop: 16 }}>All clear!</Text>
                <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 4 }}>No tickets in this category</Text>
              </View>
            ) : (
              filtered.map(ticket => (
                <TechnicianTicketCard
                  key={ticket.id}
                  ticket={ticket}
                  onPress={() => navigation.navigate('TicketDetail', { ticketId: ticket.id })}
                />
              ))
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </GlassBackground>
  );
}

function TechnicianTicketCard({ ticket, onPress }: { ticket: Ticket; onPress: () => void }) {
  const { colors } = useTheme();
  const statusCfg = STATUS_CONFIG[ticket.status] || STATUS_CONFIG.open;
  const priorityCfg = PRIORITY_CONFIG[ticket.priority] || PRIORITY_CONFIG.medium;
  const isSlaBreached = ticket.sla_deadline && new Date(ticket.sla_deadline) < new Date()
    && !['closed', 'completed', 'pending_admin_approval', 'pending_tenant_approval'].includes(ticket.status);

  const slaHoursLeft = ticket.sla_deadline
    ? Math.round((new Date(ticket.sla_deadline).getTime() - Date.now()) / 3600000)
    : null;

  // Photos from tenant
  const photoUrls: string[] = Array.isArray(ticket.photo_urls) ? ticket.photo_urls : [];
  const hasPhotos = photoUrls.length > 0;

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={[glass.card, { marginBottom: 0 }]}>
      {/* Status indicator bar */}
      <View style={{
        height: 4, borderRadius: 2, backgroundColor: statusCfg.color,
        marginBottom: 12, marginHorizontal: -18, marginTop: -18,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
      }} />

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#E8841A' }}>{ticket.ticket_number}</Text>
            {isSlaBreached && (
              <View style={{ backgroundColor: '#FEE2E2', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999 }}>
                <Text style={{ fontSize: 9, fontWeight: '800', color: '#DC2626' }}>SLA BREACHED</Text>
              </View>
            )}
            {/* Photo badge */}
            {hasPhotos && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#EDE9FE', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999 }}>
                <Ionicons name="camera" size={10} color="#7B2FBE" />
                <Text style={{ fontSize: 9, fontWeight: '800', color: '#7B2FBE' }}>{photoUrls.length}</Text>
              </View>
            )}
          </View>
          <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: colors.text }} numberOfLines={1}>
            {ticket.issue_type || 'Maintenance Issue'}
          </Text>
        </View>
        <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: statusCfg.bg }}>
          <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: statusCfg.color }}>{statusCfg.label}</Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 14, marginBottom: 10, flexWrap: 'wrap' }}>
        {ticket.tenant_name && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Ionicons name="person-outline" size={13} color={colors.textTertiary} />
            <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>{ticket.tenant_name}</Text>
          </View>
        )}
        {ticket.apartment_code && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Ionicons name="location-outline" size={13} color={colors.textTertiary} />
            <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>{ticket.apartment_code}</Text>
          </View>
        )}
        {ticket.description && (
          <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary }} numberOfLines={1}>
            {ticket.description}
          </Text>
        )}
      </View>

      {/* ── Photo thumbnails strip (visible to technician) ───────────────────── */}
      {hasPhotos && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginBottom: 10 }}
          contentContainerStyle={{ gap: 6 }}
        >
          {photoUrls.slice(0, 4).map((url, idx) => (
            <View key={idx} style={{ position: 'relative' }}>
              <Image
                source={{ uri: url }}
                style={{
                  width: 64, height: 64, borderRadius: borderRadius.md,
                  borderWidth: 1, borderColor: colors.border,
                }}
                resizeMode="cover"
              />
              {/* Show "+N more" overlay on last visible if there are more */}
              {idx === 3 && photoUrls.length > 4 && (
                <View style={{
                  position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
                  borderRadius: borderRadius.md, alignItems: 'center', justifyContent: 'center',
                }}>
                  <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.sm }}>+{photoUrls.length - 4}</Text>
                </View>
              )}
            </View>
          ))}
          <View style={{
            width: 64, height: 64, borderRadius: borderRadius.md,
            backgroundColor: '#F5F3FF', borderWidth: 1, borderColor: '#C4B5FD',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Ionicons name="eye-outline" size={20} color="#7B2FBE" />
            <Text style={{ fontSize: 9, color: '#7B2FBE', fontWeight: '700', marginTop: 2 }}>View All</Text>
          </View>
        </ScrollView>
      )}

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: priorityCfg.bg }}>
          <Text style={{ fontSize: 10, fontWeight: '700', color: priorityCfg.color }}>{priorityCfg.label}</Text>
        </View>
        {slaHoursLeft !== null && !isSlaBreached && (
          <Text style={{ fontSize: 11, color: slaHoursLeft < 4 ? '#DC2626' : colors.textTertiary, fontWeight: slaHoursLeft < 4 ? '700' : '400' }}>
            {slaHoursLeft > 0 ? `${slaHoursLeft}h left` : 'Due now'}
          </Text>
        )}
        {!ticket.sla_deadline && (
          <Text style={{ fontSize: 11, color: colors.textTertiary }}>
            {formatDate(ticket.created_at, '')}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}
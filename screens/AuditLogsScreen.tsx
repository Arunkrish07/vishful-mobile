/**
 * AuditLogsScreen.tsx — mobile port of web src/pages/AuditLogs.tsx.
 * Server-paginated audit_logs with table/action filters and performer names.
 * Data: sb.listAuditLogs({ page, pageSize, tableName, action }).
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, Modal, TextInput, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import * as sb from '../lib/supabaseService';
import { GlassBackground } from '../components/shared';

const TABLE_OPTIONS = [
  'all', 'properties', 'apartments', 'beds', 'bed_rates',
  'owners', 'owner_contracts',
  'tenants', 'tenant_allotments', 'invoices', 'receipts',
  'announcements', 'electricity_readings', 'eb_rates',
  'team_members', 'team_payments', 'team_attendance',
  'issue_types', 'ticket_assignment_rules', 'tickets',
];
const ACTION_OPTIONS = ['all', 'created', 'updated', 'deleted'];
const PAGE_SIZE = 50;

const ACTION_COLOR: Record<string, string> = {
  created: '#16a34a', updated: '#2563EB', deleted: '#DC2626',
};

function fmtTs(s: string | null) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderChanges(changes: any): string {
  if (!changes || typeof changes !== 'object') return '—';
  const entries = Object.entries(changes).filter(([k]) => !['organization_id', 'created_at', 'id'].includes(k));
  if (entries.length === 0) return '—';
  return entries.slice(0, 5).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v === null ? 'null' : String(v).slice(0, 24)}`).join('  ·  ')
    + (entries.length > 5 ? `  +${entries.length - 5} more` : '');
}

export default function AuditLogsScreen() {
  const navigation = useNavigation<any>();
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [tableFilter, setTableFilter] = useState('all');
  const [actionFilter, setActionFilter] = useState('all');
  const [performedBy, setPerformedBy] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const r = await sb.listAuditLogs({
        page, pageSize: PAGE_SIZE, tableName: tableFilter, action: actionFilter,
        performedBy: performedBy.trim() || undefined,
        from: fromDate.trim() || undefined,
        to: toDate.trim() || undefined,
      });
      setRows(r?.rows || []);
      setTotal(r?.total || 0);
    } catch {
      setRows([]); setTotal(0);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [page, tableFilter, actionFilter, performedBy, fromDate, toDate]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { load(); }, [page, tableFilter, actionFilter, performedBy, fromDate, toDate]);
  // Reset to first page when a filter changes.
  useEffect(() => { setPage(0); }, [tableFilter, actionFilter, performedBy, fromDate, toDate]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12 }}>
          <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center' }}>
            <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 }}>Audit Logs</Text>
            <Text style={{ fontSize: 13, color: '#6B7280', fontWeight: '500', marginTop: 2 }}>Who changed what</Text>
          </View>
        </View>

        {/* Filters */}
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, alignItems: 'center' }}>
            <TouchableOpacity onPress={() => setTablePickerOpen(true)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: '#E5E7EB' }}>
              <Ionicons name="filter" size={13} color="#2563EB" />
              <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>
                {tableFilter === 'all' ? 'All tables' : tableFilter.replace(/_/g, ' ')}
              </Text>
              <Ionicons name="chevron-down" size={12} color="#2563EB" />
            </TouchableOpacity>
            {ACTION_OPTIONS.map(a => (
              <TouchableOpacity key={a} onPress={() => setActionFilter(a)}
                style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: actionFilter === a ? '#2563EB' : 'rgba(37,99,235,0.1)' }}>
                <Text style={{ fontSize: 12, fontWeight: '700', textTransform: 'capitalize', color: actionFilter === a ? '#fff' : '#2563EB' }}>{a}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Performed-by + date-range filters */}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <TextInput
              value={performedBy}
              onChangeText={setPerformedBy}
              placeholder="Performed by (user id)"
              placeholderTextColor="#6B7280"
              autoCapitalize="none"
              style={{ flex: 1.4, fontSize: 12, color: '#111827', backgroundColor: '#fff', borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 }}
            />
            <TextInput
              value={fromDate}
              onChangeText={setFromDate}
              placeholder="From (YYYY-MM-DD)"
              placeholderTextColor="#6B7280"
              autoCapitalize="none"
              style={{ flex: 1, fontSize: 12, color: '#111827', backgroundColor: '#fff', borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 }}
            />
            <TextInput
              value={toDate}
              onChangeText={setToDate}
              placeholder="To (YYYY-MM-DD)"
              placeholderTextColor="#6B7280"
              autoCapitalize="none"
              style={{ flex: 1, fontSize: 12, color: '#111827', backgroundColor: '#fff', borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 }}
            />
          </View>
        </View>

        {loading && !refreshing ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color="#2563EB" />
            <Text style={{ marginTop: 12, color: '#556274' }}>Loading audit logs…</Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#2563EB" />}
          >
            {rows.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 60 }}>
                <Ionicons name="document-text-outline" size={56} color="rgba(37,99,235,0.18)" />
                <Text style={{ marginTop: 12, color: '#6B7280' }}>No audit logs found</Text>
              </View>
            ) : rows.map((log) => (
              <View key={log.id} style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#E5E7EB' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
                    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: (ACTION_COLOR[log.action] || '#2563EB') + '22' }}>
                      <Text style={{ fontSize: 10, fontWeight: '800', textTransform: 'capitalize', color: ACTION_COLOR[log.action] || '#2563EB' }}>{log.action}</Text>
                    </View>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#111827' }} numberOfLines={1}>{(log.tableName || '').replace(/_/g, ' ')}</Text>
                  </View>
                  <Text style={{ fontSize: 10, color: '#6B7280' }}>{fmtTs(log.performedAt)}</Text>
                </View>
                <Text style={{ fontSize: 12, color: '#556274', marginBottom: 4 }}>{renderChanges(log.changes)}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 11, color: '#2563EB', fontWeight: '600' }}>{log.performerName}</Text>
                  {log.recordId ? <Text style={{ fontSize: 10, color: '#6B7280', fontFamily: 'monospace' as any }}>{String(log.recordId).slice(0, 8)}…</Text> : null}
                </View>
              </View>
            ))}

            {/* Pagination */}
            {total > PAGE_SIZE && (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, marginTop: 8 }}>
                <TouchableOpacity disabled={page <= 0} onPress={() => setPage(p => Math.max(0, p - 1))}
                  style={{ opacity: page <= 0 ? 0.35 : 1, padding: 8 }}>
                  <Ionicons name="chevron-back" size={22} color="#2563EB" />
                </TouchableOpacity>
                <Text style={{ fontSize: 13, color: '#556274', fontWeight: '700' }}>Page {page + 1} of {totalPages}</Text>
                <TouchableOpacity disabled={page + 1 >= totalPages} onPress={() => setPage(p => p + 1)}
                  style={{ opacity: page + 1 >= totalPages ? 0.35 : 1, padding: 8 }}>
                  <Ionicons name="chevron-forward" size={22} color="#2563EB" />
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>
        )}

        {/* Table picker modal */}
        <Modal visible={tablePickerOpen} transparent animationType="fade" onRequestClose={() => setTablePickerOpen(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setTablePickerOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(30,18,48,0.45)', justifyContent: 'center', padding: 32 }}>
            <View style={{ backgroundColor: '#fff', borderRadius: 18, overflow: 'hidden', maxHeight: '70%' }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: '#111827', padding: 16, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>Filter by table</Text>
              <ScrollView>
                {TABLE_OPTIONS.map(t => (
                  <TouchableOpacity key={t} onPress={() => { setTableFilter(t); setTablePickerOpen(false); }}
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(37,99,235,0.05)' }}>
                    <Text style={{ fontSize: 14, fontWeight: tableFilter === t ? '800' : '500', color: tableFilter === t ? '#2563EB' : '#111827', textTransform: t === 'all' ? 'none' : 'capitalize' }}>{t === 'all' ? 'All tables' : t.replace(/_/g, ' ')}</Text>
                    {tableFilter === t && <Ionicons name="checkmark" size={18} color="#2563EB" />}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </TouchableOpacity>
        </Modal>
      </SafeAreaView>
    </GlassBackground>
  );
}

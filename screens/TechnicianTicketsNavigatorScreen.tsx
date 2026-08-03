/**
 * ─────────────────────────────────────────────────────────────
 *  TECHNICIAN TICKETS NAVIGATOR  — UPDATED
 *
 *  CHANGES FROM PREVIOUS VERSION:
 *  1. After DiagnosticFlow.onComplete → show CostEstimateReviewModal
 *     with AI-prefilled parts, editable qty/price, then send to admin.
 *  2. "Mark Complete" button → updateTicketStatus('completed') which
 *     routes to pending_tenant_approval (tenant-created) or
 *     pending_admin_approval (admin-created) — then shows confirmation.
 *  3. AdminCostApprovalSection inside TicketDetailScreen shows pending
 *     cost estimates with approve/decline + editable qty/price (admin only).
 *  4. PurchaseRecordModal for technician to upload invoice after parts arrive.
 *  5. CostEstimateReviewModal replaces the plain CostEstimateModal —
 *     pre-populates from DiagnosticFlow result, fully editable, then calls
 *     submitCostEstimates which moves ticket to waiting_for_cost_approval.
 *
 *  UNCHANGED: All other components (tabs, cards, filters, reassign, logs).
 * ─────────────────────────────────────────────────────────────
 */

import React, {
  useState, useEffect, useCallback, useRef, useMemo,
} from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Animated,
  RefreshControl, ActivityIndicator, Image, Dimensions,
  FlatList, Modal, TextInput, Alert, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/ThemeContext';
import { GlassBackground, DateField } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { DiagnosticFlow, DiagnosticFlowResult } from './DiagnosticFlow';
import TechnicianProfileScreen from './TechnicianProfileScreen';
import {
  fetchTickets,
  fetchTicket,
  fetchTicketLogs,
  updateTicketStatus,
  reassignTicket,
  fetchTeamMembers,
  submitDiagnosis,
  fetchCostEstimates,
  submitCostEstimates,
  approveCostEstimate,
  recordPurchase,
  fetchPurchases,
  uploadTicketPhoto,
  saveTicketResolution,
  postTicketComment,
  fetchVendors,
  fetchTicketResolution,
  unlockResolutionEditing,
  fetchBankAccounts,
  extractPaymentProof,
  Ticket,
  CostEstimate,
  STATUS_CONFIG,
  PRIORITY_CONFIG,
} from '../services/ticketService';

const { width: SW } = Dimensions.get('window');
const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// ─── Design tokens ────────────────────────────────────────────
const BRAND       = '#E8841A';
const BRAND_DARK  = '#C46A0E';
const BRAND_LIGHT = 'rgba(232,132,26,0.12)';

// ─── Pill ─────────────────────────────────────────────────────
function Pill({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
      <Text style={{ fontSize: 10, fontWeight: '800', color, letterSpacing: 0.4 }}>{label.toUpperCase()}</Text>
    </View>
  );
}

// ─── SLA badge ────────────────────────────────────────────────
function SlaBadge({ deadline, status }: { deadline: string | null; status: string }) {
  if (!deadline) return null;
  const done = ['closed', 'completed', 'pending_admin_approval', 'pending_tenant_approval'];
  const hoursLeft = Math.round((new Date(deadline).getTime() - Date.now()) / 3600000);
  const breached = hoursLeft < 0 && !done.includes(status);
  if (done.includes(status)) return null;
  if (breached) return <Pill label="SLA Breached" color="#DC2626" bg="#FEE2E2" />;
  if (hoursLeft < 6) return <Pill label={`${hoursLeft}h left`} color="#D97706" bg="#FEF3C7" />;
  return <Text style={{ fontSize: 11, color: '#9CA3AF' }}>{hoursLeft}h left</Text>;
}

// ─── SLA Countdown Timer (live, for ticket detail) ────────────
function SlaCountdownTimer({ deadline, status }: { deadline: string | null; status: string }) {
  const { colors } = useTheme();
  const done = ['closed', 'pending_admin_approval', 'pending_tenant_approval'];
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (!deadline || done.includes(status)) return;
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, [deadline, status]);

  if (!deadline) return null;
  if (done.includes(status)) return null;

  const msLeft = new Date(deadline).getTime() - now;
  const breached = msLeft < 0;
  const absMs = Math.abs(msLeft);
  const totalMins = Math.floor(absMs / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  const label = h > 0 ? `${h}h ${m}m` : `${m}m`;

  const bgColor   = breached ? 'rgba(220,38,38,0.08)' : msLeft < 6 * 3600000 ? 'rgba(217,119,6,0.08)' : 'rgba(34,197,94,0.08)';
  const txtColor  = breached ? '#DC2626' : msLeft < 6 * 3600000 ? '#D97706' : '#16A34A';
  const borderClr = breached ? 'rgba(220,38,38,0.3)' : msLeft < 6 * 3600000 ? 'rgba(217,119,6,0.3)' : 'rgba(34,197,94,0.3)';
  const iconName  = breached ? 'alert-circle-outline' : 'timer-outline';

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: bgColor, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: borderClr, marginHorizontal: 16, marginBottom: 4 }}>
      <Ionicons name={iconName as any} size={15} color={txtColor} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 10, fontWeight: '700', color: txtColor, letterSpacing: 0.4 }}>
          {breached ? 'SLA BREACHED' : 'SLA REMAINING'}
        </Text>
        <Text style={{ fontSize: 13, fontWeight: '800', color: txtColor }}>
          {breached ? `${label} overdue` : `${label} left`}
        </Text>
      </View>
      <Text style={{ fontSize: 10, color: colors.textTertiary }}>
        Due {new Date(deadline).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
      </Text>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════
//  1. TICKETS DASHBOARD
// ════════════════════════════════════════════════════════════════
function TicketsDashboardScreen({ navigation }: any) {
  const { colors } = useTheme();
  const { user } = useAuth();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const load = useCallback(async () => {
    try {
      const data = await fetchTickets('technician', user?.supabaseUserId || user?.userId);
      setTickets(data);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: false
      }).start();
    } finally { setLoading(false); setRefreshing(false); }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => {
    const active  = tickets.filter(t => ['assigned', 'in_progress'].includes(t.status));
    const waiting = tickets.filter(t => ['waiting_for_cost_approval', 'waiting_for_parts'].includes(t.status));
    const pending = tickets.filter(t => ['pending_tenant_approval', 'pending_admin_approval'].includes(t.status));
    const closed  = tickets.filter(t => ['closed', 'completed'].includes(t.status));
    const breached = tickets.filter(t => {
      if (!t.sla_deadline) return false;
      if (['closed','completed','pending_admin_approval','pending_tenant_approval'].includes(t.status)) return false;
      return new Date(t.sla_deadline) < new Date();
    });
    return { active, waiting, pending, closed, breached, total: tickets.length };
  }, [tickets]);

  const urgent = useMemo(() =>
    tickets.filter(t =>
      !['closed','completed'].includes(t.status) &&
      (stats.breached.some(b => b.id === t.id) ||
        (['critical','high'].includes(t.priority) && t.status === 'assigned'))
    ).slice(0, 3),
    [tickets, stats]);

  const StatCard = ({ label, value, color, bg, icon, onPress }: any) => (
    <TouchableOpacity
      onPress={onPress} activeOpacity={0.8}
      style={{ flex: 1, backgroundColor: bg, borderRadius: 18, padding: 16, minHeight: 90, justifyContent: 'space-between', borderWidth: 1, borderColor: `${color}30` }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Text style={{ fontSize: 28, fontWeight: '800', color }}>{value}</Text>
        <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: `${color}20`, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name={icon} size={16} color={color} />
        </View>
      </View>
      <Text style={{ fontSize: 11, fontWeight: '700', color: `${color}CC`, letterSpacing: 0.3 }}>{label.toUpperCase()}</Text>
    </TouchableOpacity>
  );

  if (loading) return (
    <GlassBackground><SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator size="large" color={BRAND} /></SafeAreaView></GlassBackground>
  );

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: 120, gap: 20 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} colors={[BRAND]} />}
        >
          <Animated.View style={{ opacity: fadeAnim }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
              <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                <Ionicons name="grid-outline" size={20} color="#fff" />
              </View>
              <View>
                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary, letterSpacing: 1 }}>OVERVIEW</Text>
                <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text }}>Tickets Dashboard</Text>
              </View>
            </View>
          </Animated.View>

          <Animated.View style={{ gap: 10, opacity: fadeAnim }}>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <StatCard label="Active" value={stats.active.length} color={BRAND} bg={BRAND_LIGHT} icon="hammer-outline"
                onPress={() => navigation.navigate('MyTickets', { filterKey: 'active' })} />
              <StatCard label="Waiting" value={stats.waiting.length} color="#7C3AED" bg="rgba(124,58,237,0.1)" icon="time-outline"
                onPress={() => navigation.navigate('MyTickets', { filterKey: 'waiting' })} />
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <StatCard label="Pending Approval" value={stats.pending.length} color="#0284C7" bg="rgba(2,132,199,0.1)" icon="checkmark-circle-outline"
                onPress={() => navigation.navigate('MyTickets', { filterKey: 'pending' })} />
              <StatCard label="SLA Breached" value={stats.breached.length}
                color={stats.breached.length > 0 ? '#DC2626' : '#7B6B90'}
                bg={stats.breached.length > 0 ? 'rgba(220,38,38,0.1)' : 'rgba(107,114,128,0.08)'}
                icon="warning-outline"
                onPress={() => navigation.navigate('MyTickets', { filterKey: 'breached' })} />
            </View>
          </Animated.View>

          <Animated.View style={{ opacity: fadeAnim, backgroundColor: colors.surface, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: colors.border }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>Completion Rate</Text>
              <Text style={{ fontSize: 13, fontWeight: '800', color: '#22C55E' }}>
                {stats.total > 0 ? Math.round((stats.closed.length / stats.total) * 100) : 0}%
              </Text>
            </View>
            <View style={{ height: 8, backgroundColor: colors.border, borderRadius: 999 }}>
              <View style={{ height: 8, borderRadius: 999, backgroundColor: '#22C55E', width: `${stats.total > 0 ? (stats.closed.length / stats.total) * 100 : 0}%` }} />
            </View>
            <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 6 }}>{stats.closed.length} closed of {stats.total} total</Text>
          </Animated.View>

          {urgent.length > 0 && (
            <Animated.View style={{ opacity: fadeAnim }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Ionicons name="flame" size={16} color="#DC2626" />
                <Text style={{ fontSize: 14, fontWeight: '800', color: colors.text }}>Needs Attention</Text>
                <View style={{ backgroundColor: '#FEE2E2', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 10, fontWeight: '800', color: '#DC2626' }}>{urgent.length}</Text>
                </View>
              </View>
              {urgent.map(t => (
                <UrgentTicketRow key={t.id} ticket={t} onPress={() => navigation.navigate('TicketDetail', { ticketId: t.id })} />
              ))}
            </Animated.View>
          )}

          <Animated.View style={{ opacity: fadeAnim }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: colors.text }}>Recent Tickets</Text>
              <TouchableOpacity onPress={() => navigation.navigate('MyTickets')}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: BRAND }}>View All →</Text>
              </TouchableOpacity>
            </View>
            {tickets.slice(0, 5).map(t => (
              <DashboardTicketRow key={t.id} ticket={t} onPress={() => navigation.navigate('TicketDetail', { ticketId: t.id })} />
            ))}
          </Animated.View>
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

function UrgentTicketRow({ ticket, onPress }: { ticket: Ticket; onPress: () => void }) {
  const { colors } = useTheme();
  const statusCfg = STATUS_CONFIG[ticket.status] || STATUS_CONFIG.open;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85}
      style={{ backgroundColor: 'rgba(220,38,38,0.06)', borderRadius: 14, padding: 14, borderWidth: 1.5, borderColor: 'rgba(220,38,38,0.2)', marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(220,38,38,0.12)', alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name="alert-circle" size={20} color="#DC2626" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 12, fontWeight: '800', color: '#DC2626', marginBottom: 2 }}>{ticket.ticket_number}</Text>
        <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }} numberOfLines={1}>{ticket.issue_type_name || ticket.issue_type || 'Maintenance Issue'}</Text>
        <Text style={{ fontSize: 11, color: colors.textSecondary }}>
          {[ticket.apartment_code, ticket.bed_code, ticket.tenant_name ? `· ${ticket.tenant_name}` : ''].filter(Boolean).join(' ')}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Pill label={statusCfg.label} color={statusCfg.color} bg={statusCfg.bg} />
        <SlaBadge deadline={ticket.sla_deadline} status={ticket.status} />
      </View>
    </TouchableOpacity>
  );
}

function DashboardTicketRow({ ticket, onPress }: { ticket: Ticket; onPress: () => void }) {
  const { colors } = useTheme();
  const statusCfg = STATUS_CONFIG[ticket.status] || STATUS_CONFIG.open;
  const priorityCfg = PRIORITY_CONFIG[ticket.priority] || PRIORITY_CONFIG.medium;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85}
      style={{ backgroundColor: colors.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ width: 8, height: 40, borderRadius: 4, backgroundColor: statusCfg.color }} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 11, fontWeight: '700', color: BRAND }}>{ticket.ticket_number}</Text>
        <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }} numberOfLines={1}>{ticket.issue_type_name || ticket.issue_type || 'Maintenance Issue'}</Text>
        <Text style={{ fontSize: 11, color: colors.textSecondary }}>
          {[ticket.apartment_code, ticket.bed_code].filter(Boolean).join(' · ') || '—'}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Pill label={statusCfg.label} color={statusCfg.color} bg={statusCfg.bg} />
        <View style={{ backgroundColor: priorityCfg.bg, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 }}>
          <Text style={{ fontSize: 10, fontWeight: '700', color: priorityCfg.color }}>{priorityCfg.label}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ════════════════════════════════════════════════════════════════
//  TICKET CARD SKELETON — loading placeholder
// ════════════════════════════════════════════════════════════════
function SkeletonBox({ width, height, borderRadius = 8, style }: { width?: number | string; height: number; borderRadius?: number; style?: any }) {
  const opacity = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.9, duration: 700, useNativeDriver: false }),
        Animated.timing(opacity, { toValue: 0.4, duration: 700, useNativeDriver: false }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);
  return (
    <Animated.View style={[{ width, height, borderRadius, backgroundColor: '#E5DFF0' }, { opacity }, style]} />
  );
}

function TicketCardSkeleton() {
  const { colors } = useTheme();
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: 20, overflow: 'hidden', borderWidth: 1, borderColor: colors.border }}>
      {/* Status bar at top */}
      <SkeletonBox width="40%" height={4} borderRadius={0} />
      <View style={{ padding: 16, gap: 10 }}>
        {/* Top row: ticket number + status badge */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ gap: 6 }}>
            <SkeletonBox width={100} height={10} borderRadius={6} />
            <SkeletonBox width={180} height={16} borderRadius={6} />
            <SkeletonBox width={120} height={10} borderRadius={6} />
          </View>
          <SkeletonBox width={72} height={24} borderRadius={999} />
        </View>
        {/* Meta row: tenant, apartment, bed */}
        <View style={{ flexDirection: 'row', gap: 14 }}>
          <SkeletonBox width={90} height={12} borderRadius={6} />
          <SkeletonBox width={50} height={12} borderRadius={6} />
          <SkeletonBox width={40} height={12} borderRadius={6} />
        </View>
        {/* Footer row: priority badge + SLA */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <SkeletonBox width={56} height={22} borderRadius={999} />
          <SkeletonBox width={70} height={12} borderRadius={6} />
        </View>
      </View>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════
//  2. MY TICKETS
// ════════════════════════════════════════════════════════════════
const FILTERS = [
  { key: 'all',     label: 'All',          statuses: [] as string[] },
  { key: 'active',  label: 'Active',       statuses: ['assigned', 'in_progress'] },
  { key: 'waiting', label: 'Waiting',      statuses: ['waiting_for_cost_approval', 'waiting_for_parts'] },
  { key: 'pending', label: 'Approvals',    statuses: ['pending_tenant_approval', 'pending_admin_approval'] },
  { key: 'closed',  label: 'Closed',       statuses: ['closed', 'completed'] },
  { key: 'breached',label: 'SLA Breached', statuses: [] },
];

function MyTicketsScreen({ navigation, route }: any) {
  const { colors } = useTheme();
  const { user } = useAuth();
  const [tickets, setTickets]     = useState<Ticket[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter]       = useState<string>(route?.params?.filterKey || 'all');

  useEffect(() => { if (route?.params?.filterKey) setFilter(route.params.filterKey); }, [route?.params?.filterKey]);

  const load = useCallback(async () => {
    try {
      const data = await fetchTickets('technician', user?.supabaseUserId || user?.userId);
      setTickets(data);
    } finally { setLoading(false); setRefreshing(false); }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const opt = FILTERS.find(f => f.key === filter);
    if (!opt) return tickets;
    if (filter === 'breached') {
      return tickets.filter(t => {
        if (!t.sla_deadline) return false;
        if (['closed','completed','pending_admin_approval','pending_tenant_approval'].includes(t.status)) return false;
        return new Date(t.sla_deadline) < new Date();
      });
    }
    if (opt.statuses.length === 0) return tickets;
    return tickets.filter(t => opt.statuses.includes(t.status));
  }, [tickets, filter]);

  const getCount = (key: string) => {
    const opt = FILTERS.find(f => f.key === key);
    if (!opt) return 0;
    if (key === 'breached') {
      return tickets.filter(t => {
        if (!t.sla_deadline) return false;
        if (['closed','completed','pending_admin_approval','pending_tenant_approval'].includes(t.status)) return false;
        return new Date(t.sla_deadline) < new Date();
      }).length;
    }
    if (opt.statuses.length === 0) return tickets.length;
    return tickets.filter(t => opt.statuses.includes(t.status)).length;
  };

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 }}>
          <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
            <Ionicons name="list-outline" size={20} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary, letterSpacing: 1 }}>MY WORK</Text>
            <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text }}>My Tickets</Text>
          </View>
          {getCount('active') > 0 && (
            <View style={{ backgroundColor: BRAND_LIGHT, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 }}>
              <Text style={{ fontSize: 12, fontWeight: '800', color: BRAND }}>{getCount('active')} active</Text>
            </View>
          )}
        </View>

        {/* ── Filter tabs — fixed height so they never stretch vertically ── */}
        <View style={{ height: 52 }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 8, gap: 8, alignItems: 'center' }}
          >
            {FILTERS.map(opt => {
              const cnt = getCount(opt.key);
              const isActive = filter === opt.key;
              const isBreach = opt.key === 'breached' && cnt > 0;
              return (
                <TouchableOpacity key={opt.key} onPress={() => setFilter(opt.key)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: isActive ? (isBreach ? '#DC2626' : BRAND) : colors.surface, borderWidth: 1.5, borderColor: isActive ? (isBreach ? '#DC2626' : BRAND) : colors.border }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: isActive ? '#fff' : isBreach ? '#DC2626' : colors.textSecondary }}>{opt.label}</Text>
                  {cnt > 0 && (
                    <View style={{ backgroundColor: isActive ? 'rgba(255,255,255,0.25)' : isBreach ? '#FEE2E2' : BRAND_LIGHT, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1 }}>
                      <Text style={{ fontSize: 10, fontWeight: '800', color: isActive ? '#fff' : isBreach ? '#DC2626' : BRAND }}>{cnt}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {/* ── Content area — flex: 1 so it fills remaining height ── */}
        <View style={{ flex: 1 }}>
          {loading ? (
            <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120, gap: 12 }} scrollEnabled={false}>
              {[1, 2, 3, 4].map(i => (
                <TicketCardSkeleton key={i} />
              ))}
            </ScrollView>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={t => t.id}
              contentContainerStyle={{ padding: 20, paddingBottom: 120, gap: 12 }}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} colors={[BRAND]} />}
              ListEmptyComponent={
                <View style={{ alignItems: 'center', paddingTop: 80 }}>
                  <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: `${BRAND}15`, alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
                    <Ionicons name="checkmark-done-circle-outline" size={36} color={BRAND} />
                  </View>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>All clear!</Text>
                  <Text style={{ fontSize: 14, color: colors.textSecondary, marginTop: 4 }}>No tickets in this category</Text>
                </View>
              }
              renderItem={({ item }) => (
                <TicketCard ticket={item} onPress={() => navigation.navigate('TicketDetail', { ticketId: item.id })} />
              )}
            />
          )}
        </View>
      </SafeAreaView>
    </GlassBackground>
  );
}

function TicketCard({ ticket, onPress }: { ticket: Ticket; onPress: () => void }) {
  const { colors } = useTheme();
  const statusCfg   = STATUS_CONFIG[ticket.status] || STATUS_CONFIG.open;
  const priorityCfg = PRIORITY_CONFIG[ticket.priority] || PRIORITY_CONFIG.medium;
  const photoUrls: string[] = Array.isArray(ticket.photo_urls) ? ticket.photo_urls : [];

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85}
      style={{ backgroundColor: colors.surface, borderRadius: 20, overflow: 'hidden', borderWidth: 1, borderColor: colors.border, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 3 }}>
      <View style={{ height: 4, backgroundColor: statusCfg.color }} />
      <View style={{ padding: 16 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <Text style={{ fontSize: 11, fontWeight: '800', color: BRAND, letterSpacing: 0.3 }}>{ticket.ticket_number}</Text>
              {photoUrls.length > 0 && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#EDE9FE', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999 }}>
                  <Ionicons name="camera" size={9} color="#7C3AED" />
                  <Text style={{ fontSize: 9, fontWeight: '800', color: '#7C3AED' }}>{photoUrls.length}</Text>
                </View>
              )}
            </View>
            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }} numberOfLines={1}>{ticket.issue_type_name || ticket.issue_type || 'Maintenance Issue'}</Text>
            {ticket.issue_subtype && <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 1 }}>{ticket.issue_subtype}</Text>}
          </View>
          <Pill label={statusCfg.label} color={statusCfg.color} bg={statusCfg.bg} />
        </View>
        <View style={{ flexDirection: 'row', gap: 14, marginBottom: 10, flexWrap: 'wrap' }}>
          {ticket.tenant_name && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="person-circle-outline" size={13} color={colors.textTertiary} />
              <Text style={{ fontSize: 12, color: colors.textSecondary, fontWeight: '600' }}>{ticket.tenant_name}</Text>
            </View>
          )}
          {ticket.apartment_code && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="business-outline" size={13} color={colors.textTertiary} />
              <Text style={{ fontSize: 12, color: colors.textSecondary, fontWeight: '600' }}>{ticket.apartment_code}</Text>
            </View>
          )}
          {ticket.bed_code && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="bed-outline" size={13} color={colors.textTertiary} />
              <Text style={{ fontSize: 12, color: colors.textSecondary, fontWeight: '600' }}>{ticket.bed_code}</Text>
            </View>
          )}
        </View>
        {photoUrls.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }} contentContainerStyle={{ gap: 6 }}>
            {photoUrls.slice(0, 4).map((url, idx) => (
              <View key={idx} style={{ position: 'relative' }}>
                <Image source={{ uri: url }} style={{ width: 60, height: 60, borderRadius: 10, borderWidth: 1, borderColor: colors.border }} resizeMode="cover" />
                {idx === 3 && photoUrls.length > 4 && (
                  <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>+{photoUrls.length - 4}</Text>
                  </View>
                )}
              </View>
            ))}
          </ScrollView>
        )}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ backgroundColor: priorityCfg.bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: priorityCfg.color }}>{priorityCfg.label}</Text>
          </View>
          <SlaBadge deadline={ticket.sla_deadline} status={ticket.status} />
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ════════════════════════════════════════════════════════════════
//  3. TICKET DETAIL  — updated with full cost flow
// ════════════════════════════════════════════════════════════════
function TicketDetailScreen({ navigation, route }: any) {
  const { ticketId } = route.params;
  const { colors } = useTheme();
  const { user } = useAuth();

  const [ticket, setTicket]                   = useState<any>(null);
  const [logs, setLogs]                       = useState<any[]>([]);
  const [costEstimates, setCostEstimates]     = useState<CostEstimate[]>([]);
  const [purchases, setPurchases]             = useState<any[]>([]);
  const [loading, setLoading]                 = useState(true);
  const [actionLoading, setActionLoading]     = useState(false);
  const [vendors, setVendors]                 = useState<{ id: string; vendor_name: string }[]>([]);
  const [bankAccounts, setBankAccounts]       = useState<{ id: string; bank_name: string; account_number?: string; account_name?: string }[]>([]);
  const [existingResolution, setExistingResolution] = useState<any>(null);

  // ── Closed-ticket unlock state ────────────────────────────────────────────
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const [unlockReason, setUnlockReason]       = useState('');
  const [unlockLoading, setUnlockLoading]     = useState(false);
  const [resolutionEditUnlocked, setResolutionEditUnlocked] = useState(false);
  const isResolutionReadOnly = ticket?.status === 'closed' && !resolutionEditUnlocked;

  // ── Resolution Form state ─────────────────────────────────────────────────
  const RESOLUTION_TYPES = [
    { label: 'In-house', value: 'inhouse' },
    { label: 'Outside Vendor', value: 'outside' },
    { label: 'AMC', value: 'amc' },
    { label: 'Charged to Tenant', value: 'charged' },
  ];
  const SERVICE_TYPES = [
    { label: 'Repair', value: 'repair' },
    { label: 'Replaced', value: 'replaced' },
    { label: 'New Install', value: 'new_install' },
    { label: 'Condition Service', value: 'condition_service' },
  ];
  const [showResolutionForm, setShowResolutionForm] = useState(false);
  const [resolutionForm, setResolutionForm] = useState({
    resolutionType: 'inhouse', serviceType: 'repair', closureSummary: '',
    totalLabourCost: '', vendorNameManual: '', vendorId: '',
    items: [] as { name: string; qty: number; unit_cost: number }[],
    paymentDate: '', bankAccountId: '', paymentReferenceNo: '',
    proofOfPurchaseUrl: null as string | null,
    proofOfPaymentUrl:  null as string | null,
  });
  const [resolutionProofUri,       setResolutionProofUri]       = useState<string | null>(null);
  const [resolutionProofBase64,    setResolutionProofBase64]    = useState<string | undefined>();
  // Separate: proof of payment (for OCR scanning)
  const [paymentProofUri,          setPaymentProofUri]          = useState<string | null>(null);
  const [paymentProofBase64,       setPaymentProofBase64]       = useState<string | undefined>();
  const [ocrLoading,               setOcrLoading]               = useState(false);
  const [ocrMeta,                  setOcrMeta]                  = useState<{ bankName?: string; amount?: number; date?: string } | null>(null);
  const [requireManualAmount,      setRequireManualAmount]      = useState(false);  // true when OCR can't read (no Gemini)
  const [manualPaymentAmount,      setManualPaymentAmount]      = useState('');     // user-entered amount for validation

  // ── Comments state ────────────────────────────────────────────────────────
  const [showCommentBox, setShowCommentBox] = useState(false);
  const [commentText, setCommentText]       = useState('');
  const [postingComment, setPostingComment] = useState(false);

  // Modals
  const [showDiagnosticFlow, setShowDiagnosticFlow]   = useState(false);
  const [showCostReview, setShowCostReview]           = useState(false);
  const [diagnosisResult, setDiagnosisResult]         = useState<DiagnosticFlowResult | null>(null);
  const [showReassign, setShowReassign]               = useState(false);
  const [showPurchaseRecord, setShowPurchaseRecord]   = useState(false);
  const [lightboxUrl, setLightboxUrl]                 = useState<string | null>(null);
  const [showCompletedBanner, setShowCompletedBanner] = useState(false);

  const userId = user?.supabaseUserId || user?.userId || '';
  const isAdmin = ['org_admin','super_admin','property_manager','admin','pm'].includes(user?.role || '');

  const load = useCallback(async () => {
    try {
      const [t, l, ce, pur, vnd, res, banks] = await Promise.all([
        fetchTicket(ticketId),
        fetchTicketLogs(ticketId),
        fetchCostEstimates(ticketId),
        fetchPurchases(ticketId),
        fetchVendors(),
        fetchTicketResolution(ticketId),
        fetchBankAccounts(),
      ]);
      setTicket(t);
      setLogs(l);
      setCostEstimates(ce);
      setPurchases(pur);
      setVendors(vnd || []);
      setExistingResolution(res || null);
      setBankAccounts(banks || []);
      // Reset unlock state whenever ticket is reloaded (mirrors web useEffect on ticket.status)
      setResolutionEditUnlocked((t?.status || '') !== 'closed');
    } finally { setLoading(false); }
  }, [ticketId]);

  useEffect(() => { load(); }, [load]);

  // Reset stale modals when ticket status changes
  useEffect(() => {
    if (!ticket) return;
    const s = ticket.status;
    if (!['assigned', 'in_progress', 'waiting_for_cost_approval'].includes(s)) {
      setShowCostReview(false);
      setDiagnosisResult(null);
    }
    if (s !== 'waiting_for_parts') setShowPurchaseRecord(false);
  }, [ticket?.status]);

  // ── Derived booleans matching web app getEmployeeActions() logic ─────────
  const hasDiagnostic      = Boolean(ticket?.diagnosis || (ticket?.diagnostic_data as any)?.result || (ticket?.diagnostic_data as any)?.performed_at);
  const hasPendingCosts    = costEstimates.some((e: any) => e.status === 'pending');
  const hasApprovedCosts   = costEstimates.some((e: any) => e.status === 'approved');
  const purchasedEstIds    = new Set(purchases.map((p: any) => p.cost_estimate_id).filter(Boolean));
  const unpurchasedApproved = costEstimates.filter((e: any) => e.status === 'approved' && !purchasedEstIds.has(e.id));
  const isActiveTicket     = !['closed','completed','cancelled','pending_tenant_approval','pending_admin_approval','waiting_for_cost_approval'].includes(ticket?.status || '');
  const isPendingApproval  = ['pending_tenant_approval','pending_admin_approval'].includes(ticket?.status || '');

  // ── Time Metrics (mirrors web timeMetrics — calculated from logs) ─────────
  const timeMetrics = useMemo(() => {
    if (!logs.length) return null;
    const findStatus = (s: string) => {
      const log = [...logs].reverse().find((l: any) => {
        const action = (l.action || '').toLowerCase();
        const newSt  = (l.new_status || '').toLowerCase();
        return action.includes(`status → ${s}`) || action.includes(`status changed to ${s}`) || newSt === s;
      });
      return log ? new Date(log.created_at) : null;
    };
    const fmt = (ms: number) => {
      const totalM = Math.floor(ms / 60000);
      if (totalM < 60) return `${totalM}m`;
      const h = Math.floor(totalM / 60), m = totalM % 60;
      if (h < 24) return `${h}h ${m}m`;
      return `${Math.floor(h / 24)}d ${h % 24}h`;
    };
    const assignedAt  = findStatus('assigned') || (logs[0] ? new Date(logs[0].created_at) : null);
    // The "Start Work" step (in_progress) was removed from the happy path, so an
    // in_progress log entry usually never exists. Derive metrics from the
    // assigned → completed(pending) transition instead. Fall back to the
    // in_progress timestamp only if one happens to be present.
    const startedAt   = findStatus('in_progress');
    const completedAt = findStatus('pending_tenant_approval') || findStatus('pending_admin_approval') || findStatus('completed');
    // Response = assignment → in_progress if we have it, else assignment → completion.
    const responseRef = startedAt || completedAt;
    return {
      responseTime: assignedAt && responseRef ? fmt(responseRef.getTime() - assignedAt.getTime()) : null,
      workDuration:  (startedAt || assignedAt) && completedAt ? fmt(completedAt.getTime() - (startedAt || assignedAt)!.getTime()) : null,
      totalTime:     assignedAt && completedAt ? fmt(completedAt.getTime() - assignedAt.getTime()) : null,
    };
  }, [logs]);

  // ── Save Resolution then complete ─────────────────────────────────────────
  const handleSaveResolution = async () => {
    if (!resolutionForm.closureSummary.trim()) {
      Alert.alert('Required', 'Please enter a closure summary describing what was done.'); return;
    }
    const totalCost = resolutionForm.items.reduce((s, i) => s + (i.qty * i.unit_cost), 0) + (parseFloat(resolutionForm.totalLabourCost) || 0);
    // Block submission if OCR detected a mismatched amount (per requirements)
    if (ocrMeta?.amount != null && totalCost > 0) {
      const diff = Math.abs(ocrMeta.amount - totalCost);
      const allowedDiff = Math.max(1, totalCost * 0.01);
      if (diff > allowedDiff) {
        Alert.alert('Amount Mismatch', `The payment screenshot shows ₹${Math.round(ocrMeta.amount)} but the resolution total is ₹${Math.round(totalCost)}.\n\nBoth amounts must match before you can submit.`, [{ text: 'OK' }]);
        return;
      }
    }
    // Block if manual amount entry required but not provided or mismatches
    if (requireManualAmount && paymentProofUri && totalCost > 0) {
      const enteredAmt = parseFloat(manualPaymentAmount) || 0;
      if (!manualPaymentAmount.trim() || enteredAmt <= 0) {
        Alert.alert('Required', 'Please enter the amount shown in your payment screenshot to verify it matches.', [{ text: 'OK' }]);
        return;
      }
      const diff = Math.abs(enteredAmt - totalCost);
      const allowedDiff = Math.max(1, totalCost * 0.01);
      if (diff > allowedDiff) {
        Alert.alert('Amount Mismatch', `You entered ₹${Math.round(enteredAmt)} from your screenshot, but the resolution total is ₹${Math.round(totalCost)}.\n\nBoth amounts must match. Fix the items/cost or enter the correct amount.`, [{ text: 'OK' }]);
        return;
      }
    }
    if (totalCost > 0) {
      if (!resolutionForm.paymentDate)         { Alert.alert('Required', 'Payment date is required when cost is greater than ₹0.'); return; }
      if (!resolutionForm.bankAccountId)       { Alert.alert('Required', 'Bank account is required when cost is greater than ₹0.'); return; }
      if (!resolutionForm.paymentReferenceNo)  { Alert.alert('Required', 'Payment reference number is required when cost is greater than ₹0.'); return; }
      if (!resolutionForm.proofOfPurchaseUrl)  { Alert.alert('Required', 'Bill of purchase is required when cost is involved.'); return; }
    }
    setActionLoading(true);
    try {
      // Upload proof of purchase if local URI
      let purchaseProofUrl = resolutionForm.proofOfPurchaseUrl;
      if (resolutionProofUri && !purchaseProofUrl?.startsWith('http')) {
        const uploaded = await uploadTicketPhoto(resolutionProofUri, resolutionProofBase64, 'image/jpeg');
        if (uploaded) purchaseProofUrl = uploaded;
      }
      // Upload proof of payment if local URI
      let paymentProofUrl = resolutionForm.proofOfPaymentUrl;
      if (paymentProofUri && !paymentProofUrl?.startsWith('http')) {
        const uploaded = await uploadTicketPhoto(paymentProofUri, paymentProofBase64, 'image/jpeg');
        if (uploaded) paymentProofUrl = uploaded;
      }
      await saveTicketResolution({
        ticketId, userId,
        resolutionType:     resolutionForm.resolutionType,
        serviceType:        resolutionForm.serviceType,
        closureSummary:     resolutionForm.closureSummary,
        totalLabourCost:    parseFloat(resolutionForm.totalLabourCost) || 0,
        vendorNameManual:   resolutionForm.vendorNameManual || undefined,
        vendorId:           resolutionForm.vendorId || undefined,
        items:              resolutionForm.items.length > 0 ? resolutionForm.items : undefined,
        paymentDate:        resolutionForm.paymentDate || undefined,
        bankAccountId:      resolutionForm.bankAccountId || undefined,
        paymentReferenceNo: resolutionForm.paymentReferenceNo || undefined,
        proofOfPurchaseUrl: purchaseProofUrl || undefined,
        proofOfPaymentUrl:  paymentProofUrl || undefined,
        isUnlockEdit:       isResolutionReadOnly ? false : (ticket?.status === 'closed'),
      });
      setShowResolutionForm(false);
      setShowCompletedBanner(true);
      setResolutionForm({ resolutionType: 'inhouse', serviceType: 'repair', closureSummary: '', totalLabourCost: '', vendorNameManual: '', vendorId: '', items: [], paymentDate: '', bankAccountId: '', paymentReferenceNo: '', proofOfPurchaseUrl: null, proofOfPaymentUrl: null });
      setResolutionProofUri(null); setResolutionProofBase64(undefined);
      setPaymentProofUri(null); setPaymentProofBase64(undefined);
      setOcrMeta(null);
      setRequireManualAmount(false);
      setManualPaymentAmount('');
      await load();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to save resolution');
    } finally { setActionLoading(false); }
  };

  // ── Unlock closed ticket for editing (admin only — mirrors web) ────────────
  const handleUnlockResolution = async () => {
    if (!unlockReason.trim()) { Alert.alert('Required', 'Please enter a reason for unlocking.'); return; }
    setUnlockLoading(true);
    try {
      await unlockResolutionEditing(ticketId, userId, unlockReason);
      setShowUnlockModal(false);
      setUnlockReason('');
      setResolutionEditUnlocked(true);
      // Pre-fill form from existing resolution
      if (existingResolution) {
        const items = existingResolution.actual_items_used || existingResolution.items_used || [];
        setResolutionForm({
          resolutionType:    existingResolution.resolution_type || 'inhouse',
          serviceType:       existingResolution.service_type || 'repair',
          closureSummary:    existingResolution.closure_summary || '',
          totalLabourCost:   String(existingResolution.total_labour_cost || ''),
          vendorNameManual:  existingResolution.vendor_name_manual || '',
          vendorId:          existingResolution.vendor_id || '',
          items:             (items as any[]).map((i: any) => ({ name: i.name || '', qty: i.qty || 1, unit_cost: i.unit_cost || 0 })),
          paymentDate:       existingResolution.payment_date || '',
          bankAccountId:     existingResolution.bank_account_id || '',
          paymentReferenceNo: existingResolution.payment_reference_no || '',
          proofOfPurchaseUrl: existingResolution.proof_of_purchase_url || null,
          proofOfPaymentUrl:  existingResolution.proof_of_payment_url || null,
        });
      }
      setShowResolutionForm(true);
    } catch (e: any) { Alert.alert('Error', e?.message || 'Failed to unlock ticket.'); }
    finally { setUnlockLoading(false); }
  };

  // ── Payment proof upload + OCR scan (mirrors web handleProofOfPaymentChange) ─
  const handlePaymentProofUpload = async () => {
    Alert.alert('Upload Payment Proof', 'Choose source', [
      {
        text: 'Gallery',
        onPress: async () => {
          const { status: _libPerm } = await ImagePicker.getMediaLibraryPermissionsAsync();
          const libStatus = _libPerm === 'granted' ? 'granted' : (await ImagePicker.requestMediaLibraryPermissionsAsync()).status;
          if (libStatus !== 'granted') { Alert.alert('Photo Access Required', 'Please allow photo access in Settings → Vishful → Photos.'); return; }
          const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images' as any, quality: 0.85, base64: true });
          if (!result.canceled && result.assets[0]) {
            const asset = result.assets[0];
            setPaymentProofUri(asset.uri);
            setPaymentProofBase64(asset.base64 ?? undefined);
            // Run OCR
            if (asset.base64) {
              setOcrLoading(true);
              try {
                const ocr = await extractPaymentProof(asset.base64);
                // If OCR can read the image (Gemini available)
                if (ocr.amount || ocr.payment_date || ocr.bank_name || ocr.transaction_reference) {
                  const updates: Partial<typeof resolutionForm> = {};
                  if (ocr.transaction_reference) updates.paymentReferenceNo = ocr.transaction_reference;
                  if (ocr.payment_date) updates.paymentDate = ocr.payment_date;
                  if (ocr.bank_name) {
                    const matched = bankAccounts.find((b: any) =>
                      b.bank_name?.toLowerCase().includes(ocr.bank_name!.toLowerCase()) ||
                      ocr.bank_name!.toLowerCase().includes(b.bank_name?.toLowerCase() || '')
                    );
                    if (matched) updates.bankAccountId = matched.id;
                  }
                  if (Object.keys(updates).length) setResolutionForm(p => ({ ...p, ...updates }));
                  setOcrMeta({ bankName: ocr.bank_name || undefined, amount: ocr.amount || undefined, date: ocr.payment_date || undefined });
                  setRequireManualAmount(false);
                  setManualPaymentAmount('');
                  if (ocr.amount) {
                    Alert.alert('Payment Detected', `Amount: ₹${Math.round(ocr.amount)}${ocr.bank_name ? `\nBank: ${ocr.bank_name}` : ''}${ocr.payment_date ? `\nDate: ${ocr.payment_date}` : ''}\n\nDetails auto-filled. Please verify.`);
                  }
                } else if (ocr._requireManualAmount) {
                  // OCR can't read image (no Gemini key) — ask user to enter amount manually
                  setOcrMeta(null);
                  setRequireManualAmount(true);
                  setManualPaymentAmount('');
                  Alert.alert(
                    'Enter Payment Amount',
                    ocr._message || 'Please enter the exact amount shown in your payment screenshot to verify it matches the resolution cost.',
                    [{ text: 'OK' }]
                  );
                }
              } catch { /* silent */ }
              finally { setOcrLoading(false); }
            }
          }
        },
      },
      {
        text: 'Camera',
        onPress: async () => {
          const { status: _camPerm } = await ImagePicker.getCameraPermissionsAsync();
          const camStatus = _camPerm === 'granted' ? 'granted' : (await ImagePicker.requestCameraPermissionsAsync()).status;
          if (camStatus !== 'granted') { Alert.alert('Camera Access Required', 'Please allow camera access in Settings → Vishful → Camera.'); return; }
          const result = await ImagePicker.launchCameraAsync({ quality: 0.85, base64: true });
          if (!result.canceled && result.assets[0]) {
            const asset = result.assets[0];
            setPaymentProofUri(asset.uri);
            setPaymentProofBase64(asset.base64 ?? undefined);
            if (asset.base64) {
              setOcrLoading(true);
              try {
                const ocr = await extractPaymentProof(asset.base64);
                if (ocr.amount || ocr.payment_date || ocr.bank_name || ocr.transaction_reference) {
                  const updates: Partial<typeof resolutionForm> = {};
                  if (ocr.transaction_reference) updates.paymentReferenceNo = ocr.transaction_reference;
                  if (ocr.payment_date) updates.paymentDate = ocr.payment_date;
                  if (ocr.bank_name) {
                    const matched = bankAccounts.find((b: any) =>
                      b.bank_name?.toLowerCase().includes(ocr.bank_name!.toLowerCase()) ||
                      ocr.bank_name!.toLowerCase().includes(b.bank_name?.toLowerCase() || '')
                    );
                    if (matched) updates.bankAccountId = matched.id;
                  }
                  if (Object.keys(updates).length) setResolutionForm(p => ({ ...p, ...updates }));
                  setOcrMeta({ bankName: ocr.bank_name || undefined, amount: ocr.amount || undefined, date: ocr.payment_date || undefined });
                  setRequireManualAmount(false);
                  setManualPaymentAmount('');
                  if (ocr.amount) Alert.alert('Payment Detected', `Amount: ₹${Math.round(ocr.amount)}. Details auto-filled.`);
                } else if (ocr._requireManualAmount) {
                  setOcrMeta(null);
                  setRequireManualAmount(true);
                  setManualPaymentAmount('');
                  Alert.alert('Enter Payment Amount', ocr._message || 'Please enter the exact amount shown in your payment screenshot.', [{ text: 'OK' }]);
                }
              } catch { /* silent */ }
              finally { setOcrLoading(false); }
            }
          }
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  // ── Post comment ──────────────────────────────────────────────────────────
  const handlePostComment = async () => {
    if (!commentText.trim()) return;
    setPostingComment(true);
    try {
      await postTicketComment(ticketId, commentText.trim(), userId);
      setCommentText(''); setShowCommentBox(false);
      await load();
    } catch (e: any) { Alert.alert('Error', e?.message || 'Failed to post comment'); }
    finally { setPostingComment(false); }
  };

  // ── Action buttons based on status (mirrors web getEmployeeActions) ──────
  // ── Action buttons — mirrors web getEmployeeActions() EXACTLY ────────────
  // Web is status-AGNOSTIC: same 4 possible actions for ANY active status.
  // No "Start Work", no "Add Photo", no "Parts Arrived" — those don't exist in web.
  const actionButtons = useMemo(() => {
    if (!ticket) return [];
    if (!isActiveTicket) return [];                    // web: if (!isActiveTicket) return []

    const buttons: { label: string; icon: string; color: string; bg: string; action: string; disabled?: boolean; hint?: string }[] = [];

    // 1. Reassign — shown unless pending cost estimates exist (web exact gate)
    if (!hasPendingCosts)
      buttons.push({ label: 'Reassign', icon: 'swap-horizontal-outline', color: '#7B6B90', bg: colors.surface, action: 'reassign' });

    // 2. Diagnose — ALWAYS shown for active tickets (web: always push "diagnose")
    buttons.push({
      label: hasDiagnostic ? 'Re-run Diagnostics' : 'Run Diagnostics',
      icon: 'medical-outline', color: BRAND, bg: BRAND_LIGHT, action: 'diagnose',
    });

    // 3. Record Purchase — shown when approved estimates have not yet been purchased
    //    (web renders this inline, not in the actions array, but same condition)
    if (unpurchasedApproved.length > 0)
      buttons.push({ label: 'Record Purchase', icon: 'cube-outline', color: '#fff', bg: '#0284C7', action: 'purchase' });

    // 4. Mark Complete — gated: needs completed diagnosis AND no pending cost estimates
    //    (web: "Employees must complete diagnostics before they can close/complete")
    buttons.push({
      label: 'Mark Complete',
      icon: 'checkmark-circle-outline',
      color: hasDiagnostic && !hasPendingCosts ? '#fff' : '#9B8BAE',
      bg: hasDiagnostic && !hasPendingCosts ? '#22C55E' : 'rgba(107,114,128,0.1)',
      action: 'complete',
      disabled: !hasDiagnostic || hasPendingCosts,
      hint: !hasDiagnostic
        ? 'Complete diagnostics before marking this ticket done'
        : hasPendingCosts
        ? 'Pending cost estimates must be approved first'
        : undefined,
    });

    return buttons;
  }, [ticket, colors, hasDiagnostic, hasPendingCosts, unpurchasedApproved, isActiveTicket]);

  const handleAction = async (action: string) => {
    switch (action) {
      case 'diagnose':
        setShowDiagnosticFlow(true);
        break;
      case 'reassign':
        setShowReassign(true);
        break;
      case 'purchase':
        setShowPurchaseRecord(true);
        break;
      case 'complete':
        // Opens Resolution Details form — mirrors web "Mark Completed" → setShowResolution(true)
        setResolutionForm({ resolutionType: 'inhouse', serviceType: 'repair', closureSummary: '', totalLabourCost: '', vendorNameManual: '', vendorId: '', items: [], paymentDate: '', bankAccountId: '', paymentReferenceNo: '', proofOfPurchaseUrl: null, proofOfPaymentUrl: null });
        setResolutionProofUri(null); setResolutionProofBase64(undefined);
        setShowResolutionForm(true);
        break;
    }
  };

  // ── After DiagnosticFlow completes ──────────────────────────
  const handleDiagnosisComplete = async (result: DiagnosticFlowResult) => {
    setShowDiagnosticFlow(false);

    try {
      await submitDiagnosis({
        ticketId,
        issueTypeId: ticket?.issue_type_id || '',
        questionsAnswers: result.answers.reduce((acc, qa) => ({ ...acc, [qa.question]: qa.answer }), {}),
        aiDiagnosis:     result.fullDiagnosis ? JSON.stringify(result.fullDiagnosis) : undefined,
        employeeOverride: `${result.result.cause}. Solution: ${result.result.recommendation}`,
        performedBy:     userId,
      });
    } catch (e) {
      console.warn('submitDiagnosis error:', e);
    }

    if (result.parts?.length || result.submitForApproval) {
      setDiagnosisResult(result);
      setShowCostReview(true);
    } else {
      await load();
    }
  };

  if (loading || !ticket) return (
    <GlassBackground><SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator size="large" color={BRAND} /></SafeAreaView></GlassBackground>
  );

  const photoUrls: string[] = Array.isArray(ticket.photo_urls) ? ticket.photo_urls : [];
  const statusCfg   = STATUS_CONFIG[ticket.status] || STATUS_CONFIG.open;
  const priorityCfg = PRIORITY_CONFIG[ticket.priority] || PRIORITY_CONFIG.medium;
  const meta = ticket.diagnostic_data || {};

  const pendingEstimates  = costEstimates.filter(e => e.status === 'pending');
  const approvedEstimates = costEstimates.filter(e => e.status === 'approved');
  const totalApproved     = approvedEstimates.reduce((s, e) => s + e.total, 0);
  const totalPending      = pendingEstimates.reduce((s, e) => s + e.total, 0);

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* Top bar */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <TouchableOpacity onPress={() => navigation.goBack()}
            style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
            <Ionicons name="chevron-back" size={20} color={colors.text} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.5 }}>TICKET</Text>
            <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text }}>{ticket.ticket_number}</Text>
          </View>
          <Pill label={statusCfg.label} color={statusCfg.color} bg={statusCfg.bg} />
        </View>

        {/* SLA live countdown */}
        <SlaCountdownTimer deadline={ticket.sla_deadline || null} status={ticket.status} />

        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 140, gap: 18 }}>

          {/* ── Mark Complete confirmation banner ── */}
          {showCompletedBanner && (
            <View style={{ backgroundColor: 'rgba(34,197,94,0.1)', borderRadius: 16, padding: 16, borderWidth: 1.5, borderColor: 'rgba(34,197,94,0.3)', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Ionicons name="checkmark-circle" size={28} color="#22C55E" />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: '#22C55E' }}>Marked as Complete!</Text>
                <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                  Request sent to {ticket.tenant_id ? 'the tenant' : 'admin'} for approval.
                </Text>
              </View>
              <TouchableOpacity onPress={() => setShowCompletedBanner(false)}>
                <Ionicons name="close-circle" size={22} color={colors.textTertiary} />
              </TouchableOpacity>
            </View>
          )}

          {/* ══ UNLOCK EDITING BANNER — closed tickets (admin only, mirrors web) ══ */}
          {ticket.status === 'closed' && isAdmin && !resolutionEditUnlocked && (
            <View style={{ backgroundColor: 'rgba(107,114,128,0.08)', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Ionicons name="lock-closed-outline" size={22} color={colors.textSecondary} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>Ticket Closed</Text>
                <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 2 }}>Resolution is read-only. Admins can unlock editing.</Text>
              </View>
              <TouchableOpacity
                onPress={() => setShowUnlockModal(true)}
                style={{ backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 }}
              >
                <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>Unlock</Text>
              </TouchableOpacity>
            </View>
          )}
          {ticket.tenant_rejection_reason && (
            <View style={{ backgroundColor: 'rgba(220,38,38,0.08)', borderRadius: 16, padding: 16, borderWidth: 1.5, borderColor: 'rgba(220,38,38,0.3)', flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
              <Ionicons name="close-circle" size={28} color="#DC2626" />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: '#DC2626' }}>Rejected — Needs Rework</Text>
                <Text style={{ fontSize: 13, color: colors.text, marginTop: 4, lineHeight: 20 }}>{ticket.tenant_rejection_reason}</Text>
              </View>
            </View>
          )}

          {/* ══ EXISTING RESOLUTION SUMMARY (if already saved) ══ */}
          {existingResolution && (
            <SectionCard title="Resolution Details" icon="clipboard-outline" iconColor="#0284C7" iconBg="rgba(2,132,199,0.1)">
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <View style={{ backgroundColor: 'rgba(2,132,199,0.1)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#0284C7', textTransform: 'capitalize' }}>{existingResolution.resolution_type?.replace('_', '-') || '—'}</Text>
                  </View>
                  <View style={{ backgroundColor: 'rgba(34,197,94,0.1)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#16A34A', textTransform: 'capitalize' }}>{existingResolution.service_type?.replace('_', ' ') || '—'}</Text>
                  </View>
                </View>
                {existingResolution.closure_summary ? <Text style={{ fontSize: 13, color: colors.text, lineHeight: 20 }}>{existingResolution.closure_summary}</Text> : null}
                {(existingResolution.total_cost > 0) && (
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, color: colors.textSecondary }}>Total Cost</Text>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: BRAND }}>₹{Number(existingResolution.total_cost).toLocaleString('en-IN')}</Text>
                  </View>
                )}
                {existingResolution.vendor_name_manual ? <InfoRow icon="storefront-outline" label="Vendor" value={existingResolution.vendor_name_manual} /> : null}
              </View>
            </SectionCard>
          )}
          <SectionCard title="Tenant & Location" icon="person-outline" iconColor="#7C3AED" iconBg="rgba(124,58,237,0.1)">
            <View style={{ gap: 10 }}>
              {ticket.tenant_name && <InfoRow icon="person-circle-outline" label="Tenant" value={ticket.tenant_name} />}
              {ticket.tenant_phone && <InfoRow icon="call-outline" label="Phone" value={ticket.tenant_phone} />}
              {(ticket.apartment_code || meta.apartment_code) && (
                <InfoRow icon="business-outline" label="Apartment" value={ticket.apartment_code || meta.apartment_code} />
              )}
              {ticket.bed_code && <InfoRow icon="bed-outline" label="Bed" value={ticket.bed_code} />}
            </View>
          </SectionCard>

          {/* ══ ISSUE DETAILS ══ */}
          <SectionCard title="Issue Details" icon="construct-outline" iconColor={BRAND} iconBg={BRAND_LIGHT}>
            <View style={{ gap: 10 }}>
              <InfoRow icon="help-circle-outline" label="Issue Type" value={ticket.issue_type_name || ticket.issue_type || '—'} />
              {ticket.issue_subtype && <InfoRow icon="git-branch-outline" label="Sub-type" value={ticket.issue_subtype} />}
              <InfoRow icon="flag-outline" label="Priority" value={ticket.priority} valueColor={priorityCfg.color} />
              {ticket.sla_deadline && (
                <InfoRow icon="timer-outline" label="SLA Deadline"
                  value={new Date(ticket.sla_deadline).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} />
              )}
              {ticket.description && (
                <View style={{ gap: 4 }}>
                  <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textTertiary }}>DESCRIPTION</Text>
                  <Text style={{ fontSize: 14, color: colors.text, lineHeight: 22 }}>{ticket.description}</Text>
                </View>
              )}
              {ticket.assigned_to_name && <InfoRow icon="hammer-outline" label="Assigned To" value={ticket.assigned_to_name} />}
              <InfoRow icon="calendar-outline" label="Created"
                value={new Date(ticket.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} />
            </View>
          </SectionCard>

          {/* ══ PHOTOS ══ */}
          {photoUrls.length > 0 && (
            <SectionCard title={`Photos (${photoUrls.length})`} icon="images-outline" iconColor="#0284C7" iconBg="rgba(2,132,199,0.1)">
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                {photoUrls.map((url, idx) => (
                  <TouchableOpacity key={idx} onPress={() => setLightboxUrl(url)} activeOpacity={0.85}>
                    <Image source={{ uri: url }} style={{ width: (SW - 80) / 3, height: (SW - 80) / 3, borderRadius: 12, borderWidth: 1, borderColor: colors.border }} resizeMode="cover" />
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 8, textAlign: 'center' }}>Tap photo to enlarge</Text>
            </SectionCard>
          )}

          {/* ══ DIAGNOSIS ══ */}
          {ticket.diagnosis && (
            <SectionCard title="Diagnosis Result" icon="medical-outline" iconColor="#059669" iconBg="rgba(5,150,105,0.1)">
              <Text style={{ fontSize: 14, color: colors.text, lineHeight: 22 }}>{ticket.diagnosis}</Text>
              {ticket.diagnosis_performed_at && (
                <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 6 }}>
                  Performed: {new Date(ticket.diagnosis_performed_at).toLocaleString('en-IN')}
                </Text>
              )}
            </SectionCard>
          )}

          {/* ══ COST ESTIMATES ══ */}
          {costEstimates.length > 0 && (() => {
            // Employees only see approved/declined (not pending) — mirrors web app role filter
            const visibleEstimates = isAdmin
              ? costEstimates
              : costEstimates.filter((e: any) => e.status !== 'pending');
            if (visibleEstimates.length === 0) return null;
            const approvedEstimates = costEstimates.filter((e: any) => e.status === 'approved');
            const pendingEstimates  = costEstimates.filter((e: any) => e.status === 'pending');
            const totalApproved = approvedEstimates.reduce((s, e) => s + e.total, 0);
            const totalPending  = pendingEstimates.reduce((s, e)  => s + e.total, 0);
            return (
              <SectionCard title="Cost Estimates" icon="receipt-outline" iconColor="#7C3AED" iconBg="rgba(124,58,237,0.1)">
                <View style={{ gap: 10 }}>
                  {visibleEstimates.map((est: any) => (
                    <View key={est.id}>
                      {est.repeat_job_alert && (
                        <View style={{ backgroundColor: '#FEF3C7', borderRadius: 8, padding: 8, marginBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Ionicons name="warning" size={14} color="#D97706" />
                          <Text style={{ fontSize: 11, fontWeight: '700', color: '#D97706' }}>Repeat Job — Manual approval required</Text>
                        </View>
                      )}
                      <CostEstimateRow
                        estimate={est}
                        isAdmin={isAdmin}
                        ticketId={ticketId}
                        userId={userId}
                        onUpdated={load}
                      />
                    </View>
                  ))}
                  <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 4 }} />
                  {approvedEstimates.length > 0 && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#16A34A' }}>Approved Total</Text>
                      <Text style={{ fontSize: 16, fontWeight: '800', color: '#16A34A' }}>₹{totalApproved.toLocaleString('en-IN')}</Text>
                    </View>
                  )}
                  {pendingEstimates.length > 0 && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#D97706' }}>Pending (₹{totalPending.toLocaleString('en-IN')})</Text>
                      <View style={{ backgroundColor: '#FEF3C7', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: '#D97706' }}>Awaiting approval</Text>
                      </View>
                    </View>
                  )}
                </View>
              </SectionCard>
            );
          })()}

          {/* ══ PURCHASES — with est vs actual diff ══ */}
          {purchases.length > 0 && (
            <SectionCard title="Procurement Log" icon="cube-outline" iconColor="#0284C7" iconBg="rgba(2,132,199,0.1)">
              <View style={{ gap: 10 }}>
                {purchases.map((p: any, idx: number) => {
                  const vendor = vendors.find((v: any) => v.id === p.vendor_id);
                  const diff = p.estimated_cost ? (p.actual_cost - p.estimated_cost) : null;
                  return (
                    <View key={p.id || idx} style={{ backgroundColor: 'rgba(2,132,199,0.06)', borderRadius: 12, padding: 12, gap: 4 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>{p.item_name}</Text>
                          <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 2 }}>
                            Qty: {p.quantity}{(vendor?.vendor_name || p.vendor_name_manual) ? ` · ${vendor?.vendor_name || p.vendor_name_manual}` : ''}
                            {p.purchase_date ? ` · ${formatDate(p.purchase_date, '')}` : ''}
                          </Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{ fontSize: 14, fontWeight: '800', color: '#0284C7' }}>₹{(p.actual_cost || 0).toLocaleString('en-IN')}</Text>
                          {diff !== null && (
                            <Text style={{ fontSize: 10, fontWeight: '600', color: diff > 0 ? '#DC2626' : '#16A34A' }}>
                              {diff > 0 ? '+' : ''}₹{diff.toLocaleString('en-IN')} vs est.
                            </Text>
                          )}
                        </View>
                      </View>
                      {p.invoice_url && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                          <Ionicons name="document-attach-outline" size={13} color="#0284C7" />
                          <Text style={{ fontSize: 11, color: '#0284C7', fontWeight: '600' }}>Invoice uploaded</Text>
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            </SectionCard>
          )}

          {/* ══ ACTION BUTTONS ══ */}
          {actionButtons.length > 0 && (
            <View style={{ gap: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.5 }}>ACTIONS</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                {actionButtons.map((btn, i) => (
                  <View key={i} style={{ minWidth: 140, flex: actionButtons.length === 1 ? 1 : undefined }}>
                    <TouchableOpacity
                      onPress={() => !btn.disabled && handleAction(btn.action)}
                      disabled={actionLoading || btn.disabled}
                      activeOpacity={btn.disabled ? 1 : 0.75}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 8,
                        paddingHorizontal: 18, paddingVertical: 13, borderRadius: 14,
                        backgroundColor: btn.bg,
                        borderWidth: btn.bg === colors.surface ? 1 : 0,
                        borderColor: colors.border,
                        opacity: btn.disabled ? 0.5 : 1,
                      }}
                    >
                      {actionLoading ? (
                        <ActivityIndicator size="small" color={btn.color} />
                      ) : (
                        <Ionicons name={btn.icon as any} size={18} color={btn.color} />
                      )}
                      <Text style={{ fontSize: 14, fontWeight: '700', color: btn.color }}>{btn.label}</Text>
                    </TouchableOpacity>
                    {btn.hint && (
                      <Text style={{ fontSize: 10, color: colors.textTertiary, marginTop: 3, paddingHorizontal: 4 }}>{btn.hint}</Text>
                    )}
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* ══ PENDING APPROVAL STATE ══ */}
          {['pending_tenant_approval', 'pending_admin_approval'].includes(ticket.status) && (
            <View style={{ backgroundColor: 'rgba(2,132,199,0.08)', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: 'rgba(2,132,199,0.2)', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Ionicons name="hourglass-outline" size={28} color="#0284C7" />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: '#0284C7' }}>Awaiting Approval</Text>
                <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                  {ticket.status === 'pending_tenant_approval'
                    ? 'Waiting for the tenant to confirm completion. They will receive a notification.'
                    : 'Waiting for admin to approve closure.'}
                </Text>
              </View>
            </View>
          )}

          {/* ══ CLOSED STATE ══ */}
          {['closed', 'completed'].includes(ticket.status) && (
            <View style={{ backgroundColor: 'rgba(34,197,94,0.08)', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: 'rgba(34,197,94,0.2)', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Ionicons name="checkmark-circle" size={28} color="#22C55E" />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: '#22C55E' }}>Ticket Closed</Text>
                {ticket.closed_at && (
                  <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>{new Date(ticket.closed_at).toLocaleString('en-IN')}</Text>
                )}
              </View>
            </View>
          )}

          {/* ══ TIME METRICS (mirrors web timeMetrics card) ══ */}
          {timeMetrics && (timeMetrics.responseTime || timeMetrics.workDuration || timeMetrics.totalTime) && (
            <SectionCard title="Time Metrics" icon="timer-outline" iconColor="#7C3AED" iconBg="rgba(124,58,237,0.1)">
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {timeMetrics.responseTime && (
                  <View style={{ flex: 1, backgroundColor: 'rgba(124,58,237,0.06)', borderRadius: 12, padding: 12, alignItems: 'center' }}>
                    <Text style={{ fontSize: 18, fontWeight: '800', color: '#7C3AED' }}>{timeMetrics.responseTime}</Text>
                    <Text style={{ fontSize: 10, fontWeight: '600', color: colors.textTertiary, marginTop: 2, textAlign: 'center' }}>RESPONSE TIME</Text>
                  </View>
                )}
                {timeMetrics.workDuration && (
                  <View style={{ flex: 1, backgroundColor: BRAND_LIGHT, borderRadius: 12, padding: 12, alignItems: 'center' }}>
                    <Text style={{ fontSize: 18, fontWeight: '800', color: BRAND }}>{timeMetrics.workDuration}</Text>
                    <Text style={{ fontSize: 10, fontWeight: '600', color: colors.textTertiary, marginTop: 2, textAlign: 'center' }}>WORK DURATION</Text>
                  </View>
                )}
                {timeMetrics.totalTime && (
                  <View style={{ flex: 1, backgroundColor: 'rgba(34,197,94,0.06)', borderRadius: 12, padding: 12, alignItems: 'center' }}>
                    <Text style={{ fontSize: 18, fontWeight: '800', color: '#16A34A' }}>{timeMetrics.totalTime}</Text>
                    <Text style={{ fontSize: 10, fontWeight: '600', color: colors.textTertiary, marginTop: 2, textAlign: 'center' }}>TOTAL TIME</Text>
                  </View>
                )}
              </View>
            </SectionCard>
          )}

          {/* ══ ACTIVITY LOG + COMMENTS ══ */}
          {logs.length > 0 && (
            <SectionCard title="Activity Log" icon="time-outline" iconColor="#7B6B90" iconBg="rgba(107,114,128,0.1)">
              <View style={{ gap: 0 }}>
                {logs.map((log, idx) => {
                  const isComment = (log.action || '').toLowerCase() === 'comment';
                  return (
                    <View key={log.id || idx} style={{ flexDirection: 'row', gap: 12 }}>
                      <View style={{ alignItems: 'center' }}>
                        <View style={{
                          width: 10, height: 10, borderRadius: 5, marginTop: 5,
                          backgroundColor: isComment ? '#7C3AED' : idx === 0 ? BRAND : colors.border,
                        }} />
                        {idx < logs.length - 1 && <View style={{ width: 2, flex: 1, backgroundColor: colors.border, marginTop: 4 }} />}
                      </View>
                      <View style={{ flex: 1, paddingBottom: 14 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          {isComment && (
                            <View style={{ backgroundColor: 'rgba(124,58,237,0.1)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
                              <Text style={{ fontSize: 9, fontWeight: '800', color: '#7C3AED' }}>COMMENT</Text>
                            </View>
                          )}
                          <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text, flex: 1 }}>{log.action}</Text>
                        </View>
                        {log.notes && <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2, lineHeight: 18 }}>{log.notes}</Text>}
                        <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 3 }}>
                          {new Date(log.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          {log.performer_name ? ` · ${log.performer_name}` : ''}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>

              {/* ── Add Comment (mirrors web) ───────────────────────────── */}
              {showCommentBox ? (
                <View style={{ marginTop: 12, gap: 8 }}>
                  <TextInput
                    value={commentText}
                    onChangeText={setCommentText}
                    placeholder="Type your comment…"
                    placeholderTextColor={colors.textTertiary}
                    multiline
                    style={{
                      backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
                      borderRadius: 12, padding: 12, fontSize: 14, color: colors.text,
                      minHeight: 80, textAlignVertical: 'top',
                    }}
                  />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity
                      onPress={() => { setShowCommentBox(false); setCommentText(''); }}
                      style={{ flex: 1, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: 'center' }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary }}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={handlePostComment}
                      disabled={postingComment || !commentText.trim()}
                      style={{ flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 10, borderRadius: 10, backgroundColor: '#7C3AED' }}
                    >
                      {postingComment
                        ? <ActivityIndicator size="small" color="#fff" />
                        : <Ionicons name="send-outline" size={15} color="#fff" />}
                      <Text style={{ fontSize: 13, fontWeight: '800', color: '#fff' }}>Post Comment</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  onPress={() => setShowCommentBox(true)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border }}
                >
                  <Ionicons name="chatbubble-outline" size={16} color={colors.textSecondary} />
                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary }}>Add Comment</Text>
                </TouchableOpacity>
              )}
            </SectionCard>
          )}
        </ScrollView>

        {/* ─── DIAGNOSTIC FLOW MODAL ──────────────────────────────── */}
        {showDiagnosticFlow && ticket && (
          <Modal visible={showDiagnosticFlow} animationType="slide" presentationStyle="pageSheet">
            <GlassBackground>
              <SafeAreaView style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                  <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: BRAND_LIGHT, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                    <Ionicons name="medical-outline" size={19} color={BRAND} />
                  </View>
                  <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text, flex: 1 }}>AI Diagnosis</Text>
                  <TouchableOpacity onPress={() => setShowDiagnosticFlow(false)}>
                    <Ionicons name="close-circle" size={28} color={colors.textTertiary} />
                  </TouchableOpacity>
                </View>
                <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
                  <DiagnosticFlow
                    issueTypeName={ticket.issue_type_name || ticket.issue_type || 'General'}
                    issueTypeId={ticket.issue_type_id || ''}
                    ticketId={ticketId}
                    issueSubType={ticket.issue_subtype || null}
                    onComplete={handleDiagnosisComplete}
                    onNoCostComplete={async () => { setShowDiagnosticFlow(false); setShowCompletedBanner(true); await load(); }}
                    onCancel={() => setShowDiagnosticFlow(false)}
                  />
                </ScrollView>
              </SafeAreaView>
            </GlassBackground>
          </Modal>
        )}

        {/* ─── UNLOCK CLOSED TICKET MODAL (admin only — mirrors web) ─────────── */}
        <Modal visible={showUnlockModal} animationType="fade" transparent>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <View style={{ backgroundColor: colors.background, borderRadius: 20, padding: 24, width: '100%', gap: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: 'rgba(239,68,68,0.1)', alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="lock-open-outline" size={19} color="#EF4444" />
                </View>
                <View>
                  <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>Unlock Resolution Editing</Text>
                  <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 1 }}>This will be audit logged</Text>
                </View>
              </View>
              <Text style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 20 }}>
                This ticket is closed. Editing the resolution will be recorded in the activity log. Please provide a reason.
              </Text>
              <View style={{ gap: 4 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary }}>REASON *</Text>
                <TextInput
                  value={unlockReason}
                  onChangeText={setUnlockReason}
                  placeholder="e.g. Cost correction, Vendor change..."
                  placeholderTextColor={colors.textTertiary}
                  multiline
                  style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, fontSize: 13, color: colors.text, minHeight: 72, textAlignVertical: 'top' }}
                />
              </View>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <TouchableOpacity onPress={() => { setShowUnlockModal(false); setUnlockReason(''); }}
                  style={{ flex: 1, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, alignItems: 'center' }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textSecondary }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleUnlockResolution} disabled={unlockLoading || !unlockReason.trim()}
                  style={{ flex: 2, padding: 12, borderRadius: 12, backgroundColor: unlockReason.trim() ? '#EF4444' : colors.border, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
                  {unlockLoading ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="lock-open-outline" size={16} color="#fff" />}
                  <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>Unlock & Edit</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* ─── RESOLUTION FORM MODAL (opened by Mark Complete — mirrors web) ── */}
        <Modal visible={showResolutionForm} animationType="slide" presentationStyle="pageSheet">
          <GlassBackground>
            <SafeAreaView style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: 'rgba(34,197,94,0.1)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                  <Ionicons name="clipboard-outline" size={19} color="#22C55E" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }}>Resolution Details</Text>
                  <Text style={{ fontSize: 11, color: colors.textTertiary }}>Describe what was done before marking complete</Text>
                </View>
                <TouchableOpacity onPress={() => setShowResolutionForm(false)}>
                  <Ionicons name="close-circle" size={28} color={colors.textTertiary} />
                </TouchableOpacity>
              </View>

              <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
                {/* Resolution Type */}
                <View style={{ gap: 6 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.4 }}>RESOLUTION TYPE *</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {RESOLUTION_TYPES.map(rt => (
                      <TouchableOpacity key={rt.value} onPress={() => setResolutionForm(p => ({ ...p, resolutionType: rt.value }))}
                        style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1.5,
                          borderColor: resolutionForm.resolutionType === rt.value ? '#22C55E' : colors.border,
                          backgroundColor: resolutionForm.resolutionType === rt.value ? 'rgba(34,197,94,0.1)' : colors.surface }}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: resolutionForm.resolutionType === rt.value ? '#22C55E' : colors.textSecondary }}>{rt.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                {/* Service Type */}
                <View style={{ gap: 6 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.4 }}>SERVICE TYPE *</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {SERVICE_TYPES.map(st => (
                      <TouchableOpacity key={st.value} onPress={() => setResolutionForm(p => ({ ...p, serviceType: st.value }))}
                        style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1.5,
                          borderColor: resolutionForm.serviceType === st.value ? BRAND : colors.border,
                          backgroundColor: resolutionForm.serviceType === st.value ? BRAND_LIGHT : colors.surface }}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: resolutionForm.serviceType === st.value ? BRAND : colors.textSecondary }}>{st.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                {/* Closure Summary */}
                <ModalField
                  label="Closure Summary *"
                  placeholder="Describe what was done to resolve the issue…"
                  value={resolutionForm.closureSummary}
                  onChange={(v: string) => setResolutionForm(p => ({ ...p, closureSummary: v }))}
                  multiline
                />

                {/* Items used */}
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.4 }}>PARTS / ITEMS USED</Text>
                  {resolutionForm.items.map((item, idx) => (
                    <View key={idx} style={{ backgroundColor: colors.surface, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border, gap: 8 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary }}>ITEM {idx + 1}</Text>
                        <TouchableOpacity onPress={() => setResolutionForm(p => ({ ...p, items: p.items.filter((_, i) => i !== idx) }))}>
                          <Ionicons name="trash-outline" size={16} color="#DC2626" />
                        </TouchableOpacity>
                      </View>
                      <ModalField label="Item Name" placeholder="e.g. PVC Pipe" value={item.name}
                        onChange={(v: string) => setResolutionForm(p => ({ ...p, items: p.items.map((it, i) => i === idx ? { ...it, name: v } : it) }))} />
                      <View style={{ flexDirection: 'row', gap: 10 }}>
                        <View style={{ flex: 1 }}>
                          <ModalField label="Qty" placeholder="1" value={String(item.qty)} keyboardType="numeric"
                            onChange={(v: string) => setResolutionForm(p => ({ ...p, items: p.items.map((it, i) => i === idx ? { ...it, qty: Number(v) || 1 } : it) }))} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <ModalField label="Unit Cost (₹)" placeholder="0" value={String(item.unit_cost)} keyboardType="numeric"
                            onChange={(v: string) => setResolutionForm(p => ({ ...p, items: p.items.map((it, i) => i === idx ? { ...it, unit_cost: Number(v) || 0 } : it) }))} />
                        </View>
                      </View>
                    </View>
                  ))}
                  <TouchableOpacity
                    onPress={() => setResolutionForm(p => ({ ...p, items: [...p.items, { name: '', qty: 1, unit_cost: 0 }] }))}
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 12, borderRadius: 12, borderWidth: 1.5, borderColor: BRAND, borderStyle: 'dashed' }}>
                    <Ionicons name="add-circle-outline" size={16} color={BRAND} />
                    <Text style={{ fontSize: 13, fontWeight: '700', color: BRAND }}>Add Item Used</Text>
                  </TouchableOpacity>
                </View>

                {/* ── Labour cost ── */}
                <ModalField label="Labour Cost (₹)" placeholder="0" value={resolutionForm.totalLabourCost} keyboardType="numeric"
                  onChange={(v: string) => setResolutionForm(p => ({ ...p, totalLabourCost: v }))} />

                {/* ── Vendor ── */}
                <ModalField label="Vendor / Supplier" placeholder="Enter vendor name (optional)" value={resolutionForm.vendorNameManual}
                  onChange={(v: string) => setResolutionForm(p => ({ ...p, vendorNameManual: v }))} />

                {/* ── Total cost summary ── */}
                {(resolutionForm.items.length > 0 || parseFloat(resolutionForm.totalLabourCost) > 0) && (() => {
                  const totalCost = resolutionForm.items.reduce((s, i) => s + (i.qty * i.unit_cost), 0) + (parseFloat(resolutionForm.totalLabourCost) || 0);
                  return (
                    <View style={{ backgroundColor: BRAND_LIGHT, borderRadius: 14, padding: 14, flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>Total Cost</Text>
                      <Text style={{ fontSize: 18, fontWeight: '800', color: BRAND }}>₹{totalCost.toLocaleString('en-IN')}</Text>
                    </View>
                  );
                })()}

                {/* ══ PAYMENT DETAILS (required when cost > 0, mirrors web) ════ */}
                {(() => {
                  const totalCost = resolutionForm.items.reduce((s, i) => s + (i.qty * i.unit_cost), 0) + (parseFloat(resolutionForm.totalLabourCost) || 0);
                  if (totalCost <= 0) return null;
                  return (
                    <View style={{ borderWidth: 1, borderColor: BRAND, borderRadius: 16, padding: 14, gap: 12 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Ionicons name="card-outline" size={16} color={BRAND} />
                        <Text style={{ fontSize: 12, fontWeight: '800', color: BRAND, textTransform: 'uppercase', letterSpacing: 0.5 }}>Payment Details</Text>
                        <View style={{ backgroundColor: '#FFEBEE', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                          <Text style={{ fontSize: 9, color: '#C62828', fontWeight: '700' }}>Required</Text>
                        </View>
                      </View>


                      {/* ══ STEP 1: Proof of Purchase (required) ══ */}
                      <View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                          <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.4 }}>PROOF OF PURCHASE *</Text>
                          <View style={{ backgroundColor: '#FFEBEE', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                            <Text style={{ fontSize: 9, color: '#C62828', fontWeight: '700' }}>Required</Text>
                          </View>
                        </View>
                        <TouchableOpacity
                          onPress={async () => {
                            const { status: _poPerm } = await ImagePicker.getMediaLibraryPermissionsAsync();
                            const poStatus = _poPerm === 'granted' ? 'granted' : (await ImagePicker.requestMediaLibraryPermissionsAsync()).status;
                            if (poStatus !== 'granted') { Alert.alert('Photo Access Required', 'Please allow photo access in Settings → Vishful → Photos.'); return; }
                            const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images' as any, quality: 0.8, base64: true });
                            if (!r.canceled && r.assets[0]) {
                              setResolutionProofUri(r.assets[0].uri);
                              setResolutionProofBase64(r.assets[0].base64 ?? undefined);
                              setResolutionForm(p => ({ ...p, proofOfPurchaseUrl: r.assets[0].uri }));
                            }
                          }}
                          style={{ borderWidth: 1.5, borderColor: resolutionProofUri ? '#22C55E' : '#DC2626', borderStyle: resolutionProofUri ? 'solid' : 'dashed', borderRadius: 14, overflow: 'hidden' }}>
                          {resolutionProofUri ? (
                            <View>
                              <Image source={{ uri: resolutionProofUri }} style={{ width: '100%', height: 110, resizeMode: 'cover' }} />
                              <View style={{ position: 'absolute', bottom: 6, right: 6, backgroundColor: '#22C55E', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 4 }}>
                                <Text style={{ fontSize: 10, fontWeight: '700', color: '#fff' }}>✓ Uploaded · Tap to change</Text>
                              </View>
                            </View>
                          ) : (
                            <View style={{ padding: 14, alignItems: 'center', gap: 4 }}>
                              <Ionicons name="receipt-outline" size={24} color="#DC2626" />
                              <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>Upload Bill / Invoice</Text>
                              <Text style={{ fontSize: 11, color: colors.textTertiary }}>Choose from device or use camera</Text>
                            </View>
                          )}
                        </TouchableOpacity>
                      </View>

                      {/* ══ STEP 2: Proof of Payment screenshot — OCR auto-fills fields below ══ */}
                      <View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                          <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.4 }}>PROOF OF PAYMENT</Text>
                          <View style={{ backgroundColor: '#E8F5E9', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                            <Text style={{ fontSize: 9, color: '#2E7D32', fontWeight: '700' }}>Optional · Auto-scan</Text>
                          </View>
                        </View>
                        <TouchableOpacity onPress={handlePaymentProofUpload}
                          style={{ borderWidth: 1.5, borderColor: paymentProofUri ? '#0284C7' : colors.border, borderStyle: paymentProofUri ? 'solid' : 'dashed', borderRadius: 14, overflow: 'hidden' }}>
                          {paymentProofUri ? (
                            <View>
                              <Image source={{ uri: paymentProofUri }} style={{ width: '100%', height: 110, resizeMode: 'cover' }} />
                              {ocrLoading && (
                                <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}>
                                  <ActivityIndicator color="#fff" />
                                  <Text style={{ color: '#fff', fontSize: 12, marginTop: 6 }}>Reading payment details…</Text>
                                </View>
                              )}
                              {ocrMeta && !ocrLoading && (
                                <View style={{ backgroundColor: 'rgba(2,132,199,0.92)', padding: 8 }}>
                                  <Text style={{ fontSize: 10, color: '#fff', fontWeight: '700' }}>
                                    From receipt:{ocrMeta.bankName ? `  ${ocrMeta.bankName}` : ''}{ocrMeta.amount ? `  ·  ₹${Math.round(ocrMeta.amount)}` : ''}{ocrMeta.date ? `  ·  ${ocrMeta.date}` : ''}
                                  </Text>
                                </View>
                              )}
                              {/* Mismatch check for auto-read amount */}
                              {ocrMeta?.amount != null && (() => {
                                const resTotal = resolutionForm.items.reduce((s, i) => s + (i.qty * i.unit_cost), 0) + (parseFloat(resolutionForm.totalLabourCost) || 0);
                                const diff = Math.abs(ocrMeta.amount - resTotal);
                                const allowedDiff = Math.max(1, resTotal * 0.01);
                                if (diff > allowedDiff && resTotal > 0) {
                                  return (
                                    <View style={{ backgroundColor: '#FFEBEE', padding: 10, gap: 4 }}>
                                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                        <Ionicons name="close-circle" size={16} color="#C62828" />
                                        <Text style={{ fontSize: 12, color: '#C62828', fontWeight: '800' }}>Amount Mismatch — Cannot Submit</Text>
                                      </View>
                                      <Text style={{ fontSize: 11, color: '#C62828', lineHeight: 16 }}>
                                        {'Screenshot: ₹' + Math.round(ocrMeta.amount).toLocaleString('en-IN') + ' ≠ Resolution: ₹' + Math.round(resTotal).toLocaleString('en-IN') + '\nFix the items/cost or upload the correct screenshot.'}
                                      </Text>
                                    </View>
                                  );
                                }
                                if (diff <= allowedDiff && resTotal > 0) {
                                  return (
                                    <View style={{ backgroundColor: '#E8F5E9', padding: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                      <Ionicons name="checkmark-circle" size={14} color="#2E7D32" />
                                      <Text style={{ fontSize: 11, color: '#2E7D32', fontWeight: '700' }}>
                                        {'Amount verified: ₹' + Math.round(ocrMeta.amount).toLocaleString('en-IN') + ' ✓'}
                                      </Text>
                                    </View>
                                  );
                                }
                                return null;
                              })()}
                            </View>
                          ) : (
                            <View style={{ padding: 14, alignItems: 'center', gap: 4 }}>
                              {ocrLoading ? <ActivityIndicator color="#0284C7" /> : <Ionicons name="scan-outline" size={24} color="#0284C7" />}
                              <Text style={{ fontSize: 13, fontWeight: '700', color: '#0284C7' }}>
                                {ocrLoading ? 'Reading payment details…' : 'Upload Payment Screenshot'}
                              </Text>
                              <Text style={{ fontSize: 11, color: colors.textTertiary }}>Tap to upload — auto-fills date, bank & amount</Text>
                            </View>
                          )}
                        </TouchableOpacity>

                        {/* ── Manual amount entry when OCR can't read (no Gemini key) ── */}
                        {requireManualAmount && paymentProofUri && (() => {
                          const resTotal = resolutionForm.items.reduce((s, i) => s + (i.qty * i.unit_cost), 0) + (parseFloat(resolutionForm.totalLabourCost) || 0);
                          const enteredAmt = parseFloat(manualPaymentAmount) || 0;
                          const diff = Math.abs(enteredAmt - resTotal);
                          const allowedDiff = Math.max(1, resTotal * 0.01);
                          const hasAmount = manualPaymentAmount.trim().length > 0 && enteredAmt > 0;
                          const isMatch = hasAmount && diff <= allowedDiff;
                          const isMismatch = hasAmount && diff > allowedDiff;
                          return (
                            <View style={{ marginTop: 8, backgroundColor: '#FFF8E1', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#FFB300', gap: 8 }}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Ionicons name="warning-outline" size={14} color="#E65100" />
                                <Text style={{ fontSize: 11, color: '#E65100', fontWeight: '700', flex: 1 }}>
                                  Auto-scan not available — enter screenshot amount to verify
                                </Text>
                              </View>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                <View style={{ flex: 1 }}>
                                  <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textTertiary, marginBottom: 4 }}>AMOUNT IN SCREENSHOT (₹) *</Text>
                                  <TextInput
                                    value={manualPaymentAmount}
                                    onChangeText={setManualPaymentAmount}
                                    placeholder={`e.g. ${Math.round(resTotal)}`}
                                    placeholderTextColor={colors.textTertiary}
                                    keyboardType="numeric"
                                    style={{ backgroundColor: colors.surface, borderWidth: 1.5, borderColor: isMismatch ? '#C62828' : isMatch ? '#2E7D32' : colors.border, borderRadius: 10, padding: 10, fontSize: 16, fontWeight: '700', color: colors.text }}
                                  />
                                </View>
                                <View style={{ paddingTop: 18 }}>
                                  {isMatch && <Ionicons name="checkmark-circle" size={24} color="#2E7D32" />}
                                  {isMismatch && <Ionicons name="close-circle" size={24} color="#C62828" />}
                                  {!hasAmount && <Ionicons name="help-circle-outline" size={24} color={colors.textTertiary} />}
                                </View>
                              </View>
                              {isMatch && (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#E8F5E9', borderRadius: 8, padding: 8 }}>
                                  <Ionicons name="checkmark-circle" size={14} color="#2E7D32" />
                                  <Text style={{ fontSize: 11, color: '#2E7D32', fontWeight: '700' }}>
                                    Amount matches resolution total ₹{Math.round(resTotal).toLocaleString('en-IN')} ✓
                                  </Text>
                                </View>
                              )}
                              {isMismatch && (
                                <View style={{ backgroundColor: '#FFEBEE', borderRadius: 8, padding: 8, gap: 3 }}>
                                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                    <Ionicons name="close-circle" size={14} color="#C62828" />
                                    <Text style={{ fontSize: 12, color: '#C62828', fontWeight: '800' }}>Amount Mismatch — Cannot Submit</Text>
                                  </View>
                                  <Text style={{ fontSize: 11, color: '#C62828' }}>
                                    {'You entered ₹' + Math.round(enteredAmt).toLocaleString('en-IN') + ' but resolution total is ₹' + Math.round(resTotal).toLocaleString('en-IN') + '. Fix items/cost or enter the correct amount.'}
                                  </Text>
                                </View>
                              )}
                              {!hasAmount && resTotal > 0 && (
                                <Text style={{ fontSize: 10, color: colors.textTertiary }}>
                                  Resolution total: ₹{Math.round(resTotal).toLocaleString('en-IN')} — screenshot amount must match to submit
                                </Text>
                              )}
                            </View>
                          );
                        })()}
                      </View>

                      {/* ══ STEP 3: Payment fields — auto-filled by OCR after screenshot upload ══ */}
                      <View style={{ backgroundColor: 'rgba(123,47,190,0.04)', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: 'rgba(123,47,190,0.12)', gap: 10 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Ionicons name="card-outline" size={13} color={BRAND} />
                          <Text style={{ fontSize: 10, fontWeight: '700', color: BRAND, letterSpacing: 0.3 }}>PAYMENT DETAILS</Text>
                          {ocrMeta ? (
                            <View style={{ backgroundColor: BRAND_LIGHT, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                              <Text style={{ fontSize: 9, fontWeight: '700', color: BRAND }}>Auto-filled from screenshot</Text>
                            </View>
                          ) : (
                            <Text style={{ fontSize: 9, color: colors.textTertiary }}>Upload screenshot above to auto-fill</Text>
                          )}
                        </View>

                        {/* Payment Date */}
                        <View style={{ gap: 4 }}>
                          <Text style={{ fontSize: 13, fontWeight: '600', color: '#5C4B70', marginBottom: 6 }}>Payment Date *</Text>
                          <DateField value={resolutionForm.paymentDate}
                            onChange={(v: string) => setResolutionForm(p => ({ ...p, paymentDate: v }))} />
                        </View>

                        {/* Bank Account */}
                        <View style={{ gap: 4 }}>
                          <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.4 }}>BANK ACCOUNT *</Text>
                          {bankAccounts.length === 0 ? (
                            <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12 }}>
                              <Text style={{ fontSize: 12, color: colors.textTertiary }}>No bank accounts found</Text>
                            </View>
                          ) : (
                            <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: resolutionForm.bankAccountId ? BRAND : colors.border, borderRadius: 12, overflow: 'hidden' }}>
                              {[{ id: '', bank_name: '— Select bank account —', account_number: '' }, ...bankAccounts].map((acc, idx) => (
                                <TouchableOpacity key={acc.id}
                                  onPress={() => setResolutionForm(p => ({ ...p, bankAccountId: acc.id }))}
                                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 11,
                                    borderTopWidth: idx > 0 ? 0.5 : 0, borderTopColor: colors.border,
                                    backgroundColor: resolutionForm.bankAccountId === acc.id && acc.id ? BRAND_LIGHT : 'transparent' }}>
                                  <Ionicons
                                    name={resolutionForm.bankAccountId === acc.id && acc.id ? 'checkmark-circle' : 'radio-button-off-outline'}
                                    size={16}
                                    color={resolutionForm.bankAccountId === acc.id && acc.id ? BRAND : colors.textTertiary}
                                  />
                                  <View style={{ flex: 1 }}>
                                    <Text style={{ fontSize: 13, color: colors.text }}>{acc.bank_name}</Text>
                                    {acc.account_number ? (
                                      <Text style={{ fontSize: 10, color: colors.textTertiary }}>
                                        {'••••' + String(acc.account_number).slice(-4)}
                                      </Text>
                                    ) : null}
                                  </View>
                                </TouchableOpacity>
                              ))}
                            </View>
                          )}
                        </View>

                        {/* Payment Reference */}
                        <ModalField label="Payment Reference No. *" placeholder="Txn / UTR / Ref no." value={resolutionForm.paymentReferenceNo}
                          onChange={(v: string) => setResolutionForm(p => ({ ...p, paymentReferenceNo: v }))} />
                      </View>
                    </View>
                  );
                })()}
              </ScrollView>

              <View style={{ padding: 20, borderTopWidth: 1, borderTopColor: colors.border }}>
                {/* Mismatch banner above submit button */}
                {(() => {
                  const resTotal = resolutionForm.items.reduce((s, i) => s + (i.qty * i.unit_cost), 0) + (parseFloat(resolutionForm.totalLabourCost) || 0);
                  const ocrMismatch = ocrMeta?.amount != null && resTotal > 0 && Math.abs(ocrMeta.amount - resTotal) > Math.max(1, resTotal * 0.01);
                  const manualAmt = parseFloat(manualPaymentAmount) || 0;
                  const manualMissing = requireManualAmount && paymentProofUri && resTotal > 0 && manualAmt <= 0;
                  const manualMismatch = requireManualAmount && paymentProofUri && resTotal > 0 && manualAmt > 0 && Math.abs(manualAmt - resTotal) > Math.max(1, resTotal * 0.01);
                  if (!ocrMismatch && !manualMissing && !manualMismatch) return null;
                  return (
                    <View style={{ backgroundColor: '#FFEBEE', borderRadius: 12, padding: 12, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Ionicons name="close-circle" size={18} color="#C62828" />
                      <Text style={{ fontSize: 12, color: '#C62828', fontWeight: '700', flex: 1 }}>
                        {manualMissing ? 'Enter the screenshot amount above to continue' : 'Fix amount mismatch before submitting'}
                      </Text>
                    </View>
                  );
                })()}
                <TouchableOpacity
                  onPress={handleSaveResolution}
                  disabled={actionLoading || !resolutionForm.closureSummary.trim() || ocrLoading || (() => {
                    const resTotal = resolutionForm.items.reduce((s, i) => s + (i.qty * i.unit_cost), 0) + (parseFloat(resolutionForm.totalLabourCost) || 0);
                    // Block if OCR amount mismatches
                    if (ocrMeta?.amount != null && resTotal > 0) {
                      const diff = Math.abs(ocrMeta.amount - resTotal);
                      if (diff > Math.max(1, resTotal * 0.01)) return true;
                    }
                    // Block if manual amount required but missing or mismatches
                    if (requireManualAmount && paymentProofUri && resTotal > 0) {
                      const entered = parseFloat(manualPaymentAmount) || 0;
                      if (entered <= 0) return true;
                      if (Math.abs(entered - resTotal) > Math.max(1, resTotal * 0.01)) return true;
                    }
                    return false;
                  })()}
                  style={{
                    backgroundColor: (() => {
                      if (!resolutionForm.closureSummary.trim() || ocrLoading) return colors.border;
                      const resTotal = resolutionForm.items.reduce((s, i) => s + (i.qty * i.unit_cost), 0) + (parseFloat(resolutionForm.totalLabourCost) || 0);
                      const hasMismatch = ocrMeta?.amount != null && resTotal > 0 && Math.abs(ocrMeta.amount - resTotal) > Math.max(1, resTotal * 0.01);
                      return hasMismatch ? '#DC2626' : '#22C55E';
                    })(),
                    borderRadius: 16, padding: 16, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8,
                    opacity: actionLoading ? 0.7 : 1,
                  }}>
                  {actionLoading
                    ? <ActivityIndicator color="#fff" size="small" />
                    : <Ionicons name="checkmark-circle-outline" size={20} color="#fff" />}
                  <Text style={{ fontSize: 16, fontWeight: '800', color: '#fff' }}>Submit & Mark Complete</Text>
                </TouchableOpacity>
              </View>
            </SafeAreaView>
          </GlassBackground>
        </Modal>

        {/* ─── COST ESTIMATE REVIEW MODAL (post-diagnosis or manual) ──────── */}
        <CostEstimateReviewModal
          visible={showCostReview}
          ticketId={ticketId}
          userId={userId}
          diagnosisResult={diagnosisResult}
          onClose={() => setShowCostReview(false)}
          onSubmit={async () => { setShowCostReview(false); await load(); }}
          onNoCost={async () => { setShowCostReview(false); setShowCompletedBanner(true); await load(); }}
        />

        {/* ─── REASSIGN MODAL ──────────────────────────────────────── */}
        <ReassignModal
          visible={showReassign}
          ticketId={ticketId}
          userId={userId}
          onClose={() => setShowReassign(false)}
          onSubmit={() => { setShowReassign(false); load(); }}
        />

        {/* ─── PURCHASE RECORD MODAL ───────────────────────────────── */}
        <PurchaseRecordModal
          visible={showPurchaseRecord}
          ticketId={ticketId}
          userId={userId}
          approvedEstimates={approvedEstimates}
          vendors={vendors}
          onClose={() => setShowPurchaseRecord(false)}
          onSubmit={async () => { setShowPurchaseRecord(false); await load(); }}
        />

        {/* ─── PHOTO LIGHTBOX ─────────────────────────────────────── */}
        <Modal visible={!!lightboxUrl} transparent animationType="fade">
          <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', alignItems: 'center', justifyContent: 'center' }} onPress={() => setLightboxUrl(null)} activeOpacity={1}>
            {lightboxUrl && <Image source={{ uri: lightboxUrl }} style={{ width: SW - 40, height: SW - 40, borderRadius: 16 }} resizeMode="contain" />}
            <Text style={{ color: '#fff', marginTop: 16, opacity: 0.6 }}>Tap anywhere to close</Text>
          </TouchableOpacity>
        </Modal>
      </SafeAreaView>
    </GlassBackground>
  );
}

// ════════════════════════════════════════════════════════════════
//  COST ESTIMATE ROW — with admin approve/decline inline
// ════════════════════════════════════════════════════════════════
function CostEstimateRow({ estimate, isAdmin, ticketId, userId, onUpdated }: {
  estimate: CostEstimate; isAdmin: boolean;
  ticketId: string; userId: string; onUpdated: () => void;
}) {
  const { colors } = useTheme();
  const [loading, setLoading]   = useState(false);
  const [editing, setEditing]   = useState(false);
  const [qty, setQty]           = useState(String(estimate.quantity));
  const [price, setPrice]       = useState(String(estimate.unit_price));
  const [declineReason, setDeclineReason] = useState('');
  const [showDeclineInput, setShowDeclineInput] = useState(false);

  const statusColor = estimate.status === 'approved' ? '#16A34A' : estimate.status === 'declined' ? '#DC2626' : '#D97706';
  const statusBg    = estimate.status === 'approved' ? '#DCFCE7' : estimate.status === 'declined' ? '#FEE2E2' : '#FEF3C7';

  const handleApprove = async () => {
    setLoading(true);
    try {
      await approveCostEstimate({
        estimateId: estimate.id, ticketId,
        action: 'approve', approvedBy: userId,
        modifiedQuantity:  editing ? parseInt(qty)   || estimate.quantity   : undefined,
        modifiedUnitPrice: editing ? parseFloat(price) || estimate.unit_price : undefined,
      });
      setEditing(false);
      onUpdated();
    } finally { setLoading(false); }
  };

  const handleDecline = async () => {
    if (!declineReason.trim()) {
      Alert.alert('Required', 'Please provide a reason for declining.'); return;
    }
    setLoading(true);
    try {
      await approveCostEstimate({
        estimateId: estimate.id, ticketId,
        action: 'decline', approvedBy: userId,
        declineReason,
      });
      setShowDeclineInput(false);
      onUpdated();
    } finally { setLoading(false); }
  };

  const computedTotal = editing
    ? (parseInt(qty) || 0) * (parseFloat(price) || 0)
    : estimate.total;

  return (
    <View style={{ backgroundColor: colors.background || colors.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border, gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1, marginRight: 10 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>{estimate.item_name}</Text>
          <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 2, textTransform: 'capitalize' }}>{estimate.cost_type}</Text>
        </View>
        <View style={{ backgroundColor: statusBg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
          <Text style={{ fontSize: 10, fontWeight: '800', color: statusColor, textTransform: 'uppercase' }}>{estimate.status}</Text>
        </View>
      </View>

      {/* Qty & price — editable if admin & pending */}
      {isAdmin && estimate.status === 'pending' && editing ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textTertiary }}>QTY</Text>
            <TextInput value={qty} onChangeText={setQty} keyboardType="numeric"
              style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 9, fontSize: 13, color: colors.text }} />
          </View>
          <View style={{ flex: 2, gap: 4 }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textTertiary }}>UNIT PRICE (₹)</Text>
            <TextInput value={price} onChangeText={setPrice} keyboardType="decimal-pad"
              style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 9, fontSize: 13, color: colors.text }} />
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 12, color: colors.textSecondary }}>{estimate.quantity} × ₹{estimate.unit_price.toLocaleString('en-IN')}</Text>
          <Text style={{ fontSize: 14, fontWeight: '800', color: colors.text }}>₹{computedTotal.toLocaleString('en-IN')}</Text>
        </View>
      )}

      {/* Admin actions */}
      {isAdmin && estimate.status === 'pending' && !showDeclineInput && (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {!editing && (
            <TouchableOpacity onPress={() => setEditing(true)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: colors.border }}>
              <Ionicons name="create-outline" size={14} color={colors.textSecondary} />
              <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary }}>Edit</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handleApprove} disabled={loading}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, backgroundColor: '#22C55E' }}>
            {loading ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="checkmark-outline" size={15} color="#fff" />}
            <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>{editing ? 'Approve Modified' : 'Approve'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowDeclineInput(true)} disabled={loading}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, backgroundColor: '#FEE2E2' }}>
            <Ionicons name="close-outline" size={15} color="#DC2626" />
            <Text style={{ fontSize: 12, fontWeight: '800', color: '#DC2626' }}>Decline</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Decline reason input */}
      {isAdmin && estimate.status === 'pending' && showDeclineInput && (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary }}>DECLINE REASON *</Text>
          <TextInput
            value={declineReason} onChangeText={setDeclineReason}
            placeholder="Why are you declining this estimate?"
            placeholderTextColor={colors.textTertiary}
            multiline
            style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: '#DC2626', borderRadius: 10, padding: 10, fontSize: 13, color: colors.text, minHeight: 70, textAlignVertical: 'top' }}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity onPress={() => { setShowDeclineInput(false); setDeclineReason(''); }}
              style={{ flex: 1, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: 'center' }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleDecline} disabled={loading}
              style={{ flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 10, borderRadius: 10, backgroundColor: '#DC2626' }}>
              {loading ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="close-circle-outline" size={16} color="#fff" />}
              <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>Confirm Decline</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Show decline reason if already declined */}
      {estimate.status === 'declined' && estimate.decline_reason && (
        <View style={{ backgroundColor: '#FEF2F2', borderRadius: 10, padding: 10 }}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: '#DC2626', marginBottom: 2 }}>DECLINE REASON</Text>
          <Text style={{ fontSize: 12, color: '#7F1D1D' }}>{estimate.decline_reason}</Text>
        </View>
      )}
    </View>
  );
}

// ════════════════════════════════════════════════════════════════
//  COST ESTIMATE REVIEW MODAL — post-diagnosis, sends to admin
// ════════════════════════════════════════════════════════════════
function CostEstimateReviewModal({ visible, ticketId, userId, diagnosisResult, onClose, onSubmit, onNoCost }: {
  visible: boolean;
  ticketId: string;
  userId: string;
  diagnosisResult: DiagnosticFlowResult | null;
  onClose: () => void;
  onSubmit: () => void;
  onNoCost: () => void;
}) {
  const { colors } = useTheme();
  const [noCostLoading, setNoCostLoading] = useState(false);

  const handleNoCost = async () => {
    Alert.alert(
      'No Cost — Mark Complete?',
      'This issue has no parts or material cost. The ticket will be marked complete and sent for approval directly.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm', style: 'default', onPress: async () => {
            setNoCostLoading(true);
            try {
              await updateTicketStatus(ticketId, 'completed', userId);
              onNoCost();
            } catch (e: any) {
              Alert.alert('Error', e?.message || 'Failed to mark complete');
            } finally { setNoCostLoading(false); }
          },
        },
      ]
    );
  };

  const initItems = () => {
    if (diagnosisResult?.parts && diagnosisResult.parts.length > 0) {
      return diagnosisResult.parts.map(p => ({
        item_name:  p.item_name,
        cost_type:  p.cost_type || 'parts',
        quantity:   p.quantity || 1,
        unit_price: p.unit_price || 0,
      }));
    }
    return [{ item_name: '', cost_type: 'parts', quantity: 1, unit_price: 0 }];
  };

  const [items, setItems]     = useState(initItems);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (visible) setItems(initItems());
  }, [visible, diagnosisResult]);

  const addItem    = () => setItems(p => [...p, { item_name: '', cost_type: 'parts', quantity: 1, unit_price: 0 }]);
  const removeItem = (idx: number) => setItems(p => p.filter((_, i) => i !== idx));
  const updateItem = (idx: number, key: string, val: any) =>
    setItems(p => p.map((it, i) => i === idx ? { ...it, [key]: val } : it));

  const total = items.reduce((s, i) => s + (i.quantity * i.unit_price), 0);

  const handleSubmit = async () => {
    if (items.some(i => !i.item_name.trim())) {
      Alert.alert('Required', 'All items must have a name.'); return;
    }
    setLoading(true);
    try {
      await submitCostEstimates(ticketId, items, userId);
      onSubmit();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to submit cost estimates');
    } finally { setLoading(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: 'rgba(124,58,237,0.1)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Ionicons name="receipt-outline" size={19} color="#7C3AED" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }}>Cost Estimate</Text>
              <Text style={{ fontSize: 11, color: colors.textTertiary }}>Review, edit & send to admin for approval</Text>
            </View>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close-circle" size={28} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>

          {/* Diagnosis summary if available */}
          {diagnosisResult && (
            <View style={{ marginHorizontal: 20, marginTop: 16, backgroundColor: 'rgba(34,197,94,0.08)', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: 'rgba(34,197,94,0.25)' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Ionicons name="checkmark-circle" size={16} color="#22C55E" />
                <Text style={{ fontSize: 13, fontWeight: '800', color: '#22C55E' }}>Diagnosis: {diagnosisResult.result.cause}</Text>
              </View>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>AI Estimate: {diagnosisResult.result.estimatedCost}</Text>
            </View>
          )}

          <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.5 }}>
              PARTS & MATERIALS — EDITABLE
            </Text>

            {items.map((item, idx) => (
              <View key={idx} style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: colors.border, gap: 10 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary }}>ITEM {idx + 1}</Text>
                  {items.length > 1 && (
                    <TouchableOpacity onPress={() => removeItem(idx)}>
                      <Ionicons name="trash-outline" size={18} color="#DC2626" />
                    </TouchableOpacity>
                  )}
                </View>

                <ModalField label="Item Name *" placeholder="e.g. PVC Pipe 1/2 inch" value={item.item_name} onChange={(v: string) => updateItem(idx, 'item_name', v)} />

                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <ModalField label="Qty" placeholder="1" value={String(item.quantity)} onChange={(v: string) => updateItem(idx, 'quantity', Number(v) || 1)} keyboardType="numeric" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <ModalField label="Unit Price (₹)" placeholder="0" value={String(item.unit_price)} onChange={(v: string) => updateItem(idx, 'unit_price', Number(v) || 0)} keyboardType="numeric" />
                  </View>
                </View>

                {/* Type toggle */}
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {(['parts', 'labor', 'other'] as const).map(ct => (
                    <TouchableOpacity key={ct} onPress={() => updateItem(idx, 'cost_type', ct)}
                      style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: item.cost_type === ct ? BRAND_LIGHT : colors.surface, borderWidth: 1.5, borderColor: item.cost_type === ct ? BRAND : colors.border }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: item.cost_type === ct ? BRAND : colors.textSecondary }}>
                        {ct.charAt(0).toUpperCase() + ct.slice(1)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={{ fontSize: 13, fontWeight: '800', color: BRAND, textAlign: 'right' }}>
                  Subtotal: ₹{(item.quantity * item.unit_price).toLocaleString('en-IN')}
                </Text>
              </View>
            ))}

            <TouchableOpacity onPress={addItem}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 14, borderRadius: 14, borderWidth: 1.5, borderColor: BRAND, borderStyle: 'dashed' }}>
              <Ionicons name="add-circle-outline" size={18} color={BRAND} />
              <Text style={{ fontSize: 14, fontWeight: '700', color: BRAND }}>Add Another Item</Text>
            </TouchableOpacity>
          </ScrollView>

          {/* Footer */}
          <View style={{ padding: 20, gap: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: BRAND_LIGHT, borderRadius: 14, padding: 14 }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>Total Estimate</Text>
              <Text style={{ fontSize: 20, fontWeight: '800', color: BRAND }}>₹{total.toLocaleString('en-IN')}</Text>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: total > 0 && total <= 1000 ? 'rgba(34,197,94,0.08)' : 'rgba(2,132,199,0.08)', borderRadius: 12, padding: 12 }}>
              <Ionicons name={total > 0 && total <= 1000 ? 'flash-outline' : 'send-outline'} size={16} color={total > 0 && total <= 1000 ? '#16A34A' : '#0284C7'} />
              <Text style={{ fontSize: 12, color: total > 0 && total <= 1000 ? '#16A34A' : '#0284C7', flex: 1, fontWeight: '600' }}>
                {total > 0 && total <= 1000
                  ? 'Under ₹1,000 — auto-approved instantly and moves to "Waiting for Parts" (unless it\'s a repeat job in the same apartment, which needs admin approval).'
                  : 'This will be sent to admin for approval. Ticket moves to "Awaiting Approval".'}
              </Text>
            </View>

            <TouchableOpacity onPress={handleNoCost} disabled={noCostLoading || loading}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 14, borderRadius: 16, borderWidth: 1.5, borderColor: '#22C55E', backgroundColor: 'rgba(34,197,94,0.06)' }}>
              {noCostLoading ? <ActivityIndicator color="#22C55E" size="small" /> : <Ionicons name="checkmark-done-circle-outline" size={20} color="#22C55E" />}
              <View>
                <Text style={{ fontSize: 14, fontWeight: '800', color: '#22C55E' }}>No Cost — ₹0</Text>
                <Text style={{ fontSize: 10, color: '#16A34A' }}>No parts needed · Mark complete directly</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity onPress={handleSubmit} disabled={loading || noCostLoading}
              style={{ backgroundColor: '#7C3AED', borderRadius: 16, padding: 16, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
              {loading ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="send-outline" size={20} color="#fff" />}
              <Text style={{ fontSize: 16, fontWeight: '800', color: '#fff' }}>Send to Admin for Approval</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </GlassBackground>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════
//  PURCHASE RECORD MODAL — after admin approves, parts arrived
// ════════════════════════════════════════════════════════════════
function PurchaseRecordModal({ visible, ticketId, userId, approvedEstimates, vendors, onClose, onSubmit }: {
  visible: boolean; ticketId: string; userId: string;
  approvedEstimates: CostEstimate[]; vendors: { id: string; vendor_name: string }[];
  onClose: () => void; onSubmit: () => void;
}) {
  const { colors } = useTheme();
  const purchasedEstIds = new Set<string>(); // passed in via approvedEstimates in context

  const blankForm = {
    cost_estimate_id: '' as string,
    item_name: '', quantity: 1, estimated_cost: 0, actual_cost: 0,
    vendor_id: '' as string,
    vendor_name_manual: '', vendor_pan: '', vendor_mobile: '', vendor_address: '',
    invoice_url: null as string | null,
  };
  const [form, setForm]             = useState(blankForm);
  const [invoiceUri, setInvoiceUri] = useState<string | null>(null);
  const [invoiceBase64, setInvoiceBase64] = useState<string | undefined>();
  const [loading, setLoading]       = useState(false);

  useEffect(() => {
    if (visible) {
      // Pre-fill from first unpurchased approved estimate
      const first = approvedEstimates[0];
      if (first) {
        setForm({ ...blankForm, cost_estimate_id: first.id, item_name: first.item_name, quantity: first.quantity, estimated_cost: first.unit_price, actual_cost: first.total });
      } else {
        setForm(blankForm);
      }
      setInvoiceUri(null); setInvoiceBase64(undefined);
    }
  }, [visible]);

  const pickInvoice = async () => {
    // Check current permission first — only request if not already granted (avoids repeated iOS popup)
    const { status: existing } = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (existing !== 'granted') {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Photo Access Required', 'To upload an invoice, please allow photo access in Settings → Vishful → Photos.', [{ text: 'OK' }]);
        return;
      }
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images' as any, quality: 0.8, base64: true });
    if (!result.canceled && result.assets[0]) {
      setInvoiceUri(result.assets[0].uri);
      setInvoiceBase64(result.assets[0].base64 ?? undefined);
    }
  };

  const handleSubmit = async () => {
    if (!form.item_name.trim()) { Alert.alert('Required', 'Item name is required.'); return; }
    if (!invoiceUri && !form.invoice_url) { Alert.alert('Invoice Required', 'Please upload the bill / invoice before submitting.'); return; }
    setLoading(true);
    try {
      let invoiceUrl = form.invoice_url;
      if (invoiceUri) {
        const uploaded = await uploadTicketPhoto(invoiceUri, invoiceBase64, 'image/jpeg');
        if (uploaded) invoiceUrl = uploaded;
      }
      await recordPurchase({
        ticketId,
        items: [{ item_name: form.item_name, quantity: form.quantity, actual_cost: form.actual_cost, estimated_cost: form.estimated_cost }],
        vendorId: form.vendor_id && form.vendor_id !== '__general' ? form.vendor_id : undefined,
        vendorNameManual: form.vendor_name_manual || undefined,
        invoiceUrl: invoiceUrl || undefined,
        purchasedBy: userId,
        costEstimateId: form.cost_estimate_id || undefined,
      });
      onSubmit();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to record purchase');
    } finally { setLoading(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: 'rgba(2,132,199,0.1)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Ionicons name="cube-outline" size={19} color="#0284C7" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }}>Record Purchase</Text>
              <Text style={{ fontSize: 11, color: colors.textTertiary }}>Confirm actual costs after purchase</Text>
            </View>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close-circle" size={28} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }}>
            {/* Linked Estimate selector — mirrors web (auto-fills fields) */}
            {approvedEstimates.length > 0 && (
              <View style={{ gap: 4 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.5 }}>LINKED ESTIMATE</Text>
                <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 4 }}>
                  {[{ id: '', item_name: '— No linked estimate —', quantity: 1, unit_price: 0, total: 0, cost_type: '', status: '' } as any, ...approvedEstimates].map(est => (
                    <TouchableOpacity
                      key={est.id}
                      onPress={() => {
                        if (!est.id) { setForm(p => ({ ...p, cost_estimate_id: '' })); return; }
                        setForm(p => ({ ...p, cost_estimate_id: est.id, item_name: est.item_name, quantity: est.quantity, estimated_cost: est.unit_price, actual_cost: est.total }));
                      }}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 10, backgroundColor: form.cost_estimate_id === est.id && est.id ? BRAND_LIGHT : 'transparent' }}
                    >
                      <Ionicons name={form.cost_estimate_id === est.id && est.id ? 'checkmark-circle' : 'radio-button-off-outline'} size={18} color={form.cost_estimate_id === est.id && est.id ? BRAND : colors.textTertiary} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, flex: 1 }}>{est.item_name || '— No linked estimate —'}</Text>
                      {est.id ? <Text style={{ fontSize: 12, fontWeight: '700', color: BRAND }}>₹{est.total.toLocaleString('en-IN')}</Text> : null}
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            <ModalField label="Item Name *" placeholder="e.g. PVC Pipe 1/2 inch" value={form.item_name}
              onChange={(v: string) => setForm(p => ({ ...p, item_name: v }))} />

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <ModalField label="Qty" placeholder="1" value={String(form.quantity)} keyboardType="numeric"
                  onChange={(v: string) => setForm(p => ({ ...p, quantity: Number(v) || 1 }))} />
              </View>
              <View style={{ flex: 1 }}>
                <ModalField label="Actual Cost (₹) *" placeholder="0" value={String(form.actual_cost)} keyboardType="numeric"
                  onChange={(v: string) => setForm(p => ({ ...p, actual_cost: Number(v) || 0 }))} />
              </View>
            </View>

            {form.estimated_cost > 0 && (
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: 'rgba(107,114,128,0.08)', borderRadius: 10, padding: 10 }}>
                <Text style={{ fontSize: 12, color: colors.textSecondary }}>Estimated: ₹{form.estimated_cost.toLocaleString('en-IN')}</Text>
                {form.actual_cost > 0 && (() => {
                  const diff = form.actual_cost - form.estimated_cost;
                  return <Text style={{ fontSize: 12, fontWeight: '700', color: diff > 0 ? '#DC2626' : '#16A34A' }}>
                    {diff > 0 ? '+' : ''}₹{diff.toLocaleString('en-IN')} vs est.
                  </Text>;
                })()}
              </View>
            )}

            {/* Vendor selector */}
            <View style={{ gap: 4 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.5 }}>VENDOR</Text>
              <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: 'hidden' }}>
                {[{ id: '__general', vendor_name: '+ General / One-time Vendor' }, ...vendors].map(v => (
                  <TouchableOpacity key={v.id} onPress={() => setForm(p => ({ ...p, vendor_id: v.id, vendor_name_manual: '' }))}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderTopWidth: vendors.indexOf(v as any) > -1 ? 0.5 : 0, borderTopColor: colors.border, backgroundColor: form.vendor_id === v.id ? 'rgba(232,132,26,0.1)' : 'transparent' }}>
                    <Ionicons name={form.vendor_id === v.id ? 'checkmark-circle' : 'radio-button-off-outline'} size={18} color={form.vendor_id === v.id ? BRAND : colors.textTertiary} />
                    <Text style={{ fontSize: 13, color: colors.text, flex: 1 }}>{v.vendor_name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* General vendor detail fields */}
            {form.vendor_id === '__general' && (
              <View style={{ gap: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 14 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary }}>GENERAL VENDOR DETAILS</Text>
                <ModalField label="Vendor Name *" placeholder="Enter vendor name" value={form.vendor_name_manual}
                  onChange={(v: string) => setForm(p => ({ ...p, vendor_name_manual: v }))} />
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <ModalField label="PAN Number" placeholder="ABCDE1234F" value={form.vendor_pan}
                      onChange={(v: string) => setForm(p => ({ ...p, vendor_pan: v }))} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <ModalField label="Mobile" placeholder="9876543210" value={form.vendor_mobile} keyboardType="numeric"
                      onChange={(v: string) => setForm(p => ({ ...p, vendor_mobile: v }))} />
                  </View>
                </View>
                <ModalField label="Address" placeholder="Vendor address" value={form.vendor_address}
                  onChange={(v: string) => setForm(p => ({ ...p, vendor_address: v }))} />
              </View>
            )}

            {/* Invoice — REQUIRED (mirrors web: button disabled without it) */}
            <View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.5 }}>INVOICE / BILL</Text>
                <View style={{ backgroundColor: '#FFEBEE', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 9, color: '#C62828', fontWeight: '700' }}>Required</Text>
                </View>
              </View>
              <TouchableOpacity onPress={pickInvoice}
                style={{ borderWidth: 1.5, borderColor: invoiceUri ? '#0284C7' : '#DC2626', borderStyle: invoiceUri ? 'solid' : 'dashed', borderRadius: 14, overflow: 'hidden' }}>
                {invoiceUri ? (
                  <View style={{ position: 'relative' }}>
                    <Image source={{ uri: invoiceUri }} style={{ width: '100%', height: 140, resizeMode: 'cover' }} />
                    <View style={{ position: 'absolute', bottom: 8, right: 8, backgroundColor: '#0284C7', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Ionicons name="pencil-outline" size={12} color="#fff" />
                      <Text style={{ fontSize: 11, fontWeight: '700', color: '#fff' }}>Change</Text>
                    </View>
                  </View>
                ) : (
                  <View style={{ padding: 18, alignItems: 'center', gap: 6 }}>
                    <Ionicons name="receipt-outline" size={28} color="#DC2626" />
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>Tap to upload bill / invoice</Text>
                    <Text style={{ fontSize: 11, color: colors.textTertiary }}>Required to submit purchase</Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>

          <View style={{ padding: 20, gap: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: 'rgba(2,132,199,0.1)', borderRadius: 14, padding: 14 }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>Total Actual Cost</Text>
              <Text style={{ fontSize: 20, fontWeight: '800', color: '#0284C7' }}>₹{(form.quantity * form.actual_cost).toLocaleString('en-IN')}</Text>
            </View>
            <TouchableOpacity onPress={handleSubmit} disabled={loading || !invoiceUri}
              style={{ backgroundColor: invoiceUri ? '#0284C7' : colors.border, borderRadius: 16, padding: 16, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
              {loading ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="checkmark-circle-outline" size={20} color="#fff" />}
              <Text style={{ fontSize: 16, fontWeight: '800', color: '#fff' }}>{invoiceUri ? 'Confirm Purchase' : 'Upload Invoice to Submit'}</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </GlassBackground>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════
//  REASSIGN MODAL
// ════════════════════════════════════════════════════════════════
function ReassignModal({ visible, ticketId, userId, onClose, onSubmit }: any) {
  const { colors } = useTheme();
  const [members, setMembers]   = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notes, setNotes]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    if (visible) {
      setFetching(true);
      fetchTeamMembers().then(data => { setMembers(data || []); setFetching(false); });
    }
  }, [visible]);

  const handleSubmit = async () => {
    if (!selected) { Alert.alert('Select a technician'); return; }
    setLoading(true);
    try { await reassignTicket(ticketId, selected, userId, notes); onSubmit(); }
    finally { setLoading(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: 'rgba(124,58,237,0.1)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Ionicons name="swap-horizontal-outline" size={19} color="#7C3AED" />
            </View>
            <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text, flex: 1 }}>Reassign Ticket</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close-circle" size={28} color={colors.textTertiary} /></TouchableOpacity>
          </View>
          {fetching ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator size="large" color={BRAND} /></View>
          ) : (
            <ScrollView contentContainerStyle={{ padding: 20, gap: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.5, marginBottom: 4 }}>SELECT TEAM MEMBER</Text>
              {members.map(m => {
                const id = m.user_id || m.id;
                const name = `${m.first_name || ''} ${m.last_name || ''}`.trim();
                const isSelected = selected === id;
                return (
                  <TouchableOpacity key={id} onPress={() => setSelected(id)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, backgroundColor: isSelected ? BRAND_LIGHT : colors.surface, borderWidth: 1.5, borderColor: isSelected ? BRAND : colors.border }}>
                    <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: isSelected ? BRAND : colors.border, alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: isSelected ? '#fff' : colors.textSecondary }}>{name.charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>{name}</Text>
                      {m.phone && <Text style={{ fontSize: 12, color: colors.textSecondary }}>{m.phone}</Text>}
                    </View>
                    {isSelected && <Ionicons name="checkmark-circle" size={22} color={BRAND} />}
                  </TouchableOpacity>
                );
              })}
              <ModalField label="Notes (optional)" placeholder="Reason for reassignment..." value={notes} onChange={setNotes} multiline />
            </ScrollView>
          )}
          <View style={{ padding: 20 }}>
            <TouchableOpacity onPress={handleSubmit} disabled={loading || !selected}
              style={{ backgroundColor: selected ? '#7C3AED' : colors.border, borderRadius: 16, padding: 16, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
              {loading ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="swap-horizontal-outline" size={20} color="#fff" />}
              <Text style={{ fontSize: 16, fontWeight: '800', color: '#fff' }}>Confirm Reassignment</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </GlassBackground>
    </Modal>
  );
}

// ─── Helpers ──────────────────────────────────────────────────
function SectionCard({ title, icon, iconColor, iconBg, children }: any) {
  const { colors } = useTheme();
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: 20, padding: 18, borderWidth: 1, borderColor: colors.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name={icon} size={17} color={iconColor} />
        </View>
        <Text style={{ fontSize: 14, fontWeight: '800', color: colors.text }}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function InfoRow({ icon, label, value, valueColor }: { icon: string; label: string; value: string; valueColor?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
      <View style={{ width: 22, height: 22, alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
        <Ionicons name={icon as any} size={15} color={colors.textTertiary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.4, marginBottom: 1 }}>{label.toUpperCase()}</Text>
        <Text style={{ fontSize: 14, fontWeight: '600', color: valueColor || colors.text }}>{value}</Text>
      </View>
    </View>
  );
}

function ModalField({ label, placeholder, value, onChange, multiline, keyboardType }: any) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.4 }}>{label.toUpperCase()}</Text>
      <TextInput
        value={value} onChangeText={onChange} placeholder={placeholder}
        placeholderTextColor={colors.textTertiary} multiline={multiline}
        keyboardType={keyboardType || 'default'}
        style={{ backgroundColor: colors.background || colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, fontSize: 14, color: colors.text, minHeight: multiline ? 80 : undefined, textAlignVertical: multiline ? 'top' : undefined }}
      />
    </View>
  );
}

// ════════════════════════════════════════════════════════════════
//  BOTTOM TAB NAVIGATOR
// ════════════════════════════════════════════════════════════════
import ElectricityScreen from './ElectricityScreen';

// ── Electricity tab for technician ────────────────────────────────────────────
function TechElectricityScreen() {
  return <ElectricityScreen />;
}

function TechnicianTabNavigator() {
  const { colors } = useTheme();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: 'rgba(255,255,255,0.88)',
          borderTopColor: 'rgba(224,213,234,0.3)',
          borderTopWidth: 0.5,
          height: Platform.OS === 'ios' ? 88 : 64,
          paddingBottom: Platform.OS === 'ios' ? 24 : 8,
          paddingTop: 8,
          shadowColor: '#1E1230',
          shadowOpacity: 0.06,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: -4 },
          elevation: 0,
        },
        tabBarActiveTintColor: '#7B2FBE',
        tabBarInactiveTintColor: '#9B8BAE',
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
        tabBarIcon: ({ color, focused }) => {
          const icons: Record<string, [string, string]> = {
            TicketsDashboard: ['grid', 'grid-outline'],
            MyTickets:        ['list', 'list-outline'],
            Electricity:      ['flash', 'flash-outline'],
            Profile:          ['person', 'person-outline'],
          };
          const [active, inactive] = icons[route.name] || ['help', 'help-outline'];
          return <Ionicons name={(focused ? active : inactive) as any} size={22} color={color} />;
        },
      })}
    >
      <Tab.Screen name="TicketsDashboard" component={TicketsDashboardScreen} options={{ tabBarLabel: 'Dashboard' }} />
      <Tab.Screen name="MyTickets"        component={MyTicketsScreen}        options={{ tabBarLabel: 'My Tickets' }} />
      <Tab.Screen name="Electricity"      component={TechElectricityScreen}  options={{ tabBarLabel: 'Electricity' }} />
      <Tab.Screen name="Profile"          component={TechnicianProfileScreen} options={{ tabBarLabel: 'Profile' }} />
    </Tab.Navigator>
  );
}

// ════════════════════════════════════════════════════════════════
//  ROOT STACK EXPORT
// ════════════════════════════════════════════════════════════════
export default function TechnicianNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="TechnicianTabs" component={TechnicianTabNavigator} />
      <Stack.Screen name="TicketDetail" component={TicketDetailScreen} options={{ animation: 'slide_from_right' }} />
    </Stack.Navigator>
  );
}
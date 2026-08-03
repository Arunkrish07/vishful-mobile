import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Modal, Alert, RefreshControl, TextInput, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { spacing, fontSize, glass } from '../lib/theme';
import { Button, Input, EmptyState, LoadingScreen, GlassBackground, DateField } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { Ionicons } from '@expo/vector-icons';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import { useMountedRef, isAbortError } from '../lib/safeAsync';

// ─── Constants ────────────────────────────────────────────────────────────────
const SPECIALIZATIONS = [
  'Technician', 'Plumbing', 'IT Support', 'Application Tech',
  'Housekeeping', 'Software', 'AC Technician', 'Electrician', 'Security',
];

const ROLES = [
  { label: 'Technician', value: 'technician' },
  { label: 'Property Manager', value: 'property_manager' },
  { label: 'Admin', value: 'admin' },
];

const DEPARTMENTS = ['Maintenance', 'Management', 'Support', 'Security', 'Housekeeping', 'IT'];

const EMPTY_FORM = {
  first_name: '', last_name: '', phone: '', email: '', gender: '',
  designation: '', department: '', joining_date: '', salary_amount: '',
  id_proof_type: '', id_proof_number: '',
  pan_number: '', aadhar_number: '',
  address: '', city: '', state: '',
  bank_name: '', bank_account_number: '', bank_ifsc: '',
  emergency_contact_name: '', emergency_contact_phone: '',
  status: 'active',
};

const EMPTY_PAYMENT = {
  payment_type: 'salary', amount: '', payment_date: '', payment_month: '',
  payment_mode: 'bank_transfer', notes: '',
};

const EMPTY_ATTENDANCE = {
  date: '', status: 'present', check_in: '', check_out: '', notes: '',
};

const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  active:   { color: '#16a34a', bg: '#dcfce7' },
  inactive: { color: '#dc2626', bg: '#fee2e2' },
  on_leave: { color: '#ea580c', bg: '#ffedd5' },
};

// ─── Main Screen ─────────────────────────────────────────────────────────────
export default function TeamScreen() {
  const { token } = useAuth();
  const nav = useNavigation();
  const mounted = useMountedRef();

  const [members, setMembers]       = useState<any[] | null>(null);
  const [payments, setPayments]     = useState<any[]>([]);
  const [attendance, setAttendance] = useState<any[]>([]);
  const [search, setSearch]         = useState('');
  const [activeTab, setActiveTab]   = useState<'members' | 'payments' | 'attendance'>('members');
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading]       = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedSpecs, setSelectedSpecs] = useState<string[]>([]);
  const refresh = useCallback(() => setRefreshKey(k => k + 1), []);

  // Modals
  const [showAdd, setShowAdd]           = useState(false);
  const [showEdit, setShowEdit]         = useState(false);
  const [showPayment, setShowPayment]   = useState(false);
  const [showAttendance, setShowAttendance] = useState(false);
  const [selected, setSelected]         = useState<any>(null);
  const [form, setForm]                 = useState({ ...EMPTY_FORM });
  const [paymentForm, setPaymentForm]   = useState({ ...EMPTY_PAYMENT });
  const [attForm, setAttForm]           = useState({ ...EMPTY_ATTENDANCE });
  const setF   = (k: keyof typeof EMPTY_FORM) => (v: string) => setForm(p => ({ ...p, [k]: v }));
  const setPF  = (k: keyof typeof EMPTY_PAYMENT) => (v: string) => setPaymentForm(p => ({ ...p, [k]: v }));
  const setAF  = (k: keyof typeof EMPTY_ATTENDANCE) => (v: string) => setAttForm(p => ({ ...p, [k]: v }));

  // ── Load ──
  useEffect(() => {
    if (!token) return;
    setMembers(null);
    Promise.all([
      sb.getTeamMembers(),
      sb.getAll('team_payments'),
      sb.getAll('team_attendance'),
    ]).then(([m, p, a]: any) => {
      if (!mounted.current) return;
      setMembers(m ?? []);
      setPayments(p ?? []);
      setAttendance(a ?? []);
    }).catch((e: any) => {
      if (!mounted.current || isAbortError(e)) return;
      setMembers([]); setPayments([]); setAttendance([]);
    });
  }, [token, refreshKey]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [m, p, a]: any = await Promise.all([
        sb.getTeamMembers(),
        sb.getAll('team_payments'),
        sb.getAll('team_attendance'),
      ]);
      if (mounted.current) { setMembers(m ?? []); setPayments(p ?? []); setAttendance(a ?? []); }
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  // ── Filtered ──
  const filteredMembers = (members || []).filter(m => {
    const q = search.toLowerCase();
    const fullName = `${m.first_name || ''} ${m.last_name || ''}`.trim().toLowerCase();
    return !q || fullName.includes(q) || (m.phone || '').includes(q) || (m.designation || '').toLowerCase().includes(q);
  });

  // ── CRUD ──
  const handleAdd = async () => {
    if (!form.first_name.trim()) { Alert.alert('Validation', 'First name is required'); return; }
    if (!form.phone.trim())      { Alert.alert('Validation', 'Phone is required'); return; }
    setLoading(true);
    try {
      await sb.createTeamMember({
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim() || null,
        phone: form.phone.trim(),
        email: form.email.trim() || null,
        gender: form.gender || null,
        designation: form.designation.trim() || null,
        department: form.department || null,
        joining_date: form.joining_date || null,
        salary_amount: form.salary_amount ? parseFloat(form.salary_amount) : null,
        id_proof_type: form.id_proof_type || null,
        id_proof_number: form.id_proof_number.trim() || null,
        pan_number: form.pan_number.trim() || null,
        aadhar_number: form.aadhar_number.trim() || null,
        address: form.address.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        bank_name: form.bank_name.trim() || null,
        bank_account_number: form.bank_account_number.trim() || null,
        bank_ifsc: form.bank_ifsc.trim() || null,
        emergency_contact_name: form.emergency_contact_name.trim() || null,
        emergency_contact_phone: form.emergency_contact_phone.trim() || null,
        status: form.status,
        specialties: selectedSpecs.length > 0 ? selectedSpecs : null,
      });
      setShowAdd(false);
      setForm({ ...EMPTY_FORM });
      setSelectedSpecs([]);
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to add team member');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = async () => {
    if (!selected) return;
    setLoading(true);
    try {
      await sb.updateTeamMember(selected.id, {
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim() || null,
        phone: form.phone.trim(),
        email: form.email.trim() || null,
        gender: form.gender || null,
        designation: form.designation.trim() || null,
        department: form.department || null,
        salary_amount: form.salary_amount ? parseFloat(form.salary_amount) : null,
        id_proof_type: form.id_proof_type || null,
        id_proof_number: form.id_proof_number.trim() || null,
        pan_number: form.pan_number.trim() || null,
        aadhar_number: form.aadhar_number.trim() || null,
        address: form.address.trim() || null,
        city: form.city.trim() || null,
        bank_name: form.bank_name.trim() || null,
        bank_account_number: form.bank_account_number.trim() || null,
        bank_ifsc: form.bank_ifsc.trim() || null,
        emergency_contact_name: form.emergency_contact_name.trim() || null,
        emergency_contact_phone: form.emergency_contact_phone.trim() || null,
        status: form.status,
        specialties: selectedSpecs.length > 0 ? selectedSpecs : null,
      });
      setShowEdit(false);
      setSelected(null);
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to update team member');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = (member: any) => {
    const name = `${member.first_name || ''} ${member.last_name || ''}`.trim();
    Alert.alert('Remove Member', `Remove "${name}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          try { await sb.deleteTeamMember(member.id); refresh(); }
          catch (e: any) { Alert.alert('Error', e?.message || 'Failed to remove'); }
        },
      },
    ]);
  };

  const handleAddPayment = async () => {
    if (!selected || !paymentForm.amount || !paymentForm.payment_date) {
      Alert.alert('Validation', 'Amount and payment date are required');
      return;
    }
    setLoading(true);
    try {
      await sb.insertRow('team_payments', {
        team_member_id: selected.id,
        payment_type: paymentForm.payment_type,
        amount: parseFloat(paymentForm.amount),
        payment_date: paymentForm.payment_date,
        payment_month: paymentForm.payment_month || null,
        payment_mode: paymentForm.payment_mode,
        notes: paymentForm.notes.trim() || null,
      });
      setShowPayment(false);
      setPaymentForm({ ...EMPTY_PAYMENT });
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to record payment');
    } finally {
      setLoading(false);
    }
  };

  const handleAddAttendance = async () => {
    if (!selected || !attForm.date) {
      Alert.alert('Validation', 'Date is required');
      return;
    }
    setLoading(true);
    try {
      await sb.insertRow('team_attendance', {
        team_member_id: selected.id,
        date: attForm.date,
        status: attForm.status,
        check_in: attForm.check_in || null,
        check_out: attForm.check_out || null,
        notes: attForm.notes.trim() || null,
      });
      setShowAttendance(false);
      setAttForm({ ...EMPTY_ATTENDANCE });
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to record attendance');
    } finally {
      setLoading(false);
    }
  };

  const openEdit = (m: any) => {
    setSelected(m);
    setForm({
      first_name: m.first_name || '', last_name: m.last_name || '',
      phone: m.phone || '', email: m.email || '',
      gender: m.gender || '', designation: m.designation || '',
      department: m.department || '', joining_date: m.joining_date || '',
      salary_amount: m.salary_amount ? String(m.salary_amount) : '',
      id_proof_type: m.id_proof_type || '', id_proof_number: m.id_proof_number || '',
      pan_number: m.pan_number || '', aadhar_number: m.aadhar_number || '',
      address: m.address || '', city: m.city || '', state: m.state || '',
      bank_name: m.bank_name || '', bank_account_number: m.bank_account_number || '',
      bank_ifsc: m.bank_ifsc || '',
      emergency_contact_name: m.emergency_contact_name || '',
      emergency_contact_phone: m.emergency_contact_phone || '',
      status: m.status || 'active',
    });
    setSelectedSpecs(m.specialties || m.specializations || []);
    setShowEdit(true);
  };

  const openPayment = (m: any) => { setSelected(m); setPaymentForm({ ...EMPTY_PAYMENT }); setShowPayment(true); };
  const openAttendance = (m: any) => { setSelected(m); setAttForm({ ...EMPTY_ATTENDANCE }); setShowAttendance(true); };

  // ── Render ──
  if (members === null) return <LoadingScreen />;

  const tabs = [
    { key: 'members',    label: 'Members',    icon: 'people-outline' },
    { key: 'payments',   label: 'Payments',   icon: 'cash-outline' },
    { key: 'attendance', label: 'Attendance', icon: 'calendar-outline' },
  ] as const;

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }}>
        {/* Header */}
        <View style={styles.header}>
          <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center', marginRight: 10 }}>
            <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
          </View>
          <View>
            <Text style={styles.headerTitle}>Team</Text>
            <Text style={styles.headerSub}>{members.length} members</Text>
          </View>
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => { setForm({ ...EMPTY_FORM }); setSelectedSpecs([]); setShowAdd(true); }}
          >
            <Ionicons name="add" size={22} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Tabs */}
        <View style={styles.tabRow}>
          {tabs.map(t => (
            <TouchableOpacity
              key={t.key}
              onPress={() => setActiveTab(t.key)}
              style={[styles.tab, activeTab === t.key && styles.tabActive]}
            >
              <Ionicons name={t.icon as any} size={14} color={activeTab === t.key ? '#7B2FBE' : '#9B8BAE'} />
              <Text style={[styles.tabLabel, activeTab === t.key && styles.tabLabelActive]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Search (members only) */}
        {activeTab === 'members' && (
          <View style={styles.searchRow}>
            <View style={styles.searchBox}>
              <Ionicons name="search-outline" size={18} color="#9B8BAE" style={{ marginRight: 8 }} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search by name, phone…"
                placeholderTextColor="#9B8BAE"
                value={search}
                onChangeText={setSearch}
              />
              {search.length > 0 && (
                <TouchableOpacity onPress={() => setSearch('')}>
                  <Ionicons name="close-circle" size={18} color="#9B8BAE" />
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* Content */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          showsVerticalScrollIndicator={false}
        >
          {activeTab === 'members' && (
            filteredMembers.length === 0 ? (
              <EmptyState icon="people-outline" title="No team members" subtitle="Tap + to add your first team member" />
            ) : (
              filteredMembers.map(m => (
                <MemberCard
                  key={m.id} member={m}
                  onEdit={() => openEdit(m)}
                  onDelete={() => handleDelete(m)}
                  onPayment={() => openPayment(m)}
                  onAttendance={() => openAttendance(m)}
                />
              ))
            )
          )}

          {activeTab === 'payments' && (
            payments.length === 0 ? (
              <EmptyState icon="cash-outline" title="No payments recorded" subtitle="Open a team member and record payment" />
            ) : (
              payments.map(p => <PaymentRow key={p.id} payment={p} members={members || []} />)
            )
          )}

          {activeTab === 'attendance' && (
            attendance.length === 0 ? (
              <EmptyState icon="calendar-outline" title="No attendance records" subtitle="Open a team member and mark attendance" />
            ) : (
              attendance.map(a => <AttendanceRow key={a.id} record={a} members={members || []} />)
            )
          )}
        </ScrollView>
      </SafeAreaView>

      {/* Add Member Modal */}
      <MemberFormModal
        visible={showAdd} title="Add Team Member"
        form={form} setF={setF}
        selectedSpecs={selectedSpecs} setSelectedSpecs={setSelectedSpecs}
        loading={loading} onSave={handleAdd} onClose={() => setShowAdd(false)}
      />

      {/* Edit Member Modal */}
      <MemberFormModal
        visible={showEdit} title="Edit Member"
        form={form} setF={setF}
        selectedSpecs={selectedSpecs} setSelectedSpecs={setSelectedSpecs}
        loading={loading} onSave={handleEdit}
        onClose={() => { setShowEdit(false); setSelected(null); }}
      />

      {/* Payment Modal */}
      <Modal visible={showPayment} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
          <SafeAreaView style={{ flex: 1 }}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => setShowPayment(false)}>
                <Ionicons name="close" size={24} color="#1E1230" />
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Record Payment</Text>
              <View style={{ width: 24 }} />
            </View>
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
              {selected && (
                <View style={[styles.selectedBanner]}>
                  <Ionicons name="person-circle-outline" size={20} color="#7B2FBE" />
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#1E1230', marginLeft: 8 }}>
                    {`${selected.first_name || ''} ${selected.last_name || ''}`.trim()}
                  </Text>
                </View>
              )}
              <PickerRow label="Payment Type" value={paymentForm.payment_type}
                options={[{ label: 'Salary', value: 'salary' }, { label: 'Bonus', value: 'bonus' }, { label: 'Advance', value: 'advance' }]}
                onSelect={setPF('payment_type')} />
              <Input label="Amount (₹) *" value={paymentForm.amount} onChangeText={setPF('amount')} placeholder="0" keyboardType="numeric" icon="cash-outline" />
              <View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#5C4B70', marginBottom: 6 }}>Payment Date *</Text><DateField value={paymentForm.payment_date} onChange={setPF('payment_date')} /></View>
              <Input label="Month (optional)" value={paymentForm.payment_month} onChangeText={setPF('payment_month')} placeholder="YYYY-MM" icon="calendar-number-outline" />
              <PickerRow label="Payment Mode" value={paymentForm.payment_mode}
                options={[{ label: 'Bank Transfer', value: 'bank_transfer' }, { label: 'Cash', value: 'cash' }, { label: 'UPI', value: 'upi' }]}
                onSelect={setPF('payment_mode')} />
              <Input label="Notes" value={paymentForm.notes} onChangeText={setPF('notes')} placeholder="Optional notes…" multiline icon="create-outline" />
              <View style={{ marginTop: 16 }}>
                <Button title="Save Payment" onPress={handleAddPayment} loading={loading} icon="checkmark-circle-outline" />
              </View>
            </ScrollView>
          </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* Attendance Modal */}
      <Modal visible={showAttendance} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
          <SafeAreaView style={{ flex: 1 }}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => setShowAttendance(false)}>
                <Ionicons name="close" size={24} color="#1E1230" />
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Mark Attendance</Text>
              <View style={{ width: 24 }} />
            </View>
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
              {selected && (
                <View style={styles.selectedBanner}>
                  <Ionicons name="person-circle-outline" size={20} color="#7B2FBE" />
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#1E1230', marginLeft: 8 }}>
                    {`${selected.first_name || ''} ${selected.last_name || ''}`.trim()}
                  </Text>
                </View>
              )}
              <View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#5C4B70', marginBottom: 6 }}>Date *</Text><DateField value={attForm.date} onChange={setAF('date')} /></View>
              <PickerRow label="Status" value={attForm.status}
                options={[
                  { label: 'Present', value: 'present' }, { label: 'Absent', value: 'absent' },
                  { label: 'Half Day', value: 'half_day' }, { label: 'Leave', value: 'leave' },
                ]}
                onSelect={setAF('status')} />
              <Input label="Check In" value={attForm.check_in} onChangeText={setAF('check_in')} placeholder="HH:MM" icon="time-outline" />
              <Input label="Check Out" value={attForm.check_out} onChangeText={setAF('check_out')} placeholder="HH:MM" icon="time-outline" />
              <Input label="Notes" value={attForm.notes} onChangeText={setAF('notes')} placeholder="Optional notes…" multiline icon="create-outline" />
              <View style={{ marginTop: 16 }}>
                <Button title="Save Attendance" onPress={handleAddAttendance} loading={loading} icon="checkmark-circle-outline" />
              </View>
            </ScrollView>
          </SafeAreaView>
        </GlassBackground>
      </Modal>
    </GlassBackground>
  );
}

// ─── Member Card ──────────────────────────────────────────────────────────────
function MemberCard({ member, onEdit, onDelete, onPayment, onAttendance }: any) {
  const [expanded, setExpanded] = useState(false);
  const sc = STATUS_COLORS[member.status] || STATUS_COLORS.active;
  const name = `${member.first_name || ''} ${member.last_name || ''}`.trim() || '—';
  const initials = name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase();

  return (
    <View style={styles.card}>
      <TouchableOpacity onPress={() => setExpanded(e => !e)} activeOpacity={0.85}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text style={styles.memberName}>{name}</Text>
              <View style={[styles.badge, { backgroundColor: sc.bg }]}>
                <Text style={[styles.badgeText, { color: sc.color }]}>{member.status || 'active'}</Text>
              </View>
            </View>
            {member.designation ? <Text style={styles.memberMeta}>{member.designation}{member.department ? ` · ${member.department}` : ''}</Text> : null}
            <Text style={styles.memberMeta}>
              <Ionicons name="call-outline" size={12} color="#9B8BAE" /> {member.phone || '—'}
            </Text>
            {member.salary_amount ? (
              <Text style={styles.memberMeta}>
                <Ionicons name="cash-outline" size={12} color="#9B8BAE" /> ₹{Number(member.salary_amount).toLocaleString('en-IN')}/mo
              </Text>
            ) : null}
          </View>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color="#9B8BAE" />
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={{ marginTop: 12, gap: 8 }}>
          {(member.specialties || member.specializations)?.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {(member.specialties || member.specializations).map((s: string) => (
                <View key={s} style={{ backgroundColor: 'rgba(123,47,190,0.08)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ fontSize: 11, color: '#7B2FBE', fontWeight: '600' }}>{s}</Text>
                </View>
              ))}
            </View>
          )}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            <ActionChip label="Edit" icon="pencil-outline" color="#7B2FBE" onPress={onEdit} />
            <ActionChip label="Payment" icon="cash-outline" color="#16a34a" onPress={onPayment} />
            <ActionChip label="Attendance" icon="calendar-outline" color="#2563eb" onPress={onAttendance} />
            <ActionChip label="Remove" icon="trash-outline" color="#dc2626" onPress={onDelete} />
          </View>
        </View>
      )}
    </View>
  );
}

function ActionChip({ label, icon, color, onPress }: any) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: color + '14', borderWidth: 1, borderColor: color + '30' }}
    >
      <Ionicons name={icon} size={13} color={color} />
      <Text style={{ fontSize: 12, fontWeight: '600', color }}>{label}</Text>
    </TouchableOpacity>
  );
}

function PaymentRow({ payment, members }: any) {
  const member = members.find((m: any) => m.id === payment.team_member_id);
  const name = member ? `${member.first_name || ''} ${member.last_name || ''}`.trim() : '—';
  return (
    <View style={[styles.card, { padding: 12 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View>
          <Text style={{ fontSize: 14, fontWeight: '700', color: '#1E1230' }}>{name}</Text>
          <Text style={{ fontSize: 12, color: '#9B8BAE' }}>{payment.payment_type} · {payment.payment_mode}</Text>
          <Text style={{ fontSize: 12, color: '#9B8BAE' }}>{formatDate(payment.payment_date)}{payment.payment_month ? ` · ${payment.payment_month}` : ''}</Text>
        </View>
        <Text style={{ fontSize: 16, fontWeight: '800', color: '#16a34a' }}>₹{Number(payment.amount || 0).toLocaleString('en-IN')}</Text>
      </View>
    </View>
  );
}

const ATT_COLORS: Record<string, string> = {
  present: '#16a34a', absent: '#dc2626', half_day: '#ea580c', leave: '#2563eb',
};

function AttendanceRow({ record, members }: any) {
  const member = members.find((m: any) => m.id === record.team_member_id);
  const name = member ? `${member.first_name || ''} ${member.last_name || ''}`.trim() : '—';
  const color = ATT_COLORS[record.status] || '#9B8BAE';
  return (
    <View style={[styles.card, { padding: 12 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View>
          <Text style={{ fontSize: 14, fontWeight: '700', color: '#1E1230' }}>{name}</Text>
          <Text style={{ fontSize: 12, color: '#9B8BAE' }}>{formatDate(record.date)}</Text>
          {record.check_in ? <Text style={{ fontSize: 12, color: '#9B8BAE' }}>{record.check_in} → {record.check_out || '—'}</Text> : null}
        </View>
        <View style={{ backgroundColor: color + '18', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color, textTransform: 'capitalize' }}>{(record.status || '').replace('_', ' ')}</Text>
        </View>
      </View>
    </View>
  );
}

// ─── Member Form Modal ────────────────────────────────────────────────────────
function MemberFormModal({ visible, title, form, setF, selectedSpecs, setSelectedSpecs, loading, onSave, onClose }: any) {
  const toggleSpec = (s: string) =>
    setSelectedSpecs((prev: string[]) => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color="#1E1230" />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>{title}</Text>
            <View style={{ width: 24 }} />
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
            <SectionLabel title="Personal" icon="person-outline" />
            <Input label="First Name *" value={form.first_name} onChangeText={setF('first_name')} placeholder="First name" icon="person-outline" />
            <Input label="Last Name" value={form.last_name} onChangeText={setF('last_name')} placeholder="Last name" icon="person-outline" />
            <Input label="Phone *" value={form.phone} onChangeText={setF('phone')} placeholder="10-digit phone" keyboardType="phone-pad" icon="call-outline" />
            <Input label="Email" value={form.email} onChangeText={setF('email')} placeholder="Email" keyboardType="email-address" icon="mail-outline" autoCapitalize="none" />
            <PickerRow label="Gender" value={form.gender}
              options={[{ label: 'Male', value: 'male' }, { label: 'Female', value: 'female' }, { label: 'Other', value: 'other' }]}
              onSelect={setF('gender')} />
            <PickerRow label="Status" value={form.status}
              options={[{ label: 'Active', value: 'active' }, { label: 'Inactive', value: 'inactive' }, { label: 'On Leave', value: 'on_leave' }]}
              onSelect={setF('status')} />

            <SectionLabel title="Work" icon="briefcase-outline" />
            <Input label="Designation" value={form.designation} onChangeText={setF('designation')} placeholder="e.g. Technician" icon="ribbon-outline" />
            <PickerRow label="Department" value={form.department}
              options={DEPARTMENTS.map(d => ({ label: d, value: d }))}
              onSelect={setF('department')} />
            <View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#5C4B70', marginBottom: 6 }}>Joining Date</Text><DateField value={form.joining_date} onChange={setF('joining_date')} /></View>
            <Input label="Salary (₹/month)" value={form.salary_amount} onChangeText={setF('salary_amount')} placeholder="0" keyboardType="numeric" icon="cash-outline" />

            <SectionLabel title="Specializations" icon="star-outline" />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
              {SPECIALIZATIONS.map(s => {
                const active = selectedSpecs.includes(s);
                return (
                  <TouchableOpacity
                    key={s}
                    onPress={() => toggleSpec(s)}
                    style={{
                      paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
                      backgroundColor: active ? '#7B2FBE' : 'rgba(255,255,255,0.6)',
                      borderWidth: 1, borderColor: active ? '#7B2FBE' : 'rgba(224,213,234,0.5)',
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '600', color: active ? '#fff' : '#5C4B70' }}>{s}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <SectionLabel title="Identity" icon="card-outline" />
            <Input label="PAN Number" value={form.pan_number} onChangeText={setF('pan_number')} placeholder="ABCDE1234F" autoCapitalize="characters" icon="document-text-outline" />
            <Input label="Aadhar Number" value={form.aadhar_number} onChangeText={setF('aadhar_number')} placeholder="12-digit Aadhar" keyboardType="numeric" icon="shield-outline" />

            <SectionLabel title="Address" icon="location-outline" />
            <Input label="Address" value={form.address} onChangeText={setF('address')} placeholder="Street address" multiline icon="home-outline" />
            <Input label="City" value={form.city} onChangeText={setF('city')} placeholder="City" icon="business-outline" />
            <Input label="State" value={form.state} onChangeText={setF('state')} placeholder="State" icon="map-outline" />

            <SectionLabel title="Bank Details" icon="wallet-outline" />
            <Input label="Bank Name" value={form.bank_name} onChangeText={setF('bank_name')} placeholder="Bank name" icon="business-outline" />
            <Input label="Account Number" value={form.bank_account_number} onChangeText={setF('bank_account_number')} placeholder="Account number" keyboardType="numeric" icon="card-outline" />
            <Input label="IFSC Code" value={form.bank_ifsc} onChangeText={setF('bank_ifsc')} placeholder="IFSC code" autoCapitalize="characters" icon="barcode-outline" />

            <SectionLabel title="Emergency Contact" icon="alert-circle-outline" />
            <Input label="Contact Name" value={form.emergency_contact_name} onChangeText={setF('emergency_contact_name')} placeholder="Name" icon="person-outline" />
            <Input label="Contact Phone" value={form.emergency_contact_phone} onChangeText={setF('emergency_contact_phone')} placeholder="Phone" keyboardType="phone-pad" icon="call-outline" />

            <View style={{ marginTop: 16 }}>
              <Button title="Save Member" onPress={onSave} loading={loading} icon="checkmark-circle-outline" />
            </View>
          </ScrollView>
        </SafeAreaView>
      </GlassBackground>
    </Modal>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function SectionLabel({ title, icon }: { title: string; icon: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10, marginTop: 18 }}>
      <Ionicons name={icon as any} size={14} color="#7B2FBE" />
      <Text style={{ fontSize: 11, fontWeight: '700', color: '#7B2FBE', letterSpacing: 0.8, textTransform: 'uppercase' }}>{title}</Text>
    </View>
  );
}

function PickerRow({ label, value, options, onSelect }: any) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={{ fontSize: 11, fontWeight: '600', color: '#5C4B70', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>{label}</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {options.map((opt: any) => (
          <TouchableOpacity
            key={opt.value}
            onPress={() => onSelect(opt.value)}
            style={{
              paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
              backgroundColor: value === opt.value ? '#7B2FBE' : 'rgba(255,255,255,0.6)',
              borderWidth: 1, borderColor: value === opt.value ? '#7B2FBE' : 'rgba(224,213,234,0.5)',
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: '600', color: value === opt.value ? '#fff' : '#5C4B70' }}>{opt.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 0.5, borderBottomColor: 'rgba(123,47,190,0.08)',
  },
  menuBtn: { padding: 4 },
  headerTitle: { fontSize: 18, fontWeight: '800', color: '#1E1230' },
  headerSub: { fontSize: 12, color: '#9B8BAE', marginTop: 1 },
  addBtn: {
    width: 38, height: 38, borderRadius: 12,
    backgroundColor: '#7B2FBE', alignItems: 'center', justifyContent: 'center',
  },
  tabRow: {
    flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 8, gap: 8,
    borderBottomWidth: 0.5, borderBottomColor: 'rgba(123,47,190,0.08)',
  },
  tab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: 8, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.4)',
  },
  tabActive: { backgroundColor: 'rgba(123,47,190,0.1)', borderWidth: 1, borderColor: 'rgba(123,47,190,0.2)' },
  tabLabel: { fontSize: 12, fontWeight: '600', color: '#9B8BAE' },
  tabLabelActive: { color: '#7B2FBE' },
  searchRow: { paddingHorizontal: 16, paddingVertical: 8 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(224,213,234,0.5)',
    paddingHorizontal: 14, height: 44,
  },
  searchInput: { flex: 1, fontSize: 15, color: '#1E1230' },
  card: { ...glass.card, marginBottom: 10, padding: 14 },
  avatar: {
    width: 46, height: 46, borderRadius: 14,
    backgroundColor: 'rgba(123,47,190,0.08)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: 'rgba(123,47,190,0.12)',
  },
  avatarText: { fontSize: 16, fontWeight: '800', color: '#7B2FBE' },
  memberName: { fontSize: 15, fontWeight: '700', color: '#1E1230' },
  memberMeta: { fontSize: 12, color: '#9B8BAE', marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  badgeText: { fontSize: 10, fontWeight: '700', textTransform: 'capitalize' },
  selectedBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(123,47,190,0.08)', borderRadius: 12,
    padding: 12, marginBottom: 16,
  },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 0.5, borderBottomColor: 'rgba(123,47,190,0.08)',
  },
  modalTitle: { fontSize: 17, fontWeight: '800', color: '#1E1230' },
});
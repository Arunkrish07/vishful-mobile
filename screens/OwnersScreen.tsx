import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Modal, RefreshControl, StyleSheet, Alert, Share, Linking, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { DrawerActions, useNavigation, useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../lib/auth';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { GlassBackground, EmptyState, LoadingScreen, DateField, SearchField, IconBtnSolid } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { client as convexClient, api as convexApi } from '../lib/convexApi';
import { INDIAN_STATES, INDIAN_CITIES } from '../lib/indianCitiesStates';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';

const owners = (convexApi as any).owners;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtAmt  = (v: number) => `₹${(v || 0).toLocaleString('en-IN')}`;
const fmtDate = (d: string | null) => formatDate(d, '—');
const fmtMonth = (m: string | null) => {
  if (!m) return '—';
  try { const [y, mo] = m.split('-'); return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }); }
  catch { return m; }
};
const contractColor = (status: string) =>
  status === 'active' ? '#16A34A' : status === 'upcoming' ? '#0284C7' : status === 'expired' ? '#DC2626' : '#64748B';

const PAYMENT_MODES = [
  { key: 'transfer',    label: 'Bank Transfer' },
  { key: 'cash',        label: 'Cash'          },
  { key: 'cheque',      label: 'Cheque'        },
  { key: 'upi',         label: 'UPI'           },
  { key: 'credit_card', label: 'Credit Card'   },
];

// Financial-year period helpers (mirrors web period filter)
const PERIODS = [
  { key: 'current_fy', label: 'Current FY' },
  { key: 'last_fy',    label: 'Last FY'    },
  { key: 'last_2fy',   label: 'Last 2 FY'  },
  { key: 'all',        label: 'All Time'   },
];
function periodRange(key: string): { from: Date; to: Date } {
  const now = new Date();
  const y = now.getFullYear();
  const fyStartYear = now.getMonth() >= 3 ? y : y - 1; // FY starts Apr
  const fyStart = new Date(fyStartYear, 3, 1);
  const fyEnd   = new Date(fyStartYear + 1, 2, 31, 23, 59, 59);
  switch (key) {
    case 'current_fy': return { from: fyStart, to: fyEnd };
    case 'last_fy':    return { from: new Date(fyStartYear - 1, 3, 1), to: new Date(fyStartYear, 2, 31, 23, 59, 59) };
    case 'last_2fy':   return { from: new Date(fyStartYear - 2, 3, 1), to: fyEnd };
    default:           return { from: new Date(2000, 0, 1), to: new Date(2099, 11, 31) };
  }
}

const PaymentStatusBadge = ({ p }: { p: any }) => {
  const today = new Date();
  let status = p.status;
  if (status !== 'paid' && p.due_date && new Date(p.due_date) < today) status = 'overdue';
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    paid:    { bg: '#DCFCE7', fg: '#16A34A', label: 'Paid'    },
    overdue: { bg: '#FEE2E2', fg: '#DC2626', label: 'Overdue' },
    pending: { bg: '#FEF9C3', fg: '#A16207', label: 'Pending' },
  };
  const s = map[status] || map.pending;
  return (
    <View style={{ backgroundColor: s.bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <Text style={{ fontSize: 10, fontWeight: '800', color: s.fg }}>{s.label}</Text>
    </View>
  );
};

const ContractBadge = ({ type }: { type: string }) => (
  <View style={{ backgroundColor: type === 'lease' ? '#EFF6FF' : '#DBEAFE', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
    <Text style={{ fontSize: 10, fontWeight: '700', color: type === 'lease' ? '#2563EB' : '#1D4ED8', textTransform: 'uppercase' }}>{(type || '').replace(/_/g, ' ')}</Text>
  </View>
);

const Chip = ({ label }: { label: string }) => (
  <View style={{ backgroundColor: '#EFF6FF', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
    <Text style={{ fontSize: 10, fontWeight: '700', color: '#4338CA' }}>{label}</Text>
  </View>
);

const SectionTitle = ({ title }: { title: string }) => (
  <Text style={{ fontSize: 11, fontWeight: '800', color: '#2563EB', letterSpacing: 0.5, marginTop: 16, marginBottom: 8 }}>{title.toUpperCase()}</Text>
);

// Reusable form input
const FInput = ({ label, value, onChange, placeholder, keyboardType, multiline }: any) => (
  <View style={{ marginBottom: 12 }}>
    {label ? <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary, marginBottom: 5 }}>{label}</Text> : null}
    <TextInput
      style={{
        backgroundColor: colors.surface, borderWidth: 1.5, borderColor: '#E5E7EB',
        borderRadius: 10, padding: 11, fontSize: 14, color: colors.text,
        minHeight: multiline ? 80 : undefined, textAlignVertical: multiline ? 'top' : 'center',
      }}
      value={value} onChangeText={onChange} placeholder={placeholder || ''}
      placeholderTextColor={colors.textTertiary} keyboardType={keyboardType} multiline={multiline}
    />
  </View>
);

const FDate = ({ label, value, onChange }: any) => (
  <View style={{ marginBottom: 12 }}>
    {label ? <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary, marginBottom: 5 }}>{label}</Text> : null}
    <DateField value={value} onChange={onChange} />
  </View>
);

// ─── Owner Form Modal (Add + Edit) ─────────────────────────────────────────────
const EMPTY_OWNER = {
  title: '', first_name: '', last_name: '', phone: '', email: '',
  pan_number: '', aadhar_number: '', gst_number: '',
  address: '', city: '', state: '', pincode: '',
  bank_name: '', bank_account_number: '', bank_ifsc: '', notes: '',
  photo_url: '', id_proof_url: '',
};

function splitName(full: string) {
  const parts = (full || '').trim().split(' ');
  return { first_name: parts[0] || '', last_name: parts.slice(1).join(' ') || '' };
}

// ─── Validation (mirrors web) ───────────────────────────────────────────────────
const validatePhone = (v: string) => /^\d{10}$/.test(v || '');
const validateEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || '');

const TITLE_OPTIONS = ['Mr', 'Mrs', 'Miss', 'Mstr'];

// ─── Searchable Picker (for State / City) ────────────────────────────────────────
function SearchablePicker({ label, value, onChange, options, placeholder, disabled, required }: {
  label: string; value: string; onChange: (v: string) => void;
  options: string[]; placeholder?: string; disabled?: boolean; required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const filtered = q ? options.filter(o => o.toLowerCase().includes(q.toLowerCase())) : options;
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary, marginBottom: 5 }}>{label}{required ? ' *' : ''}</Text>
      <TouchableOpacity
        disabled={disabled}
        onPress={() => { setQ(''); setOpen(true); }}
        style={{
          backgroundColor: disabled ? '#F1F5F9' : colors.surface, borderWidth: 1.5,
          borderColor: disabled ? colors.border : 'rgba(37,99,235,0.25)', borderRadius: 10,
          padding: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        }}
      >
        <Text style={{ fontSize: 14, color: value ? colors.text : colors.textTertiary }}>{value || placeholder || 'Select…'}</Text>
        <Ionicons name="chevron-down" size={16} color={colors.textTertiary} />
      </TouchableOpacity>

      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <GlassBackground>
          <SafeAreaView style={{ flex: 1 }}>
            <View style={S.modalHeader}>
              <Text style={S.modalTitle}>{label}</Text>
              <TouchableOpacity onPress={() => setOpen(false)}><Ionicons name="close-circle" size={28} color={colors.textTertiary} /></TouchableOpacity>
            </View>
            <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 12, borderWidth: 1, borderColor: '#E5E7EB', paddingHorizontal: 12, height: 42 }}>
                <Ionicons name="search-outline" size={17} color={colors.textTertiary} style={{ marginRight: 8 }} />
                <TextInput style={{ flex: 1, fontSize: 14, color: '#111827' }} value={q} onChangeText={setQ} placeholder={`Search ${label.toLowerCase()}…`} placeholderTextColor={colors.textTertiary} autoFocus />
              </View>
            </View>
            <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
              {filtered.length === 0 ? (
                <Text style={{ textAlign: 'center', color: colors.textTertiary, padding: 20 }}>No matches</Text>
              ) : filtered.map(opt => (
                <TouchableOpacity key={opt} onPress={() => { onChange(opt); setOpen(false); }}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderRadius: 10, backgroundColor: value === opt ? '#EFF6FF' : 'transparent', marginBottom: 2 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#111827' }}>{opt}</Text>
                  {value === opt && <Ionicons name="checkmark-circle" size={18} color="#2563EB" />}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </SafeAreaView>
        </GlassBackground>
      </Modal>
    </View>
  );
}

// ─── Document Upload (real upload to Supabase storage via Convex) ────────────────
function DocUpload({ label, value, onChange, folder, isImage }: {
  label: string; value: string; onChange: (url: string) => void;
  folder: string; isImage?: boolean;
}) {
  const [uploading, setUploading] = useState(false);

  const pickAndUpload = async (fromCamera: boolean) => {
    try {
      const perm = fromCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert('Permission needed', 'Please allow access to continue.'); return; }

      const result = fromCamera
        ? await ImagePicker.launchCameraAsync({ quality: 0.7, mediaTypes: ImagePicker.MediaTypeOptions.Images })
        : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ImagePicker.MediaTypeOptions.Images });

      if (result.canceled || !result.assets?.length) return;
      setUploading(true);

      // Compress / resize (max 1200px wide, matches web)
      const manip = await ImageManipulator.manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 1200 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG }
      );
      const base64 = await FileSystem.readAsStringAsync(manip.uri, { encoding: FileSystem.EncodingType.Base64 });

      const res: any = await convexClient.action(owners.uploadDocument, {
        base64,
        fileName: `${label.replace(/\s+/g, '_').toLowerCase()}.jpg`,
        folder,
        contentType: 'image/jpeg',
      });
      onChange(res.url);
    } catch (e: any) {
      Alert.alert('Upload failed', e.message || 'Could not upload file');
    } finally {
      setUploading(false);
    }
  };

  const choose = () => {
    Alert.alert(label, 'Choose a source', [
      { text: 'Take Photo', onPress: () => pickAndUpload(true) },
      { text: 'Choose from Library', onPress: () => pickAndUpload(false) },
      ...(value ? [{ text: 'Remove', style: 'destructive' as const, onPress: () => onChange('') }] : []),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary, marginBottom: 5 }}>{label}</Text>
      {value ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#EFF6FF', borderRadius: 10, padding: 10, borderWidth: 1, borderColor: '#E5E7EB' }}>
          <View style={{ width: 44, height: 44, borderRadius: 8, backgroundColor: 'rgba(37,99,235,0.12)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            <Ionicons name={isImage ? 'image' : 'document-text'} size={20} color="#2563EB" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: '#16A34A' }}>Uploaded ✓</Text>
            <TouchableOpacity onPress={() => Linking.openURL(value).catch(() => {})}>
              <Text style={{ fontSize: 11, color: '#2563EB', textDecorationLine: 'underline' }} numberOfLines={1}>View file</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={choose} disabled={uploading} style={{ padding: 6 }}>
            {uploading ? <ActivityIndicator size="small" color="#2563EB" /> : <Ionicons name="swap-horizontal" size={18} color="#2563EB" />}
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity onPress={choose} disabled={uploading}
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.surface, borderRadius: 10, padding: 13, borderWidth: 1.5, borderColor: '#E5E7EB', borderStyle: 'dashed' }}>
          {uploading ? <ActivityIndicator size="small" color="#2563EB" /> : <Ionicons name="cloud-upload-outline" size={18} color="#2563EB" />}
          <Text style={{ fontSize: 13, fontWeight: '600', color: '#2563EB' }}>{uploading ? 'Uploading…' : `Upload ${label}`}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function OwnerFormModal({ mode, initial, onClose, onSaved }: {
  mode: 'add' | 'edit';
  initial?: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<any>(() => {
    if (mode === 'edit' && initial) {
      // Owner detail returns camelCase; map to the snake_case the form/DB use
      return {
        ...EMPTY_OWNER,
        ...splitName(initial.full_name || initial.name || ''),
        title:               initial.title || initial.gender || '',
        phone:               initial.phone || '',
        email:               initial.email || '',
        pan_number:          initial.panNumber || initial.pan_number || '',
        aadhar_number:       initial.aadharNumber || initial.aadhar_number || '',
        gst_number:          initial.gstNumber || initial.gst_number || '',
        address:             initial.address || '',
        city:                initial.city || '',
        state:               initial.state || '',
        pincode:             initial.pincode || '',
        bank_name:           initial.bankName || initial.bank_name || '',
        bank_account_number: initial.bankAccountNumber || initial.bank_account_number || '',
        bank_ifsc:           initial.bankIfsc || initial.bank_ifsc || '',
        notes:               initial.notes || '',
        photo_url:           initial.photoUrl || initial.photo_url || '',
        id_proof_url:        initial.idProofUrl || initial.id_proof_url || '',
      };
    }
    return { ...EMPTY_OWNER };
  });
  const [saving, setSaving] = useState(false);
  const setF = (k: string) => (v: any) => setForm((p: any) => ({ ...p, [k]: v }));

  const handleSave = async () => {
    // Validation — mirrors web: first+last name required, phone 10 digits, valid email
    if (!form.first_name?.trim() || !form.last_name?.trim()) {
      Alert.alert('Required', 'First and Last name are required'); return;
    }
    if (!validatePhone(form.phone)) {
      Alert.alert('Invalid Phone', 'Phone must be exactly 10 digits'); return;
    }
    if (!validateEmail(form.email)) {
      Alert.alert('Invalid Email', 'Enter a valid email address'); return;
    }
    setSaving(true);
    try {
      // title is UI-only (not a DB column) — backend ignores it
      if (mode === 'add') {
        await convexClient.action(owners.createOwner, { data: form });
      } else {
        await convexClient.action(owners.updateOwner, { id: initial.id, data: form });
      }
      onSaved();
    } catch (e: any) { Alert.alert('Error', e.message); }
    setSaving(false);
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={S.modalHeader}>
            <Text style={S.modalTitle}>{mode === 'add' ? 'Add Owner' : 'Edit Owner'}</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close-circle" size={28} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
            {/* ── Name + Title (mirrors web NameGenderFields) ── */}
            <SectionTitle title="Personal" />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ width: 90 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary, marginBottom: 5 }}>Title</Text>
                <TouchableOpacity
                  onPress={() => setForm((p: any) => {
                    const i = TITLE_OPTIONS.indexOf(p.title);
                    return { ...p, title: TITLE_OPTIONS[(i + 1) % TITLE_OPTIONS.length] };
                  })}
                  style={{ backgroundColor: colors.surface, borderWidth: 1.5, borderColor: '#E5E7EB', borderRadius: 10, padding: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <Text style={{ fontSize: 14, color: form.title ? colors.text : colors.textTertiary }}>{form.title || '—'}</Text>
                  <Ionicons name="chevron-down" size={14} color={colors.textTertiary} />
                </TouchableOpacity>
              </View>
              <View style={{ flex: 1 }}><FInput label="First Name *" value={form.first_name} onChange={setF('first_name')} placeholder="First name" /></View>
            </View>
            <FInput label="Last Name *" value={form.last_name} onChange={setF('last_name')} placeholder="Last name" />
            <FInput label="Phone *" value={form.phone} onChange={setF('phone')} keyboardType="phone-pad" placeholder="10-digit mobile" />
            <FInput label="Email *" value={form.email} onChange={setF('email')} keyboardType="email-address" placeholder="name@example.com" />

            {/* ── Owner Photo (real upload) ── */}
            <DocUpload label="Owner Photo" value={form.photo_url} onChange={setF('photo_url')} folder="owners/photos" isImage />

            {/* ── Identity ── */}
            <SectionTitle title="Identity" />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><FInput label="PAN Number" value={form.pan_number} onChange={setF('pan_number')} /></View>
              <View style={{ flex: 1 }}><FInput label="Aadhar Number" value={form.aadhar_number} onChange={setF('aadhar_number')} keyboardType="numeric" /></View>
            </View>
            <DocUpload label="ID Proof Document" value={form.id_proof_url} onChange={setF('id_proof_url')} folder="owners/id-proofs" />

            {/* ── Address (State → City dependent) ── */}
            <SectionTitle title="Address" />
            <FInput label="Address" value={form.address} onChange={setF('address')} />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <SearchablePicker label="State" value={form.state} options={INDIAN_STATES}
                  onChange={(v) => setForm((p: any) => ({ ...p, state: v, city: '' }))} placeholder="Select state" />
              </View>
              <View style={{ flex: 1 }}>
                <SearchablePicker label="City" value={form.city} options={form.state ? (INDIAN_CITIES[form.state] || []) : []}
                  onChange={setF('city')} placeholder={form.state ? 'Select city' : 'Pick state first'} disabled={!form.state} />
              </View>
            </View>
            <FInput label="Pincode" value={form.pincode} onChange={setF('pincode')} keyboardType="numeric" />

            {/* ── Bank Details ── */}
            <SectionTitle title="Bank Details" />
            <FInput label="Bank Name" value={form.bank_name} onChange={setF('bank_name')} />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><FInput label="Account Number" value={form.bank_account_number} onChange={setF('bank_account_number')} keyboardType="numeric" /></View>
              <View style={{ flex: 1 }}><FInput label="IFSC" value={form.bank_ifsc} onChange={setF('bank_ifsc')} /></View>
            </View>

            {/* ── GST ── */}
            <SectionTitle title="GST" />
            <FInput label="GST Number" value={form.gst_number} onChange={setF('gst_number')} />

            <SectionTitle title="Notes" />
            <FInput label="" value={form.notes} onChange={setF('notes')} placeholder="Any notes about this owner…" multiline />

            <TouchableOpacity onPress={handleSave} disabled={saving}
              style={{ backgroundColor: '#2563EB', borderRadius: 14, padding: 15, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 8, opacity: saving ? 0.6 : 1 }}>
              {saving ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />}
              <Text style={{ fontSize: 15, fontWeight: '800', color: '#fff' }}>{saving ? 'Saving…' : mode === 'add' ? 'Create Owner' : 'Save Changes'}</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </GlassBackground>
    </Modal>
  );
}

// ─── Record / Edit Payment Modal ────────────────────────────────────────────────
function PaymentModal({ payment, mode, onClose, onSaved }: {
  payment: any; mode: 'record' | 'edit'; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState<any>(() => ({
    escalated_amount: String(payment.escalated_amount || ''),
    due_date:         payment.due_date || '',
    actual_due_date:  payment.actual_due_date || payment.due_date || '',
    status:           payment.status || 'pending',
    paid_date:        payment.paid_date || new Date().toISOString().split('T')[0],
    payment_mode:     payment.payment_mode || 'transfer',
    reference_number: payment.reference_number || '',
    notes:            payment.notes || '',
  }));
  const [saving, setSaving] = useState(false);
  const setF = (k: string) => (v: any) => setForm((p: any) => ({ ...p, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    try {
      if (mode === 'record') {
        if (!form.paid_date) { Alert.alert('Required', 'Payment date is required'); setSaving(false); return; }
        await convexClient.action(owners.recordOwnerPayment, {
          id: payment.id,
          data: { paid_date: form.paid_date, payment_mode: form.payment_mode, reference_number: form.reference_number, notes: form.notes },
        });
      } else {
        await convexClient.action(owners.editOwnerPayment, { id: payment.id, data: form });
      }
      onSaved();
    } catch (e: any) { Alert.alert('Error', e.message); }
    setSaving(false);
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={S.modalHeader}>
            <Text style={S.modalTitle}>{mode === 'record' ? 'Mark as Paid' : 'Edit Payment'}</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close-circle" size={28} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
            <View style={{ backgroundColor: '#F8FAFC', borderRadius: 10, padding: 12, marginBottom: 16 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#111827' }}>{fmtMonth(payment.payment_month)}</Text>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>Due {fmtDate(payment.due_date)} · {fmtAmt(Number(payment.escalated_amount))}</Text>
            </View>

            {mode === 'edit' && (
              <>
                <FInput label="Amount Due (₹)" value={form.escalated_amount} onChange={setF('escalated_amount')} keyboardType="numeric" />
                <FDate label="Due Date" value={form.due_date} onChange={setF('due_date')} />
                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary, marginBottom: 8 }}>Status</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                  {['pending', 'paid'].map(st => (
                    <TouchableOpacity key={st} onPress={() => setF('status')(st)}
                      style={{ flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: form.status === st ? '#2563EB' : 'rgba(37,99,235,0.06)', borderWidth: 1.5, borderColor: form.status === st ? '#2563EB' : 'rgba(37,99,235,0.2)' }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: form.status === st ? '#fff' : '#2563EB', textTransform: 'capitalize' }}>{st}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}

            {(mode === 'record' || form.status === 'paid') && (
              <>
                <FDate label="Payment Date" value={form.paid_date} onChange={setF('paid_date')} />
                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary, marginBottom: 8 }}>Payment Mode</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 14 }}>
                  {PAYMENT_MODES.map(m => (
                    <TouchableOpacity key={m.key} onPress={() => setF('payment_mode')(m.key)}
                      style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99, backgroundColor: form.payment_mode === m.key ? '#2563EB' : 'rgba(37,99,235,0.06)', borderWidth: 1.5, borderColor: form.payment_mode === m.key ? '#2563EB' : 'rgba(37,99,235,0.2)' }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: form.payment_mode === m.key ? '#fff' : '#2563EB' }}>{m.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <FInput label="Reference Number" value={form.reference_number} onChange={setF('reference_number')} placeholder="Txn / cheque ref" />
              </>
            )}

            <FInput label="Notes" value={form.notes} onChange={setF('notes')} multiline />

            <TouchableOpacity onPress={handleSave} disabled={saving}
              style={{ backgroundColor: '#16A34A', borderRadius: 14, padding: 15, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8, opacity: saving ? 0.6 : 1 }}>
              {saving ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />}
              <Text style={{ fontSize: 15, fontWeight: '800', color: '#fff' }}>{saving ? 'Saving…' : mode === 'record' ? 'Record Payment' : 'Save Payment'}</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </GlassBackground>
    </Modal>
  );
}

// ─── Contract Detail (payment schedule) Modal ──────────────────────────────────
function ContractDetailModal({ contract, onClose }: { contract: any; onClose: () => void }) {
  const [payments, setPayments] = useState<any[]>([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');
  const [payTarget, setPayTarget] = useState<{ p: any; mode: 'record' | 'edit' } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    convexClient.action(owners.getContractPayments, { contractId: contract.id })
      .then((d: any) => setPayments(d || []))
      .catch(() => setPayments([]))
      .finally(() => setLoading(false));
  }, [contract.id]);

  useEffect(() => { load(); }, [load]);

  const filtered = search
    ? payments.filter((p: any) => fmtMonth(p.payment_month).toLowerCase().includes(search.toLowerCase()))
    : payments;

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={S.modalHeader}>
            <View style={{ flex: 1 }}>
              <Text style={S.modalTitle}>{contract.propertyName || 'Contract'} {contract.apartmentCode ? `· ${contract.apartmentCode}` : ''}</Text>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>{fmtAmt(contract.monthlyRent)}/mo · {(contract.contractType || '').replace(/_/g, ' ')}</Text>
            </View>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close-circle" size={28} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>

          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 12, borderWidth: 1, borderColor: '#E5E7EB', paddingHorizontal: 12, height: 42 }}>
              <Ionicons name="search-outline" size={17} color={colors.textTertiary} style={{ marginRight: 8 }} />
              <TextInput style={{ flex: 1, fontSize: 14, color: '#111827' }} value={search} onChangeText={setSearch} placeholder="Search payments by month…" placeholderTextColor={colors.textTertiary} />
            </View>
          </View>

          {loading ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color="#2563EB" size="large" /></View>
          ) : (
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
              {/* Agreement document */}
              {contract.agreementUrl ? (
                <TouchableOpacity
                  onPress={() => Linking.openURL(contract.agreementUrl).catch(() => {})}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#EFF6FF', borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#E5E7EB' }}
                >
                  <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(37,99,235,0.12)', alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="document-text-outline" size={18} color="#2563EB" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#111827' }}>Agreement Copy</Text>
                    <Text style={{ fontSize: 11, color: colors.textSecondary }}>Tap to view document</Text>
                  </View>
                  <Ionicons name="open-outline" size={16} color="#2563EB" />
                </TouchableOpacity>
              ) : null}

              {filtered.length === 0 ? (
                <EmptyState title="No Payments" subtitle="No payment schedule generated for this contract" icon="cash-outline" />
              ) : filtered.map((p: any) => (
                <View key={p.id} style={{ backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#E5E7EB' }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827' }}>{fmtMonth(p.payment_month)}</Text>
                    <PaymentStatusBadge p={p} />
                  </View>
                  <View style={{ flexDirection: 'row', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
                    <View><Text style={S.colLbl}>BILL DATE</Text><Text style={S.colVal}>{fmtDate(p.bill_date || p.due_date)}</Text></View>
                    <View><Text style={S.colLbl}>DUE DATE</Text><Text style={S.colVal}>{fmtDate(p.due_date)}</Text></View>
                    <View><Text style={S.colLbl}>AMOUNT</Text><Text style={[S.colVal, { color: '#2563EB', fontWeight: '800' }]}>{fmtAmt(Number(p.escalated_amount))}</Text></View>
                    {p.status === 'paid' && <View><Text style={S.colLbl}>PAID</Text><Text style={S.colVal}>{fmtDate(p.paid_date)}</Text></View>}
                    {p.payment_mode && <View><Text style={S.colLbl}>MODE</Text><Text style={[S.colVal, { textTransform: 'capitalize' }]}>{p.payment_mode}</Text></View>}
                  </View>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {p.status !== 'paid' && (
                      <TouchableOpacity onPress={() => setPayTarget({ p, mode: 'record' })}
                        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 8, backgroundColor: '#DCFCE7', borderRadius: 8 }}>
                        <Ionicons name="checkmark-circle-outline" size={15} color="#16A34A" />
                        <Text style={{ fontSize: 12, fontWeight: '700', color: '#16A34A' }}>Mark Paid</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity onPress={() => setPayTarget({ p, mode: 'edit' })}
                      style={{ flex: p.status === 'paid' ? 1 : 0.6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 8, backgroundColor: '#EFF6FF', borderRadius: 8 }}>
                      <Ionicons name="create-outline" size={15} color="#2563EB" />
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>Edit</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </ScrollView>
          )}

          {payTarget && (
            <PaymentModal
              payment={payTarget.p}
              mode={payTarget.mode}
              onClose={() => setPayTarget(null)}
              onSaved={() => { setPayTarget(null); load(); }}
            />
          )}
        </SafeAreaView>
      </GlassBackground>
    </Modal>
  );
}

// ─── Owner Detail Modal (KYC / Contracts / All Payments) ───────────────────────
function OwnerDetailModal({ ownerId, onClose, onChanged }: { ownerId: string; onClose: () => void; onChanged: () => void }) {
  const [data, setData]           = useState<any>(null);
  const [loading, setLoading]     = useState(true);
  const [tab, setTab]             = useState<'kyc' | 'contracts' | 'payments'>('kyc');
  const [showContractForm, setShowContractForm] = useState(false);
  const [showEditOwner, setShowEditOwner]        = useState(false);
  const [contractSearch, setContractSearch]      = useState('');
  const [editContract, setEditContract]          = useState<any>(null);
  const [contractDetail, setContractDetail]      = useState<any>(null);
  // All payments
  const [allPayments, setAllPayments]   = useState<any[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [period, setPeriod]             = useState('current_fy');

  const loadDetail = useCallback(() => {
    convexClient.action(owners.getOwnerDetail, { ownerId })
      .then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [ownerId]);

  const loadPayments = useCallback(() => {
    setPaymentsLoading(true);
    convexClient.action(owners.listOwnerPaymentsConsolidated, { ownerId })
      .then((d: any) => setAllPayments(d || []))
      .catch(() => setAllPayments([]))
      .finally(() => setPaymentsLoading(false));
  }, [ownerId]);

  useEffect(() => { loadDetail(); }, [loadDetail]);
  useEffect(() => { if (tab === 'payments') loadPayments(); }, [tab, loadPayments]);

  const owner = data?.owner;
  const isActive = (owner?.status ?? 'active') !== 'inactive';

  const toggleStatus = () => {
    Alert.alert(
      isActive ? 'Deactivate Owner' : 'Activate Owner',
      `${isActive ? 'Deactivate' : 'Activate'} ${owner?.name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: isActive ? 'Deactivate' : 'Activate', style: isActive ? 'destructive' : 'default', onPress: async () => {
          try {
            await convexClient.action(owners.toggleOwnerStatus, { id: ownerId, currentStatus: isActive ? 'active' : 'inactive' });
            loadDetail(); onChanged();
          } catch (e: any) { Alert.alert('Error', e.message); }
        }},
      ]
    );
  };

  const handleDeleteContract = (c: any) => {
    Alert.alert('Delete Contract', `Delete this ${(c.contractType || '').replace(/_/g, ' ')} contract? Payment records will also be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try { await convexClient.action(owners.deleteContract, { id: c.id }); loadDetail(); }
        catch (e: any) { Alert.alert('Error', e.message); }
      }},
    ]);
  };

  const regenerate = () => {
    Alert.alert('Regenerate Bills', `Regenerate all payment schedules for ${owner?.name}? Paid records are preserved.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Regenerate', onPress: async () => {
        try {
          await convexClient.action(owners.regenerateOwnerBills, { ownerId, mode: 'all' });
          Alert.alert('Done', 'Bills regenerated.');
          if (tab === 'payments') loadPayments();
        } catch (e: any) { Alert.alert('Error', e.message); }
      }},
    ]);
  };

  // CSV export via Share
  const exportPayments = async () => {
    const { from, to } = periodRange(period);
    const rows = allPayments.filter((p: any) => {
      const d = p.bill_date || p.due_date || p.payment_month;
      if (!d) return false;
      const dt = new Date(d.length === 7 ? d + '-01' : d);
      return dt >= from && dt <= to;
    });
    if (rows.length === 0) { Alert.alert('Nothing to export', 'No payments in the selected period'); return; }
    const header = 'Month,Bill Date,Due Date,Apartment,Type,Base Amount,Amount,Status,Paid Date,Mode,Reference';
    const lines = rows.map((p: any) => [
      fmtMonth(p.payment_month), p.bill_date || '', p.due_date || '',
      p.apartments?.apartment_code || '', (p.owner_contracts?.contract_type || '').replace(/_/g, ' '),
      p.base_amount || 0, p.escalated_amount || 0, p.status || '',
      p.paid_date || '', p.payment_mode || '', p.reference_number || '',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const csv = [header, ...lines].join('\n');
    try {
      await Share.share({ message: csv, title: `${owner?.name} — Owner Payments` });
    } catch (_) { /* user cancelled */ }
  };

  const filteredContracts = (data?.contracts || []).filter((c: any) =>
    !contractSearch ||
    (c.propertyName || '').toLowerCase().includes(contractSearch.toLowerCase()) ||
    (c.apartmentCode || '').toLowerCase().includes(contractSearch.toLowerCase())
  );

  const { from, to } = periodRange(period);
  const filteredAllPayments = allPayments.filter((p: any) => {
    const d = p.bill_date || p.due_date || p.payment_month;
    if (!d) return false;
    const dt = new Date(d.length === 7 ? d + '-01' : d);
    return dt >= from && dt <= to;
  });
  const totalPaid    = filteredAllPayments.filter((p: any) => p.status === 'paid').reduce((s: number, p: any) => s + Number(p.escalated_amount || 0), 0);
  const totalPending = filteredAllPayments.filter((p: any) => p.status !== 'paid').reduce((s: number, p: any) => s + Number(p.escalated_amount || 0), 0);

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 18, fontWeight: '800', color: '#111827' }} numberOfLines={1}>{owner?.name || 'Owner'}</Text>
                <View style={{ backgroundColor: isActive ? '#DCFCE7' : '#F1F5F9', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: isActive ? '#16A34A' : '#64748B' }}>{isActive ? 'Active' : 'Inactive'}</Text>
                </View>
              </View>
              {owner?.phone ? <Text style={{ fontSize: 12, color: colors.textSecondary }}>{owner.phone}{owner.email ? ` · ${owner.email}` : ''}</Text> : null}
            </View>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close-circle" size={28} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color="#2563EB" size="large" /></View>
          ) : !data ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.textTertiary }}>Failed to load</Text></View>
          ) : (
            <>
              {/* Action buttons */}
              <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}>
                <TouchableOpacity onPress={() => setShowEditOwner(true)}
                  style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, backgroundColor: '#EFF6FF', borderRadius: 10 }}>
                  <Ionicons name="pencil" size={14} color="#2563EB" />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={toggleStatus}
                  style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, backgroundColor: isActive ? 'rgba(220,38,38,0.08)' : 'rgba(22,163,74,0.08)', borderRadius: 10 }}>
                  <Ionicons name="power" size={14} color={isActive ? '#DC2626' : '#16A34A'} />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: isActive ? '#DC2626' : '#16A34A' }}>{isActive ? 'Deactivate' : 'Activate'}</Text>
                </TouchableOpacity>
              </View>

              {/* Tab bar */}
              <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border }}>
                {([['kyc', 'KYC'], ['contracts', `Contracts (${data.contracts?.length || 0})`], ['payments', 'Payments']] as const).map(([key, label]) => (
                  <TouchableOpacity key={key} onPress={() => setTab(key as any)}
                    style={{ flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: tab === key ? '#2563EB' : 'transparent' }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: tab === key ? '#2563EB' : colors.textSecondary }}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* ── KYC tab ── */}
              {tab === 'kyc' && (
                <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
                  {owner.photoUrl ? (
                    <View style={{ alignItems: 'center', marginBottom: 8 }}>
                      <TouchableOpacity onPress={() => Linking.openURL(owner.photoUrl).catch(() => {})}>
                        <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: 2, borderColor: '#E5E7EB' }}>
                          <Image source={{ uri: owner.photoUrl }} style={{ width: 80, height: 80 }} resizeMode="cover" />
                        </View>
                        <Text style={{ fontSize: 10, color: '#2563EB', textAlign: 'center', marginTop: 4, fontWeight: '600' }}>View Photo</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                  <SectionTitle title="Identity" />
                  {[['PAN', owner.panNumber], ['Aadhaar', owner.aadharNumber], ['GST', owner.gstNumber]].map(([l, val]) => (
                    <View key={l as string} style={S.kycRow}>
                      <Text style={S.kycLbl}>{l}</Text>
                      <Text style={S.kycVal}>{(val as string) || '—'}</Text>
                    </View>
                  ))}
                  {/* ID Proof document */}
                  <View style={S.kycRow}>
                    <Text style={S.kycLbl}>ID Proof</Text>
                    {owner.idProofUrl ? (
                      <TouchableOpacity onPress={() => Linking.openURL(owner.idProofUrl).catch(() => {})} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 }}>
                        <Ionicons name="document-text-outline" size={14} color="#2563EB" />
                        <Text style={{ fontSize: 13, fontWeight: '600', color: '#2563EB', textDecorationLine: 'underline' }}>View document</Text>
                      </TouchableOpacity>
                    ) : (
                      <Text style={S.kycVal}>—</Text>
                    )}
                  </View>
                  <SectionTitle title="Address" />
                  <View style={S.kycRow}>
                    <Text style={S.kycLbl}>Address</Text>
                    <Text style={S.kycVal}>{[owner.address, owner.city, owner.state, owner.pincode].filter(Boolean).join(', ') || '—'}</Text>
                  </View>
                  <SectionTitle title="Bank Details" />
                  {[['Bank', owner.bankName], ['Account', owner.bankAccountNumber], ['IFSC', owner.bankIfsc]].map(([l, val]) => (
                    <View key={l as string} style={S.kycRow}>
                      <Text style={S.kycLbl}>{l}</Text>
                      <Text style={S.kycVal}>{(val as string) || '—'}</Text>
                    </View>
                  ))}
                  {owner.notes ? (
                    <>
                      <SectionTitle title="Notes" />
                      <View style={{ backgroundColor: '#F8FAFC', borderRadius: 10, padding: 12 }}>
                        <Text style={{ fontSize: 13, color: '#111827', lineHeight: 20 }}>{owner.notes}</Text>
                      </View>
                    </>
                  ) : null}
                </ScrollView>
              )}

              {/* ── Contracts tab ── */}
              {tab === 'contracts' && (
                <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 12, borderWidth: 1, borderColor: '#E5E7EB', paddingHorizontal: 12, height: 40 }}>
                      <Ionicons name="search-outline" size={16} color={colors.textTertiary} style={{ marginRight: 6 }} />
                      <TextInput style={{ flex: 1, fontSize: 13, color: '#111827' }} value={contractSearch} onChangeText={setContractSearch} placeholder="Search…" placeholderTextColor={colors.textTertiary} />
                    </View>
                    <TouchableOpacity onPress={() => setShowContractForm(true)}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#2563EB', borderRadius: 10, paddingHorizontal: 12 }}>
                      <Ionicons name="add" size={16} color="#fff" />
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#fff' }}>Add</Text>
                    </TouchableOpacity>
                  </View>

                  {filteredContracts.length === 0 ? (
                    <EmptyState title="No Contracts" subtitle="Add a contract for this owner" icon="document-outline" />
                  ) : filteredContracts.map((c: any) => (
                    <TouchableOpacity key={c.id} activeOpacity={0.85} onPress={() => setContractDetail(c)}
                      style={{ backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: contractColor(c.status) + '30' }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                          <ContractBadge type={c.contractType} />
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: contractColor(c.status) }} />
                            <Text style={{ fontSize: 11, fontWeight: '700', color: contractColor(c.status) }}>{c.status}</Text>
                          </View>
                        </View>
                        <Text style={{ fontSize: 16, fontWeight: '900', color: '#2563EB' }}>{fmtAmt(c.monthlyRent)}/mo</Text>
                      </View>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: '#111827', marginBottom: 4 }}>
                        {c.propertyName || '—'}{c.apartmentCode ? ` · ${c.apartmentCode}` : ''}{c.propertyCity ? ` · ${c.propertyCity}` : ''}
                      </Text>
                      <View style={{ flexDirection: 'row', gap: 16, marginBottom: 10 }}>
                        <View><Text style={S.colLbl}>START</Text><Text style={S.colVal}>{fmtDate(c.startDate)}</Text></View>
                        <View><Text style={S.colLbl}>END</Text><Text style={S.colVal}>{fmtDate(c.endDate)}</Text></View>
                        {c.securityDeposit > 0 && <View><Text style={S.colLbl}>DEPOSIT</Text><Text style={S.colVal}>{fmtAmt(c.securityDeposit)}</Text></View>}
                      </View>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 8, backgroundColor: '#EFF6FF', borderRadius: 8 }}>
                          <Ionicons name="receipt-outline" size={14} color="#2563EB" />
                          <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>View Payments</Text>
                        </View>
                        <TouchableOpacity onPress={() => setEditContract(c)}
                          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 14, backgroundColor: '#EFF6FF', borderRadius: 8 }}>
                          <Ionicons name="create-outline" size={14} color="#2563EB" />
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => handleDeleteContract(c)}
                          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 14, backgroundColor: 'rgba(220,38,38,0.08)', borderRadius: 8 }}>
                          <Ionicons name="trash-outline" size={14} color="#DC2626" />
                        </TouchableOpacity>
                      </View>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}

              {/* ── All Payments tab ── */}
              {tab === 'payments' && (
                <View style={{ flex: 1 }}>
                  {/* Period + actions */}
                  <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                      {PERIODS.map(p => (
                        <TouchableOpacity key={p.key} onPress={() => setPeriod(p.key)}
                          style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 99, backgroundColor: period === p.key ? '#2563EB' : 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: period === p.key ? '#2563EB' : 'rgba(37,99,235,0.2)' }}>
                          <Text style={{ fontSize: 12, fontWeight: '700', color: period === p.key ? '#fff' : '#2563EB' }}>{p.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                    {/* Summary + actions */}
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <View style={{ flex: 1, backgroundColor: '#DCFCE7', borderRadius: 10, padding: 10 }}>
                        <Text style={{ fontSize: 9, color: '#16A34A', fontWeight: '700' }}>PAID</Text>
                        <Text style={{ fontSize: 15, fontWeight: '900', color: '#16A34A' }}>{fmtAmt(totalPaid)}</Text>
                      </View>
                      <View style={{ flex: 1, backgroundColor: '#FEF9C3', borderRadius: 10, padding: 10 }}>
                        <Text style={{ fontSize: 9, color: '#A16207', fontWeight: '700' }}>PENDING</Text>
                        <Text style={{ fontSize: 15, fontWeight: '900', color: '#A16207' }}>{fmtAmt(totalPending)}</Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4 }}>
                      <TouchableOpacity onPress={exportPayments}
                        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, backgroundColor: '#EFF6FF', borderRadius: 10 }}>
                        <Ionicons name="download-outline" size={14} color="#2563EB" />
                        <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>Export CSV</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={regenerate}
                        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, backgroundColor: 'rgba(2,132,199,0.08)', borderRadius: 10 }}>
                        <Ionicons name="refresh-outline" size={14} color="#0284C7" />
                        <Text style={{ fontSize: 12, fontWeight: '700', color: '#0284C7' }}>Regenerate</Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  {paymentsLoading ? (
                    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color="#2563EB" /></View>
                  ) : (
                    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 8, paddingBottom: 40 }}>
                      {filteredAllPayments.length === 0 ? (
                        <EmptyState title="No Payments" subtitle="No payments in this period" icon="cash-outline" />
                      ) : filteredAllPayments.map((p: any) => (
                        <View key={p.id} style={{ backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#E5E7EB' }}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <View>
                              <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827' }}>{fmtMonth(p.payment_month)}</Text>
                              <Text style={{ fontSize: 11, color: colors.textSecondary }}>{p.apartments?.apartment_code || '—'}</Text>
                            </View>
                            <View style={{ alignItems: 'flex-end', gap: 4 }}>
                              <Text style={{ fontSize: 15, fontWeight: '900', color: '#2563EB' }}>{fmtAmt(Number(p.escalated_amount))}</Text>
                              <PaymentStatusBadge p={p} />
                            </View>
                          </View>
                          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                            {p.status !== 'paid' && (
                              <TouchableOpacity onPress={() => setContractDetail({ id: p.contract_id, propertyName: p.apartments?.apartment_code, monthlyRent: Number(p.escalated_amount), contractType: p.owner_contracts?.contract_type })}
                                style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                <Ionicons name="open-outline" size={13} color="#2563EB" />
                                <Text style={{ fontSize: 11, fontWeight: '600', color: '#2563EB' }}>Open contract to record</Text>
                              </TouchableOpacity>
                            )}
                            {p.status === 'paid' && p.paid_date && (
                              <Text style={{ fontSize: 11, color: colors.textTertiary }}>Paid {fmtDate(p.paid_date)} · {p.payment_mode || '—'}</Text>
                            )}
                          </View>
                        </View>
                      ))}
                    </ScrollView>
                  )}
                </View>
              )}
            </>
          )}

          {/* Sub-modals */}
          {showContractForm && (
            <AddContractModal
              ownerId={ownerId}
              ownerName={owner?.name || ''}
              ownerGst={owner?.gstNumber || ''}
              onClose={() => setShowContractForm(false)}
              onSaved={() => { setShowContractForm(false); loadDetail(); }}
            />
          )}
          {editContract && (
            <AddContractModal
              ownerId={ownerId}
              ownerName={owner?.name || ''}
              ownerGst={owner?.gstNumber || ''}
              editTarget={editContract}
              onClose={() => setEditContract(null)}
              onSaved={() => { setEditContract(null); loadDetail(); }}
            />
          )}
          {contractDetail && (
            <ContractDetailModal contract={contractDetail} onClose={() => { setContractDetail(null); if (tab === 'payments') loadPayments(); }} />
          )}
          {showEditOwner && owner && (
            <OwnerFormModal mode="edit" initial={{ ...owner, full_name: owner.name }} onClose={() => setShowEditOwner(false)} onSaved={() => { setShowEditOwner(false); loadDetail(); onChanged(); }} />
          )}
        </SafeAreaView>
      </GlassBackground>
    </Modal>
  );
}

// ─── ADD / EDIT CONTRACT MODAL ──────────────────────────────────────────────────
function AddContractModal({ ownerId, ownerName, ownerGst, editTarget, onClose, onSaved }: {
  ownerId: string; ownerName: string; ownerGst: string; editTarget?: any;
  onClose: () => void; onSaved: () => void;
}) {
  const isEdit = !!editTarget;
  const EMPTY = {
    apartment_ids: [] as string[],
    contract_type: 'lease', start_date: '', end_date: '',
    monthly_rent: '', revenue_share_percentage: '', security_deposit: '',
    lock_in_months: '', escalation_percentage: '', escalation_interval_months: '',
    payment_due_day: '1', rent_paid_in_advance: false, rent_includes_gst: false,
    notes: '', payment_schedule: 'monthly', renewal_periods: '', agreement_url: '',
  };
  const [form, setForm] = useState<any>(() => {
    if (isEdit) {
      // getOwnerDetail now returns the full contract terms, so every field is
      // pre-populated and none get nulled on save.
      return {
        ...EMPTY,
        contract_type: editTarget.contractType || 'lease',
        start_date: editTarget.startDate || '',
        end_date: editTarget.endDate || '',
        monthly_rent: editTarget.monthlyRent ? String(editTarget.monthlyRent) : '',
        revenue_share_percentage: editTarget.revenueSharePercentage != null ? String(editTarget.revenueSharePercentage) : '',
        security_deposit: editTarget.securityDeposit ? String(editTarget.securityDeposit) : '',
        lock_in_months: editTarget.lockInMonths != null ? String(editTarget.lockInMonths) : '',
        escalation_percentage: editTarget.escalationPercentage != null ? String(editTarget.escalationPercentage) : '',
        escalation_interval_months: editTarget.escalationIntervalMonths != null ? String(editTarget.escalationIntervalMonths) : '',
        payment_due_day: editTarget.paymentDueDay ? String(editTarget.paymentDueDay) : '1',
        rent_paid_in_advance: !!editTarget.rentPaidInAdvance,
        rent_includes_gst: !!editTarget.rentIncludesGst,
        payment_schedule: editTarget.paymentSchedule || 'monthly',
        renewal_periods: editTarget.renewalPeriods != null ? String(editTarget.renewalPeriods) : '',
        agreement_url: editTarget.agreementUrl || '',
        notes: editTarget.notes || '',
      };
    }
    return { ...EMPTY };
  });
  const [apts, setApts] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadingApts, setLoadingApts] = useState(!isEdit);
  const setF = (k: string) => (v: any) => setForm((p: any) => ({ ...p, [k]: v }));

  useEffect(() => {
    if (isEdit) return;
    convexClient.action(owners.listApartmentsForContract, {})
      .then(setApts).catch(() => setApts([])).finally(() => setLoadingApts(false));
  }, [isEdit]);

  const hasMonthlyRent  = parseFloat(form.monthly_rent) > 0;
  const hasRevenueShare = parseFloat(form.revenue_share_percentage) > 0;

  const CONTRACT_TYPES = [
    { key: 'lease', label: 'Lease' }, { key: 'rental', label: 'Rental' },
    { key: 'revenue_sharing', label: 'Revenue Sharing' }, { key: 'profit_sharing', label: 'Profit Sharing' },
  ];
  const SCHEDULES = [
    { key: 'monthly', label: 'Monthly' }, { key: 'quarterly', label: 'Quarterly' },
    { key: 'half_yearly', label: 'Half-Yearly' }, { key: 'yearly', label: 'Yearly' },
  ];

  const handleSave = async () => {
    if (!isEdit && form.apartment_ids.length === 0) { Alert.alert('Required', 'Select at least one apartment.'); return; }
    if (!form.start_date) { Alert.alert('Required', 'Start date is required.'); return; }
    if (!form.monthly_rent && !form.revenue_share_percentage) { Alert.alert('Required', 'Enter monthly rent or revenue share %.'); return; }
    setSaving(true);
    try {
      const gstInfo = ownerGst?.trim() ? (form.rent_includes_gst ? 'Rent Includes GST' : 'Rent Excludes GST') : 'GST under RCM';
      if (isEdit) {
        await convexClient.action(owners.updateContract, { id: editTarget.id, data: { ...form, gst_info: gstInfo } });
        Alert.alert('Success', 'Contract updated.');
      } else {
        await convexClient.action(owners.createOwnerContract, { ownerId, data: { ...form, gst_info: gstInfo } });
        Alert.alert('Success', `Contract created for ${form.apartment_ids.length} apartment(s).`);
      }
      onSaved();
    } catch (e: any) { Alert.alert('Error', e.message); }
    setSaving(false);
  };

  const FL = ({ text }: { text: string }) => (
    <Text style={{ fontSize: 10, fontWeight: '800', color: '#2563EB', letterSpacing: 0.5, marginTop: 18, marginBottom: 10, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: 'rgba(37,99,235,0.12)' }}>{text.toUpperCase()}</Text>
  );
  const PillRow = ({ options, value, onChange }: any) => (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 14 }}>
      {options.map((o: any) => {
        const active = value === o.key;
        return (
          <TouchableOpacity key={o.key} onPress={() => onChange(o.key)}
            style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 99, backgroundColor: active ? '#2563EB' : 'rgba(37,99,235,0.06)', borderWidth: 1.5, borderColor: active ? '#2563EB' : 'rgba(37,99,235,0.2)' }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : '#2563EB' }}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={S.modalHeader}>
            <View>
              <Text style={S.modalTitle}>{isEdit ? 'Edit Contract' : 'Add Contract'}</Text>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>{ownerName}</Text>
            </View>
            <TouchableOpacity onPress={onClose}><Ionicons name="close-circle" size={28} color={colors.textTertiary} /></TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
            <FL text="Contract Identity" />
            <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary, marginBottom: 8 }}>Contract Type *</Text>
            <PillRow options={CONTRACT_TYPES} value={form.contract_type} onChange={setF('contract_type')} />

            {/* Apartments (add mode only) */}
            {!isEdit && (
              <>
                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary, marginBottom: 6 }}>
                  Apartments * <Text style={{ fontWeight: '400', color: colors.textTertiary }}>(select one or more)</Text>
                </Text>
                {loadingApts ? (
                  <View style={{ alignItems: 'center', padding: 16 }}><ActivityIndicator color="#2563EB" /></View>
                ) : (
                  <View style={{ backgroundColor: colors.surface, borderWidth: 1.5, borderColor: '#E5E7EB', borderRadius: 12, overflow: 'hidden', marginBottom: 12 }}>
                    {apts.filter(a => !a.hasActiveContract).length === 0 ? (
                      <View style={{ padding: 16, alignItems: 'center' }}><Text style={{ fontSize: 12, color: colors.textTertiary }}>All apartments have active contracts</Text></View>
                    ) : apts.filter(a => !a.hasActiveContract).map((a, idx) => {
                      const checked = form.apartment_ids.includes(a.id);
                      return (
                        <TouchableOpacity key={a.id}
                          onPress={() => setF('apartment_ids')(checked ? form.apartment_ids.filter((id: string) => id !== a.id) : [...form.apartment_ids, a.id])}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderTopWidth: idx > 0 ? 0.5 : 0, borderTopColor: colors.border, backgroundColor: checked ? 'rgba(37,99,235,0.06)' : 'transparent' }}>
                          <View style={{ width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderColor: checked ? '#2563EB' : colors.border, backgroundColor: checked ? '#2563EB' : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                            {checked && <Ionicons name="checkmark" size={11} color="#fff" />}
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 13, fontWeight: '600', color: '#111827' }}>{a.propertyName} — {a.apartmentCode}</Text>
                            <Text style={{ fontSize: 10, color: colors.textTertiary }}>{a.status}</Text>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
                {form.apartment_ids.length > 0 && (
                  <View style={{ backgroundColor: '#EFF6FF', borderRadius: 8, padding: 8, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="checkmark-circle" size={14} color="#2563EB" />
                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>{form.apartment_ids.length} apartment(s) selected</Text>
                  </View>
                )}
              </>
            )}

            <FL text="Financials" />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <FInput label="Monthly / Base (₹)" value={form.monthly_rent}
                  onChange={(v: string) => setForm((p: any) => ({ ...p, monthly_rent: v, ...(parseFloat(v) > 0 ? { revenue_share_percentage: '' } : {}) }))} keyboardType="numeric" />
              </View>
              <View style={{ flex: 1 }}>
                <FInput label="Revenue Share (%)" value={form.revenue_share_percentage}
                  onChange={(v: string) => setForm((p: any) => ({ ...p, revenue_share_percentage: v, ...(parseFloat(v) > 0 ? { monthly_rent: '' } : {}) }))} keyboardType="numeric" />
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><FInput label="Security Deposit (₹)" value={form.security_deposit} onChange={setF('security_deposit')} keyboardType="numeric" /></View>
              <View style={{ flex: 1 }}><FInput label="Lock-in (months)" value={form.lock_in_months} onChange={setF('lock_in_months')} keyboardType="numeric" /></View>
            </View>
            <FInput label="Payment Due Day (1–28)" value={form.payment_due_day} onChange={setF('payment_due_day')} keyboardType="numeric" placeholder="1" />

            <TouchableOpacity onPress={() => setF('rent_paid_in_advance')(!form.rent_paid_in_advance)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <View style={{ width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: form.rent_paid_in_advance ? '#2563EB' : colors.border, backgroundColor: form.rent_paid_in_advance ? '#2563EB' : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                {form.rent_paid_in_advance && <Ionicons name="checkmark" size={12} color="#fff" />}
              </View>
              <Text style={{ fontSize: 13, color: '#111827', fontWeight: '600' }}>Rent Paid in Advance</Text>
            </TouchableOpacity>

            {ownerGst?.trim() ? (
              <TouchableOpacity onPress={() => setF('rent_includes_gst')(!form.rent_includes_gst)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <View style={{ width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: form.rent_includes_gst ? '#16A34A' : colors.border, backgroundColor: form.rent_includes_gst ? '#16A34A' : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                  {form.rent_includes_gst && <Ionicons name="checkmark" size={12} color="#fff" />}
                </View>
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#16A34A' }}>Rent includes GST</Text>
              </TouchableOpacity>
            ) : (
              <View style={{ backgroundColor: '#FEF2F2', borderRadius: 8, padding: 10, marginBottom: 14, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="information-circle-outline" size={14} color="#DC2626" />
                <Text style={{ fontSize: 12, color: '#DC2626', fontWeight: '600' }}>GST under RCM — no GST number on owner</Text>
              </View>
            )}

            <FL text="Escalation Terms" />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><FInput label="Escalation (%)" value={form.escalation_percentage} onChange={setF('escalation_percentage')} keyboardType="numeric" placeholder="e.g. 5" /></View>
              <View style={{ flex: 1 }}><FInput label="Frequency (months)" value={form.escalation_interval_months} onChange={setF('escalation_interval_months')} keyboardType="numeric" placeholder="e.g. 12" /></View>
            </View>

            <FL text="Timeline" />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><FDate label="Start Date *" value={form.start_date} onChange={setF('start_date')} /></View>
              <View style={{ flex: 1 }}><FDate label="End Date" value={form.end_date} onChange={setF('end_date')} /></View>
            </View>
            <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary, marginBottom: 8 }}>Payment Schedule</Text>
            <PillRow options={SCHEDULES} value={form.payment_schedule} onChange={setF('payment_schedule')} />

            <FInput label="Renewal Periods" value={form.renewal_periods} onChange={setF('renewal_periods')} keyboardType="numeric" placeholder="e.g. 2" />

            <FL text="Documents" />
            <DocUpload label="Agreement Copy" value={form.agreement_url} onChange={setF('agreement_url')} folder="owners/agreements" />

            <FL text="Notes" />
            <FInput label="" value={form.notes} onChange={setF('notes')} placeholder="Any notes about this contract…" multiline />

            <TouchableOpacity onPress={handleSave} disabled={saving}
              style={{ backgroundColor: '#2563EB', borderRadius: 14, padding: 15, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8, opacity: saving ? 0.6 : 1, marginTop: 8 }}>
              {saving ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />}
              <Text style={{ fontSize: 15, fontWeight: '800', color: '#fff' }}>
                {saving ? 'Saving…' : isEdit ? 'Save Contract' : `Create Contract${form.apartment_ids.length > 1 ? ` (${form.apartment_ids.length})` : ''}`}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </GlassBackground>
    </Modal>
  );
}

// ─── Owner card ───────────────────────────────────────────────────────────────
function OwnerCard({ owner, onPress }: { owner: any; onPress: () => void }) {
  const ac = owner.activeContract;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8} style={S.card}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
          <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            {owner.photoUrl ? (
              <Image source={{ uri: owner.photoUrl }} style={{ width: 38, height: 38 }} resizeMode="cover" />
            ) : (
              <Text style={{ fontSize: 15, fontWeight: '800', color: '#2563EB' }}>{(owner.name || '?')[0].toUpperCase()}</Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '800', color: '#111827' }}>{owner.name}</Text>
            {owner.phone ? <Text style={{ fontSize: 12, color: colors.textSecondary }}>{owner.phone}</Text> : null}
          </View>
        </View>
        <View style={{ backgroundColor: ac ? '#DCFCE7' : '#F1F5F9', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
          <Text style={{ fontSize: 10, fontWeight: '700', color: ac ? '#16A34A' : '#64748B' }}>
            {owner.contractCount} contract{owner.contractCount !== 1 ? 's' : ''}
          </Text>
        </View>
      </View>

      {ac ? (
        <View style={{ backgroundColor: '#F8FAFC', borderRadius: 10, padding: 10, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="home-outline" size={13} color="#2563EB" />
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#111827' }}>
                {ac.propertyName || '—'}{ac.apartmentCode ? ` · ${ac.apartmentCode}` : ''}
              </Text>
            </View>
            <ContractBadge type={ac.contractType} />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontSize: 13, fontWeight: '800', color: '#2563EB' }}>{fmtAmt(ac.monthlyRent)}/mo</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: contractColor(ac.status) }} />
              <Text style={{ fontSize: 11, color: contractColor(ac.status), fontWeight: '600' }}>{ac.status}</Text>
            </View>
          </View>
          <Text style={{ fontSize: 11, color: colors.textTertiary }}>{fmtDate(ac.startDate)} → {fmtDate(ac.endDate)}</Text>
        </View>
      ) : (
        <View style={{ backgroundColor: '#FFF8F0', borderRadius: 8, padding: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Ionicons name="information-circle-outline" size={14} color="#D97706" />
          <Text style={{ fontSize: 11, color: '#D97706' }}>No active contract</Text>
        </View>
      )}

      <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {owner.panNumber    && <Chip label="PAN" />}
        {owner.aadharNumber && <Chip label="Aadhaar" />}
        {owner.bankName     && <Chip label="Bank" />}
        {owner.gstNumber    && <Chip label="GST" />}
        {owner.email        && <Chip label="Email" />}
      </View>
    </TouchableOpacity>
  );
}

// ─── MAIN SCREEN ─────────────────────────────────────────────────────────────
export default function OwnersScreen() {
  const navigation = useNavigation<any>();
  const [ownersList,    setOwnersList]    = useState<any[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [refreshing,    setRefreshing]    = useState(false);
  const [search,        setSearch]        = useState('');
  const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
  const [showAddOwner,  setShowAddOwner]  = useState(false);
  const [propertyFilter, setPropertyFilter] = useState<string>('all');
  const [unallottedOnly, setUnallottedOnly] = useState(false);
  const [properties, setProperties] = useState<any[]>([]);
  const [showPropPicker, setShowPropPicker] = useState(false);

  const fetchOwners = useCallback(async () => {
    try {
      const [data, props] = await Promise.all([
        convexClient.action(owners.listOwners, {}),
        convexClient.action(owners.listPropertiesForFilter, {}).catch(() => []),
      ]);
      setOwnersList(data || []);
      setProperties(props || []);
    } catch (e) {
      console.error('[OwnersScreen] fetchOwners error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchOwners(); }, [fetchOwners]));
  const onRefresh = () => { setRefreshing(true); fetchOwners(); };

  let filtered = ownersList;
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(o =>
      o.name.toLowerCase().includes(q) ||
      (o.phone || '').includes(q) ||
      (o.email || '').toLowerCase().includes(q) ||
      (o.activeContract?.propertyName || '').toLowerCase().includes(q)
    );
  }
  if (propertyFilter !== 'all') {
    filtered = filtered.filter(o =>
      (o.propertyIds || []).map(String).includes(String(propertyFilter)) ||
      String(o.activeContract?.propertyId || '') === String(propertyFilter)
    );
  }
  if (unallottedOnly) {
    filtered = filtered.filter(o => !o.activeContract);
  }

  const propFilterLabel = propertyFilter === 'all'
    ? 'All Properties'
    : (properties.find(p => String(p.id) === String(propertyFilter))?.name || 'Property');

  const withActive = ownersList.filter(o => o.activeContract).length;
  const totalRent  = ownersList.reduce((s, o) => s + (o.activeContract?.monthlyRent || 0), 0);

  if (loading) return <LoadingScreen />;

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
          <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center', marginRight: 10 }}>
            <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 }}>Owners</Text>
            <Text style={{ fontSize: 13, color: '#6B7280', fontWeight: '500', marginTop: 2 }}>Landlord directory & contracts</Text>
          </View>
          <IconBtnSolid
            label="Add"
            onPress={() => setShowAddOwner(true)}
          />
        </View>

        {/* KPI strip */}
        <View style={{ flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 10, gap: 8 }}>
          {[
            { label: 'Total Owners',     value: String(ownersList.length), icon: 'person-outline'   as const },
            { label: 'Active Contracts', value: String(withActive),         icon: 'document-outline' as const },
            { label: 'Monthly Payout',   value: fmtAmt(totalRent),          icon: 'cash-outline'     as const },
          ].map(kpi => (
            <View key={kpi.label} style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.75)', borderRadius: 12, padding: 10, borderWidth: 1, borderColor: '#E5E7EB', alignItems: 'center' }}>
              <Ionicons name={kpi.icon} size={16} color="#2563EB" />
              <Text style={{ fontSize: 15, fontWeight: '900', color: '#111827', marginTop: 3 }}>{kpi.value}</Text>
              <Text style={{ fontSize: 9, color: colors.textTertiary, textAlign: 'center', marginTop: 1 }}>{kpi.label}</Text>
            </View>
          ))}
        </View>

        {/* Search */}
        <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
          <SearchField value={search} onChangeText={setSearch} placeholder="Search owners..." />
        </View>

        {/* Filter row: property + unallotted */}
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 8 }}>
          <TouchableOpacity
            onPress={() => setShowPropPicker(true)}
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: propertyFilter !== 'all' ? '#EFF6FF' : 'rgba(255,255,255,0.7)', borderRadius: 10, borderWidth: 1, borderColor: propertyFilter !== 'all' ? '#2563EB' : 'rgba(37,99,235,0.15)', paddingHorizontal: 12, height: 38 }}
          >
            <Ionicons name="business-outline" size={15} color="#2563EB" />
            <Text style={{ flex: 1, fontSize: 12, fontWeight: '600', color: propertyFilter !== 'all' ? '#2563EB' : colors.textSecondary }} numberOfLines={1}>{propFilterLabel}</Text>
            <Ionicons name="chevron-down" size={14} color={colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setUnallottedOnly(v => !v)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: unallottedOnly ? '#2563EB' : 'rgba(255,255,255,0.7)', borderRadius: 10, borderWidth: 1, borderColor: unallottedOnly ? '#2563EB' : 'rgba(37,99,235,0.15)', paddingHorizontal: 12, height: 38 }}
          >
            <Ionicons name={unallottedOnly ? 'checkbox' : 'square-outline'} size={15} color={unallottedOnly ? '#fff' : '#2563EB'} />
            <Text style={{ fontSize: 12, fontWeight: '700', color: unallottedOnly ? '#fff' : '#2563EB' }}>Unallotted</Text>
          </TouchableOpacity>
        </View>

        {/* List */}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#2563EB" />}>
          {filtered.length === 0 ? (
            <EmptyState title={search ? 'No matches' : 'No Owners'} subtitle={search ? 'Try different search terms' : 'Tap Add to create your first owner'} icon="person-outline" />
          ) : filtered.map(owner => (
            <OwnerCard key={owner.id} owner={owner} onPress={() => setSelectedOwner(owner.id)} />
          ))}
        </ScrollView>

        {/* Modals */}
        {selectedOwner && (
          <OwnerDetailModal ownerId={selectedOwner} onClose={() => setSelectedOwner(null)} onChanged={fetchOwners} />
        )}
        {showAddOwner && (
          <OwnerFormModal mode="add" onClose={() => setShowAddOwner(false)} onSaved={() => { setShowAddOwner(false); fetchOwners(); }} />
        )}

        {/* Property picker */}
        <Modal visible={showPropPicker} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowPropPicker(false)}>
          <GlassBackground>
            <SafeAreaView style={{ flex: 1 }}>
              <View style={S.modalHeader}>
                <Text style={S.modalTitle}>Filter by Property</Text>
                <TouchableOpacity onPress={() => setShowPropPicker(false)}><Ionicons name="close-circle" size={28} color={colors.textTertiary} /></TouchableOpacity>
              </View>
              <ScrollView contentContainerStyle={{ padding: 16 }}>
                <TouchableOpacity
                  onPress={() => { setPropertyFilter('all'); setShowPropPicker(false); }}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderRadius: 10, backgroundColor: propertyFilter === 'all' ? '#EFF6FF' : 'transparent', marginBottom: 4 }}
                >
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#111827' }}>All Properties</Text>
                  {propertyFilter === 'all' && <Ionicons name="checkmark-circle" size={18} color="#2563EB" />}
                </TouchableOpacity>
                {properties.map(p => (
                  <TouchableOpacity
                    key={p.id}
                    onPress={() => { setPropertyFilter(String(p.id)); setShowPropPicker(false); }}
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderRadius: 10, backgroundColor: String(propertyFilter) === String(p.id) ? '#EFF6FF' : 'transparent', marginBottom: 4 }}
                  >
                    <Text style={{ fontSize: 14, fontWeight: '600', color: '#111827' }}>{p.name}</Text>
                    {String(propertyFilter) === String(p.id) && <Ionicons name="checkmark-circle" size={18} color="#2563EB" />}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </SafeAreaView>
          </GlassBackground>
        </Modal>
      </SafeAreaView>
    </GlassBackground>
  );
}

const S = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF', borderRadius: 14, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: '#E5E7EB',
  },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#E5E7EB',
  },
  modalTitle: { fontSize: 17, fontWeight: '800', color: '#111827' },
  kycRow: { flexDirection: 'row', gap: 10, paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: '#E5E7EB' },
  kycLbl: { fontSize: 12, color: colors.textSecondary, width: 110 },
  kycVal: { fontSize: 13, fontWeight: '600', color: '#111827', flex: 1 },
  colLbl: { fontSize: 9, color: colors.textTertiary, fontWeight: '700' },
  colVal: { fontSize: 12, fontWeight: '600', color: '#111827' },
});
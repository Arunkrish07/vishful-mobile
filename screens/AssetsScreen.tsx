/**
 * AssetsScreen.tsx — COMPLETE, all 7 tabs inline (web parity).
 * Tabs: Inventory · Asset Payments · Vendors · Allocations · Categories · Analytics · Forecasts
 * Plus per-asset Detail view (payments + flow), QR, allocate/deallocate, type CRUD.
 * Single file — no external tab/modal imports needed.
 */
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Modal, Alert,
  TextInput, Platform, Linking, ActivityIndicator,
  KeyboardAvoidingView, RefreshControl, Pressable, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { GlassBackground, PickerSelect, IconBtnSolid } from '../components/shared';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useMountedRef } from '../lib/safeAsync';
import { fetchVisibleTabKeys, filterTabs } from '../lib/tabPermissions';
import * as ImagePicker from 'expo-image-picker';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/config';

// ─── Constants ────────────────────────────────────────────────────────────────
const STATUSES   = ['inventory','allocated','maintenance','retired','disposed'];
const CONDITIONS = ['new','good','fair','poor'];
const CAP_UNITS  = [
  { label: 'Tons (AC)',            value: 'tons' },
  { label: 'Litres (Fridge)',      value: 'litres' },
  { label: 'Kgs (Washing Machine)',value: 'kgs' },
  { label: 'Watts (Induction)',    value: 'watts' },
];
const RMK_TYPES  = ['positive','negative','dispute','neutral'];
const SEVS       = ['low','medium','high','critical'];
const EMPTY_STATS = { totalAssets: 0, totalInvestment: 0, allocated: 0, maintenance: 0, byCategory: [] };
const PAYMENT_MODES = [
  { value: 'cash',     label: 'Cash' },
  { value: 'transfer', label: 'Bank Transfer' },
  { value: 'upi',      label: 'UPI' },
  { value: 'cheque',   label: 'Cheque' },
  { value: 'online',   label: 'Online' },
  { value: 'card',     label: 'Card' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function allSettled(promises: Promise<any>[]): Promise<{ status: string; value?: any; reason?: any }[]> {
  return Promise.all(promises.map(p =>
    Promise.resolve(p).then(
      function(value) { return { status: 'fulfilled', value: value }; },
      function(reason) { return { status: 'rejected', reason: reason }; }
    )
  ));
}

const fmtShort = (v: number) => {
  if (!v) return '₹0';
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${v.toLocaleString('en-IN')}`;
};
const fmtFull = (v: number) => `₹${(v || 0).toLocaleString('en-IN')}`;
const fmtDate = (d: string | null) => {
  if (!d) return '—';
  try {
    const dt = new Date(d);
    return `${dt.getDate()}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getMonth()]}-${String(dt.getFullYear()).slice(2)}`;
  } catch { return d; }
};
const qrOf = (a: any) => a?.qrCode || (a?.assetCode
  ? `https://vishful.co.in/vista/asset?id=${a._id || ''}&code=${encodeURIComponent(a.assetCode)}`
  : '');
const condColor = (c: string) => ({ new: '#16a34a', good: '#2563EB', fair: '#2563EB', poor: '#DC2626' }[c] || '#6B7280');
const stsColor  = (s: string) => ({ allocated: '#16a34a', inventory: '#2563EB', available: '#2563EB', maintenance: '#2563EB', retired: '#6B7280', disposed: '#DC2626' }[s] || '#6B7280');
const confirmDelete = (msg: string) => new Promise<boolean>(res =>
  Alert.alert('Confirm', msg, [
    { text: 'Cancel', style: 'cancel', onPress: () => res(false) },
    { text: 'Delete', style: 'destructive', onPress: () => res(true) },
  ])
);
const matches = (a: any, q: string) => {
  if (!q) return true;
  const s = q.toLowerCase();
  return [a.assetCode, a.typeName, a.categoryName, a.brand, a.model,
    a.status, a.condition, a.vendorNameManual, a.serialNumber, a.invoiceNumber]
    .some(v => v && String(v).toLowerCase().includes(s));
};

// ─── QR display ──────────────────────────────────────────────────────────────
let QRLib: any = null;
try { QRLib = require('react-native-qrcode-styled').default; } catch {}
function QRDisplay({ data, size = 4 }: any) {
  if (QRLib) return React.createElement(QRLib, { data, style: { backgroundColor: '#fff' }, pieceSize: size, padding: 8, errorCorrectionLevel: 'H' });
  return (
    <View style={{ alignItems: 'center', padding: 16, borderWidth: 1, borderColor: '#ddd', borderRadius: 12, minWidth: 100 }}>
      <Ionicons name="qr-code-outline" size={48} color="#2563EB" />
      <Text style={{ fontSize: 9, color: '#556274', marginTop: 4, textAlign: 'center', maxWidth: 120 }} numberOfLines={3}>{data}</Text>
    </View>
  );
}

// ─── Shared micro-components ─────────────────────────────────────────────────
function Pill({ label, color, bg }: any) {
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color }}>{label}</Text>
    </View>
  );
}
function Lbl({ children }: any) {
  return <Text style={{ fontSize: 12, fontWeight: '700', color: '#556274', marginBottom: 4 }}>{children}</Text>;
}
function Checkbox({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return (
    <Pressable onPress={onToggle} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      <View style={{
        width: 20, height: 20, borderRadius: 5, borderWidth: 2,
        borderColor: checked ? '#2563EB' : 'rgba(37,99,235,0.35)',
        backgroundColor: checked ? '#2563EB' : '#fff',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {checked && <Ionicons name="checkmark" size={13} color="#fff" />}
      </View>
      <Text style={{ fontSize: 13, color: '#556274', flex: 1 }}>{label}</Text>
    </Pressable>
  );
}
function Inp({ label, value, onChange, placeholder, multi, num, required }: any) {
  return (
    <View style={{ marginBottom: 12 }}>
      {!!label && (
        <View style={{ flexDirection: 'row' }}>
          <Lbl>{label}</Lbl>
          {required && <Text style={{ fontSize: 12, color: '#DC2626', marginLeft: 2 }}>*</Text>}
        </View>
      )}
      <TextInput
        style={{
          backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E5E7EB',
          paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: '#111827',
          height: multi ? 80 : undefined, textAlignVertical: multi ? 'top' : 'auto',
        }}
        value={value || ''}
        onChangeText={onChange}
        placeholder={placeholder || ''}
        placeholderTextColor="#6B7280"
        multiline={multi}
        keyboardType={num ? 'decimal-pad' : 'default'}
        autoCorrect={false}
        autoCapitalize="none"
      />
    </View>
  );
}
function Row({ children }: any) { return <View style={{ flexDirection: 'row', gap: 10 }}>{children}</View>; }
function Sec({ title }: any) {
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: '#E5E7EB', marginVertical: 12, paddingTop: 12 }}>
      <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827' }}>{title}</Text>
    </View>
  );
}
function Stars({ value, onRate }: any) {
  return (
    <View style={{ flexDirection: 'row', gap: 3 }}>
      {[1,2,3,4,5].map(i => (
        <TouchableOpacity key={i} onPress={() => onRate?.(i)} disabled={!onRate}>
          <Ionicons name={i <= value ? 'star' : 'star-outline'} size={18} color={i <= value ? '#F59E0B' : '#6B7280'} />
        </TouchableOpacity>
      ))}
    </View>
  );
}
function MiniBar({ data }: any) {
  if (!data?.length) return <Text style={{ color: '#6B7280', textAlign: 'center', marginTop: 20 }}>No data</Text>;
  const mx = Math.max(...data.map((d: any) => d.count), 1);
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 150, gap: 6 }}>
        {data.map((d: any, i: number) => {
          const bh = Math.max(8, (d.count / mx) * 140);
          return (
            <View key={`${d.name}-${i}`} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: '#2563EB', marginBottom: 2 }}>{d.count}</Text>
              <View style={{ width: '100%', height: bh, backgroundColor: '#2563EB', borderRadius: 5, opacity: 0.75 }} />
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
        {data.map((d: any, i: number) => (
          <Text key={`${d.name}-label-${i}`} style={{ flex: 1, fontSize: 9, color: '#6B7280', textAlign: 'center' }} numberOfLines={2}>{d.name}</Text>
        ))}
      </View>
    </View>
  );
}

// ─── ASSET CARD (inventory list item) — tap body to open detail ──────────────
function AssetCard({ a, onView, onQR, onEdit, onAlloc, onDealloc, onDelete }: any) {
  const [open, setOpen] = useState(false);
  const isAllocated = a.status === 'allocated';
  return (
    <View style={{ backgroundColor: '#fff', borderRadius: 14, marginBottom: 10, padding: 14, borderWidth: 1, borderColor: '#E5E7EB', shadowColor: '#2563EB', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
        <TouchableOpacity activeOpacity={0.7} onPress={() => onView?.()} style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', gap: 5, flexWrap: 'wrap', marginBottom: 3 }}>
            <Text style={{ fontSize: 12, fontWeight: '800', color: '#2563EB' }}>{a.assetCode || '—'}</Text>
            <Pill label={a.status || 'inventory'} color={stsColor(a.status)} bg={stsColor(a.status) + '18'} />
            <Pill label={a.condition || 'new'} color={condColor(a.condition)} bg={condColor(a.condition) + '18'} />
          </View>
          <Text style={{ fontSize: 15, fontWeight: '700', color: '#111827' }}>{a.typeName || '—'}</Text>
          <Text style={{ fontSize: 13, color: '#556274', marginTop: 1 }}>{[a.brand, a.model].filter(Boolean).join(' ') || '—'}</Text>
          <Text style={{ fontSize: 12, color: '#6B7280', marginTop: 1 }}>{a.vendorNameManual || a.categoryName || '—'}</Text>
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 5, flexWrap: 'wrap', alignItems: 'center' }}>
            {!!a.purchasePrice && <Text style={{ fontSize: 13, fontWeight: '800', color: '#16a34a' }}>{fmtFull(a.purchasePrice)}</Text>}
            {!!a.purchaseDate  && <Text style={{ fontSize: 11, color: '#6B7280' }}>{fmtDate(a.purchaseDate)}</Text>}
            {!!a.locationName  && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <Ionicons name="location-outline" size={11} color="#6B7280" />
                <Text style={{ fontSize: 11, color: '#6B7280' }}>{a.locationName}</Text>
              </View>
            )}
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setOpen(!open)} style={{ padding: 6 }}>
          <Ionicons name={open ? 'chevron-up' : 'ellipsis-vertical'} size={18} color="#6B7280" />
        </TouchableOpacity>
      </View>
      {open && (
        <View style={{ borderTopWidth: 1, borderTopColor: '#E5E7EB', marginTop: 10, paddingTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[
            { icon: 'eye-outline',        label: 'View',       fn: () => { setOpen(false); onView(); },        color: '#2563EB' },
            { icon: 'qr-code-outline',    label: 'QR Code',    fn: () => { setOpen(false); onQR(); },          color: '#2563EB' },
            { icon: 'pencil-outline',     label: 'Edit',       fn: () => { setOpen(false); onEdit(); },        color: '#2563EB' },
            !isAllocated && { icon: 'location-outline', label: 'Allocate',   fn: () => { setOpen(false); onAlloc(); },      color: '#2563EB' },
            isAllocated  && { icon: 'arrow-undo-outline', label: 'Deallocate', fn: () => { setOpen(false); onDealloc(); },    color: '#2563EB' },
            { icon: 'trash-outline',      label: 'Delete',     fn: async () => { setOpen(false); if (await confirmDelete('Delete this asset?')) onDelete(); }, color: '#DC2626' },
          ].filter(Boolean).map((x: any) => (
            <TouchableOpacity key={x.label} onPress={x.fn}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: x.color + '40', backgroundColor: x.color + '08' }}>
              <Ionicons name={x.icon} size={13} color={x.color} />
              <Text style={{ fontSize: 12, fontWeight: '700', color: x.color }}>{x.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}
// ─── ADD / EDIT ASSET MODAL ───────────────────────────────────────────────────
const EA: any = {
  assetTypeId: '', brand: '', model: '', serialNumber: '',
  purchasePrice: '', purchaseDate: '', warrantyMonths: '',
  invoiceNumber: '', invoiceDate: '',
  capacityValue: '', capacityUnit: '',
  condition: 'new', status: 'inventory', notes: '',
  supplierId: '', vendorNameManual: '', isGeneralVendor: false,
  invoiceUrl: '', productPhotoUrl: '',
};

function AssetModal({ visible, onClose, onSave, init, title, types, vendors, brands, onNewType, onNewBrand, token }: any) {
  const [f, setF] = useState<any>(EA);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (visible) setF(init ? { ...EA, ...init } : EA); }, [visible]);
  const s = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const isValid = () =>
    !!f.assetTypeId && !!f.brand && !!f.purchasePrice && !!f.purchaseDate &&
    (f.isGeneralVendor ? !!f.vendorNameManual : !!f.supplierId);
  const save = async () => {
    if (!isValid()) { Alert.alert('Required fields', 'Asset type, brand, purchase price, purchase date and vendor are required.'); return; }
    setSaving(true);
    try { await onSave(f); }
    catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSaving(false); }
  };
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#FAF7FC' }} edges={['top']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: '#111827' }}>{title}</Text>
          <TouchableOpacity onPress={onClose} style={{ padding: 6, backgroundColor: '#EFF6FF', borderRadius: 999 }}>
            <Ionicons name="close" size={20} color="#556274" />
          </TouchableOpacity>
        </View>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
            {/* Asset Type */}
            <View style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <View style={{ flexDirection: 'row' }}><Lbl>Asset Type</Lbl><Text style={{ fontSize: 12, color: '#DC2626', marginLeft: 2 }}>*</Text></View>
                <TouchableOpacity onPress={onNewType}><Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>+ New Type</Text></TouchableOpacity>
              </View>
              <PickerSelect label="" value={f.assetTypeId}
                options={types.map((t: any) => ({ label: `${t.categoryName} → ${t.name}`, value: t._id }))}
                onSelect={(v: string) => s('assetTypeId', v)} />
            </View>
            {/* Brand + Model */}
            <Row>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <View style={{ flexDirection: 'row' }}><Lbl>Brand</Lbl><Text style={{ fontSize: 12, color: '#DC2626', marginLeft: 2 }}>*</Text></View>
                  <TouchableOpacity onPress={onNewBrand}><Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>+ New</Text></TouchableOpacity>
                </View>
                {brands.length > 0
                  ? <PickerSelect label="" value={f.brand} options={brands.map((b: any) => ({ label: b.name, value: b.name }))} onSelect={(v: string) => s('brand', v)} />
                  : <TextInput style={{ backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E5E7EB', paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: '#111827' }} value={f.brand} onChangeText={(v) => s('brand', v)} placeholder="Brand name" placeholderTextColor="#6B7280" />}
              </View>
              <View style={{ flex: 1 }}><Inp label="Model" value={f.model} onChange={(v: string) => s('model', v)} placeholder="e.g. WTL600UEA" /></View>
            </Row>
            <Inp label="Serial Number" value={f.serialNumber} onChange={(v: string) => s('serialNumber', v)} placeholder="Optional" />
            <Row>
              <View style={{ flex: 1 }}><Inp label="Capacity" value={f.capacityValue} onChange={(v: string) => s('capacityValue', v)} num placeholder="e.g. 1.5" /></View>
              <View style={{ flex: 1 }}>
                <Lbl>Unit</Lbl>
                <PickerSelect label="" value={f.capacityUnit} options={CAP_UNITS} onSelect={(v: string) => s('capacityUnit', v)} />
              </View>
            </Row>
            <Sec title="Purchase & Bill Details" />
            <ImageUploadField label="Invoice Photo" value={f.invoiceUrl || ''} onChange={(url) => s('invoiceUrl', url)} folder="invoices" token={token} />
            <Row>
              <View style={{ flex: 1 }}><Inp label="Purchase Price (₹)" value={f.purchasePrice} onChange={(v: string) => s('purchasePrice', v)} num required /></View>
              <View style={{ flex: 1 }}><DatePickerInput label="Purchase Date" value={f.purchaseDate} onChange={(v) => s('purchaseDate', v)} required /></View>
            </Row>
            <Row>
              <View style={{ flex: 1 }}><Inp label="Invoice Number" value={f.invoiceNumber} onChange={(v: string) => s('invoiceNumber', v)} /></View>
              <View style={{ flex: 1 }}><DatePickerInput label="Invoice Date" value={f.invoiceDate} onChange={(v) => s('invoiceDate', v)} /></View>
            </Row>
            <Inp label="Warranty (months)" value={f.warrantyMonths} onChange={(v: string) => s('warrantyMonths', v)} num placeholder="e.g. 12" />
            <Sec title="Vendor Details" />
            <Checkbox checked={f.isGeneralVendor} onToggle={() => s('isGeneralVendor', !f.isGeneralVendor)} label="General / One-time Vendor" />
            {f.isGeneralVendor
              ? <Inp label="Vendor Name" value={f.vendorNameManual} onChange={(v: string) => s('vendorNameManual', v)} placeholder="Enter vendor name" required />
              : (
                <View style={{ marginBottom: 12 }}>
                  <View style={{ flexDirection: 'row' }}><Lbl>Select Vendor</Lbl><Text style={{ fontSize: 12, color: '#DC2626', marginLeft: 2 }}>*</Text></View>
                  <PickerSelect label="" value={f.supplierId}
                    options={vendors.map((v: any) => ({ label: v.name || v.vendor_name, value: v.id }))}
                    onSelect={(v: string) => s('supplierId', v)} />
                </View>
              )}
            <ImageUploadField label="Product Photo" value={f.productPhotoUrl || ''} onChange={(url) => s('productPhotoUrl', url)} folder="product-photos" token={token} />
            <Sec title="Condition & Status" />
            <Row>
              <View style={{ flex: 1 }}>
                <Lbl>Condition</Lbl>
                <PickerSelect label="" value={f.condition} options={CONDITIONS.map(c => ({ label: c.charAt(0).toUpperCase() + c.slice(1), value: c }))} onSelect={(v: string) => s('condition', v)} />
              </View>
              <View style={{ flex: 1 }}>
                <Lbl>Status</Lbl>
                <PickerSelect label="" value={f.status} options={STATUSES.map(c => ({ label: c.charAt(0).toUpperCase() + c.slice(1), value: c }))} onSelect={(v: string) => s('status', v)} />
              </View>
            </Row>
            <Inp label="Notes" value={f.notes} onChange={(v: string) => s('notes', v)} multi placeholder="Optional notes..." />
            <TouchableOpacity style={{ backgroundColor: isValid() ? '#2563EB' : '#aaa', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 8 }} onPress={save} disabled={saving || !isValid()}>
              {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ fontSize: 16, fontWeight: '800', color: '#fff' }}>Save Asset</Text>}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── VENDOR MODAL ─────────────────────────────────────────────────────────────
const EV: any = { vendor_name: '', contact_person: '', phone: '', email: '', address: '', gst_number: '', pan_number: '', bank_name: '', bank_account_number: '', bank_ifsc: '', notes: '' };
function VendorModal({ visible, onClose, onSave, init, title }: any) {
  const [f, setF] = useState<any>(EV);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (visible) setF(init ? { ...EV, ...init } : EV); }, [visible]);
  const s = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const save = async () => {
    if (!f.vendor_name) { Alert.alert('Error', 'Vendor name required'); return; }
    setSaving(true);
    try { await onSave(f); }
    catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSaving(false); }
  };
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#FAF7FC' }} edges={['top']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: '#111827' }}>{title}</Text>
          <TouchableOpacity onPress={onClose} style={{ padding: 6, backgroundColor: '#EFF6FF', borderRadius: 999 }}>
            <Ionicons name="close" size={20} color="#556274" />
          </TouchableOpacity>
        </View>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
            <Inp label="Vendor Name" value={f.vendor_name} onChange={(v: string) => s('vendor_name', v)} required />
            <Row>
              <View style={{ flex: 1 }}><Inp label="Contact Person" value={f.contact_person} onChange={(v: string) => s('contact_person', v)} /></View>
              <View style={{ flex: 1 }}><Inp label="Phone" value={f.phone} onChange={(v: string) => s('phone', v)} /></View>
            </Row>
            <Row>
              <View style={{ flex: 1 }}><Inp label="Email" value={f.email} onChange={(v: string) => s('email', v)} /></View>
              <View style={{ flex: 1 }}><Inp label="Address" value={f.address} onChange={(v: string) => s('address', v)} /></View>
            </Row>
            <Sec title="KYC Details" />
            <Row>
              <View style={{ flex: 1 }}><Inp label="GST Number" value={f.gst_number} onChange={(v: string) => s('gst_number', v)} /></View>
              <View style={{ flex: 1 }}><Inp label="PAN Number" value={f.pan_number} onChange={(v: string) => s('pan_number', v)} /></View>
            </Row>
            <Sec title="Bank Details" />
            <Row>
              <View style={{ flex: 1 }}><Inp label="Bank Name" value={f.bank_name} onChange={(v: string) => s('bank_name', v)} /></View>
              <View style={{ flex: 1 }}><Inp label="Account Number" value={f.bank_account_number} onChange={(v: string) => s('bank_account_number', v)} /></View>
            </Row>
            <Inp label="IFSC Code" value={f.bank_ifsc} onChange={(v: string) => s('bank_ifsc', v)} />
            <Inp label="Notes" value={f.notes} onChange={(v: string) => s('notes', v)} multi />
            <TouchableOpacity style={{ backgroundColor: '#2563EB', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 8, opacity: saving ? 0.6 : 1 }} onPress={save} disabled={saving}>
              {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ fontSize: 16, fontWeight: '800', color: '#fff' }}>Save Vendor</Text>}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── VENDOR DETAIL + REMARKS MODAL ───────────────────────────────────────────
function VendorDetailModal({ visible, onClose, vendor, remarks, onAddRemark, onRate }: any) {
  const [tab, setTab]   = useState('details');
  const [rmkOpen, setRmkOpen] = useState(false);
  const [rType, setRType] = useState('neutral');
  const [rTitle, setRTitle] = useState('');
  const [rDesc, setRDesc] = useState('');
  const [rSev, setRSev] = useState('medium');
  const [saving, setSaving] = useState(false);
  const rBg = (t: string) => ({ positive: '#DCFCE7', negative: '#FEE2E2', dispute: '#FEF3C7', neutral: '#F3F4F6' }[t] || '#F3F4F6');
  const rCl = (t: string) => ({ positive: '#16a34a', negative: '#DC2626', dispute: '#2563EB', neutral: '#6B7280' }[t] || '#6B7280');
  const saveRemark = async () => {
    if (!rTitle) { Alert.alert('Error', 'Title required'); return; }
    setSaving(true);
    try { await onAddRemark({ remark_type: rType, title: rTitle, description: rDesc, severity: rSev }); setRmkOpen(false); setRTitle(''); setRDesc(''); }
    catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSaving(false); }
  };
  if (!vendor) return null;
  const vName = vendor.name || vendor.vendor_name;
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#FAF7FC' }} edges={['top']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: '#111827', flex: 1 }} numberOfLines={1}>{vName}</Text>
          <TouchableOpacity onPress={onClose} style={{ padding: 6, backgroundColor: '#EFF6FF', borderRadius: 999, marginLeft: 8 }}>
            <Ionicons name="close" size={20} color="#556274" />
          </TouchableOpacity>
        </View>
        <View style={{ flexDirection: 'row', gap: 8, padding: 12 }}>
          {['details', 'remarks'].map(t => (
            <TouchableOpacity key={t} onPress={() => setTab(t)}
              style={{ paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: tab === t ? '#2563EB' : 'rgba(37,99,235,0.1)' }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: tab === t ? '#fff' : '#2563EB' }}>
                {t.charAt(0).toUpperCase() + t.slice(1)}{t === 'remarks' ? ` (${remarks.length})` : ''}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 50 }}>
          {tab === 'details' ? (
            <View style={{ backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: '#E5E7EB' }}>
              {[
                ['Name',    vName],
                ['Contact', vendor.contactPerson || vendor.contact_person || '—'],
                ['Phone',   vendor.phone || '—'],
                ['Email',   vendor.email || '—'],
                ['GST',     vendor.gstNumber || vendor.gst_number || '—'],
                ['PAN',     vendor.panNumber || vendor.pan_number || '—'],
              ].map(([k, v], i) => (
                <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: i < 5 ? 1 : 0, borderBottomColor: '#E5E7EB' }}>
                  <Text style={{ fontSize: 12, color: '#6B7280', fontWeight: '600', width: 70 }}>{k}</Text>
                  <Text style={{ fontSize: 13, color: '#111827', fontWeight: '600', flex: 1, textAlign: 'right' }}>{v}</Text>
                </View>
              ))}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, alignItems: 'center' }}>
                <Text style={{ fontSize: 12, color: '#6B7280', fontWeight: '600' }}>Rating</Text>
                <Stars value={vendor.vendorRating || vendor.vendor_rating || 0} onRate={onRate} />
              </View>
            </View>
          ) : (
            <View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <Text style={{ fontSize: 15, fontWeight: '800', color: '#111827' }}>Remarks</Text>
                <TouchableOpacity onPress={() => setRmkOpen(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, backgroundColor: '#EFF6FF' }}>
                  <Ionicons name="add" size={14} color="#2563EB" />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>Add Remark</Text>
                </TouchableOpacity>
              </View>
              {rmkOpen && (
                <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: '#E5E7EB' }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827', marginBottom: 10 }}>New Remark</Text>
                  <Lbl>Type</Lbl>
                  <PickerSelect label="" value={rType} options={RMK_TYPES.map(t => ({ label: `${t.charAt(0).toUpperCase()}${t.slice(1)}`, value: t }))} onSelect={setRType} />
                  <View style={{ marginTop: 8 }}>
                    <Lbl>Severity</Lbl>
                    <PickerSelect label="" value={rSev} options={SEVS.map(sv => ({ label: `${sv.charAt(0).toUpperCase()}${sv.slice(1)}`, value: sv }))} onSelect={setRSev} />
                  </View>
                  <View style={{ marginTop: 8 }}><Inp label="Title" value={rTitle} onChange={setRTitle} required /></View>
                  <Inp label="Details" value={rDesc} onChange={setRDesc} multi />
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <TouchableOpacity style={{ flex: 1, backgroundColor: '#2563EB', borderRadius: 10, paddingVertical: 12, alignItems: 'center', opacity: saving ? 0.6 : 1 }} onPress={saveRemark} disabled={saving}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>{saving ? '…' : 'Save'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={{ flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center', borderWidth: 1.5, borderColor: '#E5E7EB' }} onPress={() => setRmkOpen(false)}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: '#556274' }}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              {remarks.length === 0
                ? <Text style={{ fontSize: 13, color: '#6B7280', textAlign: 'center', marginTop: 24 }}>No remarks yet</Text>
                : remarks.map((r: any) => (
                  <View key={r.id} style={{ backgroundColor: rBg(r.remark_type), borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: rCl(r.remark_type) + '40' }}>
                    <View style={{ flexDirection: 'row', gap: 6, marginBottom: 5 }}>
                      <Pill label={r.remark_type} color={rCl(r.remark_type)} bg={rCl(r.remark_type) + '22'} />
                      <Pill label={r.severity} color="#6B7280" bg="#E5E7EB" />
                    </View>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#111827' }}>{r.title}</Text>
                    {!!r.description && <Text style={{ fontSize: 12, color: '#556274', marginTop: 3 }}>{r.description}</Text>}
                    <Text style={{ fontSize: 10, color: '#6B7280', marginTop: 4 }}>{fmtDate(r.created_at)}</Text>
                  </View>
                ))}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── ALLOCATION MODAL ─────────────────────────────────────────────────────────
function AllocModal({ visible, onClose, onSave, asset, properties, apartments, beds, init }: any) {
  const [type,   setType]   = useState('property');
  const [propId, setPropId] = useState('');
  const [aptId,  setAptId]  = useState('');
  const [bedIds, setBedIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (visible) {
      if (init) { setType(init.type || 'property'); setPropId(init.propertyId || ''); setAptId(init.apartmentId || ''); setBedIds(init.bedIds || []); }
      else { setType('property'); setPropId(''); setAptId(''); setBedIds([]); }
    }
  }, [visible]);
  const filtApts = apartments.filter((a: any) => !propId || a.propertyId === propId || a.property_id === propId);
  const filtBeds = beds.filter((b: any) => !aptId  || b.apartmentId === aptId || b.apartment_id === aptId);
  const price = asset?.purchasePrice || 0;
  const save = async () => {
    if (!propId) { Alert.alert('Error', 'Select a property'); return; }
    if (type === 'bed' && !bedIds.length) { Alert.alert('Error', 'Select at least one bed'); return; }
    setSaving(true);
    try { await onSave({ assetId: asset?._id, allocationType: type, propertyId: propId, apartmentId: aptId || null, bedIds: type === 'bed' ? bedIds : [] }); }
    catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSaving(false); }
  };
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#FAF7FC' }} edges={['top']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: '#111827' }}>Allocate Asset</Text>
          <TouchableOpacity onPress={onClose} style={{ padding: 6, backgroundColor: '#EFF6FF', borderRadius: 999 }}>
            <Ionicons name="close" size={20} color="#556274" />
          </TouchableOpacity>
        </View>
        {asset && (
          <View style={{ paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#EFF6FF', borderBottomWidth: 1, borderBottomColor: 'rgba(37,99,235,0.15)' }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>{asset.assetCode}</Text>
            <Text style={{ fontSize: 13, color: '#556274' }}>{asset.typeName}{asset.brand ? ` · ${asset.brand}` : ''}</Text>
            <Text style={{ fontSize: 14, fontWeight: '800', color: '#16a34a', marginTop: 2 }}>Total Cost: {fmtFull(price)}</Text>
          </View>
        )}
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 50 }} keyboardShouldPersistTaps="handled">
          <Lbl>Allocate To</Lbl>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
            {['property', 'apartment', 'bed'].map(t => (
              <TouchableOpacity key={t} onPress={() => { setType(t); setAptId(''); setBedIds([]); }}
                style={{ flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: type === t ? '#2563EB' : 'rgba(37,99,235,0.1)' }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: type === t ? '#fff' : '#2563EB' }}>{t.charAt(0).toUpperCase() + t.slice(1)}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Lbl>Property *</Lbl>
          <PickerSelect label="" value={propId} options={properties.map((p: any) => ({ label: p.name || p.property_name, value: p.id }))} onSelect={(v: string) => { setPropId(v); setAptId(''); setBedIds([]); }} />
          {(type === 'apartment' || type === 'bed') && (
            <View style={{ marginTop: 12 }}>
              <Lbl>Apartment</Lbl>
              <PickerSelect label="" value={aptId} options={filtApts.map((a: any) => ({ label: a.code || a.apartment_code, value: a._id || a.id }))} onSelect={(v: string) => { setAptId(v); setBedIds([]); }} />
            </View>
          )}
          {type === 'bed' && (
            <View style={{ marginTop: 12 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <Lbl>Select Beds</Lbl>
                {bedIds.length > 0 && price > 0 && (
                  <View style={{ backgroundColor: '#EFF6FF', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5 }}>
                    <Text style={{ fontSize: 12, fontWeight: '800', color: '#2563EB' }}>{fmtFull(Math.round(price / bedIds.length))} / bed</Text>
                    <Text style={{ fontSize: 10, color: '#6B7280', textAlign: 'center' }}>{bedIds.length} bed{bedIds.length > 1 ? 's' : ''} selected</Text>
                  </View>
                )}
              </View>
              <Text style={{ fontSize: 11, color: '#6B7280', marginBottom: 8 }}>Cost (₹{price.toLocaleString('en-IN')}) shared equally across selected beds</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12, backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#E5E7EB' }}>
                {filtBeds.length === 0
                  ? <Text style={{ fontSize: 12, color: '#6B7280' }}>No beds in selected apartment</Text>
                  : filtBeds.map((b: any) => {
                    const bid = b._id || b.id; const sel = bedIds.includes(bid);
                    const perBed = sel && price > 0 && bedIds.length > 0 ? Math.round(price / bedIds.length) : 0;
                    return (
                      <TouchableOpacity key={bid} onPress={() => setBedIds(sel ? bedIds.filter(id => id !== bid) : [...bedIds, bid])}
                        style={{ paddingHorizontal: 14, paddingVertical: sel ? 6 : 8, borderRadius: 10, borderWidth: 1.5, borderColor: '#2563EB', backgroundColor: sel ? '#2563EB' : 'transparent', alignItems: 'center' }}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: sel ? '#fff' : '#2563EB' }}>{b.code || b.bed_code}</Text>
                        {sel && perBed > 0 && <Text style={{ fontSize: 9, color: 'rgba(255,255,255,0.8)', marginTop: 1 }}>₹{perBed.toLocaleString('en-IN')}</Text>}
                      </TouchableOpacity>
                    );
                  })}
              </View>
            </View>
          )}
          <TouchableOpacity style={{ backgroundColor: '#2563EB', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 20, opacity: saving ? 0.6 : 1 }} onPress={save} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ fontSize: 16, fontWeight: '800', color: '#fff' }}>Allocate Asset</Text>}
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
// ─── QR MODAL ─────────────────────────────────────────────────────────────────
function QRModal({ visible, onClose, asset }: any) {
  const qrVal = asset ? qrOf(asset) : '';
  const copy = () => {
    try { require('@react-native-clipboard/clipboard').default.setString(qrVal); Alert.alert('Copied!', 'Link copied to clipboard'); }
    catch { Alert.alert('Asset Link', qrVal); }
  };
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 22, padding: 24, width: '100%', maxWidth: 360, alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginBottom: 18 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: '#111827' }}>Asset QR Code</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color="#6B7280" /></TouchableOpacity>
          </View>
          {qrVal
            ? <QRDisplay data={qrVal} size={5} />
            : <View style={{ padding: 30, alignItems: 'center' }}><Ionicons name="qr-code-outline" size={60} color="#ddd" /><Text style={{ color: '#6B7280', marginTop: 8 }}>No QR Code</Text></View>}
          <Text style={{ fontSize: 15, fontWeight: '800', color: '#2563EB', marginTop: 16 }}>{asset?.assetCode}</Text>
          <Text style={{ fontSize: 13, color: '#556274', marginTop: 2 }}>{asset?.typeName}{asset?.brand ? ` · ${asset.brand}` : ''}{asset?.model ? ` ${asset.model}` : ''}</Text>
          {!!qrVal && (
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
              <TouchableOpacity onPress={copy} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 10, borderWidth: 1.5, borderColor: '#2563EB20', backgroundColor: '#2563EB08' }}>
                <Ionicons name="copy-outline" size={14} color="#2563EB" />
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>Copy Link</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => Linking.openURL(qrVal).catch(() => {})} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 10, borderWidth: 1.5, borderColor: '#2563EB20', backgroundColor: '#2563EB08' }}>
                <Ionicons name="open-outline" size={14} color="#2563EB" />
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>Open Link</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ─── QUICK CREATE/EDIT MODAL (Category / Type / Brand) ────────────────────────
function QuickModal({ visible, onClose, title, onSave, fields, initial }: any) {
  const init = Object.fromEntries(fields.map((f: any) => [f.key, '']));
  const [vals, setVals] = useState<any>(init);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (visible) setVals(initial ? { ...init, ...initial } : init); }, [visible]);
  const save = async () => {
    if (!vals[fields[0].key]) { Alert.alert('Error', `${fields[0].label} required`); return; }
    setSaving(true);
    try { await onSave(vals); onClose(); }
    catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSaving(false); }
  };
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 24 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 20, padding: 20 }}>
          <Text style={{ fontSize: 17, fontWeight: '800', color: '#111827', marginBottom: 14 }}>{title}</Text>
          {fields.map((f: any) => (
            <Inp key={f.key} label={f.label} value={vals[f.key]} onChange={(v: string) => setVals((p: any) => ({ ...p, [f.key]: v }))} placeholder={f.placeholder} />
          ))}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
            <TouchableOpacity style={{ flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center', borderWidth: 1.5, borderColor: '#E5E7EB' }} onPress={onClose}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: '#556274' }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center', backgroundColor: '#2563EB', opacity: saving ? 0.6 : 1 }} onPress={save} disabled={saving}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>{saving ? '…' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Image Upload Field ───────────────────────────────────────────────────────
function ImageUploadField({ label, value, onChange, folder, token }: { label: string; value: string; onChange: (url: string) => void; folder: string; token: string }) {
  const [uploading, setUploading] = useState(false);
  const upload = async (uri: string) => {
    setUploading(true);
    try {
      const filename = `${Date.now()}.jpg`;
      const res = await fetch(uri);
      const blob = await res.blob();
      const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${folder}/${filename}`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
        body: blob,
      });
      if (!uploadRes.ok) { const err = await uploadRes.json().catch(() => ({})); throw new Error(err?.message || `Upload failed (${uploadRes.status})`); }
      onChange(`${SUPABASE_URL}/storage/v1/object/public/${folder}/${filename}`);
    } catch (e: any) { Alert.alert('Upload failed', e.message); }
    finally { setUploading(false); }
  };
  const pickFromGallery = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission required', 'Allow photo library access to upload images.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.85 });
    if (!result.canceled && result.assets?.[0]) await upload(result.assets[0].uri);
  };
  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission required', 'Allow camera access to take photos.'); return; }
    const result = await ImagePicker.launchCameraAsync({ allowsEditing: true, quality: 0.85 });
    if (!result.canceled && result.assets?.[0]) await upload(result.assets[0].uri);
  };
  return (
    <View style={{ marginBottom: 12 }}>
      <Lbl>{label}</Lbl>
      {value ? (
        <View style={{ borderRadius: 12, borderWidth: 1, borderColor: '#E5E7EB', overflow: 'hidden', backgroundColor: '#fff' }}>
          <View style={{ width: '100%', height: 140, backgroundColor: '#F3F0F8', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
            <Ionicons name="image" size={44} color="#2563EB" />
            <Text style={{ fontSize: 10, color: '#6B7280', marginTop: 6, textAlign: 'center' }} numberOfLines={2}>{value.split('/').pop()}</Text>
            <Text style={{ fontSize: 11, color: '#16a34a', marginTop: 4, fontWeight: '700' }}>✓ Uploaded</Text>
          </View>
          <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#E5E7EB' }}>
            <TouchableOpacity onPress={pickFromGallery} disabled={uploading} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 10 }}>
              <Ionicons name="swap-horizontal-outline" size={14} color="#2563EB" />
              <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>Change</Text>
            </TouchableOpacity>
            <View style={{ width: 1, backgroundColor: '#EFF6FF' }} />
            <TouchableOpacity onPress={() => onChange('')} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 10 }}>
              <Ionicons name="trash-outline" size={14} color="#DC2626" />
              <Text style={{ fontSize: 12, fontWeight: '700', color: '#DC2626' }}>Remove</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity onPress={pickFromGallery} disabled={uploading} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 16, borderRadius: 12, borderWidth: 1.5, borderColor: '#E5E7EB', borderStyle: 'dashed', backgroundColor: 'rgba(37,99,235,0.04)' }}>
            {uploading ? <ActivityIndicator size="small" color="#2563EB" /> : (<><Ionicons name="image-outline" size={18} color="#2563EB" /><Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>Gallery</Text></>)}
          </TouchableOpacity>
          <TouchableOpacity onPress={takePhoto} disabled={uploading} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 16, borderRadius: 12, borderWidth: 1.5, borderColor: '#E5E7EB', borderStyle: 'dashed', backgroundColor: 'rgba(37,99,235,0.04)' }}>
            <Ionicons name="camera-outline" size={18} color="#2563EB" />
            <Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>Camera</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ─── Date Picker Input ────────────────────────────────────────────────────────
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function DatePickerInput({ label, value, onChange, required }: { label: string; value: string; onChange: (v: string) => void; required?: boolean }) {
  const [open, setOpen] = useState(false);
  const now = new Date();
  const parsed = value && /\d{4}-\d{2}-\d{2}/.test(value) ? new Date(value + 'T12:00:00') : null;
  const [selYear,  setSelYear]  = useState(parsed ? parsed.getFullYear()  : now.getFullYear());
  const [selMonth, setSelMonth] = useState(parsed ? parsed.getMonth()     : now.getMonth());
  const [selDay,   setSelDay]   = useState(parsed ? parsed.getDate()      : now.getDate());
  const daysInMonth = new Date(selYear, selMonth + 1, 0).getDate();
  const days  = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const years = Array.from({ length: 31 }, (_, i) => now.getFullYear() - 10 + i);
  const onDone = () => {
    const d = Math.min(selDay, daysInMonth);
    onChange(`${selYear}-${String(selMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    setOpen(false);
  };
  const displayValue = value ? (() => { try { const [y, m, d] = value.split('-').map(Number); return `${d} ${MONTH_NAMES[m - 1]?.slice(0, 3) || ''} ${y}`; } catch { return value; } })() : '';
  return (
    <View style={{ marginBottom: 12 }}>
      <View style={{ flexDirection: 'row' }}>
        <Lbl>{label}</Lbl>
        {required && <Text style={{ fontSize: 12, color: '#DC2626', marginLeft: 2 }}>*</Text>}
      </View>
      <TouchableOpacity onPress={() => setOpen(true)} style={{ backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E5E7EB', paddingHorizontal: 12, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Ionicons name="calendar-outline" size={16} color={value ? '#2563EB' : '#6B7280'} />
        <Text style={{ flex: 1, fontSize: 14, color: value ? '#111827' : '#6B7280' }}>{displayValue || 'Select date…'}</Text>
        {!!value && (
          <TouchableOpacity onPress={() => onChange('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={16} color="#6B7280" />
          </TouchableOpacity>
        )}
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(30,18,48,0.5)', justifyContent: 'flex-end' }} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={{ backgroundColor: '#F8FAFC', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 44 }} onStartShouldSetResponder={() => true}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(37,99,235,0.2)', alignSelf: 'center', marginTop: 12, marginBottom: 4 }} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: '#111827' }}>{label}</Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity onPress={() => setOpen(false)} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 10, backgroundColor: '#EFF6FF' }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#556274' }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={onDone} style={{ paddingHorizontal: 16, paddingVertical: 7, borderRadius: 10, backgroundColor: '#2563EB' }}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: '#fff' }}>Done</Text>
                </TouchableOpacity>
              </View>
            </View>
            <View style={{ alignItems: 'center', paddingVertical: 10, backgroundColor: '#EFF6FF' }}>
              <Text style={{ fontSize: 18, fontWeight: '900', color: '#2563EB' }}>{String(Math.min(selDay, daysInMonth)).padStart(2,'0')} {MONTH_NAMES[selMonth]?.slice(0,3)} {selYear}</Text>
            </View>
            <View style={{ flexDirection: 'row', paddingHorizontal: 8, paddingTop: 8, height: 220 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 10, fontWeight: '800', color: '#6B7280', textAlign: 'center', marginBottom: 6, letterSpacing: 1 }}>DAY</Text>
                <ScrollView showsVerticalScrollIndicator={false}>
                  {days.map(d => (
                    <TouchableOpacity key={d} onPress={() => setSelDay(d)} style={{ paddingVertical: 11, alignItems: 'center', borderRadius: 10, marginBottom: 2, marginHorizontal: 2, backgroundColor: selDay === d ? '#2563EB' : 'transparent' }}>
                      <Text style={{ fontSize: 16, fontWeight: selDay === d ? '800' : '500', color: selDay === d ? '#fff' : '#111827' }}>{String(d).padStart(2, '0')}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
              <View style={{ flex: 2.2 }}>
                <Text style={{ fontSize: 10, fontWeight: '800', color: '#6B7280', textAlign: 'center', marginBottom: 6, letterSpacing: 1 }}>MONTH</Text>
                <ScrollView showsVerticalScrollIndicator={false}>
                  {MONTH_NAMES.map((m, idx) => (
                    <TouchableOpacity key={m} onPress={() => setSelMonth(idx)} style={{ paddingVertical: 11, alignItems: 'center', borderRadius: 10, marginBottom: 2, marginHorizontal: 2, backgroundColor: selMonth === idx ? '#2563EB' : 'transparent' }}>
                      <Text style={{ fontSize: 16, fontWeight: selMonth === idx ? '800' : '500', color: selMonth === idx ? '#fff' : '#111827' }}>{m}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
              <View style={{ flex: 1.4 }}>
                <Text style={{ fontSize: 10, fontWeight: '800', color: '#6B7280', textAlign: 'center', marginBottom: 6, letterSpacing: 1 }}>YEAR</Text>
                <ScrollView showsVerticalScrollIndicator={false}>
                  {years.map(y => (
                    <TouchableOpacity key={y} onPress={() => setSelYear(y)} style={{ paddingVertical: 11, alignItems: 'center', borderRadius: 10, marginBottom: 2, marginHorizontal: 2, backgroundColor: selYear === y ? '#2563EB' : 'transparent' }}>
                      <Text style={{ fontSize: 16, fontWeight: selYear === y ? '800' : '500', color: selYear === y ? '#fff' : '#111827' }}>{y}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}
// ─── ASSET DETAIL MODAL (Overview / Payments / Flow) ──────────────────────────
function DKV({ k, v, vColor }: { k: string; v: string; vColor?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
      <Text style={{ fontSize: 12, color: '#6B7280', fontWeight: '600' }}>{k}</Text>
      <Text style={{ fontSize: 13, color: vColor || '#111827', fontWeight: '700', flex: 1, textAlign: 'right' }} numberOfLines={2}>{v}</Text>
    </View>
  );
}
function DSection({ title, right, children }: any) {
  return (
    <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#E5E7EB' }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827' }}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

function AssetDetailModal({ visible, onClose, assetId, onQR, onChanged }: any) {
  const [loading, setLoading] = useState(true);
  const [d, setD] = useState<any>(null);
  const [tab, setTab] = useState<'overview' | 'payments' | 'flow'>('overview');
  const [payOpen, setPayOpen] = useState(false);
  const [payForm, setPayForm] = useState<any>({ amount: '', paymentDate: new Date().toISOString().split('T')[0], paymentMode: '', referenceNumber: '', notes: '' });
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveForm, setMoveForm] = useState<any>({ moveDate: new Date().toISOString().split('T')[0], fromLocation: '', toLocation: '', reason: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!assetId) return;
    setLoading(true);
    try { setD(await sb.getAssetDetail(assetId)); }
    catch { setD(null); }
    finally { setLoading(false); }
  }, [assetId]);

  useEffect(() => { if (visible && assetId) { setTab('overview'); setPayOpen(false); setMoveOpen(false); load(); } }, [visible, assetId, load]);

  const savePayment = async () => {
    const amt = parseFloat(payForm.amount) || 0;
    if (amt <= 0) { Alert.alert('Validation', 'Enter a valid amount.'); return; }
    setSaving(true);
    try {
      await sb.recordAssetPayment({ assetId, amount: amt, paymentDate: payForm.paymentDate, paymentMode: payForm.paymentMode || null, referenceNumber: payForm.referenceNumber || null, notes: payForm.notes || null });
      setPayOpen(false); setPayForm({ amount: '', paymentDate: new Date().toISOString().split('T')[0], paymentMode: '', referenceNumber: '', notes: '' });
      await load(); onChanged?.();
    } catch (e: any) { Alert.alert('Error', e.message || 'Could not record payment.'); }
    finally { setSaving(false); }
  };
  const saveMovement = async () => {
    if (!moveForm.toLocation) { Alert.alert('Validation', 'Enter a destination location.'); return; }
    setSaving(true);
    try {
      await sb.recordAssetMovement({ assetId, moveDate: moveForm.moveDate, fromLocation: moveForm.fromLocation || null, toLocation: moveForm.toLocation, reason: moveForm.reason || null });
      setMoveOpen(false); setMoveForm({ moveDate: new Date().toISOString().split('T')[0], fromLocation: '', toLocation: '', reason: '' });
      await load(); onChanged?.();
    } catch (e: any) { Alert.alert('Error', e.message || 'Could not record movement.'); }
    finally { setSaving(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#FAF7FC' }} edges={['top']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 12, fontWeight: '800', color: '#2563EB' }}>{d?.assetCode || 'Asset'}</Text>
            <Text style={{ fontSize: 17, fontWeight: '800', color: '#111827' }} numberOfLines={1}>{d?.typeName || 'Asset Detail'}</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {!!d && (
              <TouchableOpacity onPress={() => onQR?.(d)} style={{ padding: 8, backgroundColor: '#EFF6FF', borderRadius: 999 }}>
                <Ionicons name="qr-code-outline" size={18} color="#2563EB" />
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={onClose} style={{ padding: 8, backgroundColor: '#EFF6FF', borderRadius: 999 }}>
              <Ionicons name="close" size={18} color="#556274" />
            </TouchableOpacity>
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}>
          {([{ k: 'overview', label: 'Overview' }, { k: 'payments', label: `Payments${d?.payments?.length ? ` (${d.payments.length})` : ''}` }, { k: 'flow', label: 'Flow' }] as const).map(t => (
            <TouchableOpacity key={t.k} onPress={() => setTab(t.k as any)} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: tab === t.k ? '#2563EB' : 'rgba(37,99,235,0.1)' }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: tab === t.k ? '#fff' : '#2563EB' }}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator size="large" color="#2563EB" /><Text style={{ marginTop: 12, color: '#6B7280' }}>Loading asset…</Text></View>
        ) : !d ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}><Ionicons name="alert-circle-outline" size={48} color="#DC2626" /><Text style={{ marginTop: 12, color: '#556274', textAlign: 'center' }}>Could not load asset detail.</Text></View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
            {tab === 'overview' && (<>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#E5E7EB' }}>
                  <Ionicons name="cash-outline" size={18} color="#16a34a" />
                  <Text style={{ fontSize: 15, fontWeight: '900', color: '#16a34a', marginTop: 4 }}>{fmtFull(d.purchasePrice)}</Text>
                  <Text style={{ fontSize: 10, color: '#6B7280' }}>Purchase Price</Text>
                </View>
                <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#E5E7EB' }}>
                  <Ionicons name="shield-checkmark-outline" size={18} color={d.warrantyActive ? '#16a34a' : '#DC2626'} />
                  <Text style={{ fontSize: 15, fontWeight: '900', color: d.warrantyActive ? '#16a34a' : '#DC2626', marginTop: 4 }}>{d.warrantyActive ? `${d.warrantyMonthsLeft ?? ''}m` : 'Expired'}</Text>
                  <Text style={{ fontSize: 10, color: '#6B7280' }}>Warranty</Text>
                </View>
                <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#E5E7EB' }}>
                  <Ionicons name="construct-outline" size={18} color="#2563EB" />
                  <Text style={{ fontSize: 15, fontWeight: '900', color: '#2563EB', marginTop: 4 }}>{d.maintenance?.length || 0}</Text>
                  <Text style={{ fontSize: 10, color: '#6B7280' }}>Maint. Records</Text>
                </View>
              </View>

              {d.purchasePrice > 0 && (
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                  <View style={{ flex: 1, backgroundColor: '#EFF6FF', borderRadius: 12, padding: 12 }}>
                    <Text style={{ fontSize: 10, color: '#2563EB', fontWeight: '800' }}>PAID</Text>
                    <Text style={{ fontSize: 15, fontWeight: '900', color: '#2563EB' }}>{fmtFull(d.totalPaid)}</Text>
                  </View>
                  <View style={{ flex: 1, backgroundColor: d.balanceDue > 0 ? '#FEE2E2' : '#DCFCE7', borderRadius: 12, padding: 12 }}>
                    <Text style={{ fontSize: 10, color: d.balanceDue > 0 ? '#DC2626' : '#16a34a', fontWeight: '800' }}>BALANCE DUE</Text>
                    <Text style={{ fontSize: 15, fontWeight: '900', color: d.balanceDue > 0 ? '#DC2626' : '#16a34a' }}>{fmtFull(d.balanceDue)}</Text>
                  </View>
                </View>
              )}

              <DSection title="Asset Details">
                <DKV k="Asset Code" v={d.assetCode || '—'} />
                <DKV k="Type" v={d.typeName || '—'} />
                <DKV k="Category" v={d.categoryName || '—'} />
                <DKV k="Brand / Model" v={[d.brand, d.model].filter(Boolean).join(' ') || '—'} />
                <DKV k="Serial Number" v={d.serialNumber || '—'} />
                <DKV k="Condition" v={d.condition || '—'} />
                <DKV k="Status" v={d.status || '—'} />
                <DKV k="Purchase Date" v={fmtDate(d.purchaseDate)} />
                <DKV k="Warranty" v={d.warrantyMonths ? `${d.warrantyMonths} months` : '—'} />
                {!!d.warrantyExpiry && <DKV k="Warranty Expires" v={fmtDate(d.warrantyExpiry)} />}
                {!!d.invoiceNumber && <DKV k="Invoice No." v={d.invoiceNumber} />}
                {!!d.invoiceDate && <DKV k="Invoice Date" v={fmtDate(d.invoiceDate)} />}
                {!!d.notes && <DKV k="Notes" v={d.notes} />}
              </DSection>

              {(d.vendor || d.vendorNameManual) && (
                <DSection title="Vendor">
                  <DKV k="Name" v={d.vendor?.name || d.vendorNameManual || '—'} />
                  {!!d.vendor?.phone && <DKV k="Phone" v={d.vendor.phone} />}
                  {!!d.vendor?.email && <DKV k="Email" v={d.vendor.email} />}
                  {!!d.vendor?.gst && <DKV k="GST" v={d.vendor.gst} />}
                </DSection>
              )}

              {d.lifetimePercent != null && (
                <DSection title="Lifetime Usage">
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                    <Text style={{ fontSize: 12, color: '#6B7280' }}>{d.ageMonths} mo used{d.expectedLifeMonths ? ` of ${d.expectedLifeMonths} mo` : ''}</Text>
                    <Text style={{ fontSize: 12, fontWeight: '800', color: '#2563EB' }}>{d.lifetimePercent}%</Text>
                  </View>
                  <View style={{ height: 8, backgroundColor: '#F3F4F6', borderRadius: 4 }}>
                    <View style={{ width: `${Math.min(100, d.lifetimePercent)}%`, height: '100%', backgroundColor: d.lifetimePercent >= 90 ? '#DC2626' : '#2563EB', borderRadius: 4 }} />
                  </View>
                </DSection>
              )}

              <DSection title="Current Allocation">
                {d.allocation ? (<>
                  <DKV k="Type" v={d.allocation.type || '—'} />
                  {!!d.allocation.property && <DKV k="Property" v={d.allocation.property} />}
                  {!!d.allocation.apartment && <DKV k="Apartment" v={d.allocation.apartment} />}
                  {!!d.allocation.bed && <DKV k="Bed" v={d.allocation.bed} />}
                  <DKV k="Allocation Date" v={fmtDate(d.allocation.date)} vColor="#2563EB" />
                </>) : <Text style={{ fontSize: 12, color: '#6B7280' }}>Not currently allocated</Text>}
              </DSection>

              <DSection title="Maintenance History" right={<Text style={{ fontSize: 11, fontWeight: '700', color: '#2563EB' }}>Total: {fmtFull(d.totalMaintenanceCost)}</Text>}>
                {(!d.maintenance || d.maintenance.length === 0) ? <Text style={{ fontSize: 12, color: '#6B7280' }}>No maintenance records</Text>
                  : d.maintenance.map((m: any) => (
                    <View key={m.id} style={{ borderTopWidth: 1, borderTopColor: 'rgba(37,99,235,0.06)', paddingVertical: 8 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: '#111827' }}>{m.type || 'Service'}</Text>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: '#16a34a' }}>{fmtFull(m.cost)}</Text>
                      </View>
                      <Text style={{ fontSize: 11, color: '#6B7280' }}>{fmtDate(m.date)}{m.vendor ? ` · ${m.vendor}` : ''}</Text>
                      {!!m.issue && <Text style={{ fontSize: 12, color: '#556274', marginTop: 2 }}>{m.issue}</Text>}
                    </View>
                  ))}
              </DSection>
            </>)}

            {tab === 'payments' && (
              <DSection title="Payments" right={
                <TouchableOpacity onPress={() => setPayOpen(!payOpen)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: '#EFF6FF' }}>
                  <Ionicons name={payOpen ? 'close' : 'add'} size={14} color="#2563EB" /><Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>{payOpen ? 'Cancel' : 'Record'}</Text>
                </TouchableOpacity>
              }>
                {payOpen && (
                  <View style={{ marginBottom: 12 }}>
                    <Inp label="Amount (₹)" value={payForm.amount} onChange={(v: string) => setPayForm({ ...payForm, amount: v })} num required />
                    <Lbl>Payment Mode</Lbl>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                      {PAYMENT_MODES.map(pm => (
                        <TouchableOpacity key={pm.value} onPress={() => setPayForm({ ...payForm, paymentMode: pm.value })} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1.5, borderColor: payForm.paymentMode === pm.value ? '#2563EB' : 'rgba(37,99,235,0.2)', backgroundColor: payForm.paymentMode === pm.value ? '#2563EB' : 'transparent' }}>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: payForm.paymentMode === pm.value ? '#fff' : '#2563EB' }}>{pm.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    <Inp label="Reference" value={payForm.referenceNumber} onChange={(v: string) => setPayForm({ ...payForm, referenceNumber: v })} placeholder="UTR / Ref no." />
                    <TouchableOpacity onPress={savePayment} disabled={saving} style={{ backgroundColor: '#2563EB', borderRadius: 10, paddingVertical: 12, alignItems: 'center', opacity: saving ? 0.6 : 1 }}>
                      {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>Save Payment</Text>}
                    </TouchableOpacity>
                  </View>
                )}
                {(!d.payments || d.payments.length === 0) ? <Text style={{ fontSize: 12, color: '#6B7280' }}>No payments recorded</Text>
                  : d.payments.map((p: any) => (
                    <View key={p.id} style={{ borderTopWidth: 1, borderTopColor: 'rgba(37,99,235,0.06)', paddingVertical: 8, flexDirection: 'row', justifyContent: 'space-between' }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: '#111827' }}>{fmtDate(p.date)}</Text>
                        <Text style={{ fontSize: 11, color: '#6B7280' }}>{(p.mode || '').toUpperCase()}{p.reference ? ` · ${p.reference}` : ''}{p.vendor ? ` · ${p.vendor}` : ''}</Text>
                        {!!p.notes && <Text style={{ fontSize: 11, color: '#556274' }}>{p.notes}</Text>}
                      </View>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: '#16a34a' }}>{fmtFull(p.amount)}</Text>
                    </View>
                  ))}
              </DSection>
            )}

            {tab === 'flow' && (<>
              <DSection title="Movement / Flow History" right={
                <TouchableOpacity onPress={() => setMoveOpen(!moveOpen)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: '#EFF6FF' }}>
                  <Ionicons name={moveOpen ? 'close' : 'add'} size={14} color="#2563EB" /><Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>{moveOpen ? 'Cancel' : 'Record'}</Text>
                </TouchableOpacity>
              }>
                {moveOpen && (
                  <View style={{ marginBottom: 12 }}>
                    <Inp label="From Location" value={moveForm.fromLocation} onChange={(v: string) => setMoveForm({ ...moveForm, fromLocation: v })} placeholder="Current location" />
                    <Inp label="To Location" value={moveForm.toLocation} onChange={(v: string) => setMoveForm({ ...moveForm, toLocation: v })} placeholder="Destination" required />
                    <Inp label="Reason" value={moveForm.reason} onChange={(v: string) => setMoveForm({ ...moveForm, reason: v })} placeholder="Reason for move" />
                    <TouchableOpacity onPress={saveMovement} disabled={saving} style={{ backgroundColor: '#2563EB', borderRadius: 10, paddingVertical: 12, alignItems: 'center', opacity: saving ? 0.6 : 1 }}>
                      {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>Save Movement</Text>}
                    </TouchableOpacity>
                  </View>
                )}
                {(!d.movements || d.movements.length === 0) ? <Text style={{ fontSize: 12, color: '#6B7280' }}>No movement records</Text>
                  : d.movements.map((m: any) => (
                    <View key={m.id} style={{ borderTopWidth: 1, borderTopColor: 'rgba(37,99,235,0.06)', paddingVertical: 8 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: '#111827' }}>{m.from || '—'}</Text>
                        <Ionicons name="arrow-forward" size={12} color="#2563EB" />
                        <Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>{m.to || '—'}</Text>
                      </View>
                      <Text style={{ fontSize: 11, color: '#6B7280' }}>{fmtDate(m.date)}{m.reason ? ` · ${m.reason}` : ''}</Text>
                    </View>
                  ))}
              </DSection>
              {d.allocations?.length > 0 && (
                <DSection title="Allocation History">
                  {d.allocations.map((al: any) => (
                    <View key={al.id} style={{ borderTopWidth: 1, borderTopColor: 'rgba(37,99,235,0.06)', paddingVertical: 8, flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#111827' }}>{[al.property, al.apartment, al.bed].filter(Boolean).join(' · ') || al.type}</Text>
                      <Text style={{ fontSize: 11, color: '#6B7280' }}>{fmtDate(al.date)}</Text>
                    </View>
                  ))}
                </DSection>
              )}
            </>)}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ─── ASSET PAYMENTS TAB (view-based, web parity) ──────────────────────────────
const normalizeInvoiceDate = (dt: string | null) => (dt || '').slice(0, 10);
function purchaseInvoiceGroupKey(r: any): string {
  const inv = (r.invoiceNumber ?? '').trim();
  if (!inv) return `__noinv__|${r.assetId ?? ''}`;
  return [r.supplierId ?? '', inv.toLowerCase(), normalizeInvoiceDate(r.invoiceDate)].join('|');
}
function aggregateSplitOrDuplicate(values: number[]): number {
  if (values.length === 0) return 0;
  const EPS = 0.02; const max = Math.max(...values); const min = Math.min(...values);
  if (max - min <= EPS) return max;
  return values.reduce((a, b) => a + b, 0);
}
function worstPaymentStatus(rows: any[]): string {
  if (rows.some((r) => r.status === 'unpaid')) return 'unpaid';
  if (rows.some((r) => r.status === 'partial')) return 'partial';
  return 'paid';
}
const PAY_STATUS_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  unpaid:  { label: 'Unpaid',  color: '#9F1239', bg: '#FFE4E6' },
  partial: { label: 'Partial', color: '#92400E', bg: '#FEF3C7' },
  paid:    { label: 'Paid',    color: '#065F46', bg: '#D1FAE5' },
};

function AssetPaymentsTab() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<any[]>([]);
  const [banks, setBanks] = useState<any[]>([]);
  const [statusFilter, setStatusFilter] = useState<'all' | 'unpaid' | 'partial' | 'paid'>('all');
  const [vendorFilter, setVendorFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const emptyForm = { assetId: '', assetCode: '', vendorId: '', paymentDate: new Date().toISOString().split('T')[0], amount: '', paymentMode: '', bankAccountId: '', referenceNumber: '', notes: '', balanceDue: 0 };
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<any>(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, b] = await Promise.all([sb.listAssetPaymentStatus().catch(() => []), sb.listAssetBankAccounts().catch(() => [])]);
      setRows(r || []); setBanks(b || []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => {
    const byKey = new Map<string, any[]>();
    for (const r of rows) { const k = purchaseInvoiceGroupKey(r); const arr = byKey.get(k) || []; arr.push(r); byKey.set(k, arr); }
    const out: any[] = [];
    byKey.forEach((grp, groupKey) => {
      const lead = grp[0];
      const displayPurchase = aggregateSplitOrDuplicate(grp.map((r) => r.purchasePrice));
      const displayPaid = aggregateSplitOrDuplicate(grp.map((r) => r.totalPaid));
      out.push({ groupKey, rows: grp, lead, displayPurchase, displayPaid, displayDue: Math.max(0, displayPurchase - displayPaid), displayStatus: worstPaymentStatus(grp) });
    });
    return out;
  }, [rows]);

  const filteredGroups = useMemo(() => {
    let g = groups;
    if (statusFilter !== 'all') g = g.filter((x) => x.displayStatus === statusFilter);
    if (vendorFilter !== 'all') g = g.filter((x) => (x.lead.vendorName || '—') === vendorFilter);
    if (search) { const s = search.toLowerCase(); g = g.filter((x) => x.rows.some((r: any) => [r.assetCode, r.vendorName, r.invoiceNumber].some((v: any) => v && String(v).toLowerCase().includes(s)))); }
    return g;
  }, [groups, statusFilter, vendorFilter, search]);

  const totals = useMemo(() => {
    let purchase = 0, paid = 0, due = 0;
    for (const g of filteredGroups) { purchase += g.displayPurchase; paid += g.displayPaid; due += g.displayDue; }
    return { purchase, paid, due };
  }, [filteredGroups]);

  const vendorOptions = useMemo(() => { const set = new Set<string>(); rows.forEach((r) => set.add(r.vendorName || '—')); return ['all', ...Array.from(set).sort()]; }, [rows]);
  const bankAccountOptions = useMemo(() => banks.map((b: any) => ({ label: `${b.bankName}${b.ifsc ? ` (${b.ifsc})` : ''} — ****${String(b.accountNumber).slice(-4)}${b.isPrimary ? ' • Primary' : ''}`, value: b.id })), [banks]);

  const openRecord = (g: any) => { setForm({ ...emptyForm, assetId: g.lead.assetId, assetCode: g.lead.assetCode, vendorId: g.lead.supplierId || '', balanceDue: g.displayDue, amount: g.displayDue > 0 ? String(Math.round(g.displayDue)) : '' }); setFormOpen(true); };
  const savePayment = async () => {
    const amt = parseFloat(form.amount);
    if (!form.assetId) { Alert.alert('Validation', 'Asset is required.'); return; }
    if (!Number.isFinite(amt) || amt <= 0) { Alert.alert('Validation', 'Amount must be greater than 0.'); return; }
    if (form.paymentMode && form.paymentMode !== 'cash' && !form.bankAccountId) { Alert.alert('Validation', 'Bank account is required when payment mode is not cash.'); return; }
    setSaving(true);
    try {
      await sb.recordAssetPayment({ assetId: form.assetId, vendorId: form.vendorId || null, paymentDate: form.paymentDate, amount: amt, paymentMode: form.paymentMode || null, bankAccountId: form.bankAccountId || null, referenceNumber: form.referenceNumber || null, notes: form.notes || null });
      setFormOpen(false); setForm(emptyForm); await load();
    } catch (e: any) { Alert.alert('Error', e.message || 'Could not record payment.'); }
    finally { setSaving(false); }
  };

  if (loading) return <View style={{ alignItems: 'center', paddingVertical: 48 }}><ActivityIndicator size="large" color="#2563EB" /><Text style={{ marginTop: 12, color: '#6B7280' }}>Loading asset payments…</Text></View>;

  return (
    <View>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#E5E7EB' }}>
          <Text style={{ fontSize: 10, color: '#6B7280', fontWeight: '800', textTransform: 'uppercase' }}>Purchase</Text>
          <Text style={{ fontSize: 15, fontWeight: '900', color: '#111827', marginTop: 4 }}>{fmtShort(totals.purchase)}</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#E5E7EB' }}>
          <Text style={{ fontSize: 10, color: '#16a34a', fontWeight: '800', textTransform: 'uppercase' }}>Paid</Text>
          <Text style={{ fontSize: 15, fontWeight: '900', color: '#16a34a', marginTop: 4 }}>{fmtShort(totals.paid)}</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#E5E7EB' }}>
          <Text style={{ fontSize: 10, color: '#DC2626', fontWeight: '800', textTransform: 'uppercase' }}>Due</Text>
          <Text style={{ fontSize: 15, fontWeight: '900', color: '#DC2626', marginTop: 4 }}>{fmtShort(totals.due)}</Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#E5E7EB', paddingHorizontal: 10, marginBottom: 10 }}>
        <Ionicons name="search-outline" size={16} color="#6B7280" />
        <TextInput value={search} onChangeText={setSearch} placeholder="Search asset, vendor, invoice…" placeholderTextColor="#6B7280" style={{ flex: 1, paddingVertical: 10, paddingLeft: 6, fontSize: 14, color: '#111827' }} />
        {!!search && <TouchableOpacity onPress={() => setSearch('')}><Ionicons name="close-circle" size={16} color="#6B7280" /></TouchableOpacity>}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['all', 'unpaid', 'partial', 'paid'] as const).map(s => (
            <TouchableOpacity key={s} onPress={() => setStatusFilter(s)} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: statusFilter === s ? '#2563EB' : 'rgba(37,99,235,0.1)' }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: statusFilter === s ? '#fff' : '#2563EB', textTransform: 'capitalize' }}>{s}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      {vendorOptions.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {vendorOptions.map(vn => (
              <TouchableOpacity key={vn} onPress={() => setVendorFilter(vn)} style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1.5, borderColor: vendorFilter === vn ? '#2563EB' : 'rgba(37,99,235,0.2)', backgroundColor: vendorFilter === vn ? '#2563EB' : 'transparent' }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: vendorFilter === vn ? '#fff' : '#2563EB' }}>{vn === 'all' ? 'All Vendors' : vn}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      )}

      {filteredGroups.length === 0 ? (
        <View style={{ alignItems: 'center', paddingVertical: 48 }}>
          <Ionicons name="cash-outline" size={52} color="#e0d9ec" />
          <Text style={{ fontSize: 16, fontWeight: '800', color: '#111827', marginTop: 12 }}>No asset payments</Text>
          <Text style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>Assets with a purchase price appear here</Text>
        </View>
      ) : (
        filteredGroups.map((g) => {
          const badge = PAY_STATUS_BADGE[g.displayStatus] || PAY_STATUS_BADGE.unpaid;
          const isMulti = g.rows.length > 1;
          const expanded = expandedKey === g.groupKey;
          return (
            <View key={g.groupKey} style={{ backgroundColor: '#fff', borderRadius: 14, marginBottom: 10, padding: 14, borderWidth: 1, borderColor: '#E5E7EB' }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Text style={{ fontSize: 13, fontWeight: '800', color: '#2563EB' }}>{isMulti ? `${g.rows.length} assets` : g.lead.assetCode}</Text>
                    <View style={{ backgroundColor: badge.bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}><Text style={{ fontSize: 10, fontWeight: '800', color: badge.color }}>{badge.label}</Text></View>
                  </View>
                  <Text style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>{g.lead.vendorName || '—'}{g.lead.invoiceNumber ? ` · Inv ${g.lead.invoiceNumber}` : ''}</Text>
                  <View style={{ flexDirection: 'row', gap: 14, marginTop: 6 }}>
                    <View><Text style={{ fontSize: 10, color: '#6B7280' }}>Purchase</Text><Text style={{ fontSize: 13, fontWeight: '700', color: '#111827' }}>{fmtFull(g.displayPurchase)}</Text></View>
                    <View><Text style={{ fontSize: 10, color: '#6B7280' }}>Paid</Text><Text style={{ fontSize: 13, fontWeight: '700', color: '#16a34a' }}>{fmtFull(g.displayPaid)}</Text></View>
                    <View><Text style={{ fontSize: 10, color: '#6B7280' }}>Due</Text><Text style={{ fontSize: 13, fontWeight: '700', color: g.displayDue > 0 ? '#DC2626' : '#16a34a' }}>{fmtFull(g.displayDue)}</Text></View>
                  </View>
                </View>
                {g.displayDue > 0 && (
                  <TouchableOpacity onPress={() => openRecord(g)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: '#2563EB' }}>
                    <Ionicons name="add" size={14} color="#fff" /><Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>Pay</Text>
                  </TouchableOpacity>
                )}
              </View>
              {isMulti && (
                <TouchableOpacity onPress={() => setExpandedKey(expanded ? null : g.groupKey)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 }}>
                  <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color="#2563EB" /><Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>{expanded ? 'Hide' : 'Show'} {g.rows.length} linked assets</Text>
                </TouchableOpacity>
              )}
              {isMulti && expanded && (
                <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: '#E5E7EB', paddingTop: 8 }}>
                  {g.rows.map((r: any) => (
                    <View key={r.assetId} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 }}>
                      <Text style={{ fontSize: 12, color: '#111827', fontWeight: '600' }}>{r.assetCode}</Text>
                      <Text style={{ fontSize: 12, color: '#6B7280' }}>{fmtFull(r.purchasePrice)} · paid {fmtFull(r.totalPaid)}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          );
        })
      )}

      <Modal visible={formOpen} animationType="slide" transparent onRequestClose={() => setFormOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(30,18,48,0.45)' }}>
          <View style={{ backgroundColor: '#FAF7FC', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 36, maxHeight: '90%' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: '#111827' }}>Record Payment</Text>
              <TouchableOpacity onPress={() => setFormOpen(false)} style={{ padding: 6, backgroundColor: '#EFF6FF', borderRadius: 999 }}><Ionicons name="close" size={18} color="#556274" /></TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#E5E7EB' }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ fontSize: 13, color: '#6B7280' }}>Asset</Text><Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>{form.assetCode}</Text></View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}><Text style={{ fontSize: 13, color: '#6B7280' }}>Balance Due</Text><Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>{fmtFull(form.balanceDue)}</Text></View>
              </View>
              <Inp label="Amount (₹)" value={form.amount} onChange={(v: string) => setForm({ ...form, amount: v })} num required />
              <DatePickerInput label="Payment Date" value={form.paymentDate} onChange={(v) => setForm({ ...form, paymentDate: v })} required />
              <Lbl>Payment Mode</Lbl>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {PAYMENT_MODES.map(pm => (
                  <TouchableOpacity key={pm.value} onPress={() => setForm({ ...form, paymentMode: pm.value })} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1.5, borderColor: form.paymentMode === pm.value ? '#2563EB' : 'rgba(37,99,235,0.2)', backgroundColor: form.paymentMode === pm.value ? '#2563EB' : 'transparent' }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: form.paymentMode === pm.value ? '#fff' : '#2563EB' }}>{pm.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {form.paymentMode && form.paymentMode !== 'cash' && (
                <>
                  <Lbl>Bank Account *</Lbl>
                  {bankAccountOptions.length === 0 ? <Text style={{ fontSize: 12, color: '#6B7280', marginBottom: 10 }}>No bank accounts found.</Text>
                    : <View style={{ marginBottom: 10 }}>
                        {bankAccountOptions.map(opt => (
                          <TouchableOpacity key={opt.value} onPress={() => setForm({ ...form, bankAccountId: opt.value })} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: form.bankAccountId === opt.value ? '#2563EB' : 'rgba(37,99,235,0.15)', backgroundColor: form.bankAccountId === opt.value ? 'rgba(37,99,235,0.06)' : '#fff', marginBottom: 6 }}>
                            <Ionicons name={form.bankAccountId === opt.value ? 'radio-button-on' : 'radio-button-off'} size={16} color="#2563EB" />
                            <Text style={{ fontSize: 12, color: '#111827', flex: 1 }}>{opt.label}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>}
                </>
              )}
              <Inp label="Reference" value={form.referenceNumber} onChange={(v: string) => setForm({ ...form, referenceNumber: v })} placeholder="UTR / Cheque no." />
              <Inp label="Notes" value={form.notes} onChange={(v: string) => setForm({ ...form, notes: v })} multi placeholder="Optional" />
              <TouchableOpacity onPress={savePayment} disabled={saving} style={{ backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 14, alignItems: 'center', opacity: saving ? 0.6 : 1 }}>
                {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ fontSize: 15, fontWeight: '800', color: '#fff' }}>Save Payment</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
// ═══════════════════════════════════════════════════════════════════════════
//  MAIN SCREEN
// ═══════════════════════════════════════════════════════════════════════════
const TABS = [
  { key: 'inventory',   label: 'Inventory',      icon: 'cube-outline' },
  { key: 'payments',    label: 'Asset Payments', icon: 'cash-outline' },
  { key: 'vendors',     label: 'Vendors',        icon: 'people-outline' },
  { key: 'allocations', label: 'Allocations',    icon: 'location-outline' },
  { key: 'categories',  label: 'Categories',     icon: 'folder-outline' },
  { key: 'analytics',   label: 'Analytics',      icon: 'bar-chart-outline' },
  { key: 'forecasts',   label: 'Forecasts',      icon: 'trending-up-outline' },
];

export default function AssetsScreen() {
  const navigation = useNavigation<any>();
  const mountedRef = useMountedRef();
  const { token, user } = useAuth() as any;

  // data
  const [stats,       setStats]       = useState<any>(EMPTY_STATS);
  const [assets,      setAssets]      = useState<any[]>([]);
  const [categories,  setCategories]  = useState<any[]>([]);
  const [types,       setTypes]       = useState<any[]>([]);
  const [vendors,     setVendors]     = useState<any[]>([]);
  const [allocations, setAllocations] = useState<any[]>([]);
  const [properties,  setProperties]  = useState<any[]>([]);
  const [apartments,  setApartments]  = useState<any[]>([]);
  const [beds,        setBeds]        = useState<any[]>([]);
  const [brands,      setBrands]      = useState<any[]>([]);
  const [forecasts,   setForecasts]   = useState<any[]>([]);
  const [remarks,     setRemarks]     = useState<any[]>([]);

  // ui
  const [activeTab,    setActiveTab]    = useState('inventory');
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [fetchError,   setFetchError]   = useState('');
  const [search,       setSearch]       = useState('');
  const [typeFilter,   setTypeFilter]   = useState('all');
  const [vendorSearch, setVendorSearch] = useState('');
  const [visibleTabKeys, setVisibleTabKeys] = useState<Set<string> | null>(null);
  // Inventory paging — avoids blocking the JS thread rendering ~1700 cards at once.
  const ASSET_PAGE = 30;
  const [assetLimit, setAssetLimit] = useState(ASSET_PAGE);
  // Reset the visible window whenever the filter/search narrows the list.
  useEffect(() => { setAssetLimit(ASSET_PAGE); }, [search, typeFilter, activeTab]);

  // modals
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  const [editAsset,      setEditAsset]      = useState<any>(null);
  const [vendorModalOpen,setVendorModalOpen]= useState(false);
  const [editVendor,     setEditVendor]     = useState<any>(null);
  const [allocOpen,      setAllocOpen]      = useState(false);
  const [allocAsset,     setAllocAsset]     = useState<any>(null);
  const [editAllocInit,  setEditAllocInit]  = useState<any>(null);
  const [qrOpen,         setQrOpen]         = useState(false);
  const [qrAsset,        setQrAsset]        = useState<any>(null);
  const [detailOpen,     setDetailOpen]     = useState(false);
  const [detailAssetId,  setDetailAssetId]  = useState<string | null>(null);
  const [vendorDetailOpen, setVendorDetailOpen] = useState(false);
  const [vendorDetail,     setVendorDetail]     = useState<any>(null);
  const [catOpen,   setCatOpen]   = useState(false);
  const [typeOpen,  setTypeOpen]  = useState(false);
  const [typeCatId, setTypeCatId] = useState('');
  const [editTypeOpen, setEditTypeOpen] = useState(false);
  const [editTypeData, setEditTypeData] = useState<any>(null);
  const [brandOpen, setBrandOpen] = useState(false);

  // ── tab permissions ──
  useEffect(() => {
    if (!user?.role) return;
    fetchVisibleTabKeys(user.role, 'Assets').then(keys => { if (mountedRef.current) setVisibleTabKeys(keys); }).catch(() => {});
  }, [user?.role]);

  // ── fetch ──
  const fetchAll = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setFetchError('');
    try {
      const [rStats, rAssets, rCats, rTypes, rVendors] = await allSettled([
        sb.getAssetStats(), sb.listAssets(), sb.listCategories(), sb.listTypes(), sb.listVendors(),
      ]);
      if (!mountedRef.current) return;
      const v = (r: any, fb: any) => r.status === 'fulfilled' ? (r.value ?? fb) : fb;
      setStats(v(rStats, EMPTY_STATS));
      setAssets(v(rAssets, []));
      setCategories(v(rCats, []));
      setTypes(v(rTypes, []));
      setVendors(v(rVendors, []));
      if ([rStats, rAssets, rCats, rTypes, rVendors].every(r => r.status === 'rejected'))
        setFetchError('Could not load assets. Pull to refresh.');
    } finally {
      if (mountedRef.current) { setLoading(false); setRefreshing(false); }
    }
    loadSecondary();
  }, []);

  const loadSecondary = useCallback(async () => {
    const [rAlloc, rProps, rApts, rBeds, rBrands, rForecasts] = await allSettled([
      sb.listAllocations(), sb.listProperties(), sb.listApartments(), sb.listBeds(), sb.listBrands(), sb.listForecasts(),
    ]);
    if (!mountedRef.current) return;
    const v = (r: any, fb: any) => r.status === 'fulfilled' ? (r.value ?? fb) : fb;
    setAllocations(v(rAlloc, []));
    setProperties(v(rProps, []));
    setApartments(v(rApts, []));
    setBeds(v(rBeds, []));
    setBrands(v(rBrands, []));
    setForecasts(v(rForecasts, []));
  }, []);

  useFocusEffect(useCallback(() => { fetchAll(); }, [fetchAll]));

  // ── handlers ──
  const handleAddAsset = async (f: any) => {
    await sb.createAsset({
      assetTypeId: f.assetTypeId, brand: f.brand, model: f.model, serialNumber: f.serialNumber,
      purchasePrice: f.purchasePrice ? parseFloat(f.purchasePrice) : null, purchaseDate: f.purchaseDate || null,
      warrantyMonths: f.warrantyMonths ? parseInt(f.warrantyMonths) : null,
      invoiceNumber: f.invoiceNumber || null, invoiceDate: f.invoiceDate || null, invoiceUrl: f.invoiceUrl || null,
      capacityValue: f.capacityValue || null, capacityUnit: f.capacityUnit || null,
      condition: f.condition, status: f.status, notes: f.notes || null,
      supplierId: f.isGeneralVendor ? null : (f.supplierId || null),
      vendorNameManual: f.isGeneralVendor ? f.vendorNameManual : null,
      productPhotoUrl: f.productPhotoUrl || null,
    });
    setAssetModalOpen(false); setEditAsset(null); fetchAll(true);
  };
  const handleEditAsset = async (f: any) => {
    // Recompute warranty_expiry from purchaseDate + warrantyMonths (mirrors createAsset derivation)
    const wMonths = f.warrantyMonths ? parseInt(f.warrantyMonths) : null;
    let warrantyExpiry: string | null = null;
    if (f.purchaseDate && wMonths) {
      const d = new Date(f.purchaseDate);
      d.setMonth(d.getMonth() + wMonths);
      warrantyExpiry = d.toISOString().split('T')[0];
    }
    await sb.updateAsset(editAsset._id, {
      assetTypeId: f.assetTypeId, brand: f.brand, model: f.model, serialNumber: f.serialNumber,
      purchasePrice: f.purchasePrice ? parseFloat(f.purchasePrice) : null, purchaseDate: f.purchaseDate || null,
      warrantyMonths: wMonths, warrantyExpiry,
      invoiceNumber: f.invoiceNumber || null, invoiceDate: f.invoiceDate || null, invoiceUrl: f.invoiceUrl || null,
      capacityValue: f.capacityValue || null, capacityUnit: f.capacityUnit || null,
      condition: f.condition, status: f.status, notes: f.notes || null,
      supplierId: f.isGeneralVendor ? null : (f.supplierId || null),
      vendorNameManual: f.isGeneralVendor ? f.vendorNameManual : null,
      productPhotoUrl: f.productPhotoUrl || null,
    });
    setAssetModalOpen(false); setEditAsset(null); fetchAll(true);
  };
  const handleDeleteAsset = async (id: string) => { await sb.deleteAsset(id); fetchAll(true); };
  const handleAllocate = async (payload: any) => { await sb.allocateAsset(payload); setAllocOpen(false); setAllocAsset(null); fetchAll(true); };
  const handleDeallocate = async (a: any) => { if (await confirmDelete(`Deallocate ${a.assetCode}?`)) { await sb.deallocateAsset(a._id); fetchAll(true); } };
  const handleDeleteAllocation = async (assetId: string, label: string) => {
    if (await confirmDelete(`Delete all allocations for ${label}?`)) { await sb.deallocateAsset(assetId); fetchAll(true); }
  };
  const handleEditAllocation = (grp: any[], assetObj: any) => {
    const first = grp[0];
    setAllocAsset(assetObj || { _id: first.asset_id, assetCode: first.assets?.asset_code, typeName: first.assets?.asset_types?.name, brand: first.assets?.brand, purchasePrice: first.assets?.purchase_price });
    setEditAllocInit({
      type: first.allocation_type,
      propertyId: first.property_id || '',
      apartmentId: first.apartment_id || '',
      bedIds: grp.filter((al: any) => al.bed_id).map((al: any) => al.bed_id),
    });
    setAllocOpen(true);
  };
  const handleAddVendor = async (f: any) => { await sb.createVendor(f); setVendorModalOpen(false); setEditVendor(null); fetchAll(true); };
  const handleEditVendor = async (f: any) => { await sb.updateVendor(editVendor.id, f); setVendorModalOpen(false); setEditVendor(null); fetchAll(true); };
  const handleDeleteVendor = async (v: any) => { if (await confirmDelete(`Delete vendor ${v.name || v.vendor_name}?`)) { await sb.deleteVendor(v.id); fetchAll(true); } };
  const handleRateVendor = async (rating: number) => { if (!vendorDetail) return; await sb.updateVendorRating(vendorDetail.id, rating); setVendorDetail((p: any) => ({ ...p, vendor_rating: rating, vendorRating: rating })); fetchAll(true); };
  const openVendorDetail = async (v: any) => {
    setVendorDetail(v); setVendorDetailOpen(true);
    try { const r = await sb.listVendorRemarks(v.id); if (mountedRef.current) setRemarks(r || []); } catch { setRemarks([]); }
  };
  const handleAddRemark = async (data: any) => { await sb.addVendorRemark({ vendorId: vendorDetail.id, ...data }); const r = await sb.listVendorRemarks(vendorDetail.id); setRemarks(r || []); };
  const handleAddCategory = async (vals: any) => { await sb.createCategory(vals.name); fetchAll(true); };
  const handleAddType = async (vals: any) => { await sb.createAssetType({ name: vals.name, categoryId: typeCatId, expectedLifeMonths: vals.lifeMonths ? parseInt(vals.lifeMonths) : null }); fetchAll(true); };
  const handleEditType = async (vals: any) => { if (!editTypeData?._id) return; await sb.updateAssetType(editTypeData._id, { name: vals.name }); setEditTypeOpen(false); fetchAll(true); };
  const handleAddBrand = async (vals: any) => { await sb.createBrand(vals.name); fetchAll(true); };

  // ── filtered data ──
  const filteredAssets = useMemo(() =>
    assets.filter(a => matches(a, search) && (typeFilter === 'all' || a.assetTypeId === typeFilter)),
  [assets, search, typeFilter]);
  const filteredVendors = useMemo(() => {
    if (!vendorSearch) return vendors;
    const s = vendorSearch.toLowerCase();
    return vendors.filter((v: any) => [v.name, v.vendor_name, v.phone, v.email, v.gst_number, v.gstNumber].some((x: any) => x && String(x).toLowerCase().includes(s)));
  }, [vendors, vendorSearch]);

  // ── render: INVENTORY ──
  const renderInventory = () => (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#E5E7EB', paddingHorizontal: 10, marginBottom: 10 }}>
        <Ionicons name="search-outline" size={16} color="#6B7280" />
        <TextInput value={search} onChangeText={setSearch} placeholder="Search inventory…" placeholderTextColor="#6B7280" style={{ flex: 1, paddingVertical: 10, paddingLeft: 6, fontSize: 14, color: '#111827' }} />
        {!!search && <TouchableOpacity onPress={() => setSearch('')}><Ionicons name="close-circle" size={16} color="#6B7280" /></TouchableOpacity>}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity onPress={() => setTypeFilter('all')} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: typeFilter === 'all' ? '#2563EB' : 'rgba(37,99,235,0.1)' }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: typeFilter === 'all' ? '#fff' : '#2563EB' }}>All Types</Text>
          </TouchableOpacity>
          {types.map((t: any) => (
            <TouchableOpacity key={t._id} onPress={() => setTypeFilter(t._id)} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: typeFilter === t._id ? '#2563EB' : 'rgba(37,99,235,0.1)' }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: typeFilter === t._id ? '#fff' : '#2563EB' }}>{t.name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
      {filteredAssets.length === 0
        ? <View style={{ alignItems: 'center', paddingVertical: 48 }}><Ionicons name="cube-outline" size={52} color="#e0d9ec" /><Text style={{ fontSize: 16, fontWeight: '800', color: '#111827', marginTop: 12 }}>No assets found</Text></View>
        : filteredAssets.slice(0, assetLimit).map((a: any) => (
          <AssetCard key={a._id} a={a}
            onView={() => { setDetailAssetId(a._id); setDetailOpen(true); }}
            onQR={() => { setQrAsset(a); setQrOpen(true); }}
            onEdit={() => { setEditAsset({
              assetTypeId: a.assetTypeId, brand: a.brand, model: a.model, serialNumber: a.serialNumber,
              purchasePrice: a.purchasePrice ? String(a.purchasePrice) : '', purchaseDate: a.purchaseDate || '',
              warrantyMonths: a.warrantyMonths ? String(a.warrantyMonths) : '', invoiceNumber: a.invoiceNumber || '',
              invoiceDate: a.invoiceDate || '', invoiceUrl: a.invoiceUrl || '', capacityValue: a.capacityValue || '',
              capacityUnit: a.capacityUnit || '', condition: a.condition || 'new', status: a.status || 'inventory',
              notes: a.notes || '', supplierId: a.supplierId || '', vendorNameManual: a.vendorNameManual || '',
              isGeneralVendor: !!a.vendorNameManual, productPhotoUrl: a.productPhotoUrl || '', _id: a._id,
            }); setAssetModalOpen(true); }}
            onAlloc={() => { setEditAllocInit(null); setAllocAsset(a); setAllocOpen(true); }}
            onDealloc={() => handleDeallocate(a)}
            onDelete={() => handleDeleteAsset(a._id)} />
        ))}
      {filteredAssets.length > assetLimit && (
        <TouchableOpacity
          onPress={() => setAssetLimit(l => l + ASSET_PAGE)}
          style={{ marginTop: 4, marginBottom: 12, paddingVertical: 14, borderRadius: 12, borderWidth: 1.5, borderColor: '#E5E7EB', backgroundColor: '#EFF6FF', alignItems: 'center' }}
        >
          <Text style={{ fontSize: 14, fontWeight: '800', color: '#2563EB' }}>
            Load more ({Math.min(assetLimit, filteredAssets.length)} of {filteredAssets.length})
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );

  // ── render: VENDORS ──
  const renderVendors = () => (
    <View>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#E5E7EB', paddingHorizontal: 10 }}>
          <Ionicons name="search-outline" size={16} color="#6B7280" />
          <TextInput value={vendorSearch} onChangeText={setVendorSearch} placeholder="Search vendors…" placeholderTextColor="#6B7280" style={{ flex: 1, paddingVertical: 10, paddingLeft: 6, fontSize: 14, color: '#111827' }} />
        </View>
        <TouchableOpacity onPress={() => { setEditVendor(null); setVendorModalOpen(true); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#2563EB' }}>
          <Ionicons name="add" size={16} color="#fff" /><Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Add</Text>
        </TouchableOpacity>
      </View>
      {filteredVendors.length === 0
        ? <View style={{ alignItems: 'center', paddingVertical: 48 }}><Ionicons name="people-outline" size={52} color="#e0d9ec" /><Text style={{ fontSize: 16, fontWeight: '800', color: '#111827', marginTop: 12 }}>No vendors</Text></View>
        : filteredVendors.map((v: any) => (
          <TouchableOpacity key={v.id} activeOpacity={0.7} onPress={() => openVendorDetail(v)} style={{ backgroundColor: '#fff', borderRadius: 14, marginBottom: 10, padding: 14, borderWidth: 1, borderColor: '#E5E7EB' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '800', color: '#111827' }}>{v.name || v.vendor_name}</Text>
                {!!(v.contactPerson || v.contact_person) && <Text style={{ fontSize: 12, color: '#556274', marginTop: 1 }}>{v.contactPerson || v.contact_person}</Text>}
                <View style={{ flexDirection: 'row', gap: 12, marginTop: 4 }}>
                  {!!v.phone && <Text style={{ fontSize: 12, color: '#6B7280' }}>{v.phone}</Text>}
                  {!!(v.gstNumber || v.gst_number) && <Text style={{ fontSize: 12, color: '#6B7280' }}>GST: {v.gstNumber || v.gst_number}</Text>}
                </View>
                <View style={{ marginTop: 6 }}><Stars value={v.vendorRating || v.vendor_rating || 0} onRate={(i: number) => sb.updateVendorRating(v.id, i).then(() => fetchAll(true))} /></View>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 8 }}>
                <Pill label={v.status || 'active'} color={(v.status || 'active') === 'active' ? '#16a34a' : '#6B7280'} bg={(v.status || 'active') === 'active' ? '#DCFCE7' : '#F3F4F6'} />
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <TouchableOpacity onPress={() => { setEditVendor(v); setVendorModalOpen(true); }} style={{ padding: 6, borderRadius: 8, backgroundColor: '#EFF6FF' }}><Ionicons name="pencil-outline" size={15} color="#2563EB" /></TouchableOpacity>
                  <TouchableOpacity onPress={() => handleDeleteVendor(v)} style={{ padding: 6, borderRadius: 8, backgroundColor: 'rgba(220,38,38,0.08)' }}><Ionicons name="trash-outline" size={15} color="#DC2626" /></TouchableOpacity>
                </View>
              </View>
            </View>
          </TouchableOpacity>
        ))}
    </View>
  );

  // ── render: ALLOCATIONS ──
  const renderAllocations = () => {
    const grouped = new Map<string, any[]>();
    allocations.forEach((a: any) => { const ex = grouped.get(a.asset_id) || []; ex.push(a); grouped.set(a.asset_id, ex); });
    const groups = Array.from(grouped.values());
    if (groups.length === 0) return <View style={{ alignItems: 'center', paddingVertical: 48 }}><Ionicons name="location-outline" size={52} color="#e0d9ec" /><Text style={{ fontSize: 16, fontWeight: '800', color: '#111827', marginTop: 12 }}>No allocations</Text><Text style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>Allocate assets from the Inventory tab</Text></View>;
    return (
      <View>
        {groups.map((grp, idx) => {
          const first = grp[0];
          const asset = assets.find((a: any) => a._id === first.asset_id);
          const price = asset?.purchasePrice || first.assets?.purchase_price || 0;
          const perBed = first.allocation_type === 'bed' && grp.length > 0 ? Math.round(price / grp.length) : 0;
          return (
            <View key={`${first.asset_id}-${idx}`} style={{ backgroundColor: '#fff', borderRadius: 14, marginBottom: 10, padding: 14, borderWidth: 1, borderColor: '#E5E7EB' }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: '#2563EB' }}>{asset?.assetCode || first.assets?.asset_code || '—'}</Text>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: '#111827', marginTop: 1 }}>{asset?.typeName || first.assets?.asset_types?.name || '—'}</Text>
                  {!!price && <Text style={{ fontSize: 13, fontWeight: '700', color: '#16a34a', marginTop: 2 }}>{fmtFull(price)}</Text>}
                </View>
                <Pill label={first.allocation_type} color="#2563EB" bg="rgba(37,99,235,0.12)" />
              </View>
              <View style={{ borderTopWidth: 1, borderTopColor: '#E5E7EB', marginTop: 10, paddingTop: 10, gap: 6 }}>
                {grp.map((al: any, i: number) => (
                  <View key={al.id || i} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                      <Ionicons name="location" size={13} color="#2563EB" />
                      <Text style={{ fontSize: 13, color: '#556274', flex: 1 }}>
                        {[al.properties?.property_name, al.apartments?.apartment_code, al.beds?.bed_code].filter(Boolean).join(' · ') || '—'}
                      </Text>
                    </View>
                    {perBed > 0 && <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>{fmtFull(perBed)}</Text>}
                  </View>
                ))}
              </View>
              {/* Allocation date + action row (QR / Edit / Delete) — web parity */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#E5E7EB', marginTop: 10, paddingTop: 10 }}>
                <Text style={{ fontSize: 11, color: '#6B7280' }}>{first.allocated_date ? `Allocated ${fmtDate(first.allocated_date)}` : ''}</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity
                    onPress={() => { setQrAsset(asset || { _id: first.asset_id, assetCode: first.assets?.asset_code, typeName: first.assets?.asset_types?.name, brand: first.assets?.brand, model: first.assets?.model }); setQrOpen(true); }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: '#E5E7EB', backgroundColor: '#EFF6FF' }}>
                    <Ionicons name="qr-code-outline" size={14} color="#2563EB" />
                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>QR</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleEditAllocation(grp, asset)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(37,99,235,0.25)', backgroundColor: 'rgba(37,99,235,0.06)' }}>
                    <Ionicons name="pencil-outline" size={14} color="#2563EB" />
                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleDeleteAllocation(first.asset_id, asset?.assetCode || first.assets?.asset_code || 'this asset')}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(220,38,38,0.25)', backgroundColor: 'rgba(220,38,38,0.06)' }}>
                    <Ionicons name="trash-outline" size={14} color="#DC2626" />
                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#DC2626' }}>Delete</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          );
        })}
      </View>
    );
  };

  // ── render: CATEGORIES ──
  const renderCategories = () => (
    <View>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
        <TouchableOpacity onPress={() => setCatOpen(true)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 12, borderRadius: 12, borderWidth: 1.5, borderColor: '#E5E7EB', backgroundColor: 'rgba(37,99,235,0.04)' }}>
          <Ionicons name="add" size={16} color="#2563EB" /><Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>Add Category</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { setTypeCatId(categories[0]?._id || ''); setTypeOpen(true); }} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 12, borderRadius: 12, borderWidth: 1.5, borderColor: '#E5E7EB', backgroundColor: 'rgba(37,99,235,0.04)' }}>
          <Ionicons name="add" size={16} color="#2563EB" /><Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>Add Asset Type</Text>
        </TouchableOpacity>
      </View>
      {categories.length === 0
        ? <View style={{ alignItems: 'center', paddingVertical: 48 }}><Ionicons name="folder-outline" size={52} color="#e0d9ec" /><Text style={{ fontSize: 16, fontWeight: '800', color: '#111827', marginTop: 12 }}>No categories</Text></View>
        : categories.map((c: any) => {
          const catTypes = types.filter((t: any) => t.categoryId === c._id);
          const assetCount = assets.filter((a: any) => a.categoryName === c.name).length;
          return (
            <View key={c._id} style={{ backgroundColor: '#fff', borderRadius: 14, marginBottom: 10, padding: 14, borderWidth: 1, borderColor: '#E5E7EB' }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontSize: 15, fontWeight: '800', color: '#111827' }}>{c.name}</Text>
                <Text style={{ fontSize: 12, color: '#6B7280' }}>{assetCount} asset{assetCount !== 1 ? 's' : ''} · {catTypes.length} type{catTypes.length !== 1 ? 's' : ''}</Text>
              </View>
              {catTypes.length > 0 && (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                  {catTypes.map((t: any) => (
                    <TouchableOpacity key={t._id}
                      onLongPress={() => Alert.alert(t.name, 'Manage this asset type', [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Rename', onPress: () => { setEditTypeData({ _id: t._id, name: t.name }); setEditTypeOpen(true); } },
                        { text: 'Delete', style: 'destructive', onPress: async () => { try { await sb.deleteAssetType(t._id); fetchAll(true); } catch (e: any) { Alert.alert('Cannot delete', e.message); } } },
                      ])}
                      style={{ backgroundColor: '#EFF6FF', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}>
                      <Text style={{ fontSize: 11, fontWeight: '600', color: '#2563EB' }}>{t.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          );
        })}
      <Text style={{ fontSize: 11, color: '#6B7280', textAlign: 'center', marginTop: 4 }}>Long-press a type chip to rename or delete</Text>
    </View>
  );

  // ── render: ANALYTICS ──
  const renderAnalytics = () => {
    const condCounts = assets.reduce((acc: any, a: any) => { const c = a.condition || 'new'; acc[c] = (acc[c] || 0) + 1; return acc; }, {});
    return (
      <View>
        <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#E5E7EB' }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: '#111827', marginBottom: 14 }}>Assets by Category</Text>
          <MiniBar data={(stats.byCategory || []).map((c: any) => ({ name: c.name, count: c.count }))} />
        </View>
        <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#E5E7EB' }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: '#111827', marginBottom: 12 }}>Condition Breakdown</Text>
          {CONDITIONS.map(c => {
            const count = condCounts[c] || 0;
            const pct = assets.length ? Math.round((count / assets.length) * 100) : 0;
            return (
              <View key={c} style={{ marginBottom: 10 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: '#556274', textTransform: 'capitalize' }}>{c}</Text>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: condColor(c) }}>{count} ({pct}%)</Text>
                </View>
                <View style={{ height: 8, backgroundColor: '#F3F4F6', borderRadius: 4 }}>
                  <View style={{ width: `${pct}%`, height: '100%', backgroundColor: condColor(c), borderRadius: 4 }} />
                </View>
              </View>
            );
          })}
        </View>
      </View>
    );
  };

  // ── render: FORECASTS ──
  const renderForecasts = () => {
    const urgColor = (u: string) => ({ overdue: '#DC2626', urgent: '#2563EB', soon: '#F59E0B', upcoming: '#2563EB' }[u] || '#6B7280');
    if (forecasts.length === 0) return <View style={{ alignItems: 'center', paddingVertical: 48 }}><Ionicons name="trending-up-outline" size={52} color="#e0d9ec" /><Text style={{ fontSize: 16, fontWeight: '800', color: '#111827', marginTop: 12 }}>No forecasts</Text><Text style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>Replacement forecasts appear here</Text></View>;
    return (
      <View>
        {forecasts.map((f: any, i: number) => (
          <View key={f.id || i} style={{ backgroundColor: '#fff', borderRadius: 14, marginBottom: 10, padding: 14, borderWidth: 1, borderColor: '#E5E7EB' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: '#2563EB' }}>{f.assetCode || f.asset_code || '—'}</Text>
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#111827', marginTop: 1 }}>{f.typeName || f.type_name || '—'}</Text>
                <View style={{ flexDirection: 'row', gap: 14, marginTop: 5 }}>
                  <View><Text style={{ fontSize: 10, color: '#6B7280' }}>Expected</Text><Text style={{ fontSize: 12, fontWeight: '700', color: '#111827' }}>{fmtDate(f.expectedReplacementDate || f.expected_replacement_date)}</Text></View>
                  <View><Text style={{ fontSize: 10, color: '#6B7280' }}>Est. Cost</Text><Text style={{ fontSize: 12, fontWeight: '700', color: '#16a34a' }}>{fmtFull(f.replacementCost || f.replacement_cost || 0)}</Text></View>
                </View>
              </View>
              {!!(f.urgency) && <Pill label={f.urgency} color={urgColor(f.urgency)} bg={urgColor(f.urgency) + '18'} />}
            </View>
          </View>
        ))}
      </View>
    );
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'inventory':   return renderInventory();
      case 'payments':    return <AssetPaymentsTab />;
      case 'vendors':     return renderVendors();
      case 'allocations': return renderAllocations();
      case 'categories':  return renderCategories();
      case 'analytics':   return renderAnalytics();
      case 'forecasts':   return renderForecasts();
      default:            return null;
    }
  };

  const visibleTabs = filterTabs(TABS, visibleTabKeys);

  if (loading && !refreshing) {
    return (
      <GlassBackground>
        <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color="#2563EB" />
          <Text style={{ marginTop: 12, color: '#556274' }}>Loading assets…</Text>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
            <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center' }}>
              <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 }}>Asset Management</Text>
              <Text style={{ fontSize: 13, color: '#6B7280', fontWeight: '500', marginTop: 2 }}>Track assets, vendors, allocations</Text>
            </View>
          </View>
          <IconBtnSolid
            label="Add Asset"
            onPress={() => { setEditAsset(null); setAssetModalOpen(true); }}
          />
        </View>

        {/* Stats row */}
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 10 }}>
          {[
            { label: 'Total',      value: stats.totalAssets || assets.length, color: '#2563EB', icon: 'cube' },
            { label: 'Investment', value: fmtShort(stats.totalInvestment || 0), color: '#16a34a', icon: 'cash' },
            { label: 'Allocated',  value: assets.filter((a: any) => a.status === 'allocated').length, color: '#2563EB', icon: 'location' },
            { label: 'Maint.',     value: stats.needsMaintenance ?? stats.maintenance ?? 0, color: '#2563EB', icon: 'construct' },
          ].map(s => (
            <View key={s.label} style={{ flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: '#E5E7EB' }}>
              <Ionicons name={s.icon as any} size={15} color={s.color} />
              <Text style={{ fontSize: 14, fontWeight: '900', color: s.color, marginTop: 3 }}>{s.value}</Text>
              <Text style={{ fontSize: 9, color: '#6B7280' }}>{s.label}</Text>
            </View>
          ))}
        </View>

        {/* Tab bar */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 46, marginBottom: 6 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 8, alignItems: 'center' }}>
          {visibleTabs.map((t: any) => (
            <TouchableOpacity key={t.key} onPress={() => setActiveTab(t.key)} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: activeTab === t.key ? '#2563EB' : 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: activeTab === t.key ? '#2563EB' : 'rgba(37,99,235,0.15)' }}>
              <Ionicons name={t.icon} size={14} color={activeTab === t.key ? '#fff' : '#2563EB'} />
              <Text style={{ fontSize: 12, fontWeight: '700', color: activeTab === t.key ? '#fff' : '#2563EB' }}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Content */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchAll(true)} tintColor="#2563EB" />}
          keyboardShouldPersistTaps="handled"
        >
          {!!fetchError && (
            <View style={{ backgroundColor: '#FEE2E2', borderRadius: 12, padding: 12, marginBottom: 12 }}>
              <Text style={{ color: '#DC2626', fontSize: 13, fontWeight: '600' }}>{fetchError}</Text>
            </View>
          )}
          {renderTab()}
        </ScrollView>

        {/* FAB on inventory */}
        {activeTab === 'inventory' && (
          <TouchableOpacity onPress={() => { setEditAsset(null); setAssetModalOpen(true); }} style={{ position: 'absolute', right: 20, bottom: 28, width: 56, height: 56, borderRadius: 28, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center', shadowColor: '#2563EB', shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}>
            <Ionicons name="add" size={28} color="#fff" />
          </TouchableOpacity>
        )}

        {/* ── Modals ── */}
        <AssetModal
          visible={assetModalOpen}
          onClose={() => { setAssetModalOpen(false); setEditAsset(null); }}
          onSave={editAsset ? handleEditAsset : handleAddAsset}
          init={editAsset}
          title={editAsset ? 'Edit Asset' : 'Add Asset'}
          types={types} vendors={vendors} brands={brands}
          onNewType={() => { setTypeCatId(categories[0]?._id || ''); setTypeOpen(true); }}
          onNewBrand={() => setBrandOpen(true)}
          token={token}
        />
        <VendorModal
          visible={vendorModalOpen}
          onClose={() => { setVendorModalOpen(false); setEditVendor(null); }}
          onSave={editVendor ? handleEditVendor : handleAddVendor}
          init={editVendor}
          title={editVendor ? 'Edit Vendor' : 'Add Vendor'}
        />
        <VendorDetailModal
          visible={vendorDetailOpen}
          onClose={() => setVendorDetailOpen(false)}
          vendor={vendorDetail}
          remarks={remarks}
          onAddRemark={handleAddRemark}
          onRate={handleRateVendor}
        />
        <AllocModal
          visible={allocOpen}
          onClose={() => { setAllocOpen(false); setAllocAsset(null); setEditAllocInit(null); }}
          onSave={handleAllocate}
          asset={allocAsset}
          init={editAllocInit}
          properties={properties} apartments={apartments} beds={beds}
        />
        <QRModal visible={qrOpen} onClose={() => setQrOpen(false)} asset={qrAsset} />
        <AssetDetailModal
          visible={detailOpen}
          onClose={() => setDetailOpen(false)}
          assetId={detailAssetId}
          onQR={(asset: any) => { setQrAsset(asset); setQrOpen(true); }}
          onChanged={() => fetchAll(true)}
        />
        <QuickModal visible={catOpen} onClose={() => setCatOpen(false)} title="Add Asset Category" onSave={handleAddCategory} fields={[{ key: 'name', label: 'Category Name *', placeholder: 'e.g. Electronics' }]} />
        <QuickModal visible={typeOpen} onClose={() => setTypeOpen(false)} title="Add Asset Type" onSave={handleAddType} fields={[{ key: 'name', label: 'Type Name *', placeholder: 'e.g. Air Conditioner' }, { key: 'lifeMonths', label: 'Expected Life (months)', placeholder: 'e.g. 60' }]} />
        <QuickModal visible={editTypeOpen} onClose={() => setEditTypeOpen(false)} title="Rename Asset Type" onSave={handleEditType} initial={editTypeData ? { name: editTypeData.name } : null} fields={[{ key: 'name', label: 'Type Name *', placeholder: 'Type name' }]} />
        <QuickModal visible={brandOpen} onClose={() => setBrandOpen(false)} title="Add Brand" onSave={handleAddBrand} fields={[{ key: 'name', label: 'Brand Name *', placeholder: 'e.g. Samsung, LG, Voltas' }]} />
      </SafeAreaView>
    </GlassBackground>
  );
}
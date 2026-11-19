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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { GlassBackground, PickerSelect, IconBtnSolid } from '../components/shared';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useMountedRef } from '../lib/safeAsync';
import { fetchVisibleTabKeys, filterTabs } from '../lib/tabPermissions';
import * as ImagePicker from 'expo-image-picker';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/config';
import { htmlToPdfAndShare } from '../lib/pdfShare';
// qrcode (1.5.4, bundled via react-native-qrcode-styled). We use only its pure-JS
// CORE (no canvas / Buffer / server deps) and build the SVG ourselves, so the
// apartment QR PDF renders real QR codes entirely on-device.
let QRCore: any = null;
try { QRCore = require('qrcode/lib/core/qrcode'); } catch {}
function qrSvg(text: string, size = 150): string {
  if (!QRCore || !text) return '';
  try {
    const qr = QRCore.create(String(text), { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const cell = size / n;
    let rects = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) rects += `<rect x="${(c * cell).toFixed(2)}" y="${(r * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  } catch { return ''; }
}

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
const esc = (v: any) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
// Web parity (downloadApartmentQrPdf): a printable 2-col QR grid for one apartment.
// QR codes are encoded on-device from the asset's public link — nothing leaves the device.
async function downloadApartmentQrPdf(aptLabel: string, assetGroups: any[][], assetsById: Map<string, any>) {
  const cards = assetGroups.map((grp) => {
    const first = grp[0];
    const asset = assetsById.get(String(first.asset_id)) || { _id: first.asset_id, assetCode: first.assets?.asset_code, qrCode: null };
    const url = qrOf(asset) || String(first.asset_id || '');
    const svg = qrSvg(url, 150);
    const code = esc(asset.assetCode || first.assets?.asset_code || '—');
    const typeName = esc(asset.typeName || first.assets?.asset_types?.name || '');
    const place = esc([first.apartments?.apartment_code, first.beds?.bed_code].filter(Boolean).join(' · '));
    return `<div class="card">${svg || '<div class="noqr">QR unavailable</div>'}<div class="code">${code}</div><div class="type">${typeName}</div><div class="place">${place}</div></div>`;
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"/><style>
    *{box-sizing:border-box} body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:24px;color:#111827}
    h1{font-size:18px;margin:0 0 4px} .sub{color:#6B7280;font-size:12px;margin-bottom:16px}
    .grid{display:flex;flex-wrap:wrap;gap:16px}
    .card{width:46%;border:1px solid #EEF1F6;border-radius:12px;padding:12px;text-align:center}
    .card svg{width:150px;height:150px}
    .noqr{width:150px;height:150px;line-height:150px;color:#9ca3af;font-size:11px;margin:0 auto}
    .code{font-weight:800;color:#2563EB;margin-top:6px;font-size:13px} .type{color:#111827;font-size:12px} .place{color:#6B7280;font-size:11px;margin-top:2px}
  </style></head><body><h1>${esc(aptLabel)} — Asset QR Codes</h1><div class="sub">${assetGroups.length} asset${assetGroups.length === 1 ? '' : 's'}</div><div class="grid">${cards.join('')}</div></body></html>`;
  await htmlToPdfAndShare(html, { dialogTitle: `${aptLabel} QR Codes` });
}

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
          backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#EEF1F6',
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
    <View style={{ borderTopWidth: 1, borderTopColor: '#EEF1F6', marginVertical: 12, paddingTop: 12 }}>
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
    <View style={{ backgroundColor: '#fff', borderRadius: 16, marginBottom: 10, padding: 14, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2 }}>
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
        <View style={{ borderTopWidth: 1, borderTopColor: '#EEF1F6', marginTop: 10, paddingTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
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
      <SafeAreaView style={{ flex: 1, backgroundColor: '#F8FAFC' }} edges={['top']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>
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
                  : <TextInput style={{ backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#EEF1F6', paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: '#111827' }} value={f.brand} onChangeText={(v) => s('brand', v)} placeholder="Brand name" placeholderTextColor="#6B7280" />}
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
            <TouchableOpacity style={{ backgroundColor: isValid() ? '#2563EB' : '#aaa', borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginTop: 8 }} onPress={save} disabled={saving || !isValid()}>
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
      <SafeAreaView style={{ flex: 1, backgroundColor: '#F8FAFC' }} edges={['top']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>
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
            <TouchableOpacity style={{ backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginTop: 8, opacity: saving ? 0.6 : 1 }} onPress={save} disabled={saving}>
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
      <SafeAreaView style={{ flex: 1, backgroundColor: '#F8FAFC' }} edges={['top']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>
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
            <View style={{ backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
              {[
                ['Name',    vName],
                ['Contact', vendor.contactPerson || vendor.contact_person || '—'],
                ['Phone',   vendor.phone || '—'],
                ['Email',   vendor.email || '—'],
                ['GST',     vendor.gstNumber || vendor.gst_number || '—'],
                ['PAN',     vendor.panNumber || vendor.pan_number || '—'],
              ].map(([k, v], i) => (
                <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: i < 5 ? 1 : 0, borderBottomColor: '#EEF1F6' }}>
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
                <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: '#EEF1F6' }}>
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
                    <TouchableOpacity style={{ flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center', borderWidth: 1.5, borderColor: '#EEF1F6' }} onPress={() => setRmkOpen(false)}>
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
                      <Pill label={r.severity} color="#6B7280" bg="#EEF1F6" />
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
      <SafeAreaView style={{ flex: 1, backgroundColor: '#F8FAFC' }} edges={['top']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>
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
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12, backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#EEF1F6' }}>
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
          <TouchableOpacity style={{ backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginTop: 20, opacity: saving ? 0.6 : 1 }} onPress={save} disabled={saving}>
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
            <TouchableOpacity style={{ flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center', borderWidth: 1.5, borderColor: '#EEF1F6' }} onPress={onClose}>
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
        <View style={{ borderRadius: 12, borderWidth: 1, borderColor: '#EEF1F6', overflow: 'hidden', backgroundColor: '#fff' }}>
          <View style={{ width: '100%', height: 140, backgroundColor: '#F8FAFC', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
            <Ionicons name="image" size={44} color="#2563EB" />
            <Text style={{ fontSize: 10, color: '#6B7280', marginTop: 6, textAlign: 'center' }} numberOfLines={2}>{value.split('/').pop()}</Text>
            <Text style={{ fontSize: 11, color: '#16a34a', marginTop: 4, fontWeight: '700' }}>✓ Uploaded</Text>
          </View>
          <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#EEF1F6' }}>
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
          <TouchableOpacity onPress={pickFromGallery} disabled={uploading} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 16, borderRadius: 12, borderWidth: 1.5, borderColor: '#EEF1F6', borderStyle: 'dashed', backgroundColor: 'rgba(37,99,235,0.04)' }}>
            {uploading ? <ActivityIndicator size="small" color="#2563EB" /> : (<><Ionicons name="image-outline" size={18} color="#2563EB" /><Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>Gallery</Text></>)}
          </TouchableOpacity>
          <TouchableOpacity onPress={takePhoto} disabled={uploading} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 16, borderRadius: 12, borderWidth: 1.5, borderColor: '#EEF1F6', borderStyle: 'dashed', backgroundColor: 'rgba(37,99,235,0.04)' }}>
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
      <TouchableOpacity onPress={() => setOpen(true)} style={{ backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#EEF1F6', paddingHorizontal: 12, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
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
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>
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
    <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827' }}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

function AssetDetailModal({ visible, onClose, assetId, onQR, onChanged }: any) {
  const navigation = useNavigation<any>();
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
      <SafeAreaView style={{ flex: 1, backgroundColor: '#F8FAFC' }} edges={['top']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>
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
                <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 16, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
                  <Ionicons name="cash-outline" size={18} color="#16a34a" />
                  <Text style={{ fontSize: 15, fontWeight: '900', color: '#16a34a', marginTop: 4 }}>{fmtFull(d.purchasePrice)}</Text>
                  <Text style={{ fontSize: 10, color: '#6B7280' }}>Purchase Price</Text>
                </View>
                <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 16, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
                  <Ionicons name="shield-checkmark-outline" size={18} color={d.warrantyActive ? '#16a34a' : '#DC2626'} />
                  <Text style={{ fontSize: 15, fontWeight: '900', color: d.warrantyActive ? '#16a34a' : '#DC2626', marginTop: 4 }}>{d.warrantyActive ? `${d.warrantyMonthsLeft ?? ''}m` : 'Expired'}</Text>
                  <Text style={{ fontSize: 10, color: '#6B7280' }}>Warranty</Text>
                </View>
                <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 16, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
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

              <DSection title="Linked Tickets" right={d.tickets?.length ? <Text style={{ fontSize: 11, fontWeight: '700', color: '#2563EB' }}>{d.tickets.length}</Text> : undefined}>
                {(!d.tickets || d.tickets.length === 0) ? <Text style={{ fontSize: 12, color: '#6B7280' }}>No tickets raised for this asset</Text>
                  : d.tickets.map((t: any) => {
                    const open = !['closed', 'completed', 'cancelled'].includes(String(t.status || '').toLowerCase());
                    return (
                      <TouchableOpacity
                        key={t.id}
                        activeOpacity={0.7}
                        onPress={() => { onClose(); navigation.navigate('Tickets', { screen: 'TicketDetail', params: { ticketId: t.id } }); }}
                        style={{ borderTopWidth: 1, borderTopColor: 'rgba(37,99,235,0.06)', paddingVertical: 8 }}
                      >
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, flexWrap: 'wrap' }}>
                            <Text style={{ fontSize: 13, fontWeight: '800', color: '#111827' }}>{t.ticketNumber || '—'}</Text>
                            <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: open ? '#FEF3C7' : '#ECFDF5' }}>
                              <Text style={{ fontSize: 10, fontWeight: '800', color: open ? '#D97706' : '#059669' }}>{t.status || 'open'}</Text>
                            </View>
                          </View>
                          {t.cost > 0 && <Text style={{ fontSize: 13, fontWeight: '700', color: '#16a34a' }}>{fmtFull(t.cost)}</Text>}
                          <Ionicons name="chevron-forward" size={16} color="#9CA3AF" />
                        </View>
                        {!!t.issueType && <Text style={{ fontSize: 12, color: '#556274', marginTop: 2 }}>{t.issueType}</Text>}
                        {!!t.createdAt && <Text style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>Raised {fmtDate(t.createdAt)}{t.resolvedAt ? ` · Resolved ${fmtDate(t.resolvedAt)}` : ''}</Text>}
                      </TouchableOpacity>
                    );
                  })}
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
  const [payments, setPayments] = useState<any[]>([]);
  const [statusFilter, setStatusFilter] = useState<'all' | 'unpaid' | 'partial' | 'paid'>('all');
  const [vendorFilter, setVendorFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const emptyForm = { id: '', assetId: '', assetCode: '', vendorId: '', paymentDate: new Date().toISOString().split('T')[0], amount: '', paymentMode: '', bankAccountId: '', referenceNumber: '', notes: '', balanceDue: 0 };
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<any>(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, b, p] = await Promise.all([
        sb.listAssetPaymentStatus().catch(() => []),
        sb.listAssetBankAccounts().catch(() => []),
        sb.listAssetPaymentsAll().catch(() => []),
      ]);
      setRows(r || []); setBanks(b || []); setPayments(p || []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Bank label by id (web shows "name · ****last4" in the payment history).
  const bankLabelById = useMemo(() => {
    const m = new Map<string, string>();
    banks.forEach((b: any) => m.set(b.id, `${b.bankName}${b.accountNumber ? ` ****${String(b.accountNumber).slice(-4)}` : ''}`));
    return m;
  }, [banks]);
  // Payment records keyed by assetId → each invoice group pulls its history.
  const paymentsByAsset = useMemo(() => {
    const m = new Map<string, any[]>();
    payments.forEach((p: any) => { const a = m.get(p.assetId) || []; a.push(p); m.set(p.assetId, a); });
    return m;
  }, [payments]);

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
  // Edit an existing payment record (web parity: openEditPayment).
  const openEdit = (p: any, g: any) => {
    setForm({ ...emptyForm, id: p.id, assetId: p.assetId, assetCode: g.lead.assetCode, vendorId: p.vendorId || g.lead.supplierId || '',
      paymentDate: p.date || emptyForm.paymentDate, amount: p.amount ? String(p.amount) : '', paymentMode: p.mode || '',
      bankAccountId: p.bankAccountId || '', referenceNumber: p.reference || '', notes: p.notes || '', balanceDue: g.displayDue });
    setFormOpen(true);
  };
  const savePayment = async () => {
    const amt = parseFloat(form.amount);
    if (!form.assetId) { Alert.alert('Validation', 'Asset is required.'); return; }
    if (!Number.isFinite(amt) || amt <= 0) { Alert.alert('Validation', 'Amount must be greater than 0.'); return; }
    if (form.paymentMode && form.paymentMode !== 'cash' && !form.bankAccountId) { Alert.alert('Validation', 'Bank account is required when payment mode is not cash.'); return; }
    setSaving(true);
    try {
      const payload = { assetId: form.assetId, vendorId: form.vendorId || null, paymentDate: form.paymentDate, amount: amt, paymentMode: form.paymentMode || null, bankAccountId: form.bankAccountId || null, referenceNumber: form.referenceNumber || null, notes: form.notes || null };
      const res: any = form.id ? await sb.updateAssetPayment(form.id, payload) : await sb.recordAssetPayment(payload);
      if (res && res.disabled) { Alert.alert('Writes disabled', res.message || 'Editing is currently disabled on this build.'); return; }
      setFormOpen(false); setForm(emptyForm); await load();
    } catch (e: any) { Alert.alert('Error', e.message || 'Could not save payment.'); }
    finally { setSaving(false); }
  };
  // Delete a payment (gated — blocked while DELETES_ENABLED is false).
  const deletePayment = async (p: any) => {
    if (!(await confirmDelete('Delete this payment? It will reverse its journal entries.'))) return;
    try {
      const res: any = await sb.deleteAssetPayment(p.id);
      if (res && res.disabled) { Alert.alert('Deletes disabled', res.message || 'Deleting is currently disabled.'); return; }
      await load();
    } catch (e: any) { Alert.alert('Error', e.message || 'Could not delete payment.'); }
  };

  if (loading) return <View style={{ alignItems: 'center', paddingVertical: 48 }}><ActivityIndicator size="large" color="#2563EB" /><Text style={{ marginTop: 12, color: '#6B7280' }}>Loading asset payments…</Text></View>;

  return (
    <View>
      {/* 4 KPI cards (web parity): Payment lines · Purchase Total · Paid · Balance Due */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 4 }}>
        {[
          { label: 'Payment lines', value: String(groups.length), color: '#2563EB' },
          { label: 'Purchase',      value: fmtShort(totals.purchase), color: '#111827' },
          { label: 'Paid',          value: fmtShort(totals.paid), color: '#16a34a' },
          { label: 'Balance Due',   value: fmtShort(totals.due), color: '#DC2626' },
        ].map((c) => (
          <View key={c.label} style={{ width: '48.5%', backgroundColor: '#fff', borderRadius: 16, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
            <Text style={{ fontSize: 10, color: c.color === '#111827' ? '#6B7280' : c.color, fontWeight: '800', textTransform: 'uppercase' }} numberOfLines={1}>{c.label}</Text>
            <Text style={{ fontSize: 16, fontWeight: '900', color: c.color, marginTop: 4 }} numberOfLines={1}>{c.value}</Text>
          </View>
        ))}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#EEF1F6', paddingHorizontal: 10, marginBottom: 10 }}>
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
          const grpPayments = g.rows.flatMap((r: any) => paymentsByAsset.get(r.assetId) || []);
          const canExpand = isMulti || grpPayments.length > 0;
          return (
            <View key={g.groupKey} style={{ backgroundColor: '#fff', borderRadius: 16, marginBottom: 10, padding: 14, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
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
              {canExpand && (
                <TouchableOpacity onPress={() => setExpandedKey(expanded ? null : g.groupKey)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 }}>
                  <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color="#2563EB" />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>
                    {expanded ? 'Hide' : 'Show'} details{isMulti ? ` · ${g.rows.length} assets` : ''}{grpPayments.length > 0 ? ` · ${grpPayments.length} payment${grpPayments.length === 1 ? '' : 's'}` : ''}
                  </Text>
                </TouchableOpacity>
              )}
              {canExpand && expanded && (
                <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: '#EEF1F6', paddingTop: 8 }}>
                  {isMulti && (
                    <View style={{ marginBottom: grpPayments.length > 0 ? 10 : 0 }}>
                      <Text style={{ fontSize: 11, fontWeight: '800', color: '#6B7280', textTransform: 'uppercase', marginBottom: 4 }}>Linked assets</Text>
                      {g.rows.map((r: any) => (
                        <View key={r.assetId} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
                          <Text style={{ fontSize: 12, color: '#111827', fontWeight: '600' }}>{r.assetCode}</Text>
                          <Text style={{ fontSize: 12, color: '#6B7280' }}>{fmtFull(r.purchasePrice)} · paid {fmtFull(r.totalPaid)}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                  {grpPayments.length > 0 && (
                    <View>
                      <Text style={{ fontSize: 11, fontWeight: '800', color: '#6B7280', textTransform: 'uppercase', marginBottom: 4 }}>Payment history</Text>
                      {grpPayments.map((p: any) => (
                        <View key={p.id} style={{ backgroundColor: '#F8FAFC', borderRadius: 10, borderWidth: 1, borderColor: '#EEF1F6', padding: 10, marginBottom: 6 }}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Text style={{ fontSize: 13, fontWeight: '800', color: '#16a34a' }}>{fmtFull(p.amount)}</Text>
                            <View style={{ flexDirection: 'row', gap: 6 }}>
                              <TouchableOpacity onPress={() => openEdit(p, g)} style={{ padding: 6, borderRadius: 8, backgroundColor: '#EFF6FF' }}><Ionicons name="pencil-outline" size={14} color="#2563EB" /></TouchableOpacity>
                              <TouchableOpacity onPress={() => deletePayment(p)} style={{ padding: 6, borderRadius: 8, backgroundColor: 'rgba(220,38,38,0.08)' }}><Ionicons name="trash-outline" size={14} color="#DC2626" /></TouchableOpacity>
                            </View>
                          </View>
                          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                            <Text style={{ fontSize: 11, color: '#6B7280' }}>{fmtDate(p.date)}</Text>
                            {!!p.mode && <Text style={{ fontSize: 11, color: '#6B7280', textTransform: 'capitalize' }}>{p.mode}</Text>}
                            {!!p.bankAccountId && <Text style={{ fontSize: 11, color: '#6B7280' }}>{bankLabelById.get(p.bankAccountId) || 'Bank'}</Text>}
                            {!!p.reference && <Text style={{ fontSize: 11, color: '#6B7280' }}>Ref {p.reference}</Text>}
                            {isMulti && <Text style={{ fontSize: 11, color: '#2563EB', fontWeight: '600' }}>{g.rows.find((r: any) => r.assetId === p.assetId)?.assetCode || ''}</Text>}
                          </View>
                          {!!p.proofUrl && <TouchableOpacity onPress={() => Linking.openURL(p.proofUrl).catch(() => {})}><Text style={{ fontSize: 11, color: '#2563EB', marginTop: 3 }}>View proof</Text></TouchableOpacity>}
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              )}
            </View>
          );
        })
      )}

      <Modal visible={formOpen} animationType="slide" transparent onRequestClose={() => setFormOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(30,18,48,0.45)' }}>
          <View style={{ backgroundColor: '#F8FAFC', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 36, maxHeight: '90%' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: '#111827' }}>{form.id ? 'Edit Payment' : 'Record Payment'}</Text>
              <TouchableOpacity onPress={() => setFormOpen(false)} style={{ padding: 6, backgroundColor: '#EFF6FF', borderRadius: 999 }}><Ionicons name="close" size={18} color="#556274" /></TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
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
// Tab order + labels mirror the web Assets screen exactly.
const TABS = [
  { key: 'inventory',   label: 'Inventory Pending',   icon: 'cube-outline' },
  { key: 'allocations', label: 'Inventory Allocated', icon: 'location-outline' },
  { key: 'maintenance', label: 'Asset Maintenance',   icon: 'construct-outline' },
  { key: 'payments',    label: 'Asset Payments',      icon: 'cash-outline' },
  { key: 'categories',  label: 'Categories',          icon: 'folder-outline' },
  { key: 'vendors',     label: 'Vendors',             icon: 'people-outline' },
  { key: 'analytics',   label: 'Analytics',           icon: 'bar-chart-outline' },
  { key: 'forecasts',   label: 'Forecasts',           icon: 'trending-up-outline' },
];

export default function AssetsScreen() {
  const insets = useSafeAreaInsets();
  // Clear the app-level FLOATING bottom nav rail (App.tsx NAV.rail: ~50px + safe-area) so the FAB isn't hidden behind it.
  const navClear = 76 + Math.max(insets.bottom, 10);
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
  // Inventory list grouping mode (web parity: listModeSelect) — flat | asset | apartment
  const [listMode,     setListMode]     = useState<'flat' | 'asset' | 'apartment'>('flat');
  // Allocated list grouping mode (web parity: allocListMode) — flat | type | apartment
  const [allocListMode, setAllocListMode] = useState<'flat' | 'type' | 'apartment'>('flat');
  const [vendorSearch, setVendorSearch] = useState('');
  const [visibleTabKeys, setVisibleTabKeys] = useState<Set<string> | null>(null);
  // Maintenance tab (asset-linked tickets, grouped client-side)
  const [maintTickets,   setMaintTickets]   = useState<any[]>([]);
  const [maintLoading,   setMaintLoading]   = useState(false);
  const [maintLoaded,    setMaintLoaded]    = useState(false);
  const [onlyWithTickets,setOnlyWithTickets]= useState(false);
  const [expandedMaint,  setExpandedMaint]  = useState<Set<string>>(new Set());
  // Web-parity maintenance analytics UI state (mirrors AssetMaintenanceTab.tsx)
  const [maintView,        setMaintView]        = useState<'by_apartment' | 'by_type'>('by_apartment');
  const [maintSearch,      setMaintSearch]      = useState('');
  const [maintTypeFilter,  setMaintTypeFilter]  = useState('all');
  const [maintKpiDetail,   setMaintKpiDetail]   = useState<null | 'types' | 'problematic' | 'spend' | 'repeat' | 'open'>(null);
  const [expandedMaintApt, setExpandedMaintApt] = useState<Set<string>>(new Set());
  const [expandedMaintType,setExpandedMaintType]= useState<Set<string>>(new Set());
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
      sb.listAllocations(), sb.listProperties(), sb.listApartments(), sb.listBeds({}), sb.listBrands(), sb.listForecasts(),
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

  // Maintenance tickets load lazily the first time the tab is opened (or after refresh).
  const loadMaintenance = useCallback(async () => {
    setMaintLoading(true);
    try {
      const t = await sb.listAssetMaintenance();
      if (mountedRef.current) setMaintTickets(Array.isArray(t) ? t : []);
    } catch {
      if (mountedRef.current) setMaintTickets([]);
    } finally {
      if (mountedRef.current) { setMaintLoading(false); setMaintLoaded(true); }
    }
  }, []);
  useEffect(() => { if (activeTab === 'maintenance' && !maintLoaded) loadMaintenance(); }, [activeTab, maintLoaded, loadMaintenance]);

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
  // Inventory Pending = assets still in stock (web parity: .eq("status","inventory")).
  const filteredAssets = useMemo(() =>
    assets.filter(a => (a.status || 'inventory') === 'inventory'
      && matches(a, search) && (typeFilter === 'all' || a.assetTypeId === typeFilter)),
  [assets, search, typeFilter]);
  const filteredVendors = useMemo(() => {
    if (!vendorSearch) return vendors;
    const s = vendorSearch.toLowerCase();
    return vendors.filter((v: any) => [v.name, v.vendor_name, v.phone, v.email, v.gst_number, v.gstNumber].some((x: any) => x && String(x).toLowerCase().includes(s)));
  }, [vendors, vendorSearch]);

  // ── Maintenance grouping (flat tickets → per-asset), cross-referenced to loaded assets ──
  const maintTicketOpen = (s: any) => !['completed', 'closed', 'resolved'].includes(String(s || '').toLowerCase());
  const maintGroups = useMemo(() => {
    const assetById = new Map<string, any>();
    for (const a of assets) if (a && a._id != null) assetById.set(String(a._id), a);
    const byAsset = new Map<string, any[]>();
    for (const t of maintTickets) {
      const k = String(t?.asset_id ?? '');
      if (!k) continue;
      const arr = byAsset.get(k) || [];
      arr.push(t);
      byAsset.set(k, arr);
    }
    const groups = Array.from(byAsset.entries()).map(([assetId, tickets]) => {
      const asset = assetById.get(assetId) || null;
      const openCount = tickets.filter((t: any) => maintTicketOpen(t.status)).length;
      const spend = tickets.reduce((s: number, t: any) => s + (Number(t.closure_cost) || 0), 0);
      const price = asset && asset.purchasePrice != null ? Number(asset.purchasePrice) : 0;
      const pct = price > 0 ? Math.round((spend / price) * 100) : null;
      return { assetId, asset, tickets, openCount, spend, price, pct };
    });
    // Most-serviced assets first.
    groups.sort((a, b) => b.tickets.length - a.tickets.length);
    return groups;
  }, [maintTickets, assets]);

  const maintKpis = useMemo(() => ({
    assetsWithTickets: maintGroups.length,
    totalOpen: maintGroups.reduce((s, g) => s + g.openCount, 0),
    repeatOffenders: maintGroups.filter((g) => g.tickets.length >= 2).length,
  }), [maintGroups]);

  // Repair-vs-replace: cumulative repair spend ≥ 60% of purchase price (only assets with cost data).
  const replaceFlags = useMemo(() =>
    maintGroups
      .filter((g) => g.price > 0 && g.spend >= 0.6 * g.price)
      .sort((a, b) => (b.pct || 0) - (a.pct || 0)),
  [maintGroups]);

  // ══════════════════════════════════════════════════════════════════════════
  // Web-parity maintenance ANALYTICS (verbatim port of AssetMaintenanceTab.tsx)
  // ══════════════════════════════════════════════════════════════════════════
  const MAINT_OPEN_STATUSES = useMemo(() => new Set([
    'open', 'assigned', 'in_progress', 'waiting_for_parts', 'waiting_for_cost_approval', 'reassigned',
  ]), []);

  // One analytics row per asset: tickets attached, location (apt/bed) derived from allocations.
  const maintAssetRows = useMemo(() => {
    const bedMap = new Map<string, any>();
    for (const b of beds) if (b && b._id != null) bedMap.set(String(b._id), b);
    const allocByAsset = new Map<string, any>();
    for (const al of allocations) if (al && al.asset_id != null) allocByAsset.set(String(al.asset_id), al);

    const ticketsByAsset = new Map<string, any[]>();
    for (const t of maintTickets) {
      const k = String(t?.asset_id ?? '');
      if (!k) continue;
      // Per-ticket cost: closure_cost already coalesces ticket_resolutions.total_cost (see listAssetMaintenance).
      const cost = (t.closure_cost != null && Number.isFinite(Number(t.closure_cost))) ? Number(t.closure_cost) : null;
      const summaryBits = [
        t.resolution_type ? String(t.resolution_type).split('_').join(' ') : '',
        t.service_type ? String(t.service_type).split('_').join(' ') : '',
        t.closure_summary || '',
      ].filter(Boolean);
      const row = {
        id: t.id,
        ticket_number: t.ticket_number || '—',
        created_at: t.created_at || null,
        issue_name: t.issue_type || '—',
        status: String(t.status || ''),
        resolved_at: t.resolved_at || null,
        resolution_summary: summaryBits.join(' · ') || '—',
        cost,
      };
      const arr = ticketsByAsset.get(k) || [];
      arr.push(row);
      ticketsByAsset.set(k, arr);
    }

    return assets.map((a: any) => {
      const alloc = allocByAsset.get(String(a._id));
      const bedId: string | null = alloc?.bed_id ?? null;            // mobile asset shape has no bed_id
      let aptId: string | null = alloc?.apartment_id ?? a.apartmentId ?? null;
      if (bedId && !aptId) aptId = bedMap.get(String(bedId))?.apartmentId ?? null;
      const bedCode = bedId ? (alloc?.beds?.bed_code || bedMap.get(String(bedId))?.code || '') : '';
      const tickets = ticketsByAsset.get(String(a._id)) || [];
      return {
        id: String(a._id),
        asset_code: a.assetCode || '',
        label: [a.brand, a.model].filter(Boolean).join(' '),
        type_id: (a.assetTypeId ?? null) as string | null,
        type_name: a.typeName || 'Uncategorized',
        purchase: Number(a.purchasePrice || 0),
        maint_cost: tickets.reduce((s: number, t: any) => s + (t.cost || 0), 0),
        tickets,
        open_tickets: tickets.filter((t: any) => MAINT_OPEN_STATUSES.has(t.status)).length,
        apartment_id: aptId,
        bed_id: bedId,
        bed_code: bedCode,
      };
    });
  }, [assets, allocations, beds, maintTickets, MAINT_OPEN_STATUSES]);

  // Shared filters for both sub-views.
  const maintFilteredAssets = useMemo(() => {
    const aptMap = new Map(apartments.map((a: any) => [String(a._id), a]));
    const term = maintSearch.trim().toLowerCase();
    return maintAssetRows.filter((a) => {
      if (onlyWithTickets && a.tickets.length === 0) return false;
      if (maintTypeFilter !== 'all' && a.type_id !== maintTypeFilter) return false;
      if (!term) return true;
      const aptCode = a.apartment_id ? String(aptMap.get(String(a.apartment_id))?.code || '') : '';
      return aptCode.toLowerCase().includes(term)
        || a.bed_code.toLowerCase().includes(term)
        || a.asset_code.toLowerCase().includes(term)
        || a.type_name.toLowerCase().includes(term)
        || a.label.toLowerCase().includes(term);
    });
  }, [maintAssetRows, apartments, maintSearch, maintTypeFilter, onlyWithTickets]);

  // Grouping: by apartment → Common + per-bed.
  const maintApartmentGroups = useMemo(() => {
    const groups = new Map<string, any>();
    for (const apt of apartments) {
      groups.set(String(apt._id), {
        id: String(apt._id),
        aptCode: String(apt.code || ''),
        propertyName: apt.propertyName || '',
        bedAssets: [] as any[],
        commonAssets: [] as any[],
      });
    }
    const unassigned: any[] = [];
    for (const a of maintFilteredAssets) {
      const g = a.apartment_id ? groups.get(String(a.apartment_id)) : null;
      if (!g) { unassigned.push(a); continue; }
      if (a.bed_id) g.bedAssets.push(a); else g.commonAssets.push(a);
    }
    const list = [...groups.values()]
      .filter((g) => g.bedAssets.length + g.commonAssets.length > 0)
      .map((g) => {
        const all = [...g.bedAssets, ...g.commonAssets];
        return {
          ...g,
          totalPurchase: all.reduce((s: number, a: any) => s + a.purchase, 0),
          totalMaint: all.reduce((s: number, a: any) => s + a.maint_cost, 0),
          ticketCount: all.reduce((s: number, a: any) => s + a.tickets.length, 0),
          openCount: all.reduce((s: number, a: any) => s + a.open_tickets, 0),
        };
      })
      .sort((x, y) => y.ticketCount - x.ticketCount || y.totalMaint - x.totalMaint);
    return { list, unassigned };
  }, [apartments, maintFilteredAssets]);

  // Grouping: by asset type → apartment subgroups.
  const maintTypeGroups = useMemo(() => {
    const aptMap = new Map(apartments.map((a: any) => [String(a._id), a]));
    const byType = new Map<string, any>();
    for (const a of maintFilteredAssets) {
      const key = a.type_id || 'untyped';
      const g = byType.get(key) || { typeName: a.type_name, assets: [] as any[] };
      g.assets.push(a);
      byType.set(key, g);
    }
    return [...byType.entries()]
      .map(([typeId, g]) => {
        const byApt = new Map<string, any>();
        for (const a of g.assets) {
          const key = a.apartment_id || 'unassigned';
          const code = a.apartment_id ? (aptMap.get(String(a.apartment_id))?.code || '?') : 'Unassigned';
          const ag = byApt.get(key) || { aptCode: String(code), assets: [] as any[] };
          ag.assets.push(a);
          byApt.set(key, ag);
        }
        return {
          typeId,
          typeName: g.typeName,
          assetCount: g.assets.length,
          ticketCount: g.assets.reduce((s: number, a: any) => s + a.tickets.length, 0),
          openCount: g.assets.reduce((s: number, a: any) => s + a.open_tickets, 0),
          totalPurchase: g.assets.reduce((s: number, a: any) => s + a.purchase, 0),
          totalMaint: g.assets.reduce((s: number, a: any) => s + a.maint_cost, 0),
          apartments: [...byApt.values()].sort((x: any, y: any) =>
            y.assets.reduce((s: number, a: any) => s + a.tickets.length, 0)
            - x.assets.reduce((s: number, a: any) => s + a.tickets.length, 0)),
        };
      })
      .sort((x, y) => y.ticketCount - x.ticketCount || y.totalMaint - x.totalMaint);
  }, [maintFilteredAssets, apartments]);

  // KPIs — computed on the unfiltered fleet so they describe the whole estate.
  const maintEstateKpis = useMemo(() => {
    const rows = maintAssetRows;
    const withTickets = rows.filter((a) => a.tickets.length > 0);
    const openTickets = rows.reduce((s, a) => s + a.open_tickets, 0);
    const totalPurchase = rows.reduce((s, a) => s + a.purchase, 0);
    const totalMaint = rows.reduce((s, a) => s + a.maint_cost, 0);
    const repeatAssets = rows.filter((a) => a.tickets.length >= 2);
    const aptMap = new Map(apartments.map((a: any) => [String(a._id), a]));
    const aptTickets = new Map<string, { code: string; tickets: number; maint: number }>();
    for (const a of rows) {
      if (!a.apartment_id || a.tickets.length === 0) continue;
      const cur = aptTickets.get(String(a.apartment_id)) || { code: String(aptMap.get(String(a.apartment_id))?.code || '?'), tickets: 0, maint: 0 };
      cur.tickets += a.tickets.length;
      cur.maint += a.maint_cost;
      aptTickets.set(String(a.apartment_id), cur);
    }
    const hotspotApt = [...aptTickets.values()].sort((x, y) => y.tickets - x.tickets || y.maint - x.maint)[0] || null;
    const typeAgg = new Map<string, { name: string; tickets: number; maint: number; purchase: number }>();
    for (const a of rows) {
      const key = a.type_id || 'untyped';
      const cur = typeAgg.get(key) || { name: a.type_name, tickets: 0, maint: 0, purchase: 0 };
      cur.tickets += a.tickets.length;
      cur.maint += a.maint_cost;
      cur.purchase += a.purchase;
      typeAgg.set(key, cur);
    }
    const typeList = [...typeAgg.values()];
    const hotspotType = [...typeList].sort((x, y) => y.tickets - x.tickets)[0] || null;
    const costliestType = [...typeList].sort((x, y) => y.maint - x.maint)[0] || null;
    return {
      totalAssets: rows.length,
      assetsWithTickets: withTickets.length,
      openTickets,
      totalPurchase,
      totalMaint,
      maintIntensity: totalPurchase > 0 ? (totalMaint / totalPurchase) * 100 : 0,
      repeatAssets: repeatAssets.length,
      hotspotApt,
      hotspotType,
      costliestType,
      typesInUse: typeAgg.size,
    };
  }, [maintAssetRows, apartments]);

  // Rows behind each tappable asset-type KPI card (primary | apartment(s) | why).
  const maintKpiDetailContent = useMemo(() => {
    if (!maintKpiDetail) return null;
    const fc = (v: number) => { const n = Math.round(Number(v || 0)); return n > 0 ? `₹${n.toLocaleString('en-IN')}` : '—'; };
    const assetLabel = (a: any) => `${a.type_name}${a.label ? ` · ${a.label}` : ''} · ${a.asset_code}`;
    const aptCodeById = new Map(apartments.map((a: any) => [String(a._id), String(a.code)]));
    const aptOf = (a: any) => a.apartment_id ? (aptCodeById.get(String(a.apartment_id)) || '?') : 'Unassigned';
    const typeApts = (g: any) => g.apartments.map((ag: any) => `${ag.aptCode} (${ag.assets.length})`).join(', ');
    if (maintKpiDetail === 'repeat') {
      return {
        title: 'Repeat-issue assets',
        description: 'Assets with 2 or more tickets — recurring problems and preventive-maintenance candidates.',
        primaryHeader: 'Asset',
        rows: maintAssetRows.filter((a) => a.tickets.length >= 2)
          .sort((x, y) => y.tickets.length - x.tickets.length)
          .map((a) => ({ primary: assetLabel(a), apartment: aptOf(a), reason: `${a.tickets.length} tickets (${a.open_tickets} open) · maintenance ${fc(a.maint_cost)}` })),
      };
    }
    if (maintKpiDetail === 'open') {
      return {
        title: 'Assets with open tickets',
        description: 'Assets that currently have at least one unresolved ticket.',
        primaryHeader: 'Asset',
        rows: maintAssetRows.filter((a) => a.open_tickets > 0)
          .sort((x, y) => y.open_tickets - x.open_tickets)
          .map((a) => ({ primary: assetLabel(a), apartment: aptOf(a), reason: `${a.open_tickets} open of ${a.tickets.length} total tickets` })),
      };
    }
    if (maintKpiDetail === 'problematic') {
      return {
        title: 'Most problematic asset types',
        description: 'Types ranked by ticket volume, highest first.',
        primaryHeader: 'Asset type',
        rows: maintTypeGroups.filter((g) => g.ticketCount > 0)
          .map((g) => ({ primary: g.typeName, apartment: typeApts(g), reason: `${g.ticketCount} tickets (${g.openCount} open) across ${g.assetCount} assets` })),
      };
    }
    if (maintKpiDetail === 'spend') {
      return {
        title: 'Maintenance spend by asset type',
        description: 'Types ranked by lifetime maintenance cost, with spend as a share of purchase value.',
        primaryHeader: 'Asset type',
        rows: [...maintTypeGroups].filter((g) => g.totalMaint > 0)
          .sort((x, y) => y.totalMaint - x.totalMaint)
          .map((g) => ({ primary: g.typeName, apartment: typeApts(g), reason: `${fc(g.totalMaint)} maintenance${g.totalPurchase > 0 ? ` · ${((g.totalMaint / g.totalPurchase) * 100).toFixed(1)}% of purchase value` : ''}` })),
      };
    }
    return {
      title: 'Asset types in use',
      description: 'Every asset type in the fleet and the apartments where its assets are placed.',
      primaryHeader: 'Asset type',
      rows: maintTypeGroups.map((g) => ({ primary: g.typeName, apartment: typeApts(g), reason: `${g.assetCount} assets · ${g.ticketCount} tickets · maintenance ${fc(g.totalMaint)}` })),
    };
  }, [maintKpiDetail, maintAssetRows, maintTypeGroups, apartments]);

  // ── render: INVENTORY ──
  const renderInventory = () => {
    // Only the paged window is rendered/grouped — keeps the JS thread light on large inventories.
    const visible = filteredAssets.slice(0, assetLimit);
    const typeOptions = [{ label: 'All types', value: 'all' }, ...types.map((t: any) => ({ label: t.name, value: t._id }))];
    const modeOptions = [
      { label: 'Flat list',           value: 'flat' },
      { label: 'Group by asset',      value: 'asset' },
      { label: 'Group by apartment',  value: 'apartment' },
    ];
    // Renders one inventory card — shared by flat + grouped modes.
    const renderCard = (a: any) => (
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
    );
    // Group the visible window by asset type name or apartment/location for grouped modes.
    let groups: { title: string; items: any[] }[] = [];
    if (listMode !== 'flat') {
      const map = new Map<string, any[]>();
      for (const a of visible) {
        const key = listMode === 'asset'
          ? (a.typeName || 'Unspecified')
          : (a.locationName || 'Unallocated');
        const arr = map.get(key) || [];
        arr.push(a);
        map.set(key, arr);
      }
      groups = Array.from(map.entries())
        .sort((x, y) => x[0].localeCompare(y[0]))
        .map(([title, items]) => ({ title, items }));
    }
    return (
      <View>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#EEF1F6', paddingHorizontal: 10, marginBottom: 10 }}>
          <Ionicons name="search-outline" size={16} color="#6B7280" />
          <TextInput value={search} onChangeText={setSearch} placeholder="Search inventory…" placeholderTextColor="#6B7280" style={{ flex: 1, paddingVertical: 10, paddingLeft: 6, fontSize: 14, color: '#111827' }} />
          {!!search && <TouchableOpacity onPress={() => setSearch('')}><Ionicons name="close-circle" size={16} color="#6B7280" /></TouchableOpacity>}
        </View>
        {/* View mode + Asset Type dropdowns (web parity: listModeSelect + type filter) */}
        <Row>
          <View style={{ flex: 1 }}>
            <PickerSelect label="View" value={listMode} options={modeOptions} onSelect={(v: string) => setListMode(v as any)} />
          </View>
          <View style={{ flex: 1 }}>
            <PickerSelect label="Asset Type" value={typeFilter} options={typeOptions} onSelect={setTypeFilter} />
          </View>
        </Row>
        {filteredAssets.length === 0
          ? <View style={{ alignItems: 'center', paddingVertical: 48 }}><Ionicons name="cube-outline" size={52} color="#e0d9ec" /><Text style={{ fontSize: 16, fontWeight: '800', color: '#111827', marginTop: 12 }}>No assets found</Text></View>
          : listMode === 'flat'
            ? visible.map(renderCard)
            : groups.map((g) => (
              <View key={g.title} style={{ marginBottom: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2, marginBottom: 8 }}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: '#111827', flex: 1 }} numberOfLines={1}>{g.title}</Text>
                  <Pill label={String(g.items.length)} color="#2563EB" bg="rgba(37,99,235,0.12)" />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#16a34a' }}>Total {fmtFull(g.items.reduce((s: number, a: any) => s + (Number(a.purchasePrice) || 0), 0))}</Text>
                </View>
                {g.items.map(renderCard)}
              </View>
            ))}
        {filteredAssets.length > assetLimit && (
          <TouchableOpacity
            onPress={() => setAssetLimit(l => l + ASSET_PAGE)}
            style={{ marginTop: 4, marginBottom: 12, paddingVertical: 14, borderRadius: 12, borderWidth: 1.5, borderColor: '#EEF1F6', backgroundColor: '#EFF6FF', alignItems: 'center' }}
          >
            <Text style={{ fontSize: 14, fontWeight: '800', color: '#2563EB' }}>
              Load more ({Math.min(assetLimit, filteredAssets.length)} of {filteredAssets.length})
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  // ── render: VENDORS ──
  const renderVendors = () => (
    <View>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#EEF1F6', paddingHorizontal: 10 }}>
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
          <TouchableOpacity key={v.id} activeOpacity={0.7} onPress={() => openVendorDetail(v)} style={{ backgroundColor: '#fff', borderRadius: 16, marginBottom: 10, padding: 14, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
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
    const assetGroups = Array.from(grouped.values());
    if (assetGroups.length === 0) return <View style={{ alignItems: 'center', paddingVertical: 48 }}><Ionicons name="location-outline" size={52} color="#e0d9ec" /><Text style={{ fontSize: 16, fontWeight: '800', color: '#111827', marginTop: 12 }}>No allocations</Text><Text style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>Allocate assets from the Inventory tab</Text></View>;

    const assetsById = new Map<string, any>();
    for (const a of assets) if (a && a._id != null) assetsById.set(String(a._id), a);
    const priceOf = (grp: any[]) => { const as = assetsById.get(String(grp[0].asset_id)); return as?.purchasePrice || grp[0].assets?.purchase_price || 0; };
    const modeOptions = [
      { label: 'Flat list', value: 'flat' },
      { label: 'Group by asset type', value: 'type' },
      { label: 'Group by apartment', value: 'apartment' },
    ];
    const modeBar = <View style={{ marginBottom: 10 }}><PickerSelect label="View" value={allocListMode} options={modeOptions} onSelect={(v: string) => setAllocListMode(v as any)} /></View>;

    const renderCard = (grp: any[], idx: number) => {
          const first = grp[0];
          const asset = assetsById.get(String(first.asset_id));
          const price = asset?.purchasePrice || first.assets?.purchase_price || 0;
          const perBed = first.allocation_type === 'bed' && grp.length > 0 ? Math.round(price / grp.length) : 0;
          return (
            <View key={`${first.asset_id}-${idx}`} style={{ backgroundColor: '#fff', borderRadius: 16, marginBottom: 10, padding: 14, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: '#2563EB' }}>{asset?.assetCode || first.assets?.asset_code || '—'}</Text>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: '#111827', marginTop: 1 }}>{asset?.typeName || first.assets?.asset_types?.name || '—'}</Text>
                  {!!price && <Text style={{ fontSize: 13, fontWeight: '700', color: '#16a34a', marginTop: 2 }}>{fmtFull(price)}</Text>}
                </View>
                <Pill label={first.allocation_type} color="#2563EB" bg="rgba(37,99,235,0.12)" />
              </View>
              <View style={{ borderTopWidth: 1, borderTopColor: '#EEF1F6', marginTop: 10, paddingTop: 10, gap: 6 }}>
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
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#EEF1F6', marginTop: 10, paddingTop: 10 }}>
                <Text style={{ fontSize: 11, color: '#6B7280' }}>{first.allocated_date ? `Allocated ${fmtDate(first.allocated_date)}` : ''}</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity
                    onPress={() => { setQrAsset(asset || { _id: first.asset_id, assetCode: first.assets?.asset_code, typeName: first.assets?.asset_types?.name, brand: first.assets?.brand, model: first.assets?.model }); setQrOpen(true); }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: '#EEF1F6', backgroundColor: '#EFF6FF' }}>
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
    };

    if (allocListMode === 'flat') {
      return <View>{modeBar}{assetGroups.map((grp, idx) => renderCard(grp, idx))}</View>;
    }

    // Grouped by asset type or apartment (web parity: allocationGroupLabel + per-group Total).
    const sections = new Map<string, any[][]>();
    for (const grp of assetGroups) {
      const first = grp[0];
      const as = assetsById.get(String(first.asset_id));
      const label = allocListMode === 'type'
        ? (as?.typeName || first.assets?.asset_types?.name || 'Unspecified')
        : (first.apartments?.apartment_code || first.properties?.property_name || 'Unassigned');
      const arr = sections.get(label) || []; arr.push(grp); sections.set(label, arr);
    }
    const sorted = Array.from(sections.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    return (
      <View>
        {modeBar}
        {sorted.map(([label, grps]) => {
          const total = grps.reduce((s, g) => s + priceOf(g), 0);
          return (
            <View key={label} style={{ marginBottom: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2, marginBottom: 8, flexWrap: 'wrap' }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: '#111827', flexShrink: 1 }} numberOfLines={1}>{label}</Text>
                <Pill label={String(grps.length)} color="#2563EB" bg="rgba(37,99,235,0.12)" />
                <Text style={{ fontSize: 12, fontWeight: '700', color: '#16a34a' }}>Total {fmtFull(total)}</Text>
                <View style={{ flex: 1 }} />
                {allocListMode === 'apartment' && (
                  <TouchableOpacity
                    onPress={() => downloadApartmentQrPdf(label, grps, assetsById).catch((e: any) => Alert.alert('Error', e?.message || 'Could not create the QR PDF.'))}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: '#EEF1F6', backgroundColor: '#EFF6FF' }}>
                    <Ionicons name="download-outline" size={13} color="#2563EB" />
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#2563EB' }}>Download QRs</Text>
                  </TouchableOpacity>
                )}
              </View>
              {grps.map((grp, idx) => renderCard(grp, idx))}
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
        <TouchableOpacity onPress={() => setCatOpen(true)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 12, borderRadius: 12, borderWidth: 1.5, borderColor: '#EEF1F6', backgroundColor: 'rgba(37,99,235,0.04)' }}>
          <Ionicons name="add" size={16} color="#2563EB" /><Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>Add Category</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { setTypeCatId(categories[0]?._id || ''); setTypeOpen(true); }} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 12, borderRadius: 12, borderWidth: 1.5, borderColor: '#EEF1F6', backgroundColor: 'rgba(37,99,235,0.04)' }}>
          <Ionicons name="add" size={16} color="#2563EB" /><Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>Add Asset Type</Text>
        </TouchableOpacity>
      </View>
      {categories.length === 0
        ? <View style={{ alignItems: 'center', paddingVertical: 48 }}><Ionicons name="folder-outline" size={52} color="#e0d9ec" /><Text style={{ fontSize: 16, fontWeight: '800', color: '#111827', marginTop: 12 }}>No categories</Text></View>
        : categories.map((c: any) => {
          const catTypes = types.filter((t: any) => t.categoryId === c._id);
          const assetCount = assets.filter((a: any) => a.categoryName === c.name).length;
          return (
            <View key={c._id} style={{ backgroundColor: '#fff', borderRadius: 16, marginBottom: 10, padding: 14, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
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
        <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: '#111827', marginBottom: 14 }}>Assets by Category</Text>
          <MiniBar data={(stats.byCategory || []).map((c: any) => ({ name: c.name, count: c.count }))} />
        </View>
        <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
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
          <View key={f.id || i} style={{ backgroundColor: '#fff', borderRadius: 16, marginBottom: 10, padding: 14, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
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

  // ── render: MAINTENANCE (asset-linked tickets grouped by asset + repair-vs-replace insights) ──
  const renderMaintenance = () => {
    if (maintLoading && !maintLoaded) {
      return <View style={{ alignItems: 'center', paddingVertical: 48 }}><ActivityIndicator size="large" color="#2563EB" /><Text style={{ marginTop: 12, color: '#6B7280' }}>Loading maintenance…</Text></View>;
    }

    const card = { backgroundColor: '#fff', borderRadius: 16, padding: 14, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } } as const;
    const fmtCost = (v: number | null | undefined) => { const n = Math.round(Number(v || 0)); return n > 0 ? `₹${n.toLocaleString('en-IN')}` : '—'; };
    const tStColor = (s: any) => {
      const x = String(s || '').toLowerCase();
      if (['completed', 'closed', 'resolved'].includes(x)) return '#16a34a';
      if (['open', 'new', 'pending', 'reopened'].includes(x)) return '#DC2626';
      if (['in_progress', 'in progress', 'assigned', 'accepted', 'scheduled'].includes(x)) return '#2563EB';
      return '#F59E0B';
    };
    const toggleIn = (set: (u: (p: Set<string>) => Set<string>) => void) => (id: string) => set((prev) => {
      const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n;
    });
    const toggleAsset = toggleIn(setExpandedMaint);
    const toggleApt = toggleIn(setExpandedMaintApt);
    const toggleType = toggleIn(setExpandedMaintType);
    const typeOptions = [{ label: 'All asset types', value: 'all' }, ...types.map((t: any) => ({ label: t.name, value: t._id }))];

    // ── small KPI card (tappable when onPress given) ──
    const kpiCard = (key: string, label: string, value: any, sub?: string, onPress?: () => void, accent?: string) => {
      const inner = (
        <>
          <Text style={{ fontSize: 10, color: accent || '#2563EB', fontWeight: '800', textTransform: 'uppercase' }} numberOfLines={1}>{label}</Text>
          <Text style={{ fontSize: 18, fontWeight: '900', color: '#111827', marginTop: 4 }} numberOfLines={1}>{value}</Text>
          {!!sub && <Text style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }} numberOfLines={2}>{sub}</Text>}
        </>
      );
      const st = { ...card, padding: 12, width: '48.5%', marginBottom: 8 } as any;
      return onPress
        ? <TouchableOpacity key={key} activeOpacity={0.7} onPress={onPress} style={st}>{inner}</TouchableOpacity>
        : <View key={key} style={st}>{inner}</View>;
    };

    // ── cost chips (cart purchase · wrench maintenance) ──
    const costChips = (purchase: number, maint: number) => (
      <>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
          <Ionicons name="cart-outline" size={13} color="#0284c7" />
          <Text style={{ fontSize: 12, color: '#111827' }}>{fmtCost(purchase)}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
          <Ionicons name="construct-outline" size={13} color="#d97706" />
          <Text style={{ fontSize: 12, color: '#111827' }}>{fmtCost(maint)}</Text>
        </View>
      </>
    );

    // ── count badges (assets / tickets / open) ──
    const countBadges = (assetCount: number, ticketCount: number, openCount: number) => (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <Pill label={`${assetCount} assets`} color="#6B7280" bg="#F1F3F9" />
        <Pill label={`${ticketCount} tickets`} color={ticketCount > 0 ? '#2563EB' : '#6B7280'} bg={ticketCount > 0 ? 'rgba(37,99,235,0.12)' : '#F1F3F9'} />
        {openCount > 0 && <Pill label={`${openCount} open`} color="#DC2626" bg="#FEE2E2" />}
      </View>
    );

    // ── expandable asset row → ticket table ──
    const assetRowBlock = (a: any) => {
      const open = expandedMaint.has(a.id);
      return (
        <View key={a.id} style={{ borderWidth: 1, borderColor: '#EEF1F6', borderRadius: 10, backgroundColor: '#F8FAFC', marginTop: 6, overflow: 'hidden' }}>
          <TouchableOpacity activeOpacity={0.7} disabled={a.tickets.length === 0} onPress={() => a.tickets.length > 0 && toggleAsset(a.id)} style={{ padding: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <Text style={{ fontSize: 12, fontWeight: '800', color: '#111827' }}>{a.type_name}</Text>
              {!!a.label && <Text style={{ fontSize: 12, color: '#6B7280' }}>· {a.label}</Text>}
              <Text style={{ fontSize: 12, color: '#6B7280' }}>· {a.asset_code}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
              {costChips(a.purchase, a.maint_cost)}
              <View style={{ flex: 1 }} />
              <Pill label={`${a.tickets.length} ticket${a.tickets.length === 1 ? '' : 's'}`} color={a.tickets.length > 0 ? '#2563EB' : '#6B7280'} bg={a.tickets.length > 0 ? 'rgba(37,99,235,0.12)' : '#F1F3F9'} />
              {a.open_tickets > 0 && <Pill label={`${a.open_tickets} open`} color="#DC2626" bg="#FEE2E2" />}
              {a.tickets.length > 0 && <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color="#6B7280" />}
            </View>
          </TouchableOpacity>
          {open && a.tickets.length > 0 && (
            <View style={{ borderTopWidth: 1, borderTopColor: '#EEF1F6', padding: 10, backgroundColor: '#fff' }}>
              {a.tickets.map((t: any) => (
                <View key={t.id} style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: 'rgba(37,99,235,0.06)' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, flexWrap: 'wrap' }}>
                      <Text style={{ fontSize: 12, fontWeight: '800', color: '#111827' }}>{t.ticket_number}</Text>
                      <Pill label={t.status || 'open'} color={tStColor(t.status)} bg={tStColor(t.status) + '18'} />
                    </View>
                    <Text style={{ fontSize: 13, fontWeight: '800', color: t.cost != null ? '#16a34a' : '#6B7280' }}>{t.cost != null ? fmtCost(t.cost) : '—'}</Text>
                  </View>
                  <Text style={{ fontSize: 12, color: '#556274', marginTop: 2 }}>{t.issue_name}</Text>
                  <Text style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>Raised {fmtDate(t.created_at)} · Resolved {fmtDate(t.resolved_at)}</Text>
                  {t.resolution_summary !== '—' && <Text style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>{t.resolution_summary}</Text>}
                </View>
              ))}
            </View>
          )}
        </View>
      );
    };

    // When loaded and there are genuinely no asset-linked tickets, show the friendly empty state.
    if (maintLoaded && maintTickets.length === 0) {
      return (
        <View style={{ alignItems: 'center', paddingVertical: 48 }}>
          <Ionicons name="construct-outline" size={52} color="#e0d9ec" />
          <Text style={{ fontSize: 16, fontWeight: '800', color: '#111827', marginTop: 12 }}>No maintenance tickets</Text>
          <Text style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>Asset-linked tickets appear here</Text>
        </View>
      );
    }

    const k = maintEstateKpis;
    const aptView = maintView === 'by_apartment';

    return (
      <View>
        {/* ── Shared filter bar ── */}
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#EEF1F6', paddingHorizontal: 10, marginBottom: 10 }}>
          <Ionicons name="search-outline" size={16} color="#6B7280" />
          <TextInput value={maintSearch} onChangeText={setMaintSearch} placeholder="Search apartment, bed, asset…" placeholderTextColor="#6B7280" style={{ flex: 1, paddingVertical: 10, paddingLeft: 6, fontSize: 14, color: '#111827' }} />
          {!!maintSearch && <TouchableOpacity onPress={() => setMaintSearch('')}><Ionicons name="close-circle" size={16} color="#6B7280" /></TouchableOpacity>}
        </View>
        <PickerSelect label="Asset Type" value={maintTypeFilter} options={typeOptions} onSelect={setMaintTypeFilter} />
        <Checkbox checked={onlyWithTickets} onToggle={() => setOnlyWithTickets((v) => !v)} label="Show only assets with tickets" />

        {/* ── Inner sub-view tabs ── */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
          <TouchableOpacity onPress={() => setMaintView('by_apartment')} activeOpacity={0.7} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, borderRadius: 10, backgroundColor: aptView ? '#EFF6FF' : '#F1F3F9', borderWidth: 1, borderColor: aptView ? '#2563EB' : 'transparent' }}>
            <Ionicons name="business-outline" size={14} color={aptView ? '#2563EB' : '#64748B'} />
            <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: '800', color: aptView ? '#2563EB' : '#64748B' }}>Apartment Based Listing</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setMaintView('by_type')} activeOpacity={0.7} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, borderRadius: 10, backgroundColor: !aptView ? '#F5F3FF' : '#F1F3F9', borderWidth: 1, borderColor: !aptView ? '#6D28D9' : 'transparent' }}>
            <Ionicons name="cube-outline" size={14} color={!aptView ? '#6D28D9' : '#64748B'} />
            <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: '800', color: !aptView ? '#6D28D9' : '#64748B' }}>Asset Type Based Listing</Text>
          </TouchableOpacity>
        </View>

        {/* ── KPI cards ── */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          {aptView ? [
            kpiCard('apts', 'Apartments with assets', maintApartmentGroups.list.length),
            kpiCard('total', 'Total assets', k.totalAssets, `${fmtCost(k.totalPurchase)} invested`),
            kpiCard('withTk', 'Assets with tickets', k.assetsWithTickets, k.totalAssets > 0 ? `${Math.round((k.assetsWithTickets / k.totalAssets) * 100)}% of fleet` : undefined),
            kpiCard('open', 'Open tickets', k.openTickets),
            kpiCard('spend', 'Maintenance spend', fmtCost(k.totalMaint), `${k.maintIntensity.toFixed(1)}% of purchase value`),
            kpiCard('hotspot', 'Hotspot apartment', k.hotspotApt ? k.hotspotApt.code : '—', k.hotspotApt ? `${k.hotspotApt.tickets} tickets · ${fmtCost(k.hotspotApt.maint)}` : undefined),
          ] : [
            kpiCard('types', 'Asset types in use', k.typesInUse, 'click for details', () => setMaintKpiDetail('types'), '#6D28D9'),
            kpiCard('prob', 'Most problematic type', (k.hotspotType && k.hotspotType.tickets > 0) ? k.hotspotType.name : '—', (k.hotspotType && k.hotspotType.tickets > 0) ? `${k.hotspotType.tickets} tickets · click for details` : undefined, () => setMaintKpiDetail('problematic'), '#6D28D9'),
            kpiCard('costly', 'Highest maintenance spend', (k.costliestType && k.costliestType.maint > 0) ? k.costliestType.name : '—', (k.costliestType && k.costliestType.maint > 0) ? `${fmtCost(k.costliestType.maint)} · click for details` : undefined, () => setMaintKpiDetail('spend'), '#6D28D9'),
            kpiCard('repeat', 'Repeat-issue assets', k.repeatAssets, 'assets with 2+ tickets — click for details', () => setMaintKpiDetail('repeat'), '#6D28D9'),
            kpiCard('openT', 'Open tickets', k.openTickets, 'click for details', () => setMaintKpiDetail('open'), '#6D28D9'),
          ]}
        </View>

        {/* ── Body: by apartment ── */}
        {aptView && (
          <View style={{ marginTop: 4 }}>
            {maintApartmentGroups.list.map((g) => {
              const open = expandedMaintApt.has(g.id);
              const m: Record<string, any[]> = {};
              for (const a of g.bedAssets) { (m[a.bed_code] = m[a.bed_code] || []).push(a); }
              const bedGroups = Object.entries(m).sort(([x], [y]) => x.localeCompare(y));
              return (
                <View key={g.id} style={{ ...card, marginBottom: 10 }}>
                  <TouchableOpacity activeOpacity={0.7} onPress={() => toggleApt(g.id)}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827' }}>{g.aptCode}</Text>
                      {!!g.propertyName && <Text style={{ fontSize: 11, color: '#6B7280', flex: 1 }} numberOfLines={1}>{g.propertyName}</Text>}
                      {!g.propertyName && <View style={{ flex: 1 }} />}
                      <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color="#6B7280" />
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
                      {costChips(g.totalPurchase, g.totalMaint)}
                      <View style={{ flex: 1 }} />
                      {countBadges(g.bedAssets.length + g.commonAssets.length, g.ticketCount, g.openCount)}
                    </View>
                  </TouchableOpacity>
                  {open && (
                    <View style={{ marginTop: 10 }}>
                      {g.commonAssets.length > 0 && (
                        <View style={{ marginBottom: 6 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <Ionicons name="home-outline" size={12} color="#6B7280" />
                            <Text style={{ fontSize: 11, fontWeight: '800', color: '#6B7280' }}>Common ({g.commonAssets.length})</Text>
                          </View>
                          {g.commonAssets.map(assetRowBlock)}
                        </View>
                      )}
                      {bedGroups.map(([bedCode, bedGroup]) => (
                        <View key={bedCode} style={{ marginBottom: 6 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <Ionicons name="bed-outline" size={12} color="#6B7280" />
                            <Text style={{ fontSize: 11, fontWeight: '800', color: '#6B7280' }}>Bed {bedCode} ({bedGroup.length})</Text>
                          </View>
                          {bedGroup.map(assetRowBlock)}
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              );
            })}
            {maintApartmentGroups.unassigned.length > 0 && (
              <View style={{ ...card, marginBottom: 10 }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: '#111827', marginBottom: 2 }}>Unassigned assets ({maintApartmentGroups.unassigned.length})</Text>
                {maintApartmentGroups.unassigned.map(assetRowBlock)}
              </View>
            )}
            {maintApartmentGroups.list.length === 0 && maintApartmentGroups.unassigned.length === 0 && (
              <Text style={{ fontSize: 13, color: '#6B7280', textAlign: 'center', paddingVertical: 32 }}>No assets match the current filters.</Text>
            )}
          </View>
        )}

        {/* ── Body: by asset type ── */}
        {!aptView && (
          <View style={{ marginTop: 4 }}>
            {maintTypeGroups.map((g) => {
              const open = expandedMaintType.has(g.typeId);
              return (
                <View key={g.typeId} style={{ ...card, marginBottom: 10 }}>
                  <TouchableOpacity activeOpacity={0.7} onPress={() => toggleType(g.typeId)}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827', flex: 1 }} numberOfLines={1}>{g.typeName}</Text>
                      <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color="#6B7280" />
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
                      {costChips(g.totalPurchase, g.totalMaint)}
                      <View style={{ flex: 1 }} />
                      {countBadges(g.assetCount, g.ticketCount, g.openCount)}
                    </View>
                  </TouchableOpacity>
                  {open && (
                    <View style={{ marginTop: 10 }}>
                      {g.apartments.map((ag: any) => (
                        <View key={ag.aptCode} style={{ marginBottom: 6 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <Ionicons name="business-outline" size={12} color="#6B7280" />
                            <Text style={{ fontSize: 11, fontWeight: '800', color: '#6B7280' }}>{ag.aptCode} ({ag.assets.length})</Text>
                          </View>
                          {ag.assets.map(assetRowBlock)}
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              );
            })}
            {maintTypeGroups.length === 0 && (
              <Text style={{ fontSize: 13, color: '#6B7280', textAlign: 'center', paddingVertical: 32 }}>No assets match the current filters.</Text>
            )}
          </View>
        )}

        {/* ── KPI detail modal (asset-type cards) ── */}
        <Modal visible={!!maintKpiDetail} transparent animationType="fade" onRequestClose={() => setMaintKpiDetail(null)}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 20 }}>
            <View style={{ backgroundColor: '#fff', borderRadius: 20, padding: 18, maxHeight: '80%' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={{ fontSize: 16, fontWeight: '900', color: '#111827', flex: 1 }}>{maintKpiDetailContent?.title}</Text>
                <TouchableOpacity onPress={() => setMaintKpiDetail(null)}><Ionicons name="close" size={22} color="#6B7280" /></TouchableOpacity>
              </View>
              <Text style={{ fontSize: 11, color: '#6B7280', marginBottom: 10 }}>{maintKpiDetailContent?.description}</Text>
              {maintKpiDetailContent && maintKpiDetailContent.rows.length > 0 ? (
                <ScrollView style={{ maxHeight: 440 }}>
                  {maintKpiDetailContent.rows.map((r, i) => (
                    <View key={i} style={{ paddingVertical: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: '#EEF1F6' }}>
                      <Text style={{ fontSize: 13, fontWeight: '800', color: '#111827' }}>{r.primary}</Text>
                      <Text style={{ fontSize: 11, color: '#2563EB', marginTop: 2 }}>{r.apartment}</Text>
                      <Text style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>{r.reason}</Text>
                    </View>
                  ))}
                </ScrollView>
              ) : (
                <Text style={{ fontSize: 13, color: '#6B7280', textAlign: 'center', paddingVertical: 24 }}>Nothing qualifies at the moment.</Text>
              )}
            </View>
          </View>
        </Modal>
      </View>
    );
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'inventory':   return renderInventory();
      case 'payments':    return <AssetPaymentsTab />;
      case 'vendors':     return renderVendors();
      case 'allocations': return renderAllocations();
      case 'maintenance': return renderMaintenance();
      case 'categories':  return renderCategories();
      case 'analytics':   return renderAnalytics();
      case 'forecasts':   return renderForecasts();
      default:            return null;
    }
  };

  const visibleTabs = filterTabs(TABS, visibleTabKeys);
  // Web parity: "Inventory Allocated (N)" and "Vendors (N)" carry a live count in the label.
  const tabLabel = (t: any) => {
    if (t.key === 'allocations') return `${t.label} (${allocations.length})`;
    if (t.key === 'vendors')     return `${t.label} (${vendors.length})`;
    return t.label;
  };

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
              <Text style={{ fontSize: 13, color: '#64748B', fontWeight: '500', marginTop: 2 }}>Track assets, vendors, allocations</Text>
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
            <View key={s.label} style={{ flex: 1, backgroundColor: '#fff', borderRadius: 16, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
              <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: s.color + '18', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
                <Ionicons name={s.icon as any} size={14} color={s.color} />
              </View>
              <Text style={{ fontSize: 14, fontWeight: '900', color: '#0F172A' }}>{s.value}</Text>
              <Text style={{ fontSize: 9, color: '#64748B' }}>{s.label}</Text>
            </View>
          ))}
        </View>

        {/* Tab bar */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 46, marginBottom: 6 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 8, alignItems: 'center' }}>
          {visibleTabs.map((t: any) => (
            <TouchableOpacity key={t.key} onPress={() => setActiveTab(t.key)} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: activeTab === t.key ? '#6D28D9' : '#F1F3F9' }}>
              <Ionicons name={t.icon} size={14} color={activeTab === t.key ? '#fff' : '#64748B'} />
              <Text style={{ fontSize: 12, fontWeight: '700', color: activeTab === t.key ? '#fff' : '#64748B' }}>{tabLabel(t)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Content */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { if (activeTab === 'maintenance') loadMaintenance(); else setMaintLoaded(false); fetchAll(true); }} tintColor="#2563EB" />}
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
          <TouchableOpacity onPress={() => { setEditAsset(null); setAssetModalOpen(true); }} style={{ position: 'absolute', right: 20, bottom: navClear + 12, width: 56, height: 56, borderRadius: 28, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center', shadowColor: '#2563EB', shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}>
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
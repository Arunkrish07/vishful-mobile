import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Modal, Alert, TextInput, ActivityIndicator, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { colors, spacing, fontSize, glass } from '../lib/theme';
import { Button, Input, EmptyState, LoadingScreen, GlassBackground, DateField, PageHeader, IconBtnSolid, SearchField, FilterChip } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { Ionicons } from '@expo/vector-icons';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import { useMountedRef, isAbortError } from '../lib/safeAsync';
import { fetchVisibleTabKeys, filterTabs } from '../lib/tabPermissions';
import { client as convexClient, api as convexApi } from '../lib/convexApi';

// ─────────────────────────────────────────────────────────────────────────────
// STATUS CONFIG
// Keys must exactly match normaliseStatus() output in supabaseApi.ts
// DB values:  "staying" | "exited" | "NEW" | "on-notice" | null
// Normalised: "staying" | "exited" | "new" | "on-notice" | "new"
// ─────────────────────────────────────────────────────────────────────────────
interface StatusDef { label: string; color: string; bg: string; icon: string; }

const STATUS: Record<string, StatusDef> = {
  staying:    { label: 'Staying',    color: '#16A34A', bg: '#DCFCE7', icon: 'home'         },
  onboarding: { label: 'Onboarding', color: '#1D4ED8', bg: '#EEF3FF', icon: 'person-add'   },
  'on-notice':{ label: 'On Notice',  color: '#EA580C', bg: '#FFEDD5', icon: 'warning'      },
  new:        { label: 'New',        color: '#1D4ED8', bg: '#EEF3FF', icon: 'star-outline'  },
  booked:     { label: 'Booked',     color: '#1D4ED8', bg: '#EEF3FF', icon: 'calendar'     },
  kyc_pending:{ label: 'KYC Pending',color: '#EA580C', bg: '#FFEDD5', icon: 'hourglass-outline' },
  exited:     { label: 'Exited',     color: '#64748B', bg: '#F1F5F9', icon: 'exit'         },
};

const getStatus = (s?: string): StatusDef =>
  STATUS[s || 'new'] || { label: s || 'New', color: '#1D4ED8', bg: '#EEF3FF', icon: 'star-outline' };

// ─────────────────────────────────────────────────────────────────────────────
// STAT CHIPS — web order: All Status | New | Booked | Staying | On Notice | Exited
// ─────────────────────────────────────────────────────────────────────────────
const STAT_CHIPS = [
  { key: 'all',        label: 'All Status', color: '#6A2C90' },
  { key: 'new',        label: 'New',        color: '#6A2C90' },
  { key: 'booked',     label: 'Booked',     color: '#6A2C90' },
  { key: 'staying',    label: 'Staying',    color: '#16A34A' },
  { key: 'on-notice',  label: 'On Notice',  color: '#EA580C' },
  { key: 'exited',     label: 'Exited',     color: '#64748B' },
];

type TabKey = 'tenants' | 'allotments';

const EMPTY_FORM = {
  // Personal
  first_name: '', last_name: '',
  phone: '', email: '',
  relation_name: '',       // S/W/D of
  date_of_birth: '',
  gender: '',
  food_preference: '',
  profession: '',
  // Address
  address: '', city: '', state: '', pincode: '',
  // Professional
  company_name: '', designation: '', date_of_joining: '',
  company_address: '', company_city: '', company_state: '', company_pincode: '',
  // Emergency contact
  emergencyContactName: '', emergencyContactRelation: '', emergencyContactPhone: '',
  // Bank
  bank_name: '', bank_branch: '', bank_account_number: '', bank_account_holder: '', bank_ifsc: '',
  // Identity / Tax
  aadhar_number: '', pan_number: '', gst_number: '', gst_name: '',
  // Legacy fields kept for backward compat
  name: '', permanentAddress: '', idProof: '',
  companyAddress: '', ebBillAmount: '', onboardingDate: '',
  emergencyContactPhone: '',  // alias kept for old handleAdd
};

// ─────────────────────────────────────────────────────────────────────────────
export default function TenantsScreen() {
  const { token, user } = useAuth();
  const nav = useNavigation();
  const mounted = useMountedRef();


  // ── Data ──
  const [tenants,    setTenants]    = useState<any[] | null>(null);
  const [beds,       setBeds]       = useState<any[] | null>(null);
  const [allotments, setAllotments] = useState<any[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey(k => k + 1), []);

  // ── UI ──
  const [activeTab,    setActiveTab]    = useState<TabKey>('tenants');
  const [visibleTabKeys, setVisibleTabKeys] = useState<Set<string> | null>(null);

  useEffect(() => {
    fetchVisibleTabKeys(user?.role || '', 'Tenants').then(keys => {
      setVisibleTabKeys(keys);
    });
  }, [user?.role]);
  // Default filter = 'staying' so the list is useful immediately
  const [statusFilter, setStatusFilter] = useState('staying');
  const [search,       setSearch]       = useState('');
  const [loading,      setLoading]      = useState(false);

  // ── Modals ──
  const [showAdd,     setShowAdd]     = useState(false);
  const [showEdit,    setShowEdit]    = useState(false);
  const [editTenant,  setEditTenant]  = useState<any>(null);

  // ── NEW: Tenant detail modal (3 tabs: Details / Remarks / Rating) ──────────
  const [detailTenant,   setDetailTenant]   = useState<any>(null);
  const [showDetail,     setShowDetail]     = useState(false);
  const [detailTab,      setDetailTab]      = useState<'details' | 'remarks' | 'rating'>('details');
  const [tenantRemarks,  setTenantRemarks]  = useState<any[]>([]);
  const [remarksLoading, setRemarksLoading] = useState(false);

  // ── NEW: Add Remark modal ──────────────────────────────────────────────────
  const [showAddRemark, setShowAddRemark] = useState(false);
  const [remarkForm, setRemarkForm] = useState({
    remark_type: 'neutral' as 'positive' | 'negative' | 'dispute' | 'neutral',
    title: '', description: '',
    severity: 'medium' as 'low' | 'medium' | 'high' | 'critical',
  });
  const [remarkLoading, setRemarkLoading] = useState(false);

  // ── NEW: Rating computation state ─────────────────────────────────────────
  const [computingRatingId, setComputingRatingId] = useState<string | null>(null);
  const [batchRatingProgress, setBatchRatingProgress] = useState<{ done: number; total: number } | null>(null);

  // ── NEW: Duplicate phone records modal ────────────────────────────────────
  const [showDuplicates,  setShowDuplicates]  = useState(false);
  const [dupPhone,        setDupPhone]        = useState('');
  const [dupResults,      setDupResults]      = useState<any[]>([]);
  const [dupGroups,       setDupGroups]       = useState<{ phone: string; tenants: any[] }[]>([]);
  const [dupLoading,      setDupLoading]      = useState(false);

  // ── Form ──
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const setF = (k: keyof typeof EMPTY_FORM) => (v: string) =>
    setForm(prev => ({ ...prev, [k]: v }));

  // ── NEW: Photo + document upload state ────────────────────────────────────
  const [photoUri,        setPhotoUri]        = useState<string | null>(null);
  const [photoBase64,     setPhotoBase64]     = useState<string | undefined>();
  const [aadhaarFrontUri, setAadhaarFrontUri] = useState<string | null>(null);
  const [aadhaarFrontBase64, setAadhaarFrontBase64] = useState<string | undefined>();
  const [aadhaarBackUri,  setAadhaarBackUri]  = useState<string | null>(null);
  const [idCardUri,       setIdCardUri]       = useState<string | null>(null);
  const [uploadingDocs,   setUploadingDocs]   = useState(false);

  // Helper to pick image from gallery or camera
  const pickImage = async (onDone: (uri: string, b64?: string) => void, title = 'Upload Photo') => {
    Alert.alert(title, 'Choose source', [
      { text: 'Gallery', onPress: async () => {
        const IP = await import('expo-image-picker') as any;
        const { status } = await IP.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') { Alert.alert('Permission needed'); return; }
        const r = await IP.launchImageLibraryAsync({ mediaTypes: 'images' as any, quality: 0.8, base64: true });
        if (!r.canceled && r.assets[0]) onDone(r.assets[0].uri, r.assets[0].base64 ?? undefined);
      }},
      { text: 'Camera', onPress: async () => {
        const IP = await import('expo-image-picker') as any;
        const { status } = await IP.requestCameraPermissionsAsync();
        if (status !== 'granted') { Alert.alert('Permission needed'); return; }
        const r = await IP.launchCameraAsync({ quality: 0.8, base64: true });
        if (!r.canceled && r.assets[0]) onDone(r.assets[0].uri, r.assets[0].base64 ?? undefined);
      }},
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  // Upload to Supabase storage and return public URL
  const uploadDocToStorage = async (uri: string, base64: string | undefined, bucket: string, context: string): Promise<string | null> => {
    try {
      const { uploadTicketPhoto } = await import('../services/ticketService') as any;
      return await uploadTicketPhoto(uri, base64, 'image/jpeg', bucket);
    } catch { return null; }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Load data
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    setTenants(null);
    Promise.all([
      sb.listTenantsEnriched(),
      sb.listBeds({}),
      sb.listAllotments(),
    ]).then(([t, b, a]: any) => {
      if (!mounted.current) return;
      setTenants(t ?? []);
      setBeds(b ?? []);
      setAllotments(a ?? []);
    }).catch((e: any) => {
      if (!mounted.current || isAbortError(e)) return;
      setTenants([]); setBeds([]); setAllotments([]);
    });
  }, [token, refreshKey]);

  // ─────────────────────────────────────────────────────────────────────────
  // Counts — reads stayingStatus (normalised from allotments in backend)
  // ─────────────────────────────────────────────────────────────────────────
  const countFor = (key: string): number => {
    if (!tenants) return 0;
    if (key === 'all') return tenants.length;
    return tenants.filter(t => t.stayingStatus === key).length;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Filtered list
  // ─────────────────────────────────────────────────────────────────────────
  const filtered = (tenants || []).filter(t => {
    const matchStatus = statusFilter === 'all' || t.stayingStatus === statusFilter;
    const q = search.toLowerCase();
    const matchSearch = !q ||
      (t.name        || '').toLowerCase().includes(q) ||
      (t.phone       || '').includes(q) ||
      (t.email       || '').toLowerCase().includes(q) ||
      (t.companyName || '').toLowerCase().includes(q) ||
      (t.designation || '').toLowerCase().includes(q);
    return matchStatus && matchSearch;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Handlers
  // ─────────────────────────────────────────────────────────────────────────
  const handleAdd = async () => {
    const fullName = [form.first_name, form.last_name].filter(Boolean).join(' ') || form.name;
    if (!fullName.trim() || !form.phone) { Alert.alert('Error', 'First Name and Phone are required'); return; }
    setLoading(true);
    try {
      // Upload photo if selected
      let photoUrl: string | null = null;
      if (photoUri) {
        setUploadingDocs(true);
        photoUrl = await uploadDocToStorage(photoUri, photoBase64, 'kyc-photos', 'photo');
        setUploadingDocs(false);
      }
      // Upload the Aadhaar front doc → id_proof_url (the one KYC document column).
      let idProofUrl: string | null = null;
      if (aadhaarFrontUri && aadhaarFrontBase64) {
        setUploadingDocs(true);
        idProofUrl = await uploadDocToStorage(aadhaarFrontUri, aadhaarFrontBase64, 'kyc-docs', 'aadhaar');
        setUploadingDocs(false);
      }
      // 1. Create the base tenant (live createTenant only persists identity).
      const created: any = await sb.createTenant({
        full_name: fullName,
        phone:     form.phone,
        email:     form.email || null,
        gender:    form.gender || null,
      });
      // 2. Persist the full KYC/profile on the new row via updateTenant (a raw
      //    update that accepts every real `tenants` column). Aadhaar is stored in
      //    the id_proof_* columns. Unconfirmed columns (bank_*, gst_*, food, …)
      //    are intentionally omitted so the write can't fail.
      const newId = created?.id || created?._id;
      if (newId) {
        await sb.updateTenant(newId, {
          first_name:               form.first_name || null,
          last_name:                form.last_name || null,
          date_of_birth:            form.date_of_birth || null,
          profession:               form.profession || null,
          designation:              form.designation || null,
          address:                  form.address || form.permanentAddress || null,
          city:                     form.city || null,
          state:                    form.state || null,
          pincode:                  form.pincode || null,
          company_name:             form.company_name || null,
          company_address:          form.company_address || null,
          emergency_contact_name:   form.emergencyContactName || null,
          emergency_contact_phone:  form.emergencyContactPhone || null,
          pan_number:               form.pan_number || null,
          // ── Full KYC field set (data-loss fix: form collected these but they
          //    were previously dropped). Backend whitelist expanded to persist. ──
          bank_name:                  form.bank_name || null,
          bank_account_number:        form.bank_account_number || null,
          bank_ifsc:                  form.bank_ifsc || null,
          gst_number:                 form.gst_number || null,
          food_preference:            form.food_preference || null,
          relation_name:              form.relation_name || null,
          date_of_joining:            form.date_of_joining || null,
          company_city:               form.company_city || null,
          company_state:              form.company_state || null,
          company_pincode:            form.company_pincode || null,
          emergency_contact_relation: form.emergencyContactRelation || null,
          ...(form.aadhar_number ? { id_proof_number: form.aadhar_number, id_proof_type: 'aadhaar' } : {}),
          ...(idProofUrl ? { id_proof_url: idProofUrl } : {}),
          ...(photoUrl ? { photo_url: photoUrl } : {}),
          kyc_completed:            true,
        });
      }
      setShowAdd(false);
      setForm({ ...EMPTY_FORM });
      setPhotoUri(null); setPhotoBase64(undefined);
      setAadhaarFrontUri(null); setAadhaarFrontBase64(undefined); setAadhaarBackUri(null); setIdCardUri(null);
      refresh();
    } catch (e: any) { Alert.alert('Error', e.message); }
    setLoading(false);
  };

  const handleEdit = async () => {
    if (!editTenant) return;
    const fullName = [form.first_name, form.last_name].filter(Boolean).join(' ') || form.name;
    if (!fullName.trim() || !form.phone) { Alert.alert('Error', 'Name and Phone required'); return; }
    setLoading(true);
    try {
      // Upload a newly-picked photo (photoBase64 is only set when the user picks one).
      let photoUrl: string | null = editTenant.photoUrl || null;
      if (photoUri && photoBase64) {
        setUploadingDocs(true);
        photoUrl = (await uploadDocToStorage(photoUri, photoBase64, 'kyc-photos', 'photo')) || photoUrl;
        setUploadingDocs(false);
      }
      let idProofUrl: string | null = null;
      if (aadhaarFrontUri && aadhaarFrontBase64) {
        setUploadingDocs(true);
        idProofUrl = await uploadDocToStorage(aadhaarFrontUri, aadhaarFrontBase64, 'kyc-docs', 'aadhaar');
        setUploadingDocs(false);
      }
      await sb.updateTenant(editTenant._id, {
        full_name:                fullName,
        first_name:               form.first_name || null,
        last_name:                form.last_name || null,
        phone:                    form.phone,
        email:                    form.email || null,
        gender:                   form.gender || null,
        date_of_birth:            form.date_of_birth || null,
        profession:               form.profession || null,
        designation:              form.designation || null,
        address:                  form.address || form.permanentAddress || null,
        city:                     form.city || null,
        state:                    form.state || null,
        pincode:                  form.pincode || null,
        company_name:             form.company_name || null,
        company_address:          form.company_address || form.companyAddress || null,
        emergency_contact_name:   form.emergencyContactName || null,
        emergency_contact_phone:  form.emergencyContactPhone || null,
        pan_number:               form.pan_number || null,
        // ── Full KYC field set (data-loss fix: previously dropped on edit). ──
        bank_name:                  form.bank_name || null,
        bank_account_number:        form.bank_account_number || null,
        bank_ifsc:                  form.bank_ifsc || null,
        gst_number:                 form.gst_number || null,
        food_preference:            form.food_preference || null,
        relation_name:              form.relation_name || null,
        date_of_joining:            form.date_of_joining || null,
        company_city:               form.company_city || null,
        company_state:              form.company_state || null,
        company_pincode:            form.company_pincode || null,
        emergency_contact_relation: form.emergencyContactRelation || null,
        ...(idProofUrl ? { id_proof_url: idProofUrl } : {}),
        photo_url:                photoUrl,
      });
      setShowEdit(false); setEditTenant(null); setForm({ ...EMPTY_FORM });
      setPhotoUri(null); setPhotoBase64(undefined);
      setAadhaarFrontUri(null); setAadhaarFrontBase64(undefined); setAadhaarBackUri(null); setIdCardUri(null);
      refresh();
    } catch (e: any) { Alert.alert('Error', e.message); }
    setLoading(false);
  };

  const openEdit = (t: any) => {
    setEditTenant(t);
    setForm({
      name:                    t.name || '',
      first_name:              t.name?.split(' ')[0] || '',
      last_name:               t.name?.split(' ').slice(1).join(' ') || '',
      phone:                   t.phone || '',
      email:                   t.email || '',
      relation_name:           t.relationName || '',
      date_of_birth:           t.dateOfBirth || '',
      gender:                  t.gender || '',
      food_preference:         t.foodPreference || '',
      profession:              t.designation || '',
      address:                 t.permanentAddress || '',
      city:                    t.city || '',
      state:                   t.state || '',
      pincode:                 t.pincode || '',
      company_name:            t.companyName || '',
      designation:             t.designation || '',
      date_of_joining:         '',
      company_address:         t.companyAddress || '',
      company_city:            '',
      company_state:           '',
      company_pincode:         '',
      emergencyContactName:    t.emergencyContactName || '',
      emergencyContactRelation:'',
      emergencyContactPhone:   t.emergencyContactPhone || '',
      bank_name:               '',
      bank_branch:             '',
      bank_account_number:     '',
      bank_account_holder:     '',
      bank_ifsc:               '',
      aadhar_number:           '',
      pan_number:              t.panNumber || '',
      gst_number:              '',
      gst_name:                '',
      idProof:                 t.idProofNumber || '',
      permanentAddress:        t.permanentAddress || '',
      companyAddress:          t.companyAddress || '',
      ebBillAmount:            '',
      onboardingDate:          t.onboardingDate || '',
    });
    setPhotoUri(t.photoUrl || null); setPhotoBase64(undefined);
    setAadhaarFrontUri(null); setAadhaarFrontBase64(undefined); setAadhaarBackUri(null); setIdCardUri(null);
    setShowEdit(true);
  };

  // Check-out (vacate) is a financial exit: it needs deductions, refund and a
  // settlement record. That form lives in the Tenant Lifecycle → Exit flow, so
  // route there instead of writing a broken/incomplete allotment update here.
  const handleCheckOut = (t: any) => {
    Alert.alert(
      'Check Out',
      `Vacate & settle ${t.name} in the Tenant Lifecycle exit flow (deductions, deposit refund).`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Go to Exit', onPress: () => nav.dispatch(DrawerActions.jumpTo('Tenant Lifecycle')) },
      ],
    );
  };

  // ── NEW: Open tenant detail modal ────────────────────────────────────────
  const openDetail = useCallback((t: any) => {
    setDetailTenant(t);
    setDetailTab('details');
    setTenantRemarks([]);
    setShowDetail(true);
  }, []);

  const loadRemarks = useCallback(async (tenantId: string) => {
    setRemarksLoading(true);
    try {
      const data = await convexClient.action((convexApi as any).tenants.listTenantRemarks, { tenantId });
      setTenantRemarks(data || []);
    } catch { setTenantRemarks([]); }
    setRemarksLoading(false);
  }, []);

  useEffect(() => {
    if (showDetail && detailTenant?._id && detailTab === 'remarks') {
      loadRemarks(detailTenant._id);
    }
  }, [showDetail, detailTab, detailTenant?._id]);

  // ── NEW: Add remark ───────────────────────────────────────────────────────
  const handleAddRemark = async () => {
    if (!remarkForm.title.trim()) { Alert.alert('Required', 'Title is required'); return; }
    setRemarkLoading(true);
    try {
      await convexClient.action((convexApi as any).tenants.addTenantRemark, {
        tenantId:    detailTenant._id,
        remarkType:  remarkForm.remark_type,
        title:       remarkForm.title,
        description: remarkForm.description || undefined,
        severity:    remarkForm.severity,
        createdBy:   user?.supabaseUserId || user?.userId || 'unknown',
      });
      setShowAddRemark(false);
      setRemarkForm({ remark_type: 'neutral', title: '', description: '', severity: 'medium' });
      await loadRemarks(detailTenant._id);
    } catch (e: any) { Alert.alert('Error', e.message); }
    setRemarkLoading(false);
  };

  // ── NEW: Compute single tenant rating ─────────────────────────────────────
  const handleComputeRating = async (tenantId: string) => {
    setComputingRatingId(tenantId);
    try {
      const result = await convexClient.action((convexApi as any).tenants.computeTenantRating, { tenantId });
      Alert.alert('Rating computed', `Score: ${result.score.toFixed(1)} / 10`);
      refresh();
      // Also update detailTenant in-place
      if (detailTenant?._id === tenantId) {
        setDetailTenant((prev: any) => ({ ...prev, tenantRating: result.score, ratingLastComputed: new Date().toISOString() }));
      }
    } catch (e: any) { Alert.alert('Error', e.message); }
    setComputingRatingId(null);
  };

  // ── NEW: Compute all ratings ──────────────────────────────────────────────
  const handleComputeAllRatings = async () => {
    const ids = (tenants || []).map((t: any) => t._id).filter(Boolean);
    if (!ids.length) { Alert.alert('No tenants', 'No tenants to compute ratings for.'); return; }
    Alert.alert('Compute All Ratings', `This will compute ratings for ${ids.length} tenants. Continue?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Compute', onPress: async () => {
        setBatchRatingProgress({ done: 0, total: ids.length });
        let done = 0;
        for (const id of ids) {
          try { await convexClient.action((convexApi as any).tenants.computeTenantRating, { tenantId: id }); }
          catch { /* skip failed */ }
          done++;
          setBatchRatingProgress({ done, total: ids.length });
        }
        setBatchRatingProgress(null);
        refresh();
        Alert.alert('Done', 'All tenant ratings updated.');
      }},
    ]);
  };

  // ── NEW: Duplicate phone detection ────────────────────────────────────────
  const runDuplicateScanAll = async () => {
    setDupLoading(true); setDupResults([]);
    try {
      const groups = await convexClient.action((convexApi as any).tenants.getDuplicateTenants, {});
      setDupGroups(groups || []);
    } catch (e: any) { Alert.alert('Error', e.message); }
    setDupLoading(false);
  };

  const runDuplicateSearch = async () => {
    if (!dupPhone.trim()) return;
    setDupLoading(true); setDupGroups([]);
    try {
      const results = await convexClient.action((convexApi as any).tenants.searchTenantsByPhone, { phone: dupPhone.trim() });
      setDupResults(results || []);
    } catch (e: any) { Alert.alert('Error', e.message); }
    setDupLoading(false);
  };

  // ── NEW: Merge duplicate tenants (web parity: merge_tenants RPC) ───────────
  // Picks the allotted record (or the first) as primary and merges the rest in.
  const tenantHasAllotment = (t: any) => {
    const match = (tenants || []).find((ten: any) => ten._id === t.id);
    return !!(match?.allotmentId || t.allotmentId || t.tenant_allotment_id);
  };
  const handleMergeDuplicates = (members: any[]) => {
    const list = (members || []).filter(Boolean);
    if (list.length < 2) return;
    const allotted = list.filter(tenantHasAllotment);
    if (allotted.length > 1) {
      Alert.alert('Cannot merge automatically', 'More than one of these records has an allotment. Merging two allotted tenants is blocked — cancel one allotment first, then merge.');
      return;
    }
    const primary = allotted[0] || list[0];
    const secondaries = list.filter((t: any) => t.id !== primary.id);
    if (!secondaries.length) return;
    Alert.alert(
      'Merge duplicates',
      `Merge ${secondaries.length} record${secondaries.length === 1 ? '' : 's'} into “${primary.full_name || 'primary'}”?\n\nAll allotments, remarks, documents, receipts and tickets move to the primary; the duplicate record${secondaries.length === 1 ? ' is' : 's are'} deleted. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Merge', style: 'destructive', onPress: async () => {
          setDupLoading(true);
          try {
            let moved = 0;
            for (const s of secondaries) {
              const res: any = await convexClient.action((convexApi as any).tenants.mergeTenants, { primaryId: primary.id, secondaryId: s.id });
              if (!res?.ok) throw new Error(res?.error || 'Merge failed');
              moved += res.totalMoved || 0;
            }
            setRefreshKey((k: number) => k + 1);
            await runDuplicateScanAll();
            Alert.alert('Merged', `Merged into “${primary.full_name || 'primary'}”. ${moved} record${moved === 1 ? '' : 's'} moved.`);
          } catch (e: any) {
            Alert.alert('Merge failed', e?.message || 'Could not merge these records.');
          } finally {
            setDupLoading(false);
          }
        } },
      ],
    );
  };

  // ── NEW: Delete tenant ────────────────────────────────────────────────────
  const handleDeleteTenant = (t: any) => {
    Alert.alert('Delete Tenant', `Delete "${t.name}"? This cannot be undone.\n\nOnly NEW tenants with no allotments can be deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await convexClient.action((convexApi as any).tenants.deleteTenant, { tenantId: t._id });
          refresh();
          Alert.alert('Deleted', 'Tenant removed.');
        } catch (e: any) { Alert.alert('Cannot delete', e.message); }
      }},
    ]);
  };

  // ─────────────────────────────────────────────────────────────────────────
  if (!tenants || !beds) return <LoadingScreen />;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <GlassBackground>
      <SafeAreaView style={tenantStyles.root} edges={['top']}>

        {/* ── Header ── */}
        <PageHeader
          title="Tenants"
          subtitle="Manage tenant KYC records"
          right={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {/* Compute All Ratings — outline/ghost */}
              <TouchableOpacity
                style={tenantStyles.ghostIconBtn}
                onPress={handleComputeAllRatings}
                disabled={!!batchRatingProgress}
              >
                <Ionicons name="star-outline" size={17} color="#D97706" />
              </TouchableOpacity>
              {/* List Multiple Records — outline/ghost */}
              <TouchableOpacity
                style={tenantStyles.ghostIconBtn}
                onPress={() => { setDupPhone(''); setDupResults([]); setDupGroups([]); setShowDuplicates(true); runDuplicateScanAll(); }}
              >
                <Ionicons name="copy-outline" size={17} color="#6A2C90" />
              </TouchableOpacity>
              <TouchableOpacity
                style={tenantStyles.ghostIconBtn}
                onPress={() => nav.dispatch(DrawerActions.jumpTo('Tenant Lifecycle'))}
              >
                <Ionicons name="log-in-outline" size={18} color="#16A34A" />
              </TouchableOpacity>
              <IconBtnSolid
                icon="add"
                onPress={() => { setForm({ ...EMPTY_FORM }); setShowAdd(true); }}
              />
            </View>
          }
        />

        {/* Batch rating progress bar */}
        {batchRatingProgress && (
          <View style={{ paddingHorizontal: 16, paddingVertical: 8, backgroundColor: 'rgba(245,158,11,0.1)', borderBottomWidth: 1, borderBottomColor: 'rgba(245,158,11,0.3)' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: '#92400E' }}>Computing ratings…</Text>
              <Text style={{ fontSize: 12, color: '#92400E' }}>{batchRatingProgress.done}/{batchRatingProgress.total}</Text>
            </View>
            <View style={{ height: 6, backgroundColor: 'rgba(245,158,11,0.2)', borderRadius: 99, overflow: 'hidden' }}>
              <View style={{ height: 6, backgroundColor: '#F59E0B', borderRadius: 99, width: `${Math.round((batchRatingProgress.done / batchRatingProgress.total) * 100)}%` as any }} />
            </View>
          </View>
        )}

        {/* ── Tabs ── */}
        <View style={tenantStyles.tabBar}>
          {filterTabs([
            { key: 'tenants'    as TabKey, label: 'Tenants',    icon: 'people-outline' as const },
            { key: 'allotments' as TabKey, label: 'Allotments', icon: 'bed-outline'    as const },
          ], visibleTabKeys).map(tab => (
            <TouchableOpacity
              key={tab.key}
              style={[tenantStyles.tabItem, activeTab === tab.key && tenantStyles.tabItemActive]}
              onPress={() => setActiveTab(tab.key)}
            >
              <Ionicons
                name={tab.icon}
                size={15}
                color={activeTab === tab.key ? '#6A2C90' : colors.textTertiary}
              />
              <Text style={[tenantStyles.tabText, activeTab === tab.key && tenantStyles.tabTextActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
          keyboardShouldPersistTaps="handled"
        >

          {/* ══ TENANTS TAB ══ */}
          {activeTab === 'tenants' ? (
            <>
              {/* Status filter chips with live counts */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginBottom: 14 }}
              >
                <View style={{ flexDirection: 'row', gap: 8, paddingRight: 8 }}>
                  {STAT_CHIPS.map(chip => (
                    <FilterChip
                      key={chip.key}
                      label={chip.label}
                      active={statusFilter === chip.key}
                      count={countFor(chip.key)}
                      onPress={() => setStatusFilter(chip.key)}
                    />
                  ))}
                </View>
              </ScrollView>

              {/* Search bar */}
              <SearchField
                value={search}
                onChangeText={setSearch}
                placeholder="Search tenants..."
                style={{ marginBottom: 8 }}
              />

              {/* Result count */}
              <Text style={tenantStyles.resultLabel}>
                {filtered.length} tenant{filtered.length !== 1 ? 's' : ''}
                {statusFilter !== 'all' ? ` · ${getStatus(statusFilter).label}` : ''}
              </Text>

              {/* Tenant cards */}
              {filtered.length === 0 ? (
                <EmptyState
                  title={`No ${getStatus(statusFilter).label} Tenants`}
                  subtitle="Try a different filter or add a new tenant"
                  icon="people-outline"
                />
              ) : (
                filtered.map(t => (
                  <TenantCard
                    key={t._id}
                    tenant={t}
                    onEdit={() => openEdit(t)}
                    onCheckOut={() => handleCheckOut(t)}
                    onViewDetail={() => openDetail(t)}
                    onDelete={() => handleDeleteTenant(t)}
                    computingRating={computingRatingId === t._id}
                    onComputeRating={() => handleComputeRating(t._id)}
                  />
                ))
              )}
            </>
          ) : (
            /* ══ ALLOTMENTS TAB ══ */
            <>
              {/* Header row */}
              <View style={{
                flexDirection: 'row', justifyContent: 'space-between',
                alignItems: 'center', marginBottom: 14,
              }}>
                <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
                  Allotments ({allotments.length})
                </Text>
                <TouchableOpacity
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 4,
                    backgroundColor: colors.primary,
                    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12,
                  }}
                  onPress={() => nav.dispatch(DrawerActions.jumpTo('Tenant Lifecycle'))}
                >
                  <Ionicons name="add-circle-outline" size={15} color="#fff" />
                  <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>
                    Allot Bed
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Allotment status summary */}
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                {(['staying', 'on-notice', 'onboarding'] as const).map(k => {
                  const sc    = getStatus(k);
                  const count = allotments.filter(a => a.stayingStatus === k).length;
                  return (
                    <View
                      key={k}
                      style={[tenantStyles.allotStat, {
                        backgroundColor: sc.bg,
                        borderColor: sc.color + '40',
                      }]}
                    >
                      <Text style={{
                        fontSize: 22, fontWeight: '900', color: sc.color,
                      }}>
                        {count}
                      </Text>
                      <Text style={{
                        fontSize: 10, color: sc.color,
                        fontWeight: '600', marginTop: 2,
                      }}>
                        {sc.label}
                      </Text>
                    </View>
                  );
                })}
              </View>

              {allotments.length === 0 ? (
                <EmptyState
                  title="No Allotments"
                  subtitle="No bed allotments found"
                  icon="bed-outline"
                />
              ) : (
                allotments.map(a => {
                  const sc = getStatus(a.stayingStatus);
                  return (
                    <View key={a._id} style={tenantStyles.card}>
                      <View style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                      }}>
                        <View style={{ flex: 1 }}>
                          <Text style={tenantStyles.cardName}>{a.tenantName}</Text>
                          <View style={{
                            flexDirection: 'row', alignItems: 'center',
                            gap: 5, marginTop: 4, flexWrap: 'wrap',
                          }}>
                            <Ionicons name="bed-outline" size={13} color={colors.primary} />
                            <Text style={{
                              fontSize: 13, color: colors.primary, fontWeight: '700',
                            }}>
                              {a.bedCode}
                            </Text>
                            <Text style={tenantStyles.dot}>·</Text>
                            <Text style={tenantStyles.cardSub}>{a.apartmentCode}</Text>
                            <Text style={tenantStyles.dot}>·</Text>
                            <Text style={tenantStyles.cardSub}>{a.propertyName}</Text>
                          </View>
                          <View style={{
                            flexDirection: 'row', gap: 12,
                            marginTop: 6, flexWrap: 'wrap',
                          }}>
                            <Text style={{ fontSize: 11, color: colors.textTertiary }}>
                              In: {a.onboardingDate || '—'}
                            </Text>
                            {a.monthlyRental > 0 && (
                              <Text style={{
                                fontSize: 11, color: '#16a34a', fontWeight: '700',
                              }}>
                                ₹{a.monthlyRental.toLocaleString('en-IN')}/mo
                              </Text>
                            )}
                            {a.balanceDue > 0 && (
                              <Text style={{
                                fontSize: 11, color: '#dc2626', fontWeight: '600',
                              }}>
                                Due: ₹{a.balanceDue.toLocaleString('en-IN')}
                              </Text>
                            )}
                          </View>
                        </View>
                        <StatusPill status={a.stayingStatus} />
                      </View>
                    </View>
                  );
                })
              )}
            </>
          )}
        </ScrollView>

        {/* ── Add Tenant Modal ── */}
        <TenantFormModal
          visible={showAdd}
          title="Add Tenant"
          form={form}
          setF={setF}
          loading={loading}
          onClose={() => { setShowAdd(false); setForm({ ...EMPTY_FORM }); setPhotoUri(null); setPhotoBase64(undefined); setAadhaarFrontUri(null); setAadhaarBackUri(null); setIdCardUri(null); }}
          onSubmit={handleAdd}
          submitLabel="Add Tenant"
          photoUri={photoUri}
          setPhotoUri={setPhotoUri}
          setPhotoBase64={setPhotoBase64}
          aadhaarFrontUri={aadhaarFrontUri}
          setAadhaarFrontUri={setAadhaarFrontUri}
          setAadhaarFrontBase64={setAadhaarFrontBase64}
          aadhaarBackUri={aadhaarBackUri}
          setAadhaarBackUri={setAadhaarBackUri}
          idCardUri={idCardUri}
          setIdCardUri={setIdCardUri}
          pickImage={pickImage}
        />

        {/* ── Edit Tenant Modal ── */}
        <TenantFormModal
          visible={showEdit}
          title="Edit Tenant"
          form={form}
          setF={setF}
          loading={loading}
          onClose={() => { setShowEdit(false); setEditTenant(null); setForm({ ...EMPTY_FORM }); setPhotoUri(null); setPhotoBase64(undefined); setAadhaarFrontUri(null); setAadhaarBackUri(null); setIdCardUri(null); }}
          onSubmit={handleEdit}
          submitLabel="Save Changes"
          photoUri={photoUri}
          setPhotoUri={setPhotoUri}
          setPhotoBase64={setPhotoBase64}
          aadhaarFrontUri={aadhaarFrontUri}
          setAadhaarFrontUri={setAadhaarFrontUri}
          setAadhaarFrontBase64={setAadhaarFrontBase64}
          aadhaarBackUri={aadhaarBackUri}
          setAadhaarBackUri={setAadhaarBackUri}
          idCardUri={idCardUri}
          setIdCardUri={setIdCardUri}
          pickImage={pickImage}
        />

        {/* ── NEW: Tenant Detail Modal (3 tabs) ── */}
        <Modal visible={showDetail} animationType="slide" presentationStyle="pageSheet">
          <GlassBackground><SafeAreaView style={{ flex: 1 }}>
            <ModalHeader title={detailTenant?.name || 'Tenant Details'} onClose={() => { setShowDetail(false); setDetailTenant(null); }} />
            {/* Tab bar */}
            <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border }}>
              {(['details', 'remarks', 'rating'] as const).map(tab => (
                <TouchableOpacity key={tab} onPress={() => setDetailTab(tab)}
                  style={{ flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: detailTab === tab ? colors.primary : 'transparent' }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: detailTab === tab ? colors.primary : colors.textSecondary, textTransform: 'capitalize' }}>
                    {tab}{tab === 'remarks' ? ` (${tenantRemarks.length})` : ''}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
              {/* Details Tab */}
              {detailTab === 'details' && detailTenant && (
                <View style={{ gap: 12 }}>
                  {[
                    ['Name', detailTenant.name || '—'],
                    ['Phone', detailTenant.phone || '—'],
                    ['Email', detailTenant.email || '—'],
                    ['Status', detailTenant.stayingStatus || '—'],
                    ['KYC', detailTenant.kycCompleted ? '✅ Complete' : '❌ Pending'],
                    ['Company', detailTenant.companyName || '—'],
                    ['Designation', detailTenant.designation || '—'],
                    ['Date of Birth', detailTenant.dateOfBirth || '—'],
                    ['Gender', detailTenant.gender || '—'],
                    ['Emergency Contact', [detailTenant.emergencyContactName, detailTenant.emergencyContactPhone].filter(Boolean).join(' · ') || '—'],
                  ].map(([label, value]) => (
                    <View key={label} style={{ flexDirection: 'row', gap: 12 }}>
                      <Text style={{ fontSize: 13, color: colors.textSecondary, width: 130 }}>{label}:</Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, flex: 1 }}>{value}</Text>
                    </View>
                  ))}
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Button title="Edit" onPress={() => { setShowDetail(false); openEdit(detailTenant); }} variant="secondary" icon="pencil-outline" />
                    </View>
                    {(detailTenant.stayingStatus === 'new' || detailTenant.stayingStatus === 'New') && (
                      <View style={{ flex: 1 }}>
                        <Button title="Delete" onPress={() => { setShowDetail(false); handleDeleteTenant(detailTenant); }} variant="danger" icon="trash-outline" />
                      </View>
                    )}
                  </View>
                </View>
              )}
              {/* Remarks Tab */}
              {detailTab === 'remarks' && (
                <>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>Remarks &amp; Disputes</Text>
                    <TouchableOpacity onPress={() => setShowAddRemark(true)}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.primary, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 12 }}>
                      <Ionicons name="add" size={14} color="#fff" />
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#fff' }}>Add Remark</Text>
                    </TouchableOpacity>
                  </View>
                  {remarksLoading ? (
                    <View style={{ alignItems: 'center', padding: 24 }}><ActivityIndicator color={colors.primary} /></View>
                  ) : tenantRemarks.length === 0 ? (
                    <EmptyState title="No Remarks" subtitle="No remarks recorded yet" icon="chatbubble-outline" />
                  ) : tenantRemarks.map((r: any) => {
                    const typeColors: Record<string, { bg: string; text: string }> = {
                      positive: { bg: '#F0FDF4', text: '#16A34A' },
                      negative: { bg: '#FEF2F2', text: '#DC2626' },
                      dispute:  { bg: '#FFF7ED', text: '#EA580C' },
                      neutral:  { bg: '#F8FAFC', text: '#64748B' },
                    };
                    const severityColors: Record<string, string> = { low: '#1D4ED8', medium: '#D97706', high: '#EA580C', critical: '#DC2626' };
                    const tc = typeColors[r.remark_type] || typeColors.neutral;
                    return (
                      <View key={r.id} style={{ backgroundColor: tc.bg, borderRadius: 16, padding: 12, borderWidth: 1, borderColor: tc.text + '30', marginBottom: 10 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                          <View style={{ backgroundColor: tc.text + '20', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                            <Text style={{ fontSize: 10, fontWeight: '700', color: tc.text, textTransform: 'uppercase' }}>{r.remark_type}</Text>
                          </View>
                          <View style={{ backgroundColor: (severityColors[r.severity] || '#64748B') + '20', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                            <Text style={{ fontSize: 10, fontWeight: '700', color: severityColors[r.severity] || '#64748B', textTransform: 'uppercase' }}>{r.severity}</Text>
                          </View>
                          <Text style={{ fontSize: 11, color: colors.textTertiary, marginLeft: 'auto' }}>
                            {r.created_at ? formatDate(r.created_at, '') : ''}
                          </Text>
                        </View>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>{r.title}</Text>
                        {r.description ? <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 4 }}>{r.description}</Text> : null}
                      </View>
                    );
                  })}
                </>
              )}
              {/* Rating Tab */}
              {detailTab === 'rating' && detailTenant && (
                <>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                    <View>
                      <Text style={{ fontSize: 36, fontWeight: '900', color: colors.text }}>
                        {detailTenant.tenantRating != null ? Number(detailTenant.tenantRating).toFixed(1) : '—'}
                        <Text style={{ fontSize: 18, color: colors.textSecondary, fontWeight: '400' }}> / 10</Text>
                      </Text>
                      {detailTenant.tenantRating != null && (
                        <RatingBadge rating={detailTenant.tenantRating} />
                      )}
                      {detailTenant.ratingLastComputed && (
                        <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 4 }}>
                          Last computed: {new Date(detailTenant.ratingLastComputed).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </Text>
                      )}
                    </View>
                    <TouchableOpacity onPress={() => handleComputeRating(detailTenant._id)}
                      disabled={computingRatingId === detailTenant._id}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12 }}>
                      {computingRatingId === detailTenant._id
                        ? <ActivityIndicator size="small" color="#fff" />
                        : <Ionicons name="refresh-outline" size={15} color="#fff" />}
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Compute Rating</Text>
                    </TouchableOpacity>
                  </View>
                  <View style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: 10 }}>Rating Breakdown</Text>
                    {[
                      ['Payment Timeliness', 'max 4 pts', '7 days = 4, 15 days = 3, 30 days = 2, late = 1'],
                      ['Tickets Raised', 'max 3 pts', '0=3, 1–2=2, 3–5=1, 6+=0'],
                      ['Remarks Score', 'max 3 pts', 'Positive adds, Negative/Dispute deducts'],
                    ].map(([title, max, detail]) => (
                      <View key={title} style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary, marginTop: 5 }} />
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{title} <Text style={{ color: colors.textTertiary, fontWeight: '400' }}>({max})</Text></Text>
                          <Text style={{ fontSize: 11, color: colors.textTertiary }}>{detail}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </>
              )}
            </ScrollView>
          </SafeAreaView></GlassBackground>
        </Modal>

        {/* ── NEW: Add Remark Modal ── */}
        <Modal visible={showAddRemark} animationType="slide" presentationStyle="pageSheet">
          <GlassBackground><SafeAreaView style={{ flex: 1 }}>
            <ModalHeader title="Add Remark" onClose={() => setShowAddRemark(false)} />
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 80 }}>
              <SecLabel>Type *</SecLabel>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                {(['positive', 'negative', 'dispute', 'neutral'] as const).map(t => {
                  const icons = { positive: '✅', negative: '❌', dispute: '⚠️', neutral: '➖' };
                  const active = remarkForm.remark_type === t;
                  return (
                    <TouchableOpacity key={t} onPress={() => setRemarkForm(p => ({ ...p, remark_type: t }))}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1.5, borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primaryLight : colors.surface }}>
                      <Text style={{ fontSize: 12 }}>{icons[t]}</Text>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: active ? colors.primary : colors.textSecondary, textTransform: 'capitalize' }}>{t}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <SecLabel>Severity</SecLabel>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                {(['low', 'medium', 'high', 'critical'] as const).map(s => {
                  const active = remarkForm.severity === s;
                  const sColors: Record<string, string> = { low: '#1D4ED8', medium: '#D97706', high: '#EA580C', critical: '#DC2626' };
                  return (
                    <TouchableOpacity key={s} onPress={() => setRemarkForm(p => ({ ...p, severity: s }))}
                      style={{ flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center', borderWidth: 1.5, borderColor: active ? sColors[s] : colors.border, backgroundColor: active ? sColors[s] + '15' : colors.surface }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: active ? sColors[s] : colors.textSecondary, textTransform: 'capitalize' }}>{s}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Input label="Title *" value={remarkForm.title} onChangeText={v => setRemarkForm(p => ({ ...p, title: v }))} placeholder="Brief title…" />
              <Input label="Details" value={remarkForm.description} onChangeText={v => setRemarkForm(p => ({ ...p, description: v }))} placeholder="Describe the issue or feedback…" multiline />
              <View style={{ marginTop: 8 }}>
                <Button title="Save Remark" onPress={handleAddRemark} loading={remarkLoading} icon="checkmark-circle-outline" />
              </View>
            </ScrollView>
          </SafeAreaView></GlassBackground>
        </Modal>

        {/* ── NEW: Duplicate Phone Records Modal ── */}
        <Modal visible={showDuplicates} animationType="slide" presentationStyle="pageSheet">
          <GlassBackground><SafeAreaView style={{ flex: 1 }}>
            <ModalHeader title="Duplicate Phone Records" onClose={() => setShowDuplicates(false)} />
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
              {/* Search by phone */}
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                <TextInput
                  style={[{ flex: 1, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 10, fontSize: 14, color: colors.text }]}
                  placeholder="Enter phone number to search"
                  placeholderTextColor={colors.textTertiary}
                  value={dupPhone}
                  onChangeText={setDupPhone}
                  keyboardType="phone-pad"
                />
                <TouchableOpacity onPress={runDuplicateSearch} disabled={dupLoading || !dupPhone.trim()}
                  style={{ backgroundColor: colors.primary, paddingHorizontal: 14, borderRadius: 12, justifyContent: 'center' }}>
                  <Text style={{ color: '#fff', fontWeight: '700' }}>{dupLoading ? '…' : 'Search'}</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity onPress={runDuplicateScanAll} disabled={dupLoading}
                style={{ backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: '#EEF1F6', padding: 12, alignItems: 'center', marginBottom: 16, flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
                {dupLoading ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="scan-outline" size={16} color={colors.primary} />}
                <Text style={{ fontSize: 13, fontWeight: '600', color: colors.primary }}>{dupLoading ? 'Scanning…' : 'List all duplicate / triplicate phone records'}</Text>
              </TouchableOpacity>
              {dupGroups.length > 0 ? dupGroups.map(g => (
                <View key={g.phone} style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 1 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>{g.phone}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={{ backgroundColor: '#FEF3C7', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: '#D97706' }}>{g.tenants.length} records</Text>
                      </View>
                      {g.tenants.length >= 2 && (
                        <TouchableOpacity onPress={() => handleMergeDuplicates(g.tenants)} disabled={dupLoading}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, opacity: dupLoading ? 0.5 : 1 }}>
                          <Ionicons name="git-merge-outline" size={13} color="#fff" />
                          <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>Merge</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                  {g.tenants.map((t: any) => {
                    const match = (tenants || []).find((ten: any) => ten._id === t.id);
                    const hasAllotment = !!(match?.allotmentId || t.allotmentId || t.tenant_allotment_id);
                    return (
                    <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{t.full_name || '—'}</Text>
                        <Text style={{ fontSize: 11, color: colors.textSecondary }}>{t.email || '—'} · {(t.staying_status || 'new').toUpperCase()}</Text>
                        <View style={{ flexDirection: 'row', marginTop: 3 }}>
                          <View style={{ backgroundColor: hasAllotment ? '#ECFDF5' : '#F1F5F9', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                            <Text style={{ fontSize: 10, fontWeight: '700', color: hasAllotment ? '#059669' : '#64748B' }}>{hasAllotment ? 'Allocated' : 'No allotment'}</Text>
                          </View>
                        </View>
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <TouchableOpacity onPress={() => { setShowDuplicates(false); if (match) openEdit(match); }}
                          style={{ backgroundColor: colors.primaryLight, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 }}>
                          <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primary }}>Open</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => handleDeleteTenant({ _id: t.id, name: t.full_name })} disabled={hasAllotment}
                          style={{ backgroundColor: hasAllotment ? colors.border : '#FEE2E2', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, opacity: hasAllotment ? 0.5 : 1 }}>
                          <Text style={{ fontSize: 12, fontWeight: '700', color: hasAllotment ? colors.textTertiary : '#DC2626' }}>Delete</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                    );
                  })}
                </View>
              )) : dupResults.length > 0 ? dupResults.map((t: any) => {
                const match = (tenants || []).find((ten: any) => ten._id === t.id);
                const hasAllotment = !!(match?.allotmentId || t.allotmentId || t.tenant_allotment_id);
                return (
                <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, backgroundColor: colors.surface, borderRadius: 16, marginBottom: 8, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 1 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{t.full_name || '—'}</Text>
                    <Text style={{ fontSize: 11, color: colors.textSecondary }}>{t.phone} · {t.email || '—'} · {(t.staying_status || 'new').toUpperCase()}</Text>
                    <View style={{ flexDirection: 'row', marginTop: 3 }}>
                      <View style={{ backgroundColor: hasAllotment ? '#ECFDF5' : '#F1F5F9', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: hasAllotment ? '#059669' : '#64748B' }}>{hasAllotment ? 'Allocated' : 'No allotment'}</Text>
                      </View>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <TouchableOpacity onPress={() => { setShowDuplicates(false); if (match) openEdit(match); }}
                      style={{ backgroundColor: colors.primaryLight, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primary }}>Open</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleDeleteTenant({ _id: t.id, name: t.full_name })} disabled={hasAllotment}
                      style={{ backgroundColor: hasAllotment ? colors.border : '#FEE2E2', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, opacity: hasAllotment ? 0.5 : 1 }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: hasAllotment ? colors.textTertiary : '#DC2626' }}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                );
              }) : !dupLoading ? (
                <Text style={{ fontSize: 13, color: colors.textTertiary, textAlign: 'center', paddingVertical: 24 }}>No duplicate records found.</Text>
              ) : null}
            </ScrollView>
          </SafeAreaView></GlassBackground>
        </Modal>
      </SafeAreaView>
    </GlassBackground>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TenantCard
// ─────────────────────────────────────────────────────────────────────────────
function TenantCard({
  tenant: t,
  onEdit,
  onCheckOut,
  onViewDetail,
  onDelete,
  computingRating,
  onComputeRating,
}: {
  tenant: any;
  onEdit: () => void;
  onCheckOut: () => void;
  onViewDetail: () => void;
  onDelete: () => void;
  computingRating: boolean;
  onComputeRating: () => void;
}) {
  const sc       = getStatus(t.stayingStatus);
  const isActive = t.stayingStatus === 'staying' || t.stayingStatus === 'onboarding';
  const isNotice = t.stayingStatus === 'on-notice';

  return (
    <TouchableOpacity activeOpacity={0.8} onPress={onViewDetail} style={tenantStyles.card}>
      {/* Top row: avatar + info + status pill */}
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
        {/* Avatar */}
        <View style={[tenantStyles.avatar, { backgroundColor: sc.bg, borderColor: sc.color + '50' }]}>
          <Text style={[tenantStyles.avatarText, { color: sc.color }]}>
            {(t.name || '?')[0].toUpperCase()}
          </Text>
        </View>

        {/* Details */}
        <View style={{ flex: 1 }}>
          <View style={{
            flexDirection: 'row', alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <Text style={tenantStyles.cardName} numberOfLines={1}>{t.name}</Text>
            <StatusPill status={t.stayingStatus} />
          </View>

          {/* Phone + gender */}
          <View style={{
            flexDirection: 'row', alignItems: 'center',
            gap: 4, marginTop: 3, flexWrap: 'wrap',
          }}>
            <Ionicons name="call-outline" size={12} color={colors.textTertiary} />
            <Text style={tenantStyles.cardSub}>{t.phone}</Text>
            {t.gender ? (
              <><Text style={tenantStyles.dot}>·</Text><Text style={tenantStyles.cardSub}>{t.gender}</Text></>
            ) : null}
          </View>

          {/* Email */}
          {t.email ? (
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2,
            }}>
              <Ionicons name="mail-outline" size={12} color={colors.textTertiary} />
              <Text style={tenantStyles.cardSub} numberOfLines={1}>{t.email}</Text>
            </View>
          ) : null}

          {/* Company / Designation */}
          {(t.companyName || t.designation) ? (
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3,
            }}>
              <Ionicons name="briefcase-outline" size={12} color={colors.textTertiary} />
              <Text style={tenantStyles.cardSub} numberOfLines={1}>
                {[t.designation, t.companyName].filter(Boolean).join(' @ ')}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Current bed row */}
      {t.currentBed ? (
        <View style={tenantStyles.accomRow}>
          <Ionicons name="bed-outline" size={13} color={colors.primary} />
          <Text style={{ fontSize: 12, color: colors.primary, fontWeight: '700' }}>
            {t.currentBed}
          </Text>
          <Text style={tenantStyles.dot}>·</Text>
          <Ionicons name="business-outline" size={12} color={colors.textSecondary} />
          <Text style={tenantStyles.cardSub}>
            {[t.currentApartment, t.currentProperty].filter(Boolean).join(' / ') || '—'}
          </Text>
          {t.monthlyRental > 0 ? (
            <>
              <Text style={tenantStyles.dot}>·</Text>
              <Text style={{ fontSize: 12, color: '#16a34a', fontWeight: '700' }}>
                ₹{Number(t.monthlyRental).toLocaleString('en-IN')}/mo
              </Text>
            </>
          ) : null}
        </View>
      ) : null}

      {/* EB Bill & Onboarding */}
      {(t.electricityBillAmount !== undefined || t.onboardingDate) ? (
        <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: colors.border, flexWrap: 'wrap' }}>
          {t.onboardingDate && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="calendar-outline" size={12} color="#0369A1" />
              <Text style={{ fontSize: 11, color: '#0369A1', fontWeight: '600' }}>
                Joined: {t.onboardingDate}
              </Text>
            </View>
          )}
          {t.electricityBillAmount !== undefined && t.electricityBillAmount !== null && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="flash-outline" size={12} color="#CA8A04" />
              <Text style={{ fontSize: 11, color: '#CA8A04', fontWeight: '600' }}>
                EB: ₹{Number(t.electricityBillAmount).toLocaleString('en-IN')}
              </Text>
            </View>
          )}
        </View>
      ) : null}

      {/* Notice banner */}
      {isNotice ? (
        <View style={tenantStyles.noticeBanner}>
          <Ionicons name="warning-outline" size={13} color="#ea580c" />
          <Text style={{ fontSize: 12, color: '#ea580c', fontWeight: '700' }}>
            Notice Period Active
          </Text>
          {t.noticeDate ? (
            <Text style={{ fontSize: 11, color: '#ea580c' }}> · since {t.noticeDate}</Text>
          ) : null}
        </View>
      ) : null}

      {/* Emergency contact */}
      {(t.emergencyContactName || t.emergencyContactPhone) ? (
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6,
        }}>
          <Ionicons name="shield-checkmark-outline" size={11} color={colors.textTertiary} />
          <Text style={{ fontSize: 11, color: colors.textTertiary }}>
            {[t.emergencyContactName, t.emergencyContactPhone].filter(Boolean).join(' · ')}
          </Text>
        </View>
      ) : null}

          {/* Rating badge (mirrors web TenantRatingBadge) */}
          {t.tenantRating != null && (
            <View style={{ marginTop: 6 }}>
              <RatingBadge rating={t.tenantRating} />
            </View>
          )}

          {/* Actions */}
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}>
            <ActionBtn icon="eye-outline" label="Details" color="#0284C7" onPress={onViewDetail} />
            <ActionBtn icon="pencil-outline" label="Edit" color={colors.primary} onPress={onEdit} />
            {(isActive || isNotice) ? (
              <ActionBtn icon="log-out-outline" label="Check Out" color="#dc2626" onPress={onCheckOut} />
            ) : null}
            {t.stayingStatus === 'new' || t.stayingStatus === 'New' ? (
              <ActionBtn icon="trash-outline" label="Delete" color="#dc2626" onPress={onDelete} />
            ) : null}
          </View>
        </TouchableOpacity>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small reusable components
// ─────────────────────────────────────────────────────────────────────────────
function StatusPill({ status }: { status?: string }) {
  const sc = getStatus(status);
  return (
    <View style={[tenantStyles.pill, { backgroundColor: sc.bg, borderColor: sc.color + '50' }]}>
      <Ionicons name={sc.icon as any} size={9} color={sc.color} />
      <Text style={[tenantStyles.pillText, { color: sc.color }]}>{sc.label}</Text>
    </View>
  );
}

function ActionBtn({
  icon, label, color, onPress,
}: { icon: string; label: string; color: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[tenantStyles.actionBtn, { backgroundColor: color + '14', borderColor: color + '35' }]}
      onPress={onPress}
    >
      <Ionicons name={icon as any} size={13} color={color} />
      <Text style={{ fontSize: 12, fontWeight: '600', color }}>{label}</Text>
    </TouchableOpacity>
  );
}

function SecLabel({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 13, fontWeight: '700', color: colors.text,
      marginTop: 16, marginBottom: 8,
    }}>
      {children}
    </Text>
  );
}

function ModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <View style={tenantStyles.modalHeader}>
      <TouchableOpacity onPress={onClose}>
        <Text style={{ color: '#dc2626', fontSize: 14 }}>Cancel</Text>
      </TouchableOpacity>
      <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>{title}</Text>
      <View style={{ width: 56 }} />
    </View>
  );
}

function FormSection({ icon, title }: { icon: string; title: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 24, marginBottom: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={icon as any} size={16} color={colors.primary} />
      </View>
      <Text style={{ fontSize: 15, fontWeight: '800', color: colors.text }}>{title}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TenantFormModal — full KYC form matching web app sections
// ─────────────────────────────────────────────────────────────────────────────
function TenantFormModal({
  visible, title, form, setF, loading, onClose, onSubmit, submitLabel,
  photoUri, setPhotoUri, setPhotoBase64,
  aadhaarFrontUri, setAadhaarFrontUri, setAadhaarFrontBase64,
  aadhaarBackUri,  setAadhaarBackUri,
  idCardUri,       setIdCardUri,
  pickImage,
}: {
  visible: boolean; title: string;
  form: typeof EMPTY_FORM;
  setF: (k: keyof typeof EMPTY_FORM) => (v: string) => void;
  loading: boolean; onClose: () => void;
  onSubmit: () => void; submitLabel: string;
  photoUri: string | null; setPhotoUri: (v: string | null) => void;
  setPhotoBase64: (v?: string) => void;
  aadhaarFrontUri: string | null; setAadhaarFrontUri: (v: string | null) => void;
  setAadhaarFrontBase64: (v?: string) => void;
  aadhaarBackUri:  string | null; setAadhaarBackUri:  (v: string | null) => void;
  idCardUri:       string | null; setIdCardUri:       (v: string | null) => void;
  pickImage: (cb: (uri: string, b64?: string) => void, title?: string) => void;
}) {
  const GENDER_OPTS   = ['Male', 'Female', 'Other'];
  const FOOD_OPTS     = ['Veg', 'Non-Veg', 'Jain', 'Vegan', 'Others'];
  const RELATION_OPTS = ['Father', 'Mother', 'Husband', 'Wife', 'Sister', 'Brother', 'Son', 'Daughter', 'Other'];

  const DocUpload = ({ uri, onPick, label, required }: { uri: string | null; onPick: () => void; label: string; required?: boolean }) => (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, marginBottom: 6 }}>
        {label}{required ? ' *' : ''}
      </Text>
      <TouchableOpacity onPress={onPick} style={{ height: uri ? 100 : 72, borderRadius: 14, borderWidth: 1.5, borderStyle: uri ? 'solid' : 'dashed', borderColor: uri ? '#22C55E' : colors.border, backgroundColor: uri ? '#F0FDF4' : colors.surface, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
        {uri ? (
          <View style={{ width: '100%', height: '100%' }}>
            <Image source={{ uri }} style={{ width: '100%', height: '100%', resizeMode: 'cover' }} />
            <View style={{ position: 'absolute', bottom: 6, right: 6, backgroundColor: '#22C55E', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 }}>
              <Text style={{ fontSize: 10, color: '#fff', fontWeight: '700' }}>✓ Tap to change</Text>
            </View>
          </View>
        ) : (
          <View style={{ alignItems: 'center', gap: 4 }}>
            <Ionicons name="cloud-upload-outline" size={22} color={colors.textTertiary} />
            <Text style={{ fontSize: 12, color: colors.textTertiary }}>Gallery or Camera</Text>
          </View>
        )}
      </TouchableOpacity>
    </View>
  );

  const PillSelect = ({ label, value, options, onSelect, required }: { label: string; value: string; options: string[]; onSelect: (v: string) => void; required?: boolean }) => (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, marginBottom: 6 }}>{label}{required ? ' *' : ''}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {options.map(opt => {
          const active = value === opt;
          return (
            <TouchableOpacity key={opt} onPress={() => onSelect(opt)} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: 1.5, borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primaryLight : colors.surface }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: active ? colors.primary : colors.textSecondary }}>{opt}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <GlassBackground><SafeAreaView style={{ flex: 1 }}>
        <ModalHeader title={title} onClose={onClose} />
        <ScrollView style={{ padding: 16 }} contentContainerStyle={{ paddingBottom: 100 }} keyboardShouldPersistTaps="handled">

          {/* ══ SECTION 1: Aadhaar Upload ══ */}
          <FormSection icon="scan-outline" title="Aadhaar Card" />
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 12, marginTop: -8 }}>
            The front image is saved to the tenant's KYC record. Back is kept on-device only.
          </Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <DocUpload uri={aadhaarFrontUri} label="Aadhaar Front"
                onPick={() => pickImage((uri, b64) => { setAadhaarFrontUri(uri); setAadhaarFrontBase64(b64); }, 'Aadhaar Front')} />
            </View>
            <View style={{ flex: 1 }}>
              <DocUpload uri={aadhaarBackUri} label="Aadhaar Back"
                onPick={() => pickImage((uri, b64) => { setAadhaarBackUri(uri); }, 'Aadhaar Back')} />
            </View>
          </View>
          <Input label="Aadhaar Number *" value={form.aadhar_number} onChangeText={v => setF('aadhar_number')(v.replace(/\D/g,'').slice(0,12))} placeholder="12 digit number" keyboardType="numeric" maxLength={12} />

          {/* ══ SECTION 2: Personal Details ══ */}
          <FormSection icon="person-outline" title="Personal Details" />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Input label="First Name *" value={form.first_name} onChangeText={setF('first_name')} placeholder="First name" /></View>
            <View style={{ flex: 1 }}><Input label="Last Name *" value={form.last_name} onChangeText={setF('last_name')} placeholder="Last name" /></View>
          </View>
          <Input label="Mobile *" value={form.phone} onChangeText={v => setF('phone')(v.replace(/\D/g,'').slice(0,10))} placeholder="10 digit mobile" keyboardType="phone-pad" maxLength={10} />
          <Input label="Email *" value={form.email} onChangeText={setF('email')} placeholder="Email address" keyboardType="email-address" autoCapitalize="none" />
          <Input label="S/W/D of (Relationship)" value={form.relation_name} onChangeText={setF('relation_name')} placeholder="e.g. S/o Ramesh Kumar" />
          <View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#64748B', marginBottom: 6 }}>Date of Birth *</Text><DateField value={form.date_of_birth} onChange={setF('date_of_birth')} /></View>
          <PillSelect label="Gender *" value={form.gender} options={GENDER_OPTS} onSelect={setF('gender')} required />
          <PillSelect label="Food Preference" value={form.food_preference} options={FOOD_OPTS} onSelect={setF('food_preference')} />
          <Input label="Profession *" value={form.profession} onChangeText={setF('profession')} placeholder="e.g. Software Engineer, Student" />

          {/* Photo */}
          <DocUpload uri={photoUri} required label="Your Photo *"
            onPick={() => pickImage((uri, b64) => { setPhotoUri(uri); setPhotoBase64(b64); }, 'Your Photo')} />

          {/* Address */}
          <Input label="Address *" value={form.address} onChangeText={setF('address')} placeholder="Full address" multiline />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Input label="Pincode" value={form.pincode} onChangeText={v => setF('pincode')(v.replace(/\D/g,'').slice(0,6))} placeholder="6 digits" keyboardType="numeric" /></View>
            <View style={{ flex: 1 }}><Input label="City" value={form.city} onChangeText={setF('city')} placeholder="City" /></View>
            <View style={{ flex: 1 }}><Input label="State" value={form.state} onChangeText={setF('state')} placeholder="State" /></View>
          </View>

          {/* ══ SECTION 3: Professional Information ══ */}
          <FormSection icon="briefcase-outline" title="Professional Information" />
          <Input label="Company / College" value={form.company_name} onChangeText={setF('company_name')} placeholder="Employer or institution" />
          <View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#64748B', marginBottom: 6 }}>Date of Joining</Text><DateField value={form.date_of_joining} onChange={setF('date_of_joining')} /></View>
          <Input label="Designation / Course" value={form.designation} onChangeText={setF('designation')} placeholder="Job title or course" />
          <Input label="Company Address" value={form.company_address} onChangeText={setF('company_address')} placeholder="Office address" multiline />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Input label="Pincode" value={form.company_pincode} onChangeText={v => setF('company_pincode')(v.replace(/\D/g,'').slice(0,6))} placeholder="6 digits" keyboardType="numeric" /></View>
            <View style={{ flex: 1 }}><Input label="City" value={form.company_city} onChangeText={setF('company_city')} placeholder="City" /></View>
            <View style={{ flex: 1 }}><Input label="State" value={form.company_state} onChangeText={setF('company_state')} placeholder="State" /></View>
          </View>
          <DocUpload uri={idCardUri} label="ID Card (Optional)"
            onPick={() => pickImage((uri) => setIdCardUri(uri), 'ID Card')} />

          {/* ══ SECTION 4: Emergency Contact ══ */}
          <FormSection icon="call-outline" title="Emergency Contact" />
          <Input label="Contact Name *" value={form.emergencyContactName} onChangeText={setF('emergencyContactName')} placeholder="Parent / Spouse name" />
          <View style={{ marginBottom: 12 }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, marginBottom: 6 }}>Relationship</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {RELATION_OPTS.map(r => {
                  const active = form.emergencyContactRelation === r;
                  return (
                    <TouchableOpacity key={r} onPress={() => setF('emergencyContactRelation')(r)}
                      style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1.5, borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primaryLight : colors.surface }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: active ? colors.primary : colors.textSecondary }}>{r}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          </View>
          <Input label="Emergency Phone *" value={form.emergencyContactPhone} onChangeText={v => setF('emergencyContactPhone')(v.replace(/\D/g,'').slice(0,10))} placeholder="10 digit number" keyboardType="phone-pad" maxLength={10} />

          {/* ══ SECTION 5: Bank Details ══ */}
          <FormSection icon="card-outline" title="Bank Details" />
          <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: -8, marginBottom: 10 }}>
            Not yet stored on the tenant record from mobile — capture in the web app for now.
          </Text>
          <Input label="Bank Name" value={form.bank_name} onChangeText={setF('bank_name')} placeholder="e.g. HDFC Bank" />
          <Input label="Branch" value={form.bank_branch} onChangeText={setF('bank_branch')} placeholder="Branch name" />
          <Input label="Account Number" value={form.bank_account_number} onChangeText={setF('bank_account_number')} placeholder="Account number" keyboardType="number-pad" />
          <Input label="Account Holder Name" value={form.bank_account_holder} onChangeText={setF('bank_account_holder')} placeholder="Name on account" />
          <Input label="IFSC Code" value={form.bank_ifsc} onChangeText={v => setF('bank_ifsc')(v.toUpperCase().slice(0,11))} placeholder="e.g. HDFC0001234" autoCapitalize="characters" maxLength={11} />

          {/* ══ SECTION 6: Other ID & Tax Details ══ */}
          <FormSection icon="document-text-outline" title="Other ID & Tax Details" />
          <Input label="PAN Number" value={form.pan_number} onChangeText={v => setF('pan_number')(v.toUpperCase().slice(0,10))} placeholder="ABCDE1234F" autoCapitalize="characters" maxLength={10} />
          <Input label="GST Number (Optional)" value={form.gst_number} onChangeText={setF('gst_number')} placeholder="GST registration number" autoCapitalize="characters" />
          <Input label="GST Name (Optional)" value={form.gst_name} onChangeText={setF('gst_name')} placeholder="GST registered name" />

          <View style={{ marginTop: 16 }}>
            <Button title={loading ? (submitLabel === 'Add Tenant' ? 'Creating…' : 'Saving…') : submitLabel} onPress={onSubmit} loading={loading} />
          </View>
        </ScrollView>
      </SafeAreaView></GlassBackground>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RatingBadge — mirrors web TenantRatingBadge
// ─────────────────────────────────────────────────────────────────────────────
function RatingBadge({ rating }: { rating: number }) {
  const r = Math.round(rating * 10) / 10;
  const { bg, text, label } = r < 4
    ? { bg: '#FEE2E2', text: '#DC2626', label: 'Poor' }
    : r < 6
    ? { bg: '#FEF3C7', text: '#D97706', label: 'Fair' }
    : r < 8
    ? { bg: '#DBEAFE', text: '#1D4ED8', label: 'Good' }
    : { bg: '#DCFCE7', text: '#16A34A', label: 'Excellent' };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <Ionicons name="star" size={11} color={text} />
      <Text style={{ fontSize: 11, fontWeight: '700', color: text }}>{r.toFixed(1)} · {label}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────
const tenantStyles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1, borderBottomColor: '#E5E7EB',
  },
  headerTitle: { fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 },
  iconBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: '#6A2C90',
    alignItems: 'center', justifyContent: 'center',
  },
  ghostIconBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1, borderColor: '#EEF1F6',
    alignItems: 'center', justifyContent: 'center',
  },

  tabBar: {
    flexDirection: 'row', backgroundColor: '#FFFFFF',
    borderBottomWidth: 1, borderBottomColor: '#E5E7EB',
  },
  tabItem: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 6, paddingVertical: 11,
    borderBottomWidth: 2, borderBottomColor: 'transparent',
  },
  tabItemActive:  { borderBottomColor: '#6A2C90' },
  tabText:        { fontSize: 13, color: colors.textTertiary, fontWeight: '500' },
  tabTextActive:  { color: '#6A2C90', fontWeight: '700' },

  chip: {
    alignItems: 'center', minWidth: 68,
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 14, borderWidth: 1.5,
  },
  chipCount: { fontSize: 20, fontWeight: '900', lineHeight: 24 },
  chipLabel: { fontSize: 10, fontWeight: '600', marginTop: 1 },

  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#FFFFFF', borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1, borderColor: '#E5E7EB', marginBottom: 8,
  },
  searchInput: { flex: 1, fontSize: 13, color: colors.text, paddingVertical: 0 },
  resultLabel: { fontSize: 11, color: colors.textTertiary, marginBottom: 10, marginLeft: 2 },

  card: {
    backgroundColor: '#FFFFFF', borderRadius: 16,
    padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: '#EEF1F6',
    shadowColor: '#0F172A', shadowOpacity: 0.05,
    shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 1,
  },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1.5,
  },
  avatarText: { fontSize: 18, fontWeight: '800' },
  cardName:   { fontSize: 15, fontWeight: '700', color: colors.text, flex: 1, marginRight: 6 },
  cardSub:    { fontSize: 12, color: colors.textSecondary },
  dot:        { fontSize: 12, color: colors.textTertiary },

  accomRow: {
    flexDirection: 'row', alignItems: 'center',
    flexWrap: 'wrap', gap: 5,
    marginTop: 8, paddingTop: 8,
    borderTopWidth: 1, borderTopColor: '#E5E7EB',
  },
  noticeBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    marginTop: 8, backgroundColor: '#FFEDD5',
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
  },

  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 7, paddingVertical: 3,
    borderRadius: 14, borderWidth: 1, marginLeft: 6,
  },
  pillText: { fontSize: 10, fontWeight: '700' },

  actionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 11, paddingVertical: 6,
    borderRadius: 8, borderWidth: 1,
  },

  allotStat: {
    flex: 1, alignItems: 'center', paddingVertical: 10,
    borderRadius: 12, borderWidth: 1,
  },

  modalHeader: {
    ...glass.header,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
});
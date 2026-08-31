import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
  Image, Modal, FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
const MEDIA_TYPE_IMAGES = 'images' as any;
import { GlassBackground } from '../components/shared';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/ThemeContext';
import { glass, spacing, borderRadius, fontSize } from '../lib/theme';
import {
  createTicket, fetchIssueTypes, fetchIssueSubTypes,
  fetchProperties, fetchApartments, fetchBeds,
  fetchTeamMembers, IssueType, IssueSubType, TeamMember,
  checkTenantPendingTickets,
  uploadTicketPhoto,
} from '../services/ticketService';
// Web parity: tenant's room-allocated asset, resolved server-side and scoped
// to just their bed (avoids shipping the org's whole allocation table).
import { getAllocationForBed, listAllocations, listAssets } from '../lib/supabaseService';
// Web parity: admin/staff "Linked Asset" picker — ranks the location's
// allocated assets against the issue (ported from the web resolver).
import { computeTicketAssetSuggestion, formatTicketAssetLabel } from '../lib/ticketAssetResolution';

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low', color: '#16A34A', bg: '#DCFCE7' },
  { value: 'medium', label: 'Medium', color: '#D97706', bg: '#FEF3C7' },
  { value: 'high', label: 'High', color: '#DC2626', bg: '#FEE2E2' },
  { value: 'critical', label: 'Critical', color: '#7C2D12', bg: '#FEE2E2' },
];

// ─── Local design tokens (mirrors DASH/VBRAND token objects used on other
// restyled admin screens — kept file-local, visual only). ───────────────────
const CT = {
  ink: '#0F172A',
  ink2: '#64748B',
  ink3: '#94A3B8',
  border: '#EEF1F6',
  soft: '#F8FAFC',
  surface: '#FFFFFF',
  blue: '#6A2C90',
  blueDeep: '#6A2C90',
  blueSoft: '#F3ECF9',
  blueTint: 'rgba(106,44,144,0.08)',
  blueTintStrong: 'rgba(106,44,144,0.12)',
};
const CT_CARD_SHADOW = {
  shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
} as const;

export default function CreateTicketScreen({ navigation }: any) {
  const { colors } = useTheme();
  const { user, tenantLocation } = useAuth();
  const isTenant = user?.role === 'tenant';
  const costSubmitGuardRef = useRef(false);
  // Web parity: tenant raise allows a single issue photo; admin keeps up to 5.
  const maxPhotos = isTenant ? 1 : 5;

  const [issueTypes, setIssueTypes] = useState<IssueType[]>([]);
  const [subTypes, setSubTypes] = useState<IssueSubType[]>([]);
  const [properties, setProperties] = useState<any[]>([]);
  const [apartments, setApartments] = useState<any[]>([]);
  const [beds, setBeds] = useState<any[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);

  const [selectedIssueType, setSelectedIssueType] = useState<IssueType | null>(null);
  const [selectedSubType, setSelectedSubType] = useState<IssueSubType | null>(null);
  const [selectedProperty, setSelectedProperty] = useState<any>(null);
  const [selectedApartment, setSelectedApartment] = useState<any>(null);
  const [selectedBed, setSelectedBed] = useState<any>(null);
  const [priority, setPriority] = useState('medium');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingBlock, setPendingBlock] = useState(false);
  const [loadingSubTypes, setLoadingSubTypes] = useState(false);
  const [loadingApartments, setLoadingApartments] = useState(false);
  const [loadingBeds, setLoadingBeds] = useState(false);

  const [selectedPhotos, setSelectedPhotos] = useState<{ uri: string; base64?: string; mimeType?: string }[]>([]);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);

  // Web parity: read-only "Linked to your room's allocated asset" line (tenant only).
  const [linkedAsset, setLinkedAsset] = useState<{ id: string; name: string } | null>(null);

  // Web parity: admin/staff "Linked Asset" picker. `assetAllocations` is the
  // org's allocations joined with full asset rows (resolver shape); recomputed
  // into location-scoped `candidateAssets` as the form changes. `selectedAssetId`
  // uses '' = unset, '__none' = explicitly no asset, else the chosen asset id.
  const [assetAllocations, setAssetAllocations] = useState<any[]>([]);
  const [candidateAssets, setCandidateAssets] = useState<any[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string>('');
  // True once the user hand-picks an asset — suppresses auto-suggestion until
  // the location/issue type changes (see the reset effect below).
  const assetManuallyPickedRef = useRef(false);

  // ── AI Issue Classifier (mirrors web useIssueClassifier) ──────────────────
  // CONFIDENCE thresholds: ≥85 = auto_select, 60–84 = suggest, <60 = manual
  const [classifying,          setClassifying]          = useState(false);
  const [classifierMatches,    setClassifierMatches]    = useState<{ issue_type_id: string; confidence: number; name?: string }[]>([]);
  const [classifierTopId,      setClassifierTopId]      = useState<string | null>(null);
  const [classifierTopConf,    setClassifierTopConf]    = useState(0);
  const [classifierAction,     setClassifierAction]     = useState<'auto_select' | 'suggest' | 'manual' | 'idle'>('idle');
  const [classifierOverridden, setClassifierOverridden] = useState(false);
  const [classifierSubTypeId,  setClassifierSubTypeId]  = useState<string | null>(null);  // AI top sub-type
  const [classifierSubTypeConf,setClassifierSubTypeConf]= useState(0);
  const classifierTimerRef    = useRef<any>(null);
  const lastClassifiedDescRef = useRef('');

  // Auto-select sub-type when subTypes load — always pick best match, no confidence gate
  useEffect(() => {
    if (!subTypes.length || selectedSubType) return;
    // Try AI-returned sub-type ID first
    if (classifierSubTypeId) {
      const found = subTypes.find((s: any) => s.id === classifierSubTypeId);
      if (found) { setSelectedSubType(found); return; }
    }
    // Fall back to local keyword match against current description
    const best = localClassifySubType(description.trim(), subTypes);
    if (best) setSelectedSubType(best);
  }, [subTypes, classifierSubTypeId]);

  // ── Local keyword fallback classifier — runs instantly when AI fails/times out ─
  function localClassifyIssue(desc: string, types: IssueType[]): IssueType | null {
    if (!types.length) return null;
    const lower = desc.toLowerCase();
    const RULES: { keywords: string[]; fragments: string[] }[] = [
      { keywords: ['water', 'leak', 'leaking', 'pipe', 'drain', 'flood', 'tap', 'plumb', 'sanit', 'toilet', 'basin', 'shower', 'wet', 'drip', 'overflow'], fragments: ['plumb', 'water', 'pipe', 'drain', 'sanit'] },
      { keywords: ['electric', 'electricity', 'power', 'light', 'switch', 'socket', 'wire', 'wiring', 'short circuit', 'trip', 'mcb', 'fuse', 'bulb', 'plug', 'shock'], fragments: ['electric', 'power', 'light', 'wir'] },
      { keywords: ['ac', 'air condition', 'air con', 'cooling', 'hvac', 'fan', 'geyser', 'heater', 'hot water', 'temperature', 'warm', 'not cool', 'not cold'], fragments: ['ac', 'air', 'cool', 'hvac', 'fan', 'heat', 'geyser'] },
      { keywords: ['pest', 'insect', 'cockroach', 'rat', 'mouse', 'rodent', 'ant', 'mosquito', 'fumig', 'bug', 'lizard', 'termite', 'infestation'], fragments: ['pest', 'insect', 'rodent', 'fumig'] },
      { keywords: ['lock', 'door', 'window', 'key', 'handle', 'hinge', 'glass', 'broken door', 'broken window', 'latch', 'knob'], fragments: ['lock', 'door', 'window', 'carpent', 'civil'] },
      { keywords: ['paint', 'wall', 'crack', 'ceiling', 'floor', 'tile', 'civil', 'mason', 'plaster', 'damp', 'seepage', 'moss', 'peeling'], fragments: ['civil', 'struct', 'carpent', 'mason', 'paint'] },
      { keywords: ['clean', 'dirty', 'hygiene', 'sweep', 'mop', 'housekeep', 'garbage', 'waste', 'smell', 'odour', 'odor', 'stain', 'dusty'], fragments: ['clean', 'hygiene', 'housekeep'] },
      { keywords: ['washing machine', 'fridge', 'refrigerator', 'microwave', 'oven', 'appliance', 'equipment', 'grill', 'mixer', 'induction', 'dishwasher'], fragments: ['appliance', 'equipment', 'device'] },
    ];
    let bestType: IssueType | null = null;
    let bestScore = 0;
    for (const rule of RULES) {
      const hits = rule.keywords.filter(k => lower.includes(k)).length;
      if (hits === 0) continue;
      for (const type of types) {
        const tl = type.name.toLowerCase();
        if (rule.fragments.some(f => tl.includes(f))) {
          const score = hits * 25;
          if (score > bestScore) { bestScore = score; bestType = type; }
        }
      }
    }
    // Direct word overlap fallback
    if (!bestType) {
      for (const type of types) {
        const words = type.name.toLowerCase().split(/\W+/).filter(w => w.length > 3);
        if (words.some(w => lower.includes(w))) { bestType = type; break; }
      }
    }
    return bestType;
  }

  // ── Local sub-type keyword fallback ─────────────────────────────────────────
  function localClassifySubType(desc: string, subs: IssueSubType[]): IssueSubType | null {
    if (!subs.length) return null;
    const lower = desc.toLowerCase();
    let best: IssueSubType | null = null;
    let bestScore = 0;
    for (const sub of subs) {
      const subLower = sub.name.toLowerCase();
      const descField = (sub as any).description?.toLowerCase() || '';
      const words = (subLower + ' ' + descField).split(/\W+/).filter(w => w.length > 2);
      const hits = words.filter(w => lower.includes(w)).length;
      if (hits > bestScore) { bestScore = hits; best = sub; }
    }
    return bestScore > 0 ? best : subs[0]; // fallback to first sub-type if no keyword match
  }

  // Debounced AI+local classification — ALWAYS auto-selects the best match, no chips/dropdowns
  useEffect(() => {
    const trimmed = description.trim();
    if (trimmed.length < 4 || issueTypes.length === 0) {
      setClassifierMatches([]); setClassifierTopId(null);
      setClassifierTopConf(0); setClassifierAction('idle');
      return;
    }
    if (trimmed === lastClassifiedDescRef.current) return;
    if (classifierTimerRef.current) clearTimeout(classifierTimerRef.current);
    classifierTimerRef.current = setTimeout(async () => {
      lastClassifiedDescRef.current = trimmed;
      if (classifierOverridden) return;
      setClassifying(true);
      try {
        const { classifyIssue } = await import('../services/ticketService') as any;
        const result = await classifyIssue(trimmed, issueTypes);
        const topId = result.top_issue_type_id as string | null;
        const subId = result.top_issue_sub_type_id as string | null;
        // Use AI top match if we got one; otherwise fall back to local
        const foundType = topId ? issueTypes.find((t: any) => t.id === topId) : null;
        const typeToSelect = foundType || localClassifyIssue(trimmed, issueTypes);
        if (typeToSelect && !classifierOverridden) {
          setClassifierTopId(typeToSelect.id);
          setClassifierTopConf(result.top_confidence || 90);
          setClassifierAction('auto_select');
          setClassifierSubTypeId(subId);
          setClassifierSubTypeConf(result.top_issue_sub_type_confidence || 90);
          onIssueTypeSelect(typeToSelect); // always auto-select immediately
        }
      } catch {
        // AI call failed — use local classifier only
        const typeToSelect = localClassifyIssue(trimmed, issueTypes);
        if (typeToSelect && !classifierOverridden) {
          setClassifierAction('auto_select');
          onIssueTypeSelect(typeToSelect);
        }
      } finally { setClassifying(false); }
    }, 650);
    return () => { if (classifierTimerRef.current) clearTimeout(classifierTimerRef.current); };
  }, [description, issueTypes, classifierOverridden]);

  useEffect(() => { loadInitialData(); }, []);

  // Web parity: resolve the asset allocated to the tenant's bed (read-only,
  // no dropdown). Server-scoped to this bed only — the tenant device never
  // receives other rooms'/tenants' allocation data.
  useEffect(() => {
    if (!isTenant || !tenantLocation?.bedId) return;
    let cancelled = false;
    (async () => {
      try {
        const match = await getAllocationForBed(tenantLocation.bedId);
        if (cancelled || !match?.assets) return;
        const name = [match.assets.brand, match.assets.model].filter(Boolean).join(' ') || match.assets.asset_code || null;
        if (name) setLinkedAsset({ id: match.asset_id, name });
      } catch (e: any) {
        console.warn('[CreateTicketScreen] getAllocationForBed failed:', e?.message);
      }
    })();
    return () => { cancelled = true; };
  }, [isTenant, tenantLocation?.bedId]);

  // Web parity (admin/staff): when the location or issue type changes, drop any
  // prior pick + manual-pick flag so the next resolve re-suggests for the new
  // context (prevents a stale asset id leaking into submit). Description edits do
  // NOT reset it — a hand-picked asset survives further typing.
  useEffect(() => {
    if (isTenant) return;
    assetManuallyPickedRef.current = false;
    setSelectedAssetId('');
  }, [isTenant, selectedProperty?.id, selectedApartment?.id, selectedBed?.id, selectedIssueType?.id]);

  // Web parity (admin/staff): resolve candidate assets for the selected
  // apartment/bed + issue type, auto-selecting the best match. Debounced so it
  // rides along with description typing (mirrors the web resolve effect).
  useEffect(() => {
    if (isTenant) return;
    const apartmentId = selectedApartment?.id || '';
    const bedId = selectedBed?.id || '';
    const propertyId = selectedProperty?.id || '';
    const issueTypeId = selectedIssueType?.id || '';
    if (!apartmentId || !issueTypeId || assetAllocations.length === 0) {
      setCandidateAssets([]);
      return;
    }
    const timer = setTimeout(() => {
      const { candidates, suggestedId } = computeTicketAssetSuggestion({
        apartmentId, bedId, propertyId, issueTypeId,
        description,
        issueTypes,
        assetAllocations,
        apartmentBedIds: beds.map((b: any) => b.id),
      });
      setCandidateAssets(candidates);
      if (!assetManuallyPickedRef.current) {
        setSelectedAssetId(suggestedId || '');
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [
    isTenant, selectedApartment?.id, selectedBed?.id, selectedProperty?.id,
    selectedIssueType?.id, description, assetAllocations, issueTypes, beds,
  ]);

  async function loadInitialData() {
    try {
      const [types, props, members] = await Promise.all([
        fetchIssueTypes(),
        isTenant ? Promise.resolve([]) : fetchProperties(),
        fetchTeamMembers(),
      ]);
      setIssueTypes(types);
      setProperties(props);
      setTeamMembers(members);
      if (isTenant && tenantLocation?.tenantId) {
        const { hasPending } = await checkTenantPendingTickets(tenantLocation.tenantId);
        if (hasPending) setPendingBlock(true);
      }
      // Admin/staff only: load org allocations + full asset rows and join them
      // into the resolver's snake_case shape. `listAllocations` omits
      // asset_type_id/status, so we pull those from `listAssets` (best-effort —
      // the picker just stays hidden if this fails).
      if (!isTenant) {
        try {
          const [allocs, assets] = await Promise.all([listAllocations(), listAssets()]);
          const assetById: Record<string, any> = {};
          for (const a of (assets as any[]) || []) {
            assetById[a._id] = {
              id: a._id,
              asset_code: a.assetCode ?? null,
              brand: a.brand ?? null,
              model: a.model ?? null,
              serial_number: a.serialNumber ?? null,
              condition: a.condition ?? null,
              status: a.status ?? null,
              asset_type_id: a.assetTypeId ?? null,
              notes: a.notes ?? null,
              created_at: a._creationTime ?? 0,
              asset_types: { name: a.typeName ?? null },
            };
          }
          const joined = ((allocs as any[]) || [])
            .filter((al: any) => al.asset_id && assetById[al.asset_id])
            .map((al: any) => ({
              allocation_type: al.allocation_type,
              apartment_id: al.apartment_id,
              bed_id: al.bed_id,
              property_id: al.property_id,
              asset_id: al.asset_id,
              assets: assetById[al.asset_id],
            }));
          setAssetAllocations(joined);
        } catch (e: any) {
          console.warn('[CreateTicketScreen] asset allocation load failed:', e?.message);
        }
      }
    } finally {
      setLoading(false);
    }
  }

  async function onIssueTypeSelect(it: IssueType, manual = false) {
    if (manual) setClassifierOverridden(true);
    setSelectedIssueType(it);
    setSelectedSubType(null);
    setSubTypes([]);
    setPriority(it.priority || 'medium');
    setLoadingSubTypes(true);
    try {
      const subs = await fetchIssueSubTypes(it.id);
      setSubTypes(subs);
    } finally {
      setLoadingSubTypes(false);
    }
  }

  async function onPropertySelect(prop: any) {
    setSelectedProperty(prop);
    setSelectedApartment(null);
    setSelectedBed(null);
    setApartments([]);
    setBeds([]);
    setLoadingApartments(true);
    try {
      const apts = await fetchApartments(prop.id);
      setApartments(apts);
    } finally {
      setLoadingApartments(false);
    }
  }

  async function onApartmentSelect(apt: any) {
    setSelectedApartment(apt);
    setSelectedBed(null);
    setBeds([]);
    setLoadingBeds(true);
    try {
      const bs = await fetchBeds(apt.id);
      setBeds(bs);
    } finally {
      setLoadingBeds(false);
    }
  }

  async function pickPhotos() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { Alert.alert('Permission Required', 'Please allow access to your photo library.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: MEDIA_TYPE_IMAGES, allowsMultipleSelection: !isTenant, quality: 0.7, base64: true,
    });
    if (!result.canceled) {
      const newPhotos = result.assets.map(a => ({ uri: a.uri, base64: a.base64 ?? undefined, mimeType: a.mimeType ?? 'image/jpeg' }));
      if (isTenant) {
        // Tenant: single photo only — a new pick replaces the existing one (web parity).
        setSelectedPhotos(newPhotos.slice(0, 1));
      } else {
        setSelectedPhotos(prev => [...prev, ...newPhotos].slice(0, maxPhotos));
      }
    }
  }

  async function takePhoto() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') { Alert.alert('Permission Required', 'Please allow camera access.'); return; }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true });
    if (!result.canceled && result.assets[0]) {
      const a = result.assets[0];
      const photo = { uri: a.uri, base64: a.base64 ?? undefined, mimeType: a.mimeType ?? 'image/jpeg' };
      if (isTenant) {
        // Tenant: single photo only — a new capture replaces the existing one (web parity).
        setSelectedPhotos([photo]);
      } else {
        setSelectedPhotos(prev => [...prev, photo].slice(0, maxPhotos));
      }
    }
  }

  function removePhoto(index: number) {
    setSelectedPhotos(prev => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit() {
    if (costSubmitGuardRef.current) return;
    if (!selectedIssueType) { Alert.alert('Error', 'Please select an issue type'); return; }
    if (!isTenant && !selectedProperty) { Alert.alert('Error', 'Please select a property'); return; }
    if (!description.trim()) { Alert.alert('Error', 'Please describe the issue'); return; }

    costSubmitGuardRef.current = true;
    setSubmitting(true);

    try {
      let photoUrls: string[] = [];
      if (selectedPhotos.length > 0) {
        setUploadingPhotos(true);
        const uploads = await Promise.all(selectedPhotos.map(p => uploadTicketPhoto(p.uri, p.base64, p.mimeType)));
        photoUrls = uploads.filter(Boolean) as string[];
        setUploadingPhotos(false);
      }

      // Tenants don't choose priority — auto-derive from the selected issue type (web parity).
      const effectivePriority = isTenant ? (selectedIssueType.priority || 'medium') : priority;

      const ticketData: any = {
        issue_type_id: selectedIssueType.id,
        issue_type: selectedIssueType.name,
        issue_subtype: selectedSubType?.name || null,
        description: description.trim(),
        priority: effectivePriority,
        created_by: user?.supabaseUserId || user?.userId || null,
        photo_urls: photoUrls.length > 0 ? photoUrls : null,
      };

      if (isTenant && tenantLocation) {
        ticketData.tenant_id = tenantLocation.tenantId;
        ticketData.property_id = tenantLocation.propertyId;
        ticketData.apartment_id = tenantLocation.apartmentId;
        ticketData.bed_id = tenantLocation.bedId;
        ticketData.tenant_name = tenantLocation.tenantName;
        ticketData.apartment_code = tenantLocation.bedCode;
        ticketData.asset_id = linkedAsset?.id ?? null;
      } else {
        ticketData.tenant_id = null;
        ticketData.tenant_name = user?.userName || null;
        ticketData.property_id = selectedProperty?.id || null;
        ticketData.apartment_id = selectedApartment?.id || null;
        ticketData.bed_id = selectedBed?.id || null;
        ticketData.apartment_code = selectedBed?.bed_code || selectedApartment?.apartment_code || null;
        // Web parity: linked asset. Respect an explicit "No specific asset"
        // (__none) as null; otherwise use the pick, falling back to a fresh
        // suggestion in case candidates resolved after the last render.
        let resolvedAssetId: string | null =
          selectedAssetId && selectedAssetId !== '__none' ? selectedAssetId : null;
        if (!resolvedAssetId && selectedAssetId !== '__none' && selectedApartment?.id && selectedIssueType?.id) {
          const { suggestedId } = computeTicketAssetSuggestion({
            apartmentId: selectedApartment.id,
            bedId: selectedBed?.id || '',
            propertyId: selectedProperty?.id || '',
            issueTypeId: selectedIssueType.id,
            description: description.trim(),
            issueTypes,
            assetAllocations,
            apartmentBedIds: beds.map((b: any) => b.id),
          });
          if (suggestedId) resolvedAssetId = suggestedId;
        }
        ticketData.asset_id = resolvedAssetId;
      }

      const ticket = await createTicket(ticketData);
      const assignedName = ticket.diagnostic_data?.assigned_to_name;
      const assignedPhone = ticket.diagnostic_data?.assigned_to_phone;
      const assignedMsg = assignedName
        ? `\n\n✅ Assigned to: ${assignedName}${assignedPhone ? `\n📞 ${assignedPhone}` : ''}`
        : '\n\n⏳ Awaiting technician assignment.';

      // Role-based success message
      const raisedBy = isTenant ? 'Tenant' : 'Admin';
      const successMessage = `${raisedBy} raised ticket successfully.\n\nTicket ${ticket.ticket_number} has been created.${assignedMsg}`;

      Alert.alert(
        assignedName ? '🎉 Ticket Created & Assigned!' : '✅ Ticket Created',
        successMessage,
        [
          { text: 'View Ticket', onPress: () => navigation.replace('TicketDetail', { ticketId: ticket.id }) },
          { text: 'Back to List', onPress: () => navigation.goBack() },
        ]
      );
    } catch (e: any) {
      const errorMessage = e?.message || 'Failed to create ticket';
      Alert.alert('❌ Ticket Creation Failed', errorMessage);
      costSubmitGuardRef.current = false;
    } finally {
      setSubmitting(false);
      setUploadingPhotos(false);
    }
  }

  if (loading) {
    return (
      <GlassBackground>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color="#6A2C90" />
        </View>
      </GlassBackground>
    );
  }

  if (pendingBlock) {
    return (
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }} edges={['top']}>
          <View style={[glass.header, { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, backgroundColor: CT.surface, borderBottomColor: CT.border }]}>
            <TouchableOpacity onPress={() => navigation.goBack()} style={{ marginRight: 12 }}>
              <Ionicons name="arrow-back" size={24} color={CT.ink} />
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: CT.ink, letterSpacing: -0.3 }}>New Ticket</Text>
          </View>
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl }}>
            <View style={{ backgroundColor: '#FFFFFF', borderRadius: 18, borderWidth: 1, borderColor: CT.border, ...CT_CARD_SHADOW, padding: spacing.xxl, alignItems: 'center' }}>
              <Ionicons name="warning-outline" size={48} color="#D97706" />
              <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: CT.ink, marginTop: 16, textAlign: 'center', letterSpacing: -0.3 }}>Pending Approval Required</Text>
              <Text style={{ fontSize: fontSize.sm, color: CT.ink2, marginTop: 8, textAlign: 'center' }}>
                You have tickets pending your approval. Please review them before creating new tickets.
              </Text>
              <TouchableOpacity
                onPress={() => navigation.navigate('Tickets')}
                style={{ marginTop: 20, backgroundColor: '#D97706', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 999 }}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>View Pending Tickets</Text>
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {/* Header */}
          <View style={[glass.header, { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, backgroundColor: CT.surface, borderBottomColor: CT.border }]}>
            <TouchableOpacity onPress={() => navigation.goBack()} style={{ marginRight: 12 }}>
              <Ionicons name="arrow-back" size={24} color={CT.ink} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: fontSize.xs, color: CT.ink3, fontWeight: '700', letterSpacing: 0.4 }}>NEW</Text>
              <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: CT.ink, letterSpacing: -0.3 }}>Create Ticket</Text>
            </View>
          </View>

          <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 100 }}>

            {/* Tenant: auto-filled location card */}
            {isTenant && tenantLocation && (
              <View style={[glass.card, { backgroundColor: CT.blueSoft, borderColor: '#E4D3EF', borderWidth: 1, borderRadius: 16, marginBottom: spacing.lg, shadowOpacity: 0 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Ionicons name="location-outline" size={16} color={CT.blueDeep} />
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: CT.blueDeep }}>Your Location</Text>
                </View>
                <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: CT.ink }}>{tenantLocation.propertyName}</Text>
                <Text style={{ fontSize: fontSize.sm, color: CT.ink2 }}>
                  {tenantLocation.unitNumber} • Bed: {tenantLocation.bedCode}
                </Text>
                {linkedAsset && (
                  <Text style={{ fontSize: fontSize.sm, color: CT.ink2, marginTop: 4 }}>
                    Linked to your room's allocated asset: {linkedAsset.name}
                  </Text>
                )}
              </View>
            )}

            {/* ══ TENANT FLOW: describe first → AI auto-selects ══ */}
            {isTenant && (
              <>
                {/* Step 1: Describe the problem */}
                <View style={[glass.card, { marginBottom: spacing.lg, borderRadius: 16, borderColor: CT.border, ...CT_CARD_SHADOW }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <View style={{ width: 24, height: 24, borderRadius: 99, backgroundColor: CT.blueDeep, alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>1</Text>
                    </View>
                    <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: CT.ink }}>What's the problem?</Text>
                  </View>
                  <TextInput
                    style={[glass.input, { padding: spacing.md, fontSize: fontSize.md, color: CT.ink, minHeight: 100, textAlignVertical: 'top', marginBottom: 0, borderRadius: 12, borderColor: CT.border, backgroundColor: CT.soft }]}
                    placeholder="Describe the issue — e.g. 'water leaking from tap', 'fan not working'..."
                    placeholderTextColor={CT.ink3}
                    value={description}
                    onChangeText={setDescription}
                    multiline
                    autoFocus
                  />

                  {/* AI scanning indicator */}
                  {description.trim().length >= 4 && classifying && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
                      <ActivityIndicator size="small" color={CT.blueDeep} />
                      <Text style={{ fontSize: fontSize.xs, color: CT.blueDeep }}>Identifying issue type…</Text>
                    </View>
                  )}
                </View>

                {/* Step 2: Issue Type — auto-selected silently, user can change */}
                {(selectedIssueType || classifierAction === 'auto_select' || classifierAction === 'manual') && (
                  <View style={[glass.card, { marginBottom: spacing.lg, borderRadius: 16, borderColor: CT.border, ...CT_CARD_SHADOW }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <View style={{ width: 24, height: 24, borderRadius: 99, backgroundColor: CT.blueDeep, alignItems: 'center', justifyContent: 'center' }}>
                        <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>2</Text>
                      </View>
                      <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: CT.ink }}>Issue Type</Text>
                      {selectedIssueType && (
                        <View style={{ backgroundColor: CT.blueTintStrong, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                          <Text style={{ fontSize: 10, color: CT.blueDeep, fontWeight: '700' }}>AUTO-DETECTED</Text>
                        </View>
                      )}
                    </View>

                    {selectedIssueType ? (
                      /* Auto-selected result — tap X to change */
                      <View style={{ backgroundColor: CT.blueTint, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <Ionicons name="sparkles" size={18} color={CT.blueDeep} />
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: CT.blueDeep }}>{selectedIssueType.name}</Text>
                          {selectedIssueType.sla_hours && (
                            <Text style={{ fontSize: 11, color: CT.ink2, marginTop: 2 }}>SLA: {selectedIssueType.sla_hours}h</Text>
                          )}
                        </View>
                        <TouchableOpacity
                          onPress={() => { setSelectedIssueType(null); setSelectedSubType(null); setSubTypes([]); setClassifierOverridden(true); setClassifierAction('idle'); lastClassifiedDescRef.current = ''; }}
                          style={{ padding: 6 }}>
                          <Ionicons name="close-circle" size={20} color={CT.ink2} />
                        </TouchableOpacity>
                      </View>
                    ) : (
                      /* Fallback picker — shown only if AI found nothing at all */
                      <DropdownPicker
                        placeholder="Select issue type"
                        value={null}
                        items={issueTypes}
                        labelKey="name"
                        onSelect={(it: IssueType) => { setClassifierOverridden(true); onIssueTypeSelect(it, true); }}
                        colors={colors}
                        icon="construct-outline"
                      />
                    )}
                  </View>
                )}

                {/* Step 3: Issue Details — auto-selected, user can change */}
                {selectedIssueType && (
                  <View style={[glass.card, { marginBottom: spacing.lg, borderRadius: 16, borderColor: CT.border, ...CT_CARD_SHADOW }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <View style={{ width: 24, height: 24, borderRadius: 99, backgroundColor: CT.blueDeep, alignItems: 'center', justifyContent: 'center' }}>
                        <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>3</Text>
                      </View>
                      <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: CT.ink }}>Issue Details</Text>
                      {selectedSubType && (
                        <View style={{ backgroundColor: CT.blueTintStrong, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                          <Text style={{ fontSize: 10, color: CT.blueDeep, fontWeight: '700' }}>AUTO-DETECTED</Text>
                        </View>
                      )}
                    </View>
                    {loadingSubTypes ? (
                      <LoadingRow colors={colors} label="Identifying issue details…" />
                    ) : subTypes.length === 0 ? (
                      <Text style={{ fontSize: fontSize.sm, color: CT.ink3 }}>No sub-categories for this issue type.</Text>
                    ) : selectedSubType ? (
                      <View style={{ backgroundColor: CT.blueTint, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <Ionicons name="sparkles" size={16} color={CT.blueDeep} />
                        <Text style={{ flex: 1, fontSize: fontSize.sm, fontWeight: '700', color: CT.blueDeep }}>{selectedSubType.name}</Text>
                        <TouchableOpacity onPress={() => setSelectedSubType(null)} style={{ padding: 4 }}>
                          <Ionicons name="close-circle" size={18} color={CT.ink2} />
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <DropdownPicker
                        placeholder="Select issue details"
                        value={null}
                        items={subTypes}
                        labelKey="name"
                        onSelect={(st: IssueSubType) => setSelectedSubType(st)}
                        colors={colors}
                        icon="list-outline"
                        allowDeselect
                        selectedId={selectedSubType?.id}
                      />
                    )}
                  </View>
                )}
              </>
            )}

            {/* ══ ADMIN FLOW: Property → Apartment → Bed → Description → AI auto-selects Issue Type + Details ══ */}
            {!isTenant && (
              <>
                {/* Step 1: Property */}
                <SectionLabel>Property *</SectionLabel>
                <DropdownPicker
                  placeholder="Select property"
                  value={selectedProperty?.property_name || null}
                  items={properties}
                  labelKey="property_name"
                  onSelect={onPropertySelect}
                  colors={colors}
                  icon="business-outline"
                  selectedId={selectedProperty?.id}
                />

                {/* Step 2: Apartment — shown after property selected */}
                {selectedProperty && (
                  <>
                    <SectionLabel>Apartment</SectionLabel>
                    {loadingApartments ? (
                      <LoadingRow colors={colors} label="Loading apartments..." />
                    ) : apartments.length > 0 ? (
                      <DropdownPicker
                        placeholder="Select apartment"
                        value={selectedApartment?.apartment_code || null}
                        items={apartments}
                        labelKey="apartment_code"
                        onSelect={onApartmentSelect}
                        colors={colors}
                        icon="grid-outline"
                        selectedId={selectedApartment?.id}
                      />
                    ) : (
                      <View style={[glass.input, { paddingHorizontal: spacing.md, paddingVertical: 14, marginBottom: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, borderColor: CT.border, backgroundColor: CT.soft }]}>
                        <Ionicons name="information-circle-outline" size={16} color={CT.ink3} />
                        <Text style={{ fontSize: fontSize.sm, color: CT.ink3 }}>No apartments found</Text>
                      </View>
                    )}
                  </>
                )}

                {/* Step 3: Bed — shown after apartment selected */}
                {selectedApartment && (
                  <>
                    <SectionLabel>Bed</SectionLabel>
                    {loadingBeds ? (
                      <LoadingRow colors={colors} label="Loading beds..." />
                    ) : beds.length > 0 ? (
                      <DropdownPicker
                        placeholder="Select bed"
                        value={selectedBed ? `${selectedBed.bed_code}${selectedBed.bed_type ? ` (${capitalize(selectedBed.bed_type)})` : ''}` : null}
                        items={beds}
                        labelKey="bed_code"
                        labelFormatter={(b: any) => `${b.bed_code}${b.bed_type ? ` (${capitalize(b.bed_type)})` : ''}`}
                        onSelect={(b: any) => setSelectedBed(b)}
                        colors={colors}
                        icon="bed-outline"
                        selectedId={selectedBed?.id}
                      />
                    ) : (
                      <View style={[glass.input, { paddingHorizontal: spacing.md, paddingVertical: 14, marginBottom: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, borderColor: CT.border, backgroundColor: CT.soft }]}>
                        <Ionicons name="information-circle-outline" size={16} color={CT.ink3} />
                        <Text style={{ fontSize: fontSize.sm, color: CT.ink3 }}>No beds found</Text>
                      </View>
                    )}
                  </>
                )}

                {/* Step 4 onwards — shown after Bed is selected, or (for admin/staff)
                    once a Property is chosen so property-level tickets are allowed. */}
                {(selectedBed || (!isTenant && selectedProperty)) && (
                  <>
                    {/* Description — AI fires after typing, auto-selects Issue Type + Details */}
                    <SectionLabel>Description *</SectionLabel>
                    <TextInput
                      style={[glass.input, { padding: spacing.md, fontSize: fontSize.md, color: CT.ink, minHeight: 100, textAlignVertical: 'top', marginBottom: 0, borderRadius: 12, borderColor: CT.border, backgroundColor: CT.soft }]}
                      placeholder="Describe the issue — e.g. 'water leaking from tap', 'AC not cooling'..."
                      placeholderTextColor={CT.ink3}
                      value={description}
                      onChangeText={txt => { setDescription(txt); setClassifierOverridden(false); lastClassifiedDescRef.current = ''; }}
                      multiline
                      autoFocus
                    />
                    {description.trim().length >= 4 && classifying && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, marginBottom: spacing.lg }}>
                        <ActivityIndicator size="small" color={CT.blueDeep} />
                        <Text style={{ fontSize: fontSize.xs, color: CT.blueDeep }}>Analyzing issue description…</Text>
                      </View>
                    )}
                    {!(description.trim().length >= 4 && classifying) && <View style={{ marginBottom: spacing.lg }} />}

                    {/* Issue Type — auto-selected by AI; tap X to pick manually */}
                    {(selectedIssueType || classifierAction === 'auto_select') && (
                      <>
                        <SectionLabel>Issue Type *</SectionLabel>
                        {selectedIssueType ? (
                          <View style={{ backgroundColor: CT.blueTint, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: spacing.lg }}>
                            <Ionicons name="sparkles" size={18} color={CT.blueDeep} />
                            <View style={{ flex: 1 }}>
                              <Text style={{ fontSize: 10, fontWeight: '700', color: CT.blueDeep, letterSpacing: 0.5 }}>AUTO-DETECTED</Text>
                              <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: CT.blueDeep }}>{selectedIssueType.name}</Text>
                            </View>
                            <TouchableOpacity
                              onPress={() => { setSelectedIssueType(null); setSelectedSubType(null); setSubTypes([]); setClassifierOverridden(true); setClassifierAction('idle'); lastClassifiedDescRef.current = ''; }}
                              style={{ padding: 6 }}>
                              <Ionicons name="close-circle" size={20} color={CT.ink2} />
                            </TouchableOpacity>
                          </View>
                        ) : (
                          <DropdownPicker
                            placeholder="Select issue type"
                            value={null}
                            items={issueTypes}
                            labelKey="name"
                            onSelect={(it: IssueType) => { setClassifierOverridden(true); onIssueTypeSelect(it, true); }}
                            colors={colors}
                            icon="construct-outline"
                          />
                        )}
                      </>
                    )}

                    {/* Issue Details — auto-selected; tap X to pick manually */}
                    {selectedIssueType && (
                      <>
                        <SectionLabel>Issue Details</SectionLabel>
                        {loadingSubTypes ? (
                          <LoadingRow colors={colors} label="Identifying issue details…" />
                        ) : subTypes.length > 0 ? (
                          selectedSubType ? (
                            <View style={{ backgroundColor: CT.blueTint, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: spacing.lg }}>
                              <Ionicons name="sparkles" size={16} color={CT.blueDeep} />
                              <View style={{ flex: 1 }}>
                                <Text style={{ fontSize: 10, fontWeight: '700', color: CT.blueDeep, letterSpacing: 0.5 }}>AUTO-DETECTED</Text>
                                <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: CT.blueDeep }}>{selectedSubType.name}</Text>
                              </View>
                              <TouchableOpacity onPress={() => setSelectedSubType(null)} style={{ padding: 4 }}>
                                <Ionicons name="close-circle" size={18} color={CT.ink2} />
                              </TouchableOpacity>
                            </View>
                          ) : (
                            <DropdownPicker
                              placeholder="Select issue details"
                              value={null}
                              items={subTypes}
                              labelKey="name"
                              onSelect={(st: IssueSubType) => setSelectedSubType(st)}
                              colors={colors}
                              icon="list-outline"
                              allowDeselect
                              selectedId={selectedSubType?.id}
                            />
                          )
                        ) : (
                          <View style={[glass.input, { paddingHorizontal: spacing.md, paddingVertical: 14, marginBottom: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, borderColor: CT.border, backgroundColor: CT.soft }]}>
                            <Ionicons name="information-circle-outline" size={16} color={CT.ink3} />
                            <Text style={{ fontSize: fontSize.sm, color: CT.ink3 }}>No sub-categories for this type</Text>
                          </View>
                        )}
                      </>
                    )}

                    {/* Linked Asset — web parity. Shown only when the selected
                        location has allocated assets matching the issue. */}
                    {selectedIssueType && candidateAssets.length > 0 && (
                      <>
                        <SectionLabel>Linked Asset</SectionLabel>
                        <DropdownPicker
                          placeholder="Select asset (optional)"
                          value={
                            selectedAssetId === '__none'
                              ? 'No specific asset'
                              : selectedAssetId
                                ? (formatTicketAssetLabel(candidateAssets.find((a: any) => a.id === selectedAssetId))
                                    || candidateAssets.find((a: any) => a.id === selectedAssetId)?.asset_code
                                    || null)
                                : null
                          }
                          items={[{ id: '__none' }, ...candidateAssets]}
                          labelKey="asset_code"
                          labelFormatter={(a: any) =>
                            a.id === '__none'
                              ? 'No specific asset'
                              : (formatTicketAssetLabel(a) || a.asset_code || 'Asset')
                          }
                          onSelect={(a: any) => {
                            assetManuallyPickedRef.current = true;
                            setSelectedAssetId(a.id === '__none' ? '__none' : a.id);
                          }}
                          colors={colors}
                          icon="cube-outline"
                          selectedId={selectedAssetId || undefined}
                        />
                        <Text style={{ fontSize: fontSize.xs, color: CT.ink3, marginTop: -spacing.md, marginBottom: spacing.lg }}>
                          {candidateAssets.length === 1
                            ? 'Auto-linked from this location — tap to change.'
                            : `${candidateAssets.length} assets found for this location — best match auto-selected.`}
                        </Text>
                      </>
                    )}

                    {/* Priority */}
                    <SectionLabel>Priority</SectionLabel>
                    <View style={{ flexDirection: 'row', gap: 8, marginBottom: spacing.lg }}>
                      {PRIORITY_OPTIONS.map(p => (
                        <TouchableOpacity key={p.value} onPress={() => setPriority(p.value)}
                          style={{ flex: 1, paddingVertical: 8, borderRadius: 12, alignItems: 'center',
                            backgroundColor: priority === p.value ? p.color : CT.surface,
                            borderWidth: 1, borderColor: priority === p.value ? p.color : CT.border }}>
                          <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: priority === p.value ? '#fff' : p.color }}>{p.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </>
                )}
              </>
            )}

            {/* ── SHARED: Photo Upload (tenant: 1 max, admin: 5 max) ────────── */}
            <SectionLabel>Photos (Optional, max {maxPhotos})</SectionLabel>
            <View style={{ marginBottom: spacing.lg }}>
              {selectedPhotos.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {selectedPhotos.map((photo, index) => (
                      <View key={index} style={{ position: 'relative' }}>
                        <Image source={{ uri: photo.uri }} style={{ width: 80, height: 80, borderRadius: borderRadius.md }} resizeMode="cover" />
                        <TouchableOpacity
                          onPress={() => removePhoto(index)}
                          style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: '#DC2626', alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Ionicons name="close" size={12} color="#fff" />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                </ScrollView>
              )}
              {/* Tenant: buttons stay visible even with a photo selected so tapping either replaces it. */}
              {(isTenant || selectedPhotos.length < maxPhotos) && (
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity
                    onPress={takePhoto}
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 12, borderWidth: 1.5, borderStyle: 'dashed', borderColor: CT.blueDeep, backgroundColor: CT.blueSoft }}
                  >
                    <Ionicons name="camera-outline" size={18} color={CT.blueDeep} />
                    <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: CT.blueDeep }}>
                      {isTenant && selectedPhotos.length > 0 ? 'Retake' : 'Camera'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={pickPhotos}
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 12, borderWidth: 1.5, borderStyle: 'dashed', borderColor: CT.blueDeep, backgroundColor: CT.blueSoft }}
                  >
                    <Ionicons name="image-outline" size={18} color={CT.blueDeep} />
                    <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: CT.blueDeep }}>
                      {isTenant && selectedPhotos.length > 0 ? 'Replace' : 'Gallery'}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
              {selectedPhotos.length > 0 && (
                <Text style={{ fontSize: fontSize.xs, color: CT.ink3, marginTop: 6, textAlign: 'center' }}>
                  {selectedPhotos.length}/{maxPhotos} photo{selectedPhotos.length > 1 ? 's' : ''} selected
                </Text>
              )}
            </View>

            {/* SLA info */}
            {selectedIssueType && (
              <View style={{ backgroundColor: CT.blueSoft, borderRadius: 12, padding: spacing.md, marginBottom: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="timer-outline" size={16} color={CT.blueDeep} />
                <Text style={{ fontSize: fontSize.sm, color: CT.blueDeep, fontWeight: '700' }}>
                  SLA: {selectedIssueType.sla_hours}h from creation
                </Text>
              </View>
            )}

            {/* Submit */}
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={submitting}
              style={{ backgroundColor: CT.blue, borderRadius: 12, paddingVertical: 16, alignItems: 'center', opacity: submitting ? 0.6 : 1, shadowColor: CT.blue, shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 3 }}
            >
              {submitting ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <ActivityIndicator color="#fff" />
                  <Text style={{ color: '#fff', fontSize: fontSize.sm, fontWeight: '700' }}>
                    {uploadingPhotos ? 'Uploading photos...' : 'Creating ticket...'}
                  </Text>
                </View>
              ) : (
                <Text style={{ color: '#fff', fontSize: fontSize.md, fontWeight: '800' }}>
                  Create Ticket{selectedPhotos.length > 0 ? ` with ${selectedPhotos.length} Photo${selectedPhotos.length > 1 ? 's' : ''}` : ''}
                </Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </GlassBackground>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function capitalize(s: string) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: CT.ink2, marginBottom: 8 }}>
      {children}
    </Text>
  );
}

function LoadingRow({ colors, label }: { colors: any; label: string }) {
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 10,
      paddingHorizontal: spacing.md, paddingVertical: 14,
      borderRadius: 12, borderWidth: 1,
      borderColor: CT.border, backgroundColor: CT.soft,
      marginBottom: spacing.lg,
    }}>
      <ActivityIndicator size="small" color={CT.blueDeep} />
      <Text style={{ fontSize: fontSize.sm, color: CT.ink3 }}>{label}</Text>
    </View>
  );
}

// ─── Reusable dropdown picker ─────────────────────────────────────────────────
interface DropdownPickerProps {
  placeholder: string;
  value: string | null;
  items: any[];
  labelKey: string;
  labelFormatter?: (item: any) => string;
  onSelect: (item: any) => void;
  colors: any;
  icon?: string;
  allowDeselect?: boolean;
  selectedId?: string;
}

function DropdownPicker({ placeholder, value, items, labelKey, labelFormatter, onSelect, colors, icon, allowDeselect, selectedId }: DropdownPickerProps) {
  const [open, setOpen] = useState(false);

  const getLabel = (item: any) => labelFormatter ? labelFormatter(item) : (item[labelKey] ?? '');

  return (
    <>
      <TouchableOpacity
        onPress={() => setOpen(true)}
        style={{
          flexDirection: 'row', alignItems: 'center',
          paddingHorizontal: spacing.md, paddingVertical: 14,
          borderRadius: 12, borderWidth: 1,
          borderColor: value ? CT.blueDeep : CT.border,
          backgroundColor: value ? CT.blueSoft : CT.surface,
          marginBottom: spacing.lg, gap: 10,
        }}
      >
        {icon && <Ionicons name={icon as any} size={18} color={value ? CT.blueDeep : CT.ink3} />}
        <Text style={{ flex: 1, fontSize: fontSize.sm, fontWeight: value ? '700' : '400', color: value ? CT.blueDeep : CT.ink3 }}>
          {value || placeholder}
        </Text>
        <Ionicons name="chevron-down" size={16} color={value ? CT.blueDeep : CT.ink3} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity
          style={{ flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', paddingHorizontal: 24 }}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        >
          <TouchableOpacity activeOpacity={1}>
            <View style={{
              backgroundColor: CT.surface,
              borderRadius: 18, maxHeight: 380,
              overflow: 'hidden', shadowColor: '#0F172A',
              shadowOpacity: 0.18, shadowRadius: 16, elevation: 10,
            }}>
              <View style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
                borderBottomWidth: 1, borderBottomColor: CT.border,
              }}>
                <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: CT.ink }}>{placeholder}</Text>
                <TouchableOpacity onPress={() => setOpen(false)}>
                  <Ionicons name="close-circle" size={22} color={CT.ink3} />
                </TouchableOpacity>
              </View>

              <FlatList
                data={items}
                keyExtractor={(item) => String(item.id ?? item[labelKey])}
                renderItem={({ item }) => {
                  const label = getLabel(item);
                  // Match on unique id when we have one — comparing by display label
                  // marks EVERY row that shares a label (e.g. two apartments both "A23")
                  // as selected. Fall back to label only when no id is provided.
                  const isSelected = selectedId != null ? selectedId === item.id : value === label;
                  return (
                    <TouchableOpacity
                      onPress={() => { onSelect(item); setOpen(false); }}
                      style={{
                        flexDirection: 'row', alignItems: 'center',
                        paddingHorizontal: spacing.lg, paddingVertical: 14,
                        borderBottomWidth: 1, borderBottomColor: CT.border,
                        backgroundColor: isSelected ? CT.blueSoft : 'transparent',
                      }}
                    >
                      <Text style={{ flex: 1, fontSize: fontSize.sm, fontWeight: isSelected ? '700' : '500', color: isSelected ? CT.blueDeep : CT.ink }}>
                        {label}
                      </Text>
                      {isSelected && <Ionicons name="checkmark-circle" size={18} color={CT.blueDeep} />}
                    </TouchableOpacity>
                  );
                }}
                showsVerticalScrollIndicator={false}
              />
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </>
  );
}
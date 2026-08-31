import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  RefreshControl, ActivityIndicator, Alert, Modal,
  KeyboardAvoidingView, Platform, Image, FlatList, StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
const MEDIA_TYPE_IMAGES = 'images' as any;
import { GlassBackground, PageHeader, IconBtnSolid, SearchField, FilterChip } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/ThemeContext';
import { glass, spacing, borderRadius, fontSize } from '../lib/theme';

// Blue / slate design tokens (web chrome)
const VBRAND = {
  purple: '#6A2C90', purpleDeep: '#1D4ED8', orange: '#6A2C90',
  ink900: '#0F172A', ink700: '#374151', ink600: '#64748B', ink500: '#64748B', ink400: '#94A3B8',
  panel: '#FFFFFF', panelBorder: '#EEF1F6',
  surface: '#FFFFFF', divider: '#EEF1F6', soft: '#F8FAFC',
};

// Unified card surface for the redesigned UI
const vCard = {
  backgroundColor: '#FFFFFF',
  borderRadius: 16,
  padding: 16,
  borderWidth: 1,
  borderColor: '#EEF1F6',
  shadowColor: '#0F172A',
  shadowOpacity: 0.05,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 4 },
} as const;

const vInput = {
  backgroundColor: '#F8FAFC',
  borderRadius: 12,
  borderWidth: 1,
  borderColor: '#EEF1F6',
} as const;
import {
  fetchTickets, createTicket, Ticket, STATUS_CONFIG, PRIORITY_CONFIG,
  fetchIssueTypes, fetchIssueSubTypes, classifyIssue, fetchProperties, fetchApartments, fetchBeds,
  IssueType, IssueSubType, uploadTicketPhoto, adminApproveCompletion,
} from '../services/ticketService';

// ─── Main admin-level tab groups (mirrors web 5-tab structure) ────────────────
const MAIN_TABS = [
  { key: 'list',       label: 'Tickets',     icon: 'list-outline'        },
  { key: 'dashboard',  label: 'Dashboard',   icon: 'stats-chart-outline' },
  { key: 'regular',    label: 'Regular',     icon: 'refresh-circle-outline' },
  { key: 'categories', label: 'Categories',  icon: 'pricetags-outline'   },
  { key: 'ai',         label: 'AI Insights', icon: 'sparkles-outline'    },
];

// ─── Constants ────────────────────────────────────────────────────────────────

// Tab groups: each key maps to one or more backend statuses
const TAB_GROUPS: { key: string; label: string; statuses: string[]; color: string; bg: string }[] = [
  { key: 'open',            label: 'Open',            statuses: ['open', 'assigned', 'in_progress', 'waiting_for_parts', 'reopened', 'on_hold', 'reassigned'], color: '#2563EB', bg: '#EEF2FF' },
  { key: 'cost_approval',   label: 'Cost Approval',   statuses: ['waiting_for_cost_approval'],                            color: '#EF4444', bg: '#FEF2F2' },
  { key: 'admin_approval',  label: 'Admin Approval',  statuses: ['pending_admin_approval'],                               color: '#2563EB', bg: '#EEF2FF' },
  { key: 'tenant_approval', label: 'Tenant Approval', statuses: ['pending_tenant_approval'],                              color: '#F59E0B', bg: '#FFFBEB' },
  { key: 'closed',          label: 'Closed',          statuses: ['closed', 'completed', 'cancelled'],                     color: '#22C55E', bg: '#ECFDF5' },
];

const PRIORITY_OPTIONS = [
  { value: 'low',      label: 'Low',      color: '#22C55E', bg: '#ECFDF5' },
  { value: 'medium',   label: 'Medium',   color: '#F59E0B', bg: '#FFFBEB' },
  { value: 'high',     label: 'High',     color: '#EF4444', bg: '#FEF2F2' },
  { value: 'critical', label: 'Critical', color: '#EF4444', bg: '#FEF2F2' },
];

// ─── Admin Raise Ticket Modal ─────────────────────────────────────────────────

function AdminRaiseTicketModal({
  visible,
  onClose,
  onCreated,
  user,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
  user: any;
}) {
  const { colors } = useTheme();
  const submitGuard = useRef(false);

  const [properties, setProperties]   = useState<any[]>([]);
  const [apartments, setApartments]   = useState<any[]>([]);
  const [beds, setBeds]               = useState<any[]>([]);
  const [issueTypes, setIssueTypes]   = useState<IssueType[]>([]);
  const [subTypes, setSubTypes]       = useState<IssueSubType[]>([]);

  const [selectedProperty,  setSelectedProperty]  = useState<any>(null);
  const [selectedApartment, setSelectedApartment] = useState<any>(null);
  const [selectedBed,       setSelectedBed]       = useState<any>(null);
  const [selectedIssueType, setSelectedIssueType] = useState<IssueType | null>(null);
  const [selectedSubType,   setSelectedSubType]   = useState<IssueSubType | null>(null);
  const [priority,          setPriority]          = useState('medium');
  const [description,       setDescription]       = useState('');

  // ── AI Issue Classifier (mirrors CreateTicketScreen admin flow) ───────────
  const [classifying, setClassifying] = useState(false);
  const [classifierMatches, setClassifierMatches] = useState<{ issue_type_id: string; confidence: number; name?: string }[]>([]);
  const [classifierTopId, setClassifierTopId] = useState<string | null>(null);
  const [classifierTopConf, setClassifierTopConf] = useState(0);
  const [classifierAction, setClassifierAction] = useState<'auto_select' | 'suggest' | 'manual' | 'idle'>('idle');
  const [classifierOverridden, setClassifierOverridden] = useState(false);
  const [classifierSubTypeId, setClassifierSubTypeId] = useState<string | null>(null);
  const classifierTimerRef = React.useRef<any>(null);
  const lastClassifiedDesc = React.useRef('');

  // ── Local keyword classifier (same as CreateTicketScreen) ────────────────
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
      { keywords: ['bill', 'billing', 'charge', 'invoice', 'payment', 'amount', 'overcharged', 'rent'], fragments: ['bill', 'charg', 'invoic', 'payment', 'rent', 'account', 'financ'] },
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
    if (!bestType) {
      for (const type of types) {
        const words = type.name.toLowerCase().split(/\W+/).filter(w => w.length > 3);
        if (words.some(w => lower.includes(w))) { bestType = type; break; }
      }
    }
    return bestType;
  }

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
    return bestScore > 0 ? best : subs[0];
  }

  // Auto-select sub-type when subTypes load
  React.useEffect(() => {
    if (!subTypes.length || selectedSubType) return;
    if (classifierSubTypeId) {
      const found = subTypes.find((s: any) => s.id === classifierSubTypeId);
      if (found) { setSelectedSubType(found); return; }
    }
    const best = localClassifySubType(description.trim(), subTypes);
    if (best) setSelectedSubType(best);
  }, [subTypes, classifierSubTypeId]);

  // Debounced AI+local classification — auto-selects best match after description typed
  React.useEffect(() => {
    const trimmed = description.trim();
    if (trimmed.length < 4 || issueTypes.length === 0) {
      setClassifierMatches([]); setClassifierTopId(null); setClassifierTopConf(0); setClassifierAction('idle');
      return;
    }
    if (trimmed === lastClassifiedDesc.current) return;
    if (classifierTimerRef.current) clearTimeout(classifierTimerRef.current);
    classifierTimerRef.current = setTimeout(async () => {
      lastClassifiedDesc.current = trimmed;
      if (classifierOverridden) return;
      setClassifying(true);
      try {
        const result = await classifyIssue(trimmed, issueTypes);
        const topId = result.top_issue_type_id as string | null;
        const subId = result.top_issue_sub_type_id as string | null;
        const foundType = topId ? issueTypes.find((t: any) => t.id === topId) : null;
        const typeToSelect = foundType || localClassifyIssue(trimmed, issueTypes);
        if (typeToSelect && !classifierOverridden) {
          setClassifierTopId(typeToSelect.id);
          setClassifierTopConf(result.top_confidence || 90);
          setClassifierAction('auto_select');
          setClassifierMatches(result.matches || []);
          if (subId) setClassifierSubTypeId(subId);
          onIssueTypeSelect(typeToSelect);
        }
      } catch {
        const typeToSelect = localClassifyIssue(trimmed, issueTypes);
        if (typeToSelect && !classifierOverridden) {
          setClassifierAction('auto_select');
          onIssueTypeSelect(typeToSelect);
        }
      } finally { setClassifying(false); }
    }, 650);
    return () => { if (classifierTimerRef.current) clearTimeout(classifierTimerRef.current); };
  }, [description, issueTypes, classifierOverridden]);

  const [selectedPhotos,  setSelectedPhotos]  = useState<{ uri: string; base64?: string; mimeType?: string }[]>([]);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);

  const [loading,           setLoading]           = useState(false);
  const [submitting,        setSubmitting]         = useState(false);
  const [loadingApartments, setLoadingApartments] = useState(false);
  const [loadingBeds,       setLoadingBeds]       = useState(false);
  const [loadingSubTypes,   setLoadingSubTypes]   = useState(false);

  useEffect(() => {
    if (visible) {
      resetAll();
      loadData();
    }
  }, [visible]);

  function resetAll() {
    setSelectedProperty(null);
    setSelectedApartment(null);
    setSelectedBed(null);
    setApartments([]);
    setBeds([]);
    setSelectedIssueType(null);
    setSelectedSubType(null);
    setSubTypes([]);
    setPriority('medium');
    setDescription('');
    setSelectedPhotos([]);
    setLoadingApartments(false);
    setLoadingBeds(false);
    setLoadingSubTypes(false);
    setClassifierOverridden(false);
    setClassifierSubTypeId(null);
    setClassifierAction('idle');
    setClassifierTopId(null);
    setClassifierMatches([]);
    lastClassifiedDesc.current = '';
    submitGuard.current = false;
  }

  async function loadData() {
    setLoading(true);
    try {
      const [props, types] = await Promise.all([fetchProperties(), fetchIssueTypes()]);
      setProperties(props);
      setIssueTypes(types);
    } finally {
      setLoading(false);
    }
  }

  async function onPropertySelect(prop: any) {
    setSelectedProperty(prop);
    setSelectedApartment(null);
    setSelectedBed(null);
    setApartments([]);
    setBeds([]);
    setLoadingApartments(true);
    try { setApartments(await fetchApartments(prop.id)); } catch {}
    setLoadingApartments(false);
  }

  async function onApartmentSelect(apt: any) {
    setSelectedApartment(apt);
    setSelectedBed(null);
    setBeds([]);
    setLoadingBeds(true);
    try { setBeds(await fetchBeds(apt.id)); } catch {}
    setLoadingBeds(false);
  }

  async function onIssueTypeSelect(it: IssueType) {
    setSelectedIssueType(it);
    setSelectedSubType(null);
    setSubTypes([]);
    setPriority(it.priority || 'medium');
    setLoadingSubTypes(true);
    try { setSubTypes(await fetchIssueSubTypes(it.id)); } catch {}
    setLoadingSubTypes(false);
  }

  async function pickPhotos() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { Alert.alert('Permission Required', 'Please allow access to your photo library.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: MEDIA_TYPE_IMAGES, allowsMultipleSelection: true, quality: 0.7, base64: true,
    });
    if (!result.canceled) {
      setSelectedPhotos(prev =>
        [...prev, ...result.assets.map(a => ({ uri: a.uri, base64: a.base64 ?? undefined, mimeType: a.mimeType ?? 'image/jpeg' }))].slice(0, 5)
      );
    }
  }

  async function takePhoto() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') { Alert.alert('Permission Required', 'Please allow camera access.'); return; }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true });
    if (!result.canceled && result.assets[0]) {
      const a = result.assets[0];
      setSelectedPhotos(prev => [...prev, { uri: a.uri, base64: a.base64 ?? undefined, mimeType: a.mimeType ?? 'image/jpeg' }].slice(0, 5));
    }
  }

  async function handleSubmit() {
    if (submitGuard.current) return;
    if (!selectedProperty)  { Alert.alert('Error', 'Please select a property'); return; }
    if (!selectedIssueType) { Alert.alert('Error', 'Please select an issue type'); return; }
    if (!description.trim()) { Alert.alert('Error', 'Please describe the issue'); return; }

    submitGuard.current = true;
    setSubmitting(true);

    try {
      let photoUrls: string[] = [];
      if (selectedPhotos.length > 0) {
        setUploadingPhotos(true);
        const uploads = await Promise.all(selectedPhotos.map(p => uploadTicketPhoto(p.uri, p.base64, p.mimeType)));
        photoUrls = uploads.filter(Boolean) as string[];
        setUploadingPhotos(false);
      }

      const ticket = await createTicket({
        issue_type_id:  selectedIssueType.id,
        issue_type:     selectedIssueType.name,
        issue_subtype:  selectedSubType?.name || null,
        description:    description.trim(),
        priority,
        created_by:     user?.supabaseUserId || user?.userId || null,
        tenant_id:      null,
        tenant_name:    user?.userName || 'Admin',
        property_id:    selectedProperty?.id || null,
        apartment_id:   selectedApartment?.id || null,
        bed_id:         selectedBed?.id || null,
        apartment_code: selectedBed?.bed_code || selectedApartment?.apartment_code || null,
        photo_urls:     photoUrls.length > 0 ? photoUrls : null,
        source:         'admin',
      });

      const assignedName = ticket.diagnostic_data?.assigned_to_name;
      const assignedPhone = ticket.diagnostic_data?.assigned_to_phone;
      const assignedMsg = assignedName
        ? `\n\n✅ Auto-assigned to: ${assignedName}${assignedPhone ? `\n📞 ${assignedPhone}` : ''}`
        : '\n\n⏳ No matching rule — ticket is open for manual assignment.';

      Alert.alert(
        assignedName ? '🎉 Ticket Raised & Assigned!' : '✅ Ticket Raised',
        `Ticket ${ticket.ticket_number} has been created.${assignedMsg}`,
        [{ text: 'OK', onPress: () => { onClose(); onCreated(); } }]
      );
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to create ticket');
      submitGuard.current = false;
    } finally {
      setSubmitting(false);
      setUploadingPhotos(false);
    }
  }

  const canSubmit = !!selectedProperty && !!selectedIssueType && !!description.trim() && !submitting;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }} edges={['top']}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

            {/* Header */}
            <View style={{
              flexDirection: 'row', alignItems: 'center',
              paddingHorizontal: 18, paddingTop: 8, paddingBottom: 14,
            }}>
              <TouchableOpacity
                onPress={onClose}
                style={{
                  width: 40, height: 40, borderRadius: 12,
                  backgroundColor: '#FFFFFF',
                  borderWidth: 0.5, borderColor: '#EEF1F6',
                  alignItems: 'center', justifyContent: 'center', marginRight: 12,
                  shadowColor: VBRAND.purpleDeep, shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
                }}
              >
                <Ionicons name="close" size={22} color={VBRAND.ink900} />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 10, color: VBRAND.ink400, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase' }}>Admin</Text>
                <Text style={{ fontSize: 20, fontWeight: '900', color: VBRAND.ink900, letterSpacing: -0.4, marginTop: 2 }}>Raise Ticket</Text>
              </View>
              {/* Step dots — animated dashes */}
              <View style={{ flexDirection: 'row', gap: 5, alignItems: 'center', backgroundColor: '#FFFFFF', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 999 }}>
                {[!!selectedProperty, !!description.trim(), !!selectedIssueType].map((done, i) => (
                  <View key={i} style={{
                    width: done ? 18 : 6, height: 6, borderRadius: 3,
                    backgroundColor: done ? VBRAND.purple : '#F3ECF9',
                  }} />
                ))}
              </View>
            </View>

            {loading ? (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                <View style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: '#F3ECF9', alignItems: 'center', justifyContent: 'center' }}>
                  <ActivityIndicator size="large" color={VBRAND.purple} />
                </View>
                <Text style={{ fontSize: 13, color: VBRAND.ink500, fontWeight: '600' }}>Loading…</Text>
              </View>
            ) : (
              <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 120, gap: 14 }}>

                {/* ── STEP 1: Property → Apartment → Bed ───────────────── */}
                <View style={vCard}>
                  <StepHeader
                    step={1}
                    title="Select Property *"
                    done={!!selectedProperty}
                    doneLabel={selectedProperty?.property_name}
                  />

                  <RaiseTicketDropdown
                    placeholder="Select property"
                    value={selectedProperty?.property_name || null}
                    items={properties}
                    labelKey="property_name"
                    onSelect={onPropertySelect}
                    colors={colors}
                    icon="business-outline"
                  />

                  {selectedProperty && (
                    <>
                      <Text style={{ fontSize: 11, fontWeight: '800', color: VBRAND.ink500, marginBottom: 8, marginTop: 4, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                        Apartment · Optional
                      </Text>
                      {loadingApartments ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 }}>
                          <ActivityIndicator size="small" color="#6A2C90" />
                          <Text style={{ fontSize: fontSize.sm, color: colors.textTertiary }}>Loading apartments...</Text>
                        </View>
                      ) : apartments.length > 0 ? (
                        <RaiseTicketDropdown
                          placeholder="Select apartment"
                          value={selectedApartment?.apartment_code || null}
                          items={apartments}
                          labelKey="apartment_code"
                          onSelect={onApartmentSelect}
                          colors={colors}
                          icon="grid-outline"
                        />
                      ) : (
                        <Text style={{ fontSize: fontSize.sm, color: colors.textTertiary, marginBottom: 8 }}>No apartments found</Text>
                      )}
                    </>
                  )}

                  {selectedApartment && (
                    <>
                      <Text style={{ fontSize: 11, fontWeight: '800', color: VBRAND.ink500, marginBottom: 8, marginTop: 4, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                        Bed · Optional
                      </Text>
                      {loadingBeds ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 }}>
                          <ActivityIndicator size="small" color="#6A2C90" />
                          <Text style={{ fontSize: fontSize.sm, color: colors.textTertiary }}>Loading beds...</Text>
                        </View>
                      ) : beds.length > 0 ? (
                        <RaiseTicketDropdown
                          placeholder="Select bed"
                          value={selectedBed ? `${selectedBed.bed_code}${selectedBed.bed_type ? ` (${capitalizeBed(selectedBed.bed_type)})` : ''}` : null}
                          items={beds}
                          labelKey="bed_code"
                          labelFormatter={(b: any) => `${b.bed_code}${b.bed_type ? ` (${capitalizeBed(b.bed_type)})` : ''}`}
                          onSelect={(b: any) => setSelectedBed(selectedBed?.id === b.id ? null : b)}
                          colors={colors}
                          icon="bed-outline"
                        />
                      ) : (
                        <Text style={{ fontSize: fontSize.sm, color: colors.textTertiary, marginBottom: 8 }}>No beds found</Text>
                      )}
                    </>
                  )}
                </View>

                {/* ── STEP 2: Description — shown after property selected ── */}
                {selectedProperty && (
                  <View style={vCard}>
                    <StepHeader step={2} title="Describe the Issue *" done={!!description.trim()} />

                    <TextInput
                      style={[vInput, {
                        padding: 14, fontSize: 14, color: VBRAND.ink900,
                        minHeight: 110, textAlignVertical: 'top', fontWeight: '500',
                      }]}
                      placeholder="Describe the issue in detail — e.g. 'water leaking from tap', 'AC not cooling'..."
                      placeholderTextColor={colors.textTertiary}
                      value={description}
                      onChangeText={txt => {
                        setDescription(txt);
                        setClassifierOverridden(false);
                        lastClassifiedDesc.current = '';
                      }}
                      multiline
                    />

                    {/* AI scanning indicator */}
                    {description.trim().length >= 4 && classifying && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
                        <ActivityIndicator size="small" color="#6A2C90" />
                        <Text style={{ fontSize: fontSize.xs, color: '#6A2C90' }}>Identifying issue type…</Text>
                      </View>
                    )}
                  </View>
                )}

                {/* ── STEP 3: Issue Type — AI auto-selected, user can change ── */}
                {selectedProperty && description.trim().length >= 4 && (
                  <View style={vCard}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <View style={{
                        width: 26, height: 26, borderRadius: 8,
                        backgroundColor: selectedIssueType ? '#6A2C90' : colors.border,
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        {selectedIssueType
                          ? <Ionicons name="checkmark" size={14} color="#fff" />
                          : <Text style={{ color: '#fff', fontWeight: '800', fontSize: 12 }}>3</Text>
                        }
                      </View>
                      <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.text }}>Issue Type *</Text>
                      {selectedIssueType && (
                        <View style={{ backgroundColor: '#F3ECF9', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                          <Text style={{ fontSize: 10, color: '#6A2C90', fontWeight: '700' }}>AUTO-DETECTED</Text>
                        </View>
                      )}
                    </View>

                    {selectedIssueType ? (
                      /* Auto-selected result — tap X to change manually */
                      <View style={{ backgroundColor: '#F3ECF9', borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                        <Ionicons name="sparkles" size={18} color="#6A2C90" />
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: '#6A2C90' }}>{selectedIssueType.name}</Text>
                          {selectedIssueType.sla_hours != null && (
                            <Text style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>SLA: {selectedIssueType.sla_hours}h · Default priority: {selectedIssueType.priority}</Text>
                          )}
                        </View>
                        <TouchableOpacity
                          onPress={() => {
                            setSelectedIssueType(null);
                            setSelectedSubType(null);
                            setSubTypes([]);
                            setClassifierOverridden(true);
                            setClassifierAction('idle');
                            lastClassifiedDesc.current = '';
                          }}
                          style={{ padding: 6 }}
                        >
                          <Ionicons name="close-circle" size={20} color="#94A3B8" />
                        </TouchableOpacity>
                      </View>
                    ) : (
                      /* Fallback picker — shown when AI found nothing */
                      <RaiseTicketDropdown
                        placeholder="Select issue type"
                        value={null}
                        items={issueTypes}
                        labelKey="name"
                        onSelect={(it: IssueType) => {
                          setClassifierOverridden(true);
                          onIssueTypeSelect(it);
                        }}
                        colors={colors}
                        icon="construct-outline"
                      />
                    )}

                    {/* Issue Details — auto-selected sub-type */}
                    {selectedIssueType && (
                      <>
                        <Text style={{ fontSize: 11, fontWeight: '800', color: VBRAND.ink500, marginBottom: 8, marginTop: 4, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                          Issue Details · Optional
                        </Text>
                        {loadingSubTypes ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 }}>
                            <ActivityIndicator size="small" color="#6A2C90" />
                            <Text style={{ fontSize: fontSize.sm, color: colors.textTertiary }}>Loading details…</Text>
                          </View>
                        ) : subTypes.length > 0 ? (
                          selectedSubType ? (
                            <View style={{ backgroundColor: '#F3ECF9', borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                              <Ionicons name="sparkles" size={16} color="#6A2C90" />
                              <View style={{ flex: 1 }}>
                                <Text style={{ fontSize: 10, fontWeight: '700', color: '#6A2C90', letterSpacing: 0.5 }}>AUTO-DETECTED</Text>
                                <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#6A2C90' }}>{selectedSubType.name}</Text>
                              </View>
                              <TouchableOpacity onPress={() => setSelectedSubType(null)} style={{ padding: 4 }}>
                                <Ionicons name="close-circle" size={18} color="#94A3B8" />
                              </TouchableOpacity>
                            </View>
                          ) : (
                            <RaiseTicketDropdown
                              placeholder="Select issue details"
                              value={selectedSubType?.name || null}
                              items={subTypes}
                              labelKey="name"
                              onSelect={(st: IssueSubType) => setSelectedSubType(selectedSubType?.id === st.id ? null : st)}
                              colors={colors}
                              icon="list-outline"
                              selectedId={selectedSubType?.id}
                            />
                          )
                        ) : (
                          <Text style={{ fontSize: fontSize.sm, color: colors.textTertiary, marginBottom: 8 }}>No sub-categories for this type</Text>
                        )}
                      </>
                    )}
                  </View>
                )}

                {/* ── Priority — shown after issue type selected ─────────── */}
                {selectedIssueType && (
                  <View style={vCard}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: VBRAND.ink500, marginBottom: 12, letterSpacing: 0.6, textTransform: 'uppercase' }}>Priority</Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {PRIORITY_OPTIONS.map(p => (
                        <TouchableOpacity
                          key={p.value}
                          onPress={() => setPriority(p.value)}
                          activeOpacity={0.85}
                          style={{
                            flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center',
                            backgroundColor: priority === p.value ? p.color : '#FFFFFF',
                            borderWidth: 1, borderColor: priority === p.value ? p.color : '#F3ECF9',
                            shadowColor: priority === p.value ? p.color : 'transparent',
                            shadowOpacity: priority === p.value ? 0.25 : 0,
                            shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
                          }}
                        >
                          <Text style={{ fontSize: 12, fontWeight: '800', color: priority === p.value ? '#fff' : p.color, letterSpacing: 0.3 }}>
                            {p.label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                )}

                {/* ── Photos card — shown after issue type selected ──────── */}
                {selectedIssueType && (
                  <View style={vCard}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: VBRAND.ink500, marginBottom: 10, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                      Photos · Optional, max 5
                    </Text>
                  {selectedPhotos.length > 0 && (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        {selectedPhotos.map((photo, index) => (
                          <View key={index} style={{ position: 'relative' }}>
                            <Image
                              source={{ uri: photo.uri }}
                              style={{ width: 76, height: 76, borderRadius: 12 }}
                              resizeMode="cover"
                            />
                            <TouchableOpacity
                              onPress={() => setSelectedPhotos(prev => prev.filter((_, i) => i !== index))}
                              style={{
                                position: 'absolute', top: -6, right: -6,
                                width: 22, height: 22, borderRadius: 11,
                                backgroundColor: '#DC2626', alignItems: 'center', justifyContent: 'center',
                                borderWidth: 2, borderColor: '#fff',
                              }}
                            >
                              <Ionicons name="close" size={12} color="#fff" />
                            </TouchableOpacity>
                          </View>
                        ))}
                      </View>
                    </ScrollView>
                  )}
                  {selectedPhotos.length < 5 && (
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                      <TouchableOpacity
                        onPress={takePhoto}
                        activeOpacity={0.8}
                        style={{
                          flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                          gap: 8, paddingVertical: 12, borderRadius: 12,
                          borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#EEF1F6',
                          backgroundColor: '#F3ECF9',
                        }}
                      >
                        <Ionicons name="camera-outline" size={16} color={VBRAND.purple} />
                        <Text style={{ fontSize: 12, fontWeight: '700', color: VBRAND.purple, letterSpacing: 0.2 }}>Camera</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={pickPhotos}
                        activeOpacity={0.8}
                        style={{
                          flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                          gap: 8, paddingVertical: 12, borderRadius: 12,
                          borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#EEF1F6',
                          backgroundColor: '#F3ECF9',
                        }}
                      >
                        <Ionicons name="image-outline" size={16} color={VBRAND.purple} />
                        <Text style={{ fontSize: 12, fontWeight: '700', color: VBRAND.purple, letterSpacing: 0.2 }}>Gallery</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                  </View>
                )}

                {/* Auto-assign info */}
                {selectedProperty && selectedIssueType && (
                  <View style={{
                    backgroundColor: '#F3ECF9', borderRadius: 16,
                    padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10,
                    borderWidth: 0.5, borderColor: '#EEF1F6',
                  }}>
                    <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
                      <Ionicons name="flash" size={16} color={VBRAND.purple} />
                    </View>
                    <Text style={{ fontSize: 13, color: VBRAND.purpleDeep, fontWeight: '600', flex: 1, lineHeight: 18 }}>
                      Technician will be auto-assigned via ticket assignment rules
                    </Text>
                  </View>
                )}

                {/* Submit — gradient */}
                <TouchableOpacity
                  onPress={handleSubmit}
                  disabled={!canSubmit}
                  activeOpacity={0.9}
                  style={{
                    borderRadius: 16, overflow: 'hidden', marginTop: 4,
                    opacity: canSubmit ? 1 : 0.5,
                    shadowColor: VBRAND.purple,
                    shadowOpacity: canSubmit ? 0.3 : 0,
                    shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
                  }}
                >
                  <LinearGradient
                    colors={canSubmit ? [VBRAND.purpleDeep, VBRAND.purple] : ['#94A3B8', '#64748B']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={{ paddingVertical: 17, alignItems: 'center', justifyContent: 'center' }}
                  >
                    {submitting ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <ActivityIndicator color="#fff" />
                        <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700', letterSpacing: 0.2 }}>
                          {uploadingPhotos ? 'Uploading photos…' : 'Raising ticket…'}
                        </Text>
                      </View>
                    ) : (
                      <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 0.2 }}>
                        Raise Ticket{selectedPhotos.length > 0 ? ` · ${selectedPhotos.length} Photo${selectedPhotos.length > 1 ? 's' : ''}` : ''}
                      </Text>
                    )}
                  </LinearGradient>
                </TouchableOpacity>

              </ScrollView>
            )}
          </KeyboardAvoidingView>
        </SafeAreaView>
      </GlassBackground>
    </Modal>
  );
}

// ─── Capitalize helper ────────────────────────────────────────────────────────

function capitalizeBed(s: string) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ─── Reusable dropdown for the raise-ticket modal ────────────────────────────

interface RaiseTicketDropdownProps {
  placeholder: string;
  value: string | null;
  items: any[];
  labelKey: string;
  labelFormatter?: (item: any) => string;
  onSelect: (item: any) => void;
  colors: any;
  icon?: string;
  disabled?: boolean;
  selectedId?: string;
}

function RaiseTicketDropdown({
  placeholder, value, items, labelKey, labelFormatter, onSelect, colors, icon, disabled, selectedId,
}: RaiseTicketDropdownProps) {
  const [open, setOpen] = useState(false);
  const getLabel = (item: any) => labelFormatter ? labelFormatter(item) : (item[labelKey] ?? '');

  return (
    <>
      <TouchableOpacity
        onPress={() => { if (!disabled) setOpen(true); }}
        activeOpacity={0.8}
        style={{
          flexDirection: 'row', alignItems: 'center',
          paddingHorizontal: 14, paddingVertical: 14,
          borderRadius: 12, borderWidth: 1,
          borderColor: value ? '#6A2C90' : '#F3ECF9',
          backgroundColor: value ? '#F3ECF9' : '#fff',
          marginBottom: 12, gap: 10,
          opacity: disabled ? 0.45 : 1,
        }}
      >
        {icon && (
          <View style={{
            width: 28, height: 28, borderRadius: 8,
            backgroundColor: value ? '#F3ECF9' : '#F3ECF9',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Ionicons name={icon as any} size={15} color={value ? VBRAND.purple : VBRAND.ink400} />
          </View>
        )}
        <Text style={{ flex: 1, fontSize: 14, fontWeight: value ? '700' : '500', color: value ? VBRAND.purpleDeep : VBRAND.ink400, letterSpacing: -0.1 }}>
          {value || placeholder}
        </Text>
        <Ionicons name="chevron-down" size={16} color={value ? VBRAND.purple : VBRAND.ink400} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity
          style={{ flex: 1, backgroundColor: 'rgba(30,18,48,0.55)', justifyContent: 'center', paddingHorizontal: 22 }}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        >
          <TouchableOpacity activeOpacity={1}>
            <View style={{
              backgroundColor: '#fff',
              borderRadius: 16, maxHeight: 440,
              overflow: 'hidden',
              shadowColor: VBRAND.purpleDeep,
              shadowOpacity: 0.3, shadowRadius: 28, shadowOffset: { width: 0, height: 12 }, elevation: 14,
            }}>
              <View style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                paddingHorizontal: 18, paddingVertical: 16,
                borderBottomWidth: 0.5, borderBottomColor: '#EEF1F6',
              }}>
                <Text style={{ fontSize: 15, fontWeight: '800', color: VBRAND.ink900, letterSpacing: -0.2 }}>{placeholder}</Text>
                <TouchableOpacity
                  onPress={() => setOpen(false)}
                  style={{ width: 30, height: 30, borderRadius: 10, backgroundColor: '#F3ECF9', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Ionicons name="close" size={18} color={VBRAND.ink600} />
                </TouchableOpacity>
              </View>
              <FlatList
                data={items}
                keyExtractor={(item) => String(item.id ?? item[labelKey])}
                renderItem={({ item }) => {
                  const label = getLabel(item);
                  const isSelected = selectedId ? selectedId === item.id : value === label;
                  return (
                    <TouchableOpacity
                      onPress={() => { onSelect(item); setOpen(false); }}
                      style={{
                        flexDirection: 'row', alignItems: 'center',
                        paddingHorizontal: 18, paddingVertical: 15,
                        borderBottomWidth: 0.5, borderBottomColor: '#EEF1F6',
                        backgroundColor: isSelected ? '#F3ECF9' : 'transparent',
                      }}
                    >
                      <Text style={{ flex: 1, fontSize: 14, fontWeight: isSelected ? '700' : '500', color: isSelected ? VBRAND.purpleDeep : VBRAND.ink900, letterSpacing: -0.1 }}>
                        {label}
                      </Text>
                      {isSelected && (
                        <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: VBRAND.purple, alignItems: 'center', justifyContent: 'center' }}>
                          <Ionicons name="checkmark" size={14} color="#fff" />
                        </View>
                      )}
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

// ─── Step Header Helper ───────────────────────────────────────────────────────

function StepHeader({ step, title, done, doneLabel }: { step: number; title: string; done: boolean; doneLabel?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 }}>
      <View style={{
        width: 28, height: 28, borderRadius: 9,
        backgroundColor: done ? VBRAND.purple : '#F3ECF9',
        alignItems: 'center', justifyContent: 'center',
        shadowColor: done ? VBRAND.purple : 'transparent',
        shadowOpacity: done ? 0.3 : 0,
        shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
      }}>
        {done
          ? <Ionicons name="checkmark" size={15} color="#fff" />
          : <Text style={{ color: VBRAND.purple, fontWeight: '800', fontSize: 13 }}>{step}</Text>
        }
      </View>
      <Text style={{ fontSize: 14, fontWeight: '800', color: VBRAND.ink900, letterSpacing: -0.2, flex: 1 }}>{title}</Text>
      {done && doneLabel && (
        <View style={{ backgroundColor: 'rgba(22,163,74,0.1)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, maxWidth: 140 }}>
          <Text style={{ fontSize: 11, color: '#16A34A', fontWeight: '700' }} numberOfLines={1}>
            {doneLabel}
          </Text>
        </View>
      )}
    </View>
  );
}

// ─── Main Tickets Screen ──────────────────────────────────────────────────────

export default function TicketsScreen({ navigation }: any) {
  const { colors } = useTheme();
  const { user } = useAuth();

  // ── Role constants (mirrors web useTicketRole) ────────────────────────────
  const rawRole = user?.role || '';
  const isAdmin    = ['org_admin','super_admin','property_manager','admin','pm'].includes(rawRole);
  const isTenant   = rawRole === 'tenant';
  const isEmployee = rawRole === 'technician';
  const [tickets, setTickets]           = useState<Ticket[]>([]);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [filterStatus, setFilterStatus] = useState('open');
  const [search, setSearch]             = useState('');
  const [showRaiseModal, setShowRaiseModal] = useState(false);

  // ── Main admin tabs (mirrors web 5-tab layout) ────────────────────────────
  const [mainTab, setMainTab] = useState<'list'|'dashboard'|'regular'|'categories'|'ai'>('list');

  // Extra data for admin tabs
  const [issueTypes,     setIssueTypes]    = useState<IssueType[]>([]);
  const [issueTypesLoaded, setIssueTypesLoaded] = useState(false);
  const [regularRules,   setRegularRules]  = useState<any[]>([]);
  const [regularLoading, setRegularLoading] = useState(false);
  const [aiAnalysis,     setAiAnalysis]    = useState<string | null>(null);
  const [aiLoading,      setAiLoading]     = useState(false);

  // Admin approval state
  const [approvalTicket, setApprovalTicket]   = useState<Ticket | null>(null);
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [rejectReason, setRejectReason]       = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);

  const load = useCallback(async () => {
    try {
      const role = ['org_admin', 'super_admin', 'property_manager', 'admin', 'pm']
        .includes(user?.role || '') ? 'admin' : (user?.role || 'admin');
      const data = await fetchTickets(role, user?.userId);
      setTickets(data);
    } catch (e: any) {
      console.warn('[TicketsScreen] load error:', e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  // Load issueTypes once for the Categories tab
  const loadIssueTypes = useCallback(async () => {
    if (issueTypes.length > 0) return;
    try {
      const types = await fetchIssueTypes();
      setIssueTypes(types);
    } catch {} finally { setIssueTypesLoaded(true); }
  }, [issueTypes.length]);

  // Load regular maintenance rules for the Regular tab
  const loadRegularRules = useCallback(async () => {
    if (regularRules.length > 0 || regularLoading) return;
    setRegularLoading(true);
    try {
      const { client, api } = await import('../lib/convexApi') as any;
      const rules = await client.action(api.tickets.listRegularMaintenanceRules, {});
      setRegularRules(Array.isArray(rules) ? rules : []);
    } catch {
      setRegularRules([]);
    } finally {
      setRegularLoading(false);
    }
  }, [regularRules.length, regularLoading]);

  useEffect(() => { load(); }, [load]);

  // Lazy-load tab data when admin switches to that tab
  useEffect(() => {
    if (!isAdmin) return;
    if (mainTab === 'categories') loadIssueTypes();
    if (mainTab === 'regular')    loadRegularRules();
  }, [mainTab, isAdmin]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const activeTab = TAB_GROUPS.find(g => g.key === filterStatus) || TAB_GROUPS[0];

  const filtered = tickets.filter(t => {
    const matchStatus = activeTab.statuses.includes(t.status);
    const q = search.toLowerCase();
    const matchSearch = !q ||
      t.ticket_number?.toLowerCase().includes(q) ||
      t.issue_type?.toLowerCase().includes(q) ||
      t.tenant_name?.toLowerCase().includes(q) ||
      t.description?.toLowerCase().includes(q);
    return matchStatus && matchSearch;
  });

  const counts: Record<string, number> = {};
  TAB_GROUPS.forEach(g => {
    counts[g.key] = tickets.filter(t => g.statuses.includes(t.status)).length;
  });

  // Tickets needing admin action right now
  const actionNeeded = tickets.filter(t =>
    ['waiting_for_cost_approval', 'pending_admin_approval', 'open'].includes(t.status)
  ).length;

  // ── Role-based title (mirrors web app) ────────────────────────────────────
  const screenTitle = isTenant ? 'My Tickets' : isEmployee ? 'Assigned Tickets' : 'Maintenance Tickets';

  // ── Tenant-filtered visible tabs (mirrors web visibleStatusTabs) ──────────
  const visibleTabs = isTenant
    ? TAB_GROUPS.filter(g => ['open','tenant_approval','closed'].includes(g.key))
    : TAB_GROUPS;

  // ── Tenant blocked: has pending_tenant_approval tickets (mirrors web) ─────
  const tenantPendingApproval = isTenant
    ? tickets.filter(t => t.status === 'pending_tenant_approval')
    : [];
  const tenantBlocked = isTenant && tenantPendingApproval.length > 0;

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>

        {/* ── Header (page-header) ─────────────────────────────────── */}
        <PageHeader
          title={screenTitle === 'Tickets' ? 'Maintenance Tickets' : screenTitle}
          subtitle="Track and manage maintenance requests"
          onBack={navigation.canGoBack() ? () => navigation.goBack() : undefined}
          right={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <IconBtnSolid
                icon="add"
                disabled={tenantBlocked}
                onPress={() => { if (!tenantBlocked) setShowRaiseModal(true); }}
              />
              {/* ── Export CSV (mirrors web app download button) ───────────── */}
              <TouchableOpacity
                onPress={async () => {
                  try {
                    if (filtered.length === 0) {
                      Alert.alert('No Data', 'No tickets to export.');
                      return;
                    }
                    // Build CSV rows matching web app column order
                    const header = ['Ticket #', 'Tenant', 'Property', 'Issue', 'Priority', 'Status', 'Created', 'SLA'].join(',');
                    const rows = filtered.map((t: any) => {
                      const now = new Date();
                      let slaStatus = '—';
                      if (t.sla_deadline) {
                        const deadline = new Date(t.sla_deadline);
                        if (['completed', 'closed'].includes(t.status)) slaStatus = 'Done';
                        else if (now > deadline) slaStatus = 'Breached';
                        else slaStatus = 'On Track';
                      }
                      const esc = (v: string) => `"${String(v || '').replace(/"/g, '""')}"`;
                      return [
                        esc(t.ticket_number || '—'),
                        esc(t.tenant_name || t.tenants?.full_name || '—'),
                        esc(`${t.properties?.property_name || '—'}${t.apartments?.apartment_code ? ' · ' + t.apartments.apartment_code : ''}`),
                        esc(t.issue_types?.name || t.issue_type || '—'),
                        esc(t.priority || '—'),
                        esc(t.status || '—'),
                        esc(t.created_at ? formatDate(t.created_at, '—') : '—'),
                        esc(slaStatus),
                      ].join(',');
                    });
                    const csvContent = [header, ...rows].join('\n');
                    const filename = `tickets-${new Date().toISOString().split('T')[0]}.csv`;
                    const FileSystem = await import('expo-file-system') as any;
                    const fileUri = FileSystem.cacheDirectory + filename;
                    await FileSystem.writeAsStringAsync(fileUri, csvContent, { encoding: 'utf8' });
                    const Sharing = await import('expo-sharing') as any;
                    const canShare = await Sharing.isAvailableAsync();
                    if (canShare) {
                      await Sharing.shareAsync(fileUri, {
                        mimeType: 'text/csv',
                        dialogTitle: 'Export Tickets',
                        UTI: 'public.comma-separated-values-text',
                      });
                    } else {
                      Alert.alert('Sharing not available', 'Cannot share files on this device.');
                    }
                  } catch (e: any) {
                    Alert.alert('Export failed', e?.message || 'Could not export tickets.');
                  }
                }}
                style={{
                  width: 40, height: 40, borderRadius: 12,
                  backgroundColor: '#FFFFFF',
                  borderWidth: 1, borderColor: '#EEF1F6',
                  alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Ionicons name="download-outline" size={18} color={VBRAND.ink900} />
              </TouchableOpacity>
            </View>
          }
        />

        {/* ── Search ─────────────────────────────────────────────────── */}
        <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 10 }}>
          <SearchField value={search} onChangeText={setSearch} placeholder="Search" />
        </View>

        {/* ── Tab bar area: fixed at top, never scrolls away ─────────────── */}
        <View style={{ flexShrink: 0 }}>
          {/* ── Main admin tabs (Tickets | Dashboard | Regular | Categories | AI) ── */}
          {isAdmin && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 4, gap: 8, flexDirection: 'row' }}
              style={{ marginTop: 2 }}
            >
              {MAIN_TABS.map(tab => {
                const active = mainTab === tab.key;
                return (
                  <TouchableOpacity
                    key={tab.key}
                    onPress={() => setMainTab(tab.key as any)}
                    activeOpacity={0.8}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 6,
                      paddingHorizontal: 14, paddingVertical: 9,
                      borderRadius: 999,
                      backgroundColor: active ? '#6A2C90' : '#F1F3F9',
                      borderWidth: 1,
                      borderColor: active ? '#6A2C90' : '#F1F3F9',
                    }}
                  >
                    <Ionicons name={tab.icon as any} size={13} color={active ? '#fff' : VBRAND.ink600} />
                    <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : VBRAND.ink600, letterSpacing: 0.1 }}>
                      {tab.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          {/* ── Status filter sub-tabs (always visible when on list/tickets tab) ── */}
          {(!isAdmin || mainTab === 'list') && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8, flexDirection: 'row', alignItems: 'center' }}
              style={{ marginTop: 2 }}
            >
              {visibleTabs.map(g => (
                <FilterChip
                  key={g.key}
                  label={g.label}
                  active={filterStatus === g.key}
                  count={counts[g.key] || undefined}
                  onPress={() => setFilterStatus(g.key)}
                />
              ))}
            </ScrollView>
          )}
        </View>

        {/* ── Content area fills remaining space ───────────────────────── */}
        <View style={{ flex: 1 }}>

        {/* ── Pending Admin Approval Banner (list tab only) ──────────── */}
        {(!isAdmin || mainTab === 'list') && tickets.filter(t => t.status === 'pending_admin_approval').length > 0 && (
          <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.sm, gap: 8 }}>
            <Text style={{ fontSize: fontSize.xs, fontWeight: '800', color: '#BE185D', letterSpacing: 0.5 }}>
              ⏳ AWAITING YOUR APPROVAL
            </Text>
            {tickets.filter(t => t.status === 'pending_admin_approval').map(t => (
              <TouchableOpacity
                key={t.id}
                onPress={() => {
                  setApprovalTicket(t);
                  setShowRejectInput(false);
                  setRejectReason('');
                  setShowApprovalModal(true);
                }}
                style={{
                  backgroundColor: '#fff', borderRadius: 16,
                  padding: 14, borderWidth: 1, borderColor: '#FBCFE8',
                  flexDirection: 'row', alignItems: 'center', gap: 12,
                  shadowColor: '#BE185D', shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
                }}
              >
                <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: '#FCE7F3', alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="eye-outline" size={20} color="#BE185D" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: '#831843', letterSpacing: -0.1 }}>
                    {t.ticket_number} · {t.issue_type || 'Maintenance'}
                  </Text>
                  <Text style={{ fontSize: 12, color: '#9D174D', marginTop: 2, fontWeight: '500' }}>
                    Work completed — tap to approve or reject
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color="#BE185D" />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* ── Tenant Blocked Banner (list tab only) ─────────────────── */}
        {(!isAdmin || mainTab === 'list') && tenantBlocked && (
          <View style={{
            marginHorizontal: 18, marginTop: 8,
            backgroundColor: '#fff', borderRadius: 16,
            padding: 14, borderWidth: 1, borderColor: '#FDE68A',
            shadowColor: '#D97706', shadowOpacity: 0.1, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: '#FEF3C7', alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="warning" size={17} color="#D97706" />
              </View>
              <Text style={{ fontSize: 14, fontWeight: '800', color: '#92400E', letterSpacing: -0.1 }}>
                Action Required: Pending Approval
              </Text>
            </View>
            <Text style={{ fontSize: 12, color: '#78350F', marginBottom: 10, lineHeight: 18, fontWeight: '500' }}>
              You have {tenantPendingApproval.length} ticket{tenantPendingApproval.length > 1 ? 's' : ''} marked as completed that need your approval. Please approve or reject before creating new tickets.
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {tenantPendingApproval.map(t => (
                <TouchableOpacity
                  key={t.id}
                  onPress={() => navigation.navigate('TicketDetail', { ticketId: t.id })}
                  style={{
                    backgroundColor: '#FEF3C7', borderRadius: 999,
                    paddingHorizontal: 12, paddingVertical: 6,
                    borderWidth: 1, borderColor: '#FCD34D',
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: '800', color: '#92400E', letterSpacing: 0.3 }}>
                    {t.ticket_number}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* ── Ticket list (inside "Tickets/list" main tab) ─────────────── */}
        {(!isAdmin || mainTab === 'list') && (
          loading ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <View style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: '#F3ECF9', alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator size="large" color={VBRAND.purple} />
              </View>
              <Text style={{ fontSize: 13, color: VBRAND.ink500, fontWeight: '600' }}>Loading tickets…</Text>
            </View>
          ) : (
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ padding: 18, paddingBottom: 100, gap: 12 }}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[VBRAND.purple]} tintColor={VBRAND.purple} />}
            >
              {filtered.length === 0 ? (
                <View style={{ alignItems: 'center', paddingVertical: 70, gap: 6 }}>
                  <View style={{
                    width: 80, height: 80, borderRadius: 24,
                    backgroundColor: '#FFFFFF',
                    borderWidth: 1, borderColor: '#EEF1F6',
                    alignItems: 'center', justifyContent: 'center', marginBottom: 12,
                    shadowColor: VBRAND.purpleDeep, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
                  }}>
                    <Ionicons name="clipboard-outline" size={36} color={VBRAND.purple} />
                  </View>
                  <Text style={{ fontSize: 17, fontWeight: '800', color: VBRAND.ink900, letterSpacing: -0.2 }}>
                    No tickets found
                  </Text>
                  <Text style={{ fontSize: 13, color: VBRAND.ink500, fontWeight: '500' }}>
                    Try a different filter or search
                  </Text>
                </View>
              ) : (
                filtered.map(ticket => (
                  <TicketCard
                    key={ticket.id}
                    ticket={ticket}
                    onPress={() => navigation.navigate('TicketDetail', { ticketId: ticket.id })}
                  />
                ))
              )}
            </ScrollView>
          )
        )}

        {/* ── DASHBOARD TAB ─────────────────────────────────────────────── */}
        {isAdmin && mainTab === 'dashboard' && (() => {
          const open        = tickets.filter(t => !['completed','closed'].includes(t.status));
          const closed      = tickets.filter(t => ['completed','closed'].includes(t.status));
          const slaBreached = open.filter(t => t.sla_deadline && new Date(t.sla_deadline) < new Date());
          const needCost    = tickets.filter(t => t.status === 'waiting_for_cost_approval');
          const needAdmin   = tickets.filter(t => t.status === 'pending_admin_approval');
          const resolveRate = tickets.length > 0 ? Math.round((closed.length / tickets.length) * 100) : 0;

          // Top issue types
          const issueCounts: Record<string,number> = {};
          tickets.forEach(t => { const k = t.issue_type || 'Unknown'; issueCounts[k] = (issueCounts[k]||0)+1; });
          const topIssues = Object.entries(issueCounts).sort(([,a],[,b])=>b-a).slice(0,5);

          // Priority breakdown
          const priCount: Record<string,number> = {};
          open.forEach(t => { const k = t.priority||'medium'; priCount[k]=(priCount[k]||0)+1; });

          const STAT_COLORS: Record<string,string> = { open:'#2563EB', closed:'#22C55E', breached:'#EF4444', cost:'#F59E0B', admin:'#2563EB' };

          return (
            <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 100, gap: 14 }}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#6A2C90']} />}
            >
              {/* KPI cards row 1 */}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {[
                  { label: 'Open',        value: open.length,    color: STAT_COLORS.open    },
                  { label: 'Closed',      value: closed.length,  color: STAT_COLORS.closed  },
                  { label: 'SLA Breach',  value: slaBreached.length, color: STAT_COLORS.breached },
                ].map(s => (
                  <View key={s.label} style={{
                    flex: 1, backgroundColor: '#FFFFFF', borderRadius: 16,
                    padding: 14, alignItems: 'center',
                    borderWidth: 1, borderColor: '#EEF1F6',
                    shadowColor: s.color, shadowOpacity: 0.08, shadowRadius: 10, elevation: 2,
                  }}>
                    <Text style={{ fontSize: 26, fontWeight: '900', color: s.color }}>{s.value}</Text>
                    <Text style={{ fontSize: 10, fontWeight: '600', color: '#64748B', marginTop: 2 }}>{s.label}</Text>
                  </View>
                ))}
              </View>

              {/* KPI cards row 2 */}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {[
                  { label: 'Cost Approval', value: needCost.length,  color: STAT_COLORS.cost  },
                  { label: 'Admin Review',  value: needAdmin.length, color: STAT_COLORS.admin },
                  { label: 'Resolve Rate',  value: `${resolveRate}%`, color: STAT_COLORS.closed },
                ].map(s => (
                  <View key={s.label} style={{
                    flex: 1, backgroundColor: '#FFFFFF', borderRadius: 16,
                    padding: 14, alignItems: 'center',
                    borderWidth: 1, borderColor: '#EEF1F6',
                    shadowColor: s.color, shadowOpacity: 0.08, shadowRadius: 10, elevation: 2,
                  }}>
                    <Text style={{ fontSize: 22, fontWeight: '900', color: s.color }}>{s.value}</Text>
                    <Text style={{ fontSize: 10, fontWeight: '600', color: '#64748B', marginTop: 2 }}>{s.label}</Text>
                  </View>
                ))}
              </View>

              {/* Priority breakdown */}
              <View style={{ backgroundColor: '#FFFFFF', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#EEF1F6' }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: '#0F172A', marginBottom: 12 }}>Open by Priority</Text>
                {[{v:'critical',l:'Critical',c:'#7C2D12'},{v:'high',l:'High',c:'#DC2626'},{v:'medium',l:'Medium',c:'#D97706'},{v:'low',l:'Low',c:'#16A34A'}].map(p => {
                  const cnt = priCount[p.v]||0;
                  const pct = open.length > 0 ? (cnt/open.length)*100 : 0;
                  return (
                    <View key={p.v} style={{ marginBottom: 10 }}>
                      <View style={{ flexDirection:'row', justifyContent:'space-between', marginBottom:4 }}>
                        <Text style={{ fontSize:12, fontWeight:'700', color: p.c }}>{p.l}</Text>
                        <Text style={{ fontSize:12, fontWeight:'700', color: p.c }}>{cnt}</Text>
                      </View>
                      <View style={{ height:6, backgroundColor:'#EEF3FF', borderRadius:99, overflow:'hidden' }}>
                        <View style={{ height:6, width:`${pct}%` as any, backgroundColor: p.c, borderRadius:99 }} />
                      </View>
                    </View>
                  );
                })}
              </View>

              {/* Top issues */}
              <View style={{ backgroundColor:'#FFFFFF', borderRadius:16, padding:16, borderWidth:1, borderColor:'#EEF1F6' }}>
                <Text style={{ fontSize:13, fontWeight:'800', color:'#0F172A', marginBottom:12 }}>Top Issue Types</Text>
                {topIssues.length === 0
                  ? <Text style={{ fontSize:12, color:'#94A3B8' }}>No data yet</Text>
                  : topIssues.map(([name, cnt], i) => (
                    <View key={name} style={{ flexDirection:'row', alignItems:'center', gap:10, marginBottom:8 }}>
                      <View style={{ width:22, height:22, borderRadius:11, backgroundColor:'#EEF3FF', alignItems:'center', justifyContent:'center' }}>
                        <Text style={{ fontSize:10, fontWeight:'800', color:'#1D4ED8' }}>{i+1}</Text>
                      </View>
                      <Text style={{ flex:1, fontSize:12, fontWeight:'600', color:'#0F172A' }} numberOfLines={1}>{name}</Text>
                      <View style={{ backgroundColor:'#EEF3FF', borderRadius:99, paddingHorizontal:8, paddingVertical:3 }}>
                        <Text style={{ fontSize:11, fontWeight:'800', color:'#1D4ED8' }}>{cnt}</Text>
                      </View>
                    </View>
                  ))
                }
              </View>
            </ScrollView>
          );
        })()}

        {/* ── REGULAR MAINTENANCE TAB ───────────────────────────────────── */}
        {isAdmin && mainTab === 'regular' && (
          <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 100, gap: 12 }}
            refreshControl={<RefreshControl refreshing={regularLoading} onRefresh={loadRegularRules} colors={['#6A2C90']} />}
          >
            {/* Info banner */}
            <View style={{ backgroundColor:'#EEF3FF', borderRadius:16, padding:12, flexDirection:'row', alignItems:'flex-start', gap:8 }}>
              <Ionicons name="information-circle-outline" size={16} color="#1D4ED8" style={{ marginTop:1 }} />
              <Text style={{ flex:1, fontSize:12, color:'#64748B', lineHeight:18 }}>
                Regular maintenance rules schedule recurring tickets automatically. Configure them in the web app Settings → Maintenance Rules.
              </Text>
            </View>

            {regularLoading ? (
              <View style={{ alignItems:'center', paddingVertical:40 }}>
                <ActivityIndicator color="#6A2C90" />
              </View>
            ) : regularRules.length === 0 ? (
              <View style={{ alignItems:'center', paddingVertical:60 }}>
                <Ionicons name="refresh-circle-outline" size={48} color="#C4B5A0" />
                <Text style={{ fontSize:16, fontWeight:'700', color:'#0F172A', marginTop:14 }}>No Rules Configured</Text>
                <Text style={{ fontSize:13, color:'#94A3B8', marginTop:4, textAlign:'center' }}>
                  Add regular maintenance rules in the web app to auto-schedule recurring tickets.
                </Text>
              </View>
            ) : regularRules.map((r: any) => (
              <View key={r.id} style={{ backgroundColor:'#FFFFFF', borderRadius:16, padding:16, borderWidth:1, borderColor:'#EEF1F6' }}>
                <View style={{ flexDirection:'row', justifyContent:'space-between', alignItems:'flex-start' }}>
                  <View style={{ flex:1 }}>
                    <Text style={{ fontSize:14, fontWeight:'800', color:'#0F172A' }}>{r.name || r.title || '—'}</Text>
                    {r.frequency && <Text style={{ fontSize:12, color:'#94A3B8', marginTop:2 }}>{r.frequency}</Text>}
                    {r.issue_type && <Text style={{ fontSize:12, color:'#6A2C90', marginTop:2 }}>{r.issue_type}</Text>}
                  </View>
                  <View style={{ backgroundColor: r.is_active !== false ? '#DCFCE7' : '#F3F4F6', borderRadius:99, paddingHorizontal:10, paddingVertical:4 }}>
                    <Text style={{ fontSize:11, fontWeight:'700', color: r.is_active !== false ? '#16A34A' : '#64748B' }}>
                      {r.is_active !== false ? 'Active' : 'Paused'}
                    </Text>
                  </View>
                </View>
              </View>
            ))}
          </ScrollView>
        )}

        {/* ── TICKET CATEGORIES TAB ─────────────────────────────────────── */}
        {isAdmin && mainTab === 'categories' && (
          <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 100, gap: 12 }}>
            <View style={{ backgroundColor:'#EEF3FF', borderRadius:16, padding:12, flexDirection:'row', alignItems:'flex-start', gap:8, marginBottom:4 }}>
              <Ionicons name="pricetags-outline" size={16} color="#1D4ED8" style={{ marginTop:1 }} />
              <Text style={{ flex:1, fontSize:12, color:'#64748B', lineHeight:18 }}>
                Ticket categories (issue types) and their sub-types. Manage them in the web app Settings → Ticket Categories.
              </Text>
            </View>

            {!issueTypesLoaded ? (
              <View style={{ alignItems:'center', paddingVertical:40 }}>
                <ActivityIndicator color="#6A2C90" />
              </View>
            ) : issueTypes.length === 0 ? (
              <View style={{ alignItems:'center', paddingVertical:40, gap:8 }}>
                <Ionicons name="pricetags-outline" size={28} color="#B9A8CE" />
                <Text style={{ fontSize:13, color:'#7A6A8E', textAlign:'center' }}>No ticket categories configured.{'\n'}Add them in the web app Settings → Ticket Categories.</Text>
              </View>
            ) : issueTypes.map((it: any) => (
              <View key={it.id} style={{ backgroundColor:'#FFFFFF', borderRadius:16, padding:14, borderWidth:1, borderColor:'#EEF1F6' }}>
                <View style={{ flexDirection:'row', justifyContent:'space-between', alignItems:'center' }}>
                  <View style={{ flex:1 }}>
                    <Text style={{ fontSize:14, fontWeight:'800', color:'#0F172A' }}>{it.name}</Text>
                    {it.description && (
                      <Text style={{ fontSize:12, color:'#94A3B8', marginTop:2 }} numberOfLines={2}>{it.description}</Text>
                    )}
                  </View>
                  <View style={{ alignItems:'flex-end', gap:4 }}>
                    <View style={{
                      backgroundColor: it.priority === 'critical' ? '#FEE2E2' : it.priority === 'high' ? '#FEF3C7' : '#DCFCE7',
                      borderRadius:99, paddingHorizontal:8, paddingVertical:3,
                    }}>
                      <Text style={{ fontSize:10, fontWeight:'700', color: it.priority === 'critical' ? '#DC2626' : it.priority === 'high' ? '#D97706' : '#16A34A' }}>
                        {(it.priority||'medium').toUpperCase()}
                      </Text>
                    </View>
                    {it.sla_hours != null && (
                      <Text style={{ fontSize:10, color:'#6A2C90', fontWeight:'600' }}>SLA: {it.sla_hours}h</Text>
                    )}
                  </View>
                </View>
              </View>
            ))}
          </ScrollView>
        )}

        {/* ── AI INSIGHTS TAB ────────────────────────────────────────────── */}
        {isAdmin && mainTab === 'ai' && (
          <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 100, gap: 14 }}>
            {/* Header card */}
            <View style={{ backgroundColor:'#F3ECF9', borderRadius:16, padding:16, borderWidth:1, borderColor:'#EEF1F6', alignItems:'center', gap:8 }}>
              <Ionicons name="sparkles" size={32} color="#6A2C90" />
              <Text style={{ fontSize:16, fontWeight:'800', color:'#0F172A', textAlign:'center' }}>AI Ticket Insights</Text>
              <Text style={{ fontSize:12, color:'#64748B', textAlign:'center', lineHeight:18 }}>
                Analyse patterns across {tickets.length} tickets to find top issues, predict maintenance needs, and surface actionable insights.
              </Text>
              <TouchableOpacity
                onPress={async () => {
                  if (aiLoading) return;
                  setAiLoading(true);
                  setAiAnalysis(null);
                  try {
                    const issueDist: Record<string,number> = {};
                    const propDist: Record<string,number> = {};
                    tickets.forEach(t => {
                      const k = t.issue_type||'Unknown';  issueDist[k]=(issueDist[k]||0)+1;
                      const p = t.property_name||'Unknown'; propDist[p]=(propDist[p]||0)+1;
                    });
                    const open    = tickets.filter(t=>!['completed','closed'].includes(t.status)).length;
                    const breached= tickets.filter(t=>t.sla_deadline&&new Date(t.sla_deadline)<new Date()&&!['completed','closed'].includes(t.status)).length;
                    const summary = `Total: ${tickets.length}, Open: ${open}, SLA Breached: ${breached}.\nTop issues: ${Object.entries(issueDist).sort(([,a],[,b])=>b-a).slice(0,5).map(([k,v])=>`${k}(${v})`).join(', ')}.\nProperties: ${Object.entries(propDist).slice(0,3).map(([k,v])=>`${k}(${v})`).join(', ')}.`;
                    const question = `You are a property maintenance analyst. Analyse these ticket stats and give 3-5 concise actionable insights. Keep each point under 2 sentences. Stats: ${summary}`;
                    const { client, api } = await import('../lib/convexApi') as any;
                    const res = await client.action(
                      (api as any).aiAssistant.askAssistant,
                      { question, history: [] }
                    );
                    const text = (res?.answer || '').trim();
                    if (!text) {
                      setAiAnalysis('Could not load AI insights: the assistant returned an empty response. Please try again.');
                    } else {
                      setAiAnalysis(text);
                    }
                  } catch (e: any) {
                    setAiAnalysis('Could not load AI insights: ' + (e?.message || 'Unknown error'));
                  } finally {
                    setAiLoading(false);
                  }
                }}
                style={{
                  flexDirection:'row', alignItems:'center', gap:8,
                  backgroundColor:'#6A2C90', borderRadius:99, paddingHorizontal:20, paddingVertical:10,
                  opacity: aiLoading ? 0.6 : 1,
                }}
              >
                {aiLoading
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Ionicons name="flash-outline" size={16} color="#fff" />
                }
                <Text style={{ color:'#fff', fontWeight:'800', fontSize:13 }}>
                  {aiLoading ? 'Analysing…' : aiAnalysis ? 'Re-analyse' : 'Run AI Analysis'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Analysis result */}
            {aiAnalysis && (
              <View style={{ backgroundColor:'#FFFFFF', borderRadius:16, padding:16, borderWidth:1, borderColor:'#EEF1F6' }}>
                <View style={{ flexDirection:'row', alignItems:'center', gap:6, marginBottom:12 }}>
                  <Ionicons name="bulb-outline" size={16} color="#6A2C90" />
                  <Text style={{ fontSize:13, fontWeight:'800', color:'#0F172A' }}>Insights</Text>
                </View>
                {aiAnalysis.split('\n').filter(l=>l.trim()).map((line, i) => (
                  <View key={i} style={{ flexDirection:'row', alignItems:'flex-start', gap:8, marginBottom:10 }}>
                    <View style={{ width:6, height:6, borderRadius:3, backgroundColor:'#6A2C90', marginTop:6 }} />
                    <Text style={{ flex:1, fontSize:13, color:'#0F172A', lineHeight:20 }}>{line.replace(/^[\d•\-\*\.]+\s*/,'')}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Quick stats for context */}
            <View style={{ backgroundColor:'#FFFFFF', borderRadius:16, padding:14, borderWidth:1, borderColor:'#EEF1F6' }}>
              <Text style={{ fontSize:12, fontWeight:'800', color:'#94A3B8', letterSpacing:1, textTransform:'uppercase', marginBottom:10 }}>Data Summary</Text>
              {[
                { label:'Total tickets analysed', value: tickets.length },
                { label:'Open tickets',            value: tickets.filter(t=>!['completed','closed'].includes(t.status)).length },
                { label:'SLA breached',            value: tickets.filter(t=>t.sla_deadline&&new Date(t.sla_deadline)<new Date()&&!['completed','closed'].includes(t.status)).length },
                { label:'Unique issue types',      value: new Set(tickets.map(t=>t.issue_type)).size },
              ].map(s => (
                <View key={s.label} style={{ flexDirection:'row', justifyContent:'space-between', paddingVertical:6, borderBottomWidth:1, borderBottomColor:'rgba(0,0,0,0.06)' }}>
                  <Text style={{ fontSize:12, color:'#64748B' }}>{s.label}</Text>
                  <Text style={{ fontSize:12, fontWeight:'800', color:'#6A2C90' }}>{s.value}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
        )}

        </View>{/* end flex:1 content area */}

        {/* ── Raise Ticket Modal ────────────────────────────────────────── */}
        <AdminRaiseTicketModal
          visible={showRaiseModal}
          onClose={() => setShowRaiseModal(false)}
          onCreated={load}
          user={user}
        />

        {/* ── Admin Approval Modal ──────────────────────────────────────── */}
        <Modal visible={showApprovalModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowApprovalModal(false)}>
          <SafeAreaView style={{ flex: 1, backgroundColor: '#F8FAFC' }} edges={['top', 'bottom']}>
            <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>
              <TouchableOpacity onPress={() => setShowApprovalModal(false)} style={{ marginRight: 12 }}>
                <Ionicons name="close" size={24} color="#0F172A" />
              </TouchableOpacity>
              <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#0F172A', flex: 1 }}>Review Completion</Text>
            </View>
            <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: 16 }}>
              {approvalTicket && (
                <>
                  {/* Ticket summary */}
                  <View style={{ backgroundColor: '#FCE7F3', borderRadius: borderRadius.lg, padding: spacing.md, borderWidth: 1, borderColor: '#BE185D' }}>
                    <Text style={{ fontSize: fontSize.xs, fontWeight: '800', color: '#BE185D', marginBottom: 6 }}>TICKET SUMMARY</Text>
                    <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: '#0F172A' }}>{approvalTicket.ticket_number}</Text>
                    <Text style={{ fontSize: fontSize.sm, color: '#4B5563', marginTop: 4 }}>{approvalTicket.issue_type} {approvalTicket.issue_subtype ? `· ${approvalTicket.issue_subtype}` : ''}</Text>
                    {approvalTicket.description && (
                      <Text style={{ fontSize: fontSize.sm, color: '#94A3B8', marginTop: 4 }}>{approvalTicket.description}</Text>
                    )}
                    {approvalTicket.tenant_name && (
                      <Text style={{ fontSize: fontSize.xs, color: '#9D174D', marginTop: 6, fontWeight: '600' }}>
                        Tenant: {approvalTicket.tenant_name}
                      </Text>
                    )}
                  </View>

                  <Text style={{ fontSize: fontSize.sm, color: '#4B5563', textAlign: 'center' }}>
                    The technician has marked this ticket as complete. Please review and approve to close it, or reject to send it back.
                  </Text>

                  {/* Reject reason input */}
                  {showRejectInput && (
                    <TextInput
                      style={{
                        backgroundColor: '#fff', borderRadius: borderRadius.md,
                        padding: spacing.md, fontSize: fontSize.md, color: '#0F172A',
                        borderWidth: 1, borderColor: '#DC2626', minHeight: 80, textAlignVertical: 'top',
                      }}
                      placeholder="Reason for rejection..."
                      placeholderTextColor="#94A3B8"
                      value={rejectReason}
                      onChangeText={setRejectReason}
                      multiline
                    />
                  )}

                  {/* Approve button */}
                  {!showRejectInput && (
                    <TouchableOpacity
                      disabled={approvalSubmitting}
                      onPress={async () => {
                        setApprovalSubmitting(true);
                        try {
                          await adminApproveCompletion(approvalTicket.id, true, user?.userId || '');
                          setShowApprovalModal(false);
                          setApprovalTicket(null);
                          await load();
                          Alert.alert('✅ Approved', 'Ticket has been closed successfully.');
                        } catch (e: any) {
                          Alert.alert('Error', e?.message || 'Failed to approve');
                        } finally { setApprovalSubmitting(false); }
                      }}
                      style={{ backgroundColor: '#16A34A', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center', opacity: approvalSubmitting ? 0.6 : 1 }}
                    >
                      {approvalSubmitting
                        ? <ActivityIndicator color="#fff" />
                        : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>✅ Approve & Close Ticket</Text>
                      }
                    </TouchableOpacity>
                  )}

                  {/* Reject flow */}
                  {!showRejectInput ? (
                    <TouchableOpacity
                      onPress={() => setShowRejectInput(true)}
                      style={{ backgroundColor: '#FEE2E2', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#DC2626' }}
                    >
                      <Text style={{ color: '#DC2626', fontWeight: '800', fontSize: fontSize.md }}>❌ Reject — Send Back</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      disabled={approvalSubmitting || !rejectReason.trim()}
                      onPress={async () => {
                        setApprovalSubmitting(true);
                        try {
                          await adminApproveCompletion(approvalTicket.id, false, user?.userId || '', rejectReason);
                          setShowApprovalModal(false);
                          setApprovalTicket(null);
                          setShowRejectInput(false);
                          setRejectReason('');
                          await load();
                          Alert.alert('Sent Back', 'Ticket returned to in-progress for the technician.');
                        } catch (e: any) {
                          Alert.alert('Error', e?.message || 'Failed to reject');
                        } finally { setApprovalSubmitting(false); }
                      }}
                      style={{ backgroundColor: '#DC2626', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center', opacity: (!rejectReason.trim() || approvalSubmitting) ? 0.5 : 1 }}
                    >
                      {approvalSubmitting
                        ? <ActivityIndicator color="#fff" />
                        : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>Confirm Rejection</Text>
                      }
                    </TouchableOpacity>
                  )}

                  {/* Back to the approve/reject choice (only shown in reject mode) */}
                  {showRejectInput && (
                    <TouchableOpacity
                      disabled={approvalSubmitting}
                      onPress={() => { setShowRejectInput(false); setRejectReason(''); }}
                      style={{ paddingVertical: 12, alignItems: 'center' }}
                    >
                      <Text style={{ color: '#64748B', fontWeight: '700', fontSize: fontSize.sm }}>← Back</Text>
                    </TouchableOpacity>
                  )}
                </>
              )}
            </ScrollView>
          </SafeAreaView>
        </Modal>

      </SafeAreaView>
    </GlassBackground>
  );
}

// ─── Ticket Card ──────────────────────────────────────────────────────────────

function TicketCard({ ticket, onPress }: { ticket: Ticket; onPress: () => void }) {
  const { colors } = useTheme();
  const statusCfg   = STATUS_CONFIG[ticket.status]   || STATUS_CONFIG.open;
  const priorityCfg = PRIORITY_CONFIG[ticket.priority] || PRIORITY_CONFIG.medium;
  const isSlaBreached = ticket.sla_deadline && new Date(ticket.sla_deadline) < new Date()
    && !['closed', 'completed'].includes(ticket.status);
  const needsAction = ['waiting_for_cost_approval', 'pending_admin_approval'].includes(ticket.status);

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={[
        {
          backgroundColor: '#FFFFFF',
          borderRadius: 16,
          padding: 14,
          marginBottom: 0,
          borderWidth: 1,
          borderColor: '#EEF1F6',
          shadowColor: '#0F172A',
          shadowOpacity: 0.05,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
        },
        needsAction && {
          borderWidth: 1.5,
          borderColor: statusCfg.color,
          shadowColor: statusCfg.color,
          shadowOpacity: 0.12,
          shadowRadius: 10,
        },
      ]}
    >
      {/* Top row */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 5, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: 11, fontWeight: '800', color: VBRAND.purpleDeep, letterSpacing: 0.6 }}>
              {ticket.ticket_number}
            </Text>
            {isSlaBreached && (
              <View style={{ backgroundColor: '#FEE2E2', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 }}>
                <Text style={{ fontSize: 9, fontWeight: '800', color: '#DC2626', letterSpacing: 0.3 }}>SLA BREACHED</Text>
              </View>
            )}
            {needsAction && (
              <View style={{ backgroundColor: statusCfg.bg, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 }}>
                <Text style={{ fontSize: 9, fontWeight: '800', color: statusCfg.color, letterSpacing: 0.3 }}>ACTION NEEDED</Text>
              </View>
            )}
          </View>
          <Text style={{ fontSize: 15, fontWeight: '700', color: VBRAND.ink900, lineHeight: 21, letterSpacing: -0.1 }} numberOfLines={2}>
            {ticket.issue_type || 'Maintenance Issue'}
          </Text>
          {ticket.issue_subtype && (
            <Text style={{ fontSize: 12, color: VBRAND.ink500, marginTop: 3 }} numberOfLines={1}>
              {ticket.issue_subtype}
            </Text>
          )}
        </View>
        <View style={{ paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999, backgroundColor: statusCfg.bg, flexShrink: 0, maxWidth: 130 }}>
          <Text style={{ fontSize: 11, fontWeight: '800', color: statusCfg.color, textAlign: 'center', letterSpacing: 0.2 }} numberOfLines={1}>
            {statusCfg.label}
          </Text>
        </View>
      </View>

      {/* Info row */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 12, alignItems: 'center' }}>
        {ticket.tenant_name && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Ionicons name="person-outline" size={13} color={VBRAND.ink400} />
            <Text style={{ fontSize: 12, color: VBRAND.ink600, fontWeight: '500' }} numberOfLines={1}>
              {ticket.tenant_name}
            </Text>
            {ticket.source === 'admin' && (
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: VBRAND.purpleDeep, marginLeft: 2 }} />
            )}
          </View>
        )}
        {ticket.apartment_code && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Ionicons name="bed-outline" size={13} color={VBRAND.ink400} />
            <Text style={{ fontSize: 12, color: VBRAND.ink600, fontWeight: '500' }}>{ticket.apartment_code}</Text>
          </View>
        )}
        {ticket.status === 'waiting_for_cost_approval' && ticket.estimated_cost != null && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#FEE2E2', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
            <Ionicons name="cash-outline" size={12} color="#DC2626" />
            <Text style={{ fontSize: 11, color: '#DC2626', fontWeight: '700' }}>
              ₹{ticket.estimated_cost.toLocaleString('en-IN')} pending
            </Text>
          </View>
        )}
      </View>

      {/* Bottom row */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, borderTopWidth: 0.5, borderTopColor: '#EEF1F6' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ paddingHorizontal: 9, paddingVertical: 3.5, borderRadius: 999, backgroundColor: priorityCfg.bg }}>
            <Text style={{ fontSize: 10, fontWeight: '800', color: priorityCfg.color, letterSpacing: 0.3 }}>
              {priorityCfg.label}
            </Text>
          </View>
          {ticket.assigned_to_name && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="hammer-outline" size={12} color={VBRAND.ink400} />
              <Text style={{ fontSize: 11, color: VBRAND.ink500, fontWeight: '500' }}>{ticket.assigned_to_name}</Text>
            </View>
          )}
        </View>
        <Text style={{ fontSize: 11, color: VBRAND.ink400, fontWeight: '500' }}>
          {formatDate(ticket.created_at, '')}
        </Text>
      </View>
    </TouchableOpacity>
  );
}
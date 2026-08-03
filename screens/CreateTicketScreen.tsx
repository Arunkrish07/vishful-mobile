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

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low', color: '#16A34A', bg: '#DCFCE7' },
  { value: 'medium', label: 'Medium', color: '#D97706', bg: '#FEF3C7' },
  { value: 'high', label: 'High', color: '#DC2626', bg: '#FEE2E2' },
  { value: 'critical', label: 'Critical', color: '#7C2D12', bg: '#FEE2E2' },
];

export default function CreateTicketScreen({ navigation }: any) {
  const { colors } = useTheme();
  const { user, tenantLocation } = useAuth();
  const isTenant = user?.role === 'tenant';
  const costSubmitGuardRef = useRef(false);

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
      mediaTypes: MEDIA_TYPE_IMAGES, allowsMultipleSelection: true, quality: 0.7, base64: true,
    });
    if (!result.canceled) {
      const newPhotos = result.assets.map(a => ({ uri: a.uri, base64: a.base64 ?? undefined, mimeType: a.mimeType ?? 'image/jpeg' }));
      setSelectedPhotos(prev => [...prev, ...newPhotos].slice(0, 5));
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

      const ticketData: any = {
        issue_type_id: selectedIssueType.id,
        issue_type: selectedIssueType.name,
        issue_subtype: selectedSubType?.name || null,
        description: description.trim(),
        priority,
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
      } else {
        ticketData.tenant_id = null;
        ticketData.tenant_name = user?.userName || null;
        ticketData.property_id = selectedProperty?.id || null;
        ticketData.apartment_id = selectedApartment?.id || null;
        ticketData.bed_id = selectedBed?.id || null;
        ticketData.apartment_code = selectedBed?.bed_code || selectedApartment?.apartment_code || null;
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
          <ActivityIndicator size="large" color="#7B2FBE" />
        </View>
      </GlassBackground>
    );
  }

  if (pendingBlock) {
    return (
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }} edges={['top']}>
          <View style={[glass.header, { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg }]}>
            <TouchableOpacity onPress={() => navigation.goBack()} style={{ marginRight: 12 }}>
              <Ionicons name="arrow-back" size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: colors.text }}>New Ticket</Text>
          </View>
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl }}>
            <View style={{ backgroundColor: '#FEF3C7', borderRadius: borderRadius.xl, padding: spacing.xxl, alignItems: 'center' }}>
              <Ionicons name="warning-outline" size={48} color="#D97706" />
              <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text, marginTop: 16, textAlign: 'center' }}>Pending Approval Required</Text>
              <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 8, textAlign: 'center' }}>
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
          <View style={[glass.header, { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg }]}>
            <TouchableOpacity onPress={() => navigation.goBack()} style={{ marginRight: 12 }}>
              <Ionicons name="arrow-back" size={24} color={colors.text} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary, fontWeight: '600' }}>NEW</Text>
              <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: colors.text }}>Create Ticket</Text>
            </View>
          </View>

          <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 100 }}>

            {/* Tenant: auto-filled location card */}
            {isTenant && tenantLocation && (
              <View style={[glass.card, { backgroundColor: '#EDE9FE', borderColor: '#C4B5FD', borderWidth: 1, marginBottom: spacing.lg }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Ionicons name="location-outline" size={16} color="#7B2FBE" />
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#7B2FBE' }}>Your Location</Text>
                </View>
                <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.text }}>{tenantLocation.propertyName}</Text>
                <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary }}>
                  {tenantLocation.unitNumber} • Bed: {tenantLocation.bedCode}
                </Text>
              </View>
            )}

            {/* ══ TENANT FLOW: describe first → AI auto-selects ══ */}
            {isTenant && (
              <>
                {/* Step 1: Describe the problem */}
                <View style={[glass.card, { marginBottom: spacing.lg }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <View style={{ width: 24, height: 24, borderRadius: 99, backgroundColor: '#7B2FBE', alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>1</Text>
                    </View>
                    <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.text }}>What's the problem?</Text>
                  </View>
                  <TextInput
                    style={[glass.input, { padding: spacing.md, fontSize: fontSize.md, color: colors.text, minHeight: 100, textAlignVertical: 'top', marginBottom: 0 }]}
                    placeholder="Describe the issue — e.g. 'water leaking from tap', 'fan not working'..."
                    placeholderTextColor={colors.textTertiary}
                    value={description}
                    onChangeText={setDescription}
                    multiline
                    autoFocus
                  />

                  {/* AI scanning indicator */}
                  {description.trim().length >= 4 && classifying && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
                      <ActivityIndicator size="small" color="#7B2FBE" />
                      <Text style={{ fontSize: fontSize.xs, color: '#7B2FBE' }}>Identifying issue type…</Text>
                    </View>
                  )}
                </View>

                {/* Step 2: Issue Type — auto-selected silently, user can change */}
                {(selectedIssueType || classifierAction === 'auto_select' || classifierAction === 'manual') && (
                  <View style={[glass.card, { marginBottom: spacing.lg }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <View style={{ width: 24, height: 24, borderRadius: 99, backgroundColor: '#7B2FBE', alignItems: 'center', justifyContent: 'center' }}>
                        <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>2</Text>
                      </View>
                      <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.text }}>Issue Type</Text>
                      {selectedIssueType && (
                        <View style={{ backgroundColor: 'rgba(123,47,190,0.1)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                          <Text style={{ fontSize: 10, color: '#7B2FBE', fontWeight: '700' }}>AUTO-DETECTED</Text>
                        </View>
                      )}
                    </View>

                    {selectedIssueType ? (
                      /* Auto-selected result — tap X to change */
                      <View style={{ backgroundColor: 'rgba(123,47,190,0.08)', borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <Ionicons name="sparkles" size={18} color="#7B2FBE" />
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: '#7B2FBE' }}>{selectedIssueType.name}</Text>
                          {selectedIssueType.sla_hours && (
                            <Text style={{ fontSize: 11, color: '#9B8BAE', marginTop: 2 }}>SLA: {selectedIssueType.sla_hours}h</Text>
                          )}
                        </View>
                        <TouchableOpacity
                          onPress={() => { setSelectedIssueType(null); setSelectedSubType(null); setSubTypes([]); setClassifierOverridden(true); setClassifierAction('idle'); lastClassifiedDescRef.current = ''; }}
                          style={{ padding: 6 }}>
                          <Ionicons name="close-circle" size={20} color="#9B8BAE" />
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
                  <View style={[glass.card, { marginBottom: spacing.lg }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <View style={{ width: 24, height: 24, borderRadius: 99, backgroundColor: '#7B2FBE', alignItems: 'center', justifyContent: 'center' }}>
                        <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>3</Text>
                      </View>
                      <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.text }}>Issue Details</Text>
                      {selectedSubType && (
                        <View style={{ backgroundColor: 'rgba(123,47,190,0.1)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                          <Text style={{ fontSize: 10, color: '#7B2FBE', fontWeight: '700' }}>AUTO-DETECTED</Text>
                        </View>
                      )}
                    </View>
                    {loadingSubTypes ? (
                      <LoadingRow colors={colors} label="Identifying issue details…" />
                    ) : subTypes.length === 0 ? (
                      <Text style={{ fontSize: fontSize.sm, color: colors.textTertiary }}>No sub-categories for this issue type.</Text>
                    ) : selectedSubType ? (
                      <View style={{ backgroundColor: 'rgba(123,47,190,0.08)', borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <Ionicons name="sparkles" size={16} color="#7B2FBE" />
                        <Text style={{ flex: 1, fontSize: fontSize.sm, fontWeight: '700', color: '#7B2FBE' }}>{selectedSubType.name}</Text>
                        <TouchableOpacity onPress={() => setSelectedSubType(null)} style={{ padding: 4 }}>
                          <Ionicons name="close-circle" size={18} color="#9B8BAE" />
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

                {/* Step 4: Priority (compact) */}
                {selectedIssueType && (
                  <View style={[glass.card, { marginBottom: spacing.lg }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <View style={{ width: 24, height: 24, borderRadius: 99, backgroundColor: '#7B2FBE', alignItems: 'center', justifyContent: 'center' }}>
                        <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>4</Text>
                      </View>
                      <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.text }}>Priority</Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {PRIORITY_OPTIONS.map(p => (
                        <TouchableOpacity key={p.value} onPress={() => setPriority(p.value)}
                          style={{ flex: 1, paddingVertical: 8, borderRadius: borderRadius.md, alignItems: 'center',
                            backgroundColor: priority === p.value ? p.color : colors.surface,
                            borderWidth: 1, borderColor: priority === p.value ? p.color : colors.border }}>
                          <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: priority === p.value ? '#fff' : p.color }}>{p.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
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
                      />
                    ) : (
                      <View style={[glass.input, { paddingHorizontal: spacing.md, paddingVertical: 14, marginBottom: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
                        <Ionicons name="information-circle-outline" size={16} color={colors.textTertiary} />
                        <Text style={{ fontSize: fontSize.sm, color: colors.textTertiary }}>No apartments found</Text>
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
                      />
                    ) : (
                      <View style={[glass.input, { paddingHorizontal: spacing.md, paddingVertical: 14, marginBottom: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
                        <Ionicons name="information-circle-outline" size={16} color={colors.textTertiary} />
                        <Text style={{ fontSize: fontSize.sm, color: colors.textTertiary }}>No beds found</Text>
                      </View>
                    )}
                  </>
                )}

                {/* Step 4 onwards — only shown after Bed is selected */}
                {selectedBed && (
                  <>
                    {/* Description — AI fires after typing, auto-selects Issue Type + Details */}
                    <SectionLabel>Description *</SectionLabel>
                    <TextInput
                      style={[glass.input, { padding: spacing.md, fontSize: fontSize.md, color: colors.text, minHeight: 100, textAlignVertical: 'top', marginBottom: 0 }]}
                      placeholder="Describe the issue — e.g. 'water leaking from tap', 'AC not cooling'..."
                      placeholderTextColor={colors.textTertiary}
                      value={description}
                      onChangeText={txt => { setDescription(txt); setClassifierOverridden(false); lastClassifiedDescRef.current = ''; }}
                      multiline
                      autoFocus
                    />
                    {description.trim().length >= 4 && classifying && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, marginBottom: spacing.lg }}>
                        <ActivityIndicator size="small" color="#7B2FBE" />
                        <Text style={{ fontSize: fontSize.xs, color: '#7B2FBE' }}>Analyzing issue description…</Text>
                      </View>
                    )}
                    {!(description.trim().length >= 4 && classifying) && <View style={{ marginBottom: spacing.lg }} />}

                    {/* Issue Type — auto-selected by AI; tap X to pick manually */}
                    {(selectedIssueType || classifierAction === 'auto_select') && (
                      <>
                        <SectionLabel>Issue Type *</SectionLabel>
                        {selectedIssueType ? (
                          <View style={{ backgroundColor: 'rgba(123,47,190,0.08)', borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: spacing.lg }}>
                            <Ionicons name="sparkles" size={18} color="#7B2FBE" />
                            <View style={{ flex: 1 }}>
                              <Text style={{ fontSize: 10, fontWeight: '700', color: '#7B2FBE', letterSpacing: 0.5 }}>AUTO-DETECTED</Text>
                              <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: '#7B2FBE' }}>{selectedIssueType.name}</Text>
                            </View>
                            <TouchableOpacity
                              onPress={() => { setSelectedIssueType(null); setSelectedSubType(null); setSubTypes([]); setClassifierOverridden(true); setClassifierAction('idle'); lastClassifiedDescRef.current = ''; }}
                              style={{ padding: 6 }}>
                              <Ionicons name="close-circle" size={20} color="#9B8BAE" />
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
                            <View style={{ backgroundColor: 'rgba(123,47,190,0.08)', borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: spacing.lg }}>
                              <Ionicons name="sparkles" size={16} color="#7B2FBE" />
                              <View style={{ flex: 1 }}>
                                <Text style={{ fontSize: 10, fontWeight: '700', color: '#7B2FBE', letterSpacing: 0.5 }}>AUTO-DETECTED</Text>
                                <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#7B2FBE' }}>{selectedSubType.name}</Text>
                              </View>
                              <TouchableOpacity onPress={() => setSelectedSubType(null)} style={{ padding: 4 }}>
                                <Ionicons name="close-circle" size={18} color="#9B8BAE" />
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
                          <View style={[glass.input, { paddingHorizontal: spacing.md, paddingVertical: 14, marginBottom: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
                            <Ionicons name="information-circle-outline" size={16} color={colors.textTertiary} />
                            <Text style={{ fontSize: fontSize.sm, color: colors.textTertiary }}>No sub-categories for this type</Text>
                          </View>
                        )}
                      </>
                    )}

                    {/* Priority */}
                    <SectionLabel>Priority</SectionLabel>
                    <View style={{ flexDirection: 'row', gap: 8, marginBottom: spacing.lg }}>
                      {PRIORITY_OPTIONS.map(p => (
                        <TouchableOpacity key={p.value} onPress={() => setPriority(p.value)}
                          style={{ flex: 1, paddingVertical: 8, borderRadius: borderRadius.md, alignItems: 'center',
                            backgroundColor: priority === p.value ? p.color : colors.surface,
                            borderWidth: 1, borderColor: priority === p.value ? p.color : colors.border }}>
                          <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: priority === p.value ? '#fff' : p.color }}>{p.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </>
                )}
              </>
            )}

            {/* ── SHARED: Photo Upload ─────────────────────────────────────── */}
            <SectionLabel>Photos (Optional, max 5)</SectionLabel>
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
              {selectedPhotos.length < 5 && (
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity
                    onPress={takePhoto}
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: borderRadius.md, borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#7B2FBE', backgroundColor: '#F5F3FF' }}
                  >
                    <Ionicons name="camera-outline" size={18} color="#7B2FBE" />
                    <Text style={{ fontSize: fontSize.sm, fontWeight: '600', color: '#7B2FBE' }}>Camera</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={pickPhotos}
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: borderRadius.md, borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#7B2FBE', backgroundColor: '#F5F3FF' }}
                  >
                    <Ionicons name="image-outline" size={18} color="#7B2FBE" />
                    <Text style={{ fontSize: fontSize.sm, fontWeight: '600', color: '#7B2FBE' }}>Gallery</Text>
                  </TouchableOpacity>
                </View>
              )}
              {selectedPhotos.length > 0 && (
                <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary, marginTop: 6, textAlign: 'center' }}>
                  {selectedPhotos.length}/5 photo{selectedPhotos.length > 1 ? 's' : ''} selected
                </Text>
              )}
            </View>

            {/* SLA info */}
            {selectedIssueType && (
              <View style={{ backgroundColor: '#EDE9FE', borderRadius: borderRadius.md, padding: spacing.md, marginBottom: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="timer-outline" size={16} color="#7B2FBE" />
                <Text style={{ fontSize: fontSize.sm, color: '#7B2FBE', fontWeight: '600' }}>
                  SLA: {selectedIssueType.sla_hours}h from creation
                </Text>
              </View>
            )}

            {/* Submit */}
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={submitting}
              style={{ backgroundColor: '#7B2FBE', borderRadius: borderRadius.lg, paddingVertical: 16, alignItems: 'center', opacity: submitting ? 0.6 : 1 }}
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
  const { colors } = useTheme();
  return (
    <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary, marginBottom: 8 }}>
      {children}
    </Text>
  );
}

function LoadingRow({ colors, label }: { colors: any; label: string }) {
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 10,
      paddingHorizontal: spacing.md, paddingVertical: 14,
      borderRadius: borderRadius.md, borderWidth: 1,
      borderColor: colors.border, backgroundColor: colors.surface,
      marginBottom: spacing.lg,
    }}>
      <ActivityIndicator size="small" color="#7B2FBE" />
      <Text style={{ fontSize: fontSize.sm, color: colors.textTertiary }}>{label}</Text>
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
          borderRadius: borderRadius.md, borderWidth: 1,
          borderColor: value ? '#7B2FBE' : colors.border,
          backgroundColor: value ? '#F5F3FF' : colors.surface,
          marginBottom: spacing.lg, gap: 10,
        }}
      >
        {icon && <Ionicons name={icon as any} size={18} color={value ? '#7B2FBE' : colors.textTertiary} />}
        <Text style={{ flex: 1, fontSize: fontSize.sm, fontWeight: value ? '700' : '400', color: value ? '#7B2FBE' : colors.textTertiary }}>
          {value || placeholder}
        </Text>
        <Ionicons name="chevron-down" size={16} color={value ? '#7B2FBE' : colors.textTertiary} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', paddingHorizontal: 24 }}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        >
          <TouchableOpacity activeOpacity={1}>
            <View style={{
              backgroundColor: colors.surface ?? '#fff',
              borderRadius: borderRadius.xl, maxHeight: 380,
              overflow: 'hidden', shadowColor: '#000',
              shadowOpacity: 0.18, shadowRadius: 16, elevation: 10,
            }}>
              <View style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
                borderBottomWidth: 1, borderBottomColor: colors.border,
              }}>
                <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: colors.text }}>{placeholder}</Text>
                <TouchableOpacity onPress={() => setOpen(false)}>
                  <Ionicons name="close-circle" size={22} color={colors.textTertiary} />
                </TouchableOpacity>
              </View>

              <FlatList
                data={items}
                keyExtractor={(item) => String(item.id ?? item[labelKey])}
                renderItem={({ item }) => {
                  const label = getLabel(item);
                  const isSelected = allowDeselect ? selectedId === item.id : value === label;
                  return (
                    <TouchableOpacity
                      onPress={() => { onSelect(item); setOpen(false); }}
                      style={{
                        flexDirection: 'row', alignItems: 'center',
                        paddingHorizontal: spacing.lg, paddingVertical: 14,
                        borderBottomWidth: 1, borderBottomColor: colors.border,
                        backgroundColor: isSelected ? '#EDE9FE' : 'transparent',
                      }}
                    >
                      <Text style={{ flex: 1, fontSize: fontSize.sm, fontWeight: isSelected ? '700' : '500', color: isSelected ? '#7B2FBE' : colors.text }}>
                        {label}
                      </Text>
                      {isSelected && <Ionicons name="checkmark-circle" size={18} color="#7B2FBE" />}
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
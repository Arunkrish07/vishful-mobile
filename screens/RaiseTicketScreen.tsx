import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Animated, Alert, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAudioRecorder, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import { useAction } from 'convex/react';
import { api } from '../convex/_generated/api';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
// SDK 54: readAsStringAsync/EncodingType moved to the /legacy entry (removed from the default export).
import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { GlassBackground } from '../components/shared';
import { CONVEX_SITE_URL } from '../lib/config';

// Voice transcription runs server-side via POST /api/transcribe (no client key).
const TRANSCRIBE_URL = `${CONVEX_SITE_URL}/api/transcribe`;

// ── Mock Tenant Fallback ───────────────────────────────────────────────────
const MOCK_TENANT = {
  id: 'mock-tenant-uuid',
  name: 'Tenant',
  phone: '',
  property_id: null as string | null,
  apartment_id: null as string | null,
  bed_id: null as string | null,
  organization_id: null as string | null,
};

// ── Voice Classification ───────────────────────────────────────────────────
// Maps spoken keywords → issue_type NAME (must match issue_types.name in DB)
// Also extracts a clean description from the transcript itself.

interface VoiceClassification {
  keywords: string[];       // words to fuzzy-match against DB issue_types.name
  priority: 'urgent' | 'high' | 'medium' | 'low';
  emoji: string;
  title: string;
  description: string;      // actual spoken words, cleaned up
}

function classifyTranscript(text: string): VoiceClassification {
  const t = text.toLowerCase();
  const desc = text.charAt(0).toUpperCase() + text.slice(1);

  // ── Urgent
  if (/shock|spark|smoke|fire|burn/.test(t))
    return { keywords: ['electric', 'power', 'wiring'], priority: 'urgent', emoji: '⚡', title: 'Electrical Emergency', description: desc };

  if (/flood|overflow|burst pipe|no water/.test(t))
    return { keywords: ['plumb', 'water', 'pipe'], priority: 'urgent', emoji: '🚱', title: 'Water Emergency', description: desc };

  // ── Cleaning
  if (/clean|dirty|dust|sweep|mop|trash|garbage|waste|bathroom|kitchen|toilet/.test(t))
    return { keywords: ['clean', 'hygiene', 'housekeep'], priority: 'high', emoji: '🧹', title: 'Cleaning Required', description: desc };

  // ── Electrical
  if (/light|bulb|tube|electricity|socket|plug|switch|wiring|power cut|power outage/.test(t))
    return { keywords: ['electric', 'power', 'light', 'wiring'], priority: 'high', emoji: '💡', title: 'Electrical Issue', description: desc };

  // ── HVAC
  if (/\bac\b|air condition|cooling|hvac|fan|ventilat|heater|geyser/.test(t))
    return { keywords: ['ac', 'air', 'cool', 'hvac', 'fan', 'heat', 'geyser'], priority: 'high', emoji: '❄️', title: 'AC / Cooling Issue', description: desc };

  // ── Appliance
  if (/fridge|refrigerator|washing machine|microwave|oven|stove|gas|chimney/.test(t))
    return { keywords: ['appliance', 'machine', 'equipment', 'device'], priority: 'medium', emoji: '🔌', title: 'Appliance Issue', description: desc };

  // ── Plumbing
  if (/water|tap|pipe|leak|drain|clog|block|sewage|sink/.test(t))
    return { keywords: ['plumb', 'water', 'pipe', 'drain', 'sanit'], priority: 'high', emoji: '🔧', title: 'Plumbing Issue', description: desc };

  // ── Structural / Civil
  if (/wall|ceiling|floor|crack|door|window|lock|paint|damp|mold|seepage/.test(t))
    return { keywords: ['civil', 'struct', 'carpent', 'mason', 'paint', 'repair'], priority: 'medium', emoji: '🏗️', title: 'Structural / Civil Issue', description: desc };

  // ── Pest
  if (/pest|cockroach|rat|mouse|mosquito|insect|bug|ant/.test(t))
    return { keywords: ['pest', 'insect', 'rodent', 'fumig'], priority: 'high', emoji: '🪲', title: 'Pest Issue', description: desc };

  // ── Fallback
  return { keywords: ['general', 'maintenance', 'misc'], priority: 'medium', emoji: '📋', title: 'General Complaint', description: desc };
}

// ── Fuzzy match helper ─────────────────────────────────────────────────────
function findIssueTypeId(keywords: string[], types: { id: string; name: string }[]): string | null {
  if (!types || types.length === 0) return null;
  for (const kw of keywords) {
    const match = types.find(t =>
      t.name.toLowerCase().includes(kw.toLowerCase()) ||
      kw.toLowerCase().includes(t.name.toLowerCase())
    );
    if (match) return match.id;
  }
  // Last resort: return first available type
  return types[0]?.id ?? null;
}

// ── Color Maps ─────────────────────────────────────────────────────────────
const PRIORITY_COLORS: Record<string, { bg: string; text: string }> = {
  urgent: { bg: '#FEE2E2', text: '#DC2626' },
  high:   { bg: '#FFEDD5', text: '#EA580C' },
  medium: { bg: '#FEF9C3', text: '#CA8A04' },
  low:    { bg: '#DCFCE7', text: '#16A34A' },
};

// ── Screen State ───────────────────────────────────────────────────────────
type ScreenState = 'idle' | 'recording' | 'transcribing' | 'done' | 'submitting' | 'success' | 'error';

// ══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ══════════════════════════════════════════════════════════════════════════════

export default function RaiseTicketScreen({ navigation, route }: any) {
  const autoStart = route?.params?.autoStart === true;
  const { user, tenantLocation } = useAuth();

  // ── Tenant profile from Supabase ─────────────────────────────────────────
  const [tenantProfile, setTenantProfile] = useState<any>(null);
  const [profileLoading, setProfileLoading] = useState(true);

  useEffect(() => {
    const loadProfile = async () => {
      try {
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (!authUser) { setProfileLoading(false); return; }

        // Try tenants table by user_id
        let { data } = await supabase
          .from('tenants')
          .select('id, full_name, phone, property_id, apartment_id, bed_id, organization_id, properties(name), apartments(apartment_number)')
          .eq('user_id', authUser.id)
          .maybeSingle();

        // Fallback: match by phone
        if (!data && authUser.phone) {
          const res = await supabase
            .from('tenants')
            .select('id, full_name, phone, property_id, apartment_id, bed_id, organization_id')
            .eq('phone', authUser.phone)
            .maybeSingle();
          data = res.data;
        }

        // Fallback: match by email
        if (!data && authUser.email) {
          const res = await supabase
            .from('tenants')
            .select('id, full_name, phone, property_id, apartment_id, bed_id, organization_id')
            .eq('email', authUser.email)
            .maybeSingle();
          data = res.data;
        }

        // If bed_id missing, try tenant_beds join
        if (data && !data.bed_id) {
          const { data: bedData } = await supabase
            .from('tenant_beds')
            .select('bed_id, apartment_id, property_id')
            .eq('tenant_id', data.id)
            .eq('status', 'active')
            .maybeSingle();
          if (bedData) {
            data.bed_id = bedData.bed_id;
            data.apartment_id = bedData.apartment_id;
            data.property_id = bedData.property_id;
          }
        }

        setTenantProfile(data ?? null);
      } catch (e) {
        console.error('[RaiseTicket] Profile load error:', e);
      } finally {
        setProfileLoading(false);
      }
    };
    loadProfile();
  }, []);

  // ── Merged tenant object ─────────────────────────────────────────────────
  const tenant = useMemo(() => ({
    id:              tenantProfile?.id              || tenantLocation?.tenantId  || user?.userId          || MOCK_TENANT.id,
    name:            tenantProfile?.full_name       || tenantLocation?.tenantName || user?.userName        || MOCK_TENANT.name,
    phone:           tenantProfile?.phone           || user?.phone               || MOCK_TENANT.phone,
    property_id:     tenantProfile?.property_id     || tenantLocation?.propertyId || MOCK_TENANT.property_id,
    apartment_id:    tenantProfile?.apartment_id    || tenantLocation?.apartmentId || MOCK_TENANT.apartment_id,
    bed_id:          tenantProfile?.bed_id          || tenantLocation?.bedId      || MOCK_TENANT.bed_id,
    organization_id: tenantProfile?.organization_id || MOCK_TENANT.organization_id,
    locationLabel:   tenantProfile?.apartments?.apartment_number
                       ? `Apt ${tenantProfile.apartments.apartment_number}`
                       : (tenantLocation?.bedCode || ''),
  }), [tenantProfile, user, tenantLocation]);

  // ── Screen state ─────────────────────────────────────────────────────────
  const [activeTab,        setActiveTab]        = useState<'voice' | 'manual'>('voice');
  const [screenState,      setScreenState]      = useState<ScreenState>('idle');
  const [transcript,       setTranscript]       = useState('');
  const [classification,   setClassification]   = useState<VoiceClassification | null>(null);
  const [errorMsg,         setErrorMsg]         = useState('');
  const [photo,            setPhoto]            = useState<string | null>(null);

  // ── Issue types from DB ──────────────────────────────────────────────────
  const [issueTypes,          setIssueTypes]          = useState<{ id: string; name: string }[]>([]);
  const [selectedIssueTypeId, setSelectedIssueTypeId] = useState<string | null>(null);

  useEffect(() => {
    const loadIssueTypes = async () => {
      try {
        const { data } = await supabase
          .from('issue_types')
          .select('id, name')
          .order('name');
        if (data) setIssueTypes(data);
      } catch (e) {
        console.error('[RaiseTicket] Failed to load issue types:', e);
      }
    };
    loadIssueTypes();
  }, []);

  // Auto-select issue type when classification or issueTypes change
  useEffect(() => {
    if (classification && issueTypes.length > 0) {
      const autoId = findIssueTypeId(classification.keywords, issueTypes);
      setSelectedIssueTypeId(autoId);
    }
  }, [classification, issueTypes]);

  const createTicket = useAction(api.tickets.createTicket);

  // ── Recording refs ───────────────────────────────────────────────────────
  const audioRecorder     = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const silenceTimer      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meteringInterval  = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Pulse animations ─────────────────────────────────────────────────────
  const pulseScale1   = useRef(new Animated.Value(1)).current;
  const pulseScale2   = useRef(new Animated.Value(1)).current;
  const pulseOpacity1 = useRef(new Animated.Value(0.6)).current;
  const pulseOpacity2 = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    if (screenState !== 'recording') return;
    const make = (scale: any, opacity: any, toScale: number, delay: number) =>
      Animated.loop(Animated.sequence([
        Animated.delay(delay),
        Animated.parallel([
          Animated.timing(scale,   { toValue: toScale, duration: 1400, useNativeDriver: false }),
          Animated.timing(opacity, { toValue: 0,       duration: 1400, useNativeDriver: false }),
        ]),
        Animated.parallel([
          Animated.timing(scale,   { toValue: 1,   duration: 0, useNativeDriver: false }),
          Animated.timing(opacity, { toValue: 0.6, duration: 0, useNativeDriver: false }),
        ]),
      ]));
    const p1 = make(pulseScale1, pulseOpacity1, 2,   0);
    const p2 = make(pulseScale2, pulseOpacity2, 1.7, 500);
    p1.start(); p2.start();
    return () => {
      p1.stop(); p2.stop();
      pulseScale1.setValue(1); pulseScale2.setValue(1);
      pulseOpacity1.setValue(0.6); pulseOpacity2.setValue(0.4);
    };
  }, [screenState]);

  // ── Timer helpers ────────────────────────────────────────────────────────
  const clearTimers = useCallback(() => {
    if (silenceTimer.current)     { clearTimeout(silenceTimer.current);   silenceTimer.current = null; }
    if (meteringInterval.current) { clearInterval(meteringInterval.current); meteringInterval.current = null; }
  }, []);

  useEffect(() => () => {
    clearTimers();
    if (audioRecorder.isRecording) audioRecorder.stop().catch(() => {});
  }, []);

  // ── Stop & transcribe ────────────────────────────────────────────────────
  const stopRecording = useCallback(async () => {
    clearTimers();
    try {
      setScreenState('transcribing');
      if (!audioRecorder.isRecording && !audioRecorder.uri) { setScreenState('idle'); return; }

      await audioRecorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
      const uri = audioRecorder.uri;

      if (!uri) {
        setErrorMsg('No audio recorded. Please try again.');
        setScreenState('error');
        return;
      }

      // ── Transcribe server-side (no client-side API key)
      const audioBase64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const resp = await fetch(TRANSCRIBE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64, mimeType: 'audio/m4a' }),
      });

      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e?.error || `Transcription error (${resp.status})`);
      }

      const data = await resp.json();
      const text = (data.transcription || '').trim();

      if (!text) {
        setErrorMsg('No speech detected. Please speak clearly and try again.');
        setScreenState('error');
        return;
      }

      setTranscript(text);
      setClassification(classifyTranscript(text));
      setScreenState('done');
    } catch (err: any) {
      console.error('[RaiseTicket] stopRecording error:', err);
      setErrorMsg(err?.message || 'Transcription failed. Check your API key.');
      setScreenState('error');
    }
  }, [clearTimers]);

  // ── Start recording ──────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    try {
      setTranscript('');
      setClassification(null);
      setErrorMsg('');
      setPhoto(null);
      setScreenState('recording');

      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        setErrorMsg('Microphone permission denied. Please allow in Settings.');
        setScreenState('error');
        return;
      }

      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();

      // ── Auto-stop after 2s of silence (metering < -40 dB)
      meteringInterval.current = setInterval(async () => {
        try {
          const status = audioRecorder.getStatus();
          if (!status.isRecording) return;
          const level = (status as any).metering ?? -160;
          if (level < -40) {
            if (!silenceTimer.current) {
              silenceTimer.current = setTimeout(() => { stopRecording(); }, 2000);
            }
          } else {
            if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
          }
        } catch (_) {}
      }, 200);

    } catch (err: any) {
      console.error('[RaiseTicket] startRecording error:', err);
      setErrorMsg(err?.message || 'Could not start microphone.');
      setScreenState('error');
    }
  }, [stopRecording]);

  // ── Auto-start recording when launched from Voice button ─────────────────
  const autoStartFired = useRef(false);
  useEffect(() => {
    if (autoStart && !profileLoading && !autoStartFired.current) {
      autoStartFired.current = true;
      // Small delay to let the screen fully render before requesting mic permission
      const t = setTimeout(() => startRecording(), 400);
      return () => clearTimeout(t);
    }
  }, [autoStart, profileLoading, startRecording]);

  const handleMicPress = useCallback(() => {
    if (screenState === 'recording') stopRecording();
    else if (screenState === 'idle' || screenState === 'error') startRecording();
  }, [screenState, startRecording, stopRecording]);

  // ── Reset ────────────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    clearTimers();
    if (audioRecorder.isRecording) audioRecorder.stop().catch(() => {});
    setTranscript('');
    setClassification(null);
    setErrorMsg('');
    setPhoto(null);
    setScreenState('idle');
  }, [clearTimers]);

  // ── Photo handlers ───────────────────────────────────────────────────────
  const compressImage = async (uri: string) => {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 1024 } }],
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG }
    );
    return result.uri;
  };

  const handleTakePhoto = useCallback(async () => {
    const { granted } = await ImagePicker.requestCameraPermissionsAsync();
    if (!granted) { Alert.alert('Permission Required', 'Camera access is needed.'); return; }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7, allowsEditing: true, aspect: [4, 3],
    });
    if (!result.canceled && result.assets[0]) {
      setPhoto(await compressImage(result.assets[0].uri));
    }
  }, []);

  const handlePickPhoto = useCallback(async () => {
    const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!granted) { Alert.alert('Permission Required', 'Gallery access is needed.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7, allowsEditing: true, aspect: [4, 3],
    });
    if (!result.canceled && result.assets[0]) {
      setPhoto(await compressImage(result.assets[0].uri));
    }
  }, []);


  // ── Submit ticket ────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!transcript || !classification) return;
    try {
      setScreenState('submitting');

      // ── Resolve auth UID ──
      let authUid: string | null = null;
      if (tenantProfile?.id) {
        authUid = tenantProfile.id;
      } else if (user?.userId && user.userId !== MOCK_TENANT.id) {
        authUid = user.userId;
      }

      console.log('[RaiseTicket] authUid:', authUid, '| org:', tenant.organization_id);

      // ── Use pre-selected issue type (from auto-match or user pick) ──
      const issueTypeId = selectedIssueTypeId;
      if (!issueTypeId) {
        throw new Error('Please select an issue type before submitting.');
      }

      const matchedTypeName = issueTypes.find((t: { id: string; name: string }) => t.id === issueTypeId)?.name || classification.title;

      // ── Upload photo first (storage may allow anon uploads) ──
      let photoUrls: string[] = [];
      if (photo) {
        try {
          const response = await fetch(photo);
          const blob = await response.blob();
          const fileName = `voice_ticket_${Date.now()}.jpg`;
          const { error: uploadErr } = await supabase.storage
            .from('ticket-photos')
            .upload(fileName, blob, { contentType: 'image/jpeg' });
          if (!uploadErr) {
            const { data: urlData } = supabase.storage
              .from('ticket-photos')
              .getPublicUrl(fileName);
            if (urlData?.publicUrl) photoUrls = [urlData.publicUrl];
          } else {
            console.warn('[RaiseTicket] Photo upload skipped:', uploadErr.message);
          }
        } catch (photoErr) {
          console.warn('[RaiseTicket] Photo upload failed:', photoErr);
        }
      }

      // ── Safe IDs ──
      const safeTenantId       = tenantProfile?.id             ?? null;
      const safePropertyId     = tenantProfile?.property_id    ?? tenantLocation?.propertyId  ?? null;
      const safeApartmentId    = tenantProfile?.apartment_id   ?? tenantLocation?.apartmentId ?? null;
      const safeBedId          = tenantProfile?.bed_id         ?? tenantLocation?.bedId       ?? null;

      // ── Create ticket via Convex (uses admin Supabase client — bypasses RLS) ──
      const result = await createTicket({
        data: {
          tenant_id:       safeTenantId,
          property_id:     safePropertyId,
          apartment_id:    safeApartmentId,
          bed_id:          safeBedId,
          issue_type_id:   issueTypeId,
          description:     classification.description,
          priority:        classification.priority,
          created_by:      authUid,
          tenant_name:     tenant.name  || null,
          tenant_phone:    tenant.phone || null,
          photo_urls:      photoUrls.length ? photoUrls : null,
          source:          'mobile_voice',
          diagnostic_data: {
            classified_title: classification.title,
            matched_issue_type: matchedTypeName,
            voice_transcription: transcript,
            keywords: classification.keywords,
          },
        },
      });

      console.log('[RaiseTicket] Ticket created:', result?.id || result?.ticket_number);
      setScreenState('success');
    } catch (err: any) {
      console.error('[RaiseTicket] Submit error:', err);
      setErrorMsg(err?.message || 'Failed to submit ticket. Please try again.');
      setScreenState('error');
    }
  }, [transcript, classification, tenant, tenantProfile, tenantLocation, photo, user, createTicket, selectedIssueTypeId, issueTypes]);

  // ── Render ───────────────────────────────────────────────────────────────
  const isRecording = screenState === 'recording';
  const isDone      = screenState === 'done' || screenState === 'submitting';

  if (profileLoading) {
    return (
      <GlassBackground>
        <SafeAreaView style={[styles.flex, { alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator size="large" color="#6366F1" />
          <Text style={{ marginTop: 12, color: '#6B7280' }}>Loading your profile…</Text>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  return (
    <GlassBackground>
      <SafeAreaView style={styles.flex} edges={['top']}>

        {/* ── Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#111827" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Raise a Complaint</Text>
            {tenant.locationLabel ? (
              <Text style={styles.headerLocation}>📍 {tenant.locationLabel}</Text>
            ) : null}
          </View>
        </View>

        {/* ── Tabs */}
        <View style={styles.tabRow}>
          {(['voice', 'manual'] as const).map(tab => (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => setActiveTab(tab)}
            >
              <Text style={[styles.tabLabel, activeTab === tab && styles.tabLabelActive]}>
                {tab === 'voice' ? '🎙️  Voice' : '✏️  Manual'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {activeTab === 'manual' ? (
            <View style={styles.placeholderCard}>
              <Ionicons name="create-outline" size={48} color="#9CA3AF" />
              <Text style={styles.placeholderTitle}>Manual Entry</Text>
              <Text style={styles.placeholderSubtext}>Prefer typing? Fill in the details yourself.</Text>
              <TouchableOpacity
                style={styles.manualEntryBtn}
                onPress={() => navigation.navigate('CreateTicket')}
                activeOpacity={0.8}
              >
                <Text style={styles.manualEntryBtnLabel}>Type it instead</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {/* ── IDLE / RECORDING */}
              {(screenState === 'idle' || isRecording) && (
                <View style={styles.micSection}>
                  <View style={styles.micWrapper}>
                    {isRecording && (
                      <>
                        <Animated.View style={[styles.pulseRing, { transform: [{ scale: pulseScale1 }], opacity: pulseOpacity1 }]} />
                        <Animated.View style={[styles.pulseRing, styles.pulseRingInner, { transform: [{ scale: pulseScale2 }], opacity: pulseOpacity2 }]} />
                      </>
                    )}
                    <TouchableOpacity
                      style={[styles.micBtn, isRecording && styles.micBtnRecording]}
                      onPress={handleMicPress}
                      activeOpacity={0.8}
                    >
                      <Ionicons name={isRecording ? 'stop' : 'mic'} size={40} color="#FFFFFF" />
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.micStatusText}>
                    {isRecording ? 'Listening… tap to stop' : 'Tap to start recording'}
                  </Text>

                  {isRecording && (
                    <>
                      <View style={styles.livePill}>
                        <View style={styles.liveDot} />
                        <Text style={styles.liveLabel}>RECORDING</Text>
                      </View>
                      <Text style={styles.autoStopHint}>Auto-stops after 2s of silence</Text>
                    </>
                  )}

                  {screenState === 'idle' && (
                    <Text style={styles.hintText}>
                      Describe your issue — e.g. "Kitchen and bathroom are not clean"
                    </Text>
                  )}
                </View>
              )}

              {/* ── TRANSCRIBING */}
              {screenState === 'transcribing' && (
                <View style={styles.centerSection}>
                  <ActivityIndicator size="large" color="#6366F1" />
                  <Text style={styles.processingTitle}>Transcribing your voice…</Text>
                  <Text style={styles.processingSubtext}>Analysing and classifying issue</Text>
                </View>
              )}

              {/* ── DONE / SUBMITTING */}
              {isDone && classification && (
                <>
                  {/* Transcript */}
                  <View style={styles.card}>
                    <Text style={styles.cardLabel}>YOUR COMPLAINT</Text>
                    <Text style={styles.transcriptText}>"{transcript}"</Text>
                  </View>

                  {/* Classification */}
                  <View style={styles.card}>
                    <Text style={styles.cardLabel}>CLASSIFIED AS</Text>
                    <View style={styles.classRow}>
                      <Text style={styles.classEmoji}>{classification.emoji}</Text>
                      <View style={styles.flex}>
                        <Text style={styles.classTitle}>{classification.title}</Text>
                        <Text style={styles.classDesc}>{classification.description}</Text>
                        <View style={styles.badgeRow}>
                          <View style={[styles.badge, { backgroundColor: PRIORITY_COLORS[classification.priority].bg }]}>
                            <Text style={[styles.badgeText, { color: PRIORITY_COLORS[classification.priority].text }]}>
                              {classification.priority.toUpperCase()}
                            </Text>
                          </View>
                          <View style={[styles.badge, { backgroundColor: '#6366F118' }]}>
                            <Text style={[styles.badgeText, { color: '#6366F1' }]}>
                              {issueTypes.find((t: { id: string; name: string }) => t.id === selectedIssueTypeId)?.name?.toUpperCase() || classification.title.toUpperCase()}
                            </Text>
                          </View>
                        </View>
                      </View>
                    </View>
                  </View>

                  {/* Issue type picker */}
                  {issueTypes.length > 0 && (
                    <View style={styles.card}>
                      <Text style={styles.cardLabel}>ISSUE TYPE (tap to change)</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <View style={styles.chipRow}>
                          {issueTypes.map((type: { id: string; name: string }) => (
                            <TouchableOpacity
                              key={type.id}
                              onPress={() => setSelectedIssueTypeId(type.id)}
                              style={[
                                styles.chip,
                                selectedIssueTypeId === type.id && styles.chipActive,
                              ]}
                            >
                              <Text style={selectedIssueTypeId === type.id ? styles.chipActiveText : styles.chipText}>
                                {type.name}
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      </ScrollView>
                    </View>
                  )}

                  {/* Tenant location confirmation */}
                  {tenant.locationLabel ? (
                    <View style={styles.locationCard}>
                      <Ionicons name="location" size={16} color="#6366F1" />
                      <Text style={styles.locationText}>
                        Ticket will be raised for: <Text style={{ fontWeight: '700' }}>{tenant.locationLabel}</Text>
                      </Text>
                    </View>
                  ) : null}

                  {/* Photo section */}
                  <View style={styles.card}>
                    <Text style={styles.cardLabel}>ATTACH PHOTO (optional)</Text>
                    {photo ? (
                      <View>
                        <Image source={{ uri: photo }} style={styles.photoPreview} resizeMode="cover" />
                        <TouchableOpacity onPress={() => setPhoto(null)} style={styles.removePhotoBtn}>
                          <Ionicons name="close-circle" size={16} color="#EF4444" />
                          <Text style={styles.removePhotoText}>Remove photo</Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <View style={styles.photoButtonRow}>
                        <TouchableOpacity style={styles.photoBtn} onPress={handleTakePhoto}>
                          <Ionicons name="camera" size={22} color="#6366F1" />
                          <Text style={styles.photoBtnText}>Camera</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.photoBtn} onPress={handlePickPhoto}>
                          <Ionicons name="image" size={22} color="#6366F1" />
                          <Text style={styles.photoBtnText}>Gallery</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>

                  {/* Action buttons */}
                  <View style={styles.actionRow}>
                    <TouchableOpacity
                      style={styles.redoBtn}
                      onPress={handleReset}
                      disabled={screenState === 'submitting'}
                    >
                      <Ionicons name="refresh" size={18} color="#6366F1" />
                      <Text style={styles.redoBtnLabel}>Redo</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.submitBtn, screenState === 'submitting' && { opacity: 0.7 }]}
                      onPress={handleSubmit}
                      disabled={screenState === 'submitting'}
                      activeOpacity={0.8}
                    >
                      {screenState === 'submitting' ? (
                        <ActivityIndicator color="#FFFFFF" size="small" />
                      ) : (
                        <>
                          <Ionicons name="send" size={18} color="#FFFFFF" />
                          <Text style={styles.submitBtnLabel}>Submit Ticket</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </View>
                </>
              )}

              {/* ── SUCCESS */}
              {screenState === 'success' && (
                <View style={[styles.card, styles.successCard]}>
                  <View style={styles.resultCenter}>
                    <Text style={styles.resultIcon}>✅</Text>
                    <Text style={styles.successTitle}>Ticket Raised!</Text>
                    <Text style={styles.successSubtext}>
                      Your complaint has been submitted successfully.
                    </Text>
                    {tenant.locationLabel ? (
                      <Text style={styles.successLocation}>📍 {tenant.locationLabel}</Text>
                    ) : null}
                    <TouchableOpacity style={[styles.submitBtn, { marginTop: 24 }]} onPress={handleReset}>
                      <Ionicons name="add-circle-outline" size={18} color="#FFFFFF" />
                      <Text style={styles.submitBtnLabel}>Raise Another</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* ── ERROR */}
              {screenState === 'error' && (
                <View style={[styles.card, styles.errorCard]}>
                  <View style={styles.resultCenter}>
                    <Text style={styles.resultIcon}>❌</Text>
                    <Text style={styles.errorTitle}>Something went wrong</Text>
                    <Text style={styles.errorSubtext}>{errorMsg}</Text>
                    <TouchableOpacity
                      style={[styles.redoBtn, { marginTop: 24, flex: 0, paddingHorizontal: 32 }]}
                      onPress={handleReset}
                    >
                      <Ionicons name="refresh" size={18} color="#6366F1" />
                      <Text style={styles.redoBtnLabel}>Try Again</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const INDIGO = '#6366F1';
const RED    = '#EF4444';

const styles = StyleSheet.create({
  flex: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: 'rgba(255,255,255,0.5)',
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(255,255,255,0.4)',
  },
  backBtn:        { marginRight: 12, padding: 4 },
  headerTitle:    { fontSize: 20, fontWeight: '800', color: '#111827' },
  headerLocation: { fontSize: 12, color: '#6366F1', marginTop: 1, fontWeight: '600' },

  tabRow: { flexDirection: 'row', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4, gap: 10 },
  tab: {
    flex: 1, paddingVertical: 12, borderRadius: 12,
    backgroundColor: '#FFFFFF', alignItems: 'center',
    borderWidth: 1.5, borderColor: '#E5E7EB',
  },
  tabActive:      { backgroundColor: INDIGO, borderColor: INDIGO },
  tabLabel:       { fontSize: 15, fontWeight: '700', color: '#6B7280' },
  tabLabelActive: { color: '#FFFFFF' },

  scrollContent: { padding: 20, paddingBottom: 40 },

  placeholderCard: {
    backgroundColor: '#FFFFFF', borderRadius: 14, padding: 48, alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
  placeholderTitle:   { fontSize: 18, fontWeight: '700', color: '#6B7280', marginTop: 14 },
  placeholderSubtext: { fontSize: 14, color: '#9CA3AF', marginTop: 4, textAlign: 'center' },
  manualEntryBtn: {
    marginTop: 20, paddingVertical: 14, paddingHorizontal: 28, borderRadius: 14,
    backgroundColor: INDIGO,
    shadowColor: INDIGO, shadowOpacity: 0.3, shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 }, elevation: 5,
  },
  manualEntryBtnLabel: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },

  micSection: { alignItems: 'center', paddingVertical: 48 },
  micWrapper:  { width: 180, height: 180, alignItems: 'center', justifyContent: 'center' },
  pulseRing: {
    position: 'absolute', width: 120, height: 120,
    borderRadius: 60, borderWidth: 3, borderColor: RED,
  },
  pulseRingInner: { borderColor: 'rgba(239,68,68,0.5)' },
  micBtn: {
    width: 100, height: 100, borderRadius: 50, backgroundColor: INDIGO,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: INDIGO, shadowOpacity: 0.4, shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 }, elevation: 8,
  },
  micBtnRecording: { backgroundColor: RED, shadowColor: RED },
  micStatusText:   { fontSize: 16, fontWeight: '600', color: '#4B5563', marginTop: 24 },
  livePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12,
    backgroundColor: '#FEE2E2', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
  },
  liveDot:      { width: 8, height: 8, borderRadius: 4, backgroundColor: RED },
  liveLabel:    { fontSize: 11, fontWeight: '800', color: '#DC2626', letterSpacing: 1.5 },
  autoStopHint: { fontSize: 12, color: '#9CA3AF', marginTop: 8 },
  hintText: {
    fontSize: 14, color: '#9CA3AF', marginTop: 24,
    textAlign: 'center', paddingHorizontal: 32, lineHeight: 20,
  },

  centerSection:    { alignItems: 'center', paddingVertical: 72 },
  processingTitle:  { fontSize: 18, fontWeight: '700', color: '#111827', marginTop: 16 },
  processingSubtext:{ fontSize: 14, color: '#6B7280', marginTop: 4 },

  card: {
    backgroundColor: '#FFFFFF', borderRadius: 16, padding: 20, marginBottom: 16,
    shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 }, elevation: 3,
  },
  cardLabel:      { fontSize: 11, fontWeight: '800', color: '#9CA3AF', letterSpacing: 1, marginBottom: 12 },
  transcriptText: { fontSize: 16, color: '#374151', fontStyle: 'italic', lineHeight: 24 },

  classRow:  { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  classEmoji:{ fontSize: 36, marginTop: 2 },
  classTitle:{ fontSize: 18, fontWeight: '800', color: '#111827' },
  classDesc: { fontSize: 14, color: '#6B7280', marginTop: 4, lineHeight: 20 },
  badgeRow:  { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  badge:     { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  badgeText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },

  locationCard: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#EEF2FF', borderRadius: 10, padding: 12, marginBottom: 16,
  },
  locationText: { fontSize: 13, color: '#4B5563' },

  photoButtonRow: { flexDirection: 'row', gap: 12 },
  photoBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 14, borderRadius: 12,
    borderWidth: 1.5, borderColor: INDIGO, backgroundColor: '#EEF2FF',
  },
  photoBtnText:   { fontSize: 14, fontWeight: '700', color: INDIGO },
  photoPreview:   { width: '100%', height: 180, borderRadius: 10, marginBottom: 10 },
  removePhotoBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  removePhotoText:{ fontSize: 13, color: '#EF4444', fontWeight: '600' },

  chipRow:       { flexDirection: 'row', gap: 8, paddingVertical: 4 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    borderWidth: 1.5, borderColor: '#E5E7EB', backgroundColor: '#F9FAFB',
  },
  chipActive:     { borderColor: INDIGO, backgroundColor: '#EEF2FF' },
  chipText:       { fontSize: 13, fontWeight: '600', color: '#6B7280' },
  chipActiveText: { fontSize: 13, fontWeight: '700', color: INDIGO },

  actionRow: { flexDirection: 'row', gap: 12, marginTop: 4 },
  redoBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 16, borderRadius: 14, backgroundColor: '#FFFFFF',
    borderWidth: 1.5, borderColor: INDIGO,
  },
  redoBtnLabel: { fontSize: 16, fontWeight: '700', color: INDIGO },
  submitBtn: {
    flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 16, borderRadius: 14, backgroundColor: INDIGO,
    shadowColor: INDIGO, shadowOpacity: 0.3, shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 }, elevation: 5,
  },
  submitBtnLabel: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },

  successCard:    { backgroundColor: '#F0FDF4', borderWidth: 1, borderColor: '#BBF7D0' },
  resultCenter:   { alignItems: 'center', paddingVertical: 24 },
  resultIcon:     { fontSize: 48, marginBottom: 12 },
  successTitle:   { fontSize: 22, fontWeight: '800', color: '#166534' },
  successSubtext: { fontSize: 15, color: '#15803D', marginTop: 6, textAlign: 'center' },
  successLocation:{ fontSize: 13, color: '#166534', marginTop: 8, fontWeight: '600' },

  errorCard:  { backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA' },
  errorTitle: { fontSize: 18, fontWeight: '700', color: '#991B1B' },
  errorSubtext: {
    fontSize: 14, color: '#DC2626', marginTop: 6,
    textAlign: 'center', paddingHorizontal: 16, lineHeight: 20,
  },
});
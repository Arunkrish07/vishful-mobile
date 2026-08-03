/**
 * TenantTicketsScreen.tsx
 *
 * Voice recording uses expo-av (Audio.Recording) — the correct React Native API.
 * MediaRecorder / getUserMedia are browser-only APIs and do NOT work on iOS/Android.
 *
 * Recording pipeline:
 *   expo-av Audio.Recording → m4a file URI → (manual review) → transcript
 *   → Convex /api/voice-ticket-direct → ticket created
 *
 * Client-side Groq transcription was removed (it required a hardcoded API key —
 * a security risk). The secure server transcription path lives in
 * services/mobileVoiceTicketService.ts. See stopRecording() for details.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  RefreshControl, ActivityIndicator, Modal, TextInput, Alert, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { useFocusEffect } from '@react-navigation/native';
import { GlassBackground } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/ThemeContext';
import { glass, spacing, borderRadius, fontSize } from '../lib/theme';
import { client, api } from '../lib/convexApi';
import {
  fetchTickets,
  fetchCostEstimates,
  tenantApproveCompletion,
  checkTenantPendingTickets,
  Ticket,
  CostEstimate,
  STATUS_CONFIG,
} from '../services/ticketService';

const BRAND       = '#7B2FBE';
const BRAND_LIGHT = 'rgba(123,47,190,0.1)';
const CONVEX_BASE = 'https://wonderful-kiwi-122.convex.site';
const TICKET_URL  = `${CONVEX_BASE}/api/voice-ticket-direct`;

type VoiceStep = 'idle' | 'recording' | 'processing' | 'review' | 'submitting' | 'success' | 'error';

export default function TenantTicketsScreen({ navigation }: any) {
  const { colors } = useTheme();
  const { user, tenantLocation } = useAuth();
  const [tickets, setTickets]       = useState<Ticket[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // ── Approval modal ────────────────────────────────────────────────────────
  const [approvalTicket,    setApprovalTicket]    = useState<Ticket | null>(null);
  const [approvalEstimates, setApprovalEstimates] = useState<CostEstimate[]>([]);
  const [approvalLoading,   setApprovalLoading]   = useState(false);
  const [estimatesLoading,  setEstimatesLoading]  = useState(false);
  const [showRejectInput,   setShowRejectInput]   = useState(false);
  const [rejectReason,      setRejectReason]      = useState('');

  const tenantId = tenantLocation?.tenantId;
  const userId   = user?.supabaseUserId || user?.userId || '';

  // ── Voice modal ───────────────────────────────────────────────────────────
  const [voiceOpen,   setVoiceOpen]   = useState(false);
  const [voiceStep,   setVoiceStep]   = useState<VoiceStep>('idle');
  const [voiceError,  setVoiceError]  = useState('');
  const [seconds,     setSeconds]     = useState(0);
  const [transcript,  setTranscript]  = useState('');
  const [issueTypes,  setIssueTypes]  = useState<any[]>([]);
  const [selTypeId,   setSelTypeId]   = useState('');
  const [selTypeName, setSelTypeName] = useState('');
  const [ticketNum,   setTicketNum]   = useState('');

  // expo-av recording refs
  const recordingRef     = useRef<Audio.Recording | null>(null);
  const silenceTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meteringIntRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef         = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Ticket list loader ────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!tenantId) { setLoading(false); return; }
    try {
      const data = await fetchTickets('tenant', undefined, tenantId);
      setTickets(data);
    } catch (e: any) {
      console.warn('[TenantTickets] load error:', e?.message);
    } finally { setLoading(false); setRefreshing(false); }
  }, [tenantId]);

  useEffect(() => { load(); }, [load]);
  // Reload tickets whenever this screen comes back into focus (e.g. after raising a ticket)
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  // ── Load issue types when voice modal opens ───────────────────────────────
  useEffect(() => {
    if (!voiceOpen) return;
    client.action(api.tickets.getIssueTypes, {})
      .then((t: any) => setIssueTypes(t || []))
      .catch(() => setIssueTypes([]));
  }, [voiceOpen]);

  // ── Recording timer ───────────────────────────────────────────────────────
  useEffect(() => {
    if (voiceStep !== 'recording') {
      clearInterval(timerRef.current!);
      setSeconds(0);
      return;
    }
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(timerRef.current!);
  }, [voiceStep]);

  // ── Clear timers helper ───────────────────────────────────────────────────
  const clearTimers = useCallback(() => {
    if (silenceTimerRef.current)  { clearTimeout(silenceTimerRef.current);  silenceTimerRef.current = null; }
    if (meteringIntRef.current)   { clearInterval(meteringIntRef.current);   meteringIntRef.current = null; }
    if (timerRef.current)         { clearInterval(timerRef.current);         timerRef.current = null; }
  }, []);

  // ── Stop recording → server transcription → review ────────────────────────
  // Client-side Groq transcription (and its hardcoded API key) was removed for
  // security. Audio is transcribed by the server via the deployed
  // POST /api/transcribe (returns text only — no ticket insert), so the tenant
  // can review the transcript and pick an issue type before submitting.
  // If transcription fails, we fall back to an empty transcript for manual entry.
  const stopRecording = useCallback(async () => {
    clearTimers();
    const rec = recordingRef.current;
    if (!rec) { setVoiceStep('idle'); return; }

    setVoiceStep('processing');
    setSelTypeId('');
    setSelTypeName('');
    try {
      await rec.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      const uri = rec.getURI();
      recordingRef.current = null;

      let text = '';
      if (uri) {
        try {
          const audioBase64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
          const resp = await fetch('https://wonderful-kiwi-122.convex.site/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64, mimeType: 'audio/m4a' }),
          });
          const data = await resp.json().catch(() => ({}));
          if (resp.ok && data?.transcription) text = String(data.transcription).trim();
        } catch (e) {
          console.warn('[VoiceModal] transcription failed, falling back to manual entry:', e);
        }
      }

      // Advance to the review step (pre-filled if transcription succeeded).
      setTranscript(text);
      setVoiceStep('review');
    } catch (err: any) {
      console.error('[VoiceModal] stopRecording error:', err);
      setVoiceError(err?.message || 'Recording failed. Please try again.');
      setVoiceStep('error');
    }
  }, [clearTimers]);

  // ── Start recording via expo-av ───────────────────────────────────────────
  const startRecording = useCallback(async () => {
    try {
      setTranscript('');
      setVoiceError('');
      setSelTypeId('');
      setSelTypeName('');

      // Request mic permission
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        Alert.alert(
          'Microphone Required',
          'Please allow microphone access in your device settings and try again.'
        );
        setVoiceStep('idle');
        return;
      }

      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

      const { recording } = await Audio.Recording.createAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });
      recordingRef.current = recording;
      setVoiceStep('recording');

      // Auto-stop after 2s of silence (metering < -40 dB) — max 60s
      meteringIntRef.current = setInterval(async () => {
        try {
          const status = await recording.getStatusAsync();
          if (!status.isRecording) return;
          const level = (status as any).metering ?? -160;
          if (level < -40) {
            if (!silenceTimerRef.current) {
              silenceTimerRef.current = setTimeout(() => stopRecording(), 2000);
            }
          } else {
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = null;
            }
          }
        } catch (_) {}
      }, 200);

      // Hard cap at 60 seconds
      silenceTimerRef.current = setTimeout(() => stopRecording(), 60000);

    } catch (err: any) {
      console.error('[VoiceModal] startRecording error:', err);
      setVoiceError(err?.message || 'Could not start microphone. Please try again.');
      setVoiceStep('error');
    }
  }, [stopRecording]);

  // ── Reset voice state ─────────────────────────────────────────────────────
  const resetVoice = useCallback(() => {
    clearTimers();
    if (recordingRef.current) {
      recordingRef.current.stopAndUnloadAsync().catch(() => {});
      recordingRef.current = null;
    }
    setVoiceStep('idle');
    setVoiceError('');
    setSeconds(0);
    setTranscript('');
    setSelTypeId('');
    setSelTypeName('');
    setTicketNum('');
  }, [clearTimers]);

  const closeVoice = useCallback(() => {
    resetVoice();
    setVoiceOpen(false);
  }, [resetVoice]);

  // ── Submit voice ticket ───────────────────────────────────────────────────
  const submitVoiceTicket = useCallback(async () => {
    if (!transcript.trim() || !selTypeId) return;
    setVoiceStep('submitting');
    try {
      // Same gate as the text raise flow: block a new ticket while one of the
      // tenant's tickets is still awaiting their approval.
      if (tenantId) {
        const { hasPending } = await checkTenantPendingTickets(tenantId);
        if (hasPending) {
          setVoiceError('You have a completed ticket awaiting your approval. Please review it before raising a new one.');
          setVoiceStep('error');
          return;
        }
      }
      const resp = await fetch(TICKET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcription:  transcript.trim(),
          source:         'mobile_voice',
          issueTypeId:    selTypeId                   || undefined,
          issueType:      selTypeName                 || undefined,
          tenantId:       tenantId                   || undefined,
          propertyId:     tenantLocation?.propertyId  || undefined,
          apartmentId:    tenantLocation?.apartmentId || undefined,
          bedId:          tenantLocation?.bedId       || undefined,
          tenantName:     user?.userName              || undefined,
          tenantPhone:    user?.phone                 || undefined,
          apartmentCode:  tenantLocation?.unitNumber  || undefined,
          createdBy:      userId                      || undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || `Server error ${resp.status}`);
      setTicketNum(data.ticketNumber || data.ticket?.ticket_number || '');
      setVoiceStep('success');
      await load();
    } catch (err: any) {
      setVoiceError(err?.message || 'Failed to create ticket. Please try again.');
      setVoiceStep('error');
    }
  }, [transcript, selTypeId, selTypeName, tenantId, tenantLocation, user, userId, load]);

  // ── Auto-start recording when modal opens ────────────────────────────────
  const autoStartRef = useRef(false);
  useEffect(() => {
    if (!voiceOpen) { autoStartRef.current = false; return; }
    if (!autoStartRef.current) {
      autoStartRef.current = true;
      // Small delay lets the modal slide-in animation complete
      setTimeout(() => startRecording(), 350);
    }
  }, [voiceOpen, startRecording]);

  // ── Approval modal helpers ────────────────────────────────────────────────
  const openApprovalModal = async (ticket: Ticket) => {
    setApprovalTicket(ticket);
    setShowRejectInput(false);
    setRejectReason('');
    setEstimatesLoading(true);
    try {
      const estimates = await fetchCostEstimates(ticket.id);
      setApprovalEstimates(estimates.filter(e => e.status === 'approved'));
    } catch { setApprovalEstimates([]); }
    finally   { setEstimatesLoading(false); }
  };

  const handleApprove = async () => {
    if (!approvalTicket) return;
    setApprovalLoading(true);
    try {
      await tenantApproveCompletion(approvalTicket.id, true, userId);
      setApprovalTicket(null);
      await load();
      Alert.alert('✅ Approved!', 'The ticket has been closed successfully.');
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to approve');
    } finally { setApprovalLoading(false); }
  };

  const handleReject = async () => {
    if (!approvalTicket) return;
    if (!rejectReason.trim()) { Alert.alert('Required', 'Please describe what still needs to be fixed.'); return; }
    setApprovalLoading(true);
    try {
      await tenantApproveCompletion(approvalTicket.id, false, userId, rejectReason.trim());
      setApprovalTicket(null);
      await load();
      Alert.alert('Rejected', 'The technician will be notified to revisit the issue.');
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to reject');
    } finally { setApprovalLoading(false); }
  };

  const openTickets      = tickets.filter(t => !['closed', 'completed'].includes(t.status));
  const closedTickets    = tickets.filter(t => ['closed', 'completed'].includes(t.status));
  const pendingApproval  = tickets.filter(t => t.status === 'pending_tenant_approval');

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>

        {/* Header */}
        <View style={[glass.header, { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg }]}>
          <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
            <Ionicons name="construct-outline" size={20} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary, fontWeight: '600' }}>MY REQUESTS</Text>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: colors.text }}>My Tickets</Text>
          </View>
          <TouchableOpacity
            onPress={() => { resetVoice(); setVoiceOpen(true); }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#6366F1', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, marginRight: 8 }}
          >
            <Ionicons name="mic" size={16} color="#fff" />
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: fontSize.sm }}>Voice</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => navigation.navigate('CreateTicket')}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: BRAND, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 }}
          >
            <Ionicons name="add" size={18} color="#fff" />
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: fontSize.sm }}>Raise</Text>
          </TouchableOpacity>
        </View>

        {/* Pending approval banner */}
        {pendingApproval.length > 0 && (
          <TouchableOpacity
            style={{ backgroundColor: '#FEF3C7', paddingHorizontal: spacing.xl, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}
            onPress={() => openApprovalModal(pendingApproval[0])}
          >
            <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: '#FDE68A', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="hourglass-outline" size={18} color="#D97706" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: '#92400E' }}>
                {pendingApproval.length} ticket{pendingApproval.length > 1 ? 's' : ''} waiting for your approval
              </Text>
              <Text style={{ fontSize: 11, color: '#A16207', marginTop: 1 }}>Tap to review the completed work</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#D97706" />
          </TouchableOpacity>
        )}

        {loading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color={BRAND} />
          </View>
        ) : !tenantId ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
            <View style={{ width: 80, height: 80, borderRadius: 24, backgroundColor: '#FEF3C7', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Ionicons name="warning-outline" size={36} color="#D97706" />
            </View>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: colors.text, textAlign: 'center' }}>Account Not Linked</Text>
            <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 8, textAlign: 'center', lineHeight: 20 }}>
              Your phone number is not linked to a tenant record.{'\n'}Please contact your property manager.
            </Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: spacing.xl, paddingBottom: 100, gap: 16 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[BRAND]} />}
          >
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <StatCard label="Total"  value={tickets.length}     color={BRAND}   bg="#EDE9FE" />
              <StatCard label="Active" value={openTickets.length} color="#D97706" bg="#FEF3C7" />
              <StatCard label="Closed" value={closedTickets.length} color="#16A34A" bg="#DCFCE7" />
            </View>

            {pendingApproval.length > 0 && (
              <>
                <SectionHeader title="Needs Your Approval" count={pendingApproval.length} urgent />
                {pendingApproval.map(t => (
                  <TenantTicketCard key={t.id} ticket={t} onPress={() => openApprovalModal(t)} showApprovalCta />
                ))}
              </>
            )}

            {openTickets.filter(t => t.status !== 'pending_tenant_approval').length > 0 && (
              <>
                <SectionHeader title="Active Tickets" count={openTickets.filter(t => t.status !== 'pending_tenant_approval').length} />
                {openTickets.filter(t => t.status !== 'pending_tenant_approval').map(t => (
                  <TenantTicketCard key={t.id} ticket={t} onPress={() => navigation.navigate('TicketDetail', { ticketId: t.id })} />
                ))}
              </>
            )}

            {closedTickets.length > 0 && (
              <>
                <SectionHeader title="Completed" count={closedTickets.length} />
                {closedTickets.map(t => (
                  <TenantTicketCard key={t.id} ticket={t} onPress={() => navigation.navigate('TicketDetail', { ticketId: t.id })} />
                ))}
              </>
            )}

            {tickets.length === 0 && (
              <View style={{ alignItems: 'center', paddingVertical: 60 }}>
                <View style={{ width: 80, height: 80, borderRadius: 24, backgroundColor: '#EDE9FE', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
                  <Ionicons name="construct-outline" size={36} color={BRAND} />
                </View>
                <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text }}>No tickets yet</Text>
                <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 4, textAlign: 'center', paddingHorizontal: 32 }}>
                  Raise a maintenance request if something needs attention
                </Text>
                <TouchableOpacity
                  onPress={() => navigation.navigate('CreateTicket')}
                  style={{ marginTop: 20, backgroundColor: BRAND, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 999, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                >
                  <Ionicons name="add" size={18} color="#fff" />
                  <Text style={{ color: '#fff', fontWeight: '700' }}>Raise Request</Text>
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>
        )}
      </SafeAreaView>

      {/* ══════════════════════════════════════════════════════════════
           TENANT APPROVAL MODAL
          ══════════════════════════════════════════════════════════════ */}
      <Modal visible={!!approvalTicket} animationType="slide" presentationStyle="pageSheet">
        {approvalTicket && (
          <GlassBackground>
            <SafeAreaView style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: '#FEF3C7', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                  <Ionicons name="checkmark-done-outline" size={22} color="#D97706" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.5 }}>REVIEW & APPROVE</Text>
                  <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }}>{approvalTicket.ticket_number}</Text>
                </View>
                <TouchableOpacity onPress={() => { setApprovalTicket(null); setShowRejectInput(false); }}>
                  <Ionicons name="close-circle" size={28} color={colors.textTertiary} />
                </TouchableOpacity>
              </View>

              <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
                <View style={{ backgroundColor: 'rgba(34,197,94,0.08)', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: 'rgba(34,197,94,0.25)' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <Ionicons name="checkmark-circle" size={20} color="#22C55E" />
                    <Text style={{ fontSize: 15, fontWeight: '800', color: '#22C55E' }}>Work Completed</Text>
                  </View>
                  <View style={{ gap: 10 }}>
                    <View>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textTertiary, marginBottom: 2 }}>ISSUE TYPE</Text>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>{approvalTicket.issue_type || 'Maintenance Issue'}</Text>
                    </View>
                    {approvalTicket.issue_subtype && (
                      <View>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textTertiary, marginBottom: 2 }}>DETAILS</Text>
                        <Text style={{ fontSize: 13, color: colors.text }}>{approvalTicket.issue_subtype}</Text>
                      </View>
                    )}
                    {approvalTicket.description && (
                      <View>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textTertiary, marginBottom: 2 }}>ORIGINAL COMPLAINT</Text>
                        <Text style={{ fontSize: 13, color: colors.textSecondary }}>{approvalTicket.description}</Text>
                      </View>
                    )}
                    {approvalTicket.assigned_to_name && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <View style={{ width: 28, height: 28, borderRadius: 9, backgroundColor: '#E8841A', alignItems: 'center', justifyContent: 'center' }}>
                          <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>{approvalTicket.assigned_to_name[0]}</Text>
                        </View>
                        <Text style={{ fontSize: 13, color: colors.textSecondary }}>Technician: <Text style={{ fontWeight: '700', color: colors.text }}>{approvalTicket.assigned_to_name}</Text></Text>
                      </View>
                    )}
                  </View>
                </View>

                {estimatesLoading ? (
                  <View style={{ alignItems: 'center', padding: 20 }}>
                    <ActivityIndicator size="small" color={BRAND} />
                    <Text style={{ fontSize: 12, color: colors.textTertiary, marginTop: 8 }}>Loading cost details...</Text>
                  </View>
                ) : approvalEstimates.length > 0 ? (
                  <View style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.border }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <Ionicons name="receipt-outline" size={16} color="#7C3AED" />
                      <Text style={{ fontSize: 14, fontWeight: '800', color: colors.text }}>Approved Parts & Costs</Text>
                    </View>
                    <View style={{ gap: 10 }}>
                      {approvalEstimates.map((est, idx) => (
                        <View key={est.id || idx} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: idx < approvalEstimates.length - 1 ? 1 : 0, borderBottomColor: colors.border }}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{est.item_name}</Text>
                            <Text style={{ fontSize: 11, color: colors.textTertiary }}>{est.quantity} × ₹{est.unit_price.toLocaleString('en-IN')}</Text>
                          </View>
                          <Text style={{ fontSize: 14, fontWeight: '800', color: '#7C3AED' }}>₹{est.total.toLocaleString('en-IN')}</Text>
                        </View>
                      ))}
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 8 }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>Total</Text>
                        <Text style={{ fontSize: 18, fontWeight: '800', color: BRAND }}>
                          ₹{approvalEstimates.reduce((s, e) => s + e.total, 0).toLocaleString('en-IN')}
                        </Text>
                      </View>
                    </View>
                  </View>
                ) : (
                  <View style={{ backgroundColor: colors.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Ionicons name="information-circle-outline" size={18} color={colors.textTertiary} />
                    <Text style={{ fontSize: 13, color: colors.textSecondary }}>No additional parts or costs for this repair.</Text>
                  </View>
                )}

                <View style={{ backgroundColor: 'rgba(123,47,190,0.08)', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: 'rgba(123,47,190,0.2)' }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: BRAND, marginBottom: 6 }}>Is the issue fully resolved?</Text>
                  <Text style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 20 }}>
                    Please confirm the work was completed to your satisfaction. Tap "Reject" to send the technician back.
                  </Text>
                </View>

                {showRejectInput && (
                  <View style={{ gap: 8 }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#DC2626', letterSpacing: 0.4 }}>WHAT STILL NEEDS TO BE FIXED? *</Text>
                    <TextInput
                      value={rejectReason}
                      onChangeText={setRejectReason}
                      placeholder="Describe the remaining issue..."
                      placeholderTextColor={colors.textTertiary}
                      multiline
                      style={{ backgroundColor: colors.surface, borderWidth: 1.5, borderColor: '#DC2626', borderRadius: 14, padding: 14, fontSize: 14, color: colors.text, minHeight: 100, textAlignVertical: 'top' }}
                    />
                  </View>
                )}
              </ScrollView>

              <View style={{ padding: 20, gap: 10, borderTopWidth: 1, borderTopColor: colors.border }}>
                {!showRejectInput ? (
                  <>
                    <TouchableOpacity onPress={handleApprove} disabled={approvalLoading}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: '#22C55E', borderRadius: 16, padding: 16 }}>
                      {approvalLoading ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="checkmark-circle" size={22} color="#fff" />}
                      <Text style={{ fontSize: 16, fontWeight: '800', color: '#fff' }}>Yes, Issue is Resolved ✓</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setShowRejectInput(true)} disabled={approvalLoading}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: '#FEE2E2', borderRadius: 16, padding: 16 }}>
                      <Ionicons name="close-circle-outline" size={22} color="#DC2626" />
                      <Text style={{ fontSize: 16, fontWeight: '800', color: '#DC2626' }}>No, Still Not Fixed</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <TouchableOpacity onPress={handleReject} disabled={approvalLoading}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: '#DC2626', borderRadius: 16, padding: 16 }}>
                      {approvalLoading ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="send-outline" size={20} color="#fff" />}
                      <Text style={{ fontSize: 16, fontWeight: '800', color: '#fff' }}>Send Back to Technician</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => { setShowRejectInput(false); setRejectReason(''); }} disabled={approvalLoading}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, borderColor: colors.border, borderRadius: 16, padding: 14 }}>
                      <Ionicons name="arrow-back-outline" size={18} color={colors.textSecondary} />
                      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textSecondary }}>Back</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </SafeAreaView>
          </GlassBackground>
        )}
      </Modal>

      {/* ══════════════════════════════════════════════════════════════
           VOICE MODAL  (expo-av recording)
          ══════════════════════════════════════════════════════════════ */}
      <Modal visible={voiceOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={closeVoice}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#F7F3F9' }} edges={['top', 'bottom']}>

          {/* Modal header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#E0D5EA', backgroundColor: '#fff' }}>
            <TouchableOpacity onPress={closeVoice} style={{ marginRight: 12, padding: 4 }}>
              <Ionicons name="close" size={24} color="#1E1230" />
            </TouchableOpacity>
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="mic" size={18} color={BRAND} />
              <Text style={{ fontSize: 17, fontWeight: '800', color: '#1E1230' }}>
                {voiceStep === 'review'     ? 'Review & Confirm'
                  : voiceStep === 'submitting' ? 'Creating Ticket…'
                  : voiceStep === 'success'    ? 'Ticket Raised!'
                  : voiceStep === 'error'      ? 'Something Went Wrong'
                  : 'Voice Complaint'}
              </Text>
            </View>
          </View>

          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">

            {/* ── IDLE / RECORDING / PROCESSING ── */}
            {(voiceStep === 'idle' || voiceStep === 'recording' || voiceStep === 'processing') && (
              <View style={{ alignItems: 'center', paddingVertical: 32, gap: 24 }}>
                <Text style={{ fontSize: 14, color: '#5C4B70', textAlign: 'center', lineHeight: 22 }}>
                  {voiceStep === 'recording'  ? 'Listening… tap Stop when done.'
                    : voiceStep === 'processing' ? 'Transcribing your voice…'
                    : 'Tap the mic and describe your issue clearly.'}
                </Text>

                {/* Mic button */}
                <View style={{ width: 120, height: 120, alignItems: 'center', justifyContent: 'center' }}>
                  {voiceStep === 'recording' && (
                    <View style={{ position: 'absolute', width: 120, height: 120, borderRadius: 60, backgroundColor: 'rgba(220,38,38,0.15)' }} />
                  )}
                  <TouchableOpacity
                    onPress={voiceStep === 'recording' ? stopRecording : startRecording}
                    disabled={voiceStep === 'processing'}
                    style={{
                      width: 90, height: 90, borderRadius: 45,
                      backgroundColor: voiceStep === 'recording' ? '#DC2626' : BRAND,
                      alignItems: 'center', justifyContent: 'center',
                      shadowColor: voiceStep === 'recording' ? '#DC2626' : BRAND,
                      shadowOpacity: 0.4, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10,
                      opacity: voiceStep === 'processing' ? 0.6 : 1,
                    }}
                  >
                    {voiceStep === 'processing'
                      ? <ActivityIndicator color="#fff" size="large" />
                      : <Ionicons name={voiceStep === 'recording' ? 'stop' : 'mic'} size={38} color="#fff" />
                    }
                  </TouchableOpacity>
                </View>

                {/* Live timer */}
                {voiceStep === 'recording' && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FEE2E2', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#DC2626' }} />
                    <Text style={{ fontSize: 15, fontWeight: '800', color: '#DC2626' }}>
                      {`${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`}
                    </Text>
                    <Text style={{ fontSize: 12, color: '#9B8BAE' }}>auto-stops on silence</Text>
                  </View>
                )}

                {/* Quick-select phrases */}
                {voiceStep === 'idle' && (
                  <View style={{ width: '100%', gap: 8 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#9B8BAE', letterSpacing: 0.8 }}>
                      EXAMPLE PHRASES — tap to use without recording
                    </Text>
                    {['AC is not working in my room', 'Water is leaking from the bathroom', 'Door lock is broken', 'WiFi is not connecting', 'Light bulb needs replacement'].map(phrase => (
                      <TouchableOpacity
                        key={phrase}
                        onPress={() => {
                          setTranscript(phrase);
                          const lower = phrase.toLowerCase();
                          const match = issueTypes.find((it: any) => lower.includes(it.name.toLowerCase()));
                          const pick  = match || issueTypes[0];
                          if (pick) { setSelTypeId(pick.id); setSelTypeName(pick.name); }
                          setVoiceStep('review');
                        }}
                        style={{ backgroundColor: 'rgba(123,47,190,0.05)', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: 'rgba(123,47,190,0.15)' }}
                      >
                        <Text style={{ fontSize: 13, color: BRAND }}>"{phrase}"</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            )}

            {/* ── REVIEW ── */}
            {voiceStep === 'review' && (
              <View style={{ gap: 16 }}>
                <View style={{ backgroundColor: '#F0F4FF', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#C7D2FE' }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#4338CA', letterSpacing: 0.6, marginBottom: 8 }}>
                    {transcript ? 'WHAT YOU SAID (tap to edit)' : 'DESCRIBE YOUR ISSUE'}
                  </Text>
                  <TextInput
                    value={transcript}
                    onChangeText={txt => {
                      setTranscript(txt);
                      const lower = txt.toLowerCase();
                      const match = issueTypes.find((it: any) => lower.includes(it.name.toLowerCase()));
                      if (match) { setSelTypeId(match.id); setSelTypeName(match.name); }
                    }}
                    multiline
                    placeholder="e.g. AC not cooling, water leaking…"
                    placeholderTextColor="#9CA3AF"
                    autoFocus={!transcript}
                    style={{ fontSize: 15, color: '#1E1230', lineHeight: 22, minHeight: 80 }}
                  />
                </View>

                {!!selTypeName && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#EDE9FE', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#C4B5FD' }}>
                    <Ionicons name="sparkles" size={16} color={BRAND} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: BRAND, letterSpacing: 0.5 }}>AUTO-DETECTED ISSUE TYPE</Text>
                      <Text style={{ fontSize: 15, fontWeight: '700', color: '#1E1230' }}>{selTypeName}</Text>
                    </View>
                  </View>
                )}

                <View style={{ gap: 6 }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#5C4B70' }}>ISSUE CATEGORY</Text>
                  {issueTypes.map((it: any) => (
                    <TouchableOpacity
                      key={it.id}
                      onPress={() => { setSelTypeId(it.id); setSelTypeName(it.name); }}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: selTypeId === it.id ? 'rgba(123,47,190,0.08)' : '#fff', borderRadius: 10, padding: 12, borderWidth: 1.5, borderColor: selTypeId === it.id ? BRAND : '#E0D5EA' }}
                    >
                      <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: selTypeId === it.id ? BRAND : '#C4B5D0', backgroundColor: selTypeId === it.id ? BRAND : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                        {selTypeId === it.id && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} />}
                      </View>
                      <Text style={{ fontSize: 14, flex: 1, fontWeight: selTypeId === it.id ? '700' : '400', color: selTypeId === it.id ? '#1E1230' : '#5C4B70' }}>{it.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <TouchableOpacity
                  onPress={() => { setTranscript(''); setVoiceStep('idle'); }}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 6 }}
                >
                  <Ionicons name="mic-outline" size={14} color={BRAND} />
                  <Text style={{ fontSize: 13, color: BRAND, fontWeight: '600' }}>Re-record</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* ── SUBMITTING ── */}
            {voiceStep === 'submitting' && (
              <View style={{ alignItems: 'center', paddingVertical: 60, gap: 16 }}>
                <ActivityIndicator size="large" color={BRAND} />
                <Text style={{ fontSize: 16, fontWeight: '700', color: '#1E1230' }}>Creating your ticket…</Text>
                <Text style={{ fontSize: 13, color: '#6B7280', textAlign: 'center' }}>AI is classifying and assigning a technician</Text>
              </View>
            )}

            {/* ── SUCCESS ── */}
            {voiceStep === 'success' && (
              <View style={{ alignItems: 'center', paddingVertical: 40, gap: 16 }}>
                <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: '#DCFCE7', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#86EFAC' }}>
                  <Ionicons name="checkmark-circle" size={48} color="#16A34A" />
                </View>
                <Text style={{ fontSize: 22, fontWeight: '900', color: '#1E1230' }}>Ticket Raised!</Text>
                {!!ticketNum && (
                  <View style={{ backgroundColor: BRAND_LIGHT, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderColor: 'rgba(123,47,190,0.25)' }}>
                    <Text style={{ fontSize: 16, fontWeight: '800', color: BRAND, letterSpacing: 1 }}>{ticketNum}</Text>
                  </View>
                )}
                <Text style={{ fontSize: 14, color: '#5C4B70', textAlign: 'center', lineHeight: 21, paddingHorizontal: 16 }}>
                  Your complaint has been logged and a technician has been assigned.
                </Text>
                <TouchableOpacity onPress={closeVoice} style={{ backgroundColor: BRAND, borderRadius: 14, paddingHorizontal: 40, paddingVertical: 14 }}>
                  <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>Done</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* ── ERROR ── */}
            {voiceStep === 'error' && (
              <View style={{ alignItems: 'center', paddingVertical: 36, gap: 14 }}>
                <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: '#FEE2E2', alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="alert-circle" size={40} color="#DC2626" />
                </View>
                <Text style={{ fontSize: 17, fontWeight: '800', color: '#1E1230' }}>Something Went Wrong</Text>
                <Text style={{ fontSize: 13, color: '#DC2626', textAlign: 'center', lineHeight: 20, paddingHorizontal: 16 }}>{voiceError}</Text>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <TouchableOpacity onPress={() => { setVoiceError(''); setVoiceStep('idle'); }} style={{ backgroundColor: BRAND, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 }}>
                    <Text style={{ color: '#fff', fontWeight: '800' }}>Try Again</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={closeVoice} style={{ backgroundColor: '#F3F0F7', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, borderWidth: 1, borderColor: '#E0D5EA' }}>
                    <Text style={{ color: '#5C4B70', fontWeight: '700' }}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

          </ScrollView>

          {/* Footer — Raise Ticket button, only on review step */}
          {voiceStep === 'review' && (
            <View style={{ padding: 20, paddingBottom: Platform.OS === 'ios' ? 8 : 20, borderTopWidth: 1, borderTopColor: '#E0D5EA', backgroundColor: '#fff' }}>
              <TouchableOpacity
                onPress={submitVoiceTicket}
                disabled={!transcript.trim() || !selTypeId}
                style={{ backgroundColor: transcript.trim() && selTypeId ? BRAND : '#C4B5D0', borderRadius: 14, paddingVertical: 16, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
              >
                <Ionicons name="paper-plane-outline" size={18} color="#fff" />
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>Raise Ticket</Text>
              </TouchableOpacity>
            </View>
          )}

        </SafeAreaView>
      </Modal>

    </GlassBackground>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function StatCard({ label, value, color, bg }: any) {
  return (
    <View style={{ flex: 1, backgroundColor: bg, borderRadius: borderRadius.lg, paddingVertical: 12, alignItems: 'center' }}>
      <Text style={{ fontSize: fontSize.xxl, fontWeight: '900', color }}>{value}</Text>
      <Text style={{ fontSize: fontSize.xs, fontWeight: '600', color, opacity: 0.7 }}>{label}</Text>
    </View>
  );
}

function SectionHeader({ title, count, urgent }: { title: string; count: number; urgent?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {urgent && <Ionicons name="alert-circle" size={16} color="#D97706" />}
      <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: urgent ? '#D97706' : colors.text }}>{title}</Text>
      <View style={{ backgroundColor: urgent ? '#FEF3C7' : colors.surfaceSecondary, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
        <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: urgent ? '#D97706' : colors.textSecondary }}>{count}</Text>
      </View>
    </View>
  );
}

function TenantTicketCard({ ticket, onPress, showApprovalCta }: {
  ticket: Ticket; onPress: () => void; showApprovalCta?: boolean;
}) {
  const { colors } = useTheme();
  const statusCfg         = STATUS_CONFIG[ticket.status] || STATUS_CONFIG.open;
  const isPendingApproval = ticket.status === 'pending_tenant_approval';

  return (
    <TouchableOpacity
      onPress={onPress} activeOpacity={0.85}
      style={[glass.card, { marginBottom: 0, borderWidth: isPendingApproval ? 2 : 1, borderColor: isPendingApproval ? '#D97706' : colors.border }]}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#7B2FBE', letterSpacing: 0.3 }}>{ticket.ticket_number}</Text>
        <View style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, backgroundColor: statusCfg.bg }}>
          <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: statusCfg.color }}>{statusCfg.label}</Text>
        </View>
      </View>
      <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: colors.text, marginBottom: 4 }}>{ticket.issue_type || 'Maintenance Issue'}</Text>
      {ticket.issue_subtype && <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, marginBottom: 6 }}>{ticket.issue_subtype}</Text>}
      {ticket.description  && <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: 8 }} numberOfLines={2}>{ticket.description}</Text>}
      {ticket.assigned_to_name && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <View style={{ width: 22, height: 22, borderRadius: 7, backgroundColor: '#E8841A', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 10, fontWeight: '800', color: '#fff' }}>{ticket.assigned_to_name[0]}</Text>
          </View>
          <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>Assigned to {ticket.assigned_to_name}</Text>
        </View>
      )}
      {(isPendingApproval || showApprovalCta) && (
        <View style={{ backgroundColor: '#FEF3C7', borderRadius: borderRadius.md, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Ionicons name="alert-circle-outline" size={16} color="#D97706" />
          <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#92400E', flex: 1 }}>Tap to review and approve the completed work →</Text>
        </View>
      )}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
        <Text style={{ fontSize: 11, color: colors.textTertiary }}>
          {formatDate(ticket.created_at, '')}
        </Text>
        {ticket.estimated_cost && <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#7B2FBE' }}>₹{ticket.estimated_cost}</Text>}
      </View>
    </TouchableOpacity>
  );
}
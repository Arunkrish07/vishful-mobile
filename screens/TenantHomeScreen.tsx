/**
 * TenantHomeScreen.tsx — FIXED
 *
 * Fixes applied:
 *  1. Removed expo-av (not installed) → MediaRecorder for voice recording
 *  2. Fixed api.tickets.listIssueTypes → api.tickets.getIssueTypes
 *  3. Added getTenantDetails wrapper via getTenantProfile
 *  4. Added voice "Raise Complaint" button in header
 *  5. Replaced SpeechRecognition (fails iOS Safari) with MediaRecorder + /api/transcribe
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TouchableOpacity,
  Alert, ActivityIndicator, Modal, TextInput, Image,
  Animated, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/ThemeContext';
import { spacing, borderRadius, fontSize, glass } from '../lib/theme';
import { Ionicons } from '@expo/vector-icons';
import { GlassBackground, DateField } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { fetchTickets, tenantApproveCompletion, checkTenantPendingTickets, Ticket } from '../services/ticketService';
import { getTenantNotices, recordNotice, getTenantLocation, listInvoices, listAnnouncements } from '../lib/supabaseService';
import { client, api } from '../lib/convexApi';
import { CONVEX_SITE_URL } from '../lib/config';

// ─── Convex HTTP endpoints ────────────────────────────────────────────────────
const CONVEX_BASE   = CONVEX_SITE_URL;
const TRANSCRIBE_URL = `${CONVEX_BASE}/api/transcribe`;
const TICKET_URL     = `${CONVEX_BASE}/api/voice-ticket-direct`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function cleanPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/\D/g, '').slice(-10);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

// ─── MediaRecorder availability check ────────────────────────────────────────
function canRecord(): boolean {
  const g = globalThis as any;
  // Only check for MediaRecorder — getUserMedia will be available once user grants permission in a0.dev iframe
  return typeof g.MediaRecorder !== 'undefined';
}

// ─── blob → base64 ────────────────────────────────────────────────────────────
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new (globalThis as any).FileReader();
    reader.onloadend = () => {
      const r: string = reader.result as string;
      resolve(r.split(',')[1] ?? r);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword → issue_type mapping
// ─────────────────────────────────────────────────────────────────────────────

const KEYWORD_MAP: Record<string, string[]> = {
  ac: ['electrical'], fan: ['electrical'], light: ['electrical'],
  bulb: ['electrical'], switch: ['electrical'], socket: ['electrical'],
  plug: ['electrical'], power: ['electrical'], inverter: ['electrical'],
  mcb: ['electrical'], fuse: ['electrical'], electrical: ['electrical'],
  water: ['plumbing'], leak: ['plumbing'], pipe: ['plumbing'],
  tap: ['plumbing'], flush: ['plumbing'], toilet: ['plumbing'],
  drain: ['plumbing'], clog: ['plumbing'], geyser: ['plumbing'],
  plumbing: ['plumbing'], tank: ['plumbing'],
  dirty: ['cleaning'], clean: ['cleaning'], garbage: ['cleaning'],
  trash: ['cleaning'], dust: ['cleaning'], sweep: ['cleaning'],
  mop: ['cleaning'], housekeeping: ['cleaning'],
  cockroach: ['pest'], rat: ['pest'], insect: ['pest'],
  mosquito: ['pest'], pest: ['pest'],
  door: ['carpentry'], window: ['carpentry'], lock: ['carpentry'],
  hinge: ['carpentry'], furniture: ['carpentry'], almirah: ['carpentry'],
  wardrobe: ['carpentry'], shelf: ['carpentry'], carpentry: ['carpentry'],
  wifi: ['wifi', 'internet'], internet: ['wifi', 'internet'],
  network: ['wifi', 'internet'], router: ['wifi', 'internet'],
  noise: ['complaint'], neighbor: ['complaint'], security: ['complaint'],
  complaint: ['complaint'],
  broken: ['maintenance'], repair: ['maintenance'], fix: ['maintenance'],
  damaged: ['maintenance'], maintenance: ['maintenance'],
};

interface IssueType { id: string; name: string; priority?: string; }

interface ClassificationResult {
  issueTypeId: string;
  issueTypeName: string;
  confidence: 'high' | 'medium' | 'low' | 'fallback';
  matchedKeyword?: string;
}

function classifyTranscript(transcript: string, issueTypes: IssueType[]): ClassificationResult | null {
  if (!issueTypes.length) return null;
  const lower = transcript.toLowerCase();
  const scores: Record<string, { score: number; keyword: string }> = {};
  for (const [keyword, targets] of Object.entries(KEYWORD_MAP)) {
    if (!lower.includes(keyword)) continue;
    for (const target of targets) {
      const match = issueTypes.find(it => it.name.toLowerCase().includes(target));
      if (match) {
        if (!scores[match.id]) scores[match.id] = { score: 0, keyword };
        scores[match.id].score += targets.indexOf(target) === 0 ? 3 : 1;
      }
    }
  }
  for (const it of issueTypes) {
    if (lower.includes(it.name.toLowerCase())) {
      if (!scores[it.id]) scores[it.id] = { score: 0, keyword: it.name };
      scores[it.id].score += 5;
    }
  }
  if (!Object.keys(scores).length) return null;
  const [bestId, { score, keyword }] = Object.entries(scores).sort((a, b) => b[1].score - a[1].score)[0];
  const bestType = issueTypes.find(it => it.id === bestId)!;
  return {
    issueTypeId: bestId, issueTypeName: bestType.name,
    confidence: score >= 5 ? 'high' : score >= 3 ? 'medium' : 'low',
    matchedKeyword: keyword,
  };
}

function getFallback(issueTypes: IssueType[]): IssueType | null {
  if (!issueTypes.length) return null;
  for (const name of ['maintenance', 'general', 'other']) {
    const f = issueTypes.find(it => it.name.toLowerCase().includes(name));
    if (f) return f;
  }
  return issueTypes[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pulsing ring
// ─────────────────────────────────────────────────────────────────────────────

function PulsingRing() {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(scale, { toValue: 1.5, duration: 700, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1,   duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  return (
    <Animated.View style={{
      position: 'absolute', width: 72, height: 72, borderRadius: 36,
      backgroundColor: 'rgba(220,38,38,0.15)', transform: [{ scale }],
    }} />
  );
}

type VoiceStep = 'idle' | 'recording' | 'processing' | 'review' | 'submitting' | 'success' | 'error';

const CONFIDENCE_COLORS = {
  high:     { bg: '#dcfce7', text: '#16a34a', border: '#86efac' },
  medium:   { bg: '#fef9c3', text: '#ca8a04', border: '#fde047' },
  low:      { bg: '#ffedd5', text: '#ea580c', border: '#fed7aa' },
  fallback: { bg: '#f3e8ff', text: '#6366F1', border: '#d8b4fe' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function TenantHomeScreen({ navigation }: any) {
  const { colors } = useTheme();
  const { user, tenantLocation } = useAuth();
  const scrollRef = useRef<ScrollView>(null);
  const [sectionOffsets, setSectionOffsets] = useState<Record<string, number>>({});

  const captureSectionOffset = useCallback((key: string) => (event: any) => {
    const y = Number(event?.nativeEvent?.layout?.y ?? 0);
    if (!Number.isFinite(y)) return;
    setSectionOffsets(prev => (prev[key] === y ? prev : { ...prev, [key]: y }));
  }, []);

  // ── Standard state ───────────────────────────────────────────────────────
  const [refreshing, setRefreshing]               = useState(false);
  const [pendingTickets, setPendingTickets]       = useState<Ticket[]>([]);
  const [approvalTicket, setApprovalTicket]       = useState<Ticket | null>(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [showRejectInput, setShowRejectInput]     = useState(false);
  const [rejectReason, setRejectReason]           = useState('');
  const [tenantNotices, setTenantNotices]         = useState<any[]>([]);
  const [noticeModalOpen, setNoticeModalOpen]     = useState(false);
  const [noticeExitDate, setNoticeExitDate]       = useState('');
  const [noticeNotes, setNoticeNotes]             = useState('');
  const [noticeSaving, setNoticeSaving]           = useState(false);
  const [tenantDetails, setTenantDetails]         = useState<any>(null);
  const [detailsLoading, setDetailsLoading]       = useState(false);
  const [accountNotLinked, setAccountNotLinked]   = useState(false);

  // ── Dues / tickets / announcements (parity with web TenantDashboard) ──────
  const [totalDue, setTotalDue]                   = useState(0);
  const [pendingInvoiceCount, setPendingInvoiceCount] = useState(0);
  const [openTicketCount, setOpenTicketCount]     = useState(0);
  const [announcements, setAnnouncements]         = useState<any[]>([]);
  const [expandedAnnouncement, setExpandedAnnouncement] = useState<string | null>(null);

  // ── Voice state ──────────────────────────────────────────────────────────
  const [voiceStep, setVoiceStep]                 = useState<VoiceStep>('idle');
  const [voiceModalOpen, setVoiceModalOpen]       = useState(false);
  const [transcript, setTranscript]               = useState('');
  const [editedTranscript, setEditedTranscript]   = useState('');
  const [durationMs, setDurationMs]               = useState(0);
  const [voiceError, setVoiceError]               = useState('');
  const [issueTypes, setIssueTypes]               = useState<IssueType[]>([]);
  const [selectedTypeId, setSelectedTypeId]       = useState('');
  const [classification, setClassification]       = useState<ClassificationResult | null>(null);
  const [createdTicketNumber, setCreatedTicketNumber] = useState('');
  const [loadingIssueTypes, setLoadingIssueTypes] = useState(false);

  // MediaRecorder refs (replaces expo-av)
  const mediaRecorderRef = useRef<any>(null);
  const audioChunksRef   = useRef<Blob[]>([]);
  const audioMimeRef     = useRef<string>('audio/webm');
  const durationTimer    = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef     = useRef(0);

  const tenantId        = tenantLocation?.tenantId ?? '';
  const userId          = user?.supabaseUserId || user?.userId || '';
  const normalizedPhone = cleanPhone(user?.phone);

  // ─────────────────────────────────────────────────────────────────────────
  // Data loaders
  // ─────────────────────────────────────────────────────────────────────────

  const loadTenantDetails = useCallback(async () => {
    if (!normalizedPhone) return;
    setDetailsLoading(true); setAccountNotLinked(false);
    try {
      // Use getTenantLocation which is confirmed to exist in supabaseService
      const result = await getTenantLocation(normalizedPhone);
      if (!result?.found) {
        setAccountNotLinked(true); setTenantDetails(null);
      } else {
        // Shape the result to match what the profile card expects
        setTenantDetails({
          tenant: {
            full_name:    result.tenantName,
            phone:        user?.phone || normalizedPhone,
            staying_status: result.stayingStatus ?? 'Staying',
            kyc_completed:  result.kycCompleted ?? false,
          },
          allotment: {
            monthly_rental: result.monthlyRent,
            onboarding_date: result.checkInDate,
            properties: { property_name: result.propertyName, address: result.propertyAddress },
            apartments: { apartment_code: result.unitNumber || result.apartmentName, floor: result.floor },
            beds: { bed_code: result.bedCode },
          },
        });
      }
    } catch (e) {
      console.warn('[TenantHome] loadTenantDetails:', e);
    }
    finally { setDetailsLoading(false); }
  }, [normalizedPhone, user?.phone]);

  const loadPending = useCallback(async () => {
    if (!tenantId) return;
    try {
      const all = await fetchTickets('tenant', undefined, tenantId);
      setPendingTickets(all.filter((t: Ticket) => t.status === 'pending_tenant_approval'));
      // TASK 2 — reuse the same fetch to count open tickets (not completed/closed/resolved)
      const closedStatuses = ['completed', 'closed', 'resolved'];
      setOpenTicketCount(
        all.filter((t: Ticket) => !closedStatuses.includes(String(t.status || '').toLowerCase())).length
      );
    } catch {}
  }, [tenantId]);

  // TASK 1 — Dues summary from real invoices
  const loadDues = useCallback(async () => {
    if (!tenantId) return;
    try {
      const invoices: any[] = (await listInvoices({ tenantId })) || [];
      let due = 0;
      let pending = 0;
      for (const inv of invoices) {
        const status = String(inv?.status || '').toLowerCase();
        if (status === 'paid') continue;
        pending += 1;
        const balance = Number(inv?.totalAmount ?? 0) - Number(inv?.paidAmount ?? 0);
        if (balance > 0) due += balance;
      }
      setTotalDue(due);
      setPendingInvoiceCount(pending);
    } catch { setTotalDue(0); setPendingInvoiceCount(0); }
  }, [tenantId]);

  // TASK 3 — Published announcements
  const loadAnnouncements = useCallback(async () => {
    try {
      const all: any[] = (await listAnnouncements()) || [];
      const published = all.filter((a: any) => a?.is_published || a?.published_at);
      setAnnouncements(published);
    } catch { setAnnouncements([]); }
  }, []);

  const loadNotices = useCallback(async () => {
    if (!tenantId) return;
    try {
      const all: any[] = await getTenantNotices(tenantId);
      setTenantNotices(all.filter((n: any) => n.tenantId === tenantId || n.tenant_id === tenantId));
    } catch {}
  }, [tenantId]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    Promise.all([loadPending(), loadNotices(), loadTenantDetails(), loadDues(), loadAnnouncements()]).finally(() => setRefreshing(false));
  }, [loadPending, loadNotices, loadTenantDetails, loadDues, loadAnnouncements]);

  useEffect(() => { loadPending(); },       [loadPending]);
  useEffect(() => { loadNotices(); },       [loadNotices]);
  useEffect(() => { loadTenantDetails(); }, [loadTenantDetails]);
  useEffect(() => { loadDues(); },          [loadDues]);
  useEffect(() => { loadAnnouncements(); }, [loadAnnouncements]);

  // Load issue types when voice modal opens
  useEffect(() => {
    if (!voiceModalOpen) return;
    setLoadingIssueTypes(true);
    client.action(api.tickets.getIssueTypes, {})
      .then((t: any) => {
        const types = t || [];
        setIssueTypes(types);
        // No MediaRecorder on this browser → skip idle, open straight to text input
        if (!canRecord() && types.length > 0) {
          const fb = types.find((it: any) =>
            ['maintenance','general','other'].some(n => it.name.toLowerCase().includes(n))
          ) || types[0];
          setSelectedTypeId(fb.id);
          setClassification({ issueTypeId: fb.id, issueTypeName: fb.name, confidence: 'fallback' });
          setEditedTranscript('');
          setVoiceStep('review');
        }
      })
      .catch(() => setIssueTypes([]))
      .finally(() => setLoadingIssueTypes(false));
  }, [voiceModalOpen]);

  // ─────────────────────────────────────────────────────────────────────────
  // Duration timer
  // ─────────────────────────────────────────────────────────────────────────

  const stopDurationTimer = useCallback(() => {
    if (durationTimer.current) { clearInterval(durationTimer.current); durationTimer.current = null; }
  }, []);

  const startDurationTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    durationTimer.current = setInterval(() => setDurationMs(Date.now() - startTimeRef.current), 200);
  }, []);

  useEffect(() => () => {
    stopDurationTimer();
    if (mediaRecorderRef.current?.state === 'recording') {
      try { mediaRecorderRef.current.stop(); } catch (_) {}
    }
  }, [stopDurationTimer]);

  // ─────────────────────────────────────────────────────────────────────────
  // Voice — MediaRecorder (works on iOS Safari, Chrome, Firefox)
  // ─────────────────────────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    setVoiceError(''); setTranscript(''); setDurationMs(0);

    if (!canRecord()) {
      // MediaRecorder not available — go straight to text entry
      const fb = getFallback(issueTypes);
      setClassification(fb ? { issueTypeId: fb.id, issueTypeName: fb.name, confidence: 'fallback' } : null);
      setSelectedTypeId(fb?.id || '');
      setEditedTranscript('');
      setVoiceStep('review');
      return;
    }

    try {
      const g = globalThis as any;
      
      // Try to get microphone permission explicitly first (important for a0.dev sandboxed iframe)
      try {
        const permissionStatus = await g.navigator.permissions.query({ name: 'microphone' });
        if (permissionStatus.state === 'denied') {
          throw new Error('Microphone permission denied');
        }
      } catch (permErr: any) {
        // If permissions.query fails, continue anyway (older browsers may not support it)
      }

      // Request getUserMedia with enhanced iOS Safari constraints
      const stream = await g.navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      
      audioChunksRef.current = [];

      // Create AudioContext for gain control to raise volume
      let audioContext: any = null;
      let sourceStream: any = stream;
      try {
        audioContext = new (g.AudioContext || g.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(stream);
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 2.5; // Raise volume to 2.5x
        source.connect(gainNode);
        
        // Create a destination to capture the processed audio
        const destination = audioContext.createMediaStreamDestination();
        gainNode.connect(destination);
        sourceStream = destination.stream;
      } catch (_) {
        // AudioContext not available, use original stream
        // Apply gain control to audio track constraints if possible
        try {
          const audioTracks = stream.getAudioTracks();
          for (const track of audioTracks) {
            const settings = track.getSettings?.();
            if (settings) {
              track.applyConstraints?.({
                advanced: [{ autoGainControl: true }]
              }).catch(() => {});
            }
          }
        } catch (_) {}
      }
      
      const mime =
        g.MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
        g.MediaRecorder.isTypeSupported?.('audio/webm')             ? 'audio/webm' :
        g.MediaRecorder.isTypeSupported?.('audio/mp4')              ? 'audio/mp4'  : '';

      audioMimeRef.current = mime || 'audio/webm';

      const recorder = mime
        ? new g.MediaRecorder(sourceStream, { mimeType: mime })
        : new g.MediaRecorder(sourceStream);

      recorder.ondataavailable = (e: any) => {
        if (e.data?.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t: any) => t.stop());
        stopDurationTimer();
        await processRecording();
      };

      recorder.onerror = () => {
        stopDurationTimer();
        setVoiceError('Recording failed. Please try the text option below.');
        setVoiceStep('error');
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      startDurationTimer();
      setVoiceStep('recording');
    } catch (err: any) {
      stopDurationTimer();
      const msg = (err?.message || '').toLowerCase();
      const errName = (err?.name || '').toLowerCase();
      
      // Handle permission errors and security errors (common in a0.dev iframe)
      if (
        msg.includes('permission') ||
        msg.includes('denied') ||
        msg.includes('notallowed') ||
        errName.includes('notallowerror') ||
        errName.includes('securityerror')
      ) {
        Alert.alert(
          'Microphone Required',
          'Please allow microphone access. In Safari, go to Settings → This Site → Microphone, then try again.',
        );
        setVoiceStep('idle');
      } else {
        // Fallback to text entry
        const fb = getFallback(issueTypes);
        setClassification(fb ? { issueTypeId: fb.id, issueTypeName: fb.name, confidence: 'fallback' } : null);
        setSelectedTypeId(fb?.id || '');
        setEditedTranscript('');
        setVoiceStep('review');
      }
    }
  }, [issueTypes, startDurationTimer, stopDurationTimer]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop(); // triggers onstop → processRecording
    }
  }, []);

  const processRecording = useCallback(async () => {
    setVoiceStep('processing');
    try {
      const actualMime = mediaRecorderRef.current?.mimeType || audioMimeRef.current || 'audio/webm';
      const blob = new (globalThis as any).Blob(audioChunksRef.current, { type: actualMime });

      if (blob.size < 1000) {
        setVoiceError("No audio captured. Please tap the mic and speak before stopping.");
        setVoiceStep('error');
        return;
      }

      const base64 = await blobToBase64(blob);

      // POST to /api/transcribe → Whisper STT
      const resp = await fetch(TRANSCRIBE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: base64, mimeType: actualMime }),
      });
      const data = await resp.json();

      if (!resp.ok || data.error) throw new Error(data.error || 'Transcription failed');

      const text = (data.transcription || '').trim();
      if (!text) {
        setVoiceError("Couldn't make out what you said. Please try again or type below.");
        setVoiceStep('error');
        return;
      }

      moveToReview(text);
    } catch (err: any) {
      setVoiceError(err.message || 'Failed to process recording. Check your connection.');
      setVoiceStep('error');
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Review transition
  // ─────────────────────────────────────────────────────────────────────────

  const moveToReview = useCallback((text: string) => {
    if (!text.trim()) { setVoiceError('No speech detected.'); setVoiceStep('error'); return; }
    setEditedTranscript(text);
    const cls = classifyTranscript(text, issueTypes);
    const fb  = getFallback(issueTypes);
    const resolved = cls || (fb ? { issueTypeId: fb.id, issueTypeName: fb.name, confidence: 'fallback' as const } : null);
    setClassification(resolved);
    setSelectedTypeId(resolved?.issueTypeId || '');
    setVoiceStep('review');
  }, [issueTypes]);

  // Auto re-classify when user edits the transcript
  useEffect(() => {
    if (voiceStep !== 'review' || !editedTranscript) return;
    const cls = classifyTranscript(editedTranscript, issueTypes);
    if (cls) { setClassification(cls); setSelectedTypeId(cls.issueTypeId); }
  }, [editedTranscript, voiceStep, issueTypes]);

  // ─────────────────────────────────────────────────────────────────────────
  // Submit
  // ─────────────────────────────────────────────────────────────────────────

  const handleVoiceSubmit = useCallback(async () => {
    if (!editedTranscript.trim() || !selectedTypeId) return;
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
      const result = await client.action(api.tickets.createTicket, {
        data: {
          description:   editedTranscript.trim(),
          issue_type_id: selectedTypeId,
          tenant_id:     tenantId    || null,
          property_id:   tenantLocation?.propertyId  || null,
          apartment_id:  tenantLocation?.apartmentId || null,
          bed_id:        tenantLocation?.bedId       || null,
          created_by:    userId                      || null,
          source:        'voice',
        },
      });
      setCreatedTicketNumber(result?.ticket_number || result?.ticketNumber || '');
      setVoiceStep('success');
      await loadPending();
    } catch (e: any) {
      setVoiceError(e?.message || 'Failed to create ticket. Please try again.');
      setVoiceStep('error');
    }
  }, [editedTranscript, selectedTypeId, tenantId, tenantLocation, userId, loadPending]);

  // ─────────────────────────────────────────────────────────────────────────
  // Reset / Close
  // ─────────────────────────────────────────────────────────────────────────

  const resetVoice = useCallback(() => {
    stopDurationTimer();
    if (mediaRecorderRef.current?.state === 'recording') {
      try { mediaRecorderRef.current.stop(); } catch (_) {}
    }
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    setVoiceStep('idle'); setTranscript(''); setEditedTranscript('');
    setDurationMs(0); setVoiceError(''); setClassification(null);
    setSelectedTypeId(''); setCreatedTicketNumber('');
  }, [stopDurationTimer]);

  const closeVoiceModal = useCallback(() => { resetVoice(); setVoiceModalOpen(false); }, [resetVoice]);

  // ─────────────────────────────────────────────────────────────────────────
  // Approval / Notice handlers (unchanged)
  // ─────────────────────────────────────────────────────────────────────────

  const handleApprove = async () => {
    if (!approvalTicket) return;
    setApprovalSubmitting(true);
    try {
      await tenantApproveCompletion(approvalTicket.id, true, userId);
      setApprovalTicket(null); await loadPending();
      Alert.alert('✅ Approved!', 'The ticket has been closed.');
    } catch (e: any) { Alert.alert('Error', e?.message || 'Failed to approve'); }
    finally { setApprovalSubmitting(false); }
  };

  const handleReject = async () => {
    if (!approvalTicket || !rejectReason.trim()) return;
    setApprovalSubmitting(true);
    try {
      await tenantApproveCompletion(approvalTicket.id, false, userId, rejectReason);
      setApprovalTicket(null); setShowRejectInput(false); setRejectReason('');
      await loadPending();
      Alert.alert('Sent Back', 'Ticket returned to technician.');
    } catch (e: any) { Alert.alert('Error', e?.message || 'Failed to reject'); }
    finally { setApprovalSubmitting(false); }
  };

  const handleSubmitNotice = async () => {
    if (!noticeExitDate.trim()) { Alert.alert('Required', 'Please enter your expected move-out date.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(noticeExitDate.trim())) { Alert.alert('Invalid Date', 'Please enter date in YYYY-MM-DD format.'); return; }
    if (!tenantLocation?.tenantId || !tenantLocation?.allotmentId || !tenantLocation?.bedId) { Alert.alert('Error', 'Your location details are missing.'); return; }
    setNoticeSaving(true);
    try {
      await recordNotice({ allotmentId: tenantLocation.allotmentId, tenantId: tenantLocation.tenantId, bedId: tenantLocation.bedId, exitDate: noticeExitDate.trim(), notes: noticeNotes.trim() || undefined });
      Alert.alert('✅ Notice Submitted', 'Management will contact you shortly.');
      setNoticeModalOpen(false); setNoticeExitDate(''); setNoticeNotes('');
      await loadNotices();
    } catch (e: any) { Alert.alert('Error', e?.message || 'Failed to submit notice.'); }
    finally { setNoticeSaving(false); }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Voice modal renderers
  // ─────────────────────────────────────────────────────────────────────────

  const renderVoiceRecord = () => {
    const recAvailable = canRecord();
    return (
      <View style={{ alignItems: 'center', paddingVertical: 28, gap: 20 }}>

        {!recAvailable && voiceStep === 'idle' && (
          <View style={{ backgroundColor: '#EEF2FF', borderRadius: 12, padding: 12, width: '100%', borderWidth: 1, borderColor: '#C7D2FE', flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
            <Ionicons name="information-circle-outline" size={18} color="#6366F1" style={{ marginTop: 1 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#5B21B6', marginBottom: 2 }}>Voice not available on this browser</Text>
              <Text style={{ fontSize: 12, color: '#6D28D9', lineHeight: 18 }}>Tap the button below to type your complaint instead.</Text>
            </View>
          </View>
        )}

        <Text style={{ fontSize: 14, color: '#556274', textAlign: 'center', lineHeight: 22, paddingHorizontal: 16 }}>
          {voiceStep === 'idle'
            ? (recAvailable ? 'Tap the mic and describe your issue clearly.' : 'Tap below to type your issue.')
            : voiceStep === 'recording' ? 'Listening… tap Stop when done.'
            : 'Processing your voice…'}
        </Text>

        <View style={{ width: 100, height: 100, alignItems: 'center', justifyContent: 'center' }}>
          {voiceStep === 'recording' && <PulsingRing />}
          <TouchableOpacity
            onPress={voiceStep === 'recording' ? stopRecording : startRecording}
            disabled={voiceStep === 'processing'}
            style={{
              width: 80, height: 80, borderRadius: 40,
              backgroundColor: voiceStep === 'recording' ? '#DC2626' : '#312E81',
              alignItems: 'center', justifyContent: 'center',
              shadowColor: voiceStep === 'recording' ? '#DC2626' : '#312E81',
              shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8,
              opacity: voiceStep === 'processing' ? 0.6 : 1,
            }}
          >
            {voiceStep === 'processing'
              ? <ActivityIndicator color="#fff" />
              : <Ionicons name={voiceStep === 'recording' ? 'stop' : (recAvailable ? 'mic' : 'create-outline')} size={32} color="#fff" />
            }
          </TouchableOpacity>
        </View>

        {voiceStep === 'recording' && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#DC2626' }} />
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#DC2626' }}>
              {formatDuration(durationMs)}
            </Text>
          </View>
        )}

        {voiceStep === 'idle' && (
          <View style={{ width: '100%', gap: 6 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: '#6B7280', letterSpacing: 0.8, marginBottom: 2 }}>
              {recAvailable ? 'EXAMPLE PHRASES — tap to use' : 'COMMON ISSUES — tap to use'}
            </Text>
            {[
              'AC is not working in my room',
              'Water is leaking from the bathroom',
              'Room needs cleaning',
              'Door lock is broken',
              'WiFi is not connecting',
            ].map(phrase => (
              <TouchableOpacity
                key={phrase}
                onPress={() => moveToReview(phrase)}
                style={{ backgroundColor: 'rgba(49,46,129,0.05)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: 'rgba(49,46,129,0.12)' }}
              >
                <Text style={{ fontSize: 12, color: '#312E81' }}>"{phrase}"</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    );
  };

  const renderVoiceReview = () => {
    const confColors = CONFIDENCE_COLORS[classification?.confidence || 'fallback'];
    const selectedType = issueTypes.find(it => it.id === selectedTypeId);
    return (
      <View style={{ gap: 14 }}>
        {selectedType && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: confColors.bg, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: confColors.border }}>
            <Ionicons name="sparkles" size={16} color={confColors.text} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, fontWeight: '800', color: confColors.text, letterSpacing: 0.5 }}>AUTO-DETECTED CATEGORY</Text>
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#111827', marginTop: 1 }}>{selectedType.name}</Text>
              {classification?.matchedKeyword && <Text style={{ fontSize: 11, color: confColors.text }}>Keyword: "{classification.matchedKeyword}"</Text>}
            </View>
            <View style={{ backgroundColor: confColors.border, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
              <Text style={{ fontSize: 10, fontWeight: '800', color: confColors.text }}>{(classification?.confidence || 'fallback').toUpperCase()}</Text>
            </View>
          </View>
        )}

        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: '#556274' }}>
            {editedTranscript ? 'YOUR DESCRIPTION' : 'DESCRIBE YOUR ISSUE'}
          </Text>
          {!canRecord() && !editedTranscript && (
            <Text style={{ fontSize: 12, color: '#6B7280', marginTop: -2, marginBottom: 4 }}>
              Type in plain language — AI will detect the issue and assign a technician
            </Text>
          )}
          <TextInput
            value={editedTranscript} onChangeText={setEditedTranscript}
            multiline numberOfLines={4}
            placeholder="e.g. AC is not working in my room, water is leaking…"
            placeholderTextColor="#B8A8CC"
            autoFocus={!editedTranscript}
            style={{ backgroundColor: '#fff', borderRadius: 12, padding: 12, fontSize: 14, color: '#111827', borderWidth: 1.5, borderColor: editedTranscript ? '#E5E7EB' : '#C7D2FE', minHeight: 90, textAlignVertical: 'top', lineHeight: 22 }}
          />
        </View>

        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: '#556274' }}>
            ISSUE CATEGORY{classification?.confidence === 'fallback' ? ' — please confirm' : ''}
          </Text>
          {loadingIssueTypes
            ? <ActivityIndicator color="#312E81" />
            : issueTypes.map(it => (
              <TouchableOpacity
                key={it.id} onPress={() => setSelectedTypeId(it.id)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: selectedTypeId === it.id ? 'rgba(49,46,129,0.08)' : '#fff', borderRadius: 10, padding: 11, borderWidth: 1.5, borderColor: selectedTypeId === it.id ? '#312E81' : '#E5E7EB' }}
              >
                <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: selectedTypeId === it.id ? '#312E81' : '#94A3B8', backgroundColor: selectedTypeId === it.id ? '#312E81' : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                  {selectedTypeId === it.id && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} />}
                </View>
                <Text style={{ fontSize: 14, flex: 1, fontWeight: selectedTypeId === it.id ? '700' : '400', color: selectedTypeId === it.id ? '#111827' : '#556274' }}>{it.name}</Text>
                {it.priority && <Text style={{ fontSize: 11, color: '#6B7280' }}>{it.priority}</Text>}
              </TouchableOpacity>
            ))
          }
        </View>

        <TouchableOpacity onPress={resetVoice} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 4 }}>
          <Ionicons name="refresh" size={13} color="#312E81" />
          <Text style={{ fontSize: 13, color: '#312E81', fontWeight: '600' }}>Record Again</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderVoiceSuccess = () => (
    <View style={{ alignItems: 'center', paddingVertical: 32, gap: 16 }}>
      <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: '#dcfce7', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#86efac' }}>
        <Ionicons name="checkmark-circle" size={44} color="#16a34a" />
      </View>
      <Text style={{ fontSize: 20, fontWeight: '800', color: '#111827' }}>Ticket Raised!</Text>
      {createdTicketNumber ? (
        <View style={{ backgroundColor: 'rgba(49,46,129,0.08)', borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderColor: 'rgba(49,46,129,0.2)' }}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: '#312E81', letterSpacing: 1 }}>{createdTicketNumber}</Text>
        </View>
      ) : null}
      <Text style={{ fontSize: 13, color: '#556274', textAlign: 'center', lineHeight: 20, paddingHorizontal: 12 }}>
        Your {classification?.issueTypeName || 'maintenance'} request has been logged. Our team will respond shortly.
      </Text>
      <TouchableOpacity onPress={closeVoiceModal} style={{ backgroundColor: '#312E81', borderRadius: 12, paddingHorizontal: 36, paddingVertical: 14, marginTop: 4 }}>
        <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>Done</Text>
      </TouchableOpacity>
    </View>
  );

  const renderVoiceError = () => (
    <View style={{ alignItems: 'center', paddingVertical: 28, gap: 14 }}>
      <View style={{ width: 68, height: 68, borderRadius: 34, backgroundColor: '#FEE2E2', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FECACA' }}>
        <Ionicons name="alert-circle" size={38} color="#DC2626" />
      </View>
      <Text style={{ fontSize: 17, fontWeight: '800', color: '#111827' }}>Something Went Wrong</Text>
      <Text style={{ fontSize: 13, color: '#DC2626', textAlign: 'center', lineHeight: 20, paddingHorizontal: 12 }}>{voiceError || 'An unexpected error occurred.'}</Text>
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 4 }}>
        <TouchableOpacity onPress={() => { setVoiceError(''); setVoiceStep('idle'); }} style={{ backgroundColor: '#312E81', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 }}>
          <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>Try Again</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={closeVoiceModal} style={{ backgroundColor: '#F3F0F7', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, borderWidth: 1, borderColor: '#E5E7EB' }}>
          <Text style={{ color: '#556274', fontWeight: '700', fontSize: 14 }}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const voiceModalTitle =
    voiceStep === 'review' && !canRecord() ? 'Raise a Complaint' :
    voiceStep === 'review'     ? 'Review & Confirm' :
    voiceStep === 'submitting' ? 'Creating Ticket…' :
    voiceStep === 'success'    ? 'Success!' :
    voiceStep === 'error'      ? 'Error' : 'Voice Ticket';

  const canSubmit = voiceStep === 'review' && editedTranscript.trim().length >= 3 && !!selectedTypeId;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>

        {/* ── Header with RAISE COMPLAINT button ── */}
        <View style={[glass.header, { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg }]}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: fontSize.xs, color: '#6B7280', fontWeight: '600', letterSpacing: 0.5 }}>WELCOME</Text>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#111827', letterSpacing: -0.3 }}>{user?.userName || 'Tenant'}</Text>
          </View>
          {/* ── VOICE BUTTON — this is what opens the voice modal ── */}
          <TouchableOpacity
            onPress={() => { resetVoice(); setVoiceModalOpen(true); }}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              backgroundColor: '#312E81', paddingHorizontal: 14,
              paddingVertical: 9, borderRadius: 999,
              shadowColor: '#312E81', shadowOpacity: 0.35,
              shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 5,
            }}
          >
            <Ionicons name="mic" size={16} color="#fff" />
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: fontSize.sm }}>Raise Complaint</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ padding: spacing.xl, paddingBottom: 20, gap: 16 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#312E81']} />}
        >

          {/* Account Not Linked banner */}
          {accountNotLinked && !detailsLoading && (
            <View style={{ backgroundColor: '#FFF3CD', borderRadius: borderRadius.lg, padding: spacing.lg, borderWidth: 1.5, borderColor: '#F9A825', flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
              <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#FFF8E1', borderWidth: 1.5, borderColor: '#F9A825', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Ionicons name="warning-outline" size={20} color="#8B6914" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: '#8B6914', marginBottom: 4 }}>Account Not Linked</Text>
                <Text style={{ fontSize: fontSize.xs, color: '#A07C2A', lineHeight: 18 }}>
                  Your phone number ({normalizedPhone || user?.phone || 'unknown'}) is not linked to a tenant record. Please contact your property manager.
                </Text>
              </View>
            </View>
          )}

          {/* Raise Complaint card (always visible) */}
          <TouchableOpacity
            onPress={() => { resetVoice(); setVoiceModalOpen(true); }}
            style={{ backgroundColor: '#EEF2FF', borderRadius: borderRadius.lg, padding: spacing.lg, borderWidth: 1.5, borderColor: '#C7D2FE', flexDirection: 'row', alignItems: 'center', gap: 14 }}
          >
            <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: '#312E81', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="mic" size={24} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: '#4C1D95' }}>Raise a Complaint</Text>
              <Text style={{ fontSize: fontSize.xs, color: '#6D28D9', marginTop: 2 }}>
                {canRecord() ? 'Tap to record your voice complaint' : 'Tap to describe your issue'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#312E81" />
          </TouchableOpacity>

          {/* Dues + Open Tickets stat tiles (parity with web TenantDashboard) */}
          <View style={{ flexDirection: 'row', gap: 12 }}>
            {/* Total Due */}
            <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 14, padding: spacing.lg, borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.5)' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <Ionicons name="wallet-outline" size={14} color={totalDue > 0 ? '#DC2626' : '#16a34a'} />
                <Text style={{ fontSize: 10, fontWeight: '800', color: '#6B7280', letterSpacing: 0.8 }}>TOTAL DUE</Text>
              </View>
              <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: totalDue > 0 ? '#DC2626' : '#16a34a' }} numberOfLines={1}>
                ₹{Number(totalDue).toLocaleString('en-IN')}
              </Text>
              <Text style={{ fontSize: fontSize.xs, color: '#6B7280', marginTop: 2 }}>
                {pendingInvoiceCount} pending {pendingInvoiceCount === 1 ? 'invoice' : 'invoices'}
              </Text>
            </View>
            {/* Open Tickets */}
            <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 14, padding: spacing.lg, borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.5)' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <Ionicons name="construct-outline" size={14} color="#312E81" />
                <Text style={{ fontSize: 10, fontWeight: '800', color: '#6B7280', letterSpacing: 0.8 }}>OPEN TICKETS</Text>
              </View>
              <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#111827' }}>{openTicketCount}</Text>
              <Text style={{ fontSize: fontSize.xs, color: '#6B7280', marginTop: 2 }}>
                {openTicketCount === 0 ? 'All resolved' : 'In progress'}
              </Text>
            </View>
          </View>

          {/* Pending Approval Alerts */}
          <View onLayout={captureSectionOffset('more')} style={{ gap: 8 }}>
            {pendingTickets.length > 0 && (
            <View style={{ gap: 8 }}>
              <Text style={{ fontSize: fontSize.xs, fontWeight: '800', color: '#EA580C', letterSpacing: 0.5 }}>⏳ ACTION REQUIRED — PLEASE REVIEW</Text>
              {pendingTickets.map(t => (
                <TouchableOpacity
                  key={t.id}
                  onPress={() => { setApprovalTicket(t); setShowRejectInput(false); setRejectReason(''); }}
                  style={{ backgroundColor: '#FFEDD5', borderRadius: borderRadius.lg, padding: spacing.md, borderWidth: 1.5, borderColor: '#EA580C', flexDirection: 'row', alignItems: 'center', gap: 10 }}
                >
                  <Ionicons name="hourglass-outline" size={22} color="#EA580C" />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: '#EA580C' }}>{t.ticket_number} — Issue Resolved</Text>
                    <Text style={{ fontSize: fontSize.xs, color: '#9A3412', marginTop: 2 }}>{t.issue_type_name || t.issue_type}{t.issue_subtype ? ` · ${t.issue_subtype}` : ''} — tap to approve or reject</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color="#EA580C" />
                </TouchableOpacity>
              ))}
            </View>
            )}
          </View>

          {/* Tenant Profile Card */}
          <View onLayout={captureSectionOffset('staying')}>
          {detailsLoading && !tenantDetails ? (
            <View style={{ backgroundColor: 'rgba(255,255,255,0.6)', borderRadius: 14, padding: spacing.lg, alignItems: 'center', gap: 8, borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.45)' }}>
              <ActivityIndicator size="small" color="#312E81" />
              <Text style={{ fontSize: fontSize.xs, color: '#6B7280' }}>Loading your details…</Text>
            </View>
          ) : tenantDetails?.tenant ? (
            <View style={{ backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 14, borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.5)', overflow: 'hidden' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.lg, gap: 14, borderBottomWidth: 0.5, borderBottomColor: 'rgba(49,46,129,0.12)', backgroundColor: 'rgba(49,46,129,0.05)' }}>
                <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: '#312E81', alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontSize: 22, fontWeight: '800', color: '#fff' }}>{(tenantDetails.tenant.full_name || user?.userName || 'T')[0].toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: '#111827' }}>{tenantDetails.tenant.full_name || user?.userName}</Text>
                  <Text style={{ fontSize: fontSize.xs, color: '#556274', marginTop: 2 }}>{tenantDetails.tenant.phone}</Text>
                  {tenantDetails.tenant.staying_status && (
                    <View style={{ alignSelf: 'flex-start', marginTop: 5, backgroundColor: '#dcfce7', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: '#16a34a' }}>
                        {tenantDetails.tenant.staying_status.toUpperCase().replace('-', ' ')}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            </View>
          ) : null}
          </View>

          {/* Accommodation Card */}
          <View onLayout={captureSectionOffset('onboarding')}>
          {(tenantDetails?.allotment || tenantLocation) && (
            <View style={{ backgroundColor: 'rgba(255,255,255,0.6)', borderRadius: 14, padding: spacing.lg, borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.45)' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.sm }}>
                <Ionicons name="home-outline" size={14} color="#312E81" />
                <Text style={{ fontSize: 10, fontWeight: '800', color: '#6B7280', letterSpacing: 1 }}>ACCOMMODATION</Text>
              </View>
              {[
                { label: 'Property',     value: tenantDetails?.allotment?.properties?.property_name ?? tenantLocation?.propertyName },
                { label: 'Apartment',    value: tenantDetails?.allotment?.apartments?.apartment_code ?? tenantLocation?.unitNumber },
                { label: 'Bed',          value: tenantDetails?.allotment?.beds?.bed_code             ?? tenantLocation?.bedCode },
                { label: 'Monthly Rent', value: tenantDetails?.allotment?.monthly_rental != null ? `₹${Number(tenantDetails.allotment.monthly_rental).toLocaleString('en-IN')}` : tenantLocation?.monthlyRent ? `₹${tenantLocation.monthlyRent.toLocaleString('en-IN')}` : null },
                { label: 'Check-in',     value: (tenantDetails?.allotment?.onboarding_date || tenantLocation?.checkInDate) ? formatDate(tenantDetails?.allotment?.onboarding_date || tenantLocation?.checkInDate, '') : null },
              ].filter(r => r.value).map(row => (
                <View key={row.label} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                  <Text style={{ fontSize: fontSize.sm, color: '#556274' }}>{row.label}</Text>
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#111827', flex: 1, textAlign: 'right', marginLeft: 16 }} numberOfLines={1}>{row.value}</Text>
                </View>
              ))}
            </View>
          )}
          </View>

          {/* Announcements (parity with web TenantDashboard) */}
          {announcements.length > 0 && (
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="megaphone-outline" size={14} color="#312E81" />
                <Text style={{ fontSize: 10, fontWeight: '800', color: '#6B7280', letterSpacing: 1 }}>ANNOUNCEMENTS</Text>
              </View>
              {announcements.map((a: any) => {
                const key = String(a.id ?? a._id);
                const expanded = expandedAnnouncement === key;
                const when = a.published_at || a.created_at;
                return (
                  <TouchableOpacity
                    key={key}
                    activeOpacity={0.8}
                    onPress={() => setExpandedAnnouncement(expanded ? null : key)}
                    style={{ backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 14, padding: spacing.lg, borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.5)', gap: 4 }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={{ flex: 1, fontSize: fontSize.sm, fontWeight: '800', color: '#111827' }} numberOfLines={expanded ? undefined : 1}>
                        {a.title || 'Announcement'}
                      </Text>
                      <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color="#6B7280" />
                    </View>
                    {when ? (
                      <Text style={{ fontSize: fontSize.xs, color: '#6B7280' }}>{formatDate(when, '')}</Text>
                    ) : null}
                    {a.content ? (
                      <Text style={{ fontSize: fontSize.sm, color: '#556274', marginTop: 2, lineHeight: 20 }} numberOfLines={expanded ? undefined : 2}>
                        {a.content}
                      </Text>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Notice read-only */}
          <View onLayout={captureSectionOffset('notices')}>
          {tenantNotices.length > 0 && (
            <View style={{ gap: 8 }}>
              <Text style={{ fontSize: fontSize.xs, fontWeight: '800', color: '#8B6914', letterSpacing: 0.5 }}>📋 YOUR NOTICE</Text>
              {tenantNotices.map((n: any) => (
                <View key={n._id || n.id} style={{ backgroundColor: 'rgba(255,248,225,0.95)', borderRadius: borderRadius.lg, padding: spacing.lg, borderWidth: 1.5, borderColor: '#F9A825', gap: 6 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <Ionicons name="notifications" size={18} color="#8B6914" />
                    <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: '#8B6914' }}>Notice Recorded</Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ fontSize: fontSize.sm, color: '#8B6914' }}>Expected Exit</Text>
                    <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#DC2626' }}>{(n.exit_date ?? n.exitDate) ? formatDate(n.exit_date ?? n.exitDate, '—') : '—'}</Text>
                  </View>
                  {n.notes ? <Text style={{ fontSize: fontSize.xs, color: '#4B3A2A' }}>{n.notes}</Text> : null}
                </View>
              ))}
            </View>
          )}
          </View>

          {/* Move-out notice button */}
          {tenantLocation && tenantNotices.length === 0 && (
            <TouchableOpacity
              onPress={() => setNoticeModalOpen(true)}
              style={{ backgroundColor: 'rgba(255,248,225,0.8)', borderRadius: borderRadius.lg, padding: spacing.md, borderWidth: 1, borderColor: '#F9A825', flexDirection: 'row', alignItems: 'center', gap: 10 }}
            >
              <Ionicons name="notifications-outline" size={20} color="#8B6914" />
              <Text style={{ fontSize: fontSize.sm, fontWeight: '600', color: '#8B6914', flex: 1 }}>Planning to move out? Submit a notice</Text>
              <Ionicons name="chevron-forward" size={16} color="#8B6914" />
            </TouchableOpacity>
          )}

        </ScrollView>

        {/* ══════════════════════════════════════════════════════════════
            VOICE MODAL
        ══════════════════════════════════════════════════════════════ */}
        <Modal visible={voiceModalOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={closeVoiceModal}>
          <SafeAreaView style={{ flex: 1, backgroundColor: '#F8FAFC' }} edges={['top', 'bottom']}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#E5E7EB', backgroundColor: '#fff' }}>
              <TouchableOpacity onPress={closeVoiceModal} style={{ marginRight: 12, padding: 4 }}>
                <Ionicons name="close" size={24} color="#111827" />
              </TouchableOpacity>
              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="mic" size={18} color="#312E81" />
                <Text style={{ fontSize: 17, fontWeight: '800', color: '#111827' }}>{voiceModalTitle}</Text>
              </View>
            </View>

            <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
              {(voiceStep === 'idle' || voiceStep === 'recording' || voiceStep === 'processing') && renderVoiceRecord()}
              {voiceStep === 'review'     && renderVoiceReview()}
              {voiceStep === 'submitting' && (
                <View style={{ alignItems: 'center', paddingVertical: 48, gap: 16 }}>
                  <ActivityIndicator size="large" color="#312E81" />
                  <Text style={{ fontSize: 16, fontWeight: '700', color: '#111827' }}>Creating your ticket…</Text>
                </View>
              )}
              {voiceStep === 'success' && renderVoiceSuccess()}
              {voiceStep === 'error'   && renderVoiceError()}
            </ScrollView>

            {voiceStep === 'review' && (
              <View style={{ padding: 20, paddingBottom: Platform.OS === 'ios' ? 8 : 20, borderTopWidth: 1, borderTopColor: '#E5E7EB', backgroundColor: '#fff' }}>
                <TouchableOpacity
                  onPress={handleVoiceSubmit} disabled={!canSubmit}
                  style={{ backgroundColor: canSubmit ? '#312E81' : '#94A3B8', borderRadius: 14, paddingVertical: 16, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
                >
                  <Ionicons name="paper-plane-outline" size={18} color="#fff" />
                  <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>Raise Ticket</Text>
                </TouchableOpacity>
              </View>
            )}
          </SafeAreaView>
        </Modal>

        {/* ══════════════════════════════════════════════════════════════
            APPROVAL MODAL
        ══════════════════════════════════════════════════════════════ */}
        <Modal visible={!!approvalTicket} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setApprovalTicket(null)}>
          <SafeAreaView style={{ flex: 1, backgroundColor: '#F8FAFC' }} edges={['top', 'bottom']}>
            <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
              <TouchableOpacity onPress={() => setApprovalTicket(null)} style={{ marginRight: 12 }}>
                <Ionicons name="close" size={24} color="#111827" />
              </TouchableOpacity>
              <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#111827' }}>Review Completed Work</Text>
            </View>
            <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: 16 }}>
              {approvalTicket && (
                <>
                  <View style={{ backgroundColor: '#FFEDD5', borderRadius: borderRadius.lg, padding: spacing.md, borderWidth: 1, borderColor: '#EA580C' }}>
                    <Text style={{ fontSize: fontSize.xs, fontWeight: '800', color: '#EA580C', marginBottom: 6 }}>WORK COMPLETED</Text>
                    <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: '#111827' }}>{approvalTicket.ticket_number}</Text>
                    <Text style={{ fontSize: fontSize.sm, color: '#4B5563', marginTop: 4 }}>{approvalTicket.issue_type_name || approvalTicket.issue_type}{approvalTicket.issue_subtype ? ` · ${approvalTicket.issue_subtype}` : ''}</Text>
                    {approvalTicket.description && <Text style={{ fontSize: fontSize.sm, color: '#556274', marginTop: 4 }}>{approvalTicket.description}</Text>}
                  </View>
                  <Text style={{ fontSize: fontSize.sm, color: '#4B5563', textAlign: 'center', lineHeight: 20 }}>Approve to close the ticket, or reject if the issue is not resolved.</Text>
                  {showRejectInput && (
                    <TextInput
                      style={{ backgroundColor: '#fff', borderRadius: borderRadius.md, padding: spacing.md, fontSize: fontSize.md, color: '#111827', borderWidth: 1, borderColor: '#DC2626', minHeight: 80, textAlignVertical: 'top' }}
                      placeholder="Describe why the issue is not resolved..." placeholderTextColor="#9CA3AF"
                      value={rejectReason} onChangeText={setRejectReason} multiline
                    />
                  )}
                  {!showRejectInput && (
                    <TouchableOpacity disabled={approvalSubmitting} onPress={handleApprove} style={{ backgroundColor: '#16A34A', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center', opacity: approvalSubmitting ? 0.6 : 1 }}>
                      {approvalSubmitting ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>✅ Yes, Issue is Fixed — Approve</Text>}
                    </TouchableOpacity>
                  )}
                  {!showRejectInput ? (
                    <TouchableOpacity onPress={() => setShowRejectInput(true)} style={{ backgroundColor: '#FEE2E2', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#DC2626' }}>
                      <Text style={{ color: '#DC2626', fontWeight: '800', fontSize: fontSize.md }}>❌ Issue Not Fixed — Reject</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity disabled={approvalSubmitting || !rejectReason.trim()} onPress={handleReject} style={{ backgroundColor: '#DC2626', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center', opacity: (!rejectReason.trim() || approvalSubmitting) ? 0.5 : 1 }}>
                      {approvalSubmitting ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>Confirm Rejection</Text>}
                    </TouchableOpacity>
                  )}
                </>
              )}
            </ScrollView>
          </SafeAreaView>
        </Modal>

        {/* ══════════════════════════════════════════════════════════════
            NOTICE MODAL
        ══════════════════════════════════════════════════════════════ */}
        <Modal visible={noticeModalOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { if (!noticeSaving) { setNoticeModalOpen(false); setNoticeExitDate(''); setNoticeNotes(''); } }}>
          <SafeAreaView style={{ flex: 1, backgroundColor: '#FFFDF5' }} edges={['top', 'bottom']}>
            <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#F0E4B0' }}>
              <TouchableOpacity onPress={() => { if (!noticeSaving) { setNoticeModalOpen(false); setNoticeExitDate(''); setNoticeNotes(''); } }} style={{ marginRight: 12 }}>
                <Ionicons name="close" size={24} color="#111827" />
              </TouchableOpacity>
              <Ionicons name="notifications-outline" size={20} color="#8B6914" style={{ marginRight: 8 }} />
              <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#111827', flex: 1 }}>Record Move-Out Notice</Text>
            </View>
            <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: 20 }}>
              <View style={{ gap: 8 }}>
                <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#111827' }}>Expected Move-Out Date <Text style={{ color: '#DC2626' }}>*</Text></Text>
                <DateField value={noticeExitDate} onChange={setNoticeExitDate} placeholder="Select move-out date" />
              </View>
              <View style={{ gap: 8 }}>
                <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#111827' }}>Additional Notes <Text style={{ color: '#6B7280', fontWeight: '400' }}>(optional)</Text></Text>
                <TextInput value={noticeNotes} onChangeText={setNoticeNotes} placeholder="Any specific reason or request…" placeholderTextColor="#6B7280" multiline numberOfLines={4} style={{ backgroundColor: '#fff', borderRadius: borderRadius.md, padding: spacing.md, fontSize: fontSize.md, color: '#111827', borderWidth: 1.5, borderColor: '#E5E7EB', minHeight: 100, textAlignVertical: 'top' }} />
              </View>
              <TouchableOpacity onPress={handleSubmitNotice} disabled={noticeSaving || !noticeExitDate.trim()} style={{ backgroundColor: noticeSaving || !noticeExitDate.trim() ? '#D4C4A0' : '#8B6914', borderRadius: borderRadius.lg, paddingVertical: 16, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
                {noticeSaving ? <ActivityIndicator color="#fff" /> : <><Ionicons name="checkmark-circle-outline" size={20} color="#fff" /><Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>Submit Notice</Text></>}
              </TouchableOpacity>
            </ScrollView>
          </SafeAreaView>
        </Modal>

      </SafeAreaView>
    </GlassBackground>
  );
}
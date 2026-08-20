/**
 * WhatsAppLogsScreen.tsx — mobile port of web WhatsAppDeliveryHistoryCard.
 * Lists recent WhatsApp send jobs; tap a job to expand its per-recipient
 * deliveries. Resend/resume writes (edge-function) are wired via
 * resumeWhatsappJob / resendAllFailedWhatsappDeliveries / resendWhatsappDelivery.
 * Data: sb.listWhatsappJobs({ jobType }), sb.listWhatsappJobDeliveries(jobId).
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl, Alert, Image, Modal, TextInput, StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import * as sb from '../lib/supabaseService';
import { GlassBackground } from '../components/shared';

const JOB_TYPE_OPTIONS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'announcement', label: 'Announcements' },
  { key: 'invoice', label: 'Invoices' },
  { key: 'receipt', label: 'Receipts' },
];

const STATUS_COLOR: Record<string, string> = {
  completed: '#16a34a', success: '#16a34a', sent: '#16a34a', delivered: '#16a34a',
  running: '#2563EB', pending: '#2563EB', queued: '#2563EB',
  failed: '#DC2626', error: '#DC2626',
  skipped: '#D97706',
};
const statusColor = (s: string) => STATUS_COLOR[(s || '').toLowerCase()] || '#2563EB';

// Web parity (WhatsAppDeliveryHistoryCard.tsx:82-100): auto-resume stalled send jobs.
const STALL_MS = 90_000;              // no progress (updatedAt) for >90s ⇒ treat as stalled
const RESUME_COOLDOWN_MS = 120_000;   // per-job 2-min cooldown so we don't spam resume
const AUTO_RESUME_INTERVAL_MS = 30_000; // re-check loaded jobs every ~30s while focused

function fmtTs(s: string | null) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function WhatsAppLogsScreen() {
  const navigation = useNavigation<any>();
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [dLoading, setDLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // id of the in-flight write
  const [jobType, setJobType] = useState('all');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [searching, setSearching] = useState(false);
  const didAutoExpand = useRef(false); // auto-expand the first failing/running job once per mount
  const [editPhone, setEditPhone] = useState<{ deliveryId: string; tenantId: string; jobId: string } | null>(null);
  const [phoneInput, setPhoneInput] = useState('');
  // Auto-resume bookkeeping (read from an interval, so mirror live state into refs).
  const lastAutoResumeRef = useRef<Record<string, number>>({}); // jobId -> last auto-resume ms
  const jobsRef = useRef<any[]>([]);
  const busyRef = useRef<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const r = await sb.listWhatsappJobs(jobType === 'all' ? {} : { jobType });
      setJobs(Array.isArray(r) ? r : []);
    } catch {
      setJobs([]);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [jobType]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Mirror live state into refs so the auto-resume interval always sees fresh values
  // without re-arming the timer on every render.
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);

  // Debounced message-level search across all jobs (web parity: name / phone /
  // invoice-receipt label). Empty/short term → back to the job list.
  useEffect(() => {
    const term = search.trim();
    if (term.length < 2) { setSearchResults(null); setSearching(false); return; }
    setSearching(true);
    const h = setTimeout(async () => {
      try {
        const r = await sb.searchWhatsappDeliveries(term);
        setSearchResults(Array.isArray(r) ? r : []);
      } catch { setSearchResults([]); }
      finally { setSearching(false); }
    }, 350);
    return () => clearTimeout(h);
  }, [search]);
  useEffect(() => { busyRef.current = busy; }, [busy]);

  // Silent refetch (no spinner / no pull-to-refresh flag) — used after an auto-resume so
  // the stall clock (updatedAt) refreshes without disturbing the user's view.
  const quietRefresh = useCallback(async () => {
    try {
      const r = await sb.listWhatsappJobs(jobType === 'all' ? {} : { jobType });
      setJobs(Array.isArray(r) ? r : []);
    } catch { /* ignore — next interval / manual refresh will retry */ }
  }, [jobType]);

  // Web parity (WhatsAppDeliveryHistoryCard.tsx:82-100): while focused, periodically
  // re-trigger any running/pending job that has made no progress for >STALL_MS, honouring
  // a per-job 2-minute cooldown so a genuinely-stuck job isn't spammed. Skipped entirely
  // while a manual write is in flight so it never fights the user's own action.
  const autoResumeTick = useCallback(async () => {
    if (busyRef.current) return; // a manual resume/resend is running — stay out of its way
    const now = Date.now();
    const list = Array.isArray(jobsRef.current) ? jobsRef.current : [];
    let didResume = false;
    for (const job of list) {
      try {
        if (!job || !job.id) continue;
        const st = String(job.status || '').toLowerCase();
        if (st !== 'running' && st !== 'pending') continue;
        if (!Number(job.totalCount)) continue;
        const updatedAt = job.updatedAt ? new Date(job.updatedAt).getTime() : 0;
        const stalledMs = now - (Number.isFinite(updatedAt) ? updatedAt : 0);
        const lastResume = lastAutoResumeRef.current[job.id] ?? 0;
        if (stalledMs > STALL_MS && now - lastResume > RESUME_COOLDOWN_MS) {
          lastAutoResumeRef.current[job.id] = now; // start cooldown before awaiting
          await sb.resumeWhatsappJob(job.id);
          didResume = true;
        }
      } catch { /* one bad job shouldn't stop the rest */ }
    }
    if (didResume) await quietRefresh();
  }, [quietRefresh]);

  // Run the checker on an interval only while the screen is focused; tear it down on
  // blur/unmount so it never runs in the background.
  useFocusEffect(useCallback(() => {
    const id = setInterval(() => { void autoResumeTick(); }, AUTO_RESUME_INTERVAL_MS);
    return () => clearInterval(id);
  }, [autoResumeTick]));

  const loadDeliveries = useCallback(async (jobId: string) => {
    setDLoading(true);
    try {
      const r = await sb.listWhatsappJobDeliveries(jobId);
      setDeliveries(Array.isArray(r) ? r : []);
    } catch {
      setDeliveries([]);
    } finally {
      setDLoading(false);
    }
  }, []);

  // Web parity: once loaded, auto-expand the first job with failures (else the first
  // running/pending job) so problems surface immediately. Fires once per mount so it
  // never fights a user's manual expand/collapse on subsequent focus refreshes.
  useEffect(() => {
    if (didAutoExpand.current || !jobs.length) return;
    const target = jobs.find(j => (j.failedCount || 0) > 0)
      || jobs.find(j => j.status === 'running' || j.status === 'pending');
    if (target) {
      didAutoExpand.current = true;
      setExpandedId(target.id);
      loadDeliveries(target.id);
    }
  }, [jobs, loadDeliveries]);

  const toggleExpand = useCallback(async (jobId: string) => {
    if (expandedId === jobId) { setExpandedId(null); setDeliveries([]); return; }
    setExpandedId(jobId);
    setDeliveries([]);
    await loadDeliveries(jobId);
  }, [expandedId, loadDeliveries]);

  // After a write, refresh both the job list and the open delivery list.
  const afterWrite = useCallback(async (jobId: string) => {
    await load(true);
    if (expandedId === jobId) await loadDeliveries(jobId);
  }, [load, expandedId, loadDeliveries]);

  const doResume = useCallback((jobId: string) => {
    Alert.alert('Resume job', 'Re-queue this job and re-send stuck messages?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Resume', onPress: async () => {
        setBusy('resume:' + jobId);
        try {
          const r = await sb.resumeWhatsappJob(jobId);
          if (r?.ok === false) Alert.alert('Resume failed', r.reason || 'Unknown error');
        } catch (e: any) {
          Alert.alert('Resume failed', e?.message || 'Unknown error');
        } finally { setBusy(null); await afterWrite(jobId); }
      } },
    ]);
  }, [afterWrite]);

  const doResendAll = useCallback((jobId: string) => {
    Alert.alert('Resend failed', 'Resend all failed/pending messages in this job?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Resend', onPress: async () => {
        setBusy('resendAll:' + jobId);
        try {
          const r = await sb.resendAllFailedWhatsappDeliveries(jobId);
          if (r?.ok === false) Alert.alert('Resend failed', r.reason || 'Unknown error');
          else Alert.alert('Queued', `Resending ${r?.attempted ?? 0} message(s)…`);
        } catch (e: any) {
          Alert.alert('Resend failed', e?.message || 'Unknown error');
        } finally { setBusy(null); await afterWrite(jobId); }
      } },
    ]);
  }, [afterWrite]);

  const doResendOne = useCallback(async (deliveryId: string, jobId: string) => {
    setBusy('one:' + deliveryId);
    try {
      const r = await sb.resendWhatsappDelivery(deliveryId);
      if (r?.ok === false) Alert.alert('Resend failed', r.reason || 'Unknown error');
    } catch (e: any) {
      Alert.alert('Resend failed', e?.message || 'Unknown error');
    } finally { setBusy(null); await afterWrite(jobId); }
  }, [afterWrite]);

  // Fix a failed delivery caused by a wrong number: save a corrected tenant phone, then resend.
  const doEditPhoneSave = useCallback(async () => {
    if (!editPhone) return;
    const phone = phoneInput.trim();
    if (!phone) { Alert.alert('Enter a number', 'Please enter a valid phone number.'); return; }
    const { deliveryId, tenantId, jobId } = editPhone;
    setBusy('phone:' + deliveryId);
    try {
      const r = await sb.updateTenantPhoneAndResend(tenantId, phone, deliveryId);
      if (r?.ok === false) { Alert.alert('Could not update', r.reason || 'Unknown error'); return; }
      setEditPhone(null); setPhoneInput('');
      Alert.alert(r?.resent ? 'Number updated' : 'Number saved',
        r?.resent ? 'Saved the new number and re-queued the message.' : (r?.reason || 'Saved the new number.'));
    } catch (e: any) {
      Alert.alert('Could not update', e?.message || 'Unknown error');
    } finally { setBusy(null); await afterWrite(jobId); }
  }, [editPhone, phoneInput, afterWrite]);

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12 }}>
          <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center' }}>
            <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 }}>WhatsApp Logs</Text>
            <Text style={{ fontSize: 13, color: '#6B7280', fontWeight: '500', marginTop: 2 }}>Outbound messages</Text>
          </View>
        </View>

        {/* Search (name / phone / invoice-receipt no) */}
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#E5E7EB', paddingHorizontal: 12 }}>
            <Ionicons name="search" size={16} color="#9CA3AF" />
            <TextInput
              style={{ flex: 1, paddingVertical: 10, fontSize: 14, color: '#111827' }}
              value={search}
              onChangeText={setSearch}
              placeholder="Search name, phone, or invoice/receipt no…"
              placeholderTextColor="#9CA3AF"
              autoCapitalize="none"
            />
            {searching ? <ActivityIndicator size="small" color="#2563EB" />
              : search ? (
                <TouchableOpacity onPress={() => setSearch('')}><Ionicons name="close-circle" size={18} color="#9CA3AF" /></TouchableOpacity>
              ) : null}
          </View>
        </View>

        {/* Job-type filter */}
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
          {JOB_TYPE_OPTIONS.map(o => (
            <TouchableOpacity key={o.key} onPress={() => setJobType(o.key)}
              style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: jobType === o.key ? '#2563EB' : 'rgba(37,99,235,0.1)' }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: jobType === o.key ? '#fff' : '#2563EB' }}>{o.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading && !refreshing ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color="#2563EB" />
            <Text style={{ marginTop: 12, color: '#556274' }}>Loading WhatsApp logs…</Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#2563EB" />}
          >
            {searchResults !== null ? (
              searchResults.length === 0 ? (
                <View style={{ alignItems: 'center', paddingVertical: 60 }}>
                  <Ionicons name="search" size={48} color="rgba(37,99,235,0.18)" />
                  <Text style={{ marginTop: 12, color: '#6B7280' }}>No messages match “{search.trim()}”</Text>
                </View>
              ) : (
                <>
                  <Text style={{ fontSize: 12, color: '#6B7280', marginBottom: 8 }}>
                    {searchResults.length} message{searchResults.length === 1 ? '' : 's'} found
                  </Text>
                  {searchResults.map((d) => {
                    const lc = (s: any) => String(s || '').toLowerCase();
                    const canResend = ['failed', 'pending', 'error', 'skipped'].includes(lc(d.status));
                    return (
                      <View key={d.id} style={{ backgroundColor: '#fff', borderRadius: 12, marginBottom: 8, borderWidth: 1, borderColor: '#E5E7EB', padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <View style={{ flexShrink: 1, paddingRight: 8 }}>
                          <Text style={{ fontSize: 13, fontWeight: '700', color: '#111827' }} numberOfLines={1}>{d.tenantName || d.label || 'Recipient'}</Text>
                          <Text style={{ fontSize: 11, color: '#6B7280' }} numberOfLines={1}>
                            {d.phoneMasked || d.deliveryKind || ''}{d.label && d.tenantName ? ` · ${d.label}` : ''}{d.sentAt ? ` · ${fmtTs(d.sentAt)}` : ''}
                          </Text>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <Text style={{ fontSize: 11, fontWeight: '800', textTransform: 'capitalize', color: statusColor(d.status) }}>{d.status || '—'}</Text>
                          {['failed', 'skipped', 'error'].includes(lc(d.status)) && d.tenantId && (
                            <TouchableOpacity disabled={!!busy} onPress={() => { setEditPhone({ deliveryId: d.id, tenantId: d.tenantId, jobId: d.jobId }); setPhoneInput(''); }} style={{ padding: 4, opacity: busy ? 0.5 : 1 }}>
                              <Ionicons name="create-outline" size={16} color="#D97706" />
                            </TouchableOpacity>
                          )}
                          {canResend && (
                            <TouchableOpacity disabled={!!busy} onPress={() => doResendOne(d.id, d.jobId)} style={{ padding: 4, opacity: busy ? 0.5 : 1 }}>
                              {busy === 'one:' + d.id ? <ActivityIndicator size="small" color="#2563EB" /> : <Ionicons name="refresh" size={16} color="#2563EB" />}
                            </TouchableOpacity>
                          )}
                        </View>
                      </View>
                    );
                  })}
                </>
              )
            ) : jobs.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 60 }}>
                <Ionicons name="logo-whatsapp" size={56} color="rgba(37,99,235,0.18)" />
                <Text style={{ marginTop: 12, color: '#6B7280' }}>No send jobs yet</Text>
              </View>
            ) : jobs.map((job) => {
              const expanded = expandedId === job.id;
              const lc = (s: any) => String(s || '').toLowerCase();
              const renderRow = (d: any) => {
                const canResend = ['failed', 'pending', 'error', 'skipped'].includes(lc(d.status));
                return (
                  <View key={d.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
                    <View style={{ flexShrink: 1, paddingRight: 8 }}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: '#111827' }} numberOfLines={1}>{d.tenantName || d.label || 'Recipient'}</Text>
                      <Text style={{ fontSize: 10, color: '#6B7280' }}>{d.phoneMasked || d.deliveryKind || ''}{d.errorMessage ? ` · ${String(d.errorMessage).slice(0, 40)}` : d.sentAt ? ` · ${fmtTs(d.sentAt)}` : ''}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <Text style={{ fontSize: 11, fontWeight: '800', textTransform: 'capitalize', color: statusColor(d.status) }}>{d.status || '—'}</Text>
                      {['failed', 'skipped', 'error'].includes(lc(d.status)) && d.tenantId && (
                        <TouchableOpacity disabled={!!busy} onPress={() => { setEditPhone({ deliveryId: d.id, tenantId: d.tenantId, jobId: job.id }); setPhoneInput(''); }} style={{ padding: 4, opacity: busy ? 0.5 : 1 }}>
                          <Ionicons name="create-outline" size={16} color="#D97706" />
                        </TouchableOpacity>
                      )}
                      {canResend && (
                        <TouchableOpacity disabled={!!busy} onPress={() => doResendOne(d.id, job.id)} style={{ padding: 4, opacity: busy ? 0.5 : 1 }}>
                          {busy === 'one:' + d.id ? <ActivityIndicator size="small" color="#2563EB" /> : <Ionicons name="refresh" size={16} color="#2563EB" />}
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              };
              return (
                <View key={job.id} style={{ backgroundColor: '#fff', borderRadius: 14, marginBottom: 10, borderWidth: 1, borderColor: '#E5E7EB', overflow: 'hidden' }}>
                  <TouchableOpacity onPress={() => toggleExpand(job.id)} style={{ padding: 14 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
                        <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: statusColor(job.status) + '22' }}>
                          <Text style={{ fontSize: 10, fontWeight: '800', textTransform: 'capitalize', color: statusColor(job.status) }}>{job.status || '—'}</Text>
                        </View>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: '#111827' }} numberOfLines={1}>{job.label || (job.jobType || '').replace(/_/g, ' ') || 'Campaign'}</Text>
                      </View>
                      <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color="#2563EB" />
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                      <Text style={{ fontSize: 12, color: '#556274' }}>Total <Text style={{ fontWeight: '800' }}>{job.totalCount}</Text></Text>
                      <Text style={{ fontSize: 12, color: '#16a34a' }}>Sent <Text style={{ fontWeight: '800' }}>{job.sentCount}</Text></Text>
                      <Text style={{ fontSize: 12, color: job.failedCount > 0 ? '#DC2626' : '#6B7280' }}>Failed <Text style={{ fontWeight: '800' }}>{job.failedCount}</Text></Text>
                      <Text style={{ fontSize: 10, color: '#6B7280', marginLeft: 'auto' }}>{fmtTs(job.createdAt)}</Text>
                    </View>
                    {/* Per-job progress: share of recipients already sent (green) with failed share (red). */}
                    {Number(job.totalCount) > 0 && (() => {
                      const total = Number(job.totalCount) || 0;
                      const sent = Math.max(0, Math.min(total, Number(job.sentCount) || 0));
                      const failed = Math.max(0, Math.min(total - sent, Number(job.failedCount) || 0));
                      const sentPct = Math.round((sent / total) * 100);
                      const failedPct = Math.round((failed / total) * 100);
                      const done = sent >= total;
                      return (
                        <View style={{ marginTop: 8 }}>
                          <View style={{ height: 6, borderRadius: 3, backgroundColor: '#E5E7EB', overflow: 'hidden', flexDirection: 'row' }}>
                            {sentPct > 0 && <View style={{ width: `${sentPct}%`, backgroundColor: done ? '#16a34a' : '#2563EB' }} />}
                            {failedPct > 0 && <View style={{ width: `${failedPct}%`, backgroundColor: '#DC2626' }} />}
                          </View>
                          <Text style={{ fontSize: 10, color: '#6B7280', marginTop: 3 }}>{sentPct}% sent{failed > 0 ? ` · ${failedPct}% failed` : ''}</Text>
                        </View>
                      );
                    })()}
                  </TouchableOpacity>

                  {expanded && (
                    <View style={{ borderTopWidth: 1, borderTopColor: '#E5E7EB', padding: 12, backgroundColor: 'rgba(37,99,235,0.03)' }}>
                      {/* Job-level actions */}
                      {(job.failedCount > 0 || job.status === 'running' || job.status === 'pending') && (
                        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                          {job.failedCount > 0 && (
                            <TouchableOpacity disabled={!!busy} onPress={() => doResendAll(job.id)}
                              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, backgroundColor: '#2563EB', opacity: busy ? 0.5 : 1 }}>
                              {busy === 'resendAll:' + job.id ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="refresh" size={13} color="#fff" />}
                              <Text style={{ fontSize: 12, fontWeight: '700', color: '#fff' }}>Resend failed ({job.failedCount})</Text>
                            </TouchableOpacity>
                          )}
                          <TouchableOpacity disabled={!!busy} onPress={() => doResume(job.id)}
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, backgroundColor: 'rgba(37,99,235,0.12)', opacity: busy ? 0.5 : 1 }}>
                            {busy === 'resume:' + job.id ? <ActivityIndicator size="small" color="#2563EB" /> : <Ionicons name="play" size={13} color="#2563EB" />}
                            <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>Resume</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                      {dLoading ? (
                        <ActivityIndicator color="#2563EB" style={{ paddingVertical: 12 }} />
                      ) : deliveries.length === 0 ? (
                        <Text style={{ fontSize: 12, color: '#6B7280', textAlign: 'center', paddingVertical: 10 }}>No delivery rows</Text>
                      ) : (
                        // Web parity: group by outcome, failures/skips first, so "who didn't get it" is up top.
                        [
                          { title: 'NOT RECEIVED', color: '#DC2626', rows: deliveries.filter(d => ['failed', 'skipped', 'error'].includes(lc(d.status))) },
                          { title: 'PENDING',      color: '#2563EB', rows: deliveries.filter(d => ['pending', 'queued', 'running'].includes(lc(d.status))) },
                          { title: 'DELIVERED',    color: '#16a34a', rows: deliveries.filter(d => !['failed', 'skipped', 'error', 'pending', 'queued', 'running'].includes(lc(d.status))) },
                        ].filter(sec => sec.rows.length > 0).map(sec => (
                          <View key={sec.title}>
                            <Text style={{ fontSize: 10, fontWeight: '800', color: sec.color, letterSpacing: 0.5, marginTop: 8, marginBottom: 2 }}>{sec.title} ({sec.rows.length})</Text>
                            {sec.rows.map(renderRow)}
                          </View>
                        ))
                      )}
                    </View>
                  )}
                </View>
              );
            })}
          </ScrollView>
        )}

        {/* Edit tenant number + resend (failed rows). absoluteFill avoids the Fabric flex:1 Modal collapse. */}
        <Modal visible={!!editPhone} transparent animationType="fade" onRequestClose={() => { setEditPhone(null); setPhoneInput(''); }}>
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', paddingHorizontal: 24 }]}>
            <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 20 }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: '#0F172A', marginBottom: 4 }}>Update number & resend</Text>
              <Text style={{ fontSize: 12, color: '#6B7280', marginBottom: 14 }}>Save a corrected phone number for this tenant and re-queue the failed message.</Text>
              <TextInput
                value={phoneInput}
                onChangeText={setPhoneInput}
                placeholder="Phone number"
                placeholderTextColor="#9CA3AF"
                keyboardType="phone-pad"
                style={{ borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: '#111827', marginBottom: 16 }}
              />
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
                <TouchableOpacity onPress={() => { setEditPhone(null); setPhoneInput(''); }} style={{ paddingHorizontal: 14, paddingVertical: 9 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#6B7280' }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity disabled={!!busy} onPress={doEditPhoneSave} style={{ paddingHorizontal: 16, paddingVertical: 9, borderRadius: 10, backgroundColor: '#2563EB', opacity: busy ? 0.6 : 1 }}>
                  {busy && String(busy).startsWith('phone:') ? <ActivityIndicator size="small" color="#fff" /> : <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Save & Resend</Text>}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </GlassBackground>
  );
}

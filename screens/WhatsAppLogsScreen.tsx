/**
 * WhatsAppLogsScreen.tsx — mobile port of web WhatsAppDeliveryHistoryCard.
 * Lists recent WhatsApp send jobs; tap a job to expand its per-recipient
 * deliveries. Resend/resume writes (edge-function) are wired via
 * resumeWhatsappJob / resendAllFailedWhatsappDeliveries / resendWhatsappDelivery.
 * Data: sb.listWhatsappJobs({ jobType }), sb.listWhatsappJobDeliveries(jobId).
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl, Alert, Image,
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
];

const STATUS_COLOR: Record<string, string> = {
  completed: '#16a34a', success: '#16a34a', sent: '#16a34a', delivered: '#16a34a',
  running: '#E8841A', pending: '#E8841A', queued: '#E8841A',
  failed: '#DC2626', error: '#DC2626',
};
const statusColor = (s: string) => STATUS_COLOR[(s || '').toLowerCase()] || '#7B2FBE';

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

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12 }}>
          <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center' }}>
            <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 22, fontWeight: '900', color: '#1E1230' }}>WhatsApp Logs</Text>
            <Text style={{ fontSize: 12, color: '#9B8BAE' }}>Delivery history for sent messages</Text>
          </View>
        </View>

        {/* Job-type filter */}
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
          {JOB_TYPE_OPTIONS.map(o => (
            <TouchableOpacity key={o.key} onPress={() => setJobType(o.key)}
              style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: jobType === o.key ? '#7B2FBE' : 'rgba(123,47,190,0.1)' }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: jobType === o.key ? '#fff' : '#7B2FBE' }}>{o.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading && !refreshing ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color="#7B2FBE" />
            <Text style={{ marginTop: 12, color: '#5C4B70' }}>Loading WhatsApp logs…</Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#7B2FBE" />}
          >
            {jobs.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 60 }}>
                <Ionicons name="logo-whatsapp" size={56} color="rgba(123,47,190,0.18)" />
                <Text style={{ marginTop: 12, color: '#9B8BAE' }}>No send jobs yet</Text>
              </View>
            ) : jobs.map((job) => {
              const expanded = expandedId === job.id;
              return (
                <View key={job.id} style={{ backgroundColor: '#fff', borderRadius: 14, marginBottom: 10, borderWidth: 1, borderColor: 'rgba(123,47,190,0.1)', overflow: 'hidden' }}>
                  <TouchableOpacity onPress={() => toggleExpand(job.id)} style={{ padding: 14 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
                        <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: statusColor(job.status) + '22' }}>
                          <Text style={{ fontSize: 10, fontWeight: '800', textTransform: 'capitalize', color: statusColor(job.status) }}>{job.status || '—'}</Text>
                        </View>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: '#1E1230' }} numberOfLines={1}>{job.label || (job.jobType || '').replace(/_/g, ' ') || 'Campaign'}</Text>
                      </View>
                      <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color="#7B2FBE" />
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                      <Text style={{ fontSize: 12, color: '#5C4B70' }}>Total <Text style={{ fontWeight: '800' }}>{job.totalCount}</Text></Text>
                      <Text style={{ fontSize: 12, color: '#16a34a' }}>Sent <Text style={{ fontWeight: '800' }}>{job.sentCount}</Text></Text>
                      <Text style={{ fontSize: 12, color: job.failedCount > 0 ? '#DC2626' : '#9B8BAE' }}>Failed <Text style={{ fontWeight: '800' }}>{job.failedCount}</Text></Text>
                      <Text style={{ fontSize: 10, color: '#9B8BAE', marginLeft: 'auto' }}>{fmtTs(job.createdAt)}</Text>
                    </View>
                  </TouchableOpacity>

                  {expanded && (
                    <View style={{ borderTopWidth: 1, borderTopColor: 'rgba(123,47,190,0.08)', padding: 12, backgroundColor: 'rgba(123,47,190,0.03)' }}>
                      {/* Job-level actions */}
                      {(job.failedCount > 0 || job.status === 'running' || job.status === 'pending') && (
                        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                          {job.failedCount > 0 && (
                            <TouchableOpacity disabled={!!busy} onPress={() => doResendAll(job.id)}
                              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, backgroundColor: '#7B2FBE', opacity: busy ? 0.5 : 1 }}>
                              {busy === 'resendAll:' + job.id ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="refresh" size={13} color="#fff" />}
                              <Text style={{ fontSize: 12, fontWeight: '700', color: '#fff' }}>Resend failed ({job.failedCount})</Text>
                            </TouchableOpacity>
                          )}
                          <TouchableOpacity disabled={!!busy} onPress={() => doResume(job.id)}
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, backgroundColor: 'rgba(123,47,190,0.12)', opacity: busy ? 0.5 : 1 }}>
                            {busy === 'resume:' + job.id ? <ActivityIndicator size="small" color="#7B2FBE" /> : <Ionicons name="play" size={13} color="#7B2FBE" />}
                            <Text style={{ fontSize: 12, fontWeight: '700', color: '#7B2FBE' }}>Resume</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                      {dLoading ? (
                        <ActivityIndicator color="#7B2FBE" style={{ paddingVertical: 12 }} />
                      ) : deliveries.length === 0 ? (
                        <Text style={{ fontSize: 12, color: '#9B8BAE', textAlign: 'center', paddingVertical: 10 }}>No delivery rows</Text>
                      ) : deliveries.map((d) => {
                        const canResend = ['failed', 'pending', 'error'].includes(String(d.status).toLowerCase());
                        return (
                          <View key={d.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(123,47,190,0.06)' }}>
                            <View style={{ flexShrink: 1, paddingRight: 8 }}>
                              <Text style={{ fontSize: 12, fontWeight: '600', color: '#1E1230' }} numberOfLines={1}>{d.tenantName || d.label || 'Recipient'}</Text>
                              <Text style={{ fontSize: 10, color: '#9B8BAE' }}>{d.phoneMasked || d.deliveryKind || ''}{d.errorMessage ? ` · ${String(d.errorMessage).slice(0, 40)}` : ''}</Text>
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                              <Text style={{ fontSize: 11, fontWeight: '800', textTransform: 'capitalize', color: statusColor(d.status) }}>{d.status || '—'}</Text>
                              {canResend && (
                                <TouchableOpacity disabled={!!busy} onPress={() => doResendOne(d.id, job.id)} style={{ padding: 4, opacity: busy ? 0.5 : 1 }}>
                                  {busy === 'one:' + d.id ? <ActivityIndicator size="small" color="#7B2FBE" /> : <Ionicons name="refresh" size={16} color="#7B2FBE" />}
                                </TouchableOpacity>
                              )}
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  )}
                </View>
              );
            })}
          </ScrollView>
        )}
      </SafeAreaView>
    </GlassBackground>
  );
}

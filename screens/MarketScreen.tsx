/**
 * MarketScreen.tsx — mobile port of web src/pages/MarketIntelligence.tsx (read).
 * Two tabs: Competitors (tracked properties) and Expansion (locality scores).
 * Read-only for now — the market-trigger scan/retry (edge-function write) is a
 * planned fast-follow once verifiable live.
 * Data: sb.getMarketCompetitors(), sb.getExpansionOpportunities().
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl, Alert, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { GlassBackground } from '../components/shared';

const fmtInr = (v: number) => `₹${(Number(v) || 0).toLocaleString('en-IN')}`;

// Web parity: competitor segment filter chips.
const SEGMENTS = ['all', 'budget', 'mid-range', 'premium', 'luxury'];

export default function MarketScreen() {
  const navigation = useNavigation<any>();
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'super_admin';
  const [tab, setTab] = useState<'competitors' | 'expansion'>('competitors');
  const [competitors, setCompetitors] = useState<any[]>([]);
  const [opportunities, setOpportunities] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [seg, setSeg] = useState('all');

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const [comp, opps] = await Promise.all([
        sb.getMarketCompetitors({}).catch(() => []),
        sb.getExpansionOpportunities().catch(() => []),
      ]);
      setCompetitors(Array.isArray(comp) ? comp : []);
      setOpportunities(Array.isArray(opps) ? opps : []);
    } catch {
      setCompetitors([]); setOpportunities([]);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const doScan = useCallback(() => {
    Alert.alert('Start market scan', 'Enqueue discovery jobs to refresh competitor data?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Scan', onPress: async () => {
        setBusy('scan');
        try {
          const r = await sb.triggerMarketScan();
          if (r?.ok === false) Alert.alert('Scan failed', r.reason || 'Unknown error');
          else Alert.alert('Sync started', `${r?.jobs ?? '?'} job(s) enqueued. Results appear after the run.`);
        } catch (e: any) {
          Alert.alert('Scan failed', e?.message || 'Unknown error');
        } finally { setBusy(null); }
      } },
    ]);
  }, []);

  const doRetry = useCallback(async () => {
    setBusy('retry');
    try {
      const r = await sb.retryMarketIntel();
      if (r?.ok === false) Alert.alert('Retry failed', r.reason || 'Unknown error');
      else Alert.alert('Retrying', `Retrying ${r?.retried ?? '?'} failed analysis(es)…`);
    } catch (e: any) {
      Alert.alert('Retry failed', e?.message || 'Unknown error');
    } finally { setBusy(null); }
  }, []);

  const deepIntelCount = competitors.filter((c) => c.crawlStatus === 'success').length;
  const shownCompetitors = seg === 'all'
    ? competitors
    : competitors.filter((c) => String(c.marketSegment || '').toLowerCase() === seg);

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12 }}>
          <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center' }}>
            <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 }}>Market AI</Text>
            <Text style={{ fontSize: 13, color: '#6B7280', fontWeight: '500', marginTop: 2 }}>Competitor pricing & locality trends</Text>
          </View>
          {canManage && (
            <TouchableOpacity disabled={!!busy} onPress={doScan}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: '#2563EB', opacity: busy ? 0.5 : 1 }}>
              {busy === 'scan' ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="sync" size={14} color="#fff" />}
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Scan</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Tabs */}
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
          {([
            { k: 'competitors', label: `Competitors${competitors.length ? ` (${competitors.length})` : ''}` },
            { k: 'expansion', label: `Expansion${opportunities.length ? ` (${opportunities.length})` : ''}` },
          ] as const).map(x => (
            <TouchableOpacity key={x.k} onPress={() => setTab(x.k as any)}
              style={{ paddingHorizontal: 16, paddingVertical: 9, borderRadius: 20, backgroundColor: tab === x.k ? '#2563EB' : 'rgba(37,99,235,0.1)' }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: tab === x.k ? '#fff' : '#2563EB' }}>{x.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading && !refreshing ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color="#2563EB" />
            <Text style={{ marginTop: 12, color: '#556274' }}>Loading market data…</Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#2563EB" />}
          >
            {tab === 'competitors' && (
              competitors.length === 0 ? (
                <View style={{ alignItems: 'center', paddingVertical: 60 }}>
                  <Ionicons name="radio-outline" size={56} color="rgba(37,99,235,0.18)" />
                  <Text style={{ marginTop: 12, color: '#6B7280' }}>No competitors tracked yet</Text>
                  <Text style={{ marginTop: 4, color: '#6B7280', fontSize: 12, textAlign: 'center' }}>Discovery jobs populate this from the web app.</Text>
                </View>
              ) : (
                <>
                  {canManage && competitors.some((c) => c.crawlStatus === 'failed') && (
                    <TouchableOpacity disabled={!!busy} onPress={doRetry}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 12, marginBottom: 10, backgroundColor: 'rgba(220,38,38,0.08)' }}>
                      {busy === 'retry' ? <ActivityIndicator size="small" color="#DC2626" /> : <Ionicons name="refresh" size={14} color="#DC2626" />}
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#DC2626' }}>Retry {competitors.filter((c) => c.crawlStatus === 'failed').length} failed analysis(es)</Text>
                    </TouchableOpacity>
                  )}
                  {/* Deep-intel coverage badge (web parity) */}
                  {deepIntelCount > 0 && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: 'rgba(22,163,74,0.1)', marginBottom: 10 }}>
                      <Ionicons name="sparkles-outline" size={12} color="#16a34a" />
                      <Text style={{ fontSize: 11, fontWeight: '700', color: '#16a34a' }}>{deepIntelCount} with deep intel</Text>
                    </View>
                  )}
                  {/* Segment filter chips (web parity) */}
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 10 }}>
                    {SEGMENTS.map((s) => (
                      <TouchableOpacity key={s} onPress={() => setSeg(s)}
                        style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: seg === s ? '#2563EB' : 'rgba(37,99,235,0.1)' }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', textTransform: 'capitalize', color: seg === s ? '#fff' : '#2563EB' }}>{s === 'all' ? 'All' : s}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                  {shownCompetitors.length === 0 ? (
                    <Text style={{ fontSize: 12, color: '#6B7280', textAlign: 'center', paddingVertical: 20 }}>No competitors in this segment.</Text>
                  ) : shownCompetitors.map((c) => (
                    <View key={c.id} style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#E5E7EB' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827', flexShrink: 1 }} numberOfLines={1}>{c.name}</Text>
                        {c.rating != null && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                            <Ionicons name="star" size={12} color="#2563EB" />
                            <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>{c.rating}{c.reviewCount != null ? ` (${c.reviewCount})` : ''}</Text>
                          </View>
                        )}
                      </View>
                      <Text style={{ fontSize: 12, color: '#6B7280', marginTop: 3 }}>
                        {[c.localityName, c.city].filter(Boolean).join(', ') || '—'}
                        {c.marketSegment ? `  ·  ${c.marketSegment}` : ''}
                      </Text>
                    </View>
                  ))}
                </>
              )
            )}

            {tab === 'expansion' && (
              opportunities.length === 0 ? (
                <View style={{ alignItems: 'center', paddingVertical: 60 }}>
                  <Ionicons name="trending-up-outline" size={56} color="rgba(37,99,235,0.18)" />
                  <Text style={{ marginTop: 12, color: '#6B7280' }}>No expansion opportunities</Text>
                  <Text style={{ marginTop: 4, color: '#6B7280', fontSize: 12, textAlign: 'center' }}>Add tracked localities in the web app to see scores.</Text>
                </View>
              ) : opportunities.map((op, i) => (
                <View key={`${op.localityName}-${op.city}-${i}`} style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#E5E7EB', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <View style={{ flexShrink: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827' }} numberOfLines={1}>{op.localityName}{op.city ? `, ${op.city}` : ''}</Text>
                    <Text style={{ fontSize: 12, color: '#6B7280', marginTop: 3 }}>{op.competitorCount} competitors · avg {fmtInr(op.avgMarketPrice)}</Text>
                  </View>
                  <View style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: op.opportunityScore >= 70 ? '#2563EB' : 'rgba(37,99,235,0.12)' }}>
                    <Text style={{ fontSize: 12, fontWeight: '900', color: op.opportunityScore >= 70 ? '#fff' : '#2563EB' }}>Score {op.opportunityScore}</Text>
                  </View>
                </View>
              ))
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </GlassBackground>
  );
}

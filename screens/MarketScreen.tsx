/**
 * MarketScreen.tsx — mobile port of web src/pages/MarketIntelligence.tsx (read).
 * Two tabs: Competitors (tracked properties) and Expansion (locality scores).
 * Read-only for now — the market-trigger scan/retry (edge-function write) is a
 * planned fast-follow once verifiable live.
 * Data: sb.getMarketCompetitors(), sb.getExpansionOpportunities().
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl, Alert, Image, TextInput,
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

// Group tracked localities by city for the Settings tab.
const groupByCity = (list: any[]): [string, any[]][] => {
  const m: Record<string, any[]> = {};
  list.forEach((t) => { const c = t.locality?.city || 'Other'; (m[c] = m[c] || []).push(t); });
  return Object.entries(m);
};

export default function MarketScreen() {
  const navigation = useNavigation<any>();
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'super_admin';
  const [tab, setTab] = useState<'competitors' | 'benchmark' | 'expansion' | 'settings'>('benchmark');
  const [competitors, setCompetitors] = useState<any[]>([]);
  const [opportunities, setOpportunities] = useState<any[]>([]);
  const [localities, setLocalities] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [benchmark, setBenchmark] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [seg, setSeg] = useState('all');
  const [expandedCompetitor, setExpandedCompetitor] = useState<string | null>(null);
  const [locName, setLocName] = useState('');
  const [locCity, setLocCity] = useState('');

  const load = useCallback(async (isRefresh = false, silent = false) => {
    // silent=true is used by the 30s auto-refresh so the poll updates data
    // without flashing the full-screen spinner or the pull-to-refresh control.
    if (silent) { /* no loading flag */ } else if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const [comp, opps, locs, summ, bench] = await Promise.all([
        sb.getMarketCompetitors({}).catch(() => []),
        sb.getExpansionOpportunities().catch(() => []),
        sb.getTrackedLocalities().catch(() => []),
        sb.getMarketSummary().catch(() => null),
        sb.getMarketBenchmark().catch(() => []),
      ]);
      setCompetitors(Array.isArray(comp) ? comp : []);
      setOpportunities(Array.isArray(opps) ? opps : []);
      setLocalities(Array.isArray(locs) ? locs : []);
      setSummary(summ || null);
      setBenchmark(Array.isArray(bench) ? bench : []);
    } catch {
      setCompetitors([]); setOpportunities([]); setLocalities([]); setSummary(null); setBenchmark([]);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, []);

  // Web parity: MarketIntelligence.tsx polls competitors + summary every 30s
  // (refetchInterval: 30_000). Mirror that with a focused-only interval so we
  // don't poll in the background. The initial load is triggered once on focus;
  // subsequent ticks are silent (no spinner flash).
  useFocusEffect(useCallback(() => {
    load();
    const id = setInterval(() => { load(false, true); }, 30000);
    return () => clearInterval(id);
  }, [load]));

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

  // ── Tracked-locality CRUD (Settings tab) ──
  const doAddLocality = useCallback(async () => {
    const name = locName.trim(), city = locCity.trim();
    if (!name || !city) { Alert.alert('Missing info', 'Enter both a locality name and a city.'); return; }
    setBusy('addLoc');
    try {
      const r = await sb.upsertTrackedLocality(name, city);
      if (r?.ok === false) { Alert.alert('Could not add', r.reason || 'Unknown error'); return; }
      setLocName(''); setLocCity('');
    } catch (e: any) { Alert.alert('Could not add', e?.message || 'Unknown error'); }
    finally { setBusy(null); await load(true); }
  }, [locName, locCity, load]);

  const doToggleLocality = useCallback(async (id: string) => {
    setBusy('tog:' + id);
    try { const r = await sb.toggleTrackedLocality(id); if (r?.ok === false) Alert.alert('Failed', r.reason || 'Error'); }
    catch (e: any) { Alert.alert('Failed', e?.message || 'Error'); }
    finally { setBusy(null); await load(true); }
  }, [load]);

  const doRemoveLocality = useCallback((id: string, name?: string) => {
    Alert.alert('Remove locality', `Stop tracking ${name || 'this locality'}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        setBusy('rm:' + id);
        try { const r = await sb.removeTrackedLocality(id); if (r?.ok === false) Alert.alert('Failed', r.reason || 'Error'); }
        catch (e: any) { Alert.alert('Failed', e?.message || 'Error'); }
        finally { setBusy(null); await load(true); }
      } },
    ]);
  }, [load]);

  const doToggleCityWide = useCallback(async (city: string) => {
    setBusy('cw:' + city);
    try { const r = await sb.toggleCityWideScan(city); if (r?.ok === false) Alert.alert('Failed', r.reason || 'Error'); }
    catch (e: any) { Alert.alert('Failed', e?.message || 'Error'); }
    finally { setBusy(null); await load(true); }
  }, [load]);

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
            {summary && (summary.competitorCount > 0 || summary.trackedLocalities > 0) ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3, alignSelf: 'flex-start', backgroundColor: 'rgba(22,163,74,0.1)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
                <Ionicons name="checkmark-circle" size={12} color="#16a34a" />
                <Text style={{ fontSize: 10, fontWeight: '700', color: '#16a34a' }}>{summary.competitorCount} competitors · {summary.trackedLocalities} localities</Text>
              </View>
            ) : (
              <Text style={{ fontSize: 13, color: '#6B7280', fontWeight: '500', marginTop: 2 }}>Competitor pricing & locality trends</Text>
            )}
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
            { k: 'benchmark', label: 'Benchmark' },
            { k: 'expansion', label: `Expansion${opportunities.length ? ` (${opportunities.length})` : ''}` },
            ...(canManage ? [{ k: 'settings', label: 'Settings' }] : []),
          ] as { k: string; label: string }[]).map(x => (
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
                  ) : shownCompetitors.map((c) => {
                    const intel = c.intelligence || {};
                    const isOpen = expandedCompetitor === c.id;
                    const hasIntel = intel.pricingMin != null || intel.pricingMax != null || (intel.roomTypes && intel.roomTypes.length) || intel.amenityScore != null || (intel.amenities && intel.amenities.length) || intel.phone || intel.email || (intel.uspTags && intel.uspTags.length);
                    const chip = (label: string, tone = '#2563EB') => (
                      <View key={label} style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: tone + '14', marginRight: 6, marginBottom: 6 }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: tone }}>{label}</Text>
                      </View>
                    );
                    return (
                      <TouchableOpacity key={c.id} activeOpacity={hasIntel ? 0.7 : 1} onPress={() => hasIntel && setExpandedCompetitor(isOpen ? null : c.id)}
                        style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#E5E7EB' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                          <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827', flexShrink: 1 }} numberOfLines={1}>{c.name}</Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            {c.rating != null && (
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                                <Ionicons name="star" size={12} color="#2563EB" />
                                <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>{c.rating}{c.reviewCount != null ? ` (${c.reviewCount})` : ''}</Text>
                              </View>
                            )}
                            {hasIntel && <Ionicons name={isOpen ? 'chevron-up' : 'chevron-down'} size={16} color="#9CA3AF" />}
                          </View>
                        </View>
                        <Text style={{ fontSize: 12, color: '#6B7280', marginTop: 3 }}>
                          {[c.localityName, c.city].filter(Boolean).join(', ') || '—'}
                          {c.marketSegment ? `  ·  ${c.marketSegment}` : ''}
                        </Text>
                        {(intel.pricingMin != null || intel.pricingMax != null) && (
                          <Text style={{ fontSize: 12, color: '#111827', fontWeight: '700', marginTop: 6 }}>
                            {intel.pricingMin != null && intel.pricingMax != null ? `${fmtInr(intel.pricingMin)}–${fmtInr(intel.pricingMax)}/mo` : `${fmtInr(intel.pricingMin ?? intel.pricingMax)}/mo`}
                          </Text>
                        )}
                        {isOpen && (
                          <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: '#F1F5F9', paddingTop: 10, gap: 8 }}>
                            {Array.isArray(intel.roomTypes) && intel.roomTypes.length > 0 && (
                              <View>
                                <Text style={{ fontSize: 10, fontWeight: '800', color: '#9CA3AF', letterSpacing: 0.4, marginBottom: 2 }}>ROOM TYPES</Text>
                                {intel.roomTypes.map((rt: any, i: number) => (
                                  <Text key={i} style={{ fontSize: 12, color: '#374151' }}>
                                    {(rt.label || rt.type || 'Room')}{rt.price != null ? ` · ${fmtInr(rt.price)}` : ''}{rt.occupancy != null ? ` · ${rt.occupancy}` : ''}
                                  </Text>
                                ))}
                              </View>
                            )}
                            {(intel.amenityScore != null || intel.digitalMaturityScore != null) && (
                              <View style={{ flexDirection: 'row', gap: 16 }}>
                                {intel.amenityScore != null && <Text style={{ fontSize: 12, color: '#374151' }}>Amenity <Text style={{ fontWeight: '800' }}>{intel.amenityScore}</Text></Text>}
                                {intel.digitalMaturityScore != null && <Text style={{ fontSize: 12, color: '#374151' }}>Digital <Text style={{ fontWeight: '800' }}>{intel.digitalMaturityScore}</Text></Text>}
                              </View>
                            )}
                            {intel.targetDemographic ? <Text style={{ fontSize: 12, color: '#374151' }}>Target: {intel.targetDemographic}</Text> : null}
                            {(intel.hasOnlineBooking || intel.hasVirtualTour || intel.hasPhotos) && (
                              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                                {intel.hasOnlineBooking ? chip('Online booking', '#16a34a') : null}
                                {intel.hasVirtualTour ? chip('Virtual tour', '#16a34a') : null}
                                {intel.hasPhotos ? chip('Photos', '#16a34a') : null}
                              </View>
                            )}
                            {Array.isArray(intel.uspTags) && intel.uspTags.length > 0 && (
                              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{intel.uspTags.map((t: any) => chip(String(t), '#7C3AED'))}</View>
                            )}
                            {Array.isArray(intel.amenities) && intel.amenities.length > 0 && (
                              <Text style={{ fontSize: 11, color: '#6B7280' }}>Amenities: {intel.amenities.join(', ')}</Text>
                            )}
                            {(intel.phone || intel.email || c.website) && (
                              <View style={{ gap: 2 }}>
                                {intel.phone ? <Text style={{ fontSize: 12, color: '#2563EB' }}>{intel.phone}</Text> : null}
                                {intel.email ? <Text style={{ fontSize: 12, color: '#2563EB' }}>{intel.email}</Text> : null}
                                {c.website ? <Text style={{ fontSize: 11, color: '#2563EB' }} numberOfLines={1}>{c.website}</Text> : null}
                              </View>
                            )}
                            {intel.crawlStatus === 'failed' && intel.errorMessage ? (
                              <Text style={{ fontSize: 11, color: '#DC2626' }}>Analysis failed: {String(intel.errorMessage).slice(0, 80)}</Text>
                            ) : null}
                          </View>
                        )}
                      </TouchableOpacity>
                    );
                  })}
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

            {tab === 'benchmark' && (
              benchmark.length === 0 ? (
                <View style={{ alignItems: 'center', paddingVertical: 60 }}>
                  <Ionicons name="stats-chart-outline" size={56} color="rgba(37,99,235,0.18)" />
                  <Text style={{ marginTop: 12, color: '#6B7280' }}>No pricing benchmark yet</Text>
                  <Text style={{ marginTop: 4, color: '#6B7280', fontSize: 12, textAlign: 'center' }}>Pricing data populates after room-type extraction completes.</Text>
                </View>
              ) : benchmark.map((row, i) => (
                <View key={`${row.localityName}-${row.roomTypeLabel}-${i}`} style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#E5E7EB' }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#111827', marginBottom: 10 }}>{row.localityName || '—'}{row.roomTypeLabel ? ` — ${row.roomTypeLabel}` : ''}</Text>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    {[
                      { l: 'P25', v: row.priceP25 != null ? fmtInr(row.priceP25) : '—', tone: '#374151' },
                      { l: 'Median', v: row.priceMedian != null ? fmtInr(row.priceMedian) : '—', tone: '#2563EB' },
                      { l: 'P75', v: row.priceP75 != null ? fmtInr(row.priceP75) : '—', tone: '#374151' },
                      { l: 'Properties', v: String(row.propertyCount ?? 0), tone: '#374151' },
                    ].map((c) => (
                      <View key={c.l} style={{ alignItems: 'center', flex: 1 }}>
                        <Text style={{ fontSize: 10, color: '#9CA3AF', marginBottom: 2 }}>{c.l}</Text>
                        <Text style={{ fontSize: 14, fontWeight: '800', color: c.tone }}>{c.v}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ))
            )}

            {tab === 'settings' && (
              <>
                {/* Add a tracked locality */}
                <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#E5E7EB' }}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: '#111827', marginBottom: 8 }}>Track a locality</Text>
                  <TextInput value={locName} onChangeText={setLocName} placeholder="Locality name (e.g. Koramangala)" placeholderTextColor="#9CA3AF"
                    style={{ borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: '#111827', marginBottom: 8 }} />
                  <TextInput value={locCity} onChangeText={setLocCity} placeholder="City (e.g. Bengaluru)" placeholderTextColor="#9CA3AF"
                    style={{ borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: '#111827', marginBottom: 10 }} />
                  <TouchableOpacity disabled={!!busy} onPress={doAddLocality}
                    style={{ backgroundColor: '#2563EB', borderRadius: 10, paddingVertical: 11, alignItems: 'center', opacity: busy ? 0.6 : 1 }}>
                    {busy === 'addLoc' ? <ActivityIndicator size="small" color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>Add locality</Text>}
                  </TouchableOpacity>
                </View>

                {localities.length === 0 ? (
                  <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                    <Ionicons name="location-outline" size={48} color="rgba(37,99,235,0.18)" />
                    <Text style={{ marginTop: 10, color: '#6B7280' }}>No tracked localities yet</Text>
                    <Text style={{ marginTop: 4, color: '#6B7280', fontSize: 12, textAlign: 'center' }}>Add one above to start tracking competitors there.</Text>
                  </View>
                ) : groupByCity(localities).map(([city, items]) => (
                  <View key={city} style={{ backgroundColor: '#fff', borderRadius: 14, marginBottom: 10, borderWidth: 1, borderColor: '#E5E7EB', overflow: 'hidden' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, backgroundColor: 'rgba(37,99,235,0.05)' }}>
                      <Text style={{ fontSize: 13, fontWeight: '800', color: '#111827' }}>{city} <Text style={{ color: '#6B7280', fontWeight: '600' }}>({items.filter((i: any) => i.isActive).length}/{items.length})</Text></Text>
                      <TouchableOpacity disabled={!!busy} onPress={() => doToggleCityWide(city)} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, opacity: busy ? 0.5 : 1 }}>
                        <Ionicons name={items.some((i: any) => i.cityWideScan) ? 'checkbox' : 'square-outline'} size={16} color="#2563EB" />
                        <Text style={{ fontSize: 11, fontWeight: '700', color: '#2563EB' }}>City-wide scan</Text>
                      </TouchableOpacity>
                    </View>
                    {items.map((t: any) => (
                      <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#F1F5F9' }}>
                        <View style={{ flexShrink: 1 }}>
                          <Text style={{ fontSize: 13, fontWeight: '600', color: '#111827' }} numberOfLines={1}>{t.locality?.name || '—'}</Text>
                          <Text style={{ fontSize: 11, color: t.isActive ? '#16a34a' : '#9CA3AF', fontWeight: '700' }}>{t.isActive ? 'Active' : 'Paused'}</Text>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <TouchableOpacity disabled={!!busy} onPress={() => doToggleLocality(t.id)} style={{ padding: 6, opacity: busy ? 0.5 : 1 }}>
                            <Ionicons name={t.isActive ? 'pause' : 'play'} size={16} color="#D97706" />
                          </TouchableOpacity>
                          <TouchableOpacity disabled={!!busy} onPress={() => doRemoveLocality(t.id, t.locality?.name)} style={{ padding: 6, opacity: busy ? 0.5 : 1 }}>
                            <Ionicons name="trash-outline" size={16} color="#DC2626" />
                          </TouchableOpacity>
                        </View>
                      </View>
                    ))}
                  </View>
                ))}
              </>
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </GlassBackground>
  );
}

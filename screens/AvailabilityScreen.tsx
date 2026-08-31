/**
 * AvailabilityScreen.tsx — clone of web src/pages/Availability.tsx.
 * Pick property → enter tenant gender/job/state/company + preferred bed types →
 * runs the deterministic recommendBeds() engine → ranked B/C/D recommendations.
 *
 * Data: sb.listScopedProperties(), sb.getAvailabilityData(propertyId).
 * Algorithm: ../lib/availabilityRecommender (ported verbatim from web).
 */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, Modal, Alert, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import * as sb from '../lib/supabaseService';
import { GlassBackground } from '../components/shared';
import { recommendBeds, type AvailabilityInput, type BedTypeBCD } from '../lib/availabilityRecommender';

// ── bed type bucketing (web parity) ──
function mapBedTypeToBCD(bedType: string | null | undefined): BedTypeBCD {
  const t = String(bedType || '').toLowerCase();
  if (t.startsWith('b')) return 'B';
  if (t.startsWith('c')) return 'C';
  if (t.startsWith('d')) return 'D';
  if (t.includes('single')) return 'B';
  if (t.includes('double')) return 'C';
  return 'D';
}

const MATCH_TYPE_LABEL: Record<string, string> = {
  PERFECT_LANGUAGE_ROOM_MATCH: 'Perfect Room',
  LANGUAGE_APARTMENT_MATCH: 'Language',
  SAME_STATE_MATCH: 'State',
  COMPANY_MATCH: 'Company',
  PROFESSION_MATCH: 'Profession',
  MIXED_COMPATIBILITY_MATCH: 'Mixed',
  NO_MATCH: 'No Match',
};
const TYPE_LABEL: Record<BedTypeBCD, string> = { B: 'Single', C: 'Double', D: 'Triple+' };

const scoreBorder = (s: number) => s >= 70 ? '#16A34A' : s >= 40 ? '#2563EB' : '#94A3B8';
const confidenceBg = (c: string) => c === 'High' ? '#DCFCE7' : c === 'Medium' ? '#FFEDD5' : '#F1F3F9';
const confidenceColor = (c: string) => c === 'High' ? '#16A34A' : c === 'Medium' ? '#EA580C' : '#64748B';

function differenceInDays(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / 86400000);
}

export default function AvailabilityScreen() {
  const navigation = useNavigation<any>();
  const [properties, setProperties] = useState<any[]>([]);
  const [propOpen, setPropOpen] = useState(false);
  const [selectedPropertyId, setSelectedPropertyId] = useState('');
  const [availData, setAvailData] = useState<any>(null);
  const [loadingProps, setLoadingProps] = useState(true);
  const [loadingData, setLoadingData] = useState(false);

  // tenant inputs
  const [tenantGender, setTenantGender] = useState<'male' | 'female'>('male');
  const [tenantJobType, setTenantJobType] = useState('');
  const [tenantState, setTenantState] = useState('');
  const [tenantCompany, setTenantCompany] = useState('');
  const [preferredBedTypes, setPreferredBedTypes] = useState<BedTypeBCD[]>(['B', 'C', 'D']);

  // result
  const [output, setOutput] = useState<any>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'vacant' | 'notice' | 'booked'>('all');

  // load scoped properties
  useEffect(() => {
    (async () => {
      setLoadingProps(true);
      try { const p = await sb.listScopedProperties(); setProperties(p || []); }
      catch { setProperties([]); }
      finally { setLoadingProps(false); }
    })();
  }, []);

  // load raw data when property changes
  useEffect(() => {
    if (!selectedPropertyId) { setAvailData(null); setOutput(null); return; }
    (async () => {
      setLoadingData(true); setOutput(null);
      try { const d = await sb.getAvailabilityData(selectedPropertyId); setAvailData(d); }
      catch { setAvailData(null); }
      finally { setLoadingData(false); }
    })();
  }, [selectedPropertyId]);

  // build recommender input (ported from web's recommendationInput useMemo)
  const recommendationInput = useMemo((): AvailabilityInput | null => {
    if (!availData || !selectedPropertyId) return null;
    const { apartments, beds, allotments, tenants } = availData;
    const activeStatuses = ['Staying', 'Booked', 'On-Notice'];

    const bedsByApartment = new Map<string, any[]>();
    for (const b of beds || []) {
      if (!bedsByApartment.has(b.apartment_id)) bedsByApartment.set(b.apartment_id, []);
      bedsByApartment.get(b.apartment_id)!.push(b);
    }

    const inputApartments = (apartments || [])
      .filter((a: any) => {
        if (a.property_id !== selectedPropertyId) return false;
        const g = (a.gender_allowed || 'both').toLowerCase();
        return ['both', 'mixed', 'any'].includes(g) || g === tenantGender;
      })
      .map((apt: any) => {
        const aptBeds = bedsByApartment.get(apt.id) || [];
        const aptBedIds = new Set(aptBeds.map((b: any) => b.id));
        const aptAllots = (allotments || []).filter((al: any) => al.apartment_id === apt.id && aptBedIds.has(al.bed_id));

        const bedCodeSorted = [...aptBeds].sort((a: any, b: any) => String(a.bed_code || '').localeCompare(String(b.bed_code || '')));

        const bedsInput = bedCodeSorted.map((b: any, idx: number) => {
          const bedAllots = (allotments || []).filter((al: any) => al.bed_id === b.id);
          const activeAllot = bedAllots.find((al: any) => activeStatuses.includes(al.staying_status));
          const vacant = !activeAllot;
          const latestExit = [...bedAllots]
            .filter((al: any) => !!al.actual_exit_date)
            .sort((x: any, y: any) => String(y.actual_exit_date).localeCompare(String(x.actual_exit_date)))[0]?.actual_exit_date;
          const vacancyDays = latestExit ? Math.max(0, differenceInDays(new Date(), new Date(latestExit))) : 0;
          const adjacent = [bedCodeSorted[idx - 1]?.id, bedCodeSorted[idx + 1]?.id].filter(Boolean) as string[];
          return {
            bedId: b.id,
            bedCode: b.bed_code || b.id.slice(0, 8),
            bedType: mapBedTypeToBCD(b.bed_type),
            vacant, vacancyDays, adjacentBeds: adjacent,
          };
        });

        const tenantsInput = aptAllots
          .filter((al: any) => ['Staying', 'On-Notice'].includes(al.staying_status))
          .map((al: any) => {
            const t = (tenants || []).find((x: any) => x.id === al.tenant_id);
            if (!t) return null;
            return {
              name: t.full_name || 'Tenant',
              bedId: al.bed_id,
              language: undefined,
              state: t.state || undefined,
              jobType: t.profession || t.designation || '',
              company_name: t.company_name || undefined,
              designation: t.designation || undefined,
            };
          })
          .filter(Boolean);

        return { apartmentId: apt.id, beds: bedsInput, tenants: tenantsInput };
      });

    const tenant = {
      name: '',
      preferredBedTypes,
      jobType: tenantJobType || '',
      ...(tenantState.trim() ? { state: tenantState.trim() } : {}),
      ...(tenantCompany.trim() ? { company_name: tenantCompany.trim() } : {}),
    };
    return { tenant, apartments: inputApartments };
  }, [availData, selectedPropertyId, tenantGender, tenantJobType, tenantState, tenantCompany, preferredBedTypes]);

  const apartmentCodeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of (availData?.apartments || [])) m.set(a.id, a.apartment_code || a.id.slice(0, 8));
    return m;
  }, [availData]);

  const runRecommendations = () => {
    if (!recommendationInput) { Alert.alert('Select a property first'); return; }
    if (!preferredBedTypes.length) { Alert.alert('Select at least one bed type (B / C / D)'); return; }
    try { setOutput(recommendBeds(recommendationInput)); }
    catch (e: any) { Alert.alert('Error', e.message || 'Could not generate recommendations.'); }
  };

  const toggleBedType = (t: BedTypeBCD) => {
    setPreferredBedTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
    setOutput(null);
  };

  const selectedPropName = properties.find(p => p.id === selectedPropertyId)?.name || 'Select property';

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12 }}>
          <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center' }}>
            <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
          </View>
          <View>
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 }}>Availability</Text>
            <Text style={{ fontSize: 13, color: '#64748B', fontWeight: '500', marginTop: 2 }}>Vacant, notice & booked beds</Text>
          </View>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 44, marginBottom: 4 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 8, alignItems: 'center' }}>
          {([
            { key: 'all', label: 'All' },
            { key: 'vacant', label: 'Vacant' },
            { key: 'notice', label: 'Notice' },
            { key: 'booked', label: 'Booked' },
          ] as const).map((f) => {
            const active = statusFilter === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                onPress={() => setStatusFilter(f.key)}
                activeOpacity={0.85}
                style={{
                  minHeight: 36, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
                  backgroundColor: active ? '#2563EB' : '#F1F3F9',
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
          {/* Property selector */}
          <Text style={{ fontSize: 12, fontWeight: '700', color: '#64748B', marginBottom: 4 }}>Property *</Text>
          <TouchableOpacity onPress={() => setPropOpen(true)} disabled={loadingProps}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#EEF1F6', paddingHorizontal: 12, paddingVertical: 12, marginBottom: 16 }}>
            <Text style={{ fontSize: 14, color: selectedPropertyId ? '#0F172A' : '#94A3B8' }}>{loadingProps ? 'Loading…' : selectedPropName}</Text>
            <Ionicons name="chevron-down" size={16} color="#2563EB" />
          </TouchableOpacity>

          {/* Tenant criteria */}
          <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2 }}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: '#0F172A', marginBottom: 12 }}>Tenant Criteria</Text>

            <Text style={{ fontSize: 12, fontWeight: '700', color: '#64748B', marginBottom: 4 }}>Gender *</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
              {(['male', 'female'] as const).map(g => (
                <TouchableOpacity key={g} onPress={() => { setTenantGender(g); setOutput(null); }}
                  style={{ flex: 1, paddingVertical: 10, borderRadius: 999, alignItems: 'center', backgroundColor: tenantGender === g ? '#2563EB' : '#F1F3F9' }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: tenantGender === g ? '#fff' : '#64748B', textTransform: 'capitalize' }}>{g}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={{ fontSize: 12, fontWeight: '700', color: '#64748B', marginBottom: 4 }}>Job Type</Text>
            <TextInput value={tenantJobType} onChangeText={(v) => { setTenantJobType(v); setOutput(null); }} placeholder="e.g. Software Engineer" placeholderTextColor="#94A3B8"
              style={{ backgroundColor: '#F8FAFC', borderRadius: 12, borderWidth: 1, borderColor: '#EEF1F6', paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, marginBottom: 12, color: '#0F172A' }} />

            <Text style={{ fontSize: 12, fontWeight: '700', color: '#64748B', marginBottom: 4 }}>State (optional)</Text>
            <TextInput value={tenantState} onChangeText={(v) => { setTenantState(v); setOutput(null); }} placeholder="e.g. Tamil Nadu" placeholderTextColor="#94A3B8"
              style={{ backgroundColor: '#F8FAFC', borderRadius: 12, borderWidth: 1, borderColor: '#EEF1F6', paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, marginBottom: 12, color: '#0F172A' }} />

            <Text style={{ fontSize: 12, fontWeight: '700', color: '#64748B', marginBottom: 4 }}>Company (optional)</Text>
            <TextInput value={tenantCompany} onChangeText={(v) => { setTenantCompany(v); setOutput(null); }} placeholder="e.g. Infosys" placeholderTextColor="#94A3B8"
              style={{ backgroundColor: '#F8FAFC', borderRadius: 12, borderWidth: 1, borderColor: '#EEF1F6', paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, marginBottom: 12, color: '#0F172A' }} />

            <Text style={{ fontSize: 12, fontWeight: '700', color: '#64748B', marginBottom: 6 }}>Preferred Bed Types (B / C / D)</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {(['B', 'C', 'D'] as BedTypeBCD[]).map(t => {
                const active = preferredBedTypes.includes(t);
                return (
                  <TouchableOpacity key={t} onPress={() => toggleBedType(t)}
                    style={{ flex: 1, paddingVertical: 10, borderRadius: 12, alignItems: 'center', borderWidth: 1.5, borderColor: active ? '#2563EB' : '#EEF1F6', backgroundColor: active ? '#2563EB' : '#F8FAFC' }}>
                    <Text style={{ fontSize: 13, fontWeight: '800', color: active ? '#fff' : '#2563EB' }}>{t}</Text>
                    <Text style={{ fontSize: 9, color: active ? 'rgba(255,255,255,0.85)' : '#64748B' }}>{TYPE_LABEL[t]}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Run button */}
          <TouchableOpacity onPress={runRecommendations} disabled={!recommendationInput || loadingData}
            style={{ backgroundColor: (!recommendationInput || loadingData) ? '#CBD5E1' : '#2563EB', borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginBottom: 16 }}>
            {loadingData ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ fontSize: 15, fontWeight: '800', color: '#fff' }}>Generate Recommendations</Text>}
          </TouchableOpacity>

          {/* Inferred states (when state left blank) */}
          {output?.inferredStates?.length > 0 && (
            <View style={{ backgroundColor: '#EEF3FF', borderRadius: 12, padding: 12, marginBottom: 12 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: '#1D4ED8', marginBottom: 4 }}>Inferred states (from name):</Text>
              <Text style={{ fontSize: 12, color: '#64748B' }}>
                {output.inferredStates.map((s: any) => `${s.state} (${Math.round(s.confidence * 100)}%)`).join(', ')}
              </Text>
            </View>
          )}

          {/* Results: B / C / D */}
          {output && (['B', 'C', 'D'] as BedTypeBCD[]).map(t => {
            const list: any[] = output.recommendations?.[t] ?? [];
            if (!preferredBedTypes.includes(t)) return null;
            return (
              <View key={t} style={{ backgroundColor: '#fff', borderRadius: 16, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: '#0F172A' }}>Type {t}</Text>
                  <Text style={{ fontSize: 12, color: '#64748B' }}>({TYPE_LABEL[t]})</Text>
                  <View style={{ marginLeft: 'auto', backgroundColor: '#EEF3FF', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: '#1D4ED8' }}>{list.length}</Text>
                  </View>
                </View>
                {list.length === 0 ? (
                  <Text style={{ fontSize: 12, color: '#64748B' }}>No vacant beds of this type.</Text>
                ) : (
                  list.map((r: any) => {
                    const aptCode = apartmentCodeById.get(r.apartmentId) || r.apartmentId?.slice(0, 6);
                    const signals: string[] = [];
                    if (r.matchedState && r.matchedState !== 'Unknown') signals.push(r.matchedState);
                    if (r.matchedLanguage && r.matchedLanguage !== 'Unknown') signals.push(r.matchedLanguage);
                    if (r.matchedProfession && r.matchedProfession !== 'Unknown') signals.push(r.matchedProfession);
                    return (
                      <View key={r.bedId} style={{ borderLeftWidth: 4, borderLeftColor: scoreBorder(r.compatibilityScore), backgroundColor: '#F8FAFC', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <Text style={{ fontSize: 12, fontWeight: '700', color: '#64748B' }}>#{r.rank}</Text>
                          <Text style={{ fontSize: 13, fontWeight: '800', color: '#0F172A' }}>{aptCode} · {r.bedCode || r.bedId?.slice(0, 8)}</Text>
                          <View style={{ marginLeft: 'auto', backgroundColor: confidenceBg(r.confidence), borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                            <Text style={{ fontSize: 11, fontWeight: '800', color: confidenceColor(r.confidence) }}>{r.compatibilityScore}%</Text>
                          </View>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                          <View style={{ backgroundColor: '#EEF3FF', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                            <Text style={{ fontSize: 10, fontWeight: '700', color: '#1D4ED8' }}>{MATCH_TYPE_LABEL[r.matchType] ?? r.matchType}</Text>
                          </View>
                          {signals.map((s) => (
                            <View key={s} style={{ backgroundColor: '#F1F3F9', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                              <Text style={{ fontSize: 10, color: '#64748B' }}>{s}</Text>
                            </View>
                          ))}
                          <Text style={{ fontSize: 10, color: '#94A3B8', marginLeft: 'auto' }}>{r.vacancyDays}d vac</Text>
                        </View>
                        {r.adjacentTenantNames?.length > 0 && (
                          <Text style={{ fontSize: 10, color: '#94A3B8', marginTop: 4 }} numberOfLines={1}>adj: {r.adjacentTenantNames.join(', ')}</Text>
                        )}
                        {!!r.reason && <Text style={{ fontSize: 10, color: '#64748B', marginTop: 4 }}>{r.reason}</Text>}
                      </View>
                    );
                  })
                )}
              </View>
            );
          })}
        </ScrollView>

        {/* Property selector modal */}
        <Modal visible={propOpen} transparent animationType="fade" onRequestClose={() => setPropOpen(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setPropOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(30,18,48,0.45)', justifyContent: 'center', padding: 28 }}>
            <View style={{ backgroundColor: '#fff', borderRadius: 18, maxHeight: '70%' }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: '#0F172A', padding: 16, borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>Select Property</Text>
              <ScrollView>
                {properties.length === 0 ? (
                  <Text style={{ fontSize: 13, color: '#64748B', padding: 16 }}>No live properties found.</Text>
                ) : properties.map(p => (
                  <TouchableOpacity key={p.id} onPress={() => { setSelectedPropertyId(p.id); setPropOpen(false); }}
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>
                    <Text style={{ fontSize: 14, fontWeight: selectedPropertyId === p.id ? '800' : '500', color: selectedPropertyId === p.id ? '#2563EB' : '#0F172A' }}>{p.name}</Text>
                    {selectedPropertyId === p.id && <Ionicons name="checkmark" size={18} color="#2563EB" />}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </TouchableOpacity>
        </Modal>
      </SafeAreaView>
    </GlassBackground>
  );
}
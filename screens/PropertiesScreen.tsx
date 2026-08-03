import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Modal, Alert, TextInput, Animated, RefreshControl, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { spacing, fontSize } from '../lib/theme';
import { GlassBackground, Input, LoadingScreen, PickerSelect } from '../components/shared';
import { Ionicons } from '@expo/vector-icons';
import { DrawerActions, useNavigation, useFocusEffect } from '@react-navigation/native';
import { useMountedRef, isAbortError } from '../lib/safeAsync';
import { useQuery } from '@tanstack/react-query';

// ─── Vishful brand palette ────────────────────────────────────────────────────
const VBRAND = {
  purple: '#7B2FBE', purpleDeep: '#3D1A6E', orange: '#E8841A',
  ink900: '#1E1230', ink700: '#3F2F58', ink600: '#5C4E70',
  ink500: '#7B6B90', ink400: '#9B8BAE',
  surface: 'rgba(255,255,255,0.92)',
  cardBorder: 'rgba(123,47,190,0.08)',
  shadow: '#3D1A6E',
};

const STATUS_OPTS = [
  { label: 'Live',        value: 'live'        },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Inactive',    value: 'inactive'    },
  { label: 'Exited',      value: 'exited'      },
  { label: 'Signed',      value: 'signed'      },
];

// ─── Status visual helpers ────────────────────────────────────────────────────
const statusMeta = (s: string) => {
  switch (s) {
    case 'live':        return { color: '#0F8F5F', bg: 'rgba(15,143,95,0.1)',   label: 'Live',        dot: '#10B981' };
    case 'in_progress': return { color: '#B45309', bg: 'rgba(217,119,6,0.1)',   label: 'In Progress', dot: '#F59E0B' };
    case 'inactive':    return { color: '#6B7280', bg: 'rgba(107,114,128,0.1)', label: 'Inactive',    dot: '#9CA3AF' };
    case 'exited':      return { color: '#B91C1C', bg: 'rgba(220,38,38,0.1)',   label: 'Exited',      dot: '#EF4444' };
    case 'signed':      return { color: VBRAND.purple, bg: 'rgba(123,47,190,0.1)', label: 'Signed',  dot: VBRAND.purple };
    default:            return { color: VBRAND.ink600, bg: 'rgba(123,47,190,0.06)', label: s,        dot: VBRAND.ink400 };
  }
};

// ─── Stat tile ────────────────────────────────────────────────────────────────
function VStat({ label, value, icon, accent, sub }: {
  label: string; value: string | number; icon: string; accent: string; sub?: string;
}) {
  return (
    <View style={styles.statTile}>
      <View style={[styles.statIcon, { backgroundColor: accent + '18' }]}>
        <Ionicons name={icon as any} size={16} color={accent} />
      </View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      {sub ? <Text style={styles.statSub}>{sub}</Text> : null}
    </View>
  );
}

// ─── Property card ────────────────────────────────────────────────────────────
function PropertyCard({
  p, onPress, onEdit, onDelete,
}: {
  p: any;
  onPress: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const sm = statusMeta(p.status);

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.9} style={styles.card}>
      {/* Top row: code chip + status + menu */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <View style={styles.codePill}>
          <View style={styles.codeDot} />
          <Text style={styles.codePillText}>{p.code}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={[styles.statusPill, { backgroundColor: sm.bg }]}>
            <View style={[styles.statusDot, { backgroundColor: sm.dot }]} />
            <Text style={[styles.statusLabel, { color: sm.color }]}>{sm.label}</Text>
          </View>
          {/* 3-dot menu */}
          <TouchableOpacity
            onPress={() => setMenuOpen(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.menuBtn}
          >
            <Ionicons name="ellipsis-vertical" size={16} color={VBRAND.ink500} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Property name */}
      <Text style={styles.propName} numberOfLines={1}>{p.name}</Text>

      {/* Address */}
      {(p.address || p.city) ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 }}>
          <Ionicons name="location-outline" size={13} color={VBRAND.ink500} />
          <Text style={styles.propAddr} numberOfLines={1}>
            {[p.address, p.city].filter(Boolean).join(', ')}
          </Text>
        </View>
      ) : null}

      {/* Apts + Beds footer */}
      <View style={styles.cardFooter}>
        <View style={styles.footerChip}>
          <View style={[styles.footerIcon, { backgroundColor: 'rgba(123,47,190,0.12)' }]}>
            <Ionicons name="grid-outline" size={12} color={VBRAND.purple} />
          </View>
          <View>
            <Text style={styles.footerVal}>{p.apartmentCount ?? 0}</Text>
            <Text style={styles.footerLbl}>APTS</Text>
          </View>
        </View>
        <View style={[styles.footerChip, { backgroundColor: 'rgba(232,132,26,0.05)' }]}>
          <View style={[styles.footerIcon, { backgroundColor: 'rgba(232,132,26,0.14)' }]}>
            <Ionicons name="bed-outline" size={12} color={VBRAND.orange} />
          </View>
          <View>
            <Text style={styles.footerVal}>{p.liveBedCount ?? p.bedCount ?? 0}</Text>
            <Text style={styles.footerLbl}>LIVE BEDS</Text>
          </View>
        </View>
      </View>

      {/* Context menu modal */}
      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <TouchableOpacity
          style={styles.menuBackdrop}
          activeOpacity={1}
          onPress={() => setMenuOpen(false)}
        >
          <View style={styles.menuSheet}>
            <Text style={styles.menuPropName} numberOfLines={1}>{p.name}</Text>

            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => { setMenuOpen(false); onPress(); }}
            >
              <Ionicons name="eye-outline" size={18} color={VBRAND.purple} />
              <Text style={styles.menuRowTxt}>View Details</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => { setMenuOpen(false); setTimeout(onEdit, 180); }}
            >
              <Ionicons name="create-outline" size={18} color={VBRAND.ink700} />
              <Text style={styles.menuRowTxt}>Edit Property</Text>
            </TouchableOpacity>

            <View style={styles.menuDivider} />

            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                setMenuOpen(false);
                setTimeout(onDelete, 180);
              }}
            >
              <Ionicons name="trash-outline" size={18} color="#DC2626" />
              <Text style={[styles.menuRowTxt, { color: '#DC2626' }]}>Delete Property</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </TouchableOpacity>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function PropertiesScreen({ navigation }: any) {
  const { token } = useAuth();
  const nav = useNavigation();
  const mounted = useMountedRef();

  const [searchQuery, setSearchQuery] = useState('');

  // ── Add property state ──
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState('');
  const [addAddress, setAddAddress] = useState('');
  const [addCity, setAddCity] = useState('');
  const [addStatus, setAddStatus] = useState('live');
  const [addLoading, setAddLoading] = useState(false);

  // ── Edit property state ──
  const [showEdit, setShowEdit] = useState(false);
  const [editTarget, setEditTarget] = useState<any>(null);
  const [editName, setEditName] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editCity, setEditCity] = useState('');
  const [editStatus, setEditStatus] = useState('live');
  const [editLoading, setEditLoading] = useState(false);

  // ── Fetch (cache-first via React Query) ──
  // Persisted cache → the list renders instantly on open and survives offline.
  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    enabled: !!token,
    queryFn: async () => (await sb.listPropertiesEnriched()) ?? [],
  });
  const properties: any[] | null = propertiesQuery.data ?? null;
  const { refetch } = propertiesQuery;
  const refresh = () => { refetch(); };

  // Refresh when returning to the screen (mount + focus fetches dedupe).
  useFocusEffect(
    React.useCallback(() => { refetch(); }, [refetch])
  );

  // ── Handlers ──
  const handleAdd = async () => {
    if (!addName.trim()) { Alert.alert('Required', 'Property name is required'); return; }
    setAddLoading(true);
    try {
      await sb.createProperty({
        name: addName.trim(),
        address: addAddress.trim() || undefined,
        city: addCity.trim() || undefined,
        status: addStatus as any,
      });
      setShowAdd(false);
      setAddName(''); setAddAddress(''); setAddCity(''); setAddStatus('live');
      refresh();
    } catch (e: any) { Alert.alert('Error', e.message); }
    setAddLoading(false);
  };

  const openEdit = (p: any) => {
    setEditTarget(p);
    setEditName(p.name || '');
    setEditAddress(p.address || '');
    setEditCity(p.city || '');
    setEditStatus(p.status || 'live');
    setShowEdit(true);
  };

  const handleEdit = async () => {
    if (!editName.trim()) { Alert.alert('Required', 'Property name is required'); return; }
    setEditLoading(true);
    try {
      await sb.updateProperty(editTarget._id || editTarget.id, {
        name:    editName.trim(),
        property_name: editName.trim(),
        address: editAddress.trim() || null,
        city:    editCity.trim()    || null,
        status:  editStatus,
      });
      setShowEdit(false);
      setEditTarget(null);
      refresh();
    } catch (e: any) { Alert.alert('Error', e.message); }
    setEditLoading(false);
  };

  const handleDelete = (p: any) => {
    Alert.alert(
      'Delete Property',
      `Delete "${p.name}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await sb.deleteProperty(p._id || p.id);
              refresh();
            } catch (e: any) { Alert.alert('Error', e.message); }
          },
        },
      ],
    );
  };

  const navigateToDetail = (p: any, tab?: string) => {
    navigation.navigate('PropertyDetail', {
      propertyId:   p._id,
      propertyName: p.name,
      initialTab:   tab,
    });
  };

  // ── Derived stats ──
  if (!properties) return <LoadingScreen />;

  const totalProps = properties.length;
  const liveProps  = properties.filter((p: any) => p.status === 'live').length;
  const totalApts  = properties.reduce((s: number, p: any) => s + (p.apartmentCount || 0), 0);
  const liveBeds   = properties.reduce((s: number, p: any) => s + (p.liveBedCount ?? p.bedCount ?? 0), 0);

  const filtered = searchQuery
    ? properties.filter((p: any) => {
        const q = searchQuery.toLowerCase();
        return [p.name, p.code, p.address, p.city].some(v => v && String(v).toLowerCase().includes(q));
      })
    : properties;

  // ────────────────────────────────────────────────────────────────────────────
  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>

        {/* ── Header ───────────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center', marginRight: 10 }}>
            <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.headerSub}>Portfolio · {liveProps} live</Text>
            <Text style={styles.headerTitle}>Properties</Text>
          </View>

          {/* Add property — gradient pill */}
          <TouchableOpacity
            onPress={() => setShowAdd(true)}
            activeOpacity={0.85}
            style={styles.addPill}
          >
            <LinearGradient
              colors={[VBRAND.purple, VBRAND.orange]}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              style={styles.addPillInner}
            >
              <Ionicons name="add" size={18} color="#fff" />
              <Text style={styles.addPillTxt}>Add</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {/* ── Search ───────────────────────────────────────────────────────── */}
        <View style={styles.searchWrap}>
          <View style={styles.searchBar}>
            <Ionicons name="search-outline" size={18} color={VBRAND.ink400} />
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search properties, cities, codes…"
              placeholderTextColor={VBRAND.ink400}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity
                onPress={() => setSearchQuery('')}
                style={styles.clearBtn}
              >
                <Ionicons name="close" size={13} color={VBRAND.purple} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={propertiesQuery.isRefetching} onRefresh={refresh} tintColor={VBRAND.purple} />}
        >
          {/* ── Stats grid: 2×2 ─────────────────────────────────────────── */}
          <View style={styles.statsGrid}>
            <VStat
              label="Total Properties"
              value={totalProps}
              icon="business-outline"
              accent={VBRAND.purple}
              sub={`${liveProps} live`}
            />
            <VStat
              label="Apartments"
              value={totalApts}
              icon="grid-outline"
              accent={VBRAND.purple}
            />
            <VStat
              label="Live Beds"
              value={liveBeds}
              icon="bed-outline"
              accent={VBRAND.orange}
            />
            <VStat
              label="Live"
              value={liveProps}
              icon="checkmark-circle-outline"
              accent="#10B981"
              sub="properties"
            />
          </View>

          {/* ── Section label ─────────────────────────────────────────────── */}
          <View style={styles.sectionRow}>
            <Text style={styles.sectionLabel}>
              {searchQuery ? `Results · ${filtered.length}` : `All Properties · ${properties.length}`}
            </Text>
          </View>

          {/* ── Property list ─────────────────────────────────────────────── */}
          {filtered.length === 0 ? (
            <View style={styles.emptyBox}>
              <View style={styles.emptyIcon}>
                <Ionicons name="business-outline" size={28} color={VBRAND.purple} />
              </View>
              <Text style={styles.emptyTitle}>
                {searchQuery ? 'No matches' : 'No properties yet'}
              </Text>
              <Text style={styles.emptySub}>
                {searchQuery ? 'Try different search terms' : 'Add your first property to get started'}
              </Text>
              {!searchQuery && (
                <TouchableOpacity
                  onPress={() => setShowAdd(true)}
                  activeOpacity={0.85}
                  style={{ marginTop: 16, borderRadius: 999, overflow: 'hidden' }}
                >
                  <LinearGradient
                    colors={[VBRAND.purple, VBRAND.orange]}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={{ paddingHorizontal: 18, paddingVertical: 10 }}
                  >
                    <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>+ Add Property</Text>
                  </LinearGradient>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            filtered.map((p: any) => (
              <PropertyCard
                key={p._id}
                p={p}
                onPress={() => navigateToDetail(p)}
                onEdit={() => openEdit(p)}
                onDelete={() => handleDelete(p)}
              />
            ))
          )}
        </ScrollView>

        {/* ══════════════════════════════════════════════════════════════════ */}
        {/* ADD PROPERTY MODAL                                                 */}
        {/* ══════════════════════════════════════════════════════════════════ */}
        <Modal
          visible={showAdd}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setShowAdd(false)}
        >
          <GlassBackground>
            <SafeAreaView style={{ flex: 1 }}>
              <View style={styles.modalHeader}>
                <TouchableOpacity onPress={() => setShowAdd(false)} style={styles.modalCloseBtn}>
                  <Ionicons name="close" size={22} color={VBRAND.ink900} />
                </TouchableOpacity>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.modalHeaderSub}>Portfolio</Text>
                  <Text style={styles.modalHeaderTitle}>Add Property</Text>
                </View>
              </View>

              <ScrollView contentContainerStyle={styles.modalScroll}>
                <View style={styles.formCard}>
                  <View style={styles.formCardHeader}>
                    <View style={styles.formCardIcon}>
                      <Ionicons name="business-outline" size={17} color={VBRAND.purple} />
                    </View>
                    <Text style={styles.formCardTitle}>Property Details</Text>
                  </View>
                  <Input label="Property Name *" value={addName} onChangeText={setAddName} placeholder="e.g. Sunrise Villa" />
                  <Input label="Address" value={addAddress} onChangeText={setAddAddress} placeholder="Full address" />
                  <Input label="City" value={addCity} onChangeText={setAddCity} placeholder="City" />
                  <PickerSelect label="Status" value={addStatus} options={STATUS_OPTS} onSelect={setAddStatus} />
                </View>

                <TouchableOpacity
                  onPress={handleAdd}
                  disabled={addLoading || !addName.trim()}
                  activeOpacity={0.9}
                  style={[styles.submitBtn, (!addName.trim() || addLoading) && { opacity: 0.5 }]}
                >
                  <LinearGradient
                    colors={!addName.trim() || addLoading ? ['#9CA3AF', '#6B7280'] : [VBRAND.purple, VBRAND.orange]}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={styles.submitGradient}
                  >
                    <Ionicons name={addLoading ? 'hourglass-outline' : 'add-circle-outline'} size={18} color="#fff" />
                    <Text style={styles.submitTxt}>{addLoading ? 'Creating…' : 'Create Property'}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </ScrollView>
            </SafeAreaView>
          </GlassBackground>
        </Modal>

        {/* ══════════════════════════════════════════════════════════════════ */}
        {/* EDIT PROPERTY MODAL                                                */}
        {/* ══════════════════════════════════════════════════════════════════ */}
        <Modal
          visible={showEdit}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setShowEdit(false)}
        >
          <GlassBackground>
            <SafeAreaView style={{ flex: 1 }}>
              <View style={styles.modalHeader}>
                <TouchableOpacity onPress={() => setShowEdit(false)} style={styles.modalCloseBtn}>
                  <Ionicons name="close" size={22} color={VBRAND.ink900} />
                </TouchableOpacity>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.modalHeaderSub}>Portfolio</Text>
                  <Text style={styles.modalHeaderTitle}>Edit Property</Text>
                </View>
              </View>

              <ScrollView contentContainerStyle={styles.modalScroll}>
                <View style={styles.formCard}>
                  <View style={styles.formCardHeader}>
                    <View style={styles.formCardIcon}>
                      <Ionicons name="create-outline" size={17} color={VBRAND.purple} />
                    </View>
                    <Text style={styles.formCardTitle}>Update Details</Text>
                  </View>

                  <Input label="Property Name *" value={editName} onChangeText={setEditName} placeholder="e.g. Sunrise Villa" />
                  <Input label="Address" value={editAddress} onChangeText={setEditAddress} placeholder="Full address" />
                  <Input label="City" value={editCity} onChangeText={setEditCity} placeholder="City" />
                  <PickerSelect label="Status" value={editStatus} options={STATUS_OPTS} onSelect={setEditStatus} />
                </View>

                <TouchableOpacity
                  onPress={handleEdit}
                  disabled={editLoading || !editName.trim()}
                  activeOpacity={0.9}
                  style={[styles.submitBtn, (!editName.trim() || editLoading) && { opacity: 0.5 }]}
                >
                  <LinearGradient
                    colors={!editName.trim() || editLoading ? ['#9CA3AF', '#6B7280'] : [VBRAND.purple, '#5A1F8E']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={styles.submitGradient}
                  >
                    <Ionicons name={editLoading ? 'hourglass-outline' : 'checkmark-circle-outline'} size={18} color="#fff" />
                    <Text style={styles.submitTxt}>{editLoading ? 'Saving…' : 'Save Changes'}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </ScrollView>
            </SafeAreaView>
          </GlassBackground>
        </Modal>

      </SafeAreaView>
    </GlassBackground>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  // ── Header ──────────────────────────────────────────────────────────────
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 18, paddingTop: 8, paddingBottom: 14,
  },
  headerSub: {
    fontSize: 10, color: VBRAND.ink400, fontWeight: '800',
    letterSpacing: 1.2, textTransform: 'uppercase',
  },
  headerTitle: { fontSize: 22, fontWeight: '900', color: VBRAND.ink900, letterSpacing: -0.4, marginTop: 2 },
  iconBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: VBRAND.shadow, shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
  },
  addPill: { borderRadius: 999, overflow: 'hidden', shadowColor: VBRAND.purple, shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  addPillInner: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 14, paddingVertical: 9 },
  addPillTxt: { color: '#fff', fontWeight: '800', fontSize: 13, letterSpacing: 0.3 },

  // ── Search ──────────────────────────────────────────────────────────────
  searchWrap: { paddingHorizontal: 18, paddingBottom: 12 },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(255,255,255,0.78)', borderRadius: 14,
    paddingHorizontal: 14, height: 46,
    borderWidth: 0.5, borderColor: 'rgba(123,47,190,0.12)',
    shadowColor: VBRAND.shadow, shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
  },
  searchInput: { flex: 1, fontSize: 14, color: VBRAND.ink900, height: 46, fontWeight: '500' },
  clearBtn: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(123,47,190,0.1)', alignItems: 'center', justifyContent: 'center' },

  // ── Scroll body ─────────────────────────────────────────────────────────
  scroll: { paddingHorizontal: 18, paddingBottom: 100, paddingTop: 4 },

  // ── Stats ────────────────────────────────────────────────────────────────
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 18 },
  statTile: {
    width: '47%', flexGrow: 1,
    backgroundColor: VBRAND.surface,
    borderRadius: 18, padding: 14,
    borderWidth: 0.5, borderColor: VBRAND.cardBorder,
    shadowColor: VBRAND.shadow, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
  },
  statIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  statValue: { fontSize: 24, fontWeight: '900', color: VBRAND.ink900, letterSpacing: -0.5 },
  statLabel: { fontSize: 11, fontWeight: '700', color: VBRAND.ink500, marginTop: 2, letterSpacing: 0.3, textTransform: 'uppercase' },
  statSub:   { fontSize: 10, fontWeight: '600', color: VBRAND.ink400, marginTop: 1 },

  // ── Section header ───────────────────────────────────────────────────────
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, paddingHorizontal: 2 },
  sectionLabel: { fontSize: 11, fontWeight: '800', color: VBRAND.ink500, letterSpacing: 1, textTransform: 'uppercase' },

  // ── Property card ────────────────────────────────────────────────────────
  card: {
    backgroundColor: VBRAND.surface,
    borderRadius: 20, padding: 16, marginBottom: 12,
    borderWidth: 0.5, borderColor: VBRAND.cardBorder,
    shadowColor: VBRAND.shadow, shadowOpacity: 0.07, shadowRadius: 14, shadowOffset: { width: 0, height: 5 },
  },
  codePill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(123,47,190,0.08)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 0.5, borderColor: 'rgba(123,47,190,0.15)' },
  codeDot:  { width: 5, height: 5, borderRadius: 3, backgroundColor: VBRAND.purple },
  codePillText: { fontSize: 11, fontWeight: '800', color: VBRAND.purpleDeep, letterSpacing: 0.5 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.2 },
  menuBtn: { padding: 4 },
  propName: { fontSize: 17, fontWeight: '800', color: VBRAND.ink900, letterSpacing: -0.3 },
  propAddr: { fontSize: 12, fontWeight: '500', color: VBRAND.ink500, flex: 1 },
  cardFooter: { flexDirection: 'row', gap: 8, marginTop: 14, paddingTop: 12, borderTopWidth: 0.5, borderTopColor: 'rgba(123,47,190,0.08)' },
  footerChip: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(123,47,190,0.04)', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12 },
  footerIcon: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  footerVal:  { fontSize: 14, fontWeight: '800', color: VBRAND.ink900, letterSpacing: -0.2 },
  footerLbl:  { fontSize: 10, fontWeight: '700', color: VBRAND.ink500, letterSpacing: 0.3, textTransform: 'uppercase' },

  // ── Context menu ────────────────────────────────────────────────────────
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  menuSheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 8, paddingBottom: 40, paddingHorizontal: 20,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, shadowOffset: { width: 0, height: -4 },
  },
  menuPropName: { fontSize: 13, fontWeight: '700', color: VBRAND.ink500, paddingVertical: 12, paddingHorizontal: 4, borderBottomWidth: 0.5, borderBottomColor: 'rgba(123,47,190,0.1)', marginBottom: 4 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 4 },
  menuRowTxt: { fontSize: 15, fontWeight: '600', color: VBRAND.ink900 },
  menuDivider: { height: 0.5, backgroundColor: 'rgba(123,47,190,0.1)', marginVertical: 4 },

  // ── Empty state ─────────────────────────────────────────────────────────
  emptyBox: { backgroundColor: VBRAND.surface, borderRadius: 20, padding: 32, alignItems: 'center', borderWidth: 0.5, borderColor: VBRAND.cardBorder, marginTop: 10 },
  emptyIcon: { width: 64, height: 64, borderRadius: 20, backgroundColor: 'rgba(123,47,190,0.08)', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: VBRAND.ink900, letterSpacing: -0.2 },
  emptySub:   { fontSize: 13, fontWeight: '500', color: VBRAND.ink500, marginTop: 4, textAlign: 'center' },

  // ── Modals ───────────────────────────────────────────────────────────────
  modalHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 8, paddingBottom: 14 },
  modalCloseBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.6)', alignItems: 'center', justifyContent: 'center', shadowColor: VBRAND.shadow, shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  modalHeaderSub:   { fontSize: 10, color: VBRAND.ink400, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase' },
  modalHeaderTitle: { fontSize: 20, fontWeight: '900', color: VBRAND.ink900, letterSpacing: -0.4, marginTop: 2 },
  modalScroll: { padding: 18, paddingBottom: 80, gap: 12 },

  formCard: { backgroundColor: VBRAND.surface, borderRadius: 18, padding: 16, borderWidth: 0.5, borderColor: VBRAND.cardBorder, shadowColor: VBRAND.shadow, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, gap: 14 },
  formCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  formCardIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: 'rgba(123,47,190,0.1)', alignItems: 'center', justifyContent: 'center' },
  formCardTitle: { fontSize: 14, fontWeight: '800', color: VBRAND.ink900, letterSpacing: -0.2 },

  submitBtn: { borderRadius: 16, overflow: 'hidden', marginTop: 4, shadowColor: VBRAND.purple, shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } },
  submitGradient: { paddingVertical: 16, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  submitTxt: { color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },
});
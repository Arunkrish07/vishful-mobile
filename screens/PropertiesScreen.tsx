import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Modal, Alert, TextInput, Animated, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { spacing, fontSize } from '../lib/theme';
import { GlassBackground, Input, LoadingScreen, PickerSelect, PageHeader, IconBtnSolid, SearchField } from '../components/shared';
import { Ionicons } from '@expo/vector-icons';
import { DrawerActions, useNavigation, useFocusEffect } from '@react-navigation/native';
import { useMountedRef, isAbortError } from '../lib/safeAsync';
import { useQuery } from '@tanstack/react-query';

// ─── Blue / slate design tokens (web chrome) ──────────────────────────────────
const VBRAND = {
  purple: '#2563EB', purpleDeep: '#1D4ED8', orange: '#4F46E5',
  ink900: '#111827', ink700: '#374151', ink600: '#6B7280',
  ink500: '#6B7280', ink400: '#9CA3AF',
  surface: '#FFFFFF',
  cardBorder: '#E5E7EB',
  soft: '#EFF6FF',
  shadow: '#0F172A',
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
    case 'live':        return { color: '#22C55E', bg: '#ECFDF5',   label: 'Live',        dot: '#22C55E' };
    case 'in_progress': return { color: '#F59E0B', bg: '#FFFBEB',   label: 'In Progress', dot: '#F59E0B' };
    case 'inactive':    return { color: '#6B7280', bg: '#F1F5F9', label: 'Inactive',    dot: '#9CA3AF' };
    case 'exited':      return { color: '#EF4444', bg: '#FEF2F2', label: 'Exited',      dot: '#EF4444' };
    case 'signed':      return { color: VBRAND.purple, bg: '#EEF2FF', label: 'Signed',  dot: VBRAND.purple };
    default:            return { color: VBRAND.ink600, bg: '#EEF2FF', label: s,        dot: VBRAND.ink400 };
  }
};

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
          <View style={[styles.footerIcon, { backgroundColor: '#EFF6FF' }]}>
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

  // ── Derived list ──
  if (!properties) return <LoadingScreen />;

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
        <PageHeader
          title="Properties"
          subtitle="Properties, apartments and beds"
          right={<IconBtnSolid icon="add" onPress={() => setShowAdd(true)} />}
        />

        {/* ── Search ───────────────────────────────────────────────────────── */}
        <View style={styles.searchWrap}>
          <SearchField
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search places..."
          />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={propertiesQuery.isRefetching} onRefresh={refresh} tintColor={VBRAND.purple} />}
        >
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
                <View style={{ marginTop: 16 }}>
                  <IconBtnSolid icon="add" label="Add Property" onPress={() => setShowAdd(true)} />
                </View>
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
                    colors={!addName.trim() || addLoading ? ['#9CA3AF', '#6B7280'] : ['#1D4ED8', '#2563EB']}
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
                    colors={!editName.trim() || editLoading ? ['#9CA3AF', '#6B7280'] : ['#1D4ED8', '#2563EB']}
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
    fontSize: 13, color: VBRAND.ink600, fontWeight: '500', marginTop: 2,
  },
  headerTitle: { fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 },
  iconBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1, borderColor: '#E5E7EB',
    alignItems: 'center', justifyContent: 'center',
  },

  // ── Search ──────────────────────────────────────────────────────────────
  searchWrap: { paddingHorizontal: 16, paddingBottom: 12 },

  // ── Scroll body ─────────────────────────────────────────────────────────
  scroll: { paddingHorizontal: 18, paddingBottom: 100, paddingTop: 4 },

  // ── Section header ───────────────────────────────────────────────────────
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, paddingHorizontal: 2 },
  sectionLabel: { fontSize: 11, fontWeight: '800', color: VBRAND.ink500, letterSpacing: 1, textTransform: 'uppercase' },

  // ── Property card ────────────────────────────────────────────────────────
  card: {
    backgroundColor: VBRAND.surface,
    borderRadius: 14, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: VBRAND.cardBorder,
  },
  codePill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#EFF6FF', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: '#DBEAFE' },
  codeDot:  { width: 5, height: 5, borderRadius: 3, backgroundColor: VBRAND.purple },
  codePillText: { fontSize: 11, fontWeight: '800', color: VBRAND.purpleDeep, letterSpacing: 0.5 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.2 },
  menuBtn: { padding: 4 },
  propName: { fontSize: 17, fontWeight: '800', color: VBRAND.ink900, letterSpacing: -0.3 },
  propAddr: { fontSize: 12, fontWeight: '500', color: VBRAND.ink500, flex: 1 },
  cardFooter: { flexDirection: 'row', gap: 8, marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#E5E7EB' },
  footerChip: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#F8FAFC', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12 },
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
  menuPropName: { fontSize: 13, fontWeight: '700', color: VBRAND.ink500, paddingVertical: 12, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: '#E5E7EB', marginBottom: 4 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 4 },
  menuRowTxt: { fontSize: 15, fontWeight: '600', color: VBRAND.ink900 },
  menuDivider: { height: 1, backgroundColor: '#E5E7EB', marginVertical: 4 },

  // ── Empty state ─────────────────────────────────────────────────────────
  emptyBox: { backgroundColor: VBRAND.surface, borderRadius: 14, padding: 32, alignItems: 'center', borderWidth: 1, borderColor: VBRAND.cardBorder, marginTop: 10 },
  emptyIcon: { width: 64, height: 64, borderRadius: 14, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: VBRAND.ink900, letterSpacing: -0.2 },
  emptySub:   { fontSize: 13, fontWeight: '500', color: VBRAND.ink500, marginTop: 4, textAlign: 'center' },

  // ── Modals ───────────────────────────────────────────────────────────────
  modalHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 8, paddingBottom: 14 },
  modalCloseBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E5E7EB', alignItems: 'center', justifyContent: 'center' },
  modalHeaderSub:   { fontSize: 13, color: VBRAND.ink600, fontWeight: '500' },
  modalHeaderTitle: { fontSize: 22, fontWeight: '800', color: VBRAND.ink900, letterSpacing: -0.4, marginTop: 2 },
  modalScroll: { padding: 18, paddingBottom: 80, gap: 12 },

  formCard: { backgroundColor: VBRAND.surface, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: VBRAND.cardBorder, gap: 14 },
  formCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  formCardIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center' },
  formCardTitle: { fontSize: 14, fontWeight: '800', color: VBRAND.ink900, letterSpacing: -0.2 },

  submitBtn: { borderRadius: 14, overflow: 'hidden', marginTop: 4, shadowColor: VBRAND.purpleDeep, shadowOpacity: 0.2, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } },
  submitGradient: { paddingVertical: 16, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  submitTxt: { color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },
});
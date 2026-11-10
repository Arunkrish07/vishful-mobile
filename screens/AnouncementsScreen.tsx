import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Modal, Alert, RefreshControl, TextInput, Image, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { spacing, fontSize, glass } from '../lib/theme';
import { Button, Input, EmptyState, LoadingScreen, GlassBackground, IconBtnSolid, SearchField } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { Ionicons } from '@expo/vector-icons';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import { useMountedRef, isAbortError } from '../lib/safeAsync';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Announcement {
  id: string;
  title: string;
  content: string;
  image_url?: string | null;
  priority: 'normal' | 'important' | 'urgent';
  is_published: boolean;
  published_at?: string | null;
  created_at: string;
  created_by?: string;
}

const PRIORITY_CONFIG = {
  normal:    { color: '#64748b', bg: '#f1f5f9', label: 'Normal',    icon: 'information-circle-outline' as const },
  important: { color: '#d97706', bg: '#fef3c7', label: 'Important', icon: 'warning-outline' as const },
  urgent:    { color: '#dc2626', bg: '#fee2e2', label: 'Urgent',    icon: 'alert-circle-outline' as const },
};

const EMPTY_FORM = { title: '', content: '', priority: 'normal' as const, image_url: '' };

// Announcement writes go through service-role Convex actions. Until those are
// deployed, anyApi resolves the call and the backend replies "Could not find
// public function" — surface that as a clear, non-cryptic message.
const WRITE_NOT_DEPLOYED =
  'Creating or editing announcements needs a backend update that hasn\'t been deployed yet. Viewing the list and sending on WhatsApp already work.';
function friendlyWriteError(e: any): string {
  const m = String(e?.message || e || '');
  if (/could not find public function|couldnotfindpublicfunction/i.test(m)) return WRITE_NOT_DEPLOYED;
  return m || 'Operation failed';
}

// ─── Main Screen ─────────────────────────────────────────────────────────────
export default function AnnouncementsScreen() {
  const { token, user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'super_admin';
  const nav = useNavigation();
  const mounted = useMountedRef();

  const [announcements, setAnnouncements] = useState<Announcement[] | null>(null);
  const [search, setSearch]               = useState('');
  const [filterPublished, setFilterPublished] = useState<'all' | 'published' | 'draft'>('all');
  const [refreshing, setRefreshing]       = useState(false);
  const [loading, setLoading]             = useState(false);
  const [refreshKey, setRefreshKey]       = useState(0);
  const refresh = useCallback(() => setRefreshKey(k => k + 1), []);

  // Modals
  const [showAdd,  setShowAdd]  = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [selected, setSelected] = useState<Announcement | null>(null);
  const [form, setForm]         = useState({ ...EMPTY_FORM });
  const setF = (k: keyof typeof EMPTY_FORM) => (v: string) => setForm(p => ({ ...p, [k]: v }));

  // ── Load ──
  useEffect(() => {
    if (!token) return;
    setAnnouncements(null);
    sb.listAnnouncements().then((rows: any) => {
      if (!mounted.current) return;
      // Sort newest first
      const sorted = (rows ?? []).sort((a: any, b: any) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      setAnnouncements(sorted);
    }).catch((e: any) => {
      if (!mounted.current || isAbortError(e)) return;
      setAnnouncements([]);
    });
  }, [token, refreshKey]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const rows: any = await sb.listAnnouncements();
      if (mounted.current) {
        const sorted = (rows ?? []).sort((a: any, b: any) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        setAnnouncements(sorted);
      }
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  // ── Filtered ──
  const filtered = (announcements || []).filter(a => {
    const q = search.toLowerCase();
    const matchSearch = !q ||
      (a.title   || '').toLowerCase().includes(q) ||
      (a.content || '').toLowerCase().includes(q);
    const matchPublished =
      filterPublished === 'all' ||
      (filterPublished === 'published' && a.is_published) ||
      (filterPublished === 'draft'     && !a.is_published);
    return matchSearch && matchPublished;
  });

  // ── Stats ──
  const total     = (announcements || []).length;
  const published = (announcements || []).filter(a => a.is_published).length;
  const urgent    = (announcements || []).filter(a => a.priority === 'urgent' && a.is_published).length;

  // ── CRUD ──
  const handleAdd = async (sendWa = false) => {
    if (!form.title.trim())   { Alert.alert('Validation', 'Title is required'); return; }
    if (!form.content.trim()) { Alert.alert('Validation', 'Content is required'); return; }
    setLoading(true);
    try {
      await sb.createAnnouncement({
        title: form.title.trim(),
        content: form.content.trim(),
        priority: form.priority,
        imageUrl: form.image_url?.trim() || null,
        // Web parity: creating (with or without Send) stores a draft. Sending only
        // broadcasts on WhatsApp; visibility in the tenant app is controlled by the
        // explicit Publish toggle (is_published), matching web createAndSend.
        isPublished: false,
        createdBy: user?.userId || null,
      });
      setShowAdd(false);
      const sent = { title: form.title.trim(), content: form.content.trim(), priority: form.priority, image_url: form.image_url?.trim() || null };
      setForm({ ...EMPTY_FORM });
      refresh();
      if (sendWa) await broadcastWhatsapp(sent);
    } catch (e: any) {
      Alert.alert('Error', friendlyWriteError(e));
    } finally {
      setLoading(false);
    }
  };

  // ── WhatsApp broadcast (mirrors web createAndSend → whatsapp-notify) ──
  const broadcastWhatsapp = async (ann: { title: string; content: string; priority?: string; image_url?: string | null }) => {
    try {
      const res = await sb.sendAnnouncementWhatsapp(ann.title, ann.content, ann.priority || 'normal', ann.image_url ?? null);
      if (res?.ok) {
        Alert.alert('Queued on WhatsApp', 'Your announcement is being sent to active tenants in the background. Track delivery progress under WhatsApp Logs.');
      } else if (res?.skipped === 'whatsapp_disabled') {
        Alert.alert('WhatsApp is off', res.reason || 'Turn on WhatsApp under Settings to send announcements.');
      } else {
        Alert.alert('WhatsApp send failed', res?.reason || 'Could not send the announcement on WhatsApp. It was still saved.');
      }
    } catch (e: any) {
      Alert.alert('WhatsApp send failed', e?.message || 'Could not send the announcement on WhatsApp.');
    }
  };

  // ── Send an EXISTING announcement over WhatsApp ──
  const handleSendExisting = (ann: Announcement) => {
    Alert.alert('Send on WhatsApp', `Send "${ann.title}" to all active tenants on WhatsApp?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Send', onPress: () => broadcastWhatsapp({ title: ann.title, content: ann.content, priority: ann.priority, image_url: ann.image_url }) },
    ]);
  };

  const handleEdit = async () => {
    if (!selected) return;
    if (!form.title.trim())   { Alert.alert('Validation', 'Title is required'); return; }
    if (!form.content.trim()) { Alert.alert('Validation', 'Content is required'); return; }
    setLoading(true);
    try {
      await sb.updateAnnouncement({
        id: selected.id,
        title: form.title.trim(),
        content: form.content.trim(),
        priority: form.priority,
        imageUrl: form.image_url?.trim() || null,
      });
      setShowEdit(false);
      setSelected(null);
      refresh();
    } catch (e: any) {
      Alert.alert('Error', friendlyWriteError(e));
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePublish = async (ann: Announcement) => {
    const newPublished = !ann.is_published;
    const action = newPublished ? 'Publish' : 'Unpublish';
    Alert.alert(
      `${action} Announcement`,
      newPublished
        ? `"${ann.title}" will be visible to all tenants.`
        : `"${ann.title}" will be hidden from tenants.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: action, style: newPublished ? 'default' : 'destructive',
          onPress: async () => {
            try {
              await sb.updateAnnouncement({ id: ann.id, isPublished: newPublished });
              refresh();
            } catch (e: any) {
              Alert.alert('Error', friendlyWriteError(e));
            }
          },
        },
      ]
    );
  };

  // ── Pick + upload an announcement banner image (mirrors web uploadAnnouncementImage) ──
  const [imgUploading, setImgUploading] = useState(false);
  const handlePickImage = async () => {
    try {
      const ImagePicker = await import('expo-image-picker') as any;
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permission needed', 'Please allow photo access to add a banner image.'); return; }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.8, base64: true });
      if (result.canceled || !result.assets?.[0]?.base64) return;
      const asset = result.assets[0];
      setImgUploading(true);
      const ext = (asset.mimeType || '').includes('png') ? 'png' : 'jpg';
      const res = await sb.uploadAnnouncementImage(asset.base64, asset.mimeType || 'image/jpeg', ext);
      if (res?.ok && res.url) {
        setForm((p: any) => ({ ...p, image_url: res.url }));
      } else {
        Alert.alert('Upload failed', res?.reason || 'Could not upload the image.');
      }
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message || 'Could not pick or upload the image.');
    } finally {
      setImgUploading(false);
    }
  };

  const handleDelete = (ann: Announcement) => {
    Alert.alert('Delete Announcement', `Delete "${ann.title}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await sb.deleteAnnouncement(ann.id);
            // Best-effort banner cleanup from org-assets (web parity).
            if (ann.image_url) { sb.deleteAnnouncementImage(ann.image_url).catch(() => {}); }
            refresh();
          } catch (e: any) {
            Alert.alert('Error', friendlyWriteError(e));
          }
        },
      },
    ]);
  };

  const openEdit = (ann: Announcement) => {
    setSelected(ann);
    setForm({ title: ann.title, content: ann.content, priority: ann.priority, image_url: ann.image_url || '' });
    setShowEdit(true);
  };

  // ── Render ──
  if (announcements === null) return <LoadingScreen />;

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }}>
        {/* Header */}
        <View style={styles.header}>
          <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center', marginRight: 10 }}>
            <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
          </View>
          <View>
            <Text style={styles.headerTitle}>Announcements</Text>
            {(total - published) > 0 ? (
              <Text style={[styles.headerSub, { color: '#94A3B8' }]}>{total - published} draft{(total - published) === 1 ? '' : 's'}</Text>
            ) : null}
          </View>
          {canManage ? (
            <IconBtnSolid
              onPress={() => { setForm({ ...EMPTY_FORM }); setShowAdd(true); }}
            />
          ) : <View style={{ width: 38 }} />}
        </View>

        {/* Stat row */}
        <View style={styles.statRow}>
          <StatChip icon="megaphone-outline" label="Total" value={total} color="#2563EB" />
          <StatChip icon="eye-outline" label="Published" value={published} color="#16a34a" />
          <StatChip icon="alert-circle-outline" label="Urgent" value={urgent} color="#dc2626" />
        </View>

        {/* Filter chips */}
        <View style={styles.filterRow}>
          {(['all', 'published', 'draft'] as const).map(f => (
            <TouchableOpacity
              key={f}
              onPress={() => setFilterPublished(f)}
              style={[styles.filterChip, filterPublished === f && styles.filterChipActive]}
            >
              <Text style={[styles.filterLabel, filterPublished === f && styles.filterLabelActive]}>
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Search */}
        <View style={styles.searchRow}>
          <SearchField value={search} onChangeText={setSearch} placeholder="Search announcements…" />
        </View>

        {/* List */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          showsVerticalScrollIndicator={false}
        >
          {filtered.length === 0 ? (
            <EmptyState
              icon="megaphone-outline"
              title="No announcements"
              subtitle={search ? 'Try a different search' : 'Tap + to create an announcement'}
            />
          ) : (
            filtered.map(ann => (
              <AnnouncementCard
                key={ann.id}
                ann={ann}
                canManage={canManage}
                onEdit={() => openEdit(ann)}
                onDelete={() => handleDelete(ann)}
                onTogglePublish={() => handleTogglePublish(ann)}
                onSend={() => handleSendExisting(ann)}
              />
            ))
          )}
        </ScrollView>
      </SafeAreaView>

      {/* Add Modal */}
      <AnnouncementFormModal
        visible={showAdd} title="New Announcement"
        form={form} setF={setF}
        loading={loading} onSave={() => handleAdd(false)}
        onSaveSend={() => handleAdd(true)}
        showSend
        onPickImage={handlePickImage} imgUploading={imgUploading}
        onClearImage={() => setForm((p: any) => ({ ...p, image_url: '' }))}
        onClose={() => setShowAdd(false)}
      />

      {/* Edit Modal */}
      <AnnouncementFormModal
        visible={showEdit} title="Edit Announcement"
        form={form} setF={setF}
        loading={loading} onSave={handleEdit}
        onPickImage={handlePickImage} imgUploading={imgUploading}
        onClearImage={() => setForm((p: any) => ({ ...p, image_url: '' }))}
        onClose={() => { setShowEdit(false); setSelected(null); }}
      />
    </GlassBackground>
  );
}

// ─── Announcement Card ────────────────────────────────────────────────────────
function AnnouncementCard({ ann, canManage, onEdit, onDelete, onTogglePublish, onSend }: {
  ann: Announcement; canManage?: boolean; onEdit: () => void; onDelete: () => void; onTogglePublish: () => void; onSend: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const pc = PRIORITY_CONFIG[ann.priority] || PRIORITY_CONFIG.normal;
  const fmtDate = (d: string) => {
    try { return formatDate(d, '—'); }
    catch { return d; }
  };

  return (
    <View style={styles.card}>
      {/* Priority stripe */}
      <View style={[styles.priorityStripe, { backgroundColor: pc.color }]} />

      <TouchableOpacity onPress={() => setExpanded(e => !e)} activeOpacity={0.85}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <View style={[styles.priorityIcon, { backgroundColor: pc.bg }]}>
            <Ionicons name={pc.icon} size={18} color={pc.color} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text style={styles.annTitle} numberOfLines={expanded ? undefined : 1}>{ann.title}</Text>
              <View style={[styles.badge, { backgroundColor: pc.bg }]}>
                <Text style={[styles.badgeText, { color: pc.color }]}>{pc.label}</Text>
              </View>
              <View style={[styles.badge, {
                backgroundColor: ann.is_published ? '#dcfce7' : '#f1f5f9',
              }]}>
                <Text style={[styles.badgeText, { color: ann.is_published ? '#16a34a' : '#64748b' }]}>
                  {ann.is_published ? 'Published' : 'Draft'}
                </Text>
              </View>
            </View>
            <Text style={styles.annDate}>
              {ann.is_published && ann.published_at
                ? `Published ${fmtDate(ann.published_at)}`
                : `Created ${fmtDate(ann.created_at)}`}
            </Text>
          </View>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color="#6B7280" />
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={{ marginTop: 12 }}>
          {/* Banner image (if any) */}
          {ann.image_url && /^https?:\/\//i.test(String(ann.image_url)) ? (
            <Image source={{ uri: ann.image_url }} style={{ width: '100%', height: 160, borderRadius: 12, marginBottom: 10, backgroundColor: 'rgba(37,99,235,0.05)' }} resizeMode="cover" />
          ) : null}

          {/* Content preview */}
          <View style={styles.contentBox}>
            <Text style={styles.contentText}>{ann.content}</Text>
          </View>

          {/* Actions — admin/super_admin only */}
          {canManage && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <ActionChip label="Edit" icon="pencil-outline" color="#2563EB" onPress={onEdit} />
              <ActionChip
                label={ann.is_published ? 'Unpublish' : 'Publish'}
                icon={ann.is_published ? 'eye-off-outline' : 'eye-outline'}
                color={ann.is_published ? '#ea580c' : '#16a34a'}
                onPress={onTogglePublish}
              />
              <ActionChip label="Send" icon="logo-whatsapp" color="#25D366" onPress={onSend} />
              <ActionChip label="Delete" icon="trash-outline" color="#dc2626" onPress={onDelete} />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function ActionChip({ label, icon, color, onPress }: any) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: color + '14', borderWidth: 1, borderColor: color + '30' }}
    >
      <Ionicons name={icon} size={13} color={color} />
      <Text style={{ fontSize: 12, fontWeight: '600', color }}>{label}</Text>
    </TouchableOpacity>
  );
}

function StatChip({ icon, label, value, color }: any) {
  return (
    <View style={[styles.statChip, { backgroundColor: color + '10' }]}>
      <Ionicons name={icon} size={16} color={color} />
      <Text style={{ fontSize: 16, fontWeight: '800', color, marginLeft: 4 }}>{value}</Text>
      <Text style={{ fontSize: 11, color: '#6B7280', marginLeft: 4 }}>{label}</Text>
    </View>
  );
}

// ─── Form Modal ───────────────────────────────────────────────────────────────
function AnnouncementFormModal({ visible, title, form, setF, loading, onSave, onSaveSend, showSend, onPickImage, imgUploading, onClearImage, onClose }: any) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color="#111827" />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>{title}</Text>
            <View style={{ width: 24 }} />
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
            <Input label="Title *" value={form.title} onChangeText={setF('title')} placeholder="Announcement title" icon="megaphone-outline" />

            {/* Priority picker */}
            <View style={{ marginBottom: 16 }}>
              <Text style={styles.sectionLabel}>Priority</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {(Object.entries(PRIORITY_CONFIG) as [string, typeof PRIORITY_CONFIG['normal']][]).map(([key, cfg]) => {
                  const active = form.priority === key;
                  return (
                    <TouchableOpacity
                      key={key}
                      onPress={() => setF('priority')(key)}
                      style={{
                        flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                        gap: 4, paddingVertical: 10, borderRadius: 12,
                        backgroundColor: active ? cfg.color : 'rgba(255,255,255,0.6)',
                        borderWidth: 1, borderColor: active ? cfg.color : 'rgba(229,231,235,0.5)',
                      }}
                    >
                      <Ionicons name={cfg.icon} size={14} color={active ? '#fff' : cfg.color} />
                      <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : cfg.color }}>{cfg.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Content */}
            <View style={{ marginBottom: 16 }}>
              <Text style={styles.sectionLabel}>Content *</Text>
              <View style={{
                backgroundColor: 'rgba(255,255,255,0.6)', borderRadius: 14,
                borderWidth: 1, borderColor: 'rgba(229,231,235,0.5)', padding: 14,
              }}>
                <TextInput
                  style={{ fontSize: 15, color: '#111827', minHeight: 120, textAlignVertical: 'top' }}
                  value={form.content}
                  onChangeText={setF('content')}
                  placeholder="Write your announcement here…"
                  placeholderTextColor="#6B7280"
                  multiline
                />
              </View>
              <Text style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
                This message will be shown to tenants when published.
              </Text>
            </View>

            {/* Banner image (optional) */}
            <View style={{ marginBottom: 16 }}>
              <Text style={styles.sectionLabel}>Banner Image (optional)</Text>
              <Text style={{ fontSize: 11, color: '#6B7280', marginBottom: 8 }}>
                If set, the image appears above the announcement text for tenants.
              </Text>
              {form.image_url ? (
                <View>
                  <Image source={{ uri: form.image_url }} style={{ width: '100%', height: 150, borderRadius: 12, backgroundColor: 'rgba(37,99,235,0.05)' }} resizeMode="cover" />
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                    <TouchableOpacity onPress={onPickImage} disabled={imgUploading} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: '#2563EB', backgroundColor: '#EFF6FF' }}>
                      <Ionicons name="image-outline" size={16} color="#2563EB" />
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#2563EB' }}>Replace</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={onClearImage} disabled={imgUploading} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: '#DC2626', backgroundColor: 'rgba(220,38,38,0.06)' }}>
                      <Ionicons name="trash-outline" size={16} color="#DC2626" />
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity onPress={onPickImage} disabled={imgUploading} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 12, borderWidth: 1.5, borderColor: 'rgba(37,99,235,0.4)', borderStyle: 'dashed', backgroundColor: 'rgba(37,99,235,0.04)' }}>
                  {imgUploading
                    ? <ActivityIndicator size="small" color="#2563EB" />
                    : <Ionicons name="cloud-upload-outline" size={18} color="#2563EB" />}
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#2563EB' }}>{imgUploading ? 'Uploading…' : 'Upload Image'}</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={{ marginTop: 8, gap: 10 }}>
              <Button title="Save Announcement" onPress={onSave} loading={loading} icon="checkmark-circle-outline" />
              {showSend && (
                <TouchableOpacity
                  onPress={onSaveSend}
                  disabled={loading}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 14, borderWidth: 1.5, borderColor: '#25D366', backgroundColor: 'rgba(37,211,102,0.08)', opacity: loading ? 0.5 : 1 }}
                >
                  <Ionicons name="logo-whatsapp" size={18} color="#25D366" />
                  <Text style={{ fontSize: 15, fontWeight: '800', color: '#111827' }}>Save &amp; Send on WhatsApp</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.infoBox}>
              <Ionicons name="information-circle-outline" size={16} color="#2563eb" />
              <Text style={styles.infoText}>
                {showSend
                  ? 'Saved as a draft. Save & Send also delivers it to active tenants on WhatsApp. Use Publish to make it visible in the tenant app.'
                  : 'Saved as draft — use Publish to make it visible to tenants.'}
              </Text>
            </View>
          </ScrollView>
        </SafeAreaView>
      </GlassBackground>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 0.5, borderBottomColor: '#E5E7EB',
  },
  menuBtn: { padding: 4 },
  headerTitle: { fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 },
  headerSub: { fontSize: 12, color: '#64748B', fontWeight: '500', marginTop: 2 },
  addBtn: {
    width: 38, height: 38, borderRadius: 12,
    backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center',
  },
  statRow: {
    flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10,
  },
  statChip: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12,
  },
  filterRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.5)',
    borderWidth: 1, borderColor: 'rgba(229,231,235,0.5)',
  },
  filterChipActive: { backgroundColor: '#2563EB', borderColor: '#2563EB' },
  filterLabel: { fontSize: 13, fontWeight: '600', color: '#6B7280' },
  filterLabelActive: { color: '#fff' },
  searchRow: { paddingHorizontal: 16, paddingBottom: 8 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(229,231,235,0.5)',
    paddingHorizontal: 14, height: 44,
  },
  searchInput: { flex: 1, fontSize: 15, color: '#111827' },
  card: {
    ...glass.card, marginBottom: 10, padding: 14,
    flexDirection: 'column', overflow: 'hidden',
  },
  priorityStripe: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, borderRadius: 4,
  },
  priorityIcon: {
    width: 38, height: 38, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  annTitle: { fontSize: 14, fontWeight: '700', color: '#111827', flex: 1 },
  annDate:  { fontSize: 11, color: '#6B7280', marginTop: 3 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 7 },
  badgeText: { fontSize: 10, fontWeight: '700' },
  contentBox: {
    backgroundColor: 'rgba(255,255,255,0.5)', borderRadius: 10,
    padding: 12, borderWidth: 0.5, borderColor: 'rgba(229,231,235,0.5)',
  },
  contentText: { fontSize: 14, color: '#111827', lineHeight: 20 },
  sectionLabel: {
    fontSize: 11, fontWeight: '600', color: '#556274',
    letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8,
  },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 0.5, borderBottomColor: '#E5E7EB',
  },
  modalTitle: { fontSize: 17, fontWeight: '800', color: '#111827' },
  infoBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: 'rgba(37,99,235,0.08)', borderRadius: 10,
    padding: 12, marginTop: 12,
  },
  infoText: { flex: 1, fontSize: 12, color: '#2563eb', lineHeight: 17 },
});
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Alert, ActivityIndicator, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/ThemeContext';
import { spacing, glass } from '../lib/theme';
import { Button, GlassBackground } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { Ionicons } from '@expo/vector-icons';
import { getActiveSession } from '../services/getActiveSession';

// ── Status colour helper ──────────────────────────────────────────────────────
const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  staying:    { bg: '#dcfce7', text: '#16a34a' },
  onboarding: { bg: '#dbeafe', text: '#2563eb' },
  'on-notice':{ bg: '#ffedd5', text: '#ea580c' },
  new:        { bg: '#ede9fe', text: '#7c3aed' },
  exited:     { bg: '#f1f5f9', text: '#64748b' },
};
const statusStyle = (s?: string) =>
  STATUS_COLORS[(s || '').toLowerCase()] ?? { bg: '#ede9fe', text: '#7c3aed' };

// ── Section label ─────────────────────────────────────────────────────────────
function SectionLabel({ title }: { title: string }) {
  const { colors } = useTheme();
  return (
    <Text style={{
      fontSize: 11, fontWeight: '700', color: colors.textTertiary,
      letterSpacing: 1, marginBottom: 10, marginTop: 20, textTransform: 'uppercase',
    }}>
      {title}
    </Text>
  );
}

// ── Info row ──────────────────────────────────────────────────────────────────
function InfoRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={[glass.card, { flexDirection: 'row', alignItems: 'center', marginBottom: 0 }]}>
      <View style={{
        width: 36, height: 36, borderRadius: 10,
        backgroundColor: colors.primaryLight,
        alignItems: 'center', justifyContent: 'center', marginRight: spacing.md,
      }}>
        <Ionicons name={icon as any} size={16} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 11, color: colors.textSecondary, fontWeight: '600' }}>{label}</Text>
        <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>{value}</Text>
      </View>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────
export default function TenantProfileScreen() {
  const { user, logout } = useAuth();
  const { colors } = useTheme();

  const [profile,       setProfile]       = useState<any>(null);
  const [accommodation, setAccommodation] = useState<any>(null);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);

  const loadProfileData = useCallback(async () => {
    let mounted = true;

    const loadProfile = async () => {
      // Try to get session, but also accept cached user from auth context
      const session = await getActiveSession();
      
      // Only bail if we have neither session nor cached user
      if (!mounted) return;
      if (!session && (!user?.userId && !user?.phone)) {
        console.warn('[TenantProfile] Profile load skipped - no session and no cached user');
        setLoading(false);
        return;
      }

      try {
        // Use phone from either session or auth context
        const phoneToUse = session?.user?.phone || user?.phone;
        
        if (!phoneToUse) {
          console.warn('[TenantProfile] No phone available for profile load');
          setLoading(false);
          return;
        }

        // getTenantProfile returns a FLAT object (or null) — map it into the
        // profile + accommodation shapes this screen renders.
        const t = await sb.getTenantProfile(phoneToUse);
        if (mounted) {
          if (t) {
            setProfile({
              name:             t.fullName ?? null,
              phone:            t.phone ?? null,
              email:            t.email ?? null,
              gender:           t.gender ?? null,
              permanentAddress: t.permanentAddress ?? null,
            });
            setAccommodation({
              stayingStatus:  t.stayingStatus ?? null,
              apartment:      t.apartmentCode ?? null,
              bed:            t.bedCode ?? null,
              onboardingDate: t.checkInDate ?? null,
              noticeDate:     t.noticeDate ?? null,
            });
            setError(null);
          } else {
            setProfile(null);
            setAccommodation(null);
          }
          setLoading(false);
        }
      } catch (e) {
        if (mounted) {
          console.error('[TenantProfile] Profile load error:', e);
          setLoading(false);
          setError('Failed to load profile. Please try again.');
        }
      }
    };

    loadProfile();

    return () => {
      mounted = false;
    };
  }, [user?.phone, user?.userId]);

  useEffect(() => {
    const cleanup = loadProfileData();
    return cleanup;
  }, [loadProfileData]);

  const stayStatus = accommodation?.stayingStatus;
  const sc = statusStyle(stayStatus);

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>

        {/* ── Header ── */}
        <View style={[glass.header, { paddingHorizontal: spacing.lg, paddingVertical: spacing.lg }]}>
          <Text style={{ fontSize: 11, color: colors.textTertiary, fontWeight: '700', letterSpacing: 0.5 }}>
            VISHFUL SPACES
          </Text>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }}>My Profile</Text>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.xl, paddingBottom: 60 }}>

          {/* ── Loading ── */}
          {loading ? (
            <View style={{ alignItems: 'center', paddingVertical: 60 }}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={{ marginTop: 12, fontSize: 13, color: colors.textSecondary }}>Loading profile…</Text>
            </View>

          ) : error ? (
            /* ── Error state ── */
            <View style={[glass.card, { alignItems: 'center', paddingVertical: 32 }]}>
              <Ionicons name="warning-outline" size={40} color="#ea580c" />
              <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text, marginTop: 12, textAlign: 'center' }}>
                {error}
              </Text>
              <TouchableOpacity
                onPress={loadProfileData}
                style={{ marginTop: 16, backgroundColor: colors.primary, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 12 }}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>Retry</Text>
              </TouchableOpacity>
            </View>

          ) : (
            <>
              {/* ── Avatar + name ── */}
              <View style={[glass.card, { marginBottom: spacing.md }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{
                    width: 60, height: 60, borderRadius: 16,
                    backgroundColor: colors.primary,
                    alignItems: 'center', justifyContent: 'center', marginRight: spacing.lg,
                  }}>
                    <Text style={{ fontSize: 26, fontWeight: '800', color: '#fff' }}>
                      {(profile?.name || user?.userName || 'T')[0].toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text }}>
                      {profile?.name || user?.userName || 'Tenant'}
                    </Text>
                    <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                      {profile?.phone || user?.phone}
                    </Text>
                    {stayStatus && (
                      <View style={{
                        alignSelf: 'flex-start', marginTop: 6,
                        backgroundColor: sc.bg,
                        paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999,
                      }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: sc.text }}>
                          {stayStatus.toUpperCase().replace('-', ' ')}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
              </View>

              {/* ── Accommodation ── */}
              {accommodation && (
                <>
                  <SectionLabel title="Accommodation" />
                  <View style={{ gap: spacing.sm }}>
                    {accommodation?.apartment && accommodation.apartment !== 'N/A' && (
                      <InfoRow icon="grid-outline"     label="Apartment" value={accommodation?.apartment ?? 'N/A'} />
                    )}
                    {accommodation?.bed && accommodation.bed !== 'N/A' && (
                      <InfoRow icon="bed-outline"      label="Bed"       value={accommodation?.bed ?? 'N/A'} />
                    )}
                    {accommodation?.onboardingDate && formatDate(accommodation?.onboardingDate) && (
                      <InfoRow icon="calendar-outline" label="Move-in Date" value={formatDate(accommodation?.onboardingDate) ?? 'N/A'} />
                    )}
                    {accommodation?.noticeDate && formatDate(accommodation?.noticeDate) && (
                      <InfoRow icon="warning-outline"  label="Notice Date" value={formatDate(accommodation?.noticeDate) ?? 'N/A'} />
                    )}
                  </View>
                </>
              )}

              {/* ── Personal details ── */}
              <SectionLabel title="Personal Details" />
              <View style={{ gap: spacing.sm }}>
                {[
                  { icon: 'call-outline',  label: 'Phone',             value: profile?.phone ?? user?.phone },
                  { icon: 'mail-outline',  label: 'Email',             value: profile?.email },
                  { icon: 'person-outline',label: 'Gender',            value: profile?.gender },
                  { icon: 'home-outline',  label: 'Permanent Address', value: profile?.permanentAddress },
                ].filter(d => d.value).map((d) => (
                  <InfoRow key={d.label} icon={d.icon} label={d.label} value={d.value as string} />
                ))}
              </View>



              {/* ── Logout ── */}
              <View style={{ marginTop: 28 }}>
                <Button
                  title="Logout"
                  onPress={() => {
                    Alert.alert('Logout', 'Are you sure?', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Logout', style: 'destructive', onPress: logout },
                    ]);
                  }}
                  variant="danger"
                  icon="log-out-outline"
                />
              </View>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}
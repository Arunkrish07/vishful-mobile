import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Alert, ActivityIndicator, TouchableOpacity, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { spacing } from '../lib/theme';
import { Button, GlassBackground } from '../components/shared';
import { useNavigation } from '@react-navigation/native';
import { formatDate } from '../lib/dateUtils';
import { Ionicons } from '@expo/vector-icons';
import { getActiveSession } from '../services/getActiveSession';

// ─── Blue / slate design tokens (web chrome) ──────────────────────────────────
const TP = {
  ink: '#0F172A', sub: '#64748B', ter: '#94A3B8',
  blue: '#6A2C90', blueDeep: '#1D4ED8',
  surface: '#FFFFFF', bg: '#F8FAFC', border: '#EEF1F6', soft: '#F3ECF9',
  good: '#16A34A', goodBg: '#DCFCE7',
  warn: '#EA580C', warnBg: '#FFEDD5',
  bad: '#DC2626', badBg: '#FEE2E2',
  info: '#1D4ED8', infoBg: '#EEF3FF',
};

/** Soft elevation used across cards/panels (design-language shadow token). */
const CARD_SHADOW = {
  shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
} as const;

const CARD: any = {
  backgroundColor: TP.surface, borderRadius: 16, borderWidth: 1, borderColor: TP.border,
  ...CARD_SHADOW,
};

// ── Status colour helper ──────────────────────────────────────────────────────
const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  staying:    { bg: TP.goodBg, text: TP.good },
  onboarding: { bg: TP.infoBg, text: TP.info },
  'on-notice':{ bg: TP.warnBg, text: TP.warn },
  new:        { bg: TP.infoBg, text: TP.info },
  exited:     { bg: '#F1F5F9', text: TP.sub },
};
const statusStyle = (s?: string) =>
  STATUS_COLORS[(s || '').toLowerCase()] ?? { bg: TP.infoBg, text: TP.info };

// ── Section label ─────────────────────────────────────────────────────────────
function SectionLabel({ title }: { title: string }) {
  return (
    <Text style={{
      fontSize: 17, fontWeight: '800', color: TP.ink, letterSpacing: -0.3,
      marginBottom: 10, marginTop: 20,
    }}>
      {title}
    </Text>
  );
}

// ── Info row ──────────────────────────────────────────────────────────────────
function InfoRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={[CARD, { flexDirection: 'row', alignItems: 'center', padding: 16, marginBottom: 0 }]}>
      <View style={{
        width: 36, height: 36, borderRadius: 10,
        backgroundColor: TP.soft,
        alignItems: 'center', justifyContent: 'center', marginRight: spacing.md,
      }}>
        <Ionicons name={icon as any} size={16} color={TP.blue} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 11, color: TP.sub, fontWeight: '600' }}>{label}</Text>
        <Text style={{ fontSize: 13, fontWeight: '700', color: TP.ink }}>{value}</Text>
      </View>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────
export default function TenantProfileScreen() {
  const { user, logout } = useAuth();
  const navigation = useNavigation<any>();

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
              photoUrl:         t.photoUrl ?? null,
              kycCompleted:     t.kycCompleted ?? false,
            });
            setAccommodation({
              stayingStatus:  t.stayingStatus ?? null,
              apartment:      t.apartmentCode ?? null,
              bed:            t.bedCode ?? null,
              onboardingDate: t.checkInDate ?? null,
              noticeDate:     t.noticeDate ?? null,
              monthlyRent:    t.monthlyRent ?? null,
              exitDate:       t.estimatedExitDate ?? null,
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
        <View style={{ backgroundColor: TP.surface, borderBottomWidth: 1, borderBottomColor: TP.border, paddingHorizontal: spacing.lg, paddingVertical: spacing.lg }}>
          <Text style={{ fontSize: 11, color: TP.ter, fontWeight: '700', letterSpacing: 0.5 }}>
            VISHFUL SPACES
          </Text>
          <Text style={{ fontSize: 18, fontWeight: '800', color: TP.ink, letterSpacing: -0.3 }}>My Profile</Text>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.xl, paddingBottom: 60 }}>

          {/* ── Loading ── */}
          {loading ? (
            <View style={{ alignItems: 'center', paddingVertical: 60 }}>
              <ActivityIndicator size="large" color={TP.blue} />
              <Text style={{ marginTop: 12, fontSize: 13, color: TP.sub }}>Loading profile…</Text>
            </View>

          ) : error ? (
            /* ── Error state ── */
            <View style={[CARD, { alignItems: 'center', paddingVertical: 32, padding: 16 }]}>
              <Ionicons name="warning-outline" size={40} color={TP.warn} />
              <Text style={{ fontSize: 14, fontWeight: '700', color: TP.ink, marginTop: 12, textAlign: 'center' }}>
                {error}
              </Text>
              <TouchableOpacity
                onPress={loadProfileData}
                style={{ marginTop: 16, backgroundColor: TP.blue, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 12 }}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>Retry</Text>
              </TouchableOpacity>
            </View>

          ) : (
            <>
              {/* ── Avatar + name ── */}
              <View style={[CARD, { padding: 16, marginBottom: spacing.md }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{
                    width: 60, height: 60, borderRadius: 16,
                    backgroundColor: TP.blue,
                    alignItems: 'center', justifyContent: 'center', marginRight: spacing.lg,
                    overflow: 'hidden',
                  }}>
                    {profile?.photoUrl ? (
                      <Image source={{ uri: profile.photoUrl }} style={{ width: 60, height: 60 }} resizeMode="cover" />
                    ) : (
                      <Text style={{ fontSize: 26, fontWeight: '800', color: '#fff' }}>
                        {(profile?.name || user?.userName || 'T')[0].toUpperCase()}
                      </Text>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 17, fontWeight: '800', color: TP.ink, letterSpacing: -0.3 }}>
                      {profile?.name || user?.userName || 'Tenant'}
                    </Text>
                    <Text style={{ fontSize: 12, color: TP.sub, marginTop: 2 }}>
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
                    {accommodation?.exitDate && formatDate(accommodation?.exitDate) && (
                      <InfoRow icon="exit-outline"     label="Estimated Exit Date" value={formatDate(accommodation?.exitDate) ?? 'N/A'} />
                    )}
                    {accommodation?.monthlyRent ? (
                      <InfoRow icon="cash-outline"     label="Monthly Rent" value={`₹${Number(accommodation.monthlyRent).toLocaleString('en-IN')}`} />
                    ) : null}
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
                  { icon: profile?.kycCompleted ? 'checkmark-circle-outline' : 'alert-circle-outline', label: 'KYC Status', value: profile?.kycCompleted ? 'Verified' : 'Pending' },
                ].filter(d => d.value).map((d) => (
                  d.label === 'KYC Status' ? (
                    <TouchableOpacity key={d.label} activeOpacity={0.7} onPress={() => navigation.navigate('TenantKyc')}>
                      <InfoRow icon={d.icon} label={d.label} value={`${d.value}  ›`} />
                    </TouchableOpacity>
                  ) : (
                    <InfoRow key={d.label} icon={d.icon} label={d.label} value={d.value as string} />
                  )
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
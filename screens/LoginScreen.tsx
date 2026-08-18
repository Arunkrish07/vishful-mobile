import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform, TouchableOpacity,
  ActivityIndicator, TextInput, Image, Animated, Easing, ScrollView, StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

type Portal = 'tenant' | 'technician' | 'staff';
type Step = 'role' | 'phone' | 'otp';

const C = {
  night: '#0F1224',
  nightMid: '#1A1F3A',
  nightTo: '#232846',
  brand: '#1D4ED8',
  brandDeep: '#1E3A8A',
  accent: '#2563EB',
  text: '#F8FAFC',
  muted: 'rgba(226,232,240,0.68)',
  dim: 'rgba(203,213,225,0.5)',
  ink: '#111827',
  inkMuted: '#6B7280',
  line: '#E5E7EB',
  white: '#FFFFFF',
  card: '#FFFFFF',
  danger: '#DC2626',
};

const STAFF_ROLES = new Set([
  'super_admin', 'org_admin', 'property_manager', 'admin', 'manager', 'pm', 'team_member',
]);

const PORTALS: {
  id: Portal;
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { id: 'tenant', title: 'Tenant', subtitle: 'Tickets, stay and notices', icon: 'home-outline' },
  { id: 'technician', title: 'Technician', subtitle: 'Assigned jobs and visits', icon: 'construct-outline' },
  { id: 'staff', title: 'Staff', subtitle: 'Property OS for the team', icon: 'grid-outline' },
];

function portalCopy(portal: Portal) {
  if (portal === 'tenant') {
    return {
      eyebrow: 'TENANT',
      title: 'Sign in to your stay',
      sub: 'We’ll text a one-time code to your registered mobile number.',
    };
  }
  if (portal === 'technician') {
    return {
      eyebrow: 'TECHNICIAN',
      title: 'Sign in to your jobs',
      sub: 'We’ll text a one-time code to your work mobile number.',
    };
  }
  return {
    eyebrow: 'STAFF',
    title: 'Welcome back',
    sub: 'We’ll text a one-time code to confirm it’s you.',
  };
}

function roleFitsPortal(role: string, portal: Portal): boolean {
  if (portal === 'tenant') return role === 'tenant';
  if (portal === 'technician') return role === 'technician';
  return STAFF_ROLES.has(role);
}

function mismatchMessage(role: string, portal: Portal): string {
  if (role === 'tenant') return 'This number is a tenant account. Choose Tenant to continue.';
  if (role === 'technician') return 'This number is a technician account. Choose Technician to continue.';
  return 'This number is a staff account. Choose Staff to continue.';
}

export default function LoginScreen() {
  const navigation = useNavigation<any>();
  const [step, setStep] = useState<Step>('role');
  const [portal, setPortal] = useState<Portal | null>(null);
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSignupPrompt, setShowSignupPrompt] = useState(false);
  const [phoneFocused, setPhoneFocused] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const resendTimer = useRef<any>(null);
  const { login } = useAuth();

  const copy = portal ? portalCopy(portal) : portalCopy('staff');

  const RESEND_SECONDS = 30;
  const startResendCountdown = () => {
    if (resendTimer.current) clearInterval(resendTimer.current);
    setResendIn(RESEND_SECONDS);
    resendTimer.current = setInterval(() => {
      setResendIn((s) => {
        if (s <= 1) { clearInterval(resendTimer.current); return 0; }
        return s - 1;
      });
    }, 1000);
  };
  useEffect(() => () => { if (resendTimer.current) clearInterval(resendTimer.current); }, []);

  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(16)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 420, useNativeDriver: true }),
      Animated.timing(slideUp, { toValue: 0, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, []);

  const pickPortal = (id: Portal) => {
    setPortal(id);
    setError('');
    setShowSignupPrompt(false);
    setStep('phone');
  };

  const backToRole = () => {
    setStep('role');
    setPortal(null);
    setPhone('');
    setOtp('');
    setError('');
    setShowSignupPrompt(false);
  };

  const handleSendOTP = async () => {
    const trimmed = phone.trim().replace(/\D/g, '').slice(-10);
    if (trimmed.length < 10) {
      setError('Enter a valid 10-digit mobile number');
      return;
    }
    setLoading(true);
    setError('');
    setShowSignupPrompt(false);
    try {
      const result = await sb.sendOtp(trimmed);
      if (result.success) {
        setStep('otp');
        startResendCountdown();
      } else {
        setError(result.message || 'This number is not registered. Please contact admin.');
        setShowSignupPrompt(true);
      }
    } catch (err) {
      setError('Failed to send OTP. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async () => {
    if (otp.trim().length !== 6) {
      setError('Enter the 6-digit OTP sent to your phone');
      return;
    }
    setLoading(true);
    setError('');
    setShowSignupPrompt(false);
    try {
      const cleanPhone = phone.trim().replace(/\D/g, '').slice(-10);
      const result = await sb.verifyOtpAndLogin(cleanPhone, otp.trim());
      if (result.success && result.token) {
        const role = String(result.user?.role || '');
        if (portal && !roleFitsPortal(role, portal)) {
          setError(mismatchMessage(role, portal));
          return;
        }
        await login(result.token, result.user as any, result.refreshToken);
      } else {
        setError(result.message || 'Could not verify. Please try again.');
      }
    } catch (err: any) {
      const msg = (err?.message || '').toLowerCase();
      if (msg.includes('invalid') || msg.includes('expired')) {
        setError('Incorrect OTP. Please check and try again.');
      } else if (msg.includes('not found') || msg.includes('not registered')) {
        setError('This number is not registered. Please contact admin.');
        setShowSignupPrompt(true);
      } else {
        setError('Could not verify. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendIn > 0 || loading) return;
    setLoading(true);
    setError('');
    setShowSignupPrompt(false);
    try {
      const cleanPhone = phone.trim().replace(/\D/g, '').slice(-10);
      const result = await sb.sendOtp(cleanPhone);
      if (result.success) {
        setOtp('');
        startResendCountdown();
      } else {
        setError(result.message || 'Could not resend the code. Please try again.');
      }
    } catch (err) {
      setError('Could not resend the code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const renderOtpCells = () => {
    const cells = [];
    for (let i = 0; i < 6; i++) {
      const ch = otp[i] || '';
      const isFilled = !!ch;
      const isActive = i === otp.length;
      cells.push(
        <View
          key={i}
          style={[
            styles.otpCell,
            isFilled && styles.otpCellFilled,
            isActive && styles.otpCellActive,
          ]}
        >
          <Text style={[styles.otpCellText, !isFilled && styles.otpCellDot]}>{ch || ''}</Text>
        </View>
      );
    }
    return cells;
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <LinearGradient
        colors={[C.night, C.nightMid, C.nightTo]}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            <Animated.View style={[styles.hero, { opacity: fadeIn, transform: [{ translateY: slideUp }] }]}>
              <Image
                source={require('../assets/vishful-logo-DPK24n8p.webp')}
                style={styles.logo}
              />
              <Text style={styles.wordmark}>Vishful</Text>
              <Text style={styles.tagline}>Stay · Belong · Succeed</Text>
            </Animated.View>

            <Animated.View style={[styles.card, { opacity: fadeIn, transform: [{ translateY: slideUp }] }]}>
              {step === 'role' && (
                <>
                  <Text style={styles.cardEyebrow}>SIGN IN</Text>
                  <Text style={styles.cardTitle}>Who’s signing in?</Text>
                  <Text style={styles.cardSub}>Choose your portal. You’ll enter your mobile number next.</Text>

                  {PORTALS.map((p) => (
                    <TouchableOpacity
                      key={p.id}
                      activeOpacity={0.88}
                      onPress={() => pickPortal(p.id)}
                      style={styles.portalRow}
                    >
                      <View style={styles.portalIcon}>
                        <Ionicons name={p.icon} size={20} color={C.brand} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.portalTitle}>{p.title}</Text>
                        <Text style={styles.portalSub}>{p.subtitle}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={18} color="#94A3B8" />
                    </TouchableOpacity>
                  ))}
                </>
              )}

              {step === 'phone' && portal && (
                <>
                  <Text style={styles.cardEyebrow}>{copy.eyebrow}</Text>
                  <Text style={styles.cardTitle}>{copy.title}</Text>
                  <Text style={styles.cardSub}>{copy.sub}</Text>

                  <Text style={styles.fieldLabel}>Mobile number</Text>
                  <View style={[styles.inputField, phoneFocused && styles.inputFieldActive]}>
                    <Text style={styles.inputPrefix}>+91</Text>
                    <View style={styles.inputDivider} />
                    <TextInput
                      style={styles.inputControl}
                      value={phone}
                      onFocus={() => setPhoneFocused(true)}
                      onBlur={() => setPhoneFocused(false)}
                      onChangeText={(t: string) => {
                        setPhone(t.replace(/\D/g, '').slice(0, 10));
                        setError('');
                        setShowSignupPrompt(false);
                      }}
                      placeholder="98765 43210"
                      placeholderTextColor={C.inkMuted}
                      keyboardType="phone-pad"
                      maxLength={10}
                    />
                  </View>

                  {error ? (
                    <View style={styles.errorBox}>
                      <Ionicons name="alert-circle" size={16} color={C.danger} />
                      <Text style={styles.errorMsg}>{error}</Text>
                    </View>
                  ) : null}

                  {showSignupPrompt ? (
                    <View style={styles.infoBox}>
                      <Ionicons name="information-circle-outline" size={18} color={C.accent} />
                      <Text style={styles.infoMsg}>Ask your property admin to add you, then sign in here.</Text>
                    </View>
                  ) : null}

                  <TouchableOpacity activeOpacity={0.88} onPress={handleSendOTP} disabled={loading} style={{ marginTop: 18 }}>
                    <View style={[styles.btn, loading && styles.btnDisabled]}>
                      {loading ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <>
                          <Text style={styles.btnText}>Send code</Text>
                          <Ionicons name="arrow-forward" size={16} color="#fff" />
                        </>
                      )}
                    </View>
                  </TouchableOpacity>

                  <TouchableOpacity onPress={backToRole} style={styles.backBtn}>
                    <Ionicons name="chevron-back" size={16} color={C.inkMuted} />
                    <Text style={styles.backText}>Change portal</Text>
                  </TouchableOpacity>
                </>
              )}

              {step === 'otp' && portal && (
                <>
                  <Text style={styles.cardEyebrow}>{copy.eyebrow}</Text>
                  <Text style={styles.cardTitle}>Check your phone</Text>
                  <Text style={styles.cardSub}>
                    6-digit code sent to <Text style={styles.cardSubStrong}>+91 {phone}</Text>
                  </Text>

                  <View style={{ position: 'relative', marginTop: 6 }}>
                    <View style={styles.otpRow}>{renderOtpCells()}</View>
                    <TextInput
                      style={styles.otpHidden}
                      value={otp}
                      onChangeText={(t: string) => {
                        setOtp(t.replace(/\D/g, '').slice(0, 6));
                        setError('');
                        setShowSignupPrompt(false);
                      }}
                      keyboardType="number-pad"
                      maxLength={6}
                      autoFocus
                      caretHidden
                    />
                  </View>

                  {error ? (
                    <View style={styles.errorBox}>
                      <Ionicons name="alert-circle" size={16} color={C.danger} />
                      <Text style={styles.errorMsg}>{error}</Text>
                    </View>
                  ) : null}

                  <TouchableOpacity activeOpacity={0.88} onPress={handleVerifyOTP} disabled={loading} style={{ marginTop: 18 }}>
                    <View style={[styles.btn, loading && styles.btnDisabled]}>
                      {loading ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <>
                          <Text style={styles.btnText}>Verify & enter</Text>
                          <Ionicons name="arrow-forward" size={16} color="#fff" />
                        </>
                      )}
                    </View>
                  </TouchableOpacity>

                  <View style={styles.resendRow}>
                    {resendIn > 0 ? (
                      <Text style={styles.resendMuted}>
                        Resend in 0:{String(resendIn).padStart(2, '0')}
                      </Text>
                    ) : (
                      <TouchableOpacity onPress={handleResend} disabled={loading}>
                        <Text style={styles.resendActive}>Resend code</Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  <TouchableOpacity
                    onPress={() => { setStep('phone'); setOtp(''); setError(''); setShowSignupPrompt(false); }}
                    style={styles.backBtn}
                  >
                    <Ionicons name="chevron-back" size={16} color={C.inkMuted} />
                    <Text style={styles.backText}>Change number</Text>
                  </TouchableOpacity>
                </>
              )}
            </Animated.View>

            <TouchableOpacity onPress={() => navigation.navigate('PrivacyPolicy')} style={styles.privacyBtn}>
              <Text style={styles.privacyText}>Privacy Policy</Text>
            </TouchableOpacity>
            <Text style={styles.foot}>Property OS</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.night },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 22,
    paddingTop: 28,
    paddingBottom: 28,
  },

  hero: { alignItems: 'center', marginBottom: 28 },
  logo: { width: 72, height: 72, resizeMode: 'contain' },
  wordmark: {
    marginTop: 10,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.6,
    color: C.text,
  },
  tagline: {
    marginTop: 6,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 2.2,
    color: C.muted,
    textTransform: 'uppercase',
  },

  card: {
    backgroundColor: C.card,
    borderRadius: 22,
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 22,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  cardEyebrow: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.6,
    color: C.accent,
    marginBottom: 6,
  },
  cardTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: C.ink,
    letterSpacing: -0.5,
  },
  cardSub: {
    fontSize: 14,
    color: C.inkMuted,
    marginTop: 8,
    lineHeight: 20,
    marginBottom: 18,
  },
  cardSubStrong: { color: C.ink, fontWeight: '700' },

  portalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#F8FAFC',
    borderWidth: 1.5,
    borderColor: C.line,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  portalIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#EFF6FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  portalTitle: { fontSize: 16, fontWeight: '800', color: C.ink },
  portalSub: { fontSize: 12, color: C.inkMuted, marginTop: 2, fontWeight: '600' },

  fieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: C.ink,
    marginBottom: 8,
  },
  inputField: {
    height: 52,
    borderRadius: 14,
    backgroundColor: '#F8FAFC',
    borderWidth: 1.5,
    borderColor: C.line,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
  },
  inputFieldActive: {
    borderColor: C.accent,
    backgroundColor: C.white,
  },
  inputPrefix: {
    fontSize: 15,
    fontWeight: '700',
    color: C.ink,
  },
  inputDivider: {
    width: 1,
    height: 20,
    backgroundColor: C.line,
    marginHorizontal: 12,
  },
  inputControl: {
    flex: 1,
    fontSize: 16,
    color: C.ink,
    letterSpacing: 0.6,
    paddingVertical: 0,
  },

  otpRow: { flexDirection: 'row', gap: 8 },
  otpCell: {
    flex: 1,
    height: 52,
    borderRadius: 12,
    backgroundColor: '#F8FAFC',
    borderWidth: 1.5,
    borderColor: C.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  otpCellFilled: {
    borderColor: C.accent,
    backgroundColor: '#EFF6FF',
  },
  otpCellActive: { borderColor: C.accent },
  otpCellText: { fontSize: 20, fontWeight: '800', color: C.ink },
  otpCellDot: { color: '#CBD5E1' },
  otpHidden: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    opacity: 0,
    color: 'transparent',
  },

  btn: {
    height: 52,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: C.brand,
  },
  btnDisabled: { opacity: 0.7 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '800' },

  resendRow: { alignItems: 'center', marginTop: 16 },
  resendMuted: { color: C.inkMuted, fontSize: 13, fontWeight: '600' },
  resendActive: { color: C.accent, fontSize: 13, fontWeight: '800' },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
    gap: 2,
  },
  backText: { color: C.inkMuted, fontSize: 13, fontWeight: '700' },

  errorBox: {
    backgroundColor: '#FEF2F2',
    borderRadius: 12,
    padding: 10,
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  errorMsg: { flex: 1, color: C.danger, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  infoBox: {
    backgroundColor: '#EFF6FF',
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  infoMsg: { flex: 1, color: C.brandDeep, fontSize: 13, lineHeight: 18, fontWeight: '600' },

  privacyBtn: { alignItems: 'center', marginTop: 22, paddingVertical: 6 },
  privacyText: { color: C.muted, fontSize: 13, fontWeight: '700' },
  foot: {
    textAlign: 'center',
    marginTop: 4,
    fontSize: 12,
    fontWeight: '600',
    color: C.dim,
  },
});

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform, TouchableOpacity,
  ActivityIndicator, TextInput, Image, Animated, Easing, ScrollView, StatusBar,
  Pressable, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

type Step = 'splash' | 'phone' | 'otp';

const { width: WIN_W } = Dimensions.get('window');

/** Web phone login palette, with typed digits / CTA in app blue (not black). */
const C = {
  night: '#0D1122',
  nightMid: '#111631',
  nightTo: '#151B39',
  text: '#F8FAFC',
  textSoft: '#E2E8F0',
  eyebrow: '#93C5FD',
  lede: 'rgba(203,213,225,0.60)',
  dim: 'rgba(148,163,184,0.50)',
  field: 'rgba(6,9,22,0.72)',
  fieldBorder: 'rgba(255,255,255,0.10)',
  prefix: 'rgba(226,232,240,0.62)',
  placeholder: 'rgba(148,163,184,0.40)',
  digit: '#60A5FA',
  digitStrong: '#93C5FD',
  accent: '#2563EB',
  brand: '#1D4ED8',
  brandDeep: '#1E3A8A',
  focus: 'rgba(37,99,235,0.28)',
  danger: '#F87171',
  white: '#FFFFFF',
};

export default function LoginScreen() {
  const navigation = useNavigation<any>();
  const [step, setStep] = useState<Step>('splash');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSignupPrompt, setShowSignupPrompt] = useState(false);
  const [phoneFocused, setPhoneFocused] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const resendTimer = useRef<any>(null);
  const { login } = useAuth();

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
  const slideUp = useRef(new Animated.Value(18)).current;
  const playEnter = () => {
    fadeIn.setValue(0);
    slideUp.setValue(18);
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 480, useNativeDriver: true }),
      Animated.timing(slideUp, { toValue: 0, duration: 480, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  };
  useEffect(() => { playEnter(); }, [step]);

  // Loading splash → auto-advance to the phone/OTP entry (no "tap to continue").
  useEffect(() => {
    if (step !== 'splash') return;
    const t = setTimeout(() => setStep('phone'), 1800);
    return () => clearTimeout(t);
  }, [step]);

  const formattedPhone = phone.length > 5 ? `${phone.slice(0, 5)} ${phone.slice(5)}` : phone;

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
          <Text style={styles.otpCellText}>{ch}</Text>
        </View>
      );
    }
    return cells;
  };

  const GoButton = ({
    label, onPress, disabled,
  }: { label: string; onPress: () => void; disabled?: boolean }) => (
    <TouchableOpacity activeOpacity={0.88} onPress={onPress} disabled={disabled}>
      <LinearGradient
        colors={disabled ? ['#1E3A8A66', '#1E3A8A44'] : ['#3B82F6', '#2563EB', '#1D4ED8']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.go, disabled && styles.goDisabled]}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <Text style={[styles.goText, disabled && styles.goTextDisabled]}>{label}</Text>
            <Ionicons name="arrow-forward" size={16} color={disabled ? 'rgba(203,213,225,0.4)' : '#fff'} />
          </>
        )}
      </LinearGradient>
    </TouchableOpacity>
  );

  if (step === 'splash') {
    return (
      <View style={styles.root}>
        <StatusBar barStyle="light-content" />
        <LinearGradient
          colors={[C.night, C.nightMid, C.nightTo]}
          start={{ x: 0.2, y: 0 }}
          end={{ x: 0.8, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View pointerEvents="none" style={[styles.orb, styles.orbA]} />
        <View pointerEvents="none" style={[styles.orb, styles.orbB]} />

        {/* Loading splash — a View root fills the web viewport reliably (RNW Pressable
            root can collapse). Auto-advances to phone entry; no tap required. */}
        <SafeAreaView style={styles.splashSafe}>
          <Animated.View style={[styles.splashStage, { opacity: fadeIn, transform: [{ translateY: slideUp }] }]}>
            <View style={styles.splashLogoWrap}>
              <Image
                source={require('../assets/vishful-logo-DPK24n8p.webp')}
                style={styles.splashLogo}
              />
            </View>
            <Text style={styles.splashBrand}>Vishful</Text>
            <Text style={styles.splashTag}>Stay · Belong · Succeed</Text>
            <ActivityIndicator size="small" color="rgba(255,255,255,0.85)" style={{ marginTop: 20 }} />
          </Animated.View>
          <Text style={styles.splashFoot}>Property OS</Text>
        </SafeAreaView>
      </View>
    );
  }

  const canSend = phone.length === 10 && !loading;
  const canVerify = otp.length === 6 && !loading;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <LinearGradient
        colors={[C.night, C.nightMid, C.nightTo]}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.85, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={[styles.orb, styles.orbLogin]} />

      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          // Android: rely on native adjustResize. Setting behavior="height" here
          // fights the OS resize and makes the soft keyboard flicker open→closed.
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            <Animated.View style={{ opacity: fadeIn, transform: [{ translateY: slideUp }] }}>
              <View style={styles.loginMark}>
                <Image
                  source={require('../assets/vishful-logo-DPK24n8p.webp')}
                  style={styles.loginMarkImg}
                />
              </View>
              <View style={styles.eyebrowRow}>
                <View style={styles.eyebrowDot} />
                <Text style={styles.eyebrow}>Vishful Property OS</Text>
              </View>
              <Text style={styles.h1}>
                {step === 'phone' ? 'Welcome back.' : 'Check your phone.'}
              </Text>
              <Text style={styles.lede}>
                {step === 'phone'
                  ? 'Sign in with the number the estate has on file for you.'
                  : 'We texted a 6-digit code to'}
              </Text>
              {step === 'otp' ? (
                <Text style={styles.loginNumber}>+91 {formattedPhone}</Text>
              ) : null}

              <View style={styles.sheet}>
                {step === 'phone' && (
                  <>
                    <Text style={styles.fieldLabel}>Mobile number</Text>
                    <View style={[styles.phoneField, phoneFocused && styles.phoneFieldActive]}>
                      <Text style={styles.phonePrefix}>+91</Text>
                      <TextInput
                        style={styles.phoneInput}
                        value={phone}
                        onFocus={() => setPhoneFocused(true)}
                        onBlur={() => setPhoneFocused(false)}
                        onChangeText={(t: string) => {
                          setPhone(t.replace(/\D/g, '').slice(0, 10));
                          setError('');
                          setShowSignupPrompt(false);
                        }}
                        placeholder="98765 43210"
                        placeholderTextColor={C.placeholder}
                        keyboardType="phone-pad"
                        maxLength={10}
                        selectionColor={C.accent}
                        cursorColor={C.accent}
                      />
                      <Text style={[styles.phoneCount, phone.length === 10 && styles.phoneCountSet]}>
                        {phone.length}/10
                      </Text>
                    </View>

                    {error ? (
                      <View style={styles.errorBox}>
                        <Ionicons name="alert-circle" size={16} color={C.danger} />
                        <Text style={styles.errorMsg}>{error}</Text>
                      </View>
                    ) : null}

                    {showSignupPrompt ? (
                      <View style={styles.infoBox}>
                        <Ionicons name="information-circle-outline" size={18} color={C.digitStrong} />
                        <Text style={styles.infoMsg}>Ask your property admin to add you, then sign in here.</Text>
                      </View>
                    ) : null}

                    <GoButton label="Send code" onPress={handleSendOTP} disabled={!canSend} />
                  </>
                )}

                {step === 'otp' && (
                  <>
                    <View style={styles.otpHead}>
                      <TouchableOpacity
                        onPress={() => { setStep('phone'); setOtp(''); setError(''); setShowSignupPrompt(false); }}
                        style={styles.changeBtn}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="chevron-back" size={12} color={C.digitStrong} />
                        <Text style={styles.changeText}>Change number</Text>
                      </TouchableOpacity>
                    </View>

                    <View style={{ position: 'relative' }}>
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
                        selectionColor={C.accent}
                      />
                    </View>

                    {error ? (
                      <View style={styles.errorBox}>
                        <Ionicons name="alert-circle" size={16} color={C.danger} />
                        <Text style={styles.errorMsg}>{error}</Text>
                      </View>
                    ) : null}

                    <GoButton label="Verify and continue" onPress={handleVerifyOTP} disabled={!canVerify} />

                    <TouchableOpacity
                      onPress={handleResend}
                      disabled={resendIn > 0 || loading}
                      style={styles.resendBtn}
                    >
                      <Text style={[styles.resendText, resendIn > 0 && styles.resendMuted]}>
                        {resendIn > 0 ? `Send a new code in ${resendIn}s` : 'Send a new code'}
                      </Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>

              <View style={styles.secureRow}>
                <Ionicons name="lock-closed-outline" size={12} color="rgba(148,163,184,0.50)" />
                <Text style={styles.secureText}>Secured with a one-time code</Text>
              </View>

              <TouchableOpacity onPress={() => navigation.navigate('PrivacyPolicy')} style={styles.privacyBtn}>
                <Text style={styles.privacyText}>Privacy Policy</Text>
              </TouchableOpacity>
            </Animated.View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.night },
  orb: {
    position: 'absolute',
    borderRadius: 999,
  },
  orbA: {
    width: WIN_W * 0.9,
    height: WIN_W * 0.9,
    top: -WIN_W * 0.18,
    left: WIN_W * 0.05,
    backgroundColor: 'rgba(37,99,235,0.16)',
  },
  orbB: {
    width: WIN_W * 0.7,
    height: WIN_W * 0.7,
    bottom: -WIN_W * 0.2,
    right: -WIN_W * 0.18,
    backgroundColor: 'rgba(30,58,138,0.28)',
  },
  orbLogin: {
    width: WIN_W * 0.85,
    height: WIN_W * 0.85,
    bottom: -WIN_W * 0.35,
    left: WIN_W * 0.08,
    backgroundColor: 'rgba(37,99,235,0.14)',
  },

  splashSafe: { flex: 1, justifyContent: 'space-between' },
  splashStage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 4,
  },
  splashLogoWrap: {
    width: 132,
    height: 132,
    borderRadius: 36,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  splashLogo: { width: 100, height: 100, resizeMode: 'contain' },
  splashBrand: {
    color: C.text,
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -1.2,
    marginTop: 8,
  },
  splashTag: {
    color: 'rgba(226,232,240,0.58)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 2.4,
    textTransform: 'uppercase',
    marginTop: 8,
  },
  splashHint: {
    color: 'rgba(203,213,225,0.48)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    marginTop: 18,
  },
  splashFoot: {
    textAlign: 'center',
    color: 'rgba(148,163,184,0.45)',
    letterSpacing: 3.2,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    paddingBottom: 28,
  },

  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 28,
  },
  loginMark: {
    width: 62,
    height: 62,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  loginMarkImg: { width: 44, height: 44, resizeMode: 'contain' },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  eyebrowDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: C.accent,
  },
  eyebrow: {
    color: C.eyebrow,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 3.2,
    textTransform: 'uppercase',
  },
  h1: {
    color: C.text,
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -1.2,
    lineHeight: 36,
    marginBottom: 10,
  },
  lede: {
    color: C.lede,
    fontSize: 13,
    lineHeight: 20,
    maxWidth: 280,
  },
  loginNumber: {
    color: C.digitStrong,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.6,
    marginTop: 6,
  },

  sheet: {
    marginTop: 22,
    borderRadius: 26,
    backgroundColor: 'rgba(24,29,56,0.86)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 20,
    gap: 16,
  },
  fieldLabel: {
    color: 'rgba(203,213,225,0.55)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 2.2,
    textTransform: 'uppercase',
  },
  phoneField: {
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: C.field,
    borderWidth: 1,
    borderColor: C.fieldBorder,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 12,
  },
  phoneFieldActive: {
    borderColor: 'rgba(37,99,235,0.70)',
    shadowColor: C.accent,
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  phonePrefix: {
    color: C.prefix,
    fontSize: 15,
    fontWeight: '800',
    paddingRight: 12,
    borderRightWidth: 1,
    borderRightColor: C.fieldBorder,
  },
  phoneInput: {
    flex: 1,
    color: C.digit,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 1.6,
    paddingVertical: 0,
    minHeight: 58,
  },
  phoneCount: {
    color: C.dim,
    fontSize: 11,
    fontWeight: '800',
  },
  phoneCountSet: { color: C.digitStrong },

  otpHead: { flexDirection: 'row', justifyContent: 'flex-start' },
  changeBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  changeText: { color: C.digitStrong, fontSize: 11, fontWeight: '700' },
  otpRow: { flexDirection: 'row', gap: 8 },
  otpCell: {
    flex: 1,
    height: 52,
    borderRadius: 14,
    backgroundColor: C.field,
    borderWidth: 1,
    borderColor: C.fieldBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  otpCellFilled: {
    backgroundColor: 'rgba(37,99,235,0.28)',
    borderColor: 'rgba(96,165,250,0.55)',
  },
  otpCellActive: {
    borderColor: C.accent,
  },
  otpCellText: {
    color: C.digit,
    fontSize: 21,
    fontWeight: '800',
  },
  otpHidden: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    opacity: 0.02,
    color: C.digit,
  },

  go: {
    minHeight: 56,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },
  goDisabled: { opacity: 1 },
  goText: { color: C.white, fontSize: 15, fontWeight: '800', letterSpacing: -0.2 },
  goTextDisabled: { color: 'rgba(203,213,225,0.40)' },

  resendBtn: { alignSelf: 'center', paddingVertical: 4, paddingHorizontal: 8 },
  resendText: { color: C.digitStrong, fontSize: 12, fontWeight: '700' },
  resendMuted: { color: 'rgba(148,163,184,0.45)' },

  errorBox: {
    backgroundColor: 'rgba(248,113,113,0.12)',
    borderRadius: 12,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  errorMsg: { flex: 1, color: C.danger, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  infoBox: {
    backgroundColor: 'rgba(37,99,235,0.14)',
    borderRadius: 12,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  infoMsg: { flex: 1, color: C.digitStrong, fontSize: 13, lineHeight: 18, fontWeight: '600' },

  secureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 18,
  },
  secureText: { color: C.dim, fontSize: 11, fontWeight: '600' },
  privacyBtn: { alignItems: 'center', marginTop: 14, paddingVertical: 6 },
  privacyText: { color: C.digitStrong, fontSize: 12, fontWeight: '700' },
});

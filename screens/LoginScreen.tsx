import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform, TouchableOpacity,
  ActivityIndicator, TextInput, Image, Animated, Easing, ScrollView, StatusBar,
  Pressable, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import Svg, { Path, Circle } from 'react-native-svg';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

type Step = 'splash' | 'phone' | 'otp';

const { width: WIN_W } = Dimensions.get('window');

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// Success checkmark geometry (72×72 viewBox).
const CHECK_PATH = 'M22 37 L32 47 L51 26';
const CHECK_LEN = 46;
const RING_CIRC = 2 * Math.PI * 31;

/** Light "premium blue" palette — bright background, dark text, blue accents. */
const C = {
  bg0: '#F7FAFF',
  bg1: '#E9F1FF',
  bg2: '#EEF0FF',
  text: '#0F172A',
  textSoft: '#334155',
  eyebrow: '#2563EB',
  lede: '#64748B',
  dim: '#94A3B8',
  field: 'rgba(255,255,255,0.94)',
  fieldBorder: '#E2E8F0',
  prefix: '#475569',
  placeholder: '#94A3B8',
  digit: '#1D4ED8',
  digitStrong: '#2563EB',
  accent: '#2563EB',
  brand: '#1D4ED8',
  brandDeep: '#1E3A8A',
  danger: '#DC2626',
  success: '#16A34A',
  white: '#FFFFFF',
  card: 'rgba(255,255,255,0.80)',
  cardBorder: 'rgba(226,232,240,0.95)',
  disabled: '#CBD5E1',
  disabledText: '#94A3B8',
};

// ─────────────────────────────────────────────────────────────────────────────
// Living mesh-gradient background — soft light base + 3 slowly drifting pastel blobs.
// ─────────────────────────────────────────────────────────────────────────────
function MeshBackground() {
  const a = useRef(new Animated.Value(0)).current;
  const b = useRef(new Animated.Value(0)).current;
  const c = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const mk = (v: Animated.Value, dur: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, { toValue: 1, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      );
    const loops = [mk(a, 9000), mk(b, 11000), mk(c, 13000)];
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, []);

  const tf = (v: Animated.Value, x: number, y: number, s0: number, s1: number) => ({
    transform: [
      { translateX: v.interpolate({ inputRange: [0, 1], outputRange: [-x, x] }) },
      { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [y, -y] }) },
      { scale: v.interpolate({ inputRange: [0, 1], outputRange: [s0, s1] }) },
    ],
  });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={[C.bg0, C.bg1, C.bg2]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View style={[styles.blob, styles.blobBlue, tf(a, 30, 26, 0.95, 1.2)]} />
      <Animated.View style={[styles.blob, styles.blobIndigo, tf(b, 36, 30, 1.12, 0.92)]} />
      <Animated.View style={[styles.blob, styles.blobViolet, tf(c, 26, 22, 0.9, 1.14)]} />
    </View>
  );
}

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
  const [success, setSuccess] = useState(false);
  const resendTimer = useRef<any>(null);
  const phoneRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const otpRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const pendingLogin = useRef<{ token: string; user: any; refreshToken?: string } | null>(null);
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

  // ── Entrance animation (replays on each step) ──────────────────────────────
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(20)).current;
  const playEnter = useCallback(() => {
    fadeIn.setValue(0);
    slideUp.setValue(20);
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 460, useNativeDriver: true }),
      Animated.timing(slideUp, { toValue: 0, duration: 460, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [fadeIn, slideUp]);
  useEffect(() => { playEnter(); }, [step, playEnter]);

  // Splash auto-advances to the phone entry.
  useEffect(() => {
    if (step !== 'splash') return;
    const t = setTimeout(() => setStep('phone'), 1800);
    return () => clearTimeout(t);
  }, [step]);

  // Open the keyboard once the step is laid out (immediate focus is unreliable on Android).
  useEffect(() => {
    if (step !== 'phone' && step !== 'otp') return;
    const t = setTimeout(() => {
      if (step === 'phone') phoneRef.current?.focus();
      else otpRef.current?.focus();
    }, 400);
    return () => clearTimeout(t);
  }, [step]);

  // ── OTP cell pop + row shake + success-draw animated values ────────────────
  const cellAnims = useRef(Array.from({ length: 6 }, () => new Animated.Value(1))).current;
  const shake = useRef(new Animated.Value(0)).current;
  const overlayOpacity = useRef(new Animated.Value(0)).current;
  const ringScale = useRef(new Animated.Value(0)).current;
  const checkDraw = useRef(new Animated.Value(0)).current;

  // Pop the most recently filled OTP cell.
  useEffect(() => {
    const i = otp.length - 1;
    if (step === 'otp' && i >= 0 && otp[i]) {
      cellAnims[i].setValue(0.7);
      Animated.spring(cellAnims[i], { toValue: 1, friction: 4, tension: 140, useNativeDriver: true }).start();
    }
  }, [otp, step, cellAnims]);

  const formattedPhone = phone.length > 5 ? `${phone.slice(0, 5)} ${phone.slice(5)}` : phone;

  const triggerError = (msg: string, signup = false) => {
    setError(msg);
    setShowSignupPrompt(signup);
    if (step === 'otp') {
      Animated.sequence([
        Animated.timing(shake, { toValue: 1, duration: 55, useNativeDriver: true }),
        Animated.timing(shake, { toValue: -1, duration: 55, useNativeDriver: true }),
        Animated.timing(shake, { toValue: 0.6, duration: 55, useNativeDriver: true }),
        Animated.timing(shake, { toValue: -0.3, duration: 55, useNativeDriver: true }),
        Animated.timing(shake, { toValue: 0, duration: 55, useNativeDriver: true }),
      ]).start();
      setOtp('');
    }
  };

  const playSuccess = () => {
    setSuccess(true);
    Animated.sequence([
      Animated.timing(overlayOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.spring(ringScale, { toValue: 1, friction: 5, tension: 80, useNativeDriver: true }),
    ]).start();
    Animated.timing(checkDraw, { toValue: 1, duration: 440, delay: 180, easing: Easing.out(Easing.cubic), useNativeDriver: false })
      .start(() => {
        setTimeout(() => {
          const p = pendingLogin.current;
          if (p) login(p.token, p.user as any, p.refreshToken);
        }, 420);
      });
  };

  const handleSendOTP = async () => {
    const trimmed = phone.trim().replace(/\D/g, '').slice(-10);
    if (trimmed.length < 10) { setError('Enter a valid 10-digit mobile number'); return; }
    setLoading(true); setError(''); setShowSignupPrompt(false);
    try {
      const result = await sb.sendOtp(trimmed);
      if (result.success) {
        setStep('otp');
        startResendCountdown();
      } else {
        setError(result.message || 'This number is not registered. Please contact admin.');
        setShowSignupPrompt(true);
      }
    } catch {
      setError('Failed to send OTP. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async () => {
    if (otp.trim().length !== 6) { setError('Enter the 6-digit OTP sent to your phone'); return; }
    setLoading(true); setError(''); setShowSignupPrompt(false);
    try {
      const cleanPhone = phone.trim().replace(/\D/g, '').slice(-10);
      const result = await sb.verifyOtpAndLogin(cleanPhone, otp.trim());
      if (result.success && result.token) {
        pendingLogin.current = { token: result.token, user: result.user, refreshToken: result.refreshToken };
        playSuccess();
      } else {
        triggerError(result.message || 'Could not verify. Please try again.');
      }
    } catch (err: any) {
      const msg = (err?.message || '').toLowerCase();
      if (msg.includes('invalid') || msg.includes('expired')) {
        triggerError('Incorrect OTP. Please check and try again.');
      } else if (msg.includes('not found') || msg.includes('not registered')) {
        triggerError('This number is not registered. Please contact admin.', true);
      } else {
        triggerError('Could not verify. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Auto-verify once all six digits are entered.
  useEffect(() => {
    if (step === 'otp' && otp.length === 6 && !loading && !success) {
      handleVerifyOTP();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otp, step]);

  const handleResend = async () => {
    if (resendIn > 0 || loading) return;
    setLoading(true); setError(''); setShowSignupPrompt(false);
    try {
      const cleanPhone = phone.trim().replace(/\D/g, '').slice(-10);
      const result = await sb.sendOtp(cleanPhone);
      if (result.success) { setOtp(''); startResendCountdown(); }
      else setError(result.message || 'Could not resend the code. Please try again.');
    } catch {
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
      const isActive = i === otp.length && !success;
      cells.push(
        <Animated.View
          key={i}
          style={[
            styles.otpCell,
            isFilled && styles.otpCellFilled,
            isActive && styles.otpCellActive,
            { transform: [{ scale: cellAnims[i] }] },
          ]}
        >
          <Text style={styles.otpCellText}>{ch}</Text>
        </Animated.View>,
      );
    }
    return cells;
  };

  const GoButton = ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => (
    <TouchableOpacity activeOpacity={0.88} onPress={onPress} disabled={disabled}>
      {disabled ? (
        <View style={[styles.go, styles.goDisabled]}>
          <Text style={styles.goTextDisabled}>{label}</Text>
          <Ionicons name="arrow-forward" size={16} color={C.disabledText} />
        </View>
      ) : (
        <LinearGradient
          colors={['#2563EB', '#1D4ED8']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.go}
        >
          {loading && !success ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Text style={styles.goText}>{label}</Text>
              <Ionicons name="arrow-forward" size={16} color="#fff" />
            </>
          )}
        </LinearGradient>
      )}
    </TouchableOpacity>
  );

  // ── Splash ─────────────────────────────────────────────────────────────────
  if (step === 'splash') {
    return (
      <View style={styles.root}>
        <StatusBar barStyle="dark-content" />
        <MeshBackground />
        <SafeAreaView style={styles.splashSafe}>
          <Animated.View style={[styles.splashStage, { opacity: fadeIn, transform: [{ translateY: slideUp }] }]}>
            <View style={styles.splashLogoWrap}>
              <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={styles.splashLogo} />
            </View>
            <Text style={styles.splashBrand}>Vishful</Text>
            <Text style={styles.splashTag}>Stay · Belong · Succeed</Text>
            <ActivityIndicator size="small" color={C.accent} style={{ marginTop: 20 }} />
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
      <StatusBar barStyle="dark-content" />
      <MeshBackground />

      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            <Animated.View style={{ opacity: fadeIn, transform: [{ translateY: slideUp }] }}>
              <View style={styles.loginMark}>
                <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={styles.loginMarkImg} />
              </View>
              <View style={styles.eyebrowRow}>
                <View style={styles.eyebrowDot} />
                <Text style={styles.eyebrow}>Vishful Property OS</Text>
              </View>
              <Text style={styles.h1}>{step === 'phone' ? 'Welcome back.' : 'Check your phone.'}</Text>
              <Text style={styles.lede}>
                {step === 'phone'
                  ? 'Sign in with the number the estate has on file for you.'
                  : 'We texted a 6-digit code to'}
              </Text>
              {step === 'otp' ? <Text style={styles.loginNumber}>+91 {formattedPhone}</Text> : null}

              <BlurView intensity={22} tint="light" style={styles.sheet}>
                {step === 'phone' && (
                  <>
                    <Text style={styles.fieldLabel}>Mobile number</Text>
                    <Pressable
                      onPressIn={() => phoneRef.current?.focus()}
                      style={[styles.phoneField, phoneFocused && styles.phoneFieldActive]}
                    >
                      <Text style={styles.phonePrefix}>+91</Text>
                      <TextInput
                        ref={phoneRef}
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
                        inputMode="numeric"
                        maxLength={10}
                        showSoftInputOnFocus
                        autoCorrect={false}
                        autoComplete="tel"
                        textContentType="telephoneNumber"
                        selectionColor={C.accent}
                        cursorColor={C.accent}
                        underlineColorAndroid="transparent"
                      />
                      <Text style={[styles.phoneCount, phone.length === 10 && styles.phoneCountSet]}>
                        {phone.length}/10
                      </Text>
                    </Pressable>

                    {error ? (
                      <View style={styles.errorBox}>
                        <Ionicons name="alert-circle" size={16} color={C.danger} />
                        <Text style={styles.errorMsg}>{error}</Text>
                      </View>
                    ) : null}

                    {showSignupPrompt ? (
                      <View style={styles.infoBox}>
                        <Ionicons name="information-circle-outline" size={18} color={C.brand} />
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
                        <Ionicons name="chevron-back" size={12} color={C.brand} />
                        <Text style={styles.changeText}>Change number</Text>
                      </TouchableOpacity>
                    </View>

                    <Pressable onPressIn={() => otpRef.current?.focus()} style={{ position: 'relative' }}>
                      <Animated.View
                        style={[styles.otpRow, { transform: [{ translateX: shake.interpolate({ inputRange: [-1, 1], outputRange: [-10, 10] }) }] }]}
                        pointerEvents="none"
                      >
                        {renderOtpCells()}
                      </Animated.View>
                      <TextInput
                        ref={otpRef}
                        style={styles.otpHidden}
                        value={otp}
                        onChangeText={(t: string) => {
                          setOtp(t.replace(/\D/g, '').slice(0, 6));
                          setError('');
                          setShowSignupPrompt(false);
                        }}
                        keyboardType="number-pad"
                        inputMode="numeric"
                        maxLength={6}
                        showSoftInputOnFocus
                        caretHidden
                        autoComplete="sms-otp"
                        textContentType="oneTimeCode"
                        importantForAutofill="yes"
                        selectionColor={C.accent}
                        underlineColorAndroid="transparent"
                      />
                    </Pressable>

                    {error ? (
                      <View style={styles.errorBox}>
                        <Ionicons name="alert-circle" size={16} color={C.danger} />
                        <Text style={styles.errorMsg}>{error}</Text>
                      </View>
                    ) : null}

                    <GoButton label="Verify and continue" onPress={handleVerifyOTP} disabled={!canVerify} />

                    <TouchableOpacity onPress={handleResend} disabled={resendIn > 0 || loading} style={styles.resendBtn}>
                      <Text style={[styles.resendText, resendIn > 0 && styles.resendMuted]}>
                        {resendIn > 0 ? `Send a new code in ${resendIn}s` : 'Send a new code'}
                      </Text>
                    </TouchableOpacity>
                  </>
                )}
              </BlurView>

              <View style={styles.secureRow}>
                <Ionicons name="lock-closed-outline" size={12} color={C.dim} />
                <Text style={styles.secureText}>Secured with a one-time code</Text>
              </View>

              <TouchableOpacity onPress={() => navigation.navigate('PrivacyPolicy')} style={styles.privacyBtn}>
                <Text style={styles.privacyText}>Privacy Policy</Text>
              </TouchableOpacity>
            </Animated.View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>

      {/* ── Success overlay — drawn checkmark, then enter the app ── */}
      {success && (
        <Animated.View style={[styles.successOverlay, { opacity: overlayOpacity }]} pointerEvents="none">
          <Animated.View style={{ transform: [{ scale: ringScale }] }}>
            <Svg width={120} height={120} viewBox="0 0 72 72">
              <AnimatedCircle
                cx={36}
                cy={36}
                r={31}
                stroke={C.success}
                strokeWidth={3}
                fill="rgba(22,163,74,0.08)"
                strokeDasharray={RING_CIRC}
                strokeDashoffset={ringScale.interpolate({ inputRange: [0, 1], outputRange: [RING_CIRC, 0] })}
                strokeLinecap="round"
              />
              <AnimatedPath
                d={CHECK_PATH}
                stroke={C.success}
                strokeWidth={5}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={CHECK_LEN}
                strokeDashoffset={checkDraw.interpolate({ inputRange: [0, 1], outputRange: [CHECK_LEN, 0] })}
              />
            </Svg>
          </Animated.View>
          <Text style={styles.successText}>Verified</Text>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg0 },

  blob: { position: 'absolute', borderRadius: 999, opacity: 0.9 },
  blobBlue: {
    width: WIN_W * 1.05,
    height: WIN_W * 1.05,
    top: -WIN_W * 0.3,
    left: -WIN_W * 0.2,
    backgroundColor: 'rgba(37,99,235,0.14)',
  },
  blobIndigo: {
    width: WIN_W * 0.95,
    height: WIN_W * 0.95,
    bottom: -WIN_W * 0.25,
    right: -WIN_W * 0.25,
    backgroundColor: 'rgba(79,70,229,0.14)',
  },
  blobViolet: {
    width: WIN_W * 0.8,
    height: WIN_W * 0.8,
    top: WIN_W * 0.45,
    right: -WIN_W * 0.1,
    backgroundColor: 'rgba(124,58,237,0.10)',
  },

  splashSafe: { flex: 1, justifyContent: 'space-between' },
  splashStage: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 4 },
  splashLogoWrap: {
    width: 148, height: 148, borderRadius: 40,
    backgroundColor: '#FFFFFF',
    borderWidth: 1, borderColor: '#E2E8F0',
    alignItems: 'center', justifyContent: 'center', marginBottom: 10,
    shadowColor: '#1E293B', shadowOpacity: 0.12, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 8,
  },
  splashLogo: { width: 112, height: 112, resizeMode: 'contain' },
  splashBrand: { color: C.text, fontSize: 32, fontWeight: '800', letterSpacing: -1.2, marginTop: 10 },
  splashTag: {
    color: C.lede, fontSize: 12, fontWeight: '600',
    letterSpacing: 2.4, textTransform: 'uppercase', marginTop: 8,
  },
  splashFoot: {
    textAlign: 'center', color: C.dim, letterSpacing: 3.2,
    fontSize: 11, fontWeight: '600', textTransform: 'uppercase', paddingBottom: 28,
  },

  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 28 },

  // Centered, enlarged logo on a white card.
  loginMark: {
    width: 96, height: 96, borderRadius: 26,
    backgroundColor: '#FFFFFF',
    borderWidth: 1, borderColor: '#E2E8F0',
    alignItems: 'center', justifyContent: 'center',
    alignSelf: 'center', marginBottom: 18,
    shadowColor: '#1E293B', shadowOpacity: 0.12, shadowRadius: 20, shadowOffset: { width: 0, height: 10 }, elevation: 6,
  },
  loginMarkImg: { width: 72, height: 72, resizeMode: 'contain' },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10 },
  eyebrowDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: C.accent },
  eyebrow: { color: C.eyebrow, fontSize: 10, fontWeight: '800', letterSpacing: 3.2, textTransform: 'uppercase' },
  h1: { color: C.text, fontSize: 32, fontWeight: '800', letterSpacing: -1.1, lineHeight: 36, marginBottom: 10, textAlign: 'center' },
  lede: { color: C.lede, fontSize: 13, lineHeight: 20, maxWidth: 300, textAlign: 'center', alignSelf: 'center' },
  loginNumber: { color: C.digitStrong, fontSize: 15, fontWeight: '700', letterSpacing: 0.6, marginTop: 6, textAlign: 'center' },

  sheet: {
    marginTop: 22, borderRadius: 28, overflow: 'hidden',
    backgroundColor: C.card,
    borderWidth: 1, borderColor: C.cardBorder,
    paddingHorizontal: 20, paddingTop: 22, paddingBottom: 20, gap: 16,
    shadowColor: '#1E293B', shadowOpacity: 0.10, shadowRadius: 28, shadowOffset: { width: 0, height: 16 }, elevation: 10,
  },
  fieldLabel: { color: C.lede, fontSize: 10, fontWeight: '800', letterSpacing: 2.2, textTransform: 'uppercase' },
  phoneField: {
    minHeight: 58, borderRadius: 18, backgroundColor: C.field,
    borderWidth: 1, borderColor: C.fieldBorder,
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 12,
  },
  phoneFieldActive: {
    borderColor: C.accent,
    shadowColor: C.accent, shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 0 },
  },
  phonePrefix: { color: C.prefix, fontSize: 15, fontWeight: '800', paddingRight: 12, borderRightWidth: 1, borderRightColor: C.fieldBorder },
  phoneInput: { flex: 1, color: C.digit, fontSize: 17, fontWeight: '700', letterSpacing: 1.6, paddingVertical: 0, minHeight: 58 },
  phoneCount: { color: C.dim, fontSize: 11, fontWeight: '800' },
  phoneCountSet: { color: C.digitStrong },

  otpHead: { flexDirection: 'row', justifyContent: 'flex-start' },
  changeBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  changeText: { color: C.brand, fontSize: 11, fontWeight: '700' },
  otpRow: { flexDirection: 'row', gap: 8 },
  otpCell: {
    flex: 1, height: 54, borderRadius: 14, backgroundColor: C.field,
    borderWidth: 1, borderColor: C.fieldBorder, alignItems: 'center', justifyContent: 'center',
  },
  otpCellFilled: { backgroundColor: 'rgba(37,99,235,0.10)', borderColor: 'rgba(37,99,235,0.45)' },
  otpCellActive: {
    borderColor: C.accent,
    shadowColor: C.accent, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 0 },
  },
  otpCellText: { color: C.digit, fontSize: 22, fontWeight: '800' },
  otpHidden: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.02, color: C.digit },

  go: {
    minHeight: 56, borderRadius: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    shadowColor: '#2563EB', shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 10 }, elevation: 8,
  },
  goDisabled: { backgroundColor: C.disabled, shadowOpacity: 0, elevation: 0 },
  goText: { color: C.white, fontSize: 15, fontWeight: '800', letterSpacing: -0.2 },
  goTextDisabled: { color: C.disabledText, fontSize: 15, fontWeight: '800', letterSpacing: -0.2 },

  resendBtn: { alignSelf: 'center', paddingVertical: 4, paddingHorizontal: 8 },
  resendText: { color: C.brand, fontSize: 12, fontWeight: '700' },
  resendMuted: { color: C.dim },

  errorBox: { backgroundColor: 'rgba(220,38,38,0.08)', borderRadius: 12, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  errorMsg: { flex: 1, color: C.danger, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  infoBox: { backgroundColor: 'rgba(37,99,235,0.08)', borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  infoMsg: { flex: 1, color: C.brand, fontSize: 13, lineHeight: 18, fontWeight: '600' },

  secureRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 18 },
  secureText: { color: C.dim, fontSize: 11, fontWeight: '600' },
  privacyBtn: { alignItems: 'center', marginTop: 14, paddingVertical: 6 },
  privacyText: { color: C.brand, fontSize: 12, fontWeight: '700' },

  successOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(247,250,255,0.92)', gap: 14,
  },
  successText: { color: C.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.4 },
});

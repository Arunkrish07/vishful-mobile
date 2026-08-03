import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform, TouchableOpacity,
  ActivityIndicator, TextInput, Image, Animated, Easing, ScrollView,
  Dimensions, AccessibilityInfo,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient, Stop, Rect } from 'react-native-svg';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

// ── "Coming home at dusk" — the brand's flame→purple logo gradient, turned into
// atmosphere. A twilight sky, an ember horizon glow behind the mark (the light of
// home), and monospaced numerals for the one job this screen has: a number + a code.
const C = {
  plumNight: '#1C0E36',
  plumMid: '#2C1751',
  duskMauve: '#45256E',
  ember: '#F0871E',
  emberGlow: '#FFC073',
  warmWhite: '#FBF4EC',
  mauveHaze: '#B9A6D4',
  mauveDim: '#8A78A6',
};

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const { width: WIN_W, height: WIN_H } = Dimensions.get('window');

export default function LoginScreen() {
  const navigation = useNavigation<any>();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSignupPrompt, setShowSignupPrompt] = useState(false);
  const [phoneFocused, setPhoneFocused] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const resendTimer = useRef<any>(null);
  const { login } = useAuth();

  // ── Resend cooldown ──────────────────────────────────────────────────────
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

  // ── Entrance + ambient glow breathe (reduced-motion aware) ───────────────
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(24)).current;
  const glow = useRef(new Animated.Value(1)).current;
  const float = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let loop: Animated.CompositeAnimation | undefined;
    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      Animated.parallel([
        Animated.timing(fadeIn, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.timing(slideUp, { toValue: 0, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]).start();

      if (!reduce) {
        loop = Animated.loop(
          Animated.sequence([
            Animated.timing(glow, { toValue: 0.82, duration: 2600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
            Animated.timing(glow, { toValue: 1, duration: 2600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          ])
        );
        loop.start();
        Animated.loop(
          Animated.sequence([
            Animated.timing(float, { toValue: 1, duration: 2400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
            Animated.timing(float, { toValue: 0, duration: 2400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          ])
        ).start();
      }
    });
    return () => loop?.stop();
  }, []);

  const floatY = float.interpolate({ inputRange: [0, 1], outputRange: [0, -7] });

  // ── Logic preserved exactly from original ────────────────────────────────
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
      setError('Enter the valid 6-digit OTP sent to your phone');
      return;
    }
    if (otp.length < 4) {
      setError('Enter the OTP sent to your phone');
      return;
    }
    setLoading(true);
    setError('');
    setShowSignupPrompt(false);

    try {
      const cleanPhone = phone.trim().replace(/\D/g, '').slice(-10);
      const result = await sb.verifyOtpAndLogin(cleanPhone, otp.trim());
      if (result.success && result.token) {
        await login(result.token, result.user as any);
      } else {
        setError(result.message || 'Something went wrong. Please try again.');
      }
    } catch (err: any) {
      const msg = (err?.message || '').toLowerCase();
      if (msg.includes('invalid') || msg.includes('expired')) {
        setError('Incorrect OTP. Please check and try again.');
      } else if (msg.includes('not found') || msg.includes('not registered')) {
        setError('This number is not registered. Please contact admin.');
        setShowSignupPrompt(true);
      } else {
        setError('Something went wrong. Please try again.');
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

  // Render OTP cells (visual only — actual value held in `otp`)
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
          <Text style={[styles.otpCellText, !isFilled && styles.otpCellDot]}>{ch || '·'}</Text>
        </View>
      );
    }
    return cells;
  };

  return (
    <View style={styles.root}>
      {/* Twilight sky — the brand flame→purple gradient as atmosphere */}
      <LinearGradient
        colors={[C.plumNight, C.plumMid, C.duskMauve]}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />

      {/* Signature: ember horizon bloom behind the mark — the light of home */}
      <Animated.View style={[styles.glowWrap, { opacity: glow }]} pointerEvents="none">
        <Svg width={WIN_W} height={WIN_H * 0.6}>
          <Defs>
            <RadialGradient id="ember" cx="50%" cy="42%" rx="62%" ry="52%">
              <Stop offset="0%" stopColor={C.emberGlow} stopOpacity={0.55} />
              <Stop offset="34%" stopColor={C.ember} stopOpacity={0.22} />
              <Stop offset="70%" stopColor={C.ember} stopOpacity={0.05} />
              <Stop offset="100%" stopColor={C.ember} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect x={0} y={0} width={WIN_W} height={WIN_H * 0.6} fill="url(#ember)" />
        </Svg>
      </Animated.View>

      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
        >
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            {/* Hero — flame mark backlit by the bloom, clean wordmark below */}
            <Animated.View style={[styles.hero, { opacity: fadeIn, transform: [{ translateY: slideUp }] }]}>
              <Animated.View style={{ transform: [{ translateY: floatY }], alignItems: 'center' }}>
                {/* Clip the webp to just the flame — its baked wordmark goes muddy on dark */}
                <View style={styles.markClip}>
                  <Image
                    source={require('../assets/vishful-logo-DPK24n8p.webp')}
                    style={styles.markImg}
                  />
                </View>
                <Text style={styles.wordmark}>VISHFUL</Text>
              </Animated.View>
            </Animated.View>

            {/* Content */}
            <Animated.View style={[styles.body, { opacity: fadeIn, transform: [{ translateY: slideUp }] }]}>
              {step === 'phone' && (
                <>
                  <Text style={styles.eyebrow}>SECURE SIGN-IN</Text>
                  <Text style={styles.display}>Welcome back</Text>
                  <Text style={styles.sub}>
                    Enter your mobile number — we'll text a one-time code to confirm it's you.
                  </Text>

                  <View style={styles.panel}>
                    <Text style={styles.fieldLabel}>MOBILE NUMBER</Text>
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
                        placeholderTextColor={C.mauveDim}
                        keyboardType="phone-pad"
                        maxLength={10}
                      />
                    </View>

                    {error ? (
                      <View style={styles.errorBox}>
                        <Ionicons name="alert-circle" size={18} color="#FCA5A5" style={{ marginTop: 1 }} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.errorMsg}>{error}</Text>
                        </View>
                      </View>
                    ) : null}

                    {showSignupPrompt && (
                      <View style={styles.infoBox}>
                        <Ionicons name="information-circle-outline" size={20} color={C.emberGlow} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.infoTitle}>Not registered?</Text>
                          <Text style={styles.infoMsg}>Ask your property admin to add you, then sign in here.</Text>
                        </View>
                      </View>
                    )}

                    <TouchableOpacity activeOpacity={0.9} onPress={handleSendOTP} disabled={loading} style={{ marginTop: 18 }}>
                      <LinearGradient
                        colors={loading ? ['#B9691A', '#B9691A'] : ['#FF9E3D', C.ember]}
                        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                        style={styles.btnPrimary}
                      >
                        {loading ? (
                          <ActivityIndicator color="#fff" />
                        ) : (
                          <>
                            <Text style={styles.btnPrimaryText}>Send code</Text>
                            <Ionicons name="arrow-forward" size={16} color="#fff" />
                          </>
                        )}
                      </LinearGradient>
                    </TouchableOpacity>

                    <View style={styles.trustBox}>
                      <Ionicons name="shield-checkmark" size={13} color={C.mauveHaze} />
                      <Text style={styles.trustText}>End-to-end encrypted. We never share or sell your number.</Text>
                    </View>
                  </View>

                  <TouchableOpacity onPress={() => navigation.navigate('PrivacyPolicy')} style={styles.linkBtn}>
                    <Text style={styles.linkText}>Privacy Policy</Text>
                  </TouchableOpacity>
                </>
              )}

              {step === 'otp' && (
                <>
                  <Text style={styles.eyebrow}>ENTER CODE</Text>
                  <Text style={styles.display}>Check your phone</Text>
                  <Text style={styles.sub}>
                    We sent a 6-digit code to <Text style={styles.subStrong}>+91 {phone}</Text>
                  </Text>

                  <View style={styles.panel}>
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
                      />
                    </View>

                    {error ? (
                      <View style={[styles.errorBox, { marginTop: 16 }]}>
                        <Ionicons name="alert-circle" size={18} color="#FCA5A5" style={{ marginTop: 1 }} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.errorMsg}>{error}</Text>
                        </View>
                      </View>
                    ) : null}

                    <TouchableOpacity activeOpacity={0.9} onPress={handleVerifyOTP} disabled={loading} style={{ marginTop: 18 }}>
                      <LinearGradient
                        colors={loading ? ['#B9691A', '#B9691A'] : ['#FF9E3D', C.ember]}
                        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                        style={styles.btnPrimary}
                      >
                        {loading ? (
                          <ActivityIndicator color="#fff" />
                        ) : (
                          <>
                            <Text style={styles.btnPrimaryText}>Verify &amp; enter</Text>
                            <Ionicons name="arrow-forward" size={16} color="#fff" />
                          </>
                        )}
                      </LinearGradient>
                    </TouchableOpacity>

                    <View style={styles.resendRow}>
                      {resendIn > 0 ? (
                        <Text style={styles.resendMuted}>
                          Didn't get it? Resend in{' '}
                          <Text style={styles.resendClock}>0:{String(resendIn).padStart(2, '0')}</Text>
                        </Text>
                      ) : (
                        <TouchableOpacity onPress={handleResend} disabled={loading} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Text style={styles.resendActive}>Resend code</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>

                  <TouchableOpacity
                    onPress={() => { setStep('phone'); setOtp(''); setError(''); setShowSignupPrompt(false); }}
                    style={styles.linkBtn}
                  >
                    <Text style={styles.linkText}>← Change number</Text>
                  </TouchableOpacity>
                </>
              )}
            </Animated.View>

            {/* Tagline spine — the brand journey, quiet at the foot */}
            <Text style={styles.spine}>STAY · BELONG · SUCCEED</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.plumNight },

  glowWrap: { position: 'absolute', top: 0, left: 0, right: 0 },

  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 28,
    paddingBottom: 40,
  },

  hero: { alignItems: 'center', marginTop: 48 },
  markClip: {
    width: 150,
    height: 104,        // clip below the flame, above the baked wordmark
    overflow: 'hidden',
    alignItems: 'center',
  },
  markImg: {
    width: 150,
    height: 168,        // full art; only the top (flame) shows through the clip
    resizeMode: 'contain',
  },
  wordmark: {
    marginTop: 10,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 6,
    color: C.warmWhite,
    paddingLeft: 6,      // optical balance for the tracked caps
  },

  body: { marginTop: 30 },

  eyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2.5,
    color: C.mauveHaze,
    marginBottom: 8,
  },
  display: {
    fontSize: 34,
    fontWeight: '800',
    color: C.warmWhite,
    letterSpacing: -1,
    lineHeight: 38,
  },
  sub: {
    fontSize: 14,
    color: C.mauveHaze,
    marginTop: 10,
    lineHeight: 21,
  },
  subStrong: { color: C.warmWhite, fontWeight: '700' },

  // Lamplit panel
  panel: {
    marginTop: 26,
    backgroundColor: 'rgba(255,255,255,0.055)',
    borderRadius: 22,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },

  fieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: C.mauveDim,
    marginBottom: 10,
  },

  inputField: {
    height: 54,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.22)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.10)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  inputFieldActive: {
    borderColor: C.ember,
    backgroundColor: 'rgba(240,135,30,0.08)',
  },
  inputPrefix: {
    fontSize: 15,
    fontWeight: '700',
    color: C.warmWhite,
    fontFamily: MONO,
    marginRight: 12,
  },
  inputDivider: {
    width: 1,
    height: 22,
    backgroundColor: 'rgba(255,255,255,0.16)',
    marginRight: 12,
  },
  inputControl: {
    flex: 1,
    fontSize: 16,
    color: C.warmWhite,
    fontFamily: MONO,
    letterSpacing: 1.5,
    paddingVertical: 0,
  },

  // OTP
  otpRow: { flexDirection: 'row', gap: 8 },
  otpCell: {
    flex: 1,
    height: 58,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.22)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  otpCellFilled: {
    borderColor: C.ember,
    backgroundColor: 'rgba(240,135,30,0.12)',
  },
  otpCellActive: {
    borderColor: C.emberGlow,
  },
  otpCellText: {
    fontSize: 22,
    fontWeight: '700',
    color: C.warmWhite,
    fontFamily: MONO,
  },
  otpCellDot: { color: 'rgba(185,166,212,0.35)', fontWeight: '400' },
  otpHidden: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    opacity: 0,
    color: 'transparent',
  },

  // CTA
  btnPrimary: {
    height: 54,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    shadowColor: C.ember,
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  btnPrimaryText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.3,
  },

  trustBox: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  trustText: {
    flex: 1,
    fontSize: 11.5,
    color: C.mauveHaze,
    lineHeight: 16,
  },

  resendRow: { alignItems: 'center', marginTop: 16 },
  resendMuted: { color: C.mauveDim, fontSize: 13, fontWeight: '600' },
  resendClock: { color: C.mauveHaze, fontFamily: MONO, letterSpacing: 0.5 },
  resendActive: { color: C.emberGlow, fontSize: 13, fontWeight: '700', letterSpacing: 0.2 },

  linkBtn: { alignItems: 'center', marginTop: 18, paddingVertical: 6 },
  linkText: {
    color: C.mauveHaze,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },

  // Feedback boxes
  errorBox: {
    backgroundColor: 'rgba(220,38,38,0.14)',
    borderRadius: 12,
    padding: 12,
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderColor: 'rgba(252,165,165,0.28)',
  },
  errorMsg: { color: '#FCA5A5', fontSize: 13, lineHeight: 18, fontWeight: '600' },
  infoBox: {
    backgroundColor: 'rgba(240,135,30,0.10)',
    borderRadius: 12,
    padding: 14,
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,192,115,0.28)',
  },
  infoTitle: { color: C.emberGlow, fontSize: 13, fontWeight: '800' },
  infoMsg: { color: C.mauveHaze, fontSize: 12, marginTop: 2, lineHeight: 17 },

  spine: {
    textAlign: 'center',
    marginTop: 36,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 3,
    color: 'rgba(185,166,212,0.5)',
  },
});

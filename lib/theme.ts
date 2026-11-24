/**
 * Vishful mobile design tokens — aligned to vishful-mobile-app.vercel.app
 * Indigo-night splash + light slate app chrome.
 */

export const brand = {
  // Logo wing accents (mark only)
  orange: '#F37021',
  orangeLight: '#FFBA08',
  orangeDark: '#C06A0E',
  purple: '#7D3C98',
  purpleLight: '#A5B4FC',
  purpleDark: '#312E81',
  gradientStart: '#312E81',
  gradientMid: '#6366F1',
  gradientEnd: '#F37021',
};

/** Mobile shell / nav (web blue system — vishful-mobile-app) */
export const mobile = {
  brand: '#1D4ED8',
  brandDeep: '#1E3A8A',
  brandSoft: '#EFF6FF',
  brandMid: '#93C5FD',
  accent: '#2563EB',
  accentStrong: '#1D4ED8',
  navOnBg: '#EFF6FF',
  navOnText: '#1D4ED8',
  navOnBorder: '#BFDBFE',
  navIdle: '#556274',
  splashFrom: '#0F1224',
  splashMid: '#1A1F3A',
  splashTo: '#232846',
  splashGlow: 'rgba(99,102,241,0.16)',
  splashText: '#F8FAFC',
  splashTag: 'rgba(226,232,240,0.58)',
  splashHint: 'rgba(203,213,225,0.45)',
  deckFrom: '#1E1B4B',
  deckMid: '#312E81',
  deckTo: '#4338CA',
} as const;

// Sidebar/Drawer — light slate to match reference app chrome
export const sidebarColors = {
  background: '#F8FAFC',
  hoverBackground: '#F1F5F9',
  activeBackground: '#EEF2FF',
  defaultText: '#374151',
  defaultIcon: '#556274',
  activeText: '#1D4ED8',
  activeIcon: '#2563EB',
  dividerColor: 'rgba(15,23,42,0.08)',
  headerTitle: '#111827',
  headerSubtitle: '#6B7280',
  skeletonBase: '#E5E7EB',
  skeletonHighlight: '#F8FAFC',
} as const;

export const lightColors = {
  primary: '#2563EB',
  primaryDark: '#1D4ED8',
  primaryLight: '#EFF6FF',
  secondary: '#1E3A8A',
  secondaryLight: '#EFF6FF',
  secondaryDark: '#1E3A8A',
  success: '#22C55E',
  successLight: '#ECFDF5',
  warning: '#F59E0B',
  warningLight: '#FFFBEB',
  danger: '#EF4444',
  dangerLight: '#FEF2F2',
  info: '#3B82F6',
  infoLight: '#EFF6FF',
  background: '#F6F8FC',
  surface: '#FFFFFF',
  surfaceSecondary: '#EEF2F8',
  border: '#E6EBF2',
  borderLight: '#EEF2F7',
  text: '#0F172A',
  textSecondary: '#5B6878',
  textTertiary: '#8A98AA',
  white: '#FFFFFF',
  black: '#000000',
};

export const colors = lightColors;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const borderRadius = {
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 30,
  full: 9999,
};

export const fontSize = {
  xs: 12,
  sm: 13,
  md: 15,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 28,
  hero: 34,
};

export const inputHeight = 48;

export const shadows = {
  card: {
    shadowColor: '#1E293B',
    shadowOpacity: 0.06,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  elevated: {
    shadowColor: '#1E293B',
    shadowOpacity: 0.10,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },
  glow: {
    shadowColor: '#6366F1',
    shadowOpacity: 0.28,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  subtle: {
    shadowColor: '#0F172A',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  float: {
    shadowColor: '#1E293B',
    shadowOpacity: 0.14,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  purpleGlow: {
    shadowColor: '#6366F1',
    shadowOpacity: 0.25,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
};

export const glass = {
  // Content cards stay crisp white — premium soft depth, rounder corners.
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#EBEFF5',
    shadowColor: '#1E293B',
    shadowOpacity: 0.06,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
    padding: 16,
    marginBottom: 12,
  } as const,
  cardElevated: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#EBEFF5',
    shadowColor: '#1E293B',
    shadowOpacity: 0.10,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
    padding: 18,
    marginBottom: 14,
  } as const,
  header: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderBottomWidth: 1,
    borderBottomColor: '#E6EBF2',
    shadowColor: '#1E293B',
    shadowOpacity: 0.05,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  } as const,
  input: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E6EBF2',
  } as const,
  pillButton: {
    borderRadius: 999,
    paddingHorizontal: 20,
    paddingVertical: 12,
  } as const,
  // Glass chrome (used behind BlurView for headers / nav / modal sheets).
  blurIntensity: 40,
  blurTint: 'light' as const,
  chrome: { backgroundColor: 'rgba(255,255,255,0.72)' } as const,
  gradient: ['#F6F8FC', '#F1F5FB', '#EAF1FF'] as readonly string[],
  screenGradient: ['#F6F8FC', '#F1F5FB', '#EEF2F8'] as readonly string[],
  heroGradient: ['#1E3A8A', '#2563EB', '#3B82F6'] as readonly string[],
};

export const animation = {
  fast: 120,
  normal: 200,
  slow: 300,
  spring: { damping: 18, stiffness: 180 },
  pressScale: 0.97,
  microBounce: { damping: 12, stiffness: 200 },
  stackAnimation: 'slide_from_right' as const,
  stackDuration: 220,
} as const;

export const typography = {
  hero: { fontSize: fontSize.hero, fontWeight: '800' as const, color: colors.text, letterSpacing: -0.8 },
  title: { fontSize: fontSize.xl, fontWeight: '700' as const, color: colors.text, letterSpacing: -0.3 },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: '700' as const, color: colors.text },
  body: { fontSize: fontSize.md, color: colors.text, lineHeight: 22 },
  bodySmall: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20 },
  caption: { fontSize: fontSize.xs, color: colors.textTertiary },
  label: { fontSize: fontSize.xs, fontWeight: '600' as const, color: colors.textSecondary, letterSpacing: 0.5, textTransform: 'uppercase' as const },
};

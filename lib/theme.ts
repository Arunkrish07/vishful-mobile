export const brand = {
  orange: '#E8841A',
  orangeLight: '#F5A84A',
  orangeDark: '#C06A0E',
  purple: '#7B2FBE',
  purpleLight: '#9B5FDE',
  purpleDark: '#5A1F8E',
  // Gradient stops derived from logo wing
  gradientStart: '#7B2FBE',  // purple wing tip
  gradientMid: '#B868D8',    // lavender mid-wing
  gradientEnd: '#E8841A',    // orange wing tip
};

// Sidebar/Drawer Dark Theme Colors
export const sidebarColors = {
  background: '#F7F3F9',
  hoverBackground: '#EDE6F5',
  activeBackground: 'rgba(255,255,255,0.85)',
  defaultText: '#3D2E50',
  defaultIcon: '#7B6B90',
  activeText: '#7B2FBE',
  activeIcon: '#7B2FBE',
  dividerColor: 'rgba(123,47,190,0.08)',
  headerTitle: '#1E1230',
  headerSubtitle: '#7B6B90',
  skeletonBase: '#E8E0F0',
  skeletonHighlight: '#F7F3F9',
} as const;

export const lightColors = {
  primary: '#E8841A',
  primaryDark: '#C06A0E',
  primaryLight: '#FFF3E6',
  secondary: '#7B2FBE',
  secondaryLight: '#F0E6FF',
  secondaryDark: '#5A1F8E',
  success: '#16A34A',
  successLight: '#DCFCE7',
  warning: '#CA8A04',
  warningLight: '#FEF9C3',
  danger: '#DC2626',
  dangerLight: '#FEE2E2',
  info: '#0369A1',
  infoLight: '#E0F2FE',
  background: '#F7F3F9',        // warm lavender-white
  surface: '#FFFFFF',
  surfaceSecondary: '#F3EEF6',  // light purple tint
  border: '#E0D5EA',            // purple-tinted border
  borderLight: '#EDE6F3',
  text: '#1E1230',              // deep purple-black
  textSecondary: '#5C4B70',     // muted purple
  textTertiary: '#9B8BAE',      // light purple-grey
  white: '#FFFFFF',
  black: '#000000',
};

// Legacy export — points to light by default for backward compat
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
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  full: 9999,
};

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  hero: 40,
};

export const inputHeight = 52;

export const shadows = {
  card: {
    shadowColor: '#3D1A6E',
    shadowOpacity: 0.06,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  elevated: {
    shadowColor: '#3D1A6E',
    shadowOpacity: 0.1,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 12 },
    elevation: 5,
  },
  glow: {
    shadowColor: '#E8841A',
    shadowOpacity: 0.35,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  subtle: {
    shadowColor: '#3D1A6E',
    shadowOpacity: 0.03,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  float: {
    shadowColor: '#7B2FBE',
    shadowOpacity: 0.15,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },
  purpleGlow: {
    shadowColor: '#7B2FBE',
    shadowOpacity: 0.3,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
};

// ── Glassmorphism presets ─────────────────────────────────────────────────
export const glass = {
  card: {
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderRadius: 20,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.5)',
    shadowColor: '#3D1A6E',
    shadowOpacity: 0.05,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
    padding: 16,
    marginBottom: 12,
  } as const,
  cardElevated: {
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderRadius: 24,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.6)',
    shadowColor: '#3D1A6E',
    shadowOpacity: 0.08,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 10 },
    elevation: 5,
    padding: 20,
    marginBottom: 14,
  } as const,
  header: {
    backgroundColor: 'rgba(255,255,255,0.5)',
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(255,255,255,0.4)',
    shadowColor: '#3D1A6E',
    shadowOpacity: 0.03,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  } as const,
  input: {
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(224,213,234,0.5)',
  } as const,
  pillButton: {
    borderRadius: 999,
    paddingHorizontal: 20,
    paddingVertical: 14,
  } as const,
  // Purple-to-peach gradient (mirrors logo wing transition)
  gradient: ['#EDE4F8', '#F0E8F4', '#FBF0E8'] as readonly string[],
  screenGradient: ['#EDE4F8', '#F2EAF6', '#FBF0E8'] as readonly string[],
  // A richer gradient for hero areas
  heroGradient: ['#DDD0F0', '#E8D8F0', '#F5E0D0'] as readonly string[],
};

// ── Animation timing ──────────────────────────────────────────────────────
export const animation = {
  fast: 120,
  normal: 200,
  slow: 300,
  spring: { damping: 18, stiffness: 180 },
  pressScale: 0.97,
  microBounce: { damping: 12, stiffness: 200 },
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
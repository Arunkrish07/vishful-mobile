import './lib/errorGuard'; // MUST be first — catches prototype errors during module init
import React, { useState, useEffect, useCallback, useContext, useRef } from 'react';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { createDrawerNavigator, DrawerContentScrollView, DrawerItemList } from '@react-navigation/drawer';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StyleSheet, View, Text, ActivityIndicator, Alert, TouchableOpacity, LogBox, Image, TextInput, Modal, ScrollView, KeyboardAvoidingView, Platform, Animated, Dimensions, TouchableWithoutFeedback } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { queryClient, asyncStoragePersister, CACHE_MAX_AGE } from './lib/queryClient';
import { AuthProvider, useAuth } from './lib/auth';
import * as sb from './lib/supabaseService';
import { fontSize, spacing, sidebarColors, glass } from './lib/theme';
import { useTheme, ThemeProvider } from './lib/ThemeContext';
import LoginScreen from './screens/LoginScreen';
import PrivacyPolicyScreen from './screens/PrivacyPolicyScreen';
import DashboardScreen from './screens/DashboardScreen';
import PropertiesScreen from './screens/PropertiesScreen';
import PropertyDetailScreen from './screens/PropertyDetailScreen';
import TenantsScreen from './screens/TenantsScreen';
import AssetsScreen from './screens/AssetsScreen';
import AccountingScreen from './screens/AccountingScreen';
import ElectricityScreen from './screens/ElectricityScreen';
import ReportsScreen from './screens/ReportsScreen';
import SettingsScreen from './screens/SettingsScreen';
import TenantLifecycleScreen from './screens/TenantLifecycleScreen';
import TenantHomeScreen from './screens/TenantHomeScreen';
import TenantProfileScreen from './screens/TenantProfileScreen';
import TenantKycScreen from './screens/TenantKycScreen';
import  TechnicianTicketsNavigatorScreen  from './screens/TechnicianTicketsNavigatorScreen';
import TicketsScreen from './screens/TicketsScreen';
import TenantTicketsScreen from './screens/TenantTicketsScreen';
import CreateTicketScreen from './screens/CreateTicketScreen';
import TicketDetailScreen from './screens/TicketDetailScreen';
import RaiseTicketScreen from './screens/RaiseTicketScreen';
import OwnersScreen from './screens/OwnersScreen';
import AnouncementsScreen from './screens/AnouncementsScreen';
import AnalyticsScreen from './screens/AnalyticsScreen';
import AvailabilityScreen from './screens/AvailabilityScreen';
import TeamScreen from './screens/TeamScreen';
import MarketScreen from './screens/MarketScreen';
import WhatsAppLogsScreen from './screens/WhatsAppLogsScreen';
import AuditLogsScreen from './screens/AuditLogsScreen';
import { LinearGradient } from 'expo-linear-gradient';
import { ConvexProvider, ConvexReactClient } from 'convex/react';

// ── Inline Permissions System ────────────────────────────────────────────────
// Fetches role_permissions from Supabase and exposes canAccess(module).
// Kept inline to avoid bundler module-resolution issues in sandboxed environments.

type AppModule =
  | 'Dashboard' | 'Properties' | 'Owners' | 'Tenants' | 'Tenant Lifecycle'
  | 'Assets' | 'Accounting' | 'Electricity' | 'Reports' | 'Tickets'
  | 'Analytics' | 'Availability' | 'Announcements'
  | 'Team' | 'Market AI' | 'WhatsApp Logs' | 'Audit Logs' | 'Settings';

type PermMap = Record<string, { can_read: boolean; can_create: boolean; can_update: boolean; can_delete: boolean }>;

interface PermissionsContextType {
  canAccess: (module: AppModule) => boolean;
  isPermissionsLoading: boolean;
  /** True for super_admin / org_admin — lets the drawer bypass HIDDEN_ON_MOBILE. */
  isSuperuser: boolean;
}

const FULL_PERM  = { can_read: true,  can_create: true,  can_update: true,  can_delete: true  };
const SUPER_ROLES = new Set(['super_admin', 'org_admin']);
const MANAGED_ROLES = new Set(['property_manager', 'admin', 'manager']);
// Roles that use their own dedicated navigators and never hit the admin drawer's
// permission gating (so they must NOT trigger a role_permissions lookup).
const NON_DRAWER_ROLES = new Set(['tenant', 'technician']);
// Roles allowed into the admin drawer. Any authenticated role that is NOT here and
// NOT in NON_DRAWER_ROLES is treated as unauthorized — it must not inherit admin
// access by default (closes the old "anything that isn't tenant/technician → full
// admin" escalation, including the backend's 'unknown'/'team_member' fallbacks).
const ADMIN_ROLES = new Set([...SUPER_ROLES, ...MANAGED_ROLES, 'pm', 'team_member']);

/** Map an AppModule display name to the lowercase slug used by role_permissions.module. */
const moduleSlug = (module: AppModule): string => module.toLowerCase().replace(/\s+/g, '_');

const PermissionsContext = React.createContext<PermissionsContextType>({
  canAccess: () => true,
  isPermissionsLoading: false,
  isSuperuser: false,
});

function PermissionsProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated } = useAuth();
  const [permMap, setPermMap]     = React.useState<PermMap>({});
  const [isLoading, setIsLoading] = React.useState(false);
  const lastRole                  = React.useRef<string | null>(null);

  const role         = user?.role || '';
  const isSuperuser  = SUPER_ROLES.has(role);
  const isManaged    = MANAGED_ROLES.has(role);
  // Any authenticated, non-superuser role that lives in the admin drawer (managed
  // roles AND unknown non-tenant/technician roles) is gated by DB permissions.
  const usesDbPerms  = isAuthenticated && !!role && !isSuperuser && !NON_DRAWER_ROLES.has(role);

  React.useEffect(() => {
    if (!isAuthenticated || !role) { setPermMap({}); lastRole.current = null; return; }
    if (isSuperuser)               { setPermMap({}); lastRole.current = role;  return; }
    if (!usesDbPerms)              { setPermMap({}); lastRole.current = role;  return; }
    if (lastRole.current === role) return;

    setIsLoading(true);
    lastRole.current = role;

    (sb as any).getPermissions(role)
      .then((rows: any[]) => {
        const map: PermMap = {};
        (rows || []).forEach((r: any) => {
          map[r.module] = {
            can_read:   !!r.can_read,
            can_create: !!r.can_create,
            can_update: !!r.can_update,
            can_delete: !!r.can_delete,
          };
        });
        setPermMap(map);
        console.log('[PERMISSIONS] Loaded for role:', role, '| modules:', Object.keys(map).join(', '));
      })
      .catch((err: any) => {
        console.warn('[PERMISSIONS] Load failed, defaulting open:', err?.message);
        setPermMap({});
      })
      .finally(() => setIsLoading(false));
  }, [role, isAuthenticated]);

  const canAccess = React.useCallback((module: AppModule): boolean => {
    if (module === 'Dashboard' || module === 'Settings' || module === 'Announcements') return true; // always visible
    if (isSuperuser) return true;                                     // super_admin / org_admin bypass
    if (Object.keys(permMap).length === 0) {
      // No permission rows loaded yet. Fail OPEN only for known admin roles whose
      // config may simply be unset; DENY for any other role so an unrecognized role
      // can't inherit full admin access while perms are empty.
      return ADMIN_ROLES.has(role);
    }
    // Deny-by-default: managed + unknown non-tenant roles are gated by DB perms.
    // Key by the lowercase slug (role_permissions.module is lowercase, e.g. 'properties').
    return !!(permMap[moduleSlug(module)]?.can_read);
  }, [isSuperuser, permMap, role]);

  return (
    <PermissionsContext.Provider value={{ canAccess, isPermissionsLoading: isLoading, isSuperuser }}>
      {children}
    </PermissionsContext.Provider>
  );
}

function usePermissions() { return React.useContext(PermissionsContext); }

// ── Silence known benign warnings ───────────────────────────────────
LogBox.ignoreLogs([
  'Animated: `useNativeDriver`',
  'ResizeObserver loop completed',
  'ResizeObserver loop completed with undelivered notifications',
  'loop completed with undelivered',
  'undelivered notifications',
  'importScripts',
  'Failed to execute',
  'The script at',
  'cdn.jsdelivr',
  '[useSnack]',
  'NetworkError',
  'Failed to load',
  'WorkerGlobalScope',
  'monaco',
  'ts.worker',
  'failed to load',
  'CMbG-7ft.js',
  'Cannot read properties of undefined',
  "reading 'includes'",
  'min/vs/assets/ts.worker',
  '/ts.worker',
  'expo-notifications',
  'not fully supported in Expo Go',
  'was removed from Expo Go',
]);

// console noise filter — safe in both web and React Native
const _origConsoleError = console.error;
console.error = (...args: any[]) => {
  const msg = args.map(a => String(a ?? '')).join(' ').toLowerCase();
  // Catch ALL ResizeObserver variations early
  if (
    msg.includes('resizeobserver') ||
    msg.includes('loop completed') ||
    msg.includes('undelivered') ||
    msg.includes('monaco') ||
    msg.includes('ts.worker') ||
    msg.includes('importscripts') ||
    msg.includes('workerglobalscope') ||
    msg.includes('networkerror') ||
    msg.includes('failed to execute') ||
    msg.includes('failed to load') ||
    msg.includes('the script at') ||
    msg.includes('jsdelivr') ||
    msg.includes('usesnack') ||
    msg.includes('fast2sms') ||
    msg.includes('sms fetch blocked') ||
    msg.includes('cmbg-7ft')
  ) return;
  _origConsoleError(...args);
};

// Also patch console.log to catch [useSnack] wrapper
const _origConsoleLog = console.log;
console.log = (...args: any[]) => {
  const msg = args.map(a => String(a ?? '')).join(' ').toLowerCase();
  if (msg.includes('usesnack') && (msg.includes('resizeobserver') || msg.includes('loop completed'))) return;
  _origConsoleLog(...args);
};

const Drawer = createDrawerNavigator();
const Stack = createNativeStackNavigator();
const PropStack = createNativeStackNavigator();
const TicketStack = createNativeStackNavigator();
const TenantTab = createBottomTabNavigator();
const TenantStack = createNativeStackNavigator();
const AuthStack = createNativeStackNavigator();

function PropertiesStack() {
  return (
    <PropStack.Navigator screenOptions={{ headerShown: false }}>
      <PropStack.Screen name="PropertiesList" component={PropertiesScreen} />
      <PropStack.Screen name="PropertyDetail" component={PropertyDetailScreen} />
    </PropStack.Navigator>
  );
}

function TicketsStack() {
  return (
    <TicketStack.Navigator screenOptions={{ headerShown: false }}>
      <TicketStack.Screen name="TicketsList" component={TicketsScreen} />
      <TicketStack.Screen name="TicketDetail" component={TicketDetailScreen} />
    </TicketStack.Navigator>
  );
}

function CustomDrawerContent(props: any) {
  const { user, logout } = useAuth();

  const handleDrawerLogout = () => {
    Alert.alert('Confirm Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Logout', style: 'destructive', onPress: () => logout() },
    ]);
  };

  return (
    <LinearGradient
      colors={['#F8FAFC', '#F4F6FB', '#EFF6FF']}
      start={{ x: 0, y: 0 }}
      end={{ x: 0.5, y: 1 }}
      style={{ flex: 1 }}
    >
      <DrawerContentScrollView
        {...props}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        style={{ backgroundColor: 'transparent' }}
      >
        {/* Brand header */}
        <View style={{
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.lg,
          borderBottomWidth: 1,
          borderBottomColor: '#E5E7EB',
          marginBottom: spacing.sm,
        }}>
          {/* Logo row */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.lg }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Image
                source={require('./assets/vishful-logo-DPK24n8p.webp')}
                style={{ width: 44, height: 44, resizeMode: 'contain' }}
              />
              <View>
                <Text style={{
                  fontSize: fontSize.xl,
                  fontWeight: '800',
                  color: '#1D4ED8',
                  letterSpacing: -0.3,
                }}>
                  Vishful
                </Text>
                <Text style={{
                  fontSize: 10,
                  color: '#6B7280',
                  letterSpacing: 1.6,
                  fontWeight: '600',
                  textTransform: 'uppercase',
                }}>Stay · Belong · Succeed</Text>
              </View>
            </View>
            <TouchableOpacity onPress={handleDrawerLogout} style={{ padding: 6 }}>
              <Ionicons name="log-out-outline" size={20} color="#556274" />
            </TouchableOpacity>
          </View>

          {/* User info */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{
              width: 46,
              height: 46,
              borderRadius: 23,
              backgroundColor: '#EFF6FF',
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: '#BFDBFE',
            }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: '#1D4ED8' }}>
                {(user?.userName || 'V')[0].toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{
                fontSize: fontSize.md,
                fontWeight: '700',
                color: '#111827',
              }}>
                {user?.userName || 'Admin'}
              </Text>
              <Text style={{
                fontSize: fontSize.xs,
                color: '#6B7280',
                marginTop: 1,
              }}>{'Vishful Spaces LLP'}</Text>
            </View>
          </View>
        </View>

        <DrawerItemList {...props} />
      </DrawerContentScrollView>
    </LinearGradient>
  );
}

// Modules hidden from the mobile drawer for non-super-admin roles.
// Kept as the mechanism for future toggles; super_admin/org_admin bypass it
// entirely (they see every tab). Currently empty — all built tabs are exposed.
const HIDDEN_ON_MOBILE = new Set<AppModule>([]);

function MainDrawer() {
  const { colors } = useTheme();
  const { canAccess: rawCanAccess, isPermissionsLoading, isSuperuser } = usePermissions();
  // Wrap canAccess so hidden modules are treated as inaccessible for regular
  // roles, without touching the underlying permission logic. Super admins bypass
  // the hide list so they always see the full tab set.
  const canAccess = React.useCallback(
    (module: AppModule) => (isSuperuser || !HIDDEN_ON_MOBILE.has(module)) && rawCanAccess(module),
    [rawCanAccess, isSuperuser],
  );

  // Show a brief loading state while permissions are being fetched for managed roles.
  // This prevents a flash where all screens briefly appear before the DB response arrives.
  if (isPermissionsLoading) {
    return (
      <LinearGradient
        colors={['#EDE4F8', '#F2EAF6', '#FBF0E8']}
        start={{ x: 0, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
      >
        <ActivityIndicator size="small" color="#2563EB" />
        <Text style={{ marginTop: 12, fontSize: 13, color: '#6B7280' }}>Loading permissions…</Text>
      </LinearGradient>
    );
  }

  return (
    <Drawer.Navigator
      drawerContent={CustomDrawerContent}
      screenOptions={{
        headerShown: false,
        // Floating bottom bar is the primary nav now — no edge-swipe sidebar
        // (also avoids conflicts with horizontal scrolls inside screens).
        swipeEnabled: false,
        drawerActiveTintColor: '#1D4ED8',
        drawerInactiveTintColor: '#6B7280',
        drawerActiveBackgroundColor: '#EFF6FF',
        drawerLabelStyle: {
          fontSize: 14,
          fontWeight: '500',
          marginLeft: -4,
          lineHeight: 20,
          flexShrink: 1,
        },
        drawerItemStyle: {
          borderRadius: 12,
          marginHorizontal: 12,
          marginVertical: 2,
          paddingVertical: 8,
          paddingHorizontal: 12,
          backgroundColor: 'transparent',
        },
        drawerStyle: {
          width: '78%',
          backgroundColor: 'transparent',
        },
        drawerType: 'front',
      }}
    >
      {/* Dashboard — always visible to any admin-type role */}
      <Drawer.Screen name="Dashboard" component={DashboardScreen}
        options={{ drawerIcon: ({ color }: any) => <Ionicons name="grid-outline" size={20} color={color} /> }} />

      {/* Permission-gated screens — visible only if role has can_read in role_permissions */}
      {canAccess('Tickets') && (
        <Drawer.Screen name="Tickets" component={TicketsStack}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="ticket-outline" size={20} color={color} /> }} />
      )}
      {canAccess('Properties') && (
        <Drawer.Screen name="Properties" component={PropertiesStack}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="business-outline" size={20} color={color} /> }} />
      )}
      {canAccess('Owners') && (
        <Drawer.Screen name="Owners" component={OwnersScreen}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="people-circle-outline" size={20} color={color} /> }} />
      )}
      {canAccess('Tenants') && (
        <Drawer.Screen name="Tenants" component={TenantsScreen}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="people-outline" size={20} color={color} /> }} />
      )}
      {canAccess('Tenant Lifecycle') && (
        <Drawer.Screen name="Tenant Lifecycle" component={TenantLifecycleScreen}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="git-branch-outline" size={20} color={color} /> }} />
      )}
      {canAccess('Assets') && (
        <Drawer.Screen name="Assets" component={AssetsScreen}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="cube-outline" size={20} color={color} /> }} />
      )}
      {canAccess('Accounting') && (
        <Drawer.Screen name="Accounting" component={AccountingScreen}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="receipt-outline" size={20} color={color} /> }} />
      )}
      {canAccess('Electricity') && (
        <Drawer.Screen name="Electricity" component={ElectricityScreen}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="flash-outline" size={20} color={color} /> }} />
      )}
      {canAccess('Reports') && (
        <Drawer.Screen name="Reports" component={ReportsScreen}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="bar-chart-outline" size={20} color={color} /> }} />
      )}
      {canAccess('Analytics') && (
        <Drawer.Screen name="Analytics" component={AnalyticsScreen}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="analytics-outline" size={20} color={color} /> }} />
      )}
      {canAccess('Availability') && (
        <Drawer.Screen name="Availability" component={AvailabilityScreen}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="calendar-outline" size={20} color={color} /> }} />
      )}
      {canAccess('Market AI') && (
        <Drawer.Screen name="Market AI" component={MarketScreen}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="radio-outline" size={20} color={color} /> }} />
      )}
      <Drawer.Screen name="Announcements" component={AnouncementsScreen}
        options={{ drawerIcon: ({ color }: any) => <Ionicons name="megaphone-outline" size={20} color={color} /> }} />
      {canAccess('Team') && (
        <Drawer.Screen name="Team" component={TeamScreen}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="briefcase-outline" size={20} color={color} /> }} />
      )}
      {canAccess('WhatsApp Logs') && (
        <Drawer.Screen name="WhatsApp Logs" component={WhatsAppLogsScreen}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="logo-whatsapp" size={20} color={color} /> }} />
      )}
      {canAccess('Audit Logs') && (
        <Drawer.Screen name="Audit Logs" component={AuditLogsScreen}
          options={{ drawerIcon: ({ color }: any) => <Ionicons name="document-text-outline" size={20} color={color} /> }} />
      )}

      {/* Settings — always visible so admins can manage permissions */}
      <Drawer.Screen name="Settings" component={SettingsScreen}
        options={{ drawerIcon: ({ color }: any) => <Ionicons name="settings-outline" size={20} color={color} /> }} />
    </Drawer.Navigator>
  );
}

function TenantTabNavigator() {
  return (
    <TenantTab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ color, size }) => {
          let iconName: any = 'home-outline';
          if (route.name === 'Home') iconName = 'home-outline';
          else if (route.name === 'Tickets') iconName = 'construct-outline';
          else if (route.name === 'Profile') iconName = 'person-outline';
          return <Ionicons name={iconName} size={size} color={color} />;
        },
        tabBarActiveTintColor: '#1D4ED8',
        tabBarInactiveTintColor: '#556274',
        tabBarStyle: {
          backgroundColor: '#FFFFFF',
          borderTopWidth: 1,
          borderTopColor: '#E5E7EB',
          height: 64,
          paddingBottom: 8,
          paddingTop: 6,
          elevation: 0,
          shadowColor: '#0F172A',
          shadowOpacity: 0.06,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: -2 },
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600', marginTop: -2 },
      })}
    >
      <TenantTab.Screen name="Home" component={TenantHomeScreen} />
      <TenantTab.Screen name="Tickets" component={TenantTicketsScreen} />
      <TenantTab.Screen name="Profile" component={TenantProfileScreen} />
    </TenantTab.Navigator>
  );
}

function TenantNavigator() {
  return (
    <TenantStack.Navigator screenOptions={{ headerShown: false }}>
      <TenantStack.Screen name="TenantTabs" component={TenantTabNavigator} />
      <TenantStack.Screen name="CreateTicket" component={CreateTicketScreen} />
      <TenantStack.Screen name="TenantKyc" component={TenantKycScreen} />
      <TenantStack.Screen name="RaiseTicket" component={RaiseTicketScreen} />
      <TenantStack.Screen name="TicketDetail" component={TicketDetailScreen} />
    </TenantStack.Navigator>
  );
}

// Technician uses the full TechnicianNavigator directly (no extra wrapping)
// TechnicianTicketsNavigatorScreen already has its own tab bar (Dashboard + My Tickets)
// and a profile accessible via its own stack — no double-tab needed.
function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="PrivacyPolicy" component={PrivacyPolicyScreen} />
    </AuthStack.Navigator>
  );
}

// ─── Inline AI Assistant (no separate file import needed) ────────────────────
type AIMessage = { role: 'user' | 'assistant'; content: string };
const AI_W = Dimensions.get('window').width;
const AI_SUGGESTIONS = [
  'How many tenants are currently staying?',
  'Show me all open tickets',
  'What is the current occupancy rate?',
  'How many tenants are on notice?',
  'What are the high priority tickets?',
  'Show recent EB payments',
];
function AIMarkdown({ text, style }: { text: string; style?: any }) {
  return (
    <View>
      {text.split('\n').map((line, i) => {
        const isBullet = /^[\*\-•]\s/.test(line.trim());
        const clean = line.trim().replace(/^[\*\-•]\s/, '');
        const parts = clean.split(/\*\*(.*?)\*\*/g);
        return (
          <View key={i} style={isBullet ? { flexDirection: 'row', marginBottom: 2 } : { marginBottom: 1 }}>
            {isBullet && <Text style={[style, { marginRight: 6 }]}>•</Text>}
            <Text style={[style, { flex: 1, flexWrap: 'wrap' }]}>
              {parts.map((p, j) => j % 2 === 1 ? <Text key={j} style={{ fontWeight: '800' }}>{p}</Text> : <Text key={j}>{p}</Text>)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
function FloatingAIAssistant({ raised }: { raised?: boolean }) {
  const { user } = useAuth();
  const [open, setOpen]         = useState(false);
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [input, setInput]       = useState('');
  const [busy, setBusy]         = useState(false);
  const scrollRef               = useRef<any>(null);
  const pulseAnim               = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!open) {
      Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.1, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1,   duration: 1000, useNativeDriver: true }),
      ])).start();
    } else { pulseAnim.stopAnimation(); pulseAnim.setValue(1); }
  }, [open]);

  useEffect(() => { setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100); }, [messages, busy]);

  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{ role: 'assistant', content: "Hi! I'm your Vishful AI assistant. I have live access to your tenants, tickets, properties and EB data.\n\nAsk me anything!" }]);
    }
  }, [open]);

  const handleSend = async (text?: string) => {
    const q = (text || input).trim();
    if (!q || busy) return;
    setInput('');
    const hist: AIMessage[] = [...messages, { role: 'user', content: q }];
    setMessages(hist);
    setBusy(true);
    try {
      const { client: cc, api: ca } = require('./lib/convexApi');
      const res = await cc.action((ca as any).aiAssistant.askAssistant, { question: q, history: hist.slice(-6).map((m: AIMessage) => ({ role: m.role, content: m.content })) });
      setMessages(p => [...p, { role: 'assistant', content: res.answer || 'No response.' }]);
    } catch (e: any) {
      setMessages(p => [...p, { role: 'assistant', content: `Error: ${e.message || 'Could not reach AI.'}` }]);
    }
    setBusy(false);
  };

  const role = (user as any)?.role || '';
  if (role === 'tenant') return null;

  const AS = StyleSheet.create({
    fab: { position: 'absolute', bottom: 28, right: 20, zIndex: 999, shadowColor: '#2563EB', shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 12 },
    fabBtn: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center' },
    panel: { width: AI_W, height: Dimensions.get('window').height, backgroundColor: '#F8FAFC' },
    hdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: 'rgba(255,255,255,0.95)', borderBottomWidth: 1, borderBottomColor: 'rgba(123,47,190,0.1)' },
    avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center' },
    bubble: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 10, gap: 6 },
    bInner: { maxWidth: AI_W * 0.78, borderRadius: 18, padding: 12 },
    bUser: { backgroundColor: '#2563EB', borderBottomRightRadius: 4 },
    bBot: { backgroundColor: 'rgba(255,255,255,0.95)', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: 'rgba(123,47,190,0.1)' },
    inpArea: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: 'rgba(255,255,255,0.95)', borderTopWidth: 1, borderTopColor: 'rgba(123,47,190,0.1)' },
    inp: { flex: 1, minHeight: 42, maxHeight: 120, backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#E5E7EB', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: '#111827', textAlignVertical: 'top' },
    send: { width: 42, height: 42, borderRadius: 14, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center' },
  });

  return (
    <>
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={AS.panel}>
          <View style={{ flex: 1 }}>
              {/* Header */}
              <View style={AS.hdr}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={AS.avatar}><Ionicons name="sparkles" size={16} color="#fff" /></View>
                  <View>
                    <Text style={{ fontSize: 16, fontWeight: '800', color: '#111827' }}>AI Assistant</Text>
                    <Text style={{ fontSize: 11, color: '#9B8BAE' }}>Ask about your data</Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                  {messages.length > 1 && (
                    <TouchableOpacity onPress={() => setMessages([])} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(123,47,190,0.07)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
                      <Ionicons name="trash-outline" size={14} color="#9B8BAE" />
                      <Text style={{ fontSize: 11, color: '#9B8BAE', fontWeight: '600' }}>Clear</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(123,47,190,0.08)', alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="close" size={20} color="#6B7280" />
                  </TouchableOpacity>
                </View>
              </View>
              {/* Messages */}
              <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 8 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                {messages.map((msg, i) => (
                  <View key={i} style={[AS.bubble, msg.role === 'user' ? { justifyContent: 'flex-end' } : { justifyContent: 'flex-start' }]}>
                    {msg.role === 'assistant' && <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center', marginBottom: 2, flexShrink: 0 }}><Ionicons name="sparkles" size={10} color="#fff" /></View>}
                    <View style={[AS.bInner, msg.role === 'user' ? AS.bUser : AS.bBot]}>
                      {msg.role === 'user'
                        ? <Text style={{ fontSize: 14, color: '#fff', lineHeight: 20 }}>{msg.content}</Text>
                        : <AIMarkdown text={msg.content} style={{ fontSize: 14, color: '#111827', lineHeight: 20 }} />}
                    </View>
                  </View>
                ))}
                {busy && (
                  <View style={[AS.bubble, { justifyContent: 'flex-start' }]}>
                    <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center', marginBottom: 2 }}><Ionicons name="sparkles" size={10} color="#fff" /></View>
                    <View style={[AS.bInner, AS.bBot, { paddingVertical: 12 }]}>
                      <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
                        <ActivityIndicator size="small" color="#2563EB" />
                        <Text style={{ fontSize: 12, color: '#2563EB', fontWeight: '600' }}>Thinking…</Text>
                      </View>
                    </View>
                  </View>
                )}
                {messages.length === 1 && !busy && (
                  <View style={{ marginTop: 12 }}>
                    <Text style={{ fontSize: 11, color: '#9B8BAE', fontWeight: '700', marginBottom: 8 }}>SUGGESTED QUESTIONS</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {AI_SUGGESTIONS.map((s, i) => (
                        <TouchableOpacity key={i} onPress={() => handleSend(s)} style={{ backgroundColor: 'rgba(123,47,190,0.08)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: 'rgba(123,47,190,0.15)' }}>
                          <Text style={{ fontSize: 12, color: '#2563EB', fontWeight: '600' }}>{s}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                )}
              </ScrollView>
              {/* Input */}
              <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={8}>
                <View style={AS.inpArea}>
                  <TextInput style={AS.inp} value={input} onChangeText={setInput} placeholder="Ask anything about your data…" placeholderTextColor="#9B8BAE" multiline maxLength={500} editable={!busy} onSubmitEditing={() => handleSend()} returnKeyType="send" blurOnSubmit />
                  <TouchableOpacity onPress={() => handleSend()} disabled={!input.trim() || busy} style={[AS.send, (!input.trim() || busy) && { opacity: 0.4 }]}>
                    <Ionicons name="send" size={16} color="#fff" />
                  </TouchableOpacity>
                </View>
              </KeyboardAvoidingView>
            </View>
        </View>
      </Modal>
      {!open && (
        <Animated.View style={[AS.fab, raised && { bottom: 78 }, { transform: [{ scale: pulseAnim }] }]}>
          <TouchableOpacity onPress={() => setOpen(true)} style={AS.fabBtn} activeOpacity={0.85}>
            <Ionicons name="sparkles" size={24} color="#fff" />
          </TouchableOpacity>
        </Animated.View>
      )}
    </>
  );
}

// ── Bottom nav rail — exact match to vishful-mobile-app nav-rail ───────────
const NAV_UI = {
  brand: '#1D4ED8',
  accent: '#2563EB',
  idle: '#556274',
  muted: '#6B7280',
  line: '#E5E7EB',
  trackBg: 'rgba(255,255,255,0.97)',
  onBg: '#FFFFFF',
  onGlow: '#EEF4FF',
};

/** Order + labels match the web `An` nav rail exactly. */
type NavItem = {
  name: string;
  label: string;
  icon: any;
  module?: AppModule;
  always?: boolean;
};

const ADMIN_NAV_RAIL: NavItem[] = [
  { name: 'Dashboard',        label: 'Home',          icon: 'home-outline',            always: true },
  { name: 'Tenant Lifecycle', label: 'Lifecycle',     icon: 'git-branch-outline',      module: 'Tenant Lifecycle' },
  { name: 'Tickets',          label: 'Tickets',       icon: 'ticket-outline',          module: 'Tickets' },
  { name: 'Electricity',      label: 'EB',            icon: 'flash-outline',           module: 'Electricity' },
  { name: 'Properties',       label: 'Properties',    icon: 'business-outline',        module: 'Properties' },
  { name: 'Tenants',          label: 'Tenants',       icon: 'people-outline',          module: 'Tenants' },
  { name: 'Assets',           label: 'Assets',        icon: 'cube-outline',            module: 'Assets' },
  { name: 'Accounting',       label: 'Accounts',      icon: 'wallet-outline',          module: 'Accounting' },
  { name: 'Reports',          label: 'Reports',       icon: 'bar-chart-outline',       module: 'Reports' },
  { name: 'Availability',     label: 'Availability',  icon: 'calendar-outline',        module: 'Availability' },
  { name: 'Announcements',    label: 'Announcements', icon: 'megaphone-outline',       always: true },
  { name: 'Owners',           label: 'Owners',        icon: 'people-circle-outline',   module: 'Owners' },
  { name: 'Analytics',        label: 'Analytics',     icon: 'analytics-outline',       module: 'Analytics' },
  { name: 'Market AI',        label: 'Market AI',     icon: 'sparkles-outline',        module: 'Market AI' },
  { name: 'WhatsApp Logs',    label: 'WhatsApp',      icon: 'logo-whatsapp',           module: 'WhatsApp Logs' },
  { name: 'Audit Logs',       label: 'Audit Logs',    icon: 'document-text-outline',   module: 'Audit Logs' },
  { name: 'Settings',         label: 'Settings',      icon: 'settings-outline',        always: true },
  { name: 'Team',             label: 'Team',          icon: 'briefcase-outline',       module: 'Team' },
];

function AdminFloatingNav({ navRef }: { navRef: any }) {
  const insets = useSafeAreaInsets();
  const { canAccess: rawCanAccess, isSuperuser } = usePermissions();
  const canAccess = React.useCallback(
    (m?: AppModule, always?: boolean) =>
      !!always || (!!m && (isSuperuser || !HIDDEN_ON_MOBILE.has(m)) && rawCanAccess(m)),
    [rawCanAccess, isSuperuser],
  );

  const [active, setActive] = useState('Dashboard');
  const scrollRef = useRef<ScrollView>(null);
  const itemLayouts = useRef<Record<string, { x: number; w: number }>>({});

  useEffect(() => {
    const update = () => {
      try {
        const s: any = navRef.getRootState?.();
        const top = s?.routes?.[s.index]?.name;
        if (top) setActive(top);
      } catch {}
    };
    update();
    const unsub = navRef.addListener?.('state', update);
    return () => { try { unsub?.(); } catch {} };
  }, [navRef]);

  // Keep the active tab centered in the horizontal rail (same as web nav-rail).
  useEffect(() => {
    const layout = itemLayouts.current[active];
    if (!layout || !scrollRef.current) return;
    const target = Math.max(0, layout.x - 80);
    scrollRef.current.scrollTo({ x: target, animated: true });
  }, [active]);

  const go = (name: string) => {
    try { if (navRef.isReady?.()) navRef.navigate(name as never); } catch {}
  };

  const items = ADMIN_NAV_RAIL.filter(i => canAccess(i.module, i.always));

  return (
    <View
      pointerEvents="box-none"
      style={[NAV.rail, { paddingBottom: Math.max(insets.bottom, 8) }]}
    >
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={NAV.track}
        decelerationRate="fast"
      >
        {items.map((item) => {
          const on = active === item.name;
          return (
            <TouchableOpacity
              key={item.name}
              style={[NAV.item, on && NAV.itemOn]}
              activeOpacity={0.85}
              onPress={() => go(item.name)}
              onLayout={(e) => {
                const { x, width } = e.nativeEvent.layout;
                itemLayouts.current[item.name] = { x, w: width };
              }}
            >
              <Ionicons
                name={item.icon}
                size={18}
                color={on ? NAV_UI.brand : NAV_UI.idle}
                style={on ? { transform: [{ translateY: -1 }, { scale: 1.06 }] } : undefined}
              />
              <Text style={[NAV.label, on && NAV.labelOn]} numberOfLines={1}>
                {item.label}
              </Text>
              {on ? <View style={NAV.underline} /> : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const NAV = StyleSheet.create({
  rail: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 900,
    elevation: 24,
    backgroundColor: NAV_UI.trackBg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: NAV_UI.line,
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: -2 },
  },
  track: {
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingTop: 4,
    height: 50,
    gap: 2,
  },
  item: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 68,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 18,
    position: 'relative',
  },
  itemOn: {
    backgroundColor: NAV_UI.onBg,
    shadowColor: '#2563EB',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(147,197,253,0.55)',
  },
  label: {
    marginTop: 2,
    fontSize: 10,
    fontWeight: '600',
    color: NAV_UI.idle,
    letterSpacing: 0.1,
  },
  labelOn: {
    color: NAV_UI.brand,
    fontWeight: '700',
  },
  underline: {
    position: 'absolute',
    bottom: 3,
    width: 22,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#1D4ED8',
  },
});

// Shown when an authenticated account resolves to a role that is neither an admin
// role nor tenant/technician — instead of silently dropping it into the admin app.
function UnauthorizedScreen({ onLogout }: { onLogout: () => void }) {
  return (
    <View style={{ flex: 1, backgroundColor: '#F8FAFC', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <Ionicons name="lock-closed-outline" size={48} color="#2563EB" />
      <Text style={{ fontSize: fontSize.xl, fontWeight: '800', color: '#111827', marginTop: 16, textAlign: 'center' }}>Access not enabled</Text>
      <Text style={{ fontSize: fontSize.sm, color: '#6B7280', marginTop: 10, textAlign: 'center', lineHeight: 20 }}>
        Your account isn't set up with access to this app yet. Please contact your administrator.
      </Text>
      <TouchableOpacity onPress={onLogout} style={{ marginTop: 28, backgroundColor: '#2563EB', paddingHorizontal: 28, paddingVertical: 12, borderRadius: 14 }}>
        <Text style={{ color: '#fff', fontWeight: '800' }}>Sign Out</Text>
      </TouchableOpacity>
    </View>
  );
}

function AppNavigator() {
  const { isAuthenticated, isLoading, user, logout } = useAuth();
  const { colors } = useTheme();
  const navRef = useNavigationContainerRef();

  if (isLoading) {
    return (
      <LinearGradient
        colors={['#0F1224', '#1A1F3A', '#232846']}
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.8, y: 1 }}
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
      >
        <View style={{
          width: 132, height: 132, borderRadius: 36,
          backgroundColor: 'rgba(255,255,255,0.06)',
          borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Image
            source={require('./assets/vishful-logo-DPK24n8p.webp')}
            style={{ width: 100, height: 100, resizeMode: 'contain' }}
          />
        </View>
        <Text style={{ fontSize: 34, fontWeight: '800', color: '#F8FAFC', marginTop: 16, letterSpacing: -0.8 }}>
          Vishful
        </Text>
        <Text style={{ fontSize: 12, color: 'rgba(226,232,240,0.58)', letterSpacing: 2.4, marginTop: 8, fontWeight: '600', textTransform: 'uppercase' }}>
          Stay · Belong · Succeed
        </Text>
        <ActivityIndicator size="small" color="#2563EB" style={{ marginTop: 32 }} />
        <Text style={{ fontSize: 12, color: 'rgba(203,213,225,0.45)', marginTop: 20 }}>Property OS</Text>
      </LinearGradient>
    );
  }

  if (!isAuthenticated) return <NavigationContainer><AuthNavigator /></NavigationContainer>;

  const role = user?.role || '';

  // technician → restricted: Tickets only
  const isEmployee = role === 'technician';
  // tenant → restricted: Raise ticket + My requests + Profile only
  const isTenant = role === 'tenant';
  // Admin drawer is gated to an explicit allow-list (was "anything not
  // tenant/technician"). An unrecognized/unauthorized role no longer falls
  // through to the full admin app.
  const isAdmin = ADMIN_ROLES.has(role);

  if (!isAdmin && !isEmployee && !isTenant) {
    return <UnauthorizedScreen onLogout={logout} />;
  }

  return (
    <View style={{ flex: 1 }}>
      <NavigationContainer ref={navRef}>
        {isAdmin    && <MainDrawer />}
        {isEmployee && <TechnicianTicketsNavigatorScreen />}
        {isTenant   && <TenantNavigator />}
      </NavigationContainer>
      {/* Floating bottom navigation — replaces the side drawer for admins */}
      {isAdmin && <AdminFloatingNav navRef={navRef} />}
      {/* Floating AI assistant — visible on all screens for admin/employee */}
      {(isAdmin || isEmployee) && <FloatingAIAssistant raised={isAdmin} />}
    </View>
  );
}

// ── Error Boundary ──────────────────────────────────────────────────────
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error) {
    const msg = error?.message || '';
    const benign = ['prototype', 'removeEventListener', 'security policy', 'ResizeObserver', 'loop completed with undelivered', 'useSnack'];
    if (benign.some(p => msg.includes(p))) {
      // Benign Snack runtime error — render() already handles this, just clean up state
      setTimeout(() => this.setState({ hasError: false, error: null }), 500);
      return;
    }
    console.warn('[ErrorBoundary]', error.message);
  }
  render() {
    if (this.state.hasError) {
      // For benign Snack/runtime errors, render children anyway (no flicker)
      const msg = this.state.error?.message || '';
      const benign = ['prototype', 'removeEventListener', 'security policy', 'ResizeObserver', 'loop completed with undelivered', 'useSnack'];
      if (benign.some(p => msg.includes(p))) {
        return this.props.children;
      }
      // Real error — show recovery UI
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: '#F8FAFC' }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#111827', marginBottom: 8 }}>
            Something went wrong
          </Text>
          <Text style={{ fontSize: 13, color: '#6B7280', textAlign: 'center', marginBottom: 16 }}>
            {this.state.error?.message || 'Please restart the app'}
          </Text>
          <TouchableOpacity
            onPress={() => this.setState({ hasError: false, error: null })}
            style={{ backgroundColor: '#2563EB', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 99 }}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const convexClient = new ConvexReactClient('https://polished-sockeye-740.convex.cloud');

export default function App() {
  return (
    <ErrorBoundary>
      <ConvexProvider client={convexClient}>
        <SafeAreaProvider>
          <PersistQueryClientProvider
            client={queryClient}
            persistOptions={{ persister: asyncStoragePersister, maxAge: CACHE_MAX_AGE }}
          >
            <ThemeProvider>
              <AuthProvider>
                <PermissionsProvider>
                  <AppNavigator />
                </PermissionsProvider>
              </AuthProvider>
            </ThemeProvider>
          </PersistQueryClientProvider>
        </SafeAreaProvider>
      </ConvexProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({ container: { flex: 1 } });
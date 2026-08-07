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

// ── Placeholder for ticket screens (removed — new system TBD) ───────────
function TicketPlaceholder() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F7F3F9' }}>
      <Ionicons name="construct-outline" size={48} color="#7B2FBE" />
      <Text style={{ fontSize: 18, fontWeight: '700', color: '#1E1230', marginTop: 16 }}>
        Tickets
      </Text>
      <Text style={{ fontSize: 14, color: '#5C4B70', marginTop: 4, textAlign: 'center', paddingHorizontal: 32 }}>
        New ticket system coming soon
      </Text>
    </View>
  );
}

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
      colors={['#EDE4F8', '#F2EAF6', '#FBF0E8']}
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
          borderBottomWidth: 0.5,
          borderBottomColor: 'rgba(123,47,190,0.08)',
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
                  fontSize: fontSize.lg,
                  fontWeight: '900',
                  color: '#1E1230',
                  letterSpacing: 0.5,
                }}>
                  <Text style={{ color: '#7B2FBE' }}>VISH</Text>
                  <Text style={{ color: '#E8841A' }}>FUL</Text>
                </Text>
                <Text style={{
                  fontSize: 8,
                  color: '#5C4B70',
                  letterSpacing: 2,
                  fontWeight: '600',
                }}>STAY | BELONG | SUCCEED</Text>
              </View>
            </View>
            <TouchableOpacity onPress={handleDrawerLogout} style={{ padding: 6 }}>
              <Ionicons name="log-out-outline" size={20} color="#5C4B70" />
            </TouchableOpacity>
          </View>

          {/* User info */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{
              width: 46,
              height: 46,
              borderRadius: 14,
              backgroundColor: 'rgba(123,47,190,0.08)',
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1.5,
              borderColor: 'rgba(123,47,190,0.12)',
            }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: '#7B2FBE' }}>
                {(user?.userName || 'V')[0].toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{
                fontSize: fontSize.md,
                fontWeight: '700',
                color: '#1E1230',
              }}>
                {user?.userName || 'Admin'}
              </Text>
              <Text style={{
                fontSize: fontSize.xs,
                color: '#5C4B70',
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
        <ActivityIndicator size="small" color="#7B2FBE" />
        <Text style={{ marginTop: 12, fontSize: 13, color: '#5C4B70' }}>Loading permissions…</Text>
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
        drawerActiveTintColor: '#7B2FBE',
        drawerInactiveTintColor: '#5C4B70',
        drawerActiveBackgroundColor: 'rgba(255,255,255,0.65)',
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
        tabBarActiveTintColor: '#7B2FBE',
        tabBarInactiveTintColor: '#9B8BAE',
        tabBarStyle: {
          backgroundColor: 'rgba(255,255,255,0.88)',
          borderTopWidth: 0.5,
          borderTopColor: 'rgba(224,213,234,0.3)',
          paddingTop: 6,
          elevation: 0,
          shadowColor: '#3D1A6E',
          shadowOpacity: 0.06,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: -4 },
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
    fab: { position: 'absolute', bottom: 28, right: 20, zIndex: 999, shadowColor: '#7B2FBE', shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 12 },
    fabBtn: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#7B2FBE', alignItems: 'center', justifyContent: 'center' },
    panel: { width: AI_W, height: Dimensions.get('window').height, backgroundColor: '#F7F3F9' },
    hdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: 'rgba(255,255,255,0.95)', borderBottomWidth: 1, borderBottomColor: 'rgba(123,47,190,0.1)' },
    avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#7B2FBE', alignItems: 'center', justifyContent: 'center' },
    bubble: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 10, gap: 6 },
    bInner: { maxWidth: AI_W * 0.78, borderRadius: 18, padding: 12 },
    bUser: { backgroundColor: '#7B2FBE', borderBottomRightRadius: 4 },
    bBot: { backgroundColor: 'rgba(255,255,255,0.95)', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: 'rgba(123,47,190,0.1)' },
    inpArea: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: 'rgba(255,255,255,0.95)', borderTopWidth: 1, borderTopColor: 'rgba(123,47,190,0.1)' },
    inp: { flex: 1, minHeight: 42, maxHeight: 120, backgroundColor: '#fff', borderWidth: 1.5, borderColor: 'rgba(123,47,190,0.2)', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: '#1E1230', textAlignVertical: 'top' },
    send: { width: 42, height: 42, borderRadius: 14, backgroundColor: '#7B2FBE', alignItems: 'center', justifyContent: 'center' },
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
                    <Text style={{ fontSize: 16, fontWeight: '800', color: '#1E1230' }}>AI Assistant</Text>
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
                    <Ionicons name="close" size={20} color="#5C4B70" />
                  </TouchableOpacity>
                </View>
              </View>
              {/* Messages */}
              <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 8 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                {messages.map((msg, i) => (
                  <View key={i} style={[AS.bubble, msg.role === 'user' ? { justifyContent: 'flex-end' } : { justifyContent: 'flex-start' }]}>
                    {msg.role === 'assistant' && <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#7B2FBE', alignItems: 'center', justifyContent: 'center', marginBottom: 2, flexShrink: 0 }}><Ionicons name="sparkles" size={10} color="#fff" /></View>}
                    <View style={[AS.bInner, msg.role === 'user' ? AS.bUser : AS.bBot]}>
                      {msg.role === 'user'
                        ? <Text style={{ fontSize: 14, color: '#fff', lineHeight: 20 }}>{msg.content}</Text>
                        : <AIMarkdown text={msg.content} style={{ fontSize: 14, color: '#1E1230', lineHeight: 20 }} />}
                    </View>
                  </View>
                ))}
                {busy && (
                  <View style={[AS.bubble, { justifyContent: 'flex-start' }]}>
                    <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#7B2FBE', alignItems: 'center', justifyContent: 'center', marginBottom: 2 }}><Ionicons name="sparkles" size={10} color="#fff" /></View>
                    <View style={[AS.bInner, AS.bBot, { paddingVertical: 12 }]}>
                      <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
                        <ActivityIndicator size="small" color="#7B2FBE" />
                        <Text style={{ fontSize: 12, color: '#7B2FBE', fontWeight: '600' }}>Thinking…</Text>
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
                          <Text style={{ fontSize: 12, color: '#7B2FBE', fontWeight: '600' }}>{s}</Text>
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
        <Animated.View style={[AS.fab, raised && { bottom: 108 }, { transform: [{ scale: pulseAnim }] }]}>
          <TouchableOpacity onPress={() => setOpen(true)} style={AS.fabBtn} activeOpacity={0.85}>
            <Ionicons name="sparkles" size={24} color="#fff" />
          </TouchableOpacity>
        </Animated.View>
      )}
    </>
  );
}

// ── Floating bottom navigation (replaces the side drawer for admins) ─────────
const NAV_DUSK = {
  plumNight: '#1C0E36', ember: '#F0871E', emberGlow: '#FFC073',
  warmWhite: '#FBF4EC', mauveHaze: '#C6B4DE', mauveDim: '#9A88B6',
};

type NavItem = { name: string; icon: any; module?: AppModule; always?: boolean };
// Mirrors MainDrawer exactly (same names/icons/permission modules).
const ADMIN_MENU: NavItem[] = [
  { name: 'Dashboard',        icon: 'grid-outline',            always: true },
  { name: 'Tickets',          icon: 'ticket-outline',          module: 'Tickets' },
  { name: 'Properties',       icon: 'business-outline',        module: 'Properties' },
  { name: 'Owners',           icon: 'people-circle-outline',   module: 'Owners' },
  { name: 'Tenants',          icon: 'people-outline',          module: 'Tenants' },
  { name: 'Tenant Lifecycle', icon: 'git-branch-outline',      module: 'Tenant Lifecycle' },
  { name: 'Assets',           icon: 'cube-outline',            module: 'Assets' },
  { name: 'Accounting',       icon: 'receipt-outline',         module: 'Accounting' },
  { name: 'Electricity',      icon: 'flash-outline',           module: 'Electricity' },
  { name: 'Reports',          icon: 'bar-chart-outline',       module: 'Reports' },
  { name: 'Analytics',        icon: 'analytics-outline',       module: 'Analytics' },
  { name: 'Availability',     icon: 'calendar-outline',        module: 'Availability' },
  { name: 'Market AI',        icon: 'radio-outline',           module: 'Market AI' },
  { name: 'Announcements',    icon: 'megaphone-outline',       always: true },
  { name: 'Team',             icon: 'briefcase-outline',       module: 'Team' },
  { name: 'WhatsApp Logs',    icon: 'logo-whatsapp',           module: 'WhatsApp Logs' },
  { name: 'Audit Logs',       icon: 'document-text-outline',   module: 'Audit Logs' },
  { name: 'Settings',         icon: 'settings-outline',        always: true },
];
const PRIMARY_TABS = ['Dashboard', 'Tickets', 'Properties', 'Tenants'];

function AdminFloatingNav({ navRef }: { navRef: any }) {
  const insets = useSafeAreaInsets();
  const { width: WIN_W, height: WIN_H } = Dimensions.get('window');
  const { logout } = useAuth();
  const { canAccess: rawCanAccess, isSuperuser } = usePermissions();
  const canAccess = React.useCallback(
    (m?: AppModule, always?: boolean) =>
      !!always || (!!m && (isSuperuser || !HIDDEN_ON_MOBILE.has(m)) && rawCanAccess(m)),
    [rawCanAccess, isSuperuser],
  );

  const [active, setActive] = useState('Dashboard');
  const [moreOpen, setMoreOpen] = useState(false);
  const sheetAnim = useRef(new Animated.Value(0)).current;

  // Track the active top-level route from the navigation container's root state.
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

  useEffect(() => {
    Animated.timing(sheetAnim, { toValue: moreOpen ? 1 : 0, duration: 240, useNativeDriver: true }).start();
  }, [moreOpen]);

  const go = (name: string) => {
    setMoreOpen(false);
    try { if (navRef.isReady?.()) navRef.navigate(name as never); } catch {}
  };

  const handleLogout = () => {
    setMoreOpen(false);
    Alert.alert('Confirm Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Logout', style: 'destructive', onPress: () => logout() },
    ]);
  };

  const primaryItems = ADMIN_MENU.filter(i => PRIMARY_TABS.includes(i.name) && canAccess(i.module, i.always));
  const moreItems    = ADMIN_MENU.filter(i => !PRIMARY_TABS.includes(i.name) && canAccess(i.module, i.always));
  const activeInMore = moreItems.some(i => i.name === active);

  const renderTab = (item: NavItem | null) => {
    const isMore   = item === null;
    const label    = isMore ? 'More' : item!.name;
    const icon     = isMore ? 'apps' : item!.icon;
    const isActive = isMore ? (moreOpen || activeInMore) : active === item!.name;
    return (
      <TouchableOpacity
        key={isMore ? '__more' : item!.name}
        style={NAV.tab}
        activeOpacity={0.8}
        onPress={() => (isMore ? setMoreOpen(true) : go(item!.name))}
      >
        <Ionicons name={icon} size={22} color={isActive ? NAV_DUSK.ember : NAV_DUSK.mauveHaze} />
        <Text style={[NAV.tabLbl, { color: isActive ? NAV_DUSK.emberGlow : NAV_DUSK.mauveDim }]} numberOfLines={1}>
          {label}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <>
      <View pointerEvents="box-none" style={[NAV.wrap, { bottom: Math.max(insets.bottom, 10) + 6 }]}>
        <View style={NAV.bar}>
          {primaryItems.map(i => renderTab(i))}
          {renderTab(null)}
        </View>
      </View>

      {/* More sheet — plain absolute overlay with explicit dims (Fabric-safe; a
          flex/percentage Modal collapses to 0×0 on the new architecture). */}
      {moreOpen && (
        <View style={{ position: 'absolute', top: 0, left: 0, width: WIN_W, height: WIN_H, zIndex: 1000, elevation: 40 }}>
          <TouchableWithoutFeedback onPress={() => setMoreOpen(false)}>
            <Animated.View style={[{ position: 'absolute', top: 0, left: 0, width: WIN_W, height: WIN_H, backgroundColor: 'rgba(10,4,22,0.62)' }, { opacity: sheetAnim }]} />
          </TouchableWithoutFeedback>
          <Animated.View
            style={[
              NAV.sheet,
              {
                width: WIN_W,
                maxHeight: Math.round(WIN_H * 0.8),
                paddingBottom: insets.bottom + 16,
                transform: [{ translateY: sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [WIN_H, 0] }) }],
              },
            ]}
          >
            <View style={NAV.sheetHandle} />
            <View style={NAV.sheetHead}>
              <Text style={NAV.sheetTitle}>All menus</Text>
              <TouchableOpacity onPress={() => setMoreOpen(false)} style={NAV.sheetClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={18} color={NAV_DUSK.mauveHaze} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={NAV.grid} showsVerticalScrollIndicator={false}>
              {moreItems.map(i => {
                const on = active === i.name;
                return (
                  <TouchableOpacity key={i.name} style={NAV.cell} activeOpacity={0.8} onPress={() => go(i.name)}>
                    <View style={[NAV.cellIco, on && { backgroundColor: 'rgba(240,135,30,0.18)', borderColor: NAV_DUSK.ember }]}>
                      <Ionicons name={i.icon} size={22} color={on ? NAV_DUSK.emberGlow : NAV_DUSK.warmWhite} />
                    </View>
                    <Text style={NAV.cellLbl} numberOfLines={2}>{i.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            {/* Sign out — pinned below the menu grid so it stays reachable */}
            <TouchableOpacity style={NAV.signOut} activeOpacity={0.85} onPress={handleLogout}>
              <Ionicons name="log-out-outline" size={20} color={NAV_DUSK.ember} />
              <Text style={NAV.signOutLbl}>Sign Out</Text>
            </TouchableOpacity>
          </Animated.View>
        </View>
      )}
    </>
  );
}

const NAV = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 900, elevation: 30 },
  bar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(28,14,54,0.97)',
    borderRadius: 26, paddingHorizontal: 6, paddingVertical: 8,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 20, shadowOffset: { width: 0, height: 10 }, elevation: 16,
    marginHorizontal: 14,
  },
  tab: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 4, minWidth: 60 },
  tabLbl: { fontSize: 10, fontWeight: '700', marginTop: 3, letterSpacing: 0.2 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,4,22,0.6)' },
  sheet: {
    position: 'absolute', left: 0, bottom: 0,
    backgroundColor: '#241141',
    borderTopLeftRadius: 26, borderTopRightRadius: 26,
    paddingTop: 10, paddingHorizontal: 16,
    borderTopWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)', marginBottom: 10 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, paddingHorizontal: 4 },
  sheetTitle: { fontSize: 15, fontWeight: '800', color: '#FBF4EC', letterSpacing: 0.3 },
  sheetClose: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingBottom: 8 },
  cell: { width: '25%', alignItems: 'center', marginBottom: 18, paddingHorizontal: 2 },
  cellIco: { width: 52, height: 52, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  cellLbl: { fontSize: 10.5, fontWeight: '600', color: '#C6B4DE', textAlign: 'center', lineHeight: 13 },
  signOut: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 6, marginHorizontal: 4, paddingVertical: 14, borderRadius: 16, backgroundColor: 'rgba(240,135,30,0.10)', borderWidth: 1, borderColor: 'rgba(240,135,30,0.35)' },
  signOutLbl: { fontSize: 14, fontWeight: '800', color: '#FBC98A', letterSpacing: 0.3 },
});

// Shown when an authenticated account resolves to a role that is neither an admin
// role nor tenant/technician — instead of silently dropping it into the admin app.
function UnauthorizedScreen({ onLogout }: { onLogout: () => void }) {
  return (
    <LinearGradient colors={glass.screenGradient as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <Ionicons name="lock-closed-outline" size={48} color="#7B2FBE" />
      <Text style={{ fontSize: fontSize.xl, fontWeight: '900', color: '#1E1230', marginTop: 16, textAlign: 'center' }}>Access not enabled</Text>
      <Text style={{ fontSize: fontSize.sm, color: '#5C4B70', marginTop: 10, textAlign: 'center', lineHeight: 20 }}>
        Your account isn't set up with access to this app yet. Please contact your administrator.
      </Text>
      <TouchableOpacity onPress={onLogout} style={{ marginTop: 28, backgroundColor: '#7B2FBE', paddingHorizontal: 28, paddingVertical: 12, borderRadius: 12 }}>
        <Text style={{ color: '#fff', fontWeight: '800' }}>Sign Out</Text>
      </TouchableOpacity>
    </LinearGradient>
  );
}

function AppNavigator() {
  const { isAuthenticated, isLoading, user, logout } = useAuth();
  const { colors } = useTheme();
  const navRef = useNavigationContainerRef();

  if (isLoading) {
    return (
      <LinearGradient
        colors={glass.screenGradient as any}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
      >
        <Image
          source={require('./assets/vishful-logo-DPK24n8p.webp')}
          style={{ width: 120, height: 120, resizeMode: 'contain' }}
        />
        <Text style={{ fontSize: fontSize.xxl, fontWeight: '900', color: '#1E1230', marginTop: 12, letterSpacing: 1 }}>
          <Text style={{ color: '#7B2FBE' }}>VISH</Text>
          <Text style={{ color: '#E8841A' }}>FUL</Text>
        </Text>
        <Text style={{ fontSize: fontSize.xs, color: '#5C4B70', letterSpacing: 2.5, marginTop: 4 }}>STAY | BELONG | SUCCEED</Text>
        <ActivityIndicator size="small" color="#E8841A" style={{ marginTop: 32 }} />
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
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#1E1230', marginBottom: 8 }}>
            Something went wrong
          </Text>
          <Text style={{ fontSize: 14, color: '#5C4B70', textAlign: 'center', marginBottom: 20 }}>
            Please restart the app
          </Text>
          <TouchableOpacity
            onPress={() => this.setState({ hasError: false, error: null })}
            style={{ backgroundColor: '#E8841A', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 99 }}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
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
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({ container: { flex: 1 } });
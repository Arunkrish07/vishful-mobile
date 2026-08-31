// ─── SettingsScreen.tsx ───────────────────────────────────────────────────────
// Mirrors web Settings.tsx exactly (minus Appearance tab).
// Tabs: Organization · Role Assignment · Permissions · Assignment Rules ·
//       Bed Types · Bank Accounts · Financial Constants · Pre-Exit Process ·
//       Auto-Approval · Maintenance Items
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Modal, Switch, StyleSheet, Image,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import { useAuth } from '../lib/auth';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { GlassBackground } from '../components/shared';
import { client as convexClient, api as convexApi } from '../lib/convexApi';
import { LinearGradient } from 'expo-linear-gradient';
import * as sb from '../lib/supabaseService';

// ─── NAV REGISTRY (mirrors web navigation-registry.ts) ───────────────────────
const NAV_REGISTRY = [
  { module: 'dashboard',        label: 'Dashboard',        icon: 'grid-outline',            tabs: [] },
  { module: 'properties',       label: 'Properties',       icon: 'business-outline',        tabs: [] },
  { module: 'owners',           label: 'Owners',           icon: 'people-circle-outline',   tabs: [] },
  { module: 'tenants',          label: 'Tenants',          icon: 'people-outline',          tabs: [] },
  { module: 'tenant_lifecycle', label: 'Tenant Lifecycle', icon: 'git-branch-outline',      tabs: [] },
  { module: 'assets',           label: 'Assets',           icon: 'cube-outline',
    tabs: [
      { key: 'inventory',   label: 'Inventory' },
      { key: 'vendors',     label: 'Vendors' },
      { key: 'allocations', label: 'Allocations' },
      { key: 'categories',  label: 'Categories' },
    ],
  },
  { module: 'tickets', label: 'Tickets', icon: 'construct-outline',
    tabs: [
      { key: 'list',      label: 'Tickets' },
      { key: 'regular',   label: 'Regular Maintenance' },
      { key: 'dashboard', label: 'Dashboard' },
    ],
  },
  { module: 'electricity', label: 'Electricity', icon: 'flash-outline',
    tabs: [
      { key: 'readings', label: 'Meter Readings' },
      { key: 'rates',    label: 'EB Rates' },
    ],
  },
  { module: 'reports', label: 'Reports', icon: 'bar-chart-outline',
    tabs: [
      { key: 'overview',   label: 'Overview'  },
      { key: 'occupancy',  label: 'Occupancy' },
      { key: 'tickets',    label: 'Tickets'   },
      { key: 'tenants',    label: 'Tenants'   },
      { key: 'pnl',        label: 'P&L'       },
      { key: 'bed_profit', label: 'Beds'      },
      { key: 'eb_recon',   label: 'EB Recon'  },
    ],
  },
  { module: 'accounting', label: 'Accounting', icon: 'calculator-outline',
    tabs: [
      { key: 'income',   label: 'Income'   },
      { key: 'expense',  label: 'Expense'  },
      { key: 'ledger',   label: 'Ledger'   },
      { key: 'summary',  label: 'Summary'  },
    ],
  },
  { module: 'analytics',     label: 'Analytics',     icon: 'analytics-outline',      tabs: [] },
  { module: 'availability',  label: 'Availability',  icon: 'calendar-outline',       tabs: [] },
  { module: 'market_ai',     label: 'Market AI',     icon: 'radio-outline',         tabs: [] },
  { module: 'announcements', label: 'Announcements', icon: 'megaphone-outline',      tabs: [] },
  { module: 'team',          label: 'Team',          icon: 'briefcase-outline',      tabs: [] },
  { module: 'whatsapp_logs', label: 'WhatsApp Logs', icon: 'logo-whatsapp',          tabs: [] },
  { module: 'audit_logs',    label: 'Audit Logs',    icon: 'document-text-outline',  tabs: [] },
  { module: 'settings', label: 'Settings', icon: 'settings-outline', tabs: [] },
];

const ROLE_KEYS   = ['super_admin', 'org_admin', 'property_manager', 'employee', 'technician', 'tenant'];
const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin', org_admin: 'Org Admin', property_manager: 'Prop. Manager',
  employee: 'Employee', technician: 'Technician', tenant: 'Tenant',
};
const ROLE_COLORS: Record<string, string> = {
  super_admin: '#DC2626', org_admin: '#2563EB', property_manager: '#2563EB',
  employee: '#16A34A', technician: '#EA580C', tenant: '#64748B',
};

// ─── TABS ─────────────────────────────────────────────────────────────────────
const TABS = [
  { key: 'organization',    label: 'Organization',       icon: 'business-outline'      },
  { key: 'roles',           label: 'Role Assignment',    icon: 'people-circle-outline' },
  { key: 'permissions',     label: 'Permissions',        icon: 'shield-checkmark-outline' },
  { key: 'rules',           label: 'Assignment Rules',   icon: 'list-outline'          },
  { key: 'bed_types',       label: 'Bed Types',          icon: 'bed-outline'           },
  { key: 'bank_accounts',   label: 'Bank Accounts',      icon: 'card-outline'          },
  { key: 'financial',       label: 'Financial Constants',icon: 'calculator-outline'    },
  { key: 'exit_process',    label: 'Pre-Exit Process',   icon: 'log-out-outline'       },
  { key: 'auto_approval',   label: 'Auto-Approval',      icon: 'flash-outline'         },
  { key: 'maintenance',     label: 'Maintenance Items',  icon: 'construct-outline'     },
];

// ─── Small reusable components ────────────────────────────────────────────────
const SL = ({ text }: { text: string }) => (
  <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.5, marginBottom: 6, marginTop: 4 }}>{text.toUpperCase()}</Text>
);
const TInput = ({ label, value, onChangeText, placeholder, keyboardType, multiline, autoCapitalize }: any) => (
  <View style={{ marginBottom: 12 }}>
    {label ? <SL text={label} /> : null}
    <TextInput
      style={{ backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EEF1F6', borderRadius: 12, padding: 10, fontSize: 14, color: colors.text, minHeight: multiline ? 72 : undefined, textAlignVertical: multiline ? 'top' : undefined }}
      value={value} onChangeText={onChangeText} placeholder={placeholder}
      placeholderTextColor={colors.textTertiary} keyboardType={keyboardType}
      multiline={multiline} autoCapitalize={autoCapitalize}
    />
  </View>
);
const Card = ({ children, style }: any) => (
  <View style={[{ backgroundColor: '#FFFFFF', borderRadius: 16, padding: 14, borderWidth: 1, borderColor: '#EEF1F6', marginBottom: 12, shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2 }, style]}>{children}</View>
);
const SaveBtn = ({ onPress, loading, label = 'Save Changes' }: any) => (
  <TouchableOpacity onPress={onPress} disabled={loading}
    style={{ backgroundColor: '#2563EB', borderRadius: 12, padding: 13, alignItems: 'center', marginTop: 8, opacity: loading ? 0.6 : 1 }}>
    {loading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>{label}</Text>}
  </TouchableOpacity>
);

// ─── MAIN SCREEN ─────────────────────────────────────────────────────────────
export default function SettingsScreen() {
  const { user, logout } = useAuth();

  const confirmSignOut = () => {
    Alert.alert(
      user?.userName ? `Sign out of ${user.userName}?` : 'Sign out?',
      'You’ll need your mobile number to sign back in.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => logout() },
      ],
    );
  };
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState('organization');
  const [loading, setLoading] = useState(false);
  const [orgStats, setOrgStats] = useState<{ properties: number; beds: number; team: number } | null>(null);

  // ── Organization tab ──────────────────────────────────────────────────────
  const [orgForm, setOrgForm] = useState({
    organization_name: '', gst_number: '', address_line1: '', address_line2: '',
    city: '', state: '', pincode: '', country: 'India',
    contact_person_name: '', contact_phone: '', contact_email: '', website: '',
  });

  // ── Role Assignment tab ───────────────────────────────────────────────────
  const [teamMembers,    setTeamMembers]    = useState<any[]>([]);
  const [orgProfiles,    setOrgProfiles]    = useState<any[]>([]);
  const [userRoles,      setUserRoles]      = useState<any[]>([]);
  const [roleSearch,     setRoleSearch]     = useState('');
  const [assignOpen,     setAssignOpen]     = useState(false);
  const [assignMember,   setAssignMember]   = useState('');
  const [assignRole,     setAssignRole]     = useState('');

  // ── Permissions tab ───────────────────────────────────────────────────────
  const [selectedRole,   setSelectedRole]   = useState('super_admin');
  const [rolePerms,      setRolePerms]      = useState<any[]>([]);
  const [tabPerms,       setTabPerms]       = useState<any[]>([]);
  const [openModules,    setOpenModules]     = useState<Set<string>>(new Set());

  // ── Assignment Rules tab ──────────────────────────────────────────────────
  const [rules,          setRules]          = useState<any[]>([]);
  const [issueTypes,     setIssueTypes]     = useState<any[]>([]);
  const [ruleOpen,       setRuleOpen]       = useState(false);
  const [editRule,       setEditRule]       = useState<any>(null);
  const [ruleForm,       setRuleForm]       = useState({ rule_type: 'issue_type', issue_type_id: '', apartment_code: '', assigned_employee_id: '', priority: '0' });

  // ── Bed Types tab ─────────────────────────────────────────────────────────
  const [bedTypes,       setBedTypes]       = useState<any[]>([]);
  const [bedTypeName,    setBedTypeName]    = useState('');
  const [bedTypeOpen,    setBedTypeOpen]    = useState(false);

  // ── Bank Accounts tab ─────────────────────────────────────────────────────
  const [bankAccounts,   setBankAccounts]   = useState<any[]>([]);
  const [bankOpen,       setBankOpen]       = useState(false);
  const [editBank,       setEditBank]       = useState<any>(null);
  const [bankForm,       setBankForm]       = useState({ bank_name: '', account_number: '', account_holder: '', ifsc: '', branch: '', is_primary: false });

  // ── Financial Constants tab ───────────────────────────────────────────────
  const [finForm, setFinForm] = useState({
    onboarding_fee: '1000', exit_fee_under_1yr: '2250', advance_ratio: '1.5',
    key_loss_fee: '500', cc_charge_percent: '1.5',
    gst_exemption_days: '90', gst_short_stay_rate: '5',
    gst_rcm_rate: '18', gst_applicable_minimum_rent: '20000',
  });
  const [lifecycleId, setLifecycleId] = useState<string | null>(null);

  // ── Pre-Exit Process tab ──────────────────────────────────────────────────
  const [exitForm, setExitForm] = useState({ exit_task_assignee_1: '', exit_task_assignee_2: '' });
  const [exitMembers, setExitMembers] = useState<any[]>([]);

  // ── Auto-Approval tab ─────────────────────────────────────────────────────
  const [autoForm, setAutoForm] = useState({ ticket_auto_approve_threshold: '1000', ticket_repeat_check_days: '30' });

  // ── Maintenance Items tab ─────────────────────────────────────────────────
  const [maintItems,   setMaintItems]   = useState<any[]>([]);
  const [maintOpen,    setMaintOpen]    = useState(false);
  const [maintForm,    setMaintForm]    = useState({ name: '', unit: '', description: '' });

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const call = useCallback(async (action: string, args: any = {}) => {
    return convexClient.action((convexApi as any).settings[action], args);
  }, []);

  const callConvex = useCallback(async (namespace: string, action: string, args: any = {}) => {
    return convexClient.action((convexApi as any)[namespace][action], args);
  }, []);

  // ─── Load data per tab ────────────────────────────────────────────────────
  const loadTab = useCallback(async (tab: string) => {
    setLoading(true);
    try {
      if (tab === 'organization') {
        try {
          const sb = await import('../lib/convexApi');
          const data = await convexClient.action((convexApi as any).settings.getOrgSettings, {});
          if (data) setOrgForm(f => ({
            ...f,
            organization_name: data.organizationName || '',
            gst_number: data.gst_number ?? f.gst_number,
            address_line1: data.address_line1 ?? f.address_line1,
            address_line2: data.address_line2 ?? f.address_line2,
            city: data.city ?? f.city,
            state: data.state ?? f.state,
            pincode: data.pincode ?? f.pincode,
            country: data.country ?? f.country,
            contact_person_name: data.contact_person_name ?? f.contact_person_name,
            contact_phone: data.contact_phone ?? f.contact_phone,
            contact_email: data.contact_email ?? f.contact_email,
            website: data.website ?? f.website,
          }));
        } catch {}
      }
      if (tab === 'roles') {
        const [members, profiles, roles] = await Promise.all([
          call('getTeamMembers'),
          call('getOrgProfiles'),
          call('getUserRoles'),
        ]);
        setTeamMembers(members || []);
        setOrgProfiles(profiles || []);
        setUserRoles(roles || []);
      }
      if (tab === 'permissions') {
        const [rp, tp] = await Promise.all([
          call('getRolePermissions'),
          call('getTabPermissions'),
        ]);
        setRolePerms(rp || []);
        setTabPerms(tp || []);
      }
      if (tab === 'rules') {
        const [r, it, members] = await Promise.all([
          call('listAssignmentRules').catch(() => []),
          call('listIssueTypes').catch(() => []),
          call('getTeamMembers'),
        ]);
        setRules(r || []);
        setIssueTypes(it || []);
        if (!teamMembers.length) setTeamMembers(members || []);
      }
      if (tab === 'bed_types') {
        const data = await call('listBedTypes').catch(() => []);
        setBedTypes(data || []);
      }
      if (tab === 'bank_accounts') {
        // getBankAccounts lives in the tickets namespace (api.tickets.getBankAccounts), not settings.
        const data = await callConvex('tickets', 'getBankAccounts').catch(() => []);
        setBankAccounts(data || []);
      }
      if (tab === 'financial') {
        const data = await call('getLifecycleConfig').catch(() => null);
        if (data) {
          setLifecycleId(data.id || null);
          setFinForm({
            onboarding_fee: String(data.onboarding_fee ?? 1000),
            exit_fee_under_1yr: String(data.exit_fee_under_1yr ?? 2250),
            advance_ratio: String(data.advance_ratio ?? 1.5),
            key_loss_fee: String(data.key_loss_fee ?? 500),
            cc_charge_percent: String(data.cc_charge_percent ?? 1.5),
            gst_exemption_days: String(data.gst_exemption_days ?? 90),
            gst_short_stay_rate: String(data.gst_short_stay_rate ?? 5),
            gst_rcm_rate: String(data.gst_rcm_rate ?? 18),
            gst_applicable_minimum_rent: String(data.gst_applicable_minimum_rent ?? 20000),
          });
        }
      }
      if (tab === 'exit_process') {
        const [orgData, members] = await Promise.all([
          call('getOrgExitSettings').catch(() => null),
          call('getTeamMembers'),
        ]);
        setExitMembers(members || []);
        if (orgData) setExitForm({ exit_task_assignee_1: orgData.exit_task_assignee_1 || '', exit_task_assignee_2: orgData.exit_task_assignee_2 || '' });
      }
      if (tab === 'auto_approval') {
        const data = await call('getOrgExitSettings').catch(() => null);
        if (data) setAutoForm({ ticket_auto_approve_threshold: String(data.ticket_auto_approve_threshold ?? 1000), ticket_repeat_check_days: String(data.ticket_repeat_check_days ?? 30) });
      }
      if (tab === 'maintenance') {
        const data = await call('listMaintenanceItems').catch(() => []);
        setMaintItems(data || []);
      }
    } catch (e) {
      console.error(`[Settings] loadTab(${tab}) error:`, e);
    }
    setLoading(false);
  }, [call, callConvex]);

  useEffect(() => { loadTab(activeTab); }, [activeTab]);

  // Real workspace counts for the plan card (properties · beds · team members).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [dash, team] = await Promise.all([
        sb.getDashboardData().catch(() => null),
        call('getTeamMembers').catch(() => []),
      ]);
      if (cancelled) return;
      setOrgStats({
        properties: Number((dash as any)?.totalProperties ?? 0),
        beds: Number((dash as any)?.totalBeds ?? (dash as any)?.liveBeds ?? 0),
        team: Array.isArray(team) ? team.length : 0,
      });
    })();
    return () => { cancelled = true; };
  }, [call]);

  // ─── Enriched members for Role tab ────────────────────────────────────────
  const enrichedMembers = useMemo(() => {
    return teamMembers.map((tm: any) => {
      let profileMatch = orgProfiles.find((p: any) => p.id === tm.user_id) ||
        orgProfiles.find((p: any) => p.email === tm.email) ||
        orgProfiles.find((p: any) => p.phone === tm.phone);
      const profileId = profileMatch?.id;
      const roles = profileId
        ? userRoles.filter((r: any) => r.user_id === profileId).map((r: any) => r.role)
        : [];
      return {
        ...tm,
        profileId,
        displayName: `${tm.first_name || ''} ${tm.last_name || ''}`.trim() || tm.name || '—',
        roles,
        isLinked: !!profileId,
      };
    }).filter((m: any) => {
      if (!roleSearch) return true;
      const q = roleSearch.toLowerCase();
      return m.displayName.toLowerCase().includes(q) || (m.email || '').toLowerCase().includes(q) || (m.phone || '').includes(q);
    });
  }, [teamMembers, orgProfiles, userRoles, roleSearch]);

  // ─── Permissions helpers ──────────────────────────────────────────────────
  const getModulePerm = (module: string) =>
    rolePerms.find((p: any) => p.role === selectedRole && p.module === module);
  const getTabPerm = (module: string, tabKey: string) =>
    tabPerms.find((p: any) => p.role === selectedRole && p.module === module && p.tab_key === tabKey);
  const isModuleEnabled = (module: string) => !!getModulePerm(module);

  const handleModuleToggle = async (module: string, enabled: boolean) => {
    try {
      if (enabled) {
        await call('upsertRolePermission', { role: selectedRole, module, can_create: false, can_read: true, can_update: false, can_delete: false });
      } else {
        const perm = getModulePerm(module) as any;
        if (perm?.id) await call('deleteRolePermission', { id: perm.id });
      }
      const rp = await call('getRolePermissions');
      setRolePerms(rp || []);
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  const handleCrudToggle = async (module: string, field: string, value: boolean) => {
    const perm = getModulePerm(module) as any;
    if (!perm) return;
    const upd = { role: selectedRole, module, can_create: perm.can_create, can_read: perm.can_read, can_update: perm.can_update, can_delete: perm.can_delete, id: perm.id, [field]: value };
    try {
      await call('upsertRolePermission', upd);
      const rp = await call('getRolePermissions');
      setRolePerms(rp || []);
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  const handleTabVisibilityToggle = async (module: string, tabKey: string, visible: boolean) => {
    const existing = getTabPerm(module, tabKey) as any;
    try {
      await call('upsertTabPermission', {
        id: existing?.id, role: selectedRole, module, tab_key: tabKey,
        is_visible: visible, can_create: existing?.can_create ?? false,
        can_read: existing?.can_read ?? true, can_update: existing?.can_update ?? false,
        can_delete: existing?.can_delete ?? false,
      });
      const tp = await call('getTabPermissions');
      setTabPerms(tp || []);
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  const handleGrantAll = async () => {
    Alert.alert('Grant All', `Grant ALL permissions to ${ROLE_LABELS[selectedRole]}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Grant', onPress: async () => {
        setLoading(true);
        try {
          for (const mod of NAV_REGISTRY) {
            await call('upsertRolePermission', { role: selectedRole, module: mod.module, can_create: true, can_read: true, can_update: true, can_delete: true });
            for (const tab of mod.tabs) {
              await call('upsertTabPermission', { role: selectedRole, module: mod.module, tab_key: tab.key, is_visible: true, can_create: true, can_read: true, can_update: true, can_delete: true });
            }
          }
          const [rp, tp] = await Promise.all([call('getRolePermissions'), call('getTabPermissions')]);
          setRolePerms(rp || []); setTabPerms(tp || []);
          Alert.alert('Done', 'All permissions granted.');
        } catch (e: any) { Alert.alert('Error', e.message); }
        setLoading(false);
      }},
    ]);
  };

  const handleRevokeAll = async () => {
    Alert.alert('Revoke All', `Remove ALL permissions from ${ROLE_LABELS[selectedRole]}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Revoke', style: 'destructive', onPress: async () => {
        setLoading(true);
        try {
          await call('deleteAllRolePermissions', { role: selectedRole });
          const [rp, tp] = await Promise.all([call('getRolePermissions'), call('getTabPermissions')]);
          setRolePerms(rp || []); setTabPerms(tp || []);
          Alert.alert('Done', 'All permissions revoked.');
        } catch (e: any) { Alert.alert('Error', e.message); }
        setLoading(false);
      }},
    ]);
  };

  // ─── TAB RENDERS ──────────────────────────────────────────────────────────

  const renderOrganization = () => (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Card>
        <Text style={S.cardTitle}>Organization Details</Text>
        <TInput label="Organization Name *" value={orgForm.organization_name} onChangeText={(v: string) => setOrgForm(f => ({ ...f, organization_name: v }))} placeholder="e.g. Vishful Spaces LLP" />
        <TInput label="GST Number" value={orgForm.gst_number} onChangeText={(v: string) => setOrgForm(f => ({ ...f, gst_number: v }))} placeholder="GST registration number" autoCapitalize="characters" />
      </Card>
      <Card>
        <Text style={S.cardTitle}>Address</Text>
        <TInput label="Address Line 1" value={orgForm.address_line1} onChangeText={(v: string) => setOrgForm(f => ({ ...f, address_line1: v }))} placeholder="Street address" />
        <TInput label="Address Line 2" value={orgForm.address_line2} onChangeText={(v: string) => setOrgForm(f => ({ ...f, address_line2: v }))} placeholder="Apartment, suite, etc." />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}><TInput label="City" value={orgForm.city} onChangeText={(v: string) => setOrgForm(f => ({ ...f, city: v }))} placeholder="City" /></View>
          <View style={{ flex: 1 }}><TInput label="State" value={orgForm.state} onChangeText={(v: string) => setOrgForm(f => ({ ...f, state: v }))} placeholder="State" /></View>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}><TInput label="Pincode" value={orgForm.pincode} onChangeText={(v: string) => setOrgForm(f => ({ ...f, pincode: v }))} placeholder="6 digits" keyboardType="numeric" /></View>
          <View style={{ flex: 1 }}><TInput label="Country" value={orgForm.country} onChangeText={(v: string) => setOrgForm(f => ({ ...f, country: v }))} placeholder="India" /></View>
        </View>
      </Card>
      <Card>
        <Text style={S.cardTitle}>Primary Contact</Text>
        <TInput label="Contact Person" value={orgForm.contact_person_name} onChangeText={(v: string) => setOrgForm(f => ({ ...f, contact_person_name: v }))} placeholder="Full name" />
        <TInput label="Phone" value={orgForm.contact_phone} onChangeText={(v: string) => setOrgForm(f => ({ ...f, contact_phone: v }))} placeholder="+91XXXXXXXXXX" keyboardType="phone-pad" />
        <TInput label="Email" value={orgForm.contact_email} onChangeText={(v: string) => setOrgForm(f => ({ ...f, contact_email: v }))} placeholder="email@example.com" keyboardType="email-address" autoCapitalize="none" />
        <TInput label="Website" value={orgForm.website} onChangeText={(v: string) => setOrgForm(f => ({ ...f, website: v }))} placeholder="https://..." autoCapitalize="none" />
      </Card>
      <SaveBtn loading={loading} onPress={async () => {
        setLoading(true);
        try {
          await call('updateOrgSettings', {
            organizationName: orgForm.organization_name.trim(),
            gstNumber: orgForm.gst_number.trim(),
            addressLine1: orgForm.address_line1.trim(),
            addressLine2: orgForm.address_line2.trim(),
            city: orgForm.city.trim(),
            state: orgForm.state.trim(),
            pincode: orgForm.pincode.trim(),
            country: orgForm.country.trim(),
            contactPersonName: orgForm.contact_person_name.trim(),
            contactPhone: orgForm.contact_phone.trim(),
            contactEmail: orgForm.contact_email.trim(),
            website: orgForm.website.trim(),
          });
          Alert.alert('Saved', 'Organization profile updated.');
        } catch (e: any) { Alert.alert('Error', e.message); }
        setLoading(false);
      }} />
    </ScrollView>
  );

  const renderRoles = () => (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      {/* Search + Add button */}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: '#EEF1F6', paddingHorizontal: 10 }}>
          <Ionicons name="search-outline" size={16} color={colors.textTertiary} style={{ marginRight: 6 }} />
          <TextInput style={{ flex: 1, fontSize: 14, color: colors.text, paddingVertical: 9 }} value={roleSearch} onChangeText={setRoleSearch} placeholder="Search team members…" placeholderTextColor={colors.textTertiary} />
        </View>
        <TouchableOpacity onPress={() => { setAssignMember(''); setAssignRole(''); setAssignOpen(true); }}
          style={{ backgroundColor: '#2563EB', borderRadius: 10, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="person-add-outline" size={18} color="#fff" />
        </TouchableOpacity>
      </View>

      {enrichedMembers.length === 0 ? (
        <Card><Text style={{ color: colors.textTertiary, textAlign: 'center', paddingVertical: 20 }}>No team members found</Text></Card>
      ) : enrichedMembers.map((m: any) => (
        <Card key={m.id} style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>{m.displayName}</Text>
              {m.email ? <Text style={{ fontSize: 12, color: colors.textSecondary }}>{m.email}</Text> : null}
              {m.phone ? <Text style={{ fontSize: 12, color: colors.textSecondary }}>{m.phone}</Text> : null}
              {!m.isLinked && <Text style={{ fontSize: 11, color: '#D97706', marginTop: 2 }}>⚠ Not linked to user account</Text>}
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              {m.roles.length === 0 ? (
                <View style={{ backgroundColor: '#F1F5F9', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ fontSize: 10, color: colors.textTertiary }}>No role</Text>
                </View>
              ) : m.roles.map((role: string) => (
                <TouchableOpacity key={role} onPress={() => {
                  Alert.alert('Remove Role', `Remove "${ROLE_LABELS[role] || role}" from ${m.displayName}?`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Remove', style: 'destructive', onPress: async () => {
                      try { await call('removeUserRole', { user_id: m.profileId, role }); await loadTab('roles'); }
                      catch (e: any) { Alert.alert('Error', e.message); }
                    }},
                  ]);
                }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: (ROLE_COLORS[role] || '#64748B') + '15', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: (ROLE_COLORS[role] || '#64748B') + '40' }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: ROLE_COLORS[role] || '#64748B' }}>{ROLE_LABELS[role] || role}</Text>
                  <Ionicons name="close" size={10} color={ROLE_COLORS[role] || '#64748B'} />
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </Card>
      ))}
    </ScrollView>
  );

  const renderPermissions = () => {
    const currentRolePermCount = rolePerms.filter((p: any) => p.role === selectedRole).length;
    return (
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        {/* Role selector */}
        <Card>
          <Text style={S.cardTitle}>Select Role</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 4 }}>
              {ROLE_KEYS.map(role => {
                const active = selectedRole === role;
                return (
                  <TouchableOpacity key={role} onPress={() => setSelectedRole(role)}
                    style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 99, backgroundColor: active ? (ROLE_COLORS[role] || '#2563EB') : '#F1F5F9', borderWidth: 1, borderColor: active ? (ROLE_COLORS[role] || '#2563EB') : '#EEF1F6' }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : colors.textSecondary }}>{ROLE_LABELS[role]}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <TouchableOpacity onPress={handleGrantAll} style={{ flex: 1, backgroundColor: '#16A34A', borderRadius: 10, padding: 9, alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>Grant All</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleRevokeAll} style={{ flex: 1, backgroundColor: '#DC2626', borderRadius: 10, padding: 9, alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>Revoke All</Text>
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 8 }}>
            {currentRolePermCount} / {NAV_REGISTRY.length} modules configured
          </Text>
        </Card>

        {/* Module accordions */}
        {NAV_REGISTRY.map(mod => {
          const isOpen = openModules.has(mod.module);
          const enabled = isModuleEnabled(mod.module);
          const perm = getModulePerm(mod.module) as any;
          const hasTabs = mod.tabs.length > 0;
          const CRUD = [
            { key: 'can_create', label: 'Create' },
            { key: 'can_read',   label: 'Read'   },
            { key: 'can_update', label: 'Update' },
            { key: 'can_delete', label: 'Delete' },
          ];
          return (
            <View key={mod.module} style={[S.permCard, !enabled && { opacity: 0.5 }]}>
              {/* Module header row */}
              <TouchableOpacity onPress={() => setOpenModules(prev => { const n = new Set(prev); n.has(mod.module) ? n.delete(mod.module) : n.add(mod.module); return n; })}
                style={{ flexDirection: 'row', alignItems: 'center', padding: 12 }}>
                <Ionicons name={isOpen ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textTertiary} />
                <Ionicons name={mod.icon as any} size={16} color="#2563EB" style={{ marginHorizontal: 8 }} />
                <Text style={{ flex: 1, fontSize: 14, fontWeight: '700', color: colors.text }}>{mod.label}</Text>
                {hasTabs && <View style={{ backgroundColor: '#EFF6FF', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, marginRight: 8 }}>
                  <Text style={{ fontSize: 9, fontWeight: '700', color: '#2563EB' }}>{mod.tabs.length} TABS</Text>
                </View>}
                <Switch value={enabled} onValueChange={(v) => handleModuleToggle(mod.module, v)} trackColor={{ true: '#2563EB' }} thumbColor="#fff" />
              </TouchableOpacity>

              {/* Expanded content */}
              {isOpen && enabled && (
                <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 10 }}>
                  {/* Page-level CRUD */}
                  <View style={{ backgroundColor: '#F8FAFC', borderRadius: 10, padding: 10 }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textTertiary, marginBottom: 8 }}>PAGE-LEVEL PERMISSIONS</Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {CRUD.map(({ key, label }) => {
                        const checked = perm?.[key] ?? false;
                        return (
                          <TouchableOpacity key={key} onPress={() => handleCrudToggle(mod.module, key, !checked)}
                            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <View style={{ width: 16, height: 16, borderRadius: 4, borderWidth: 1.5, borderColor: checked ? '#2563EB' : '#EEF1F6', backgroundColor: checked ? '#2563EB' : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                              {checked && <Ionicons name="checkmark" size={10} color="#fff" />}
                            </View>
                            <Text style={{ fontSize: 11, color: colors.textSecondary }}>{label}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>

                  {/* Tab permissions */}
                  {hasTabs && (
                    <View style={{ backgroundColor: '#F8FAFC', borderRadius: 10, padding: 10 }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textTertiary, marginBottom: 8 }}>TAB VISIBILITY</Text>
                      {mod.tabs.map(tab => {
                        const tabPerm = getTabPerm(mod.module, tab.key) as any;
                        const isVisible = tabPerm ? tabPerm.is_visible : true;
                        return (
                          <View key={tab.key} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#EEF1F6' }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                              <Ionicons name={isVisible ? 'eye-outline' : 'eye-off-outline'} size={14} color={isVisible ? '#2563EB' : '#DC2626'} />
                              <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{tab.label}</Text>
                            </View>
                            <Switch value={isVisible} onValueChange={(v) => handleTabVisibilityToggle(mod.module, tab.key, v)} trackColor={{ true: '#2563EB' }} thumbColor="#fff" />
                          </View>
                        );
                      })}
                    </View>
                  )}
                </View>
              )}
              {isOpen && !enabled && (
                <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
                  <Text style={{ fontSize: 12, color: colors.textTertiary, fontStyle: 'italic' }}>Enable this module to configure permissions.</Text>
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>
    );
  };

  const renderRules = () => (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <TouchableOpacity onPress={() => { setEditRule(null); setRuleForm({ rule_type: 'issue_type', issue_type_id: '', apartment_code: '', assigned_employee_id: '', priority: '0' }); setRuleOpen(true); }}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#2563EB', borderRadius: 10, padding: 11, marginBottom: 14 }}>
        <Ionicons name="add" size={16} color="#fff" />
        <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>Add Rule</Text>
      </TouchableOpacity>

      {rules.length === 0 ? (
        <Card><Text style={{ color: colors.textTertiary, textAlign: 'center', paddingVertical: 20 }}>No assignment rules configured</Text></Card>
      ) : rules.map((r: any) => {
        const member = teamMembers.find((m: any) => m.id === r.assigned_employee_id);
        const it = issueTypes.find((i: any) => i.id === r.issue_type_id);
        return (
          <Card key={r.id} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', gap: 6, marginBottom: 4 }}>
                  <View style={{ backgroundColor: '#EFF6FF', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#2563EB' }}>{r.rule_type === 'issue_type' ? 'Issue' : 'Apartment'}</Text>
                  </View>
                  <View style={{ backgroundColor: '#F1F5F9', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <Text style={{ fontSize: 10, color: colors.textTertiary }}>Priority {r.priority}</Text>
                  </View>
                </View>
                <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>
                  {r.rule_type === 'issue_type' ? (it?.name || 'Unknown issue type') : `Apartment ${r.apartment_code}`}
                </Text>
                <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                  → {member ? `${member.first_name || ''} ${member.last_name || ''}`.trim() : 'Unknown member'}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity onPress={() => { setEditRule(r); setRuleForm({ rule_type: r.rule_type, issue_type_id: r.issue_type_id || '', apartment_code: r.apartment_code || '', assigned_employee_id: r.assigned_employee_id || '', priority: String(r.priority || 0) }); setRuleOpen(true); }}>
                  <Ionicons name="pencil-outline" size={18} color="#2563EB" />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => Alert.alert('Delete Rule', 'Delete this assignment rule?', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: async () => {
                    try { await call('deleteAssignmentRule', { id: r.id }); loadTab('rules'); }
                    catch (e: any) { Alert.alert('Error', e.message); }
                  }},
                ])}>
                  <Ionicons name="trash-outline" size={18} color="#DC2626" />
                </TouchableOpacity>
              </View>
            </View>
          </Card>
        );
      })}
    </ScrollView>
  );

  const renderBedTypes = () => (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <TouchableOpacity onPress={() => { setBedTypeName(''); setBedTypeOpen(true); }}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#2563EB', borderRadius: 10, padding: 11, marginBottom: 14 }}>
        <Ionicons name="add" size={16} color="#fff" />
        <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>Add Bed Type</Text>
      </TouchableOpacity>
      {bedTypes.length === 0 && (
        <Card><Text style={{ fontSize: 12, color: colors.textTertiary, textAlign: 'center', paddingVertical: 12 }}>No custom bed types. Default types (Executive, Single, Double, Triple, Quad) are used.</Text></Card>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {bedTypes.map((bt: any) => (
          <View key={bt.id} style={{ backgroundColor: colors.surface, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#EEF1F6', minWidth: 120, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <View>
              <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>{bt.name}</Text>
              <Text style={{ fontSize: 10, color: colors.textTertiary }}>Order: {bt.sort_order}</Text>
            </View>
            <TouchableOpacity onPress={() => Alert.alert('Delete', `Delete "${bt.name}"?`, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: async () => {
                try { await call('deleteBedType', { id: bt.id }); loadTab('bed_types'); }
                catch (e: any) { Alert.alert('Error', e.message); }
              }},
            ])}>
              <Ionicons name="trash-outline" size={16} color="#DC2626" />
            </TouchableOpacity>
          </View>
        ))}
      </View>
    </ScrollView>
  );

  const renderBankAccounts = () => (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <TouchableOpacity onPress={() => { setEditBank(null); setBankForm({ bank_name: '', account_number: '', account_holder: '', ifsc: '', branch: '', is_primary: false }); setBankOpen(true); }}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#2563EB', borderRadius: 10, padding: 11, marginBottom: 14 }}>
        <Ionicons name="add" size={16} color="#fff" />
        <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>Add Bank Account</Text>
      </TouchableOpacity>
      {bankAccounts.map((acc: any) => (
        <Card key={acc.id} style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>{acc.bank_name}</Text>
                {acc.is_primary && <View style={{ backgroundColor: '#EFF6FF', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}><Text style={{ fontSize: 9, fontWeight: '700', color: '#2563EB' }}>PRIMARY</Text></View>}
              </View>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>••••{String(acc.account_number || '').slice(-4)}</Text>
              {acc.account_holder && <Text style={{ fontSize: 12, color: colors.textSecondary }}>{acc.account_holder}</Text>}
              {acc.ifsc && <Text style={{ fontSize: 11, color: colors.textTertiary }}>{acc.ifsc}</Text>}
            </View>
            <View style={{ flexDirection: 'row', gap: 14 }}>
              <TouchableOpacity onPress={() => { setEditBank(acc); setBankForm({ bank_name: acc.bank_name || '', account_number: acc.account_number || '', account_holder: acc.account_holder || '', ifsc: acc.ifsc || '', branch: acc.branch || '', is_primary: acc.is_primary || false }); setBankOpen(true); }}>
                <Ionicons name="pencil-outline" size={18} color="#2563EB" />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => {
                Alert.alert('Delete Bank Account', `Delete "${acc.bank_name}" (••••${String(acc.account_number || '').slice(-4)})?`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: async () => {
                    try { await call('deleteBankAccount', { id: acc.id }); loadTab('bank_accounts'); }
                    catch (e: any) { Alert.alert('Error', e.message); }
                  } },
                ]);
              }}>
                <Ionicons name="trash-outline" size={18} color="#DC2626" />
              </TouchableOpacity>
            </View>
          </View>
        </Card>
      ))}
    </ScrollView>
  );

  const renderFinancial = () => (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Card>
        <Text style={S.cardTitle}>Lifecycle Financial Constants</Text>
        <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 12 }}>Used in booking/onboarding/exit and credit-card charge calculations.</Text>
        <TInput label="Onboarding Charges (₹)" value={finForm.onboarding_fee} onChangeText={(v: string) => setFinForm(f => ({ ...f, onboarding_fee: v }))} keyboardType="numeric" />
        <TInput label="Exit Charges <1yr (₹)" value={finForm.exit_fee_under_1yr} onChangeText={(v: string) => setFinForm(f => ({ ...f, exit_fee_under_1yr: v }))} keyboardType="numeric" />
        <TInput label="Advance Ratio (Months)" value={finForm.advance_ratio} onChangeText={(v: string) => setFinForm(f => ({ ...f, advance_ratio: v }))} keyboardType="decimal-pad" />
        <TInput label="Key Loss Fee (₹)" value={finForm.key_loss_fee} onChangeText={(v: string) => setFinForm(f => ({ ...f, key_loss_fee: v }))} keyboardType="numeric" />
        <TInput label="Credit Card Charges (%)" value={finForm.cc_charge_percent} onChangeText={(v: string) => setFinForm(f => ({ ...f, cc_charge_percent: v }))} keyboardType="decimal-pad" />
      </Card>
      <Card>
        <Text style={S.cardTitle}>GST Settings</Text>
        <TInput label="GST Exemption Threshold (Days)" value={finForm.gst_exemption_days} onChangeText={(v: string) => setFinForm(f => ({ ...f, gst_exemption_days: v }))} keyboardType="numeric" />
        <TInput label="GST Rate for Short Stay (%)" value={finForm.gst_short_stay_rate} onChangeText={(v: string) => setFinForm(f => ({ ...f, gst_short_stay_rate: v }))} keyboardType="decimal-pad" />
        <TInput label="RCM GST Rate (%)" value={finForm.gst_rcm_rate} onChangeText={(v: string) => setFinForm(f => ({ ...f, gst_rcm_rate: v }))} keyboardType="decimal-pad" />
        <TInput label="GST-Applicable Minimum Rent (₹)" value={finForm.gst_applicable_minimum_rent} onChangeText={(v: string) => setFinForm(f => ({ ...f, gst_applicable_minimum_rent: v }))} keyboardType="numeric" />
      </Card>
      <SaveBtn loading={loading} label="Save Financial Constants" onPress={async () => {
        setLoading(true);
        try {
          await call('saveLifecycleConfig', { data: { id: lifecycleId, ...Object.fromEntries(Object.entries(finForm).map(([k, v]) => [k, Number(v)])) } });
          Alert.alert('Saved', 'Financial constants updated.');
        } catch (e: any) { Alert.alert('Error', e.message); }
        setLoading(false);
      }} />
    </ScrollView>
  );

  const renderExitProcess = () => (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Ionicons name="log-out-outline" size={18} color="#2563EB" />
          <Text style={S.cardTitle}>Pre-Exit Task Auto-Assignment</Text>
        </View>
        <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 14, lineHeight: 18 }}>
          Defines who receives pre-exit tasks. The system assigns to Person 1 first. If Person 1 has 3+ pending tasks, the task goes to Person 2. Tasks are auto-created at 9:00 AM the day before the tenant's exit date.
        </Text>
        <SL text="Primary Assignee (Person 1) *" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {exitMembers.map((m: any) => {
              const name = `${m.first_name || ''} ${m.last_name || ''}`.trim();
              const uid = m.user_id || m.id;
              const active = exitForm.exit_task_assignee_1 === uid;
              return (
                <TouchableOpacity key={m.id} onPress={() => setExitForm(f => ({ ...f, exit_task_assignee_1: uid }))}
                  style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99, backgroundColor: active ? '#2563EB' : colors.surface, borderWidth: 1, borderColor: active ? '#2563EB' : '#EEF1F6' }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : colors.textSecondary }}>{name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>
        <Text style={{ fontSize: 11, color: colors.textTertiary, marginBottom: 14 }}>Gets exit tasks by default</Text>
        <SL text="Secondary Assignee (Person 2, optional)" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity onPress={() => setExitForm(f => ({ ...f, exit_task_assignee_2: '' }))}
              style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99, backgroundColor: !exitForm.exit_task_assignee_2 ? '#2563EB' : colors.surface, borderWidth: 1, borderColor: !exitForm.exit_task_assignee_2 ? '#2563EB' : '#EEF1F6' }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: !exitForm.exit_task_assignee_2 ? '#fff' : colors.textSecondary }}>None</Text>
            </TouchableOpacity>
            {exitMembers.map((m: any) => {
              const name = `${m.first_name || ''} ${m.last_name || ''}`.trim();
              const uid = m.user_id || m.id;
              const active = exitForm.exit_task_assignee_2 === uid;
              return (
                <TouchableOpacity key={m.id} onPress={() => setExitForm(f => ({ ...f, exit_task_assignee_2: uid }))}
                  style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99, backgroundColor: active ? '#2563EB' : colors.surface, borderWidth: 1, borderColor: active ? '#2563EB' : '#EEF1F6' }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : colors.textSecondary }}>{name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>
        <Text style={{ fontSize: 11, color: colors.textTertiary, marginBottom: 14 }}>Gets overflow tasks when Person 1 is busy</Text>
        <SaveBtn loading={loading} label="Save Exit Settings" onPress={async () => {
          setLoading(true);
          try {
            await call('saveOrgExitSettings', { data: exitForm });
            Alert.alert('Saved', 'Exit process settings updated.');
          } catch (e: any) { Alert.alert('Error', e.message); }
          setLoading(false);
        }} />
      </Card>
    </ScrollView>
  );

  const renderAutoApproval = () => (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <Ionicons name="flash" size={18} color="#D97706" />
          <Text style={S.cardTitle}>Ticket Auto-Approval Settings</Text>
        </View>
        <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 16, lineHeight: 18 }}>
          Controls when ticket cost estimates are auto-approved without admin intervention. Employees do not see whether an approval was automatic or manual.
        </Text>

        <SL text="Auto-Approve Threshold (₹)" />
        <Text style={{ fontSize: 11, color: colors.textTertiary, marginBottom: 8 }}>Tickets with total cost ≤ this amount are automatically approved. Set to 0 to disable.</Text>
        <TInput value={autoForm.ticket_auto_approve_threshold} onChangeText={(v: string) => setAutoForm(f => ({ ...f, ticket_auto_approve_threshold: v }))} keyboardType="numeric" placeholder="e.g. 1000" />
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          {[500, 1000, 1500, 2000].map(p => (
            <TouchableOpacity key={p} onPress={() => setAutoForm(f => ({ ...f, ticket_auto_approve_threshold: String(p) }))}
              style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: autoForm.ticket_auto_approve_threshold === String(p) ? '#2563EB' : colors.surface, borderWidth: 1, borderColor: '#EEF1F6' }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: autoForm.ticket_auto_approve_threshold === String(p) ? '#fff' : colors.textSecondary }}>₹{p.toLocaleString('en-IN')}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <SL text="Repeat Job Check Window (days)" />
        <Text style={{ fontSize: 11, color: colors.textTertiary, marginBottom: 8 }}>If the same issue was resolved in the same apartment within this many days, auto-approval is blocked and a repeat-job alert is raised.</Text>
        <TInput value={autoForm.ticket_repeat_check_days} onChangeText={(v: string) => setAutoForm(f => ({ ...f, ticket_repeat_check_days: v }))} keyboardType="numeric" placeholder="e.g. 30" />
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          {[14, 30, 60, 90].map(p => (
            <TouchableOpacity key={p} onPress={() => setAutoForm(f => ({ ...f, ticket_repeat_check_days: String(p) }))}
              style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: autoForm.ticket_repeat_check_days === String(p) ? '#2563EB' : colors.surface, borderWidth: 1, borderColor: '#EEF1F6' }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: autoForm.ticket_repeat_check_days === String(p) ? '#fff' : colors.textSecondary }}>{p}d</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ backgroundColor: '#F8FAFC', borderRadius: 10, padding: 12, marginBottom: 14 }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: colors.text, marginBottom: 6 }}>How it works:</Text>
          {[
            'Tickets with no cost estimates → auto-completed immediately',
            `Cost ≤ ₹${autoForm.ticket_auto_approve_threshold} AND not a repeat job → auto-approved`,
            `Same issue in same apartment within ${autoForm.ticket_repeat_check_days} days → manual review required`,
            'Cost over threshold → normal manual approval flow',
          ].map((txt, i) => <Text key={i} style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 3 }}>• {txt}</Text>)}
        </View>

        <SaveBtn loading={loading} label="Save Auto-Approval Settings" onPress={async () => {
          setLoading(true);
          try {
            await call('saveOrgExitSettings', { data: { ticket_auto_approve_threshold: parseFloat(autoForm.ticket_auto_approve_threshold), ticket_repeat_check_days: parseInt(autoForm.ticket_repeat_check_days) } });
            Alert.alert('Saved', 'Auto-approval settings updated.');
          } catch (e: any) { Alert.alert('Error', e.message); }
          setLoading(false);
        }} />
      </Card>
    </ScrollView>
  );

  const renderMaintenance = () => (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <TouchableOpacity onPress={() => { setMaintForm({ name: '', unit: '', description: '' }); setMaintOpen(true); }}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#2563EB', borderRadius: 10, padding: 11, marginBottom: 14 }}>
        <Ionicons name="add" size={16} color="#fff" />
        <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>Add Maintenance Item</Text>
      </TouchableOpacity>
      {maintItems.length === 0 ? (
        <Card><Text style={{ color: colors.textTertiary, textAlign: 'center', paddingVertical: 20 }}>No maintenance items defined</Text></Card>
      ) : maintItems.map((item: any) => (
        <Card key={item.id} style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>{item.name}</Text>
              {item.unit && <Text style={{ fontSize: 11, color: colors.textSecondary }}>Unit: {item.unit}</Text>}
              {item.description && <Text style={{ fontSize: 11, color: colors.textTertiary }}>{item.description}</Text>}
            </View>
            <TouchableOpacity onPress={() => Alert.alert('Delete', `Delete "${item.name}"?`, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: async () => {
                try { await call('deleteMaintenanceItem', { id: item.id }); loadTab('maintenance'); }
                catch (e: any) { Alert.alert('Error', e.message); }
              }},
            ])}>
              <Ionicons name="trash-outline" size={18} color="#DC2626" />
            </TouchableOpacity>
          </View>
        </Card>
      ))}
    </ScrollView>
  );

  // ─── TAB CONTENT ROUTER ───────────────────────────────────────────────────
  const renderContent = () => {
    if (loading && ['permissions', 'roles', 'rules'].includes(activeTab)) {
      return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color="#2563EB" size="large" /></View>;
    }
    switch (activeTab) {
      case 'organization':  return renderOrganization();
      case 'roles':         return renderRoles();
      case 'permissions':   return renderPermissions();
      case 'rules':         return renderRules();
      case 'bed_types':     return renderBedTypes();
      case 'bank_accounts': return renderBankAccounts();
      case 'financial':     return renderFinancial();
      case 'exit_process':  return renderExitProcess();
      case 'auto_approval': return renderAutoApproval();
      case 'maintenance':   return renderMaintenance();
      default: return null;
    }
  };

  // ── Account identity + sign-out footer (reference-parity) ──────────────────
  const acctName = user?.userName?.trim() || 'Account';
  const acctInitials = acctName.split(/\s+/).map((p: string) => p[0]).join('').slice(0, 2).toUpperCase() || 'A';
  const acctRoleLabel = ROLE_LABELS[user?.role || ''] || 'Admin Account';
  const acctOrgSub = orgForm.organization_name?.trim() || '';
  const acctPhone = user?.phone
    ? (user.phone.startsWith('+') ? user.phone : `+91 ${user.phone}`)
    : '';
  // Clear both the floating nav rail and the AI FAB (56px @ bottom:28 → top ~84).
  const railClearance = 96 + Math.max(insets.bottom, 10);

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#E2E8F0' }}>
          <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center', marginRight: 10 }}>
            <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 }}>Settings</Text>
            <Text style={{ fontSize: 13, color: '#64748B', fontWeight: '500', marginTop: 2 }}>Profile, appearance, access, org defaults</Text>
          </View>
        </View>

        {/* Account identity card (reference parity) */}
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#EEF1F6', padding: 14, shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
            <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: '#4F46E5', alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: '#fff', fontWeight: '800', fontSize: 16 }}>{acctInitials}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: '#0F172A' }} numberOfLines={1}>{acctName}</Text>
              {acctOrgSub ? (
                <Text style={{ fontSize: 12, color: '#64748B', marginTop: 1 }} numberOfLines={1}>{acctOrgSub}</Text>
              ) : null}
              <View style={{ alignSelf: 'flex-start', marginTop: 6, backgroundColor: '#EEF0FF', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
                <Text style={{ fontSize: 11, fontWeight: '800', color: '#4F46E5' }}>{acctRoleLabel}</Text>
              </View>
            </View>
          </View>
        </View>

        {/* Plan / workspace usage card (reference parity) — real counts */}
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <LinearGradient
            colors={['#2563EB', '#4F46E5'] as const}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <View style={{ flex: 1, minWidth: 0, paddingRight: 12 }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: '#FFFFFF' }}>Growth Plan</Text>
              <Text style={{ fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.82)', marginTop: 3 }} numberOfLines={2}>
                {orgStats
                  ? `${orgStats.beds} bed${orgStats.beds === 1 ? '' : 's'} · ${orgStats.properties} propert${orgStats.properties === 1 ? 'y' : 'ies'} · ${orgStats.team} team member${orgStats.team === 1 ? '' : 's'}`
                  : 'Loading usage…'}
              </Text>
            </View>
            <View style={{ backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
              <Text style={{ fontSize: 12, fontWeight: '800', color: '#FFFFFF', letterSpacing: 0.5 }}>GROWTH</Text>
            </View>
          </LinearGradient>
        </View>

        {/* Tab bar (horizontal scroll) */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, flexShrink: 0, borderBottomWidth: 1, borderBottomColor: '#E2E8F0' }}
          contentContainerStyle={{ flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, gap: 8, alignItems: 'center' }}
        >
          {TABS.map(tab => {
            const active = activeTab === tab.key;
            return (
              <TouchableOpacity key={tab.key} onPress={() => setActiveTab(tab.key)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: active ? '#2563EB' : '#F1F3F9', borderWidth: 1, borderColor: active ? '#2563EB' : '#F1F3F9' }}>
                <Ionicons name={tab.icon as any} size={14} color={active ? '#fff' : '#64748B'} />
                <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>{tab.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Content */}
        <View style={{ flex: 1 }}>{renderContent()}</View>

        {/* Signed-in / Sign out footer (reference parity) — lifted above the floating nav */}
        <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: railClearance, borderTopWidth: 1, borderTopColor: '#EEF1F6', backgroundColor: '#FFFFFF' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#EEF1F6', paddingHorizontal: 14, paddingVertical: 12, shadowColor: '#0F172A', shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: '#94A3B8', letterSpacing: 0.3 }}>Signed in</Text>
              {acctPhone ? (
                <Text style={{ fontSize: 15, fontWeight: '800', color: '#0F172A', marginTop: 2 }} numberOfLines={1}>{acctPhone}</Text>
              ) : (
                <Text style={{ fontSize: 15, fontWeight: '800', color: '#0F172A', marginTop: 2 }} numberOfLines={1}>{acctName}</Text>
              )}
            </View>
            <TouchableOpacity
              onPress={confirmSignOut}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Sign out"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 12, borderWidth: 1, borderColor: '#EEF1F6', backgroundColor: '#FFFFFF', paddingHorizontal: 14, paddingVertical: 9 }}
            >
              <Ionicons name="log-out-outline" size={16} color="#0F172A" />
              <Text style={{ fontSize: 13, fontWeight: '800', color: '#0F172A' }}>Sign out</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Assign Role Modal ─────────────────────────────────────────────── */}
        <Modal visible={assignOpen} animationType="slide" presentationStyle="pageSheet">
          <GlassBackground>
            <SafeAreaView style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
                <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text }}>Assign Role</Text>
                <TouchableOpacity onPress={() => setAssignOpen(false)}><Ionicons name="close-circle" size={26} color={colors.textTertiary} /></TouchableOpacity>
              </View>
              <ScrollView style={{ padding: 20 }}>
                <SL text="Team Member" />
                <ScrollView style={{ maxHeight: 200, borderWidth: 1, borderColor: '#EEF1F6', borderRadius: 10, backgroundColor: colors.surface, marginBottom: 14 }}>
                  {teamMembers.map((m: any, idx: number) => {
                    const name = `${m.first_name || ''} ${m.last_name || ''}`.trim();
                    const active = assignMember === m.id;
                    return (
                      <TouchableOpacity key={m.id} onPress={() => setAssignMember(m.id)}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderTopWidth: idx > 0 ? 0.5 : 0, borderTopColor: '#EEF1F6', backgroundColor: active ? '#EFF6FF' : 'transparent' }}>
                        <Ionicons name={active ? 'checkmark-circle' : 'radio-button-off-outline'} size={16} color={active ? '#2563EB' : colors.textTertiary} />
                        <Text style={{ fontSize: 14, color: colors.text }}>{name}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
                <SL text="Role" />
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                  {ROLE_KEYS.map(role => {
                    const active = assignRole === role;
                    return (
                      <TouchableOpacity key={role} onPress={() => setAssignRole(role)}
                        style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99, backgroundColor: active ? (ROLE_COLORS[role] || '#2563EB') : colors.surface, borderWidth: 1, borderColor: active ? (ROLE_COLORS[role] || '#2563EB') : '#EEF1F6' }}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : colors.textSecondary }}>{ROLE_LABELS[role]}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <SaveBtn label="Assign Role" loading={loading} onPress={async () => {
                  if (!assignMember || !assignRole) { Alert.alert('Required', 'Select a team member and role.'); return; }
                  setLoading(true);
                  try {
                    const member = teamMembers.find((m: any) => m.id === assignMember);
                    let profileId = orgProfiles.find((p: any) => p.id === member?.user_id || p.email === member?.email || p.phone === member?.phone)?.id;
                    if (!profileId) { Alert.alert('Not linked', 'The team member must log in first to create a user account.'); setLoading(false); return; }
                    await call('assignUserRole', { user_id: profileId, role: assignRole });
                    setAssignOpen(false); loadTab('roles');
                    Alert.alert('Done', 'Role assigned successfully.');
                  } catch (e: any) { Alert.alert('Error', e.message); }
                  setLoading(false);
                }} />
              </ScrollView>
            </SafeAreaView>
          </GlassBackground>
        </Modal>

        {/* ── Add/Edit Rule Modal ───────────────────────────────────────────── */}
        <Modal visible={ruleOpen} animationType="slide" presentationStyle="pageSheet">
          <GlassBackground>
            <SafeAreaView style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
                <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text }}>{editRule ? 'Edit Rule' : 'Add Rule'}</Text>
                <TouchableOpacity onPress={() => setRuleOpen(false)}><Ionicons name="close-circle" size={26} color={colors.textTertiary} /></TouchableOpacity>
              </View>
              <ScrollView style={{ padding: 20 }}>
                <SL text="Rule Type" />
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                  {[{ key: 'issue_type', label: 'Issue-specific' }, { key: 'apartment', label: 'Apartment-based' }].map(rt => (
                    <TouchableOpacity key={rt.key} onPress={() => setRuleForm(f => ({ ...f, rule_type: rt.key }))}
                      style={{ flex: 1, padding: 10, borderRadius: 10, alignItems: 'center', backgroundColor: ruleForm.rule_type === rt.key ? '#2563EB' : colors.surface, borderWidth: 1, borderColor: ruleForm.rule_type === rt.key ? '#2563EB' : '#EEF1F6' }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: ruleForm.rule_type === rt.key ? '#fff' : colors.textSecondary }}>{rt.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {ruleForm.rule_type === 'issue_type' && (
                  <>
                    <SL text="Issue Type" />
                    <ScrollView style={{ maxHeight: 150, borderWidth: 1, borderColor: '#EEF1F6', borderRadius: 10, backgroundColor: colors.surface, marginBottom: 14 }}>
                      {issueTypes.map((it: any, idx: number) => {
                        const active = ruleForm.issue_type_id === it.id;
                        return (
                          <TouchableOpacity key={it.id} onPress={() => setRuleForm(f => ({ ...f, issue_type_id: it.id }))}
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderTopWidth: idx > 0 ? 0.5 : 0, borderTopColor: '#EEF1F6', backgroundColor: active ? '#EFF6FF' : 'transparent' }}>
                            <Ionicons name={active ? 'checkmark-circle' : 'radio-button-off-outline'} size={16} color={active ? '#2563EB' : colors.textTertiary} />
                            <Text style={{ fontSize: 13, color: colors.text }}>{it.name}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </>
                )}
                {ruleForm.rule_type === 'apartment' && (
                  <TInput label="Apartment Code" value={ruleForm.apartment_code} onChangeText={(v: string) => setRuleForm(f => ({ ...f, apartment_code: v }))} placeholder="e.g. A-101" />
                )}
                <SL text="Assign To" />
                <ScrollView style={{ maxHeight: 150, borderWidth: 1, borderColor: '#EEF1F6', borderRadius: 10, backgroundColor: colors.surface, marginBottom: 14 }}>
                  {teamMembers.map((m: any, idx: number) => {
                    const name = `${m.first_name || ''} ${m.last_name || ''}`.trim();
                    const active = ruleForm.assigned_employee_id === m.id;
                    return (
                      <TouchableOpacity key={m.id} onPress={() => setRuleForm(f => ({ ...f, assigned_employee_id: m.id }))}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderTopWidth: idx > 0 ? 0.5 : 0, borderTopColor: '#EEF1F6', backgroundColor: active ? '#EFF6FF' : 'transparent' }}>
                        <Ionicons name={active ? 'checkmark-circle' : 'radio-button-off-outline'} size={16} color={active ? '#2563EB' : colors.textTertiary} />
                        <Text style={{ fontSize: 13, color: colors.text }}>{name}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
                <TInput label="Priority (lower = higher priority)" value={ruleForm.priority} onChangeText={(v: string) => setRuleForm(f => ({ ...f, priority: v }))} keyboardType="numeric" placeholder="0" />
                <SaveBtn label={editRule ? 'Update Rule' : 'Add Rule'} loading={loading} onPress={async () => {
                  if (!ruleForm.assigned_employee_id) { Alert.alert('Required', 'Select a team member.'); return; }
                  setLoading(true);
                  try {
                    if (editRule) { await call('updateAssignmentRule', { id: editRule.id, data: { ...ruleForm, priority: parseInt(ruleForm.priority) } }); }
                    else { await call('createAssignmentRule', { data: { ...ruleForm, priority: parseInt(ruleForm.priority) } }); }
                    setRuleOpen(false); loadTab('rules');
                    Alert.alert('Saved', 'Assignment rule saved.');
                  } catch (e: any) { Alert.alert('Error', e.message); }
                  setLoading(false);
                }} />
              </ScrollView>
            </SafeAreaView>
          </GlassBackground>
        </Modal>

        {/* ── Add Bed Type Modal ────────────────────────────────────────────── */}
        <Modal visible={bedTypeOpen} animationType="slide" presentationStyle="pageSheet">
          <GlassBackground>
            <SafeAreaView style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
                <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text }}>Add Bed Type</Text>
                <TouchableOpacity onPress={() => setBedTypeOpen(false)}><Ionicons name="close-circle" size={26} color={colors.textTertiary} /></TouchableOpacity>
              </View>
              <View style={{ padding: 20 }}>
                <TInput label="Bed Type Name *" value={bedTypeName} onChangeText={setBedTypeName} placeholder="e.g. Executive" />
                <SaveBtn label="Add Bed Type" loading={loading} onPress={async () => {
                  if (!bedTypeName.trim()) { Alert.alert('Required', 'Enter a bed type name.'); return; }
                  setLoading(true);
                  try {
                    await call('createBedType', { name: bedTypeName.trim(), sort_order: bedTypes.length });
                    setBedTypeOpen(false); setBedTypeName(''); loadTab('bed_types');
                    Alert.alert('Added', 'Bed type created.');
                  } catch (e: any) { Alert.alert('Error', e.message); }
                  setLoading(false);
                }} />
              </View>
            </SafeAreaView>
          </GlassBackground>
        </Modal>

        {/* ── Add/Edit Bank Account Modal ───────────────────────────────────── */}
        <Modal visible={bankOpen} animationType="slide" presentationStyle="pageSheet">
          <GlassBackground>
            <SafeAreaView style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
                <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text }}>{editBank ? 'Edit Bank Account' : 'Add Bank Account'}</Text>
                <TouchableOpacity onPress={() => setBankOpen(false)}><Ionicons name="close-circle" size={26} color={colors.textTertiary} /></TouchableOpacity>
              </View>
              <ScrollView style={{ padding: 20 }}>
                <TInput label="Bank Name *" value={bankForm.bank_name} onChangeText={(v: string) => setBankForm(f => ({ ...f, bank_name: v }))} placeholder="e.g. HDFC Bank" />
                <TInput label="Account Number *" value={bankForm.account_number} onChangeText={(v: string) => setBankForm(f => ({ ...f, account_number: v }))} placeholder="Account number" keyboardType="number-pad" />
                <TInput label="Account Holder Name *" value={bankForm.account_holder} onChangeText={(v: string) => setBankForm(f => ({ ...f, account_holder: v }))} placeholder="Name on account" />
                <TInput label="IFSC Code" value={bankForm.ifsc} onChangeText={(v: string) => setBankForm(f => ({ ...f, ifsc: v.toUpperCase() }))} placeholder="e.g. HDFC0001234" autoCapitalize="characters" />
                <TInput label="Branch" value={bankForm.branch} onChangeText={(v: string) => setBankForm(f => ({ ...f, branch: v }))} placeholder="Branch name" />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                  <Switch value={bankForm.is_primary} onValueChange={(v) => setBankForm(f => ({ ...f, is_primary: v }))} trackColor={{ true: '#2563EB' }} thumbColor="#fff" />
                  <Text style={{ fontSize: 14, color: colors.text }}>Set as primary account</Text>
                </View>
                <SaveBtn label={editBank ? 'Update Account' : 'Add Account'} loading={loading} onPress={async () => {
                  if (!bankForm.bank_name || !bankForm.account_number) { Alert.alert('Required', 'Bank name and account number are required.'); return; }
                  setLoading(true);
                  try {
                    if (editBank) { await call('updateBankAccount', { id: editBank.id, data: bankForm }); }
                    else { await call('createBankAccount', { data: bankForm }); }
                    setBankOpen(false); loadTab('bank_accounts');
                    Alert.alert('Saved', 'Bank account saved.');
                  } catch (e: any) { Alert.alert('Error', e.message); }
                  setLoading(false);
                }} />
              </ScrollView>
            </SafeAreaView>
          </GlassBackground>
        </Modal>

        {/* ── Add Maintenance Item Modal ────────────────────────────────────── */}
        <Modal visible={maintOpen} animationType="slide" presentationStyle="pageSheet">
          <GlassBackground>
            <SafeAreaView style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' }}>
                <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text }}>Add Maintenance Item</Text>
                <TouchableOpacity onPress={() => setMaintOpen(false)}><Ionicons name="close-circle" size={26} color={colors.textTertiary} /></TouchableOpacity>
              </View>
              <View style={{ padding: 20 }}>
                <TInput label="Item Name *" value={maintForm.name} onChangeText={(v: string) => setMaintForm(f => ({ ...f, name: v }))} placeholder="e.g. PVC Pipe" />
                <TInput label="Unit (e.g. pcs, mtr, kg)" value={maintForm.unit} onChangeText={(v: string) => setMaintForm(f => ({ ...f, unit: v }))} placeholder="pcs" />
                <TInput label="Description" value={maintForm.description} onChangeText={(v: string) => setMaintForm(f => ({ ...f, description: v }))} placeholder="Optional description" multiline />
                <SaveBtn label="Add Item" loading={loading} onPress={async () => {
                  if (!maintForm.name.trim()) { Alert.alert('Required', 'Enter item name.'); return; }
                  setLoading(true);
                  try {
                    await call('createMaintenanceItem', { data: maintForm });
                    setMaintOpen(false); setMaintForm({ name: '', unit: '', description: '' }); loadTab('maintenance');
                    Alert.alert('Added', 'Maintenance item added.');
                  } catch (e: any) { Alert.alert('Error', e.message); }
                  setLoading(false);
                }} />
              </View>
            </SafeAreaView>
          </GlassBackground>
        </Modal>

      </SafeAreaView>
    </GlassBackground>
  );
}

const S = StyleSheet.create({
  cardTitle: { fontSize: 17, fontWeight: '800', color: '#0F172A', marginBottom: 10 },
  permCard: { backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#EEF1F6', marginBottom: 8, overflow: 'hidden' },
});
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Modal, Alert, RefreshControl, TextInput, Image, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { Button, Input, EmptyState, LoadingScreen, GlassBackground, DateField, IconBtnSolid, SearchField } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { Ionicons } from '@expo/vector-icons';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import { useMountedRef, isAbortError } from '../lib/safeAsync';
import { generateAndSharePayslip } from '../lib/payslipPdf';
import { recentPayrollMonths, payrollMonthKey, payrollPeriodLabel } from '../lib/payroll';
import {
  teamKpis, computeMemberRows, orgRollup, daySnapshot, needsAttention,
  calendarHeat, heatDominant, summarizeWorkHours, memberMonthRows,
  memberMonthSummary, monthKey, toYmd, type DayHeat, type MemberDashRow,
} from '../lib/teamAttendanceDashboard';

// ─── Constants ────────────────────────────────────────────────────────────────
const SPECIALIZATIONS = [
  'Technician', 'Plumbing', 'IT Support', 'Application Tech',
  'Housekeeping', 'Software', 'AC Technician', 'Electrician', 'Security',
];

const ROLES = [
  { label: 'Technician', value: 'technician' },
  { label: 'Property Manager', value: 'property_manager' },
  { label: 'Admin', value: 'admin' },
];

const DEPARTMENTS = ['Maintenance', 'Management', 'Support', 'Security', 'Housekeeping', 'IT'];

const EMPTY_FORM = {
  first_name: '', last_name: '', phone: '', email: '', gender: '',
  designation: '', department: '', joining_date: '', salary_amount: '',
  id_proof_type: '', id_proof_number: '',
  pan_number: '', aadhar_number: '',
  address: '', city: '', state: '',
  bank_name: '', bank_account_number: '', bank_ifsc: '',
  emergency_contact_name: '', emergency_contact_phone: '',
  status: 'active',
};

const EMPTY_PAYMENT = {
  payment_type: 'salary', amount: '', payment_date: '', payment_month: '',
  payment_mode: 'bank_transfer', notes: '',
};

const EMPTY_ATTENDANCE = {
  date: '', status: 'present', check_in: '', check_out: '', notes: '',
};

const EMPTY_EXIT = { exit_date: '', exit_type: 'resigned', exit_reason: '' };

const EXIT_TYPES = [
  { label: 'Resigned', value: 'resigned' },
  { label: 'Terminated', value: 'terminated' },
  { label: 'Retired', value: 'retired' },
  { label: 'Contract Ended', value: 'contract_ended' },
  { label: 'Other', value: 'other' },
];

const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  active:   { color: '#16a34a', bg: '#dcfce7' },
  inactive: { color: '#dc2626', bg: '#fee2e2' },
  on_leave: { color: '#ea580c', bg: '#ffedd5' },
};

// ─── Main Screen ─────────────────────────────────────────────────────────────
export default function TeamScreen() {
  const { token } = useAuth();
  const nav = useNavigation();
  const mounted = useMountedRef();

  const [members, setMembers]       = useState<any[] | null>(null);
  const [payments, setPayments]     = useState<any[]>([]);
  const [attendance, setAttendance] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [tickets, setTickets]       = useState<any[]>([]);
  const [search, setSearch]         = useState('');
  const [activeTab, setActiveTab]   = useState<'members' | 'dashboard' | 'payments' | 'salary' | 'attendance' | 'performance'>('members');
  const [salaryBills, setSalaryBills] = useState<any[]>([]);
  const [salaryLoading, setSalaryLoading] = useState(false);
  const [salaryBusy, setSalaryBusy] = useState<string | null>(null);
  const [payslipBusy, setPayslipBusy] = useState<string | null>(null);
  const [orgName, setOrgName] = useState('Vishful Spaces LLP');
  const [salaryMonth, setSalaryMonth] = useState<string>(() => payrollMonthKey(new Date()));
  const [generating, setGenerating] = useState(false);
  const salaryMonthOptions = useMemo(() => recentPayrollMonths(6), []);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading]       = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedSpecs, setSelectedSpecs] = useState<string[]>([]);
  const refresh = useCallback(() => setRefreshKey(k => k + 1), []);

  // Modals
  const [showAdd, setShowAdd]           = useState(false);
  const [showEdit, setShowEdit]         = useState(false);
  const [showPayment, setShowPayment]   = useState(false);
  const [showAttendance, setShowAttendance] = useState(false);
  const [showPaymentEdit, setShowPaymentEdit] = useState(false);
  const [editingPayment, setEditingPayment]   = useState<any>(null);
  const [showExit, setShowExit]         = useState(false);
  const [showMemberAtt, setShowMemberAtt] = useState(false);
  const [showDepartments, setShowDepartments] = useState(false);
  const [newDeptName, setNewDeptName]   = useState('');
  const [editingDeptId, setEditingDeptId] = useState<string | null>(null);
  const [editingDeptName, setEditingDeptName] = useState('');
  const [deptBusy, setDeptBusy]         = useState(false);
  const [selected, setSelected]         = useState<any>(null);
  const [form, setForm]                 = useState({ ...EMPTY_FORM });
  const [paymentForm, setPaymentForm]   = useState({ ...EMPTY_PAYMENT });
  const [attForm, setAttForm]           = useState({ ...EMPTY_ATTENDANCE });
  const [exitForm, setExitForm]         = useState({ ...EMPTY_EXIT });
  const setF   = (k: keyof typeof EMPTY_FORM) => (v: string) => setForm(p => ({ ...p, [k]: v }));
  const setPF  = (k: keyof typeof EMPTY_PAYMENT) => (v: string) => setPaymentForm(p => ({ ...p, [k]: v }));
  const setAF  = (k: keyof typeof EMPTY_ATTENDANCE) => (v: string) => setAttForm(p => ({ ...p, [k]: v }));
  const setXF  = (k: keyof typeof EMPTY_EXIT) => (v: string) => setExitForm(p => ({ ...p, [k]: v }));

  // ── Load ──
  useEffect(() => {
    if (!token) return;
    setMembers(null);
    Promise.all([
      sb.getTeamMembers(),
      sb.listTeamPayments(),
      sb.listTeamAttendance(),
      sb.listTeamDepartments().catch(() => []),
      sb.listOrgTickets().catch(() => []),
    ]).then(([m, p, a, d, t]: any) => {
      if (!mounted.current) return;
      setMembers(m ?? []);
      setPayments(p ?? []);
      setAttendance(a ?? []);
      setDepartments(Array.isArray(d) ? d : []);
      setTickets(Array.isArray(t) ? t : []);
    }).catch((e: any) => {
      if (!mounted.current || isAbortError(e)) return;
      setMembers([]); setPayments([]); setAttendance([]);
    });
  }, [token, refreshKey]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [m, p, a, d, t]: any = await Promise.all([
        sb.getTeamMembers(),
        sb.listTeamPayments().catch(() => []),
        sb.listTeamAttendance().catch(() => []),
        sb.listTeamDepartments().catch(() => []),
        sb.listOrgTickets().catch(() => []),
      ]);
      if (mounted.current) {
        setMembers(m ?? []); setPayments(p ?? []); setAttendance(a ?? []);
        setDepartments(Array.isArray(d) ? d : []);
        setTickets(Array.isArray(t) ? t : []);
      }
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  // ── Salary bills (read + draft→approved→paid status flow) ──
  const loadSalary = useCallback(async () => {
    setSalaryLoading(true);
    try {
      const bills = await sb.listSalaryBills();
      if (mounted.current) setSalaryBills(Array.isArray(bills) ? bills : []);
    } catch { if (mounted.current) setSalaryBills([]); }
    finally { if (mounted.current) setSalaryLoading(false); }
  }, []);
  useEffect(() => { if (activeTab === 'salary') loadSalary(); }, [activeTab, loadSalary]);

  // Org name for the pay-slip header — fetched once when the Salary tab opens.
  useEffect(() => {
    if (activeTab !== 'salary') return;
    let cancelled = false;
    (async () => {
      try {
        const s: any = await sb.getOrgSettings();
        if (!cancelled && mounted.current && s?.organizationName) setOrgName(String(s.organizationName));
      } catch { /* keep default */ }
    })();
    return () => { cancelled = true; };
  }, [activeTab]);

  const handleDownloadPayslip = useCallback(async (bill: any, memberName: string, designation?: string | null) => {
    setPayslipBusy(bill.id);
    try {
      await generateAndSharePayslip({
        orgName,
        employeeName: memberName,
        designation: designation || null,
        month: bill.month || '',
        presentDays: Number(bill.present_days) || 0,
        workingDays: Number(bill.working_days) || 0,
        baseSalary: Number(bill.base_salary) || 0,
        earnedSalary: Number(bill.earned_salary) || 0,
        advanceDeducted: Number(bill.advance_deducted) || 0,
        otherDeductions: Number(bill.other_deductions) || 0,
        netPayable: Number(bill.net_payable ?? bill.earned_salary) || 0,
        status: bill.status || 'draft',
      });
    } catch (e: any) {
      Alert.alert('Pay-slip', e?.message || 'Could not generate the pay-slip. Please try again.');
    } finally {
      if (mounted.current) setPayslipBusy(null);
    }
  }, [orgName]);

  const handleGenerateSalary = useCallback(async () => {
    setGenerating(true);
    try {
      const r: any = await sb.generateSalaryBills(salaryMonth);
      await loadSalary();
      const parts = [
        `Created ${r?.created ?? 0}`,
        `updated ${r?.updated ?? 0}`,
        (r?.skippedPaid ?? 0) > 0 ? `${r.skippedPaid} already paid` : null,
        (r?.failed ?? 0) > 0 ? `${r.failed} failed` : null,
      ].filter(Boolean).join(', ');
      Alert.alert('Salary drafts', (r?.membersConsidered ?? 0) === 0
        ? 'No active members with a salary set for this period.'
        : `${parts}.`);
    } catch (e: any) {
      Alert.alert('Salary drafts', e?.message || 'Could not generate salary bills. Please try again.');
    } finally {
      if (mounted.current) setGenerating(false);
    }
  }, [salaryMonth, loadSalary]);

  const handleSalaryStatus = useCallback(async (bill: any, status: string) => {
    setSalaryBusy(bill.id);
    try {
      await sb.setSalaryBillStatus(bill.id, status);
      if (mounted.current) setSalaryBills(prev => prev.map(b => b.id === bill.id ? { ...b, status } : b));
    } catch (e: any) { Alert.alert('Error', e?.message || 'Could not update status'); }
    finally { if (mounted.current) setSalaryBusy(null); }
  }, []);

  // ── Filtered ──
  const filteredMembers = (members || []).filter(m => {
    const q = search.toLowerCase();
    const fullName = `${m.first_name || ''} ${m.last_name || ''}`.trim().toLowerCase();
    return !q || fullName.includes(q) || (m.phone || '').includes(q) || (m.designation || '').toLowerCase().includes(q);
  });

  // ── Attendance analytics (pure lib) ──
  const currentMonth = monthKey();
  const kpis = useMemo(
    () => teamKpis(members || [], attendance || []),
    [members, attendance],
  );
  const dashRows = useMemo(
    () => computeMemberRows(members || [], attendance || [], currentMonth)
      .filter(r => r.rate !== null)
      .sort((a, b) => (a.rate as number) - (b.rate as number)),
    [members, attendance, currentMonth],
  );
  const rollup = useMemo(
    () => orgRollup(members || [], attendance || [], currentMonth),
    [members, attendance, currentMonth],
  );
  const todaySnap = useMemo(
    () => daySnapshot(members || [], attendance || [], toYmd(new Date())),
    [members, attendance],
  );
  const attention = useMemo(
    () => needsAttention(members || [], attendance || [], currentMonth, 5),
    [members, attendance, currentMonth],
  );

  // ── CRUD ──
  const handleAdd = async () => {
    if (!form.first_name.trim()) { Alert.alert('Validation', 'First name is required'); return; }
    if (!form.phone.trim())      { Alert.alert('Validation', 'Phone is required'); return; }
    setLoading(true);
    try {
      await sb.createTeamMember({
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim() || null,
        phone: form.phone.trim(),
        email: form.email.trim() || null,
        gender: form.gender || null,
        designation: form.designation.trim() || null,
        department: form.department || null,
        joining_date: form.joining_date || null,
        salary_amount: form.salary_amount ? parseFloat(form.salary_amount) : null,
        id_proof_type: form.id_proof_type || null,
        id_proof_number: form.id_proof_number.trim() || null,
        pan_number: form.pan_number.trim() || null,
        aadhar_number: form.aadhar_number.trim() || null,
        address: form.address.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        bank_name: form.bank_name.trim() || null,
        bank_account_number: form.bank_account_number.trim() || null,
        bank_ifsc: form.bank_ifsc.trim() || null,
        emergency_contact_name: form.emergency_contact_name.trim() || null,
        emergency_contact_phone: form.emergency_contact_phone.trim() || null,
        status: form.status,
        specialties: selectedSpecs.length > 0 ? selectedSpecs : null,
      });
      setShowAdd(false);
      setForm({ ...EMPTY_FORM });
      setSelectedSpecs([]);
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to add team member');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = async () => {
    if (!selected) return;
    setLoading(true);
    try {
      await sb.updateTeamMember(selected.id, {
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim() || null,
        phone: form.phone.trim(),
        email: form.email.trim() || null,
        gender: form.gender || null,
        designation: form.designation.trim() || null,
        department: form.department || null,
        joining_date: form.joining_date || null,
        salary_amount: form.salary_amount ? parseFloat(form.salary_amount) : null,
        id_proof_type: form.id_proof_type || null,
        id_proof_number: form.id_proof_number.trim() || null,
        pan_number: form.pan_number.trim() || null,
        aadhar_number: form.aadhar_number.trim() || null,
        address: form.address.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        bank_name: form.bank_name.trim() || null,
        bank_account_number: form.bank_account_number.trim() || null,
        bank_ifsc: form.bank_ifsc.trim() || null,
        emergency_contact_name: form.emergency_contact_name.trim() || null,
        emergency_contact_phone: form.emergency_contact_phone.trim() || null,
        status: form.status,
        specialties: selectedSpecs.length > 0 ? selectedSpecs : null,
      });
      setShowEdit(false);
      setSelected(null);
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to update team member');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = (member: any) => {
    const name = `${member.first_name || ''} ${member.last_name || ''}`.trim();
    Alert.alert('Remove Member', `Remove "${name}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          try { await sb.deleteTeamMember(member.id); refresh(); }
          catch (e: any) { Alert.alert('Error', e?.message || 'Failed to remove'); }
        },
      },
    ]);
  };

  const handleAddPayment = async () => {
    if (!selected || !paymentForm.amount || !paymentForm.payment_date) {
      Alert.alert('Validation', 'Amount and payment date are required');
      return;
    }
    setLoading(true);
    try {
      await sb.createTeamPayment({
        team_member_id: selected.id,
        payment_type: paymentForm.payment_type,
        amount: parseFloat(paymentForm.amount),
        payment_date: paymentForm.payment_date,
        payment_month: paymentForm.payment_month || null,
        payment_mode: paymentForm.payment_mode,
        notes: paymentForm.notes.trim() || null,
      });
      setShowPayment(false);
      setPaymentForm({ ...EMPTY_PAYMENT });
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to record payment');
    } finally {
      setLoading(false);
    }
  };

  const handleAddAttendance = async () => {
    if (!selected || !attForm.date) {
      Alert.alert('Validation', 'Date is required');
      return;
    }
    setLoading(true);
    try {
      await sb.createTeamAttendance({
        team_member_id: selected.id,
        date: attForm.date,
        status: attForm.status,
        check_in: attForm.check_in || null,
        check_out: attForm.check_out || null,
        notes: attForm.notes.trim() || null,
      });
      setShowAttendance(false);
      setAttForm({ ...EMPTY_ATTENDANCE });
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to record attendance');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePayment = async () => {
    if (!editingPayment || !paymentForm.amount || !paymentForm.payment_date) {
      Alert.alert('Validation', 'Amount and payment date are required');
      return;
    }
    setLoading(true);
    try {
      await sb.updateTeamPayment(editingPayment.id, {
        payment_type: paymentForm.payment_type,
        amount: parseFloat(paymentForm.amount),
        payment_date: paymentForm.payment_date,
        payment_month: paymentForm.payment_month || null,
        payment_mode: paymentForm.payment_mode,
        notes: paymentForm.notes.trim() || null,
      });
      setShowPaymentEdit(false);
      setEditingPayment(null);
      setPaymentForm({ ...EMPTY_PAYMENT });
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to update payment');
    } finally {
      setLoading(false);
    }
  };

  const handleDeletePayment = (p: any) => {
    Alert.alert('Delete Payment', `Delete this ₹${Number(p.amount || 0).toLocaleString('en-IN')} ${p.payment_type || ''} payment? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try { await sb.deleteTeamPayment(p.id); refresh(); }
          catch (e: any) { Alert.alert('Error', e?.message || 'Failed to delete payment'); }
        },
      },
    ]);
  };

  const openPaymentEdit = (p: any) => {
    setEditingPayment(p);
    setPaymentForm({
      payment_type: p.payment_type || 'salary',
      amount: p.amount != null ? String(p.amount) : '',
      payment_date: p.payment_date || '',
      payment_month: p.payment_month || '',
      payment_mode: p.payment_mode || 'bank_transfer',
      notes: p.notes || '',
    });
    setShowPaymentEdit(true);
  };

  const handleExit = async () => {
    if (!selected) return;
    if (!exitForm.exit_date) { Alert.alert('Validation', 'Exit date is required'); return; }
    setLoading(true);
    try {
      await sb.updateTeamMember(selected.id, {
        status: 'inactive',
        exit_date: exitForm.exit_date,
        exit_type: exitForm.exit_type || null,
        exit_reason: exitForm.exit_reason.trim() || null,
      });
      setShowExit(false);
      setSelected(null);
      setExitForm({ ...EMPTY_EXIT });
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to record exit');
    } finally {
      setLoading(false);
    }
  };

  const handleReactivate = (m: any) => {
    const name = `${m.first_name || ''} ${m.last_name || ''}`.trim();
    Alert.alert('Reactivate Member', `Reactivate "${name}"? They will be marked active and exit details cleared.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reactivate',
        onPress: async () => {
          try {
            await sb.updateTeamMember(m.id, { status: 'active', exit_date: null, exit_type: null, exit_reason: null });
            refresh();
          } catch (e: any) { Alert.alert('Error', e?.message || 'Failed to reactivate'); }
        },
      },
    ]);
  };

  const openExit = (m: any) => { setSelected(m); setExitForm({ ...EMPTY_EXIT, exit_date: toYmd(new Date()) }); setShowExit(true); };
  const openMemberAttendance = (m: any) => { setSelected(m); setShowMemberAtt(true); };

  // ── Departments CRUD (generic wrappers → team_departments) ──
  const reloadDepartments = async () => {
    try {
      const rows: any = await sb.listTeamDepartments();
      if (mounted.current) setDepartments(Array.isArray(rows) ? rows : []);
    } catch { /* keep existing list */ }
  };

  const handleAddDept = async () => {
    const name = newDeptName.trim();
    if (!name) { Alert.alert('Validation', 'Department name is required'); return; }
    setDeptBusy(true);
    try {
      await sb.createTeamDepartment({ name });
      setNewDeptName('');
      await reloadDepartments();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to add department');
    } finally {
      if (mounted.current) setDeptBusy(false);
    }
  };

  const handleRenameDept = async (id: string) => {
    const name = editingDeptName.trim();
    if (!name) { Alert.alert('Validation', 'Department name is required'); return; }
    setDeptBusy(true);
    try {
      await sb.updateTeamDepartment(id, { name });
      setEditingDeptId(null);
      setEditingDeptName('');
      await reloadDepartments();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to rename department');
    } finally {
      if (mounted.current) setDeptBusy(false);
    }
  };

  const handleDeleteDept = (dept: any) => {
    Alert.alert('Delete Department', `Delete "${dept?.name || ''}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await sb.deleteTeamDepartment(dept.id);
            await reloadDepartments();
          } catch (e: any) { Alert.alert('Error', e?.message || 'Failed to delete department'); }
        },
      },
    ]);
  };

  // Department names offered in the member form (loaded names ∪ built-in defaults)
  const deptOptions = useMemo(() => {
    const names: string[] = [];
    (departments || []).forEach((d: any) => {
      const n = (d?.name || '').trim();
      if (n && !names.includes(n)) names.push(n);
    });
    DEPARTMENTS.forEach(d => { if (!names.includes(d)) names.push(d); });
    return names;
  }, [departments]);

  // ── Performance rows (per-member maintenance-ticket stats) ──
  const perfRows = useMemo(() => {
    return (members || []).map((m: any) => {
      const assignedTickets = (tickets || []).filter((t: any) => t.assigned_to === m.id);
      const assigned = assignedTickets.length;
      const resolved = assignedTickets.filter((t: any) => {
        const s = String(t.status || '').toLowerCase();
        return s === 'completed' || s === 'closed';
      }).length;
      const rate = assigned > 0 ? Math.round((resolved / assigned) * 100) : 0;
      const name = `${m.first_name || ''} ${m.last_name || ''}`.trim() || '—';
      return { id: m.id, name, assigned, resolved, rate };
    }).sort((a, b) => b.assigned - a.assigned);
  }, [members, tickets]);

  const openEdit = (m: any) => {
    setSelected(m);
    setForm({
      first_name: m.first_name || '', last_name: m.last_name || '',
      phone: m.phone || '', email: m.email || '',
      gender: m.gender || '', designation: m.designation || '',
      department: m.department || '', joining_date: m.joining_date || '',
      salary_amount: m.salary_amount ? String(m.salary_amount) : '',
      id_proof_type: m.id_proof_type || '', id_proof_number: m.id_proof_number || '',
      pan_number: m.pan_number || '', aadhar_number: m.aadhar_number || '',
      address: m.address || '', city: m.city || '', state: m.state || '',
      bank_name: m.bank_name || '', bank_account_number: m.bank_account_number || '',
      bank_ifsc: m.bank_ifsc || '',
      emergency_contact_name: m.emergency_contact_name || '',
      emergency_contact_phone: m.emergency_contact_phone || '',
      status: m.status || 'active',
    });
    setSelectedSpecs(m.specialties || m.specializations || []);
    setShowEdit(true);
  };

  const openPayment = (m: any) => { setSelected(m); setPaymentForm({ ...EMPTY_PAYMENT }); setShowPayment(true); };
  const openAttendance = (m: any) => { setSelected(m); setAttForm({ ...EMPTY_ATTENDANCE }); setShowAttendance(true); };

  // ── Render ──
  if (members === null) return <LoadingScreen />;

  const tabs = [
    { key: 'members',    label: 'Members',    icon: 'people-outline' },
    { key: 'dashboard',  label: 'Insights',   icon: 'stats-chart-outline' },
    { key: 'payments',   label: 'Payments',   icon: 'cash-outline' },
    { key: 'salary',     label: 'Salary',     icon: 'receipt-outline' },
    { key: 'attendance', label: 'Attendance', icon: 'calendar-outline' },
    { key: 'performance', label: 'Performance', icon: 'trophy-outline' },
  ] as const;

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }}>
        {/* Header */}
        <View style={styles.header}>
          <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center', marginRight: 10 }}>
            <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
          </View>
          <View>
            <Text style={styles.headerTitle}>Team</Text>
            <Text style={styles.headerSub}>Access & roles</Text>
          </View>
          <IconBtnSolid
            onPress={() => { setForm({ ...EMPTY_FORM }); setSelectedSpecs([]); setShowAdd(true); }}
          />
        </View>

        {/* Tabs — horizontal scroll so all 6 fit without cramming/clipping the labels */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabRowScroll}
          contentContainerStyle={styles.tabRow}
        >
          {tabs.map(t => (
            <TouchableOpacity
              key={t.key}
              onPress={() => setActiveTab(t.key)}
              style={[styles.tab, activeTab === t.key && styles.tabActive]}
            >
              <Ionicons name={t.icon as any} size={14} color={activeTab === t.key ? '#fff' : '#64748B'} />
              <Text style={[styles.tabLabel, activeTab === t.key && styles.tabLabelActive]} numberOfLines={1}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Search (members only) */}
        {activeTab === 'members' && (
          <View style={styles.searchRow}>
            <SearchField value={search} onChangeText={setSearch} placeholder="Search by name, phone…" />
          </View>
        )}

        {/* Content */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          showsVerticalScrollIndicator={false}
        >
          {activeTab === 'members' && (
            <>
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 10 }}>
                <TouchableOpacity
                  onPress={() => { setNewDeptName(''); setEditingDeptId(null); setEditingDeptName(''); setShowDepartments(true); }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, backgroundColor: '#2563EB14', borderWidth: 1, borderColor: '#2563EB30' }}
                >
                  <Ionicons name="business-outline" size={14} color="#2563EB" />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#2563EB' }}>Departments{departments.length ? ` (${departments.length})` : ''}</Text>
                </TouchableOpacity>
              </View>
              <KpiHeader
                teamSize={kpis.teamSize}
                presentToday={kpis.presentToday}
                attendanceRate={kpis.attendanceRate}
              />
              {filteredMembers.length === 0 ? (
                <EmptyState icon="people-outline" title="No team members" subtitle="Tap + to add your first team member" />
              ) : (
                filteredMembers.map(m => (
                  <MemberCard
                    key={m.id} member={m}
                    onEdit={() => openEdit(m)}
                    onDelete={() => handleDelete(m)}
                    onPayment={() => openPayment(m)}
                    onAttendance={() => openMemberAttendance(m)}
                    onExit={() => openExit(m)}
                    onReactivate={() => handleReactivate(m)}
                  />
                ))
              )}
            </>
          )}

          {activeTab === 'dashboard' && (
            <AttendanceDashboardView
              memberCount={(members || []).length}
              rollup={rollup}
              today={todaySnap}
              rows={dashRows}
              attention={attention}
              onOpenMember={openMemberAttendance}
            />
          )}

          {activeTab === 'payments' && (
            payments.length === 0 ? (
              <EmptyState icon="cash-outline" title="No payments recorded" subtitle="Open a team member and record payment" />
            ) : (
              payments.map(p => (
                <PaymentRow
                  key={p.id} payment={p} members={members || []}
                  onEdit={() => openPaymentEdit(p)}
                  onDelete={() => handleDeletePayment(p)}
                />
              ))
            )
          )}

          {activeTab === 'salary' && (
            <>
            <View style={{ marginBottom: 12 }}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {salaryMonthOptions.map((mo) => {
                    const active = salaryMonth === mo;
                    return (
                      <TouchableOpacity key={mo} onPress={() => setSalaryMonth(mo)}
                        style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99, backgroundColor: active ? '#2563EB' : '#F1F3F9' }}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : '#64748B' }}>{payrollPeriodLabel(mo)}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>
              <TouchableOpacity disabled={generating} onPress={handleGenerateSalary}
                style={{ backgroundColor: '#0F172A', borderRadius: 12, paddingVertical: 11, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8, opacity: generating ? 0.6 : 1 }}>
                {generating ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="sparkles-outline" size={16} color="#fff" />}
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>{generating ? 'Generating…' : 'Generate drafts from attendance'}</Text>
              </TouchableOpacity>
            </View>
            {salaryLoading ? (
              <ActivityIndicator color="#2563EB" style={{ marginTop: 30 }} />
            ) : salaryBills.length === 0 ? (
              <EmptyState icon="receipt-outline" title="No salary bills" subtitle="Pick a pay period and tap “Generate drafts from attendance” to create pay-slips, then approve and mark paid." />
            ) : (
              salaryBills.map(b => {
                const m = (members || []).find((x: any) => x.id === b.team_member_id);
                const name = m ? (m.name || `${m.first_name || ''} ${m.last_name || ''}`.trim() || 'Member') : 'Member';
                const st = String(b.status || 'draft').toLowerCase();
                const stCfg = st === 'paid' ? { bg: '#DCFCE7', c: '#16A34A', label: 'Paid' }
                  : st === 'approved' ? { bg: '#EEF3FF', c: '#1D4ED8', label: 'Approved' }
                  : { bg: '#FFEDD5', c: '#EA580C', label: 'Draft' };
                const deductions = (Number(b.advance_deducted) || 0) + (Number(b.other_deductions) || 0);
                const net = Number(b.net_payable ?? b.earned_salary ?? 0);
                const busy = salaryBusy === b.id;
                return (
                  <View key={b.id} style={{ backgroundColor: '#fff', borderRadius: 16, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#EEF1F6', shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <View style={{ flex: 1, paddingRight: 8 }}>
                        <Text style={{ fontSize: 15, fontWeight: '800', color: '#0F172A' }}>{name}</Text>
                        <Text style={{ fontSize: 12, color: '#64748B' }}>{b.month} · {b.present_days ?? 0}/{b.working_days ?? 0} days</Text>
                      </View>
                      <View style={{ backgroundColor: stCfg.bg, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                        <Text style={{ fontSize: 11, fontWeight: '800', color: stCfg.c }}>{stCfg.label}</Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
                      <View><Text style={{ fontSize: 10, color: '#94A3B8' }}>Base</Text><Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A' }}>₹{Math.round(Number(b.base_salary) || 0).toLocaleString('en-IN')}</Text></View>
                      <View><Text style={{ fontSize: 10, color: '#94A3B8' }}>Earned</Text><Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A' }}>₹{Math.round(Number(b.earned_salary) || 0).toLocaleString('en-IN')}</Text></View>
                      {deductions > 0 && <View><Text style={{ fontSize: 10, color: '#94A3B8' }}>Deductions</Text><Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>−₹{Math.round(deductions).toLocaleString('en-IN')}</Text></View>}
                      <View><Text style={{ fontSize: 10, color: '#94A3B8' }}>Net payable</Text><Text style={{ fontSize: 15, fontWeight: '900', color: '#0F172A' }}>₹{Math.round(net).toLocaleString('en-IN')}</Text></View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                        <TouchableOpacity disabled={payslipBusy === b.id} onPress={() => handleDownloadPayslip(b, name, m?.designation)} style={{ backgroundColor: '#fff', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', flexDirection: 'row', gap: 6, borderWidth: 1, borderColor: '#EEF1F6' }}>
                          {payslipBusy === b.id
                            ? <ActivityIndicator size="small" color="#2563EB" />
                            : <><Ionicons name="download-outline" size={15} color="#2563EB" /><Text style={{ color: '#2563EB', fontWeight: '700', fontSize: 13 }}>Payslip</Text></>}
                        </TouchableOpacity>
                        {st === 'draft' && (
                          <TouchableOpacity disabled={busy} onPress={() => handleSalaryStatus(b, 'approved')} style={{ flex: 1, backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 10, alignItems: 'center', opacity: busy ? 0.5 : 1 }}>
                            {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>Approve</Text>}
                          </TouchableOpacity>
                        )}
                        {st === 'approved' && (
                          <TouchableOpacity disabled={busy} onPress={() => handleSalaryStatus(b, 'paid')} style={{ flex: 1, backgroundColor: '#16A34A', borderRadius: 12, paddingVertical: 10, alignItems: 'center', opacity: busy ? 0.5 : 1 }}>
                            {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>Mark Paid</Text>}
                          </TouchableOpacity>
                        )}
                        {st === 'approved' && (
                          <TouchableOpacity disabled={busy} onPress={() => handleSalaryStatus(b, 'draft')} style={{ backgroundColor: '#fff', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', borderWidth: 1, borderColor: '#EEF1F6' }}>
                            <Text style={{ color: '#64748B', fontWeight: '700', fontSize: 13 }}>Revert</Text>
                          </TouchableOpacity>
                        )}
                    </View>
                  </View>
                );
              })
            )}
            </>
          )}

          {activeTab === 'attendance' && (
            attendance.length === 0 ? (
              <EmptyState icon="calendar-outline" title="No attendance records" subtitle="Open a team member and mark attendance" />
            ) : (
              attendance.map(a => <AttendanceRow key={a.id} record={a} members={members || []} />)
            )
          )}

          {activeTab === 'performance' && (
            <PerformanceView rows={perfRows} totalTickets={tickets.length} />
          )}
        </ScrollView>
      </SafeAreaView>

      {/* Add Member Modal */}
      <MemberFormModal
        visible={showAdd} title="Add Team Member"
        form={form} setF={setF} deptOptions={deptOptions}
        selectedSpecs={selectedSpecs} setSelectedSpecs={setSelectedSpecs}
        loading={loading} onSave={handleAdd} onClose={() => setShowAdd(false)}
      />

      {/* Edit Member Modal */}
      <MemberFormModal
        visible={showEdit} title="Edit Member"
        form={form} setF={setF} deptOptions={deptOptions}
        selectedSpecs={selectedSpecs} setSelectedSpecs={setSelectedSpecs}
        loading={loading} onSave={handleEdit}
        onClose={() => { setShowEdit(false); setSelected(null); }}
      />

      {/* Payment Modal */}
      <Modal visible={showPayment} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
          <SafeAreaView style={{ flex: 1 }}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => setShowPayment(false)}>
                <Ionicons name="close" size={24} color="#0F172A" />
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Record Payment</Text>
              <View style={{ width: 24 }} />
            </View>
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
              {selected && (
                <View style={[styles.selectedBanner]}>
                  <Ionicons name="person-circle-outline" size={20} color="#2563EB" />
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#0F172A', marginLeft: 8 }}>
                    {`${selected.first_name || ''} ${selected.last_name || ''}`.trim()}
                  </Text>
                </View>
              )}
              <PickerRow label="Payment Type" value={paymentForm.payment_type}
                options={[{ label: 'Salary', value: 'salary' }, { label: 'Advance', value: 'advance' }, { label: 'Bonus', value: 'bonus' }, { label: 'Deduction', value: 'deduction' }]}
                onSelect={setPF('payment_type')} />
              <Input label="Amount (₹) *" value={paymentForm.amount} onChangeText={setPF('amount')} placeholder="0" keyboardType="numeric" icon="cash-outline" />
              <View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#64748B', marginBottom: 6 }}>Payment Date *</Text><DateField value={paymentForm.payment_date} onChange={setPF('payment_date')} /></View>
              <Input label="Month (optional)" value={paymentForm.payment_month} onChangeText={setPF('payment_month')} placeholder="YYYY-MM" icon="calendar-number-outline" />
              <PickerRow label="Payment Mode" value={paymentForm.payment_mode}
                options={[{ label: 'Bank Transfer', value: 'bank_transfer' }, { label: 'Cash', value: 'cash' }, { label: 'UPI', value: 'upi' }, { label: 'Cheque', value: 'cheque' }]}
                onSelect={setPF('payment_mode')} />
              <Input label="Notes" value={paymentForm.notes} onChangeText={setPF('notes')} placeholder="Optional notes…" multiline icon="create-outline" />
              <View style={{ marginTop: 16 }}>
                <Button title="Save Payment" onPress={handleAddPayment} loading={loading} icon="checkmark-circle-outline" />
              </View>
            </ScrollView>
          </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* Attendance Modal */}
      <Modal visible={showAttendance} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
          <SafeAreaView style={{ flex: 1 }}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => setShowAttendance(false)}>
                <Ionicons name="close" size={24} color="#0F172A" />
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Mark Attendance</Text>
              <View style={{ width: 24 }} />
            </View>
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
              {selected && (
                <View style={styles.selectedBanner}>
                  <Ionicons name="person-circle-outline" size={20} color="#2563EB" />
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#0F172A', marginLeft: 8 }}>
                    {`${selected.first_name || ''} ${selected.last_name || ''}`.trim()}
                  </Text>
                </View>
              )}
              <View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#64748B', marginBottom: 6 }}>Date *</Text><DateField value={attForm.date} onChange={setAF('date')} /></View>
              <PickerRow label="Status" value={attForm.status}
                options={[
                  { label: 'Present', value: 'present' }, { label: 'Absent', value: 'absent' },
                  { label: 'Half Day', value: 'half_day' }, { label: 'Leave', value: 'leave' },
                ]}
                onSelect={setAF('status')} />
              <Input label="Check In" value={attForm.check_in} onChangeText={setAF('check_in')} placeholder="HH:MM" icon="time-outline" />
              <Input label="Check Out" value={attForm.check_out} onChangeText={setAF('check_out')} placeholder="HH:MM" icon="time-outline" />
              <Input label="Notes" value={attForm.notes} onChangeText={setAF('notes')} placeholder="Optional notes…" multiline icon="create-outline" />
              <View style={{ marginTop: 16 }}>
                <Button title="Save Attendance" onPress={handleAddAttendance} loading={loading} icon="checkmark-circle-outline" />
              </View>
            </ScrollView>
          </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* Payment Edit Modal */}
      <Modal visible={showPaymentEdit} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
          <SafeAreaView style={{ flex: 1 }}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => { setShowPaymentEdit(false); setEditingPayment(null); }}>
                <Ionicons name="close" size={24} color="#0F172A" />
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Edit Payment</Text>
              <TouchableOpacity onPress={() => editingPayment && handleDeletePayment(editingPayment)}>
                <Ionicons name="trash-outline" size={22} color="#dc2626" />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
              <PickerRow label="Payment Type" value={paymentForm.payment_type}
                options={[{ label: 'Salary', value: 'salary' }, { label: 'Advance', value: 'advance' }, { label: 'Bonus', value: 'bonus' }, { label: 'Deduction', value: 'deduction' }]}
                onSelect={setPF('payment_type')} />
              <Input label="Amount (₹) *" value={paymentForm.amount} onChangeText={setPF('amount')} placeholder="0" keyboardType="numeric" icon="cash-outline" />
              <View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#64748B', marginBottom: 6 }}>Payment Date *</Text><DateField value={paymentForm.payment_date} onChange={setPF('payment_date')} /></View>
              <Input label="Month (optional)" value={paymentForm.payment_month} onChangeText={setPF('payment_month')} placeholder="YYYY-MM" icon="calendar-number-outline" />
              <PickerRow label="Payment Mode" value={paymentForm.payment_mode}
                options={[{ label: 'Bank Transfer', value: 'bank_transfer' }, { label: 'Cash', value: 'cash' }, { label: 'UPI', value: 'upi' }, { label: 'Cheque', value: 'cheque' }]}
                onSelect={setPF('payment_mode')} />
              <Input label="Notes" value={paymentForm.notes} onChangeText={setPF('notes')} placeholder="Optional notes…" multiline icon="create-outline" />
              <View style={{ marginTop: 16 }}>
                <Button title="Update Payment" onPress={handleUpdatePayment} loading={loading} icon="checkmark-circle-outline" />
              </View>
            </ScrollView>
          </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* Exit Employee Modal */}
      <Modal visible={showExit} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
          <SafeAreaView style={{ flex: 1 }}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => { setShowExit(false); setSelected(null); }}>
                <Ionicons name="close" size={24} color="#0F172A" />
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Exit Employee</Text>
              <View style={{ width: 24 }} />
            </View>
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
              {selected && (
                <View style={styles.selectedBanner}>
                  <Ionicons name="person-circle-outline" size={20} color="#2563EB" />
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#0F172A', marginLeft: 8 }}>
                    {`${selected.first_name || ''} ${selected.last_name || ''}`.trim()}
                  </Text>
                </View>
              )}
              <View style={{ backgroundColor: '#FEF2F2', borderRadius: 12, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: '#FECACA' }}>
                <Text style={{ fontSize: 12, color: '#b91c1c', fontWeight: '600' }}>
                  This marks the member inactive and records their exit. You can reactivate them later.
                </Text>
              </View>
              <View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#64748B', marginBottom: 6 }}>Exit Date *</Text><DateField value={exitForm.exit_date} onChange={setXF('exit_date')} /></View>
              <PickerRow label="Exit Type" value={exitForm.exit_type} options={EXIT_TYPES} onSelect={setXF('exit_type')} />
              <Input label="Reason" value={exitForm.exit_reason} onChangeText={setXF('exit_reason')} placeholder="Optional reason…" multiline icon="create-outline" />
              <View style={{ marginTop: 16 }}>
                <Button title="Confirm Exit" onPress={handleExit} loading={loading} icon="log-out-outline" />
              </View>
            </ScrollView>
          </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* Member Attendance Panel */}
      <Modal visible={showMemberAtt} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
          <SafeAreaView style={{ flex: 1 }}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => setShowMemberAtt(false)}>
                <Ionicons name="close" size={24} color="#0F172A" />
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Attendance</Text>
              <TouchableOpacity onPress={() => { if (selected) openAttendance(selected); }}>
                <Ionicons name="add-circle-outline" size={24} color="#2563EB" />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
              {selected && (
                <MemberAttendancePanel member={selected} attendance={attendance || []} />
              )}
            </ScrollView>
          </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* Manage Departments Modal */}
      <Modal visible={showDepartments} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
          <SafeAreaView style={{ flex: 1 }}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => { setShowDepartments(false); setEditingDeptId(null); setEditingDeptName(''); }}>
                <Ionicons name="close" size={24} color="#0F172A" />
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Departments</Text>
              <View style={{ width: 24 }} />
            </View>
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
              {/* Add new */}
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end', marginBottom: 16 }}>
                <View style={{ flex: 1 }}>
                  <Input label="New Department" value={newDeptName} onChangeText={setNewDeptName} placeholder="e.g. Maintenance" icon="business-outline" />
                </View>
                <TouchableOpacity
                  onPress={handleAddDept}
                  disabled={deptBusy}
                  style={{ height: 48, paddingHorizontal: 16, borderRadius: 12, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center', opacity: deptBusy ? 0.6 : 1, marginBottom: 14 }}
                >
                  <Ionicons name="add" size={22} color="#fff" />
                </TouchableOpacity>
              </View>

              {departments.length === 0 ? (
                <EmptyState icon="business-outline" title="No departments" subtitle="Add a department above to get started" />
              ) : (
                departments.map((d: any) => (
                  <View key={d.id} style={[styles.card, { padding: 12 }]}>
                    {editingDeptId === d.id ? (
                      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                        <TextInput
                          value={editingDeptName}
                          onChangeText={setEditingDeptName}
                          placeholder="Department name"
                          style={{ flex: 1, fontSize: 14, color: '#0F172A', backgroundColor: '#F8FAFC', borderRadius: 10, borderWidth: 1, borderColor: '#EEF1F6', paddingHorizontal: 12, height: 40 }}
                        />
                        <ActionChip label="Save" icon="checkmark-outline" color="#16a34a" onPress={() => handleRenameDept(d.id)} />
                        <ActionChip label="Cancel" icon="close-outline" color="#64748B" onPress={() => { setEditingDeptId(null); setEditingDeptName(''); }} />
                      </View>
                    ) : (
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: '#0F172A', flex: 1, paddingRight: 8 }}>{d.name || '—'}</Text>
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <ActionChip label="Rename" icon="pencil-outline" color="#2563EB" onPress={() => { setEditingDeptId(d.id); setEditingDeptName(d.name || ''); }} />
                          <ActionChip label="Delete" icon="trash-outline" color="#dc2626" onPress={() => handleDeleteDept(d)} />
                        </View>
                      </View>
                    )}
                  </View>
                ))
              )}
            </ScrollView>
          </SafeAreaView>
        </GlassBackground>
      </Modal>
    </GlassBackground>
  );
}

// ─── Member Card ──────────────────────────────────────────────────────────────
function MemberCard({ member, onEdit, onDelete, onPayment, onAttendance, onExit, onReactivate }: any) {
  const [expanded, setExpanded] = useState(false);
  const sc = STATUS_COLORS[member.status] || STATUS_COLORS.active;
  const name = `${member.first_name || ''} ${member.last_name || ''}`.trim() || '—';
  const initials = name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase();

  return (
    <View style={styles.card}>
      <TouchableOpacity onPress={() => setExpanded(e => !e)} activeOpacity={0.85}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text style={styles.memberName}>{name}</Text>
              <View style={[styles.badge, { backgroundColor: sc.bg }]}>
                <Text style={[styles.badgeText, { color: sc.color }]}>{member.status || 'active'}</Text>
              </View>
            </View>
            {member.designation ? <Text style={styles.memberMeta}>{member.designation}{member.department ? ` · ${member.department}` : ''}</Text> : null}
            <Text style={styles.memberMeta}>
              <Ionicons name="call-outline" size={12} color="#64748B" /> {member.phone || '—'}
            </Text>
            {member.salary_amount ? (
              <Text style={styles.memberMeta}>
                <Ionicons name="cash-outline" size={12} color="#64748B" /> ₹{Number(member.salary_amount).toLocaleString('en-IN')}/mo
              </Text>
            ) : null}
          </View>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color="#64748B" />
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={{ marginTop: 12, gap: 8 }}>
          {(member.specialties || member.specializations)?.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {(member.specialties || member.specializations).map((s: string) => (
                <View key={s} style={{ backgroundColor: '#EFF6FF', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ fontSize: 11, color: '#2563EB', fontWeight: '600' }}>{s}</Text>
                </View>
              ))}
            </View>
          )}
          <View style={{ gap: 6, backgroundColor: '#F8FAFC', borderRadius: 10, padding: 10 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: '#94A3B8', letterSpacing: 0.4 }}>PROFILE & KYC</Text>
            <ProfileRow icon="briefcase-outline" label="Designation" value={member.designation} />
            <ProfileRow icon="business-outline" label="Department" value={member.department} />
            <ProfileRow icon="mail-outline" label="Email" value={member.email} />
            <ProfileRow icon="calendar-outline" label="Joined" value={member.joining_date ? formatDate(member.joining_date) : null} />
            <ProfileRow icon="card-outline" label="PAN" value={member.pan_number} />
            <ProfileRow icon="finger-print-outline" label="Aadhaar" value={member.aadhar_number} />
            <ProfileRow icon="wallet-outline" label="Bank" value={member.bank_name ? `${member.bank_name}${member.bank_account_number ? ' · ' + member.bank_account_number : ''}` : null} />
            <ProfileRow icon="git-branch-outline" label="IFSC" value={member.bank_ifsc} />
            {!(member.designation || member.department || member.email || member.joining_date || member.pan_number || member.aadhar_number || member.bank_name || member.bank_ifsc) && (
              <Text style={{ fontSize: 12, color: '#94A3B8', fontStyle: 'italic' }}>No profile/KYC details on file — tap Edit to add.</Text>
            )}
          </View>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            <ActionChip label="Edit" icon="pencil-outline" color="#2563EB" onPress={onEdit} />
            <ActionChip label="Payment" icon="cash-outline" color="#16a34a" onPress={onPayment} />
            <ActionChip label="Attendance" icon="calendar-outline" color="#2563eb" onPress={onAttendance} />
            {member.status === 'inactive' ? (
              <ActionChip label="Reactivate" icon="refresh-outline" color="#16a34a" onPress={onReactivate} />
            ) : (
              <ActionChip label="Exit" icon="log-out-outline" color="#ea580c" onPress={onExit} />
            )}
            <ActionChip label="Remove" icon="trash-outline" color="#dc2626" onPress={onDelete} />
          </View>
        </View>
      )}
    </View>
  );
}

function ActionChip({ label, icon, color, onPress }: any) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: color + '14', borderWidth: 1, borderColor: color + '30' }}
    >
      <Ionicons name={icon} size={13} color={color} />
      <Text style={{ fontSize: 12, fontWeight: '600', color }}>{label}</Text>
    </TouchableOpacity>
  );
}

function ProfileRow({ icon, label, value }: any) {
  if (!value) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Ionicons name={icon} size={13} color="#94A3B8" />
      <Text style={{ fontSize: 11, color: '#64748B', width: 82 }}>{label}</Text>
      <Text style={{ fontSize: 12, color: '#334155', fontWeight: '600', flex: 1 }}>{String(value)}</Text>
    </View>
  );
}

function PaymentRow({ payment, members, onEdit, onDelete }: any) {
  const member = members.find((m: any) => m.id === payment.team_member_id);
  const name = member ? `${member.first_name || ''} ${member.last_name || ''}`.trim() : '—';
  return (
    <View style={[styles.card, { padding: 12 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flex: 1, paddingRight: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: '#0F172A' }}>{name}</Text>
          <Text style={{ fontSize: 12, color: '#64748B' }}>{payment.payment_type} · {payment.payment_mode}</Text>
          <Text style={{ fontSize: 12, color: '#64748B' }}>{formatDate(payment.payment_date)}{payment.payment_month ? ` · ${payment.payment_month}` : ''}</Text>
        </View>
        <Text style={{ fontSize: 16, fontWeight: '800', color: '#0F172A' }}>₹{Number(payment.amount || 0).toLocaleString('en-IN')}</Text>
      </View>
      {(onEdit || onDelete) && (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
          {onEdit && <ActionChip label="Edit" icon="pencil-outline" color="#2563EB" onPress={onEdit} />}
          {onDelete && <ActionChip label="Delete" icon="trash-outline" color="#dc2626" onPress={onDelete} />}
        </View>
      )}
    </View>
  );
}

const ATT_COLORS: Record<string, string> = {
  present: '#16a34a', absent: '#dc2626', half_day: '#ea580c', leave: '#2563eb',
};

function AttendanceRow({ record, members }: any) {
  const member = members.find((m: any) => m.id === record.team_member_id);
  const name = member ? `${member.first_name || ''} ${member.last_name || ''}`.trim() : '—';
  const color = ATT_COLORS[record.status] || '#64748B';
  return (
    <View style={[styles.card, { padding: 12 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View>
          <Text style={{ fontSize: 14, fontWeight: '700', color: '#0F172A' }}>{name}</Text>
          <Text style={{ fontSize: 12, color: '#64748B' }}>{formatDate(record.date)}</Text>
          {record.check_in ? <Text style={{ fontSize: 12, color: '#64748B' }}>{record.check_in} → {record.check_out || '—'}</Text> : null}
        </View>
        <View style={{ backgroundColor: color + '18', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color, textTransform: 'capitalize' }}>{(record.status || '').replace('_', ' ')}</Text>
        </View>
      </View>
    </View>
  );
}

// ─── Performance view (maintenance-ticket stats per member) ─────────────────────
function PerformanceView({ rows, totalTickets }: { rows: any[]; totalTickets: number }) {
  if (!rows || rows.length === 0) {
    return <EmptyState icon="trophy-outline" title="No team members" subtitle="Add members to see maintenance performance" />;
  }
  const totalAssigned = rows.reduce((s, r) => s + (r.assigned || 0), 0);
  const totalResolved = rows.reduce((s, r) => s + (r.resolved || 0), 0);
  const overallRate = totalAssigned > 0 ? Math.round((totalResolved / totalAssigned) * 100) : 0;

  return (
    <View>
      {/* Summary strip */}
      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
        {[
          { label: 'Tickets', value: String(totalTickets), color: '#0F172A' },
          { label: 'Assigned', value: String(totalAssigned), color: '#2563EB' },
          { label: 'Resolved', value: String(totalResolved), color: '#16a34a' },
          { label: 'Resolve %', value: `${overallRate}%`, color: rateColor(overallRate) },
        ].map(it => (
          <View key={it.label} style={[styles.card, { flex: 1, padding: 10, marginBottom: 0, alignItems: 'center' }]}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: it.color }}>{it.value}</Text>
            <Text style={{ fontSize: 9, color: '#64748B', fontWeight: '600', marginTop: 2, textTransform: 'uppercase' }}>{it.label}</Text>
          </View>
        ))}
      </View>

      {/* Per-member table */}
      <View style={[styles.card, { padding: 0, overflow: 'hidden' }]}>
        <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: '#EEF1F6' }}>
          <Text style={{ flex: 1, fontSize: 11, fontWeight: '700', color: '#64748B' }}>EMPLOYEE</Text>
          <Text style={{ width: 62, fontSize: 11, fontWeight: '700', color: '#64748B', textAlign: 'center' }}>ASSIGNED</Text>
          <Text style={{ width: 62, fontSize: 11, fontWeight: '700', color: '#64748B', textAlign: 'center' }}>RESOLVED</Text>
          <Text style={{ width: 52, fontSize: 11, fontWeight: '700', color: '#64748B', textAlign: 'right' }}>RATE</Text>
        </View>
        {rows.map((r: any, i: number) => (
          <View
            key={r.id}
            style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: i === 0 ? 0 : 0.5, borderTopColor: '#F1F5F9' }}
          >
            <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: '#0F172A', paddingRight: 6 }} numberOfLines={1}>{r.name}</Text>
            <Text style={{ width: 62, fontSize: 13, color: '#2563EB', textAlign: 'center', fontWeight: '600' }}>{r.assigned}</Text>
            <Text style={{ width: 62, fontSize: 13, color: '#16a34a', textAlign: 'center', fontWeight: '600' }}>{r.resolved}</Text>
            <Text style={{ width: 52, fontSize: 13, fontWeight: '800', color: r.assigned > 0 ? rateColor(r.rate) : '#94A3B8', textAlign: 'right' }}>{r.assigned > 0 ? `${r.rate}%` : '—'}</Text>
          </View>
        ))}
      </View>
      <Text style={{ fontSize: 11, color: '#94A3B8', marginTop: 10, textAlign: 'center' }}>
        Resolved = assigned tickets marked completed or closed.
      </Text>
    </View>
  );
}

// ─── Attendance KPI header (Members list) ───────────────────────────────────────
function KpiHeader({ teamSize, presentToday, attendanceRate }: { teamSize: number; presentToday: number; attendanceRate: number }) {
  const items = [
    { label: 'Team Size',   value: String(teamSize),          icon: 'people-outline',   color: '#2563EB' },
    { label: 'Present Today', value: String(presentToday),    icon: 'checkmark-circle-outline', color: '#16a34a' },
    { label: 'Attend. Rate', value: `${attendanceRate}%`,     icon: 'stats-chart-outline', color: '#ea580c' },
  ];
  return (
    <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
      {items.map(it => (
        <View key={it.label} style={[styles.card, { flex: 1, padding: 12, marginBottom: 0, alignItems: 'flex-start' }]}>
          <Ionicons name={it.icon as any} size={16} color={it.color} />
          <Text style={{ fontSize: 20, fontWeight: '800', color: '#0F172A', marginTop: 6 }}>{it.value}</Text>
          <Text style={{ fontSize: 10, color: '#64748B', fontWeight: '600', marginTop: 2 }}>{it.label}</Text>
        </View>
      ))}
    </View>
  );
}

// ─── Attendance Dashboard view (Insights tab) ───────────────────────────────────
const DASH_SEG_COLORS: Record<string, string> = {
  present: '#16a34a', late: '#65a30d', leave: '#2563eb', absent: '#dc2626', unlogged: '#f87171',
};

function StatusBar({ rollup }: { rollup: any }) {
  const total = rollup.possibleDays || 0;
  const purePresent = Math.max(0, rollup.presentDays - rollup.lateDays);
  const loggedAbsent = Math.max(0, rollup.absentDays - rollup.unloggedAbsentDays);
  const segs = [
    { key: 'present',  label: 'Present',  value: purePresent },
    { key: 'late',     label: 'Late',     value: rollup.lateDays },
    { key: 'leave',    label: 'Leave',    value: rollup.leaveDays },
    { key: 'absent',   label: 'Absent',   value: loggedAbsent },
    { key: 'unlogged', label: 'Unlogged', value: rollup.unloggedAbsentDays },
  ].map(s => ({ ...s, pct: total > 0 ? Math.round((s.value / total) * 1000) / 10 : 0 }));

  return (
    <View style={[styles.card, { padding: 14 }]}>
      <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A', marginBottom: 2 }}>Status distribution</Text>
      <Text style={{ fontSize: 24, fontWeight: '800', color: '#0F172A' }}>{total}</Text>
      <Text style={{ fontSize: 11, color: '#64748B', marginBottom: 12 }}>Man-days this month</Text>
      <View style={{ flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', backgroundColor: '#EEF1F6' }}>
        {segs.filter(s => s.pct > 0).map(s => (
          <View key={s.key} style={{ width: `${s.pct}%`, backgroundColor: DASH_SEG_COLORS[s.key] }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
        {segs.map(s => (
          <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, width: '45%' }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: DASH_SEG_COLORS[s.key] }} />
            <Text style={{ fontSize: 11, color: '#64748B' }}>{s.label}</Text>
            <Text style={{ fontSize: 11, fontWeight: '700', color: '#0F172A', marginLeft: 'auto' }}>{s.pct}%</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function rateColor(rate: number | null): string {
  if (rate === null) return '#64748B';
  if (rate >= 90) return '#16a34a';
  if (rate >= 75) return '#ea580c';
  return '#dc2626';
}

function AttendanceDashboardView({ memberCount, rollup, today, rows, attention, onOpenMember }: any) {
  if (memberCount === 0) {
    return <EmptyState icon="stats-chart-outline" title="No team members" subtitle="Add members to see attendance insights" />;
  }
  return (
    <View>
      {/* Big-number strip */}
      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
        {[
          { label: 'Active', value: today.total, color: '#0F172A' },
          { label: 'Present', value: today.present, color: '#16a34a' },
          { label: 'Absent', value: today.absent, color: today.absent > 0 ? '#dc2626' : '#0F172A' },
          { label: 'On Leave', value: today.leave, color: '#2563eb' },
        ].map(it => (
          <View key={it.label} style={[styles.card, { flex: 1, padding: 10, marginBottom: 0, alignItems: 'center' }]}>
            <Text style={{ fontSize: 20, fontWeight: '800', color: it.color }}>{it.value}</Text>
            <Text style={{ fontSize: 9, color: '#64748B', fontWeight: '600', marginTop: 2, textTransform: 'uppercase' }}>{it.label}</Text>
          </View>
        ))}
      </View>

      {/* Attendance rate KPI */}
      <View style={[styles.card, { padding: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
        <View>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A' }}>Attendance rate</Text>
          <Text style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>Current month · all members</Text>
        </View>
        <Text style={{ fontSize: 30, fontWeight: '800', color: rateColor(rollup.ratePct) }}>{rollup.ratePct}%</Text>
      </View>

      {/* Status distribution */}
      <StatusBar rollup={rollup} />

      {/* Needs attention */}
      {attention.length > 0 && (
        <View style={[styles.card, { padding: 14, backgroundColor: '#0F172A' }]}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Needs attention</Text>
          <Text style={{ fontSize: 11, color: '#94A3B8', marginTop: 2, marginBottom: 8 }}>Lowest attendance this month</Text>
          {attention.map((r: MemberDashRow) => (
            <TouchableOpacity
              key={r.member.id}
              activeOpacity={0.7}
              onPress={() => onOpenMember(r.member)}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 }}
            >
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }} numberOfLines={1}>{r.name}</Text>
                <Text style={{ fontSize: 11, color: '#94A3B8' }}>{r.summary.unloggedAbsentDays} unlogged · {r.summary.absentDays} absent</Text>
              </View>
              <View style={{ backgroundColor: (r.rate ?? 0) < 70 ? '#7f1d1d' : 'rgba(255,255,255,0.12)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: (r.rate ?? 0) < 70 ? '#fecaca' : '#fff' }}>{r.rate}%</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Per-employee rate list */}
      <View style={[styles.card, { padding: 0, overflow: 'hidden' }]}>
        <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: '#EEF1F6' }}>
          <Text style={{ flex: 1, fontSize: 11, fontWeight: '700', color: '#64748B' }}>EMPLOYEE</Text>
          <Text style={{ width: 42, fontSize: 11, fontWeight: '700', color: '#64748B', textAlign: 'center' }}>P</Text>
          <Text style={{ width: 42, fontSize: 11, fontWeight: '700', color: '#64748B', textAlign: 'center' }}>A</Text>
          <Text style={{ width: 42, fontSize: 11, fontWeight: '700', color: '#64748B', textAlign: 'center' }}>L</Text>
          <Text style={{ width: 52, fontSize: 11, fontWeight: '700', color: '#64748B', textAlign: 'right' }}>RATE</Text>
        </View>
        {rows.length === 0 ? (
          <Text style={{ padding: 14, fontSize: 12, color: '#64748B' }}>No attendance data this month.</Text>
        ) : rows.map((r: MemberDashRow, i: number) => (
          <TouchableOpacity
            key={r.member.id}
            activeOpacity={0.7}
            onPress={() => onOpenMember(r.member)}
            style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: i === 0 ? 0 : 0.5, borderTopColor: '#F1F5F9' }}
          >
            <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: '#0F172A', paddingRight: 6 }} numberOfLines={1}>{r.name}</Text>
            <Text style={{ width: 42, fontSize: 13, color: '#16a34a', textAlign: 'center', fontWeight: '600' }}>{r.summary.presentUnits}</Text>
            <Text style={{ width: 42, fontSize: 13, color: '#dc2626', textAlign: 'center', fontWeight: '600' }}>{r.summary.absentDays}</Text>
            <Text style={{ width: 42, fontSize: 13, color: '#2563eb', textAlign: 'center', fontWeight: '600' }}>{r.summary.leaveDays}</Text>
            <Text style={{ width: 52, fontSize: 13, fontWeight: '800', color: rateColor(r.rate), textAlign: 'right' }}>{r.rate}%</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// ─── Member Attendance Panel (per-member monthly summary + work-hours) ──────────
const HEAT_COLORS: Record<string, string> = {
  present: '#16a34a', late: '#65a30d', leave: '#2563eb', absent: '#dc2626',
};

function MemberAttendancePanel({ member, attendance }: any) {
  const month = monthKey();
  const summary = useMemo(() => memberMonthSummary(member, attendance, month), [member, attendance, month]);
  const heat = useMemo(() => calendarHeat([member], attendance, month), [member, attendance, month]);
  const monthRows = useMemo(() => memberMonthRows(member.id, attendance, month), [member, attendance, month]);
  const workStart = (member?.work_start_time || '09:00').slice(0, 5);
  const hoursPerDay = Number(member?.work_hours_per_day || 8);
  const work = useMemo(
    () => summarizeWorkHours(monthRows, { workStart, hoursPerDay }),
    [monthRows, workStart, hoursPerDay],
  );

  const rate = summary.ratePct;
  const possible = summary.possibleDays || 0;
  const firstDow = heat[0] ? new Date(heat[0].date + 'T00:00:00').getDay() : 0;
  const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  const heatColor = (day: DayHeat): string => {
    if (day.isFuture) return '#F1F5F9';
    if (day.isSunday) return '#E2E8F0';
    const dom = heatDominant(day);
    return dom ? HEAT_COLORS[dom] : '#F1F5F9';
  };

  const tiles = [
    { key: 'present', label: 'Present', value: String(summary.presentUnits), color: '#16a34a' },
    { key: 'leave',   label: 'Leave',   value: String(summary.leaveDays),   color: '#2563eb' },
    { key: 'absent',  label: 'Absent',  value: String(summary.absentDays),  color: '#dc2626' },
    { key: 'rate',    label: 'Rate',    value: rate === null ? '—' : `${rate}%`, color: rateColor(rate) },
  ];

  return (
    <View>
      {/* Member banner */}
      <View style={styles.selectedBanner}>
        <Ionicons name="person-circle-outline" size={20} color="#2563EB" />
        <Text style={{ fontSize: 14, fontWeight: '700', color: '#0F172A', marginLeft: 8 }}>
          {`${member.first_name || ''} ${member.last_name || ''}`.trim()}
        </Text>
      </View>

      {/* Summary tiles */}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
        {tiles.map(t => (
          <View key={t.key} style={[styles.card, { flex: 1, padding: 10, marginBottom: 0, alignItems: 'center' }]}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: t.color }}>{t.value}</Text>
            <Text style={{ fontSize: 9, color: '#64748B', fontWeight: '600', marginTop: 2, textTransform: 'uppercase' }}>{t.label}</Text>
          </View>
        ))}
      </View>

      {/* Calendar heat grid */}
      <View style={[styles.card, { padding: 14 }]}>
        <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A', marginBottom: 10 }}>Attendance calendar</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {DAY_LABELS.map((d, i) => (
            <View key={`dl-${i}`} style={{ width: `${100 / 7}%`, alignItems: 'center', marginBottom: 4 }}>
              <Text style={{ fontSize: 10, color: '#94A3B8', fontWeight: '600' }}>{d}</Text>
            </View>
          ))}
          {Array.from({ length: firstDow }).map((_, i) => (
            <View key={`b-${i}`} style={{ width: `${100 / 7}%`, aspectRatio: 1, padding: 2 }} />
          ))}
          {heat.map((day) => (
            <View key={day.date} style={{ width: `${100 / 7}%`, aspectRatio: 1, padding: 2 }}>
              <View style={{ flex: 1, borderRadius: 4, backgroundColor: heatColor(day), alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 9, color: (day.isFuture || day.isSunday || !heatDominant(day)) ? '#94A3B8' : '#fff', fontWeight: '600' }}>
                  {Number(day.date.slice(8, 10))}
                </Text>
              </View>
            </View>
          ))}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
          {[['Present', '#16a34a'], ['Late', '#65a30d'], ['Leave', '#2563eb'], ['Absent', '#dc2626'], ['Off', '#E2E8F0']].map(([l, c]) => (
            <View key={l} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c }} />
              <Text style={{ fontSize: 10, color: '#64748B' }}>{l}</Text>
            </View>
          ))}
        </View>
        {possible > 0 && (
          <Text style={{ fontSize: 11, color: '#64748B', marginTop: 10 }}>
            {summary.presentUnits} of {possible} days present
            {summary.unloggedAbsentDays > 0 ? ` · ${summary.unloggedAbsentDays} unlogged` : ''}
          </Text>
        )}
      </View>

      {/* Work-hours tiles */}
      {work.daysWithTimes > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[
            {
              key: 'late', label: 'Avg late arrival',
              value: work.avgLateMinutes != null ? `${Math.round(work.avgLateMinutes)}m` : 'On time',
              sub: `${work.lateDays} late days`, color: work.avgLateMinutes != null ? '#ea580c' : '#16a34a',
            },
            {
              key: 'worked', label: 'Hours worked',
              value: `${work.totalWorkedHours.toFixed(1)}h`,
              sub: `of ${work.expectedHours.toFixed(1)}h · ${work.daysWithTimes} days`, color: '#2563EB',
            },
            {
              key: 'comp', label: 'Late compensated',
              value: work.lateDays > 0 ? `${work.lateCompensated}/${work.lateDays}` : '—',
              sub: 'made up hours', color: '#16a34a',
            },
            {
              key: 'missing', label: work.missingHours < 0 ? 'Extra hours' : 'Missing hours',
              value: work.missingHours < 0 ? `+${Math.abs(work.missingHours).toFixed(1)}h` : `${work.missingHours.toFixed(1)}h`,
              sub: 'vs designated', color: work.missingHours < 0 ? '#16a34a' : '#dc2626',
            },
          ].map(t => (
            <View key={t.key} style={[styles.card, { width: '47%', padding: 12, marginBottom: 0 }]}>
              <Text style={{ fontSize: 10, color: '#64748B', fontWeight: '600' }} numberOfLines={1}>{t.label}</Text>
              <Text style={{ fontSize: 18, fontWeight: '800', color: t.color, marginTop: 2 }}>{t.value}</Text>
              <Text style={{ fontSize: 9, color: '#94A3B8', marginTop: 2 }} numberOfLines={1}>{t.sub}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={{ fontSize: 12, color: '#64748B', textAlign: 'center', marginTop: 4 }}>No check-in/out times logged this month.</Text>
      )}
    </View>
  );
}

// ─── Member Form Modal ────────────────────────────────────────────────────────
function MemberFormModal({ visible, title, form, setF, deptOptions, selectedSpecs, setSelectedSpecs, loading, onSave, onClose }: any) {
  // Offer loaded department names (falls back to built-in defaults); keep any
  // pre-existing free-text value selectable so editing never drops it.
  const deptChoices: string[] = (() => {
    const base: string[] = Array.isArray(deptOptions) && deptOptions.length ? deptOptions : DEPARTMENTS;
    const cur = (form?.department || '').trim();
    return cur && !base.includes(cur) ? [cur, ...base] : base;
  })();
  const toggleSpec = (s: string) =>
    setSelectedSpecs((prev: string[]) => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color="#0F172A" />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>{title}</Text>
            <View style={{ width: 24 }} />
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
            <SectionLabel title="Personal" icon="person-outline" />
            <Input label="First Name *" value={form.first_name} onChangeText={setF('first_name')} placeholder="First name" icon="person-outline" />
            <Input label="Last Name" value={form.last_name} onChangeText={setF('last_name')} placeholder="Last name" icon="person-outline" />
            <Input label="Phone *" value={form.phone} onChangeText={setF('phone')} placeholder="10-digit phone" keyboardType="phone-pad" icon="call-outline" />
            <Input label="Email" value={form.email} onChangeText={setF('email')} placeholder="Email" keyboardType="email-address" icon="mail-outline" autoCapitalize="none" />
            <PickerRow label="Gender" value={form.gender}
              options={[{ label: 'Male', value: 'male' }, { label: 'Female', value: 'female' }, { label: 'Other', value: 'other' }]}
              onSelect={setF('gender')} />
            <PickerRow label="Status" value={form.status}
              options={[{ label: 'Active', value: 'active' }, { label: 'Inactive', value: 'inactive' }, { label: 'On Leave', value: 'on_leave' }]}
              onSelect={setF('status')} />

            <SectionLabel title="Work" icon="briefcase-outline" />
            <Input label="Designation" value={form.designation} onChangeText={setF('designation')} placeholder="e.g. Technician" icon="ribbon-outline" />
            <PickerRow label="Department" value={form.department}
              options={deptChoices.map((d: string) => ({ label: d, value: d }))}
              onSelect={setF('department')} />
            <View style={{ marginBottom: 14 }}><Text style={{ fontSize: 13, fontWeight: '600', color: '#64748B', marginBottom: 6 }}>Joining Date</Text><DateField value={form.joining_date} onChange={setF('joining_date')} /></View>
            <Input label="Salary (₹/month)" value={form.salary_amount} onChangeText={setF('salary_amount')} placeholder="0" keyboardType="numeric" icon="cash-outline" />

            <SectionLabel title="Specializations" icon="star-outline" />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
              {SPECIALIZATIONS.map(s => {
                const active = selectedSpecs.includes(s);
                return (
                  <TouchableOpacity
                    key={s}
                    onPress={() => toggleSpec(s)}
                    style={{
                      paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
                      backgroundColor: active ? '#2563EB' : '#F1F3F9',
                      borderWidth: 1, borderColor: active ? '#2563EB' : '#EEF1F6',
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '600', color: active ? '#fff' : '#64748B' }}>{s}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <SectionLabel title="Identity" icon="card-outline" />
            <Input label="PAN Number" value={form.pan_number} onChangeText={setF('pan_number')} placeholder="ABCDE1234F" autoCapitalize="characters" icon="document-text-outline" />
            <Input label="Aadhar Number" value={form.aadhar_number} onChangeText={setF('aadhar_number')} placeholder="12-digit Aadhar" keyboardType="numeric" icon="shield-outline" />
            <Input label="ID Proof Type" value={form.id_proof_type} onChangeText={setF('id_proof_type')} placeholder="e.g. Aadhaar / Passport / Voter ID" icon="id-card-outline" />
            <Input label="ID Proof Number" value={form.id_proof_number} onChangeText={setF('id_proof_number')} placeholder="Document number" icon="document-outline" />

            <SectionLabel title="Address" icon="location-outline" />
            <Input label="Address" value={form.address} onChangeText={setF('address')} placeholder="Street address" multiline icon="home-outline" />
            <Input label="City" value={form.city} onChangeText={setF('city')} placeholder="City" icon="business-outline" />
            <Input label="State" value={form.state} onChangeText={setF('state')} placeholder="State" icon="map-outline" />

            <SectionLabel title="Bank Details" icon="wallet-outline" />
            <Input label="Bank Name" value={form.bank_name} onChangeText={setF('bank_name')} placeholder="Bank name" icon="business-outline" />
            <Input label="Account Number" value={form.bank_account_number} onChangeText={setF('bank_account_number')} placeholder="Account number" keyboardType="numeric" icon="card-outline" />
            <Input label="IFSC Code" value={form.bank_ifsc} onChangeText={setF('bank_ifsc')} placeholder="IFSC code" autoCapitalize="characters" icon="barcode-outline" />

            <SectionLabel title="Emergency Contact" icon="alert-circle-outline" />
            <Input label="Contact Name" value={form.emergency_contact_name} onChangeText={setF('emergency_contact_name')} placeholder="Name" icon="person-outline" />
            <Input label="Contact Phone" value={form.emergency_contact_phone} onChangeText={setF('emergency_contact_phone')} placeholder="Phone" keyboardType="phone-pad" icon="call-outline" />

            <View style={{ marginTop: 16 }}>
              <Button title="Save Member" onPress={onSave} loading={loading} icon="checkmark-circle-outline" />
            </View>
          </ScrollView>
        </SafeAreaView>
      </GlassBackground>
    </Modal>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function SectionLabel({ title, icon }: { title: string; icon: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10, marginTop: 18 }}>
      <Ionicons name={icon as any} size={14} color="#2563EB" />
      <Text style={{ fontSize: 11, fontWeight: '700', color: '#2563EB', letterSpacing: 0.8, textTransform: 'uppercase' }}>{title}</Text>
    </View>
  );
}

function PickerRow({ label, value, options, onSelect }: any) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={{ fontSize: 11, fontWeight: '600', color: '#64748B', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>{label}</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {options.map((opt: any) => (
          <TouchableOpacity
            key={opt.value}
            onPress={() => onSelect(opt.value)}
            style={{
              paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
              backgroundColor: value === opt.value ? '#2563EB' : '#F1F3F9',
              borderWidth: 1, borderColor: value === opt.value ? '#2563EB' : '#EEF1F6',
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: '600', color: value === opt.value ? '#fff' : '#64748B' }}>{opt.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 0.5, borderBottomColor: '#EEF1F6',
  },
  menuBtn: { padding: 4 },
  headerTitle: { fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 },
  headerSub: { fontSize: 12, color: '#64748B', fontWeight: '500', marginTop: 2 },
  addBtn: {
    width: 38, height: 38, borderRadius: 12,
    backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center',
  },
  tabRowScroll: {
    flexGrow: 0,
    borderBottomWidth: 0.5, borderBottomColor: '#EEF1F6',
  },
  tabRow: {
    flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 8, gap: 8, alignItems: 'center',
  },
  tab: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, backgroundColor: '#F1F3F9',
  },
  tabActive: { backgroundColor: '#2563EB' },
  tabLabel: { fontSize: 12, fontWeight: '700', color: '#64748B' },
  tabLabelActive: { color: '#fff' },
  searchRow: { paddingHorizontal: 16, paddingVertical: 8 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 14, borderWidth: 1, borderColor: '#EEF1F6',
    paddingHorizontal: 14, height: 44,
  },
  searchInput: { flex: 1, fontSize: 15, color: '#0F172A' },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16, borderWidth: 1, borderColor: '#EEF1F6',
    shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    marginBottom: 10, padding: 14,
  },
  avatar: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: '#EFF6FF',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#EEF1F6',
  },
  avatarText: { fontSize: 16, fontWeight: '800', color: '#2563EB' },
  memberName: { fontSize: 15, fontWeight: '700', color: '#0F172A' },
  memberMeta: { fontSize: 12, color: '#64748B', marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  badgeText: { fontSize: 10, fontWeight: '700', textTransform: 'capitalize' },
  selectedBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#EFF6FF', borderRadius: 12,
    padding: 12, marginBottom: 16,
  },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 0.5, borderBottomColor: '#EEF1F6',
  },
  modalTitle: { fontSize: 17, fontWeight: '800', color: '#0F172A' },
});
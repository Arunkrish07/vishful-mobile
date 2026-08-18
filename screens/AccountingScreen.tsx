import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, Alert, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { colors, spacing, borderRadius, fontSize, glass } from '../lib/theme';
import { Button, Input, Badge, EmptyState, LoadingScreen, PickerSelect, GlassBackground, DateField, SearchField, IconBtnSolid } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { Ionicons } from '@expo/vector-icons';
import { useMountedRef, isAbortError } from '../lib/safeAsync';

const statusColor = (s: string) => {
  switch (s) { case 'paid': return colors.success; case 'sent': return colors.primary;
    case 'partial': return colors.warning; case 'overdue': return colors.danger; default: return colors.textSecondary; }
};

export default function AccountingScreen() {
  const { token } = useAuth();
  const mounted = useMountedRef();

  const [invoices, setInvoices] = useState<any[] | null>(null);
  const [stays, setStays] = useState<any[]>([]);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  const [showAdd, setShowAdd] = useState(false);
  const [showPay, setShowPay] = useState<any>(null);
  const [tenantId, setTenantId] = useState('');
  const [month, setMonth] = useState('');
  const [rent, setRent] = useState('');
  const [elec, setElec] = useState('0');
  const [other, setOther] = useState('0');
  const [dueDate, setDueDate] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payMode, setPayMode] = useState('cash');
  const [payRef, setPayRef] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!token) return;
    setInvoices(null);
    Promise.all([
      sb.listInvoices(),
      sb.listBillingTenants(),
      sb.getPendingDues(),
    ]).then(([inv, s, dues]: any) => {
      if (!mounted.current) return;
      setInvoices(inv ?? []);
      setStays(s ?? []);
      setPendingTotal(dues?.totalPending ?? 0);
    }).catch((e: any) => {
      if (!mounted.current || isAbortError(e)) return;
      setInvoices([]);
      setStays([]);
      setPendingTotal(0);
    });
  }, [token, refreshKey]);

  const handleCreate = async () => {
    if (!tenantId || !month) { Alert.alert('Error', 'Select tenant and billing month'); return; }
    const activeStay = stays.find((s: any) => s.tenantId === tenantId && s.status === 'active');
    if (!activeStay) { Alert.alert('Error', 'Tenant has no active stay'); return; }
    // listBillingTenants now returns the real monthly_rental, so default to it when
    // the rent field is left blank; a manual entry still overrides.
    const rentAmount = Number(rent) || Number(activeStay.monthlyRent) || 0;
    if (!rentAmount || rentAmount <= 0) { Alert.alert('Error', 'Enter a rent amount greater than 0'); return; }
    setLoading(true);
    try {
      await sb.createInvoice({
        token: token!,
        tenantId,
        allotmentId: activeStay.allotmentId,
        propertyId: activeStay.propertyId,
        apartmentId: activeStay.apartmentId,
        bedId: activeStay.bedId,
        billingMonth: month,
        rentAmount,
        electricityAmount: Number(elec) || 0,
        otherCharges: Number(other) || 0,
        // Web parity: default due date is the 7th of the billing month (not now+7d).
        dueDate: dueDate || (/^\d{4}-\d{2}$/.test(month) ? `${month}-07` : new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]),
      });
      setShowAdd(false);
      setTenantId(''); setMonth(''); setRent(''); setElec('0'); setOther('0');
      setRefreshKey((k: number) => k + 1);
    } catch (e: any) { Alert.alert('Error', e.message); }
    setLoading(false);
  };

  const handlePayment = async () => {
    if (!payAmount || !showPay) return;
    const balance = Number(showPay.totalAmount || 0) - Number(showPay.paidAmount || 0);
    const amt = Number(payAmount);
    if (!(amt > 0)) { Alert.alert('Invalid amount', 'Enter a payment amount greater than 0.'); return; }
    if (amt > balance + 0.01) { Alert.alert('Amount too high', `Payment cannot exceed the outstanding balance of Rs ${balance.toLocaleString('en-IN')}.`); return; }
    setLoading(true);
    try {
      await sb.recordPayment({
        token: token!,
        invoiceId: showPay._id,
        paymentDate: new Date().toISOString().split('T')[0],
        paymentMode: payMode,
        amountPaid: amt,
        referenceNumber: payRef.trim() || null,
      });
      setShowPay(null); setPayAmount(''); setPayRef('');
      setRefreshKey((k: number) => k + 1);
    } catch (e: any) { Alert.alert('Error', e.message); }
    setLoading(false);
  };

  if (!invoices) return <LoadingScreen />;

  const filtered = (filter === 'all' ? invoices : invoices.filter((i: any) => i.status === filter))
    .filter((i: any) => {
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return [i.invoiceNumber, i.tenantName, i.propertyName, i.billingMonth, i.status]
        .filter(Boolean).some((v: any) => String(v).toLowerCase().includes(q));
    });
  const activeStays = stays.filter((s: any) => s.status === 'active');
  const tenantOpts = activeStays.map((s: any) => ({ label: `${s.tenantName} (${s.bedCode})`, value: s.tenantId }));
  const payModes = [
    { label: 'Cash', value: 'cash' },
    { label: 'UPI', value: 'upi' },
    { label: 'Bank Transfer', value: 'bank' },
    { label: 'Card', value: 'card' },
  ];

  // Canonical AR from v_tenant_current_dues (see getPendingDues) — not a client-side invoice sum.
  const totalPending = pendingTotal;

  return (
    <GlassBackground>
    <SafeAreaView style={{ flex: 1 }} edges={['top']}>
      <View style={[glass.header, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg }]}>
        <View style={{ width: 38, height: 28, overflow: 'hidden', alignItems: 'center', marginRight: 10 }}>
          <Image source={require('../assets/vishful-logo-DPK24n8p.webp')} style={{ width: 38, height: 44, resizeMode: 'contain' }} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 }}>Accounts</Text>
        </View>
        <IconBtnSolid onPress={() => setShowAdd(true)} />
      </View>
      {totalPending > 0 && (
        <View style={styles.pendingBanner}>
          <Ionicons name="alert-circle" size={18} color={colors.danger} />
          <Text style={styles.pendingText}>Pending: Rs {totalPending.toLocaleString()}</Text>
        </View>
      )}
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        <SearchField value={search} onChangeText={setSearch} placeholder="Search accounts..." />
      </View>
      <ScrollView horizontal style={styles.filters} showsHorizontalScrollIndicator={false}>
        {['all', 'sent', 'partial', 'paid', 'overdue'].map(f => (
          <TouchableOpacity key={f} style={[styles.filterChip, filter === f && styles.filterActive]} onPress={() => setFilter(f)}>
            <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>{f}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.xl, paddingBottom: 100 }}>
        {filtered.length === 0 ? (
          <EmptyState title="No Invoices" subtitle="Create invoices for tenant billing" icon="receipt-outline" />
        ) : filtered.map((inv: any) => (
          <TouchableOpacity key={inv._id} style={styles.card} onPress={() => setShowPay(inv)}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={styles.invNum}>{inv.invoiceNumber}</Text>
              <Badge text={inv.status} color={statusColor(inv.status)} />
            </View>
            <Text style={styles.cardTitle}>{inv.tenantName}</Text>
            <Text style={styles.cardSub}>{inv.billingMonth} | {inv.propertyName}</Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
              <View>
                <Text style={styles.cardSub}>Rent: Rs {inv.rentAmount}</Text>
                {inv.electricityAmount > 0 && <Text style={styles.cardSub}>Elec: Rs {inv.electricityAmount}</Text>}
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text }}>Rs {inv.totalAmount}</Text>
                {inv.paidAmount > 0 && <Text style={{ fontSize: fontSize.sm, color: colors.success }}>Paid: Rs {inv.paidAmount}</Text>}
              </View>
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Create Invoice */}
      <Modal visible={showAdd} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={[glass.header, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg }]}>
            <TouchableOpacity onPress={() => setShowAdd(false)}>
              <Text style={{ color: colors.danger }}>Cancel</Text>
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text }}>New Invoice</Text>
            <View style={{ width: 50 }} />
          </View>
          <ScrollView style={{ padding: spacing.xl }}>
            <PickerSelect label="Tenant" value={tenantId} options={tenantOpts} onSelect={setTenantId} />
            <Input label="Billing Month (YYYY-MM)" value={month} onChangeText={setMonth} placeholder="2025-01" />
            <Input label="Rent Amount" value={rent} onChangeText={setRent} placeholder="Monthly rent" keyboardType="numeric" />
            <Input label="Electricity Amount" value={elec} onChangeText={setElec} placeholder="0" keyboardType="numeric" />
            <Input label="Other Charges" value={other} onChangeText={setOther} placeholder="0" keyboardType="numeric" />
            <View style={{ marginBottom: 14 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: '#556274', marginBottom: 6 }}>Due Date</Text>
              <DateField value={dueDate} onChange={setDueDate} />
            </View>
            <Button title="Create Invoice" onPress={handleCreate} loading={loading} icon="receipt-outline" />
          </ScrollView>
        </SafeAreaView>
        </GlassBackground>
      </Modal>

      {/* Record Payment */}
      <Modal visible={!!showPay} animationType="slide" presentationStyle="pageSheet">
        <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={[glass.header, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg }]}>
            <TouchableOpacity onPress={() => setShowPay(null)}>
              <Text style={{ color: colors.danger }}>Close</Text>
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: colors.text }}>{showPay?.invoiceNumber}</Text>
            <View style={{ width: 50 }} />
          </View>
          {showPay && (
            <ScrollView style={{ padding: spacing.xl }}>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryLabel}>Total Amount</Text>
                <Text style={styles.summaryValue}>Rs {showPay.totalAmount}</Text>
                <Text style={styles.summaryLabel}>Paid</Text>
                <Text style={[styles.summaryValue, { color: colors.success }]}>Rs {showPay.paidAmount}</Text>
                <Text style={styles.summaryLabel}>Balance</Text>
                <Text style={[styles.summaryValue, { color: colors.danger }]}>Rs {showPay.totalAmount - showPay.paidAmount}</Text>
              </View>
              {showPay.status !== 'paid' && (
                <>
                  <Input label="Amount" value={payAmount} onChangeText={setPayAmount}
                    placeholder={String(showPay.totalAmount - showPay.paidAmount)} keyboardType="numeric" />
                  <PickerSelect label="Payment Mode" value={payMode} options={payModes} onSelect={setPayMode} />
                  <Input label="Reference No. (UTR / txn ref)" value={payRef} onChangeText={setPayRef} placeholder="Optional — bank/UPI reference" />
                  <Button title="Record Payment" onPress={handlePayment} loading={loading} icon="cash-outline" />
                </>
              )}
            </ScrollView>
          )}
        </SafeAreaView>
        </GlassBackground>
      </Modal>
    </SafeAreaView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: spacing.xl, paddingVertical: spacing.lg,
  },
  title: { fontSize: fontSize.xl, fontWeight: '700', color: colors.text },
  addBtn: { width: 40, height: 40, borderRadius: 14, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    shadowColor: colors.primary, shadowOpacity: 0.4, shadowRadius: 10, elevation: 5 },
  pendingBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.dangerLight, padding: spacing.md, paddingHorizontal: spacing.xl },
  pendingText: { fontSize: fontSize.sm, color: colors.danger, fontWeight: '600' },
  filters: { backgroundColor: 'rgba(255,255,255,0.5)', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, maxHeight: 50,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.3)' },
  filterChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.6)', marginRight: 8,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' },
  filterActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterText: { fontSize: fontSize.sm, color: colors.textSecondary, textTransform: 'capitalize', fontWeight: '600' },
  filterTextActive: { color: colors.white, fontWeight: '700' },
  card: {
    backgroundColor: '#FFFFFF', borderRadius: 14, padding: spacing.lg,
    marginBottom: spacing.md, borderWidth: 1, borderColor: '#E5E7EB',
    shadowColor: '#1D4ED8', shadowOpacity: 0.06, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 3,
  },
  invNum: { fontSize: fontSize.xs, fontWeight: '700', color: colors.primary },
  cardTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  cardSub: { fontSize: fontSize.sm, color: colors.textSecondary },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#E5E7EB',
  },
  summaryCard: {
    backgroundColor: '#FFFFFF', borderRadius: 14, padding: spacing.xl, marginBottom: spacing.xl,
    borderWidth: 1, borderColor: '#E5E7EB',
  },
  summaryLabel: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 8 },
  summaryValue: { fontSize: fontSize.xl, fontWeight: '700', color: colors.text },
});
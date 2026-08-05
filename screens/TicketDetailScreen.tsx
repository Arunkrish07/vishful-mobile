import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Modal, KeyboardAvoidingView, Platform,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { GlassBackground, DateField } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/ThemeContext';
import { glass, spacing, borderRadius, fontSize } from '../lib/theme';
import {
  fetchTicket, fetchTicketLogs, fetchCostEstimates, fetchPurchases,
  updateTicketStatus, reassignTicket, submitDiagnosis, submitCostEstimates,
  approveCostEstimate, recordPurchase, tenantApproveCompletion, adminApproveCompletion,
  fetchTeamMembers, fetchDiagnosticSession,
  getNextStatuses, STATUS_CONFIG, PRIORITY_CONFIG,
  Ticket, CostEstimate, TicketLog, TeamMember,
  uploadTicketPhoto,
} from '../services/ticketService';
import {
  fetchResolution, fetchBankAccounts, fetchVendors,
  saveResolution, deleteResolution,
  unlockResolutionEditing as unlockResolutionEditingService,
  ocrPaymentImage, syncTicketResolutionExpense,
  populateFormFromResolution, DEFAULT_RESOLUTION_FORM,
  BankAccount, TicketResolutionForm, ResolutionItem,
} from '../services/ticketResolutionService';
import * as sb from '../lib/supabaseService';

type ActiveTab = 'details' | 'diagnosis' | 'costs' | 'timeline';

export default function TicketDetailScreen({ route, navigation }: any) {
  const { ticketId } = route.params;
  const { colors } = useTheme();
  const { user } = useAuth();
  const rawRole = user?.role || '';
  const role = ['org_admin', 'super_admin', 'property_manager', 'admin', 'pm'].includes(rawRole) ? 'admin' : rawRole || 'admin';

  // ── Core data ──────────────────────────────────────────────────────────────
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [logs, setLogs] = useState<TicketLog[]>([]);
  const [estimates, setEstimates] = useState<CostEstimate[]>([]);
  const [purchases, setPurchases] = useState<any[]>([]);
  const [diagSession, setDiagSession] = useState<any>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [costApprovers, setCostApprovers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('details');

  // ── Resolution ─────────────────────────────────────────────────────────────
  const [resolution, setResolution] = useState<any>(null);
  const [resolutionForm, setResolutionForm] = useState<TicketResolutionForm>(DEFAULT_RESOLUTION_FORM);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [resolutionEditMode, setResolutionEditMode] = useState(false);
  const [resolutionEditUnlocked, setResolutionEditUnlocked] = useState(false);
  const [showResolutionForm, setShowResolutionForm] = useState(false);
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const [unlockReason, setUnlockReason] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [paymentOcrLoading, setPaymentOcrLoading] = useState(false);
  const [paymentOcrMeta, setPaymentOcrMeta] = useState<{ bankName?: string; amount?: number } | null>(null);
  const [savingResolution, setSavingResolution] = useState(false);

  // ── Modals ─────────────────────────────────────────────────────────────────
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [showReassignModal, setShowReassignModal] = useState(false);
  const [showDiagModal, setShowDiagModal] = useState(false);
  const [showCostModal, setShowCostModal] = useState(false);
  const [showPurchaseModal, setShowPurchaseModal] = useState(false);
  const [showApprovalModal, setShowApprovalModal] = useState(false);

  const [statusNotes, setStatusNotes] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const costSubmitGuard = useRef(false);

  // ── Computed ───────────────────────────────────────────────────────────────
  const isResolutionReadOnly = ticket?.status === 'closed' && !resolutionEditUnlocked;

  // ── Load ───────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const [t, l, e, p, d, members, res, banks, vends, approvers] = await Promise.all([
        fetchTicket(ticketId),
        fetchTicketLogs(ticketId),
        fetchCostEstimates(ticketId),
        fetchPurchases(ticketId),
        fetchDiagnosticSession(ticketId),
        fetchTeamMembers(),
        fetchResolution(ticketId),
        fetchBankAccounts(),
        fetchVendors(),
        sb.getCostApprovers().catch(() => []),
      ]);
      setTicket(t);
      setLogs(l);
      setEstimates(e);
      setPurchases(p);
      setDiagSession(d);
      setTeamMembers(members);
      setCostApprovers(Array.isArray(approvers) ? approvers : []);
      setResolution(res);
      setBankAccounts(banks);
      setVendors(vends);

      if (res) {
        setResolutionForm(populateFormFromResolution(res));
        setResolutionEditMode(false);
      } else {
        setResolutionForm(DEFAULT_RESOLUTION_FORM);
        setResolutionEditMode(true);
      }
      setResolutionEditUnlocked((t?.status || '') !== 'closed');
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => { load(); }, [load]);

  // ── Status change ──────────────────────────────────────────────────────────
  async function handleStatusChange(newStatus: string) {
    if (!ticket) return;
    if (submitting) return;

    if (newStatus === 'completed') {
      const isAdminCreated = !ticket.tenant_id;
      const recipient = isAdminCreated ? 'Admin' : (ticket.tenant_name || 'Tenant');
      Alert.alert(
        'Send Approval Request?',
        `This will send an approval request to ${recipient}. They must approve before the ticket is closed.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Send Request',
            onPress: async () => {
              setSubmitting(true);
              try {
                await updateTicketStatus(ticket.id, newStatus, user?.userId || '', {
                  notes: statusNotes, rejectionReason,
                });
                setShowStatusModal(false);
                setStatusNotes('');
                setRejectionReason('');
                await load();
                Alert.alert('Request Sent', `Approval request sent to ${recipient}.`);
              } catch (e: any) {
                Alert.alert('Error', e?.message || 'Failed to update status');
              } finally {
                setSubmitting(false);
              }
            },
          },
        ]
      );
      return;
    }

    setSubmitting(true);
    try {
      const result = await updateTicketStatus(ticket.id, newStatus, user?.userId || '', {
        notes: statusNotes, rejectionReason,
      });
      setShowStatusModal(false);
      setStatusNotes('');
      setRejectionReason('');
      await load();
      Alert.alert('Success', `Ticket status updated to ${STATUS_CONFIG[result.newStatus]?.label || result.newStatus}`);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to update status');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Unlock closed ticket ───────────────────────────────────────────────────
  async function handleUnlock() {
    if (!ticket) return;
    setUnlocking(true);
    try {
      await unlockResolutionEditingService({
        ticketId: ticket.id,
        organizationId: (ticket as any).organization_id || '',
        userId: user?.userId || '',
        reason: unlockReason,
      });
      setResolutionEditUnlocked(true);
      setResolutionEditMode(true);
      setShowUnlockModal(false);
      setShowResolutionForm(true);
      setUnlockReason('');
      await load();
      Alert.alert('Editing Unlocked', 'You can now edit the resolution without changing the ticket status.');
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to unlock');
    } finally {
      setUnlocking(false);
    }
  }

  // ── Save resolution ────────────────────────────────────────────────────────
  async function handleSaveResolution() {
    if (!ticket) return;

    const totalParts = resolutionForm.items.reduce((s, i) => s + i.total, 0);
    const totalCost = totalParts + (Number(resolutionForm.total_labour_cost) || 0);

    if (totalCost > 0) {
      if (!resolutionForm.payment_date) {
        Alert.alert('Required', 'Payment date is required when cost is greater than 0.');
        return;
      }
      if (!resolutionForm.bank_account_id) {
        Alert.alert('Required', 'Bank account is required when cost is greater than 0.');
        return;
      }
      if (!resolutionForm.payment_reference_no?.trim()) {
        Alert.alert('Required', 'Payment reference number is required.');
        return;
      }
      if (!resolutionForm.proof_of_purchase_url) {
        Alert.alert('Required', 'Proof of purchase is required when cost is greater than 0.');
        return;
      }
      // If a payment proof was uploaded and OCR extracted an amount, validate it matches
      if (resolutionForm.proof_of_payment_url && paymentOcrMeta?.amount != null) {
        const ocrAmount = Math.round(paymentOcrMeta.amount);
        const formAmount = Math.round(totalCost);
        if (ocrAmount !== formAmount) {
          Alert.alert(
            'Amount Mismatch',
            `The payment screenshot shows ₹${ocrAmount.toLocaleString('en-IN')} but the total cost is ₹${formAmount.toLocaleString('en-IN')}. Please upload the correct payment proof or adjust the cost details to match.`,
            [{ text: 'OK' }]
          );
          return;
        }
      }
    }

    setSavingResolution(true);
    try {
      const resolutionId = await saveResolution({
        ticketId: ticket.id,
        organizationId: (ticket as any).organization_id || '',
        form: resolutionForm,
        existingResolutionId: resolution?.id ?? null,
      });

      // Sync to Accounting Expense table
      await syncTicketResolutionExpense({
        ticket: {
          id: ticket.id,
          organization_id: (ticket as any).organization_id || '',
          property_id: (ticket as any).property_id,
          apartment_id: (ticket as any).apartment_id,
          bed_id: (ticket as any).bed_id,
          issue_type_id: (ticket as any).issue_type_id,
          asset_id: (ticket as any).asset_id,
          ticket_number: (ticket as any).ticket_number,
        },
        resolutionId,
        totalCost,
        paymentDate: resolutionForm.payment_date || null,
        vendorId: resolutionForm.vendor_id || null,
        proofOfPurchaseUrl: resolutionForm.proof_of_purchase_url,
        closureSummary: resolutionForm.closure_summary,
      });

      setShowResolutionForm(false);
      setResolutionEditMode(false);
      await load();
      Alert.alert('Saved', 'Resolution details saved and synced to Accounting.');
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to save resolution');
    } finally {
      setSavingResolution(false);
    }
  }

  // ── OCR payment image ──────────────────────────────────────────────────────
  async function handleProofOfPaymentUpload(url: string | null) {
    setResolutionForm((p) => ({ ...p, proof_of_payment_url: url }));
    setPaymentOcrMeta(null);
    if (!url) return;

    const lower = url.toLowerCase();
    const isImage = lower.includes('.jpg') || lower.includes('.jpeg') || lower.includes('.png') || lower.includes('.webp');
    if (!isImage) return;

    setPaymentOcrLoading(true);
    try {
      const result = await ocrPaymentImage(url, bankAccounts);
      setResolutionForm((p) => ({
        ...p,
        payment_reference_no: result.reference || p.payment_reference_no,
        payment_date: result.paymentDate || p.payment_date,
        bank_account_id: result.matchedBankAccountId || p.bank_account_id,
      }));
      setPaymentOcrMeta({
        bankName: result.bankName,
        amount: result.amount,
      });
      const parts = [
        result.reference && `Reference: ${result.reference}`,
        result.paymentDate && `Date: ${formatDate(result.paymentDate, '')}`,
        result.matchedBankAccountId && 'Bank account matched.',
        result.amount && `Amount: ₹${Math.round(result.amount)}`,
        result.bankName && !result.matchedBankAccountId && `Bank on receipt: ${result.bankName}`,
      ].filter(Boolean).join(' · ');
      if (parts) Alert.alert('Payment Details Filled', parts);
    } catch (e: any) {
      Alert.alert('OCR Failed', e.message || 'Enter payment details manually.');
    } finally {
      setPaymentOcrLoading(false);
    }
  }

  if (loading || !ticket) {
    return (
      <GlassBackground>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color="#7B2FBE" />
        </View>
      </GlassBackground>
    );
  }

  const statusCfg = STATUS_CONFIG[ticket.status] || STATUS_CONFIG.open;
  const priorityCfg = PRIORITY_CONFIG[ticket.priority] || PRIORITY_CONFIG.medium;
  const nextStatuses = getNextStatuses(ticket.status, role);
  const isSlaBreached = ticket.sla_deadline && new Date(ticket.sla_deadline) < new Date()
    && !['closed', 'completed'].includes(ticket.status);
  const isAssignedTechnician = role === 'technician' && ticket.assigned_to === (user?.supabaseUserId || user?.userId);
  const isAdmin = role === 'admin' || role === 'pm';
  const isTenant = role === 'tenant';

  // ── Scoped cost-estimate approval gating ────────────────────────────────────
  // Only users configured in cost_estimate_approvers (matching scope) may approve/
  // decline estimates. super_admin is never blocked. When NO approver rules exist
  // at all, fall back to admin (existing behavior) so approvals don't dead-end.
  const isSuperAdmin = (user?.role || '') === 'super_admin';
  const currentUserId = user?.supabaseUserId || user?.userId;
  const canApproveCost = isSuperAdmin || costApprovers.length === 0 || costApprovers.some((a: any) => {
    if (String(a.approver_user_id) !== String(currentUserId)) return false;
    if (a.scope_type === 'global') return true;
    if (a.scope_type === 'property' && a.property_id && a.property_id === (ticket as any).property_id) return true;
    if (a.scope_type === 'issue_type' && a.issue_type_id && a.issue_type_id === (ticket as any).issue_type_id) return true;
    return false;
  });
  // Tenants must use the approval flow only (Accept & Close / Not Resolved) —
  // web has no generic status dropdown for tenants, so exclude them here to
  // avoid bypassing the required-reason rework flow (tenantApproveCompletion).
  const canUpdateStatus = (isAssignedTechnician && nextStatuses.length > 0) ||
    (isAdmin && nextStatuses.length > 0);

  // Show resolution form for completed/closed tickets or when admin triggers it
  const showResolutionSection = ['completed', 'pending_tenant_approval', 'pending_admin_approval', 'closed'].includes(ticket.status);

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* Header */}
        <View style={[glass.header, {
          flexDirection: 'row', alignItems: 'center',
          paddingHorizontal: spacing.xl, paddingVertical: spacing.lg,
        }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={{ marginRight: 12 }}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary, fontWeight: '600' }}>TICKET</Text>
            <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: colors.text }}>{(ticket as any).ticket_number}</Text>
          </View>
          <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: statusCfg.bg }}>
            <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: statusCfg.color }}>{statusCfg.label}</Text>
          </View>
        </View>

        {/* SLA breach banner — SLA/timer info is hidden from tenants (web parity) */}
        {isSlaBreached && !isTenant && (
          <View style={{ backgroundColor: '#FEE2E2', paddingHorizontal: spacing.xl, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name="warning-outline" size={16} color="#DC2626" />
            <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#DC2626' }}>
              SLA BREACHED — Due: {new Date(ticket.sla_deadline!).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
            </Text>
          </View>
        )}

        {/* Tab bar — hidden for tenants (they see only Details, like the web) */}
        {!isTenant && (
        <View style={{ flexDirection: 'row', paddingHorizontal: spacing.xl, paddingTop: spacing.sm, gap: 4 }}>
          {(['details', 'diagnosis', 'costs', 'timeline'] as ActiveTab[]).map(tab => (
            <TouchableOpacity
              key={tab}
              onPress={() => setActiveTab(tab)}
              style={{
                flex: 1, paddingVertical: 8, borderRadius: borderRadius.md, alignItems: 'center',
                backgroundColor: activeTab === tab ? '#7B2FBE' : colors.surface,
                borderWidth: 1, borderColor: activeTab === tab ? '#7B2FBE' : colors.border,
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: '700', color: activeTab === tab ? '#fff' : colors.textSecondary }}>
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        )}

        <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 160, gap: 12 }}>
          {/* Admin completion-review banner — modal is dismissable now, so give the
              admin an explicit entry point after reviewing the tabs. */}
          {isAdmin && ticket.status === 'pending_admin_approval' && (
            <TouchableOpacity
              onPress={() => setShowApprovalModal(true)}
              style={{ backgroundColor: '#FFFBEB', borderColor: '#FDE68A', borderWidth: 1, borderRadius: borderRadius.lg, padding: spacing.md, flexDirection: 'row', alignItems: 'center', gap: 10 }}
            >
              <Ionicons name="hourglass" size={20} color="#D97706" />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: '#B45309' }}>Awaiting Your Review</Text>
                <Text style={{ fontSize: fontSize.xs, color: '#5C4B70' }}>Review the work, then approve to close or send back for rework.</Text>
              </View>
              <View style={{ backgroundColor: '#7B2FBE', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
                <Text style={{ fontSize: 11, fontWeight: '800', color: '#fff' }}>Review</Text>
              </View>
            </TouchableOpacity>
          )}
          {activeTab === 'details' && (
            <DetailsTab
              ticket={ticket}
              priorityCfg={priorityCfg}
              statusCfg={statusCfg}
              resolution={resolution}
              isAdmin={isAdmin}
              isTenant={isTenant}
              isResolutionReadOnly={isResolutionReadOnly}
              resolutionEditUnlocked={resolutionEditUnlocked}
              bankAccounts={bankAccounts}
              onEdit={() => { setResolutionEditMode(true); setShowResolutionForm(true); }}
              onUnlock={() => setShowUnlockModal(true)}
              onAdd={() => { setResolutionEditMode(true); setShowResolutionForm(true); }}
              onOpenApproval={() => setShowApprovalModal(true)}
              showResolutionSection={showResolutionSection}
            />
          )}
          {!isTenant && activeTab === 'diagnosis' && (
            <DiagnosisTab
              ticket={ticket}
              diagSession={diagSession}
              isAssignedTechnician={isAssignedTechnician}
              onOpen={() => setShowDiagModal(true)}
            />
          )}
          {!isTenant && activeTab === 'costs' && (
            <CostsTab
              ticket={ticket}
              estimates={estimates}
              purchases={purchases}
              isAssignedTechnician={isAssignedTechnician}
              isAdmin={isAdmin}
              canApproveCost={canApproveCost}
              userId={user?.userId || ''}
              onSubmitCosts={() => setShowCostModal(true)}
              onRecordPurchase={() => setShowPurchaseModal(true)}
              onApprove={() => setShowApprovalModal(true)}
              onRefresh={load}
            />
          )}
          {!isTenant && activeTab === 'timeline' && (
            <TimelineTab logs={logs} />
          )}
        </ScrollView>

        {/* Action Buttons */}
        <View style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          padding: spacing.xl, paddingBottom: 32, gap: 10,
          backgroundColor: 'rgba(255,255,255,0.9)',
          borderTopWidth: 1, borderTopColor: colors.border,
        }}>
          {canUpdateStatus && nextStatuses.length > 0 && (
            <TouchableOpacity
              onPress={() => setShowStatusModal(true)}
              style={{ backgroundColor: '#7B2FBE', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center' }}
            >
              <Text style={{ color: '#fff', fontSize: fontSize.md, fontWeight: '800' }}>Update Status</Text>
            </TouchableOpacity>
          )}

          {/* Admin can (re)assign at any active work stage — backend resets status→assigned + SLA.
              Excluded: terminal (closed/cancelled/completed) and approval-pending states. */}
          {isAdmin && ['open', 'assigned', 'in_progress', 'waiting_for_parts', 'waiting_for_cost_approval', 'on_hold', 'reopened', 'reassigned'].includes(ticket.status) && (
            <TouchableOpacity
              onPress={() => setShowReassignModal(true)}
              style={{ backgroundColor: '#E8841A', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center' }}
            >
              <Text style={{ color: '#fff', fontSize: fontSize.md, fontWeight: '800' }}>
                {ticket.status === 'open' ? 'Assign Technician' : 'Reassign Technician'}
              </Text>
            </TouchableOpacity>
          )}

          {isAssignedTechnician && ticket.status === 'in_progress' && !diagSession && (
            <TouchableOpacity
              onPress={() => setShowDiagModal(true)}
              style={{ backgroundColor: '#0369A1', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center' }}
            >
              <Text style={{ color: '#fff', fontSize: fontSize.md, fontWeight: '800' }}>Run Diagnosis</Text>
            </TouchableOpacity>
          )}

          {isAssignedTechnician && ticket.status === 'in_progress' && estimates.length === 0 && (
            <TouchableOpacity
              onPress={() => setShowCostModal(true)}
              style={{ backgroundColor: '#16A34A', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center' }}
            >
              <Text style={{ color: '#fff', fontSize: fontSize.md, fontWeight: '800' }}>Submit Cost Estimate</Text>
            </TouchableOpacity>
          )}

          {isAssignedTechnician && ticket.status === 'waiting_for_parts' && purchases.length === 0 && (
            <TouchableOpacity
              onPress={() => setShowPurchaseModal(true)}
              style={{ backgroundColor: '#16A34A', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center' }}
            >
              <Text style={{ color: '#fff', fontSize: fontSize.md, fontWeight: '800' }}>Record Purchase</Text>
            </TouchableOpacity>
          )}

          {/* Resolution button — for completed/closed tickets */}
          {showResolutionSection && !resolution && (isAdmin || isAssignedTechnician) && (
            <TouchableOpacity
              onPress={() => { setResolutionEditMode(true); setShowResolutionForm(true); }}
              style={{ backgroundColor: '#1D4ED8', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center' }}
            >
              <Text style={{ color: '#fff', fontSize: fontSize.md, fontWeight: '800' }}>Add Resolution Details</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── MODALS ─────────────────────────────────────────────────────── */}
        <StatusModal
          visible={showStatusModal}
          onClose={() => setShowStatusModal(false)}
          nextStatuses={nextStatuses}
          statusNotes={statusNotes}
          setStatusNotes={setStatusNotes}
          rejectionReason={rejectionReason}
          setRejectionReason={setRejectionReason}
          onSubmit={handleStatusChange}
          submitting={submitting}
          currentStatus={ticket.status}
        />

        <ReassignModal
          visible={showReassignModal}
          onClose={() => setShowReassignModal(false)}
          teamMembers={teamMembers}
          onReassign={async (memberId: string, notes: string) => {
            setSubmitting(true);
            try {
              await reassignTicket(ticket.id, memberId, user?.userId || '', notes);
              setShowReassignModal(false);
              await load();
            } catch (e: any) { Alert.alert('Error', e.message); }
            finally { setSubmitting(false); }
          }}
          submitting={submitting}
        />

        <DiagnosisModal
          visible={showDiagModal}
          onClose={() => setShowDiagModal(false)}
          ticketId={ticket.id}
          issueTypeId={(ticket as any).issue_type_id}
          userId={user?.userId || ''}
          onSubmit={async (args: any) => {
            setSubmitting(true);
            try {
              await submitDiagnosis(args);
              setShowDiagModal(false);
              await load();
              Alert.alert('Success', 'Diagnosis submitted');
            } catch (e: any) { Alert.alert('Error', e.message); }
            finally { setSubmitting(false); }
          }}
          submitting={submitting}
        />

        <CostEstimateModal
          visible={showCostModal}
          onClose={() => setShowCostModal(false)}
          guard={costSubmitGuard}
          onSubmit={async (items: any) => {
            if (costSubmitGuard.current) return;
            costSubmitGuard.current = true;
            setSubmitting(true);
            try {
              const total = (items || []).reduce((s: number, i: any) => s + (i.quantity || 1) * (i.unit_price || 0), 0);
              if (total <= 0) {
                // "No cost required" — a ₹0 estimate dead-ends in waiting_for_parts
                // (backend auto-approve is gated on cost > 0), so move the ticket back
                // toward completion instead of routing through cost approval.
                await updateTicketStatus(ticket.id, 'in_progress', user?.userId || '', { notes: 'No cost required — proceeding without parts/payment.' });
              } else {
                await submitCostEstimates(ticket.id, items, user?.userId || '');
              }
              setShowCostModal(false);
              await load();
              Alert.alert('Success', total <= 0 ? 'No cost required — ticket moved to In Progress' : 'Cost estimates submitted for approval');
            } catch (e: any) { Alert.alert('Error', e.message); costSubmitGuard.current = false; }
            finally { setSubmitting(false); }
          }}
          submitting={submitting}
        />

        <PurchaseModal
          visible={showPurchaseModal}
          onClose={() => setShowPurchaseModal(false)}
          onSubmit={async (args: any) => {
            setSubmitting(true);
            try {
              await recordPurchase({ ...args, ticketId: ticket.id, purchasedBy: user?.userId || '' });
              setShowPurchaseModal(false);
              await load();
              Alert.alert('Success', 'Purchase recorded');
            } catch (e: any) { Alert.alert('Error', e.message); }
            finally { setSubmitting(false); }
          }}
          submitting={submitting}
          vendors={vendors}
        />

        {(ticket.status === 'pending_tenant_approval' || ticket.status === 'pending_admin_approval') && (
          <ApprovalModal
            visible={showApprovalModal}
            onClose={() => setShowApprovalModal(false)}
            onApprove={async (approved: boolean, reason?: string) => {
              setSubmitting(true);
              try {
                if (ticket.status === 'pending_admin_approval') {
                  await adminApproveCompletion(ticket.id, approved, user?.userId || '', reason);
                } else {
                  await tenantApproveCompletion(ticket.id, approved, user?.userId || '', reason);
                }
                await load();
                Alert.alert(
                  approved ? 'Ticket Closed' : 'Sent Back',
                  approved ? 'Ticket has been closed successfully.' : 'Ticket returned to in-progress.'
                );
              } catch (e: any) { Alert.alert('Error', e.message); }
              finally { setSubmitting(false); }
            }}
            submitting={submitting}
          />
        )}

        {/* Unlock Resolution Editing (Admin only) */}
        <UnlockModal
          visible={showUnlockModal}
          onClose={() => { setShowUnlockModal(false); setUnlockReason(''); }}
          reason={unlockReason}
          setReason={setUnlockReason}
          onUnlock={handleUnlock}
          loading={unlocking}
        />

        {/* Resolution Form Modal */}
        <ResolutionFormModal
          visible={showResolutionForm}
          onClose={() => setShowResolutionForm(false)}
          form={resolutionForm}
          setForm={setResolutionForm}
          vendors={vendors}
          bankAccounts={bankAccounts}
          isReadOnly={isResolutionReadOnly}
          paymentOcrLoading={paymentOcrLoading}
          paymentOcrMeta={paymentOcrMeta}
          onProofOfPaymentChange={handleProofOfPaymentUpload}
          onSave={handleSaveResolution}
          saving={savingResolution}
          ticketId={ticket.id}
          totalCostFromParent={
            resolutionForm.items.reduce((s, i) => s + i.total, 0) +
            (Number(resolutionForm.total_labour_cost) || 0)
          }
        />
      </SafeAreaView>
    </GlassBackground>
  );
}

// ─── DETAILS TAB ──────────────────────────────────────────────────────────────

function DetailsTab({ ticket, priorityCfg, statusCfg, resolution, isAdmin, isTenant, isResolutionReadOnly,
  resolutionEditUnlocked, bankAccounts, onEdit, onUnlock, onAdd, onOpenApproval, showResolutionSection }: any) {
  const { colors } = useTheme();
  return (
    <>
      <View style={glass.card}>
        {(ticket as any).created_by_name && (
          <Row label="Created By" value={`${(ticket as any).created_by_name}${(ticket as any).is_creator_tenant ? ' (Tenant)' : ''}`} />
        )}
        <Row label="Issue Type" value={(ticket as any).issue_type || '—'} />
        {(ticket as any).issue_subtype && <Row label="Sub-type" value={(ticket as any).issue_subtype} />}
        <Row label="Priority" value={
          <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: priorityCfg.bg, alignSelf: 'flex-start' }}>
            <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: priorityCfg.color }}>{priorityCfg.label}</Text>
          </View>
        } />
        <Row label="Status" value={
          <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: statusCfg.bg, alignSelf: 'flex-start' }}>
            <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: statusCfg.color }}>{statusCfg.label}</Text>
          </View>
        } />
        {!isTenant && (ticket as any).sla_deadline && (
          <Row label="SLA Deadline" value={new Date((ticket as any).sla_deadline).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} />
        )}
      </View>

      <View style={glass.card}>
        <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#5C4B70', marginBottom: 8 }}>LOCATION</Text>
        {(ticket as any).tenant_name && <Row label="Tenant" value={(ticket as any).tenant_name} />}
        {(ticket as any).tenant_phone && <Row label="Phone" value={(ticket as any).tenant_phone} />}
        {(ticket as any).property_name && <Row label="Property" value={(ticket as any).property_name} />}
        {(ticket as any).apartment && <Row label="Apartment" value={(ticket as any).apartment} />}
        {(ticket as any).bed_code && <Row label="Bed" value={(ticket as any).bed_code} />}
      </View>

      {(ticket as any).linked_asset && (
        <View style={glass.card}>
          <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#5C4B70', marginBottom: 8 }}>LINKED ASSET</Text>
          <Row label="Asset" value={(ticket as any).linked_asset.label || (ticket as any).linked_asset.asset_code || '—'} />
          {(ticket as any).linked_asset.asset_code && <Row label="Code" value={(ticket as any).linked_asset.asset_code} />}
          {(ticket as any).linked_asset.condition && <Row label="Condition" value={(ticket as any).linked_asset.condition} />}
        </View>
      )}

      {(ticket as any).assigned_to_name && (
        <View style={glass.card}>
          <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#5C4B70', marginBottom: 8 }}>ASSIGNEE</Text>
          <Row label="Name" value={(ticket as any).assigned_to_name} />
          {(ticket as any).assigned_to_phone && <Row label="Phone" value={(ticket as any).assigned_to_phone} />}
        </View>
      )}

      {(ticket as any).description && (
        <View style={glass.card}>
          <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#5C4B70', marginBottom: 8 }}>DESCRIPTION</Text>
          <Text style={{ fontSize: fontSize.md, color: '#1E1230', lineHeight: 22 }}>{(ticket as any).description}</Text>
        </View>
      )}

      {!isTenant && ((ticket as any).diagnostic_data?.result || (ticket as any).diagnosis) && (() => {
        const r = (ticket as any).diagnostic_data?.result ?? (ticket as any).diagnosis;
        const isObj = typeof r === 'object' && r !== null;
        const hasContent = isObj ? (r.cause || r.recommendation || r.severity) : String(r || '').trim();
        if (!hasContent) return null;
        return (
          <View style={[glass.card, { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE', borderWidth: 1 }]}>
            <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#1D4ED8', marginBottom: 6 }}>DIAGNOSIS</Text>
            {isObj ? (
              <>
                {r.cause && <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: '#1E1230', marginBottom: 4 }}>{r.cause}</Text>}
                {r.severity && <Text style={{ fontSize: fontSize.xs, color: '#1D4ED8', marginBottom: 4, textTransform: 'uppercase' }}>Severity: {r.severity}</Text>}
                {r.recommendation && <Text style={{ fontSize: fontSize.sm, color: '#374151', lineHeight: 20, marginBottom: 4 }}>{r.recommendation}</Text>}
                {r.estimatedCost && <Text style={{ fontSize: fontSize.sm, fontWeight: '600', color: '#1D4ED8' }}>Est. Cost: {r.estimatedCost}</Text>}
              </>
            ) : (
              <Text style={{ fontSize: fontSize.md, color: '#1E1230', lineHeight: 22 }}>{String(r)}</Text>
            )}
          </View>
        );
      })()}

      {/* ── TENANT: status banner — Completed / Awaiting Approval / In Progress ── */}
      {isTenant && showResolutionSection && (() => {
        const st = String((ticket as any).status || '');
        const isDone = st === 'completed' || st === 'closed';
        const isAwaiting = st === 'pending_tenant_approval' || st === 'pending_admin_approval';
        // Visual config per state
        const cfg = isDone
          ? { label: 'Work Completed', icon: 'checkmark-circle', color: '#047857', iconColor: '#059669', bg: '#ECFDF5', border: '#A7F3D0' }
          : isAwaiting
          ? { label: 'Awaiting Your Approval', icon: 'hourglass', color: '#B45309', iconColor: '#D97706', bg: '#FFFBEB', border: '#FDE68A' }
          : { label: 'Work In Progress', icon: 'construct', color: '#1D4ED8', iconColor: '#2563EB', bg: '#EFF6FF', border: '#BFDBFE' };
        return (
          <View style={[glass.card, { borderColor: cfg.border, borderWidth: 1, backgroundColor: cfg.bg }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Ionicons name={cfg.icon as any} size={20} color={cfg.iconColor} />
              <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: cfg.color }}>{cfg.label}</Text>
            </View>
            {isDone && resolution?.closure_summary ? (
              <View style={{ marginTop: 4, padding: 10, backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 10 }}>
                <Text style={{ fontSize: fontSize.xs, color: '#5C4B70', fontWeight: '700', marginBottom: 2 }}>What was done:</Text>
                <Text style={{ fontSize: fontSize.sm, color: '#1E1230', lineHeight: 20 }}>{resolution.closure_summary}</Text>
              </View>
            ) : isAwaiting ? (
              <>
                <Text style={{ fontSize: fontSize.xs, color: '#5C4B70' }}>
                  The technician has finished the work. Please review and approve, or request rework.
                </Text>
                {st === 'pending_tenant_approval' && onOpenApproval && (
                  <TouchableOpacity
                    onPress={onOpenApproval}
                    style={{ marginTop: 12, backgroundColor: '#7B2FBE', borderRadius: borderRadius.lg, paddingVertical: 12, alignItems: 'center' }}
                  >
                    <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: '#fff' }}>Review & Approve</Text>
                  </TouchableOpacity>
                )}
              </>
            ) : (
              <Text style={{ fontSize: fontSize.xs, color: '#5C4B70' }}>
                Our team is working on your request. You'll be notified when it's resolved.
              </Text>
            )}
          </View>
        );
      })()}

      {/* ── RESOLUTION DETAILS CARD ── matching web grid layout exactly (admins/technicians only) */}
      {!isTenant && showResolutionSection && (
        <View style={[glass.card, { borderColor: '#BFDBFE', borderWidth: 1, backgroundColor: '#EFF6FF' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="checkmark-circle" size={16} color="#1D4ED8" />
              <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#1D4ED8' }}>RESOLUTION DETAILS</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {isAdmin && resolution && !isResolutionReadOnly && (
                <TouchableOpacity
                  onPress={onEdit}
                  style={{ backgroundColor: '#DBEAFE', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 }}
                >
                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#1D4ED8' }}>Edit</Text>
                </TouchableOpacity>
              )}
              {isAdmin && (ticket as any).status === 'closed' && !resolutionEditUnlocked && (
                <TouchableOpacity
                  onPress={onUnlock}
                  style={{ backgroundColor: '#FEF3C7', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 }}
                >
                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#D97706' }}>🔓 Unlock to Edit</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          {resolution ? (
            <>
              {/* 2-column grid — mirrors web exactly */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                <ResGridCell label="Type" value={resolution.resolution_type} />
                <ResGridCell label="Service" value={resolution.service_type} />
                <ResGridCell
                  label="Total Cost"
                  value={`₹${Math.round(Number(resolution.actual_total_cost ?? resolution.total_cost) || 0).toLocaleString('en-IN')}`}
                />
                <ResGridCell label="Payment Date" value={resolution.payment_date || '—'} />
                {resolution.bank_account_id && (() => {
                  const b = (bankAccounts as BankAccount[]).find((x) => x.id === resolution.bank_account_id);
                  return b ? (
                    <ResGridCell label="Bank Account" value={`${b.bank_name} ••••${String(b.account_number || '').slice(-4)}`} />
                  ) : null;
                })()}
                {resolution.payment_reference_no && (
                  <ResGridCell label="Reference No." value={resolution.payment_reference_no} />
                )}
              </View>

              {/* Items used */}
              {Array.isArray(resolution.actual_items_used) && resolution.actual_items_used.length > 0 && (
                <View style={{ marginTop: 10 }}>
                  <Text style={{ fontSize: fontSize.xs, color: '#374151', marginBottom: 6 }}>Items used:</Text>
                  {(resolution.actual_items_used as ResolutionItem[]).map((item, i) => (
                    <Text key={i} style={{ fontSize: fontSize.xs, color: '#1E1230', marginBottom: 2 }}>
                      • {item.name} × {item.qty} @ ₹{Math.round(Number(item.unit_cost) || 0)} = ₹{Math.round(Number(item.total) || 0)}
                    </Text>
                  ))}
                </View>
              )}

              {/* Closure summary */}
              {resolution.closure_summary ? (
                <View style={{ marginTop: 10 }}>
                  <Text style={{ fontSize: fontSize.xs, color: '#374151', marginBottom: 4 }}>Summary:</Text>
                  <Text style={{ fontSize: fontSize.sm, color: '#1E1230', lineHeight: 20 }}>{resolution.closure_summary}</Text>
                </View>
              ) : null}

              {/* File links */}
              <View style={{ flexDirection: 'row', gap: 16, marginTop: 12 }}>
                {resolution.proof_of_purchase_url && (
                  <TouchableOpacity onPress={() => Linking.openURL(resolution.proof_of_purchase_url)}>
                    <Text style={{ fontSize: fontSize.xs, color: '#2563EB', textDecorationLine: 'underline' }}>
                      📄 Bill of purchase
                    </Text>
                  </TouchableOpacity>
                )}
                {resolution.proof_of_payment_url && (
                  <TouchableOpacity onPress={() => Linking.openURL(resolution.proof_of_payment_url)}>
                    <Text style={{ fontSize: fontSize.xs, color: '#2563EB', textDecorationLine: 'underline' }}>
                      🧾 Proof of payment
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            </>
          ) : (
            <View style={{ alignItems: 'center', paddingVertical: 20 }}>
              <Ionicons name="document-text-outline" size={32} color="#93C5FD" />
              <Text style={{ fontSize: fontSize.sm, color: '#374151', marginTop: 8, textAlign: 'center' }}>
                No resolution details yet.
              </Text>
              {(isAdmin) && (
                <TouchableOpacity
                  onPress={onAdd}
                  style={{ marginTop: 12, backgroundColor: '#1D4ED8', paddingHorizontal: 20, paddingVertical: 8, borderRadius: 999 }}
                >
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: fontSize.xs }}>+ Add Resolution Details</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
      )}
    </>
  );
}

function ResGridCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ width: '50%', paddingRight: 8, marginBottom: 8 }}>
      <Text style={{ fontSize: 10, color: '#6B7280' }}>{label}</Text>
      <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#1E1230' }}>{value}</Text>
    </View>
  );
}

function Row({ label, value }: { label: string; value: any }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.borderLight }}>
      <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, flex: 1 }}>{label}</Text>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Text style={{ fontSize: fontSize.sm, fontWeight: '600', color: colors.text, flex: 1, textAlign: 'right' }}>{value}</Text>
      ) : value}
    </View>
  );
}

// ─── DIAGNOSIS TAB ────────────────────────────────────────────────────────────

// ─── Activity note formatter (web parity: strip DIAGNOSIS_METADATA JSON) ───────
// Returns { summary?, body } so the timeline shows a clean "Diagnosis summary"
// (Cause/Severity/Est. cost/Recommendation) + Q&A body instead of raw JSON.
function formatActivityNote(raw?: string | null): { summary?: { cause?: string; severity?: string; estimatedCost?: string; recommendation?: string }; body: string } {
  if (!raw) return { body: '' };
  const prefix = 'DIAGNOSIS_METADATA\n';
  if (!raw.startsWith(prefix)) return { body: raw };
  const after = raw.slice(prefix.length);
  const sep = after.indexOf('\n\n');
  const metaLine = sep >= 0 ? after.slice(0, sep) : after;
  const body = sep >= 0 ? after.slice(sep + 2) : '';
  try {
    const meta = JSON.parse(metaLine);
    return { summary: meta, body };
  } catch {
    return { body: raw };
  }
}

function DiagnosisTab({ ticket, diagSession, isAssignedTechnician, onOpen }: any) {
  const { colors } = useTheme();
  if (!diagSession) {
    return (
      <View style={[glass.card, { alignItems: 'center', paddingVertical: 40 }]}>
        <Ionicons name="medical-outline" size={40} color={colors.textTertiary} />
        <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.text, marginTop: 12 }}>No Diagnosis Yet</Text>
        <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 4 }}>
          {isAssignedTechnician ? 'Run a diagnosis to document the issue' : 'Awaiting technician diagnosis'}
        </Text>
        {isAssignedTechnician && (
          <TouchableOpacity onPress={onOpen} style={{ marginTop: 16, backgroundColor: '#0369A1', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 999 }}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>Run Diagnosis</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <View style={glass.card}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 }}>
        <Ionicons name="checkmark-circle" size={18} color="#16A34A" />
        <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#16A34A' }}>DIAGNOSIS COMPLETE</Text>
      </View>
      {diagSession.questions_answers && (() => {
        const qa = diagSession.questions_answers;
        // Normalize to an array of { question, answer } regardless of stored shape.
        const items: { question: string; answer: string }[] = Array.isArray(qa)
          ? qa.map((it: any) => ({
              question: it?.question ?? it?.q ?? '',
              answer: it?.answer ?? it?.a ?? (typeof it === 'string' ? it : ''),
            }))
          : Object.entries(qa).map(([k, v]: any) => {
              if (v && typeof v === 'object') return { question: v.question ?? k, answer: v.answer ?? '' };
              return { question: k, answer: String(v ?? '') };
            });
        return items
          .filter((it) => it.question || it.answer)
          .map((it, i) => (
            <View key={i} style={{ marginBottom: 12 }}>
              {!!it.question && <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary }}>{it.question}</Text>}
              {!!it.answer && <Text style={{ fontSize: fontSize.md, color: colors.text, marginTop: 2 }}>{it.answer}</Text>}
            </View>
          ));
      })()}
      {diagSession.ai_diagnosis && (() => {
        const raw = diagSession.ai_diagnosis;
        const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : raw;
        const isObj = typeof parsed === 'object' && parsed !== null;
        return (
          <View style={{ backgroundColor: '#EFF6FF', borderRadius: borderRadius.md, padding: spacing.md, marginTop: 8 }}>
            <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#1D4ED8', marginBottom: 4 }}>AI Diagnosis</Text>
            {isObj ? (
              <>
                {parsed.summary && <Text style={{ fontSize: fontSize.sm, color: colors.text, marginBottom: 4 }}>{parsed.summary}</Text>}
                {parsed.causes?.length > 0 && parsed.causes.map((c: any, i: number) => (
                  <Text key={i} style={{ fontSize: fontSize.sm, color: colors.text, marginBottom: 2 }}>• {c.cause || c}</Text>
                ))}
                {parsed.recommendedAction && <Text style={{ fontSize: fontSize.sm, color: '#1D4ED8', marginTop: 4 }}>{parsed.recommendedAction}</Text>}
                {!parsed.summary && !parsed.causes && (
                  <Text style={{ fontSize: fontSize.sm, color: colors.text }}>{JSON.stringify(parsed)}</Text>
                )}
              </>
            ) : (
              <Text style={{ fontSize: fontSize.md, color: colors.text }}>{String(parsed)}</Text>
            )}
          </View>
        );
      })()}
      {diagSession.employee_override && (
        <View style={{ backgroundColor: '#DCFCE7', borderRadius: borderRadius.md, padding: spacing.md, marginTop: 8 }}>
          <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#16A34A', marginBottom: 4 }}>Technician Note</Text>
          <Text style={{ fontSize: fontSize.md, color: colors.text }}>{diagSession.employee_override}</Text>
        </View>
      )}
    </View>
  );
}

// ─── COSTS TAB ────────────────────────────────────────────────────────────────

function CostsTab({ ticket, estimates, purchases, isAssignedTechnician, isAdmin, canApproveCost, userId, onSubmitCosts, onRecordPurchase, onApprove, onRefresh }: any) {
  const { colors } = useTheme();
  const totalEstimated = estimates.reduce((s: number, e: CostEstimate) => s + (e.total || 0), 0);
  const totalPurchased = purchases.reduce((s: number, p: any) => s + (p.total_cost || p.actual_cost || 0), 0);
  const allEstimatesApproved = estimates.length > 0 && estimates.every((e: CostEstimate) => e.status === 'approved');

  // Cross-platform decline-reason capture (Alert.prompt is iOS-only, so Android
  // admins previously could not decline an estimate — use an in-app modal instead).
  const [declineFor, setDeclineFor] = useState<CostEstimate | null>(null);
  const [declineReason, setDeclineReason] = useState('');
  const [declining, setDeclining] = useState(false);

  // Approve-with-optional-modification (backend supports modifiedQuantity/modifiedUnitPrice).
  const [approveFor, setApproveFor] = useState<CostEstimate | null>(null);
  const [approveQty, setApproveQty] = useState('');
  const [approvePrice, setApprovePrice] = useState('');
  const [approving, setApproving] = useState(false);
  const submitApprove = async () => {
    if (!approveFor) return;
    setApproving(true);
    try {
      const q = parseInt(approveQty) || approveFor.quantity;
      const up = parseFloat(approvePrice);
      const args: any = { estimateId: approveFor.id, ticketId: ticket.id, action: 'approve', approvedBy: userId };
      if (q !== approveFor.quantity) args.modifiedQuantity = q;
      if (!isNaN(up) && up !== approveFor.unit_price) args.modifiedUnitPrice = up;
      await approveCostEstimate(args);
      setApproveFor(null);
      onRefresh();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setApproving(false);
    }
  };
  const submitDecline = async () => {
    if (!declineFor || !declineReason.trim()) return;
    setDeclining(true);
    try {
      await approveCostEstimate({ estimateId: declineFor.id, ticketId: ticket.id, action: 'decline', approvedBy: userId, declineReason: declineReason.trim() });
      setDeclineFor(null);
      setDeclineReason('');
      onRefresh();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setDeclining(false);
    }
  };

  return (
    <>
      {estimates.length > 0 && (
        <View style={glass.card}>
          <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#5C4B70', marginBottom: 12 }}>COST ESTIMATES</Text>
          {estimates.map((e: CostEstimate) => (
            <View key={e.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.borderLight, gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.text }}>{e.item_name}</Text>
                <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>
                  {e.quantity} × ₹{e.unit_price} = ₹{e.total}
                </Text>
              </View>
              <StatusBadge status={e.status} />
              {isAdmin && canApproveCost && e.status === 'pending' && (
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <TouchableOpacity
                    onPress={() => { setApproveQty(String(e.quantity)); setApprovePrice(String(e.unit_price)); setApproveFor(e); }}
                    style={{ backgroundColor: '#DCFCE7', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#16A34A' }}>Approve</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => { setDeclineReason(''); setDeclineFor(e); }}
                    style={{ backgroundColor: '#FEE2E2', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#DC2626' }}>Decline</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          ))}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
            <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary }}>Total Estimated</Text>
            <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: '#7B2FBE' }}>₹{totalEstimated.toFixed(2)}</Text>
          </View>
          {allEstimatesApproved && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, backgroundColor: '#DCFCE7', borderRadius: borderRadius.md, padding: spacing.sm }}>
              <Ionicons name="checkmark-circle" size={16} color="#16A34A" />
              <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#16A34A' }}>All estimates approved — cost estimation complete</Text>
            </View>
          )}
        </View>
      )}

      {purchases.length > 0 && (
        <View style={glass.card}>
          <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#5C4B70', marginBottom: 12 }}>PURCHASES</Text>
          {purchases.map((p: any) => (
            <View key={p.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.borderLight }}>
              <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.text }}>
                {p.item_name || 'Purchase'}
              </Text>
              <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>
                ₹{p.actual_cost} • {p.vendor_name_manual || p.vendor_name || 'Vendor'} • {p.purchase_date}
              </Text>
            </View>
          ))}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
            <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary }}>Total Spent</Text>
            <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: '#16A34A' }}>₹{totalPurchased.toFixed(2)}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, backgroundColor: '#DCFCE7', borderRadius: borderRadius.md, padding: spacing.sm }}>
            <Ionicons name="checkmark-circle" size={16} color="#16A34A" />
            <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#16A34A' }}>Purchase recorded — this step is complete</Text>
          </View>
        </View>
      )}

      {estimates.length === 0 && purchases.length === 0 && (
        <View style={[glass.card, { alignItems: 'center', paddingVertical: 40 }]}>
          <Ionicons name="receipt-outline" size={40} color={colors.textTertiary} />
          <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: colors.text, marginTop: 12 }}>No Cost Data</Text>
          <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 4, textAlign: 'center' }}>
            {isAssignedTechnician ? 'Submit cost estimates when parts are needed' : 'Cost estimates will appear here'}
          </Text>
        </View>
      )}

      {/* Approve modal — allows optionally modifying qty/unit price before approval */}
      <Modal visible={!!approveFor} transparent animationType="fade" onRequestClose={() => setApproveFor(null)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1, backgroundColor: 'rgba(30,18,48,0.45)', justifyContent: 'center', padding: 24 }}
        >
          <View style={{ backgroundColor: '#fff', borderRadius: 18, padding: 20 }}>
            <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: colors.text, marginBottom: 4 }}>Approve Estimate</Text>
            <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: 12 }}>
              {approveFor?.item_name ? `"${approveFor.item_name}"` : 'this estimate'} — adjust quantity or unit price if needed, then approve.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 10, color: colors.textSecondary, marginBottom: 2 }}>Quantity</Text>
                <TextInput
                  value={approveQty}
                  onChangeText={setApproveQty}
                  keyboardType="numeric"
                  style={{ borderWidth: 1, borderColor: colors.borderLight, borderRadius: 12, padding: 12, fontSize: fontSize.sm, color: colors.text, textAlign: 'center' }}
                />
              </View>
              <View style={{ flex: 2 }}>
                <Text style={{ fontSize: 10, color: colors.textSecondary, marginBottom: 2 }}>Unit Price (₹)</Text>
                <TextInput
                  value={approvePrice}
                  onChangeText={setApprovePrice}
                  keyboardType="numeric"
                  style={{ borderWidth: 1, borderColor: colors.borderLight, borderRadius: 12, padding: 12, fontSize: fontSize.sm, color: colors.text }}
                />
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity
                onPress={() => setApproveFor(null)}
                style={{ flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.borderLight, alignItems: 'center' }}
              >
                <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submitApprove}
                disabled={approving}
                style={{ flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: approving ? '#A7E0BE' : '#16A34A' }}
              >
                <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: '#fff' }}>{approving ? 'Approving…' : 'Approve'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Decline-reason modal (cross-platform replacement for Alert.prompt) */}
      <Modal visible={!!declineFor} transparent animationType="fade" onRequestClose={() => setDeclineFor(null)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1, backgroundColor: 'rgba(30,18,48,0.45)', justifyContent: 'center', padding: 24 }}
        >
          <View style={{ backgroundColor: '#fff', borderRadius: 18, padding: 20 }}>
            <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: colors.text, marginBottom: 4 }}>Decline Estimate</Text>
            <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: 12 }}>
              Why are you declining {declineFor?.item_name ? `"${declineFor.item_name}"` : 'this estimate'}?
            </Text>
            <TextInput
              value={declineReason}
              onChangeText={setDeclineReason}
              placeholder="Enter a reason"
              placeholderTextColor={colors.textTertiary}
              multiline
              style={{ minHeight: 72, borderWidth: 1, borderColor: colors.borderLight, borderRadius: 12, padding: 12, fontSize: fontSize.sm, color: colors.text, textAlignVertical: 'top' }}
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity
                onPress={() => { setDeclineFor(null); setDeclineReason(''); }}
                style={{ flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.borderLight, alignItems: 'center' }}
              >
                <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submitDecline}
                disabled={!declineReason.trim() || declining}
                style={{ flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: (!declineReason.trim() || declining) ? '#F3B4B4' : '#DC2626' }}
              >
                <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: '#fff' }}>{declining ? 'Declining…' : 'Decline'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: any = {
    pending: { color: '#D97706', bg: '#FEF3C7' },
    approved: { color: '#16A34A', bg: '#DCFCE7' },
    declined: { color: '#DC2626', bg: '#FEE2E2' },
  };
  const cfg = map[status] || map.pending;
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: cfg.bg }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color: cfg.color }}>{status.charAt(0).toUpperCase() + status.slice(1)}</Text>
    </View>
  );
}

// ─── TIMELINE TAB ─────────────────────────────────────────────────────────────

function TimelineTab({ logs }: { logs: TicketLog[] }) {
  const { colors } = useTheme();
  return (
    <View style={glass.card}>
      <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#5C4B70', marginBottom: 12 }}>ACTIVITY TIMELINE</Text>
      {logs.length === 0 ? (
        <Text style={{ fontSize: fontSize.sm, color: colors.textTertiary, textAlign: 'center', padding: 20 }}>No activity yet</Text>
      ) : (
        logs.map((log, idx) => (
          <View key={log.id} style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
            <View style={{ alignItems: 'center' }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#7B2FBE', marginTop: 4 }} />
              {idx < logs.length - 1 && <View style={{ width: 2, flex: 1, backgroundColor: colors.borderLight, marginTop: 4 }} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.text }}>{log.action}</Text>
              {log.notes && (() => {
                const fmt = formatActivityNote(log.notes);
                return (
                  <View style={{ marginTop: 2 }}>
                    {fmt.summary && (
                      <View style={{ backgroundColor: 'rgba(123,47,190,0.05)', borderRadius: 8, padding: 8, marginBottom: fmt.body ? 6 : 0 }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: '#5C4B70', marginBottom: 2 }}>Diagnosis summary</Text>
                        {!!fmt.summary.cause && <Text style={{ fontSize: 11, color: colors.textSecondary }}>Cause: <Text style={{ color: colors.text }}>{fmt.summary.cause}</Text></Text>}
                        {!!fmt.summary.severity && <Text style={{ fontSize: 11, color: colors.textSecondary }}>Severity: <Text style={{ color: colors.text }}>{fmt.summary.severity}</Text></Text>}
                        {!!fmt.summary.estimatedCost && <Text style={{ fontSize: 11, color: colors.textSecondary }}>Est. cost: <Text style={{ color: colors.text }}>{fmt.summary.estimatedCost}</Text></Text>}
                        {!!fmt.summary.recommendation && <Text style={{ fontSize: 11, color: colors.textSecondary }}>Recommendation: <Text style={{ color: colors.text }}>{fmt.summary.recommendation}</Text></Text>}
                      </View>
                    )}
                    {!!fmt.body && <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>{fmt.body}</Text>}
                  </View>
                );
              })()}
              {log.new_status && (
                <View style={{ marginTop: 4 }}>
                  <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: STATUS_CONFIG[log.new_status]?.bg || '#E5E7EB', alignSelf: 'flex-start' }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: STATUS_CONFIG[log.new_status]?.color || '#374151' }}>
                      {STATUS_CONFIG[log.new_status]?.label || log.new_status}
                    </Text>
                  </View>
                </View>
              )}
              <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 4 }}>
                {new Date(log.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
              </Text>
            </View>
          </View>
        ))
      )}
    </View>
  );
}

// ─── UNLOCK MODAL ─────────────────────────────────────────────────────────────

function UnlockModal({ visible, onClose, reason, setReason, onUnlock, loading }: any) {
  const { colors } = useTheme();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#F7F3F9' }} edges={['top', 'bottom']}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#E0D5EA' }}>
            <TouchableOpacity onPress={onClose} style={{ marginRight: 12 }}>
              <Ionicons name="close" size={24} color="#1E1230" />
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#1E1230' }}>Unlock Resolution Editing</Text>
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: 16 }}>
            <View style={{ backgroundColor: '#FEF3C7', borderRadius: borderRadius.md, padding: spacing.md, flexDirection: 'row', gap: 8 }}>
              <Ionicons name="lock-open-outline" size={18} color="#D97706" style={{ marginTop: 1 }} />
              <Text style={{ flex: 1, fontSize: fontSize.sm, color: '#92400E', lineHeight: 20 }}>
                This keeps the ticket in <Text style={{ fontWeight: '700' }}>Closed</Text> status but allows admins to edit resolution details. An audit log entry will be created.
              </Text>
            </View>
            <TextInput
              style={[glass.input, { padding: spacing.md, minHeight: 90, textAlignVertical: 'top', color: '#1E1230', fontSize: fontSize.md }]}
              placeholder="Explain why resolution needs editing… (optional)"
              placeholderTextColor="#9B8BAE"
              value={reason}
              onChangeText={setReason}
              multiline
            />
            <TouchableOpacity
              onPress={onUnlock}
              disabled={loading}
              style={{ backgroundColor: '#D97706', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center', opacity: loading ? 0.6 : 1 }}
            >
              {loading
                ? <ActivityIndicator color="#fff" />
                : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>🔓 Unlock Editing</Text>
              }
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── RESOLUTION FORM MODAL ────────────────────────────────────────────────────
// Full-screen modal mirroring the web resolution form exactly.
// Includes: resolution type, service type, vendor, items table, labour cost,
// SEPARATE proof-of-purchase + proof-of-payment uploads, OCR auto-fill,
// payment date, bank account, reference no, closure summary.

function ResolutionFormModal({
  visible, onClose, form, setForm, vendors, bankAccounts,
  isReadOnly, paymentOcrLoading, paymentOcrMeta, onProofOfPaymentChange,
  onSave, saving, ticketId, totalCostFromParent,
}: any) {
  const { colors } = useTheme();
  const [uploadingPurchase, setUploadingPurchase] = useState(false);
  const [uploadingPayment, setUploadingPayment] = useState(false);
  const [showVendorPicker, setShowVendorPicker] = useState(false);
  const [showBankPicker, setShowBankPicker] = useState(false);

  const totalParts = (form.items as ResolutionItem[]).reduce((s, i) => s + i.total, 0);
  const totalCost = totalParts + (Number(form.total_labour_cost) || 0);
  const requiresPayment = totalCost > 0;

  async function pickAndUploadImage(_bucket: string, folder: string, onDone: (url: string | null) => void, setUploading: (v: boolean) => void) {
    if (Platform.OS === 'web') {
      // Web/desktop: use expo-document-picker which calls the native browser file dialog
      // directly from the user gesture — no hidden <input> needed, no gesture chain break
      try {
        const DocumentPicker = await import('expo-document-picker') as any;
        const result = await DocumentPicker.getDocumentAsync({
          type: ['image/*', 'application/pdf'],
          copyToCacheDirectory: true,
          multiple: false,
        });
        if (result.canceled || !result.assets?.length) return;
        const file = result.assets[0];
        setUploading(true);
        try {
          const response = await fetch(file.uri);
          const blob = await response.blob();
          const reader = new FileReader();
          await new Promise<void>((resolve, reject) => {
            reader.onload = async () => {
              try {
                const dataUrl = reader.result as string;
                const base64 = dataUrl.split(',')[1];
                const url = await uploadTicketPhoto(dataUrl, base64, file.mimeType || 'image/jpeg');
                onDone(url);
                resolve();
              } catch (err: any) {
                reject(err);
              }
            };
            reader.onerror = () => reject(new Error('FileReader failed'));
            reader.readAsDataURL(blob);
          });
        } catch (err: any) {
          Alert.alert('Upload Failed', err.message || 'Could not upload file');
          onDone(null);
        } finally {
          setUploading(false);
        }
      } catch (err: any) {
        Alert.alert('Error', err.message || 'Could not open file picker');
      }
      return;
    }
    // Native iOS/Android: Camera + Gallery action sheet
    Alert.alert(
      'Upload Image',
      'Choose source',
      [
        {
          text: 'Camera',
          onPress: async () => {
            const perm = await ImagePicker.requestCameraPermissionsAsync();
            if (!perm.granted) {
              Alert.alert(
                'Camera Permission Required',
                'Camera access is needed to take a photo. Please enable it in your device Settings.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Open Settings', onPress: () => { try { const { Linking: RNLinking } = require('react-native'); RNLinking.openSettings(); } catch {} } },
                ]
              );
              return;
            }
            const result = await ImagePicker.launchCameraAsync({
              mediaTypes: 'images' as any,
              quality: 0.85,
              base64: true,
            });
            if (result.canceled || !result.assets?.[0]) return;
            const asset = result.assets[0];
            setUploading(true);
            try {
              const url = await uploadTicketPhoto(asset.uri, asset.base64 || undefined, asset.mimeType || 'image/jpeg');
              onDone(url);
            } catch (e: any) {
              Alert.alert('Upload Failed', e.message || 'Could not upload image');
              onDone(null);
            } finally {
              setUploading(false);
            }
          },
        },
        {
          text: 'Gallery',
          onPress: async () => {
            const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (!perm.granted) {
              Alert.alert(
                'Photo Library Permission Required',
                'Photo library access is needed to upload an image. Please enable it in your device Settings.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Open Settings', onPress: () => { try { const { Linking: RNLinking } = require('react-native'); RNLinking.openSettings(); } catch {} } },
                ]
              );
              return;
            }
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: 'images' as any,
              quality: 0.8,
              base64: true,
            });
            if (result.canceled || !result.assets?.[0]) return;
            const asset = result.assets[0];
            setUploading(true);
            try {
              const url = await uploadTicketPhoto(asset.uri, asset.base64 || undefined, asset.mimeType || 'image/jpeg');
              onDone(url);
            } catch (e: any) {
              Alert.alert('Upload Failed', e.message || 'Could not upload image');
              onDone(null);
            } finally {
              setUploading(false);
            }
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ],
      { cancelable: true },
    );
  }

    function addItem() {
    setForm((p: TicketResolutionForm) => ({
      ...p,
      items: [...p.items, { name: '', qty: 1, unit_cost: 0, total: 0 }],
    }));
  }

  function updateItem(idx: number, field: keyof ResolutionItem, value: any) {
    setForm((p: TicketResolutionForm) => {
      const items = [...p.items];
      items[idx] = { ...items[idx], [field]: value };
      if (field === 'qty' || field === 'unit_cost') {
        items[idx].total = (Number(items[idx].qty) || 0) * (Number(items[idx].unit_cost) || 0);
      }
      return { ...p, items };
    });
  }

  function removeItem(idx: number) {
    setForm((p: TicketResolutionForm) => ({
      ...p,
      items: p.items.filter((_, i) => i !== idx),
    }));
  }

  const resolutionTypeOpts = [
    { value: 'inhouse', label: 'In-House' },
    { value: 'outside', label: 'Outside Vendor' },
    { value: 'amc', label: 'AMC' },
    { value: 'charged', label: 'Charged to Tenant' },
  ];
  const serviceTypeOpts = [
    { value: 'condition_service', label: 'Condition & Service' },
    { value: 'replaced', label: 'Replaced' },
    { value: 'new_install', label: 'New Install' },
    { value: 'repair', label: 'Repair' },
  ];

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#F7F3F9' }} edges={['top', 'bottom']}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#E0D5EA' }}>
            <TouchableOpacity onPress={onClose} style={{ marginRight: 12 }}>
              <Ionicons name="close" size={24} color="#1E1230" />
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#1E1230', flex: 1 }}>Resolution Details</Text>
            {isReadOnly && (
              <View style={{ backgroundColor: '#FEE2E2', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#DC2626' }}>Read Only</Text>
              </View>
            )}
          </View>

          <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: 16, paddingBottom: 40 }}>
            {/* Resolution Type */}
            <View>
              <Text style={formLabel}>Resolution Type *</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                {resolutionTypeOpts.map((opt) => (
                  <TouchableOpacity
                    key={opt.value}
                    onPress={() => !isReadOnly && setForm((p: TicketResolutionForm) => ({ ...p, resolution_type: opt.value as any }))}
                    style={{
                      paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
                      backgroundColor: form.resolution_type === opt.value ? '#7B2FBE' : '#fff',
                      borderWidth: 1.5, borderColor: form.resolution_type === opt.value ? '#7B2FBE' : '#D1D5DB',
                    }}
                  >
                    <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: form.resolution_type === opt.value ? '#fff' : '#374151' }}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Service Type */}
            <View>
              <Text style={formLabel}>Service Type *</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                {serviceTypeOpts.map((opt) => (
                  <TouchableOpacity
                    key={opt.value}
                    onPress={() => !isReadOnly && setForm((p: TicketResolutionForm) => ({ ...p, service_type: opt.value as any }))}
                    style={{
                      paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
                      backgroundColor: form.service_type === opt.value ? '#0369A1' : '#fff',
                      borderWidth: 1.5, borderColor: form.service_type === opt.value ? '#0369A1' : '#D1D5DB',
                    }}
                  >
                    <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: form.service_type === opt.value ? '#fff' : '#374151' }}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Vendor (outside / amc) */}
            {['outside', 'amc'].includes(form.resolution_type) && (
              <View>
                <Text style={formLabel}>Vendor</Text>
                {vendors.length > 0 ? (
                  <View>
                    <TouchableOpacity
                      onPress={() => !isReadOnly && setShowVendorPicker(true)}
                      style={[glass.input, { flexDirection: 'row', alignItems: 'center', padding: spacing.md, justifyContent: 'space-between' }]}
                    >
                      <Text style={{ color: form.vendor_id ? '#1E1230' : '#9B8BAE', fontSize: fontSize.md }}>
                        {form.vendor_id ? (vendors.find((v: any) => v.id === form.vendor_id)?.vendor_name || 'Select vendor') : 'Select vendor'}
                      </Text>
                      <Ionicons name="chevron-down" size={16} color="#9B8BAE" />
                    </TouchableOpacity>
                    {form.vendor_id && (() => {
                      const sel = vendors.find((v: any) => v.id === form.vendor_id);
                      return sel && (sel.contact_person || sel.phone) ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, paddingHorizontal: 4 }}>
                          <Ionicons name="information-circle-outline" size={13} color="#6B7280" />
                          <Text style={{ fontSize: 11, color: '#6B7280' }}>
                            {[sel.contact_person, sel.phone].filter(Boolean).join(' · ')}
                          </Text>
                        </View>
                      ) : null;
                    })()}
                  </View>
                ) : null}
                <TextInput
                  style={[glass.input, { padding: spacing.md, color: '#1E1230', fontSize: fontSize.md, marginTop: 6 }]}
                  placeholder="Or enter vendor name manually"
                  placeholderTextColor="#9B8BAE"
                  value={form.vendor_name_manual}
                  onChangeText={(v) => !isReadOnly && setForm((p: TicketResolutionForm) => ({ ...p, vendor_name_manual: v }))}
                  editable={!isReadOnly}
                />
              </View>
            )}

            {/* Items used */}
            <View>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={formLabel}>Items Used</Text>
                {!isReadOnly && (
                  <TouchableOpacity onPress={addItem} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Ionicons name="add-circle-outline" size={18} color="#7B2FBE" />
                    <Text style={{ fontSize: fontSize.xs, color: '#7B2FBE', fontWeight: '700' }}>Add Item</Text>
                  </TouchableOpacity>
                )}
              </View>
              {form.items.length === 0 && (
                <Text style={{ fontSize: fontSize.xs, color: '#9B8BAE', marginTop: 6 }}>No items added yet</Text>
              )}
              {(form.items as ResolutionItem[]).map((item, idx) => (
                <View key={idx} style={{ backgroundColor: '#fff', borderRadius: borderRadius.md, padding: spacing.md, marginTop: 8, borderWidth: 1, borderColor: '#E5E7EB' }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#5C4B70' }}>Item {idx + 1}</Text>
                    {!isReadOnly && (
                      <TouchableOpacity onPress={() => removeItem(idx)}>
                        <Ionicons name="trash-outline" size={16} color="#DC2626" />
                      </TouchableOpacity>
                    )}
                  </View>
                  <TextInput
                    style={[glass.input, { padding: spacing.sm, color: '#1E1230', fontSize: fontSize.sm, marginBottom: 6 }]}
                    placeholder="Item name"
                    placeholderTextColor="#9B8BAE"
                    value={item.name}
                    onChangeText={(v) => updateItem(idx, 'name', v)}
                    editable={!isReadOnly}
                  />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 10, color: '#6B7280', marginBottom: 2 }}>Qty</Text>
                      <TextInput
                        style={[glass.input, { padding: spacing.sm, color: '#1E1230', fontSize: fontSize.sm, textAlign: 'center' }]}
                        keyboardType="numeric"
                        value={String(item.qty)}
                        onChangeText={(v) => updateItem(idx, 'qty', parseInt(v) || 0)}
                        editable={!isReadOnly}
                      />
                    </View>
                    <View style={{ flex: 2 }}>
                      <Text style={{ fontSize: 10, color: '#6B7280', marginBottom: 2 }}>Unit Cost (₹)</Text>
                      <TextInput
                        style={[glass.input, { padding: spacing.sm, color: '#1E1230', fontSize: fontSize.sm }]}
                        keyboardType="numeric"
                        value={String(item.unit_cost)}
                        onChangeText={(v) => updateItem(idx, 'unit_cost', parseFloat(v) || 0)}
                        editable={!isReadOnly}
                      />
                    </View>
                    <View style={{ flex: 2 }}>
                      <Text style={{ fontSize: 10, color: '#6B7280', marginBottom: 2 }}>Total (₹)</Text>
                      <View style={[glass.input, { padding: spacing.sm, justifyContent: 'center' }]}>
                        <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#7B2FBE' }}>₹{Math.round(item.total)}</Text>
                      </View>
                    </View>
                  </View>
                </View>
              ))}
              {form.items.length > 0 && (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
                  <Text style={{ fontSize: fontSize.xs, color: '#6B7280' }}>Parts subtotal</Text>
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#7B2FBE' }}>₹{Math.round(totalParts)}</Text>
                </View>
              )}
            </View>

            {/* Labour cost */}
            <View>
              <Text style={formLabel}>Labour Cost (₹)</Text>
              <TextInput
                style={[glass.input, { padding: spacing.md, color: '#1E1230', fontSize: fontSize.md, marginTop: 6 }]}
                keyboardType="numeric"
                placeholder="0"
                placeholderTextColor="#9B8BAE"
                value={String(form.total_labour_cost || '')}
                onChangeText={(v) => !isReadOnly && setForm((p: TicketResolutionForm) => ({ ...p, total_labour_cost: parseFloat(v) || 0 }))}
                editable={!isReadOnly}
              />
            </View>

            {/* Total cost display */}
            <View style={{ backgroundColor: '#EDE9FE', borderRadius: borderRadius.md, padding: spacing.md, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#5C4B70' }}>Total Cost</Text>
              <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#7B2FBE' }}>₹{Math.round(totalCost).toLocaleString('en-IN')}</Text>
            </View>

            {/* ── PAYMENT DETAILS — shown only when total > 0 ── */}
            {requiresPayment && (
              <View style={{ backgroundColor: '#F0FDF4', borderRadius: borderRadius.lg, borderWidth: 1, borderColor: '#BBF7D0', padding: spacing.lg, gap: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#15803D' }}>Payment Details (required)</Text>
                  <Text style={{ fontSize: 10, color: '#6B7280' }}>Actual cost &gt; 0</Text>
                </View>

                {/* Proof of Purchase — SEPARATE upload option */}
                <View>
                  <Text style={[formLabel, { color: '#15803D' }]}>Proof of Purchase *</Text>
                  <Text style={{ fontSize: 10, color: '#6B7280', marginBottom: 6 }}>Bill / invoice from vendor</Text>
                  {form.proof_of_purchase_url ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#DCFCE7', padding: spacing.sm, borderRadius: borderRadius.md }}>
                      <Ionicons name="document-attach" size={18} color="#16A34A" />
                      <Text style={{ flex: 1, fontSize: fontSize.xs, color: '#15803D', fontWeight: '600' }} numberOfLines={1}>Purchase bill uploaded ✓</Text>
                      {!isReadOnly && (
                        <TouchableOpacity onPress={() => setForm((p: TicketResolutionForm) => ({ ...p, proof_of_purchase_url: null }))}>
                          <Ionicons name="close-circle" size={18} color="#DC2626" />
                        </TouchableOpacity>
                      )}
                    </View>
                  ) : (
                    <TouchableOpacity
                      onPress={() => !isReadOnly && pickAndUploadImage('ticket-photos', 'proof-of-purchase', (url) => {
                        if (url) setForm((p: TicketResolutionForm) => ({ ...p, proof_of_purchase_url: url }));
                      }, setUploadingPurchase)}
                      disabled={isReadOnly || uploadingPurchase}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: borderRadius.md, borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#16A34A', backgroundColor: '#fff', opacity: isReadOnly ? 0.5 : 1 }}
                    >
                      {uploadingPurchase
                        ? <ActivityIndicator size="small" color="#16A34A" />
                        : <Ionicons name="cloud-upload-outline" size={20} color="#16A34A" />
                      }
                      <View>
                        <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#16A34A' }}>
                          {uploadingPurchase ? 'Uploading…' : 'Upload Purchase Bill'}
                        </Text>
                        {!uploadingPurchase && (
                          <Text style={{ fontSize: 10, color: '#6B7280', textAlign: 'center', marginTop: 2 }}>
                            {Platform.OS === 'web' ? 'Choose file (image or PDF)' : 'Camera or Gallery'}
                          </Text>
                        )}
                      </View>
                    </TouchableOpacity>
                  )}
                </View>

                {/* Proof of Payment — SEPARATE upload option with OCR */}
                <View>
                  <Text style={[formLabel, { color: '#15803D' }]}>Proof of Payment (optional)</Text>
                  <Text style={{ fontSize: 10, color: '#6B7280', marginBottom: 6 }}>Bank transfer screenshot / receipt — auto-scans amount, date &amp; bank</Text>
                  {form.proof_of_payment_url ? (
                    <View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#DCFCE7', padding: spacing.sm, borderRadius: borderRadius.md }}>
                        <Ionicons name="scan" size={18} color="#16A34A" />
                        <Text style={{ flex: 1, fontSize: fontSize.xs, color: '#15803D', fontWeight: '600' }} numberOfLines={1}>Payment proof uploaded ✓</Text>
                        {!isReadOnly && (
                          <TouchableOpacity onPress={() => { onProofOfPaymentChange(null); }}>
                            <Ionicons name="close-circle" size={18} color="#DC2626" />
                          </TouchableOpacity>
                        )}
                      </View>
                      {paymentOcrLoading && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
                          <ActivityIndicator size="small" color="#16A34A" />
                          <Text style={{ fontSize: fontSize.xs, color: '#6B7280' }}>Reading payment details from image…</Text>
                        </View>
                      )}
                      {paymentOcrMeta && (paymentOcrMeta.bankName || paymentOcrMeta.amount != null) && (
                        <View style={{ backgroundColor: '#fff', borderRadius: borderRadius.sm, borderWidth: 1, borderColor: '#BBF7D0', padding: spacing.sm, marginTop: 6, flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                          <Text style={{ fontSize: 10, fontWeight: '700', color: '#374151' }}>From receipt (OCR): </Text>
                          {paymentOcrMeta.bankName && <Text style={{ fontSize: 10, color: '#374151' }}>{paymentOcrMeta.bankName}</Text>}
                          {paymentOcrMeta.bankName && paymentOcrMeta.amount != null && <Text style={{ fontSize: 10, color: '#9B8BAE' }}> · </Text>}
                          {paymentOcrMeta.amount != null && (
                            <Text style={{ fontSize: 10, fontWeight: '700', color: '#16A34A' }}>
                              ₹{Math.round(paymentOcrMeta.amount).toLocaleString('en-IN')}
                            </Text>
                          )}
                        </View>
                      )}
                    </View>
                  ) : (
                    <TouchableOpacity
                      onPress={() => !isReadOnly && pickAndUploadImage('ticket-photos', 'proof-of-payment', (url) => {
                        if (url) onProofOfPaymentChange(url);
                      }, setUploadingPayment)}
                      disabled={isReadOnly || uploadingPayment}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: borderRadius.md, borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#0369A1', backgroundColor: '#fff', opacity: isReadOnly ? 0.5 : 1 }}
                    >
                      {uploadingPayment
                        ? <ActivityIndicator size="small" color="#0369A1" />
                        : <Ionicons name="scan-outline" size={20} color="#0369A1" />
                      }
                      <View>
                        <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#0369A1' }}>
                          {uploadingPayment ? 'Uploading…' : 'Upload Payment Proof (Auto-scan)'}
                        </Text>
                        {!uploadingPayment && (
                          <Text style={{ fontSize: 10, color: '#6B7280', textAlign: 'center', marginTop: 2 }}>
                            {Platform.OS === 'web' ? 'Choose file (image or PDF)' : 'Camera or Gallery'}
                          </Text>
                        )}
                      </View>
                    </TouchableOpacity>
                  )}
                </View>

                {/* Payment Date */}
                <View>
                  <Text style={[formLabel, { color: '#15803D' }]}>Payment Date *</Text>
                  <View style={{ marginTop: 6 }}>
                    <DateField
                      value={form.payment_date}
                      disabled={isReadOnly}
                      onChange={(v) => setForm((p: TicketResolutionForm) => ({ ...p, payment_date: v }))}
                    />
                  </View>
                </View>

                {/* Bank Account */}
                <View>
                  <Text style={[formLabel, { color: '#15803D' }]}>Bank Account *</Text>
                  <TouchableOpacity
                    onPress={() => !isReadOnly && setShowBankPicker(true)}
                    style={[glass.input, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.md, marginTop: 6 }]}
                  >
                    <Text style={{ fontSize: fontSize.md, color: form.bank_account_id ? '#1E1230' : '#9B8BAE' }}>
                      {form.bank_account_id
                        ? (() => {
                          const b = (bankAccounts as BankAccount[]).find((x) => x.id === form.bank_account_id);
                          return b ? `${b.bank_name} ••••${String(b.account_number || '').slice(-4)}` : 'Select bank account';
                        })()
                        : 'Select bank account'
                      }
                    </Text>
                    <Ionicons name="chevron-down" size={16} color="#9B8BAE" />
                  </TouchableOpacity>
                </View>

                {/* Payment Reference */}
                <View>
                  <Text style={[formLabel, { color: '#15803D' }]}>Payment Reference No. *</Text>
                  <TextInput
                    style={[glass.input, { padding: spacing.md, color: '#1E1230', fontSize: fontSize.md, marginTop: 6 }]}
                    placeholder="Txn / UTR / Ref no."
                    placeholderTextColor="#9B8BAE"
                    value={form.payment_reference_no}
                    onChangeText={(v) => !isReadOnly && setForm((p: TicketResolutionForm) => ({ ...p, payment_reference_no: v }))}
                    editable={!isReadOnly}
                  />
                </View>
              </View>
            )}

            {/* Closure Summary */}
            <View>
              <Text style={formLabel}>Closure Comments (visible to tenant)</Text>
              <TextInput
                style={[glass.input, { padding: spacing.md, minHeight: 90, textAlignVertical: 'top', color: '#1E1230', fontSize: fontSize.md, marginTop: 6 }]}
                placeholder="What was done to resolve this issue…"
                placeholderTextColor="#9B8BAE"
                value={form.closure_summary}
                onChangeText={(v) => !isReadOnly && setForm((p: TicketResolutionForm) => ({ ...p, closure_summary: v }))}
                multiline
                editable={!isReadOnly}
              />
            </View>

            {/* Save button */}
            {!isReadOnly && (
              <TouchableOpacity
                onPress={onSave}
                disabled={saving}
                style={{ backgroundColor: '#7B2FBE', borderRadius: borderRadius.lg, paddingVertical: 16, alignItems: 'center', opacity: saving ? 0.6 : 1, marginTop: 8 }}
              >
                {saving
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>Save Resolution & Sync to Accounting</Text>
                }
              </TouchableOpacity>
            )}
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>

      {/* Vendor Picker Modal */}
      <Modal visible={showVendorPicker} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowVendorPicker(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#F7F3F9' }} edges={['top', 'bottom']}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#E0D5EA' }}>
            <TouchableOpacity onPress={() => setShowVendorPicker(false)} style={{ marginRight: 12 }}>
              <Ionicons name="close" size={24} color="#1E1230" />
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#1E1230' }}>Select Vendor</Text>
          </View>
          <ScrollView>
            {vendors.map((v: any) => (
              <TouchableOpacity
                key={v.id}
                onPress={() => { setForm((p: TicketResolutionForm) => ({ ...p, vendor_id: v.id })); setShowVendorPicker(false); }}
                style={{ padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#E0D5EA', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: '#1E1230' }}>{v.vendor_name}</Text>
                  {(v.contact_person || v.phone) ? (
                    <Text style={{ fontSize: fontSize.xs, color: '#6B7280', marginTop: 2 }}>
                      {[v.contact_person, v.phone].filter(Boolean).join(' · ')}
                    </Text>
                  ) : null}
                </View>
                {form.vendor_id === v.id && <Ionicons name="checkmark" size={20} color="#7B2FBE" />}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* Bank Account Picker Modal */}
      <Modal visible={showBankPicker} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowBankPicker(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#F7F3F9' }} edges={['top', 'bottom']}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#E0D5EA' }}>
            <TouchableOpacity onPress={() => setShowBankPicker(false)} style={{ marginRight: 12 }}>
              <Ionicons name="close" size={24} color="#1E1230" />
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#1E1230' }}>Select Bank Account</Text>
          </View>
          <ScrollView>
            {(bankAccounts as BankAccount[]).map((b) => (
              <TouchableOpacity
                key={b.id}
                onPress={() => { setForm((p: TicketResolutionForm) => ({ ...p, bank_account_id: b.id })); setShowBankPicker(false); }}
                style={{ padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#E0D5EA', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <View>
                  <Text style={{ fontSize: fontSize.md, fontWeight: '600', color: '#1E1230' }}>{b.bank_name}</Text>
                  <Text style={{ fontSize: fontSize.xs, color: '#6B7280' }}>
                    ••••{String(b.account_number || '').slice(-4)}{b.is_primary ? ' (Primary)' : ''}
                  </Text>
                </View>
                {form.bank_account_id === b.id && <Ionicons name="checkmark" size={20} color="#7B2FBE" />}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </Modal>
  );
}

const formLabel: any = {
  fontSize: fontSize.xs,
  fontWeight: '700',
  color: '#374151',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

// ─── EXISTING MODALS (unchanged) ──────────────────────────────────────────────

function StatusModal({ visible, onClose, nextStatuses, statusNotes, setStatusNotes, rejectionReason, setRejectionReason, onSubmit, submitting, currentStatus }: any) {
  const { colors } = useTheme();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top', 'bottom']}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <TouchableOpacity onPress={onClose} style={{ marginRight: 12 }}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: colors.text }}>Update Status</Text>
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: 12 }}>
            <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: 4 }}>Select new status:</Text>
            {nextStatuses.map((s: string) => {
              const cfg = STATUS_CONFIG[s] || { label: s, color: '#374151', bg: '#E5E7EB', icon: 'radio-button-off-outline' };
              return (
                <TouchableOpacity
                  key={s}
                  onPress={() => onSubmit(s)}
                  disabled={submitting}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 12,
                    padding: spacing.lg, borderRadius: borderRadius.lg,
                    backgroundColor: cfg.bg, borderWidth: 1, borderColor: cfg.color + '40',
                    opacity: submitting ? 0.6 : 1,
                  }}
                >
                  <Ionicons name={cfg.icon as any} size={22} color={cfg.color} />
                  <View>
                    <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: cfg.color }}>{cfg.label}</Text>
                  </View>
                  {submitting && <ActivityIndicator size="small" color={cfg.color} style={{ marginLeft: 'auto' }} />}
                </TouchableOpacity>
              );
            })}
            <TextInput
              style={[glass.input, { padding: spacing.md, fontSize: fontSize.md, color: colors.text, minHeight: 80, textAlignVertical: 'top' }]}
              placeholder="Notes (optional)..."
              placeholderTextColor={colors.textTertiary}
              value={statusNotes}
              onChangeText={setStatusNotes}
              multiline
            />
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ReassignModal({ visible, onClose, teamMembers, onReassign, submitting }: any) {
  const { colors } = useTheme();
  const [notes, setNotes] = useState('');
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top', 'bottom']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <TouchableOpacity onPress={onClose} style={{ marginRight: 12 }}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: colors.text }}>Assign Technician</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: 10 }}>
          <TextInput
            style={[glass.input, { padding: spacing.md, fontSize: fontSize.md, color: colors.text, marginBottom: 8 }]}
            placeholder="Notes (optional)"
            placeholderTextColor={colors.textTertiary}
            value={notes}
            onChangeText={setNotes}
          />
          {teamMembers.map((m: TeamMember) => (
            <TouchableOpacity
              key={m.id}
              onPress={() => onReassign(m.user_id, notes)}
              disabled={submitting}
              style={[glass.card, { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 0 }]}
            >
              <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#7B2FBE', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>
                  {(m.first_name || 'T')[0].toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: colors.text }}>
                  {m.first_name} {m.last_name}
                </Text>
                <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>{m.designation || 'Technician'}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          ))}
          {teamMembers.length === 0 && (
            <Text style={{ fontSize: fontSize.sm, color: colors.textTertiary, textAlign: 'center', padding: 20 }}>No team members available</Text>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function DiagnosisModal({ visible, onClose, ticketId, issueTypeId, userId, onSubmit, submitting }: any) {
  const { colors } = useTheme();
  const [q1, setQ1] = useState('');
  const [q2, setQ2] = useState('');
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#F7F3F9' }} edges={['top', 'bottom']}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#E0D5EA' }}>
            <TouchableOpacity onPress={onClose} style={{ marginRight: 12 }}>
              <Ionicons name="close" size={24} color="#1E1230" />
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#1E1230' }}>Run Diagnosis</Text>
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: 14 }}>
            <QField label="What is the symptom?" value={q1} onChange={setQ1} />
            <QField label="When did it start?" value={q2} onChange={setQ2} />
            <TouchableOpacity
              onPress={() => onSubmit({
                ticketId, issueTypeId, userId, performedBy: userId,
                questionsAnswers: { 'Symptom': q1, 'When did it start': q2 },
              })}
              disabled={submitting || !q1}
              style={{ backgroundColor: '#0369A1', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center', opacity: (!q1 || submitting) ? 0.5 : 1 }}
            >
              {submitting ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>Submit Diagnosis</Text>}
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function CostEstimateModal({ visible, onClose, guard, onSubmit, submitting }: any) {
  const [noCost, setNoCost] = useState(false);
  const [items, setItems] = useState([{ item_name: '', cost_type: 'parts', quantity: 1, unit_price: 0 }]);

  const addItem = () => setItems(prev => [...prev, { item_name: '', cost_type: 'parts', quantity: 1, unit_price: 0 }]);

  const totalEstimate = items.reduce((s, i) => s + (i.quantity || 1) * (i.unit_price || 0), 0);

  const handleSubmit = () => {
    if (guard.current) return;
    if (noCost) {
      onSubmit([{ item_name: 'No cost required', cost_type: 'labor', quantity: 1, unit_price: 0 }]);
    } else {
      onSubmit(items);
    }
  };

  const canSubmit = noCost || items.some(i => i.item_name && i.unit_price > 0);

  const COST_TYPES = [
    { value: 'parts', label: 'Parts' },
    { value: 'labor', label: 'Labor' },
  ];

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#F7F3F9' }} edges={['top', 'bottom']}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#E0D5EA' }}>
            <TouchableOpacity onPress={onClose} style={{ marginRight: 12 }}>
              <Ionicons name="close" size={24} color="#1E1230" />
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#1E1230' }}>Submit Cost Estimate</Text>
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: 14 }}>
            <Text style={{ fontSize: fontSize.sm, color: '#6B7280', marginBottom: 4 }}>
              Add items (parts/labor) and submit for management approval.
            </Text>

            <TouchableOpacity
              onPress={() => setNoCost(!noCost)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: noCost ? '#DCFCE7' : '#fff', padding: spacing.md, borderRadius: borderRadius.md, borderWidth: 1, borderColor: noCost ? '#16A34A' : '#D1D5DB' }}
            >
              <Ionicons name={noCost ? 'checkbox' : 'square-outline'} size={20} color={noCost ? '#16A34A' : '#6B7280'} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: fontSize.sm, color: noCost ? '#16A34A' : '#374151', fontWeight: noCost ? '700' : '400' }}>
                  No cost required
                </Text>
                <Text style={{ fontSize: fontSize.xs, color: '#6B7280' }}>
                  Select if this issue needs no parts or payment
                </Text>
              </View>
            </TouchableOpacity>

            {!noCost && (
              <>
                {items.map((item, idx) => (
                  <View key={idx} style={{ backgroundColor: '#fff', borderRadius: borderRadius.md, padding: spacing.md, borderWidth: 1, borderColor: '#E5E7EB' }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#5C4B70' }}>Item {idx + 1}</Text>
                      {items.length > 1 && (
                        <TouchableOpacity onPress={() => setItems(prev => prev.filter((_, i) => i !== idx))}>
                          <Ionicons name="trash-outline" size={16} color="#DC2626" />
                        </TouchableOpacity>
                      )}
                    </View>

                    <TextInput
                      style={[glass.input, { padding: spacing.sm, color: '#1E1230', fontSize: fontSize.sm, marginBottom: 8 }]}
                      placeholder="Item name (e.g. Capacitor)"
                      placeholderTextColor="#9B8BAE"
                      value={item.item_name}
                      onChangeText={(v) => { const n = [...items]; n[idx] = { ...n[idx], item_name: v }; setItems(n); }}
                    />

                    {/* Cost type toggle — matches web Parts/Labor select */}
                    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                      {COST_TYPES.map((ct) => (
                        <TouchableOpacity
                          key={ct.value}
                          onPress={() => { const n = [...items]; n[idx] = { ...n[idx], cost_type: ct.value }; setItems(n); }}
                          style={{
                            flex: 1, paddingVertical: 7, borderRadius: borderRadius.md, alignItems: 'center',
                            backgroundColor: item.cost_type === ct.value ? '#7B2FBE' : '#F3F4F6',
                            borderWidth: 1, borderColor: item.cost_type === ct.value ? '#7B2FBE' : '#D1D5DB',
                          }}
                        >
                          <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: item.cost_type === ct.value ? '#fff' : '#374151' }}>
                            {ct.label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 10, color: '#6B7280', marginBottom: 2 }}>Quantity</Text>
                        <TextInput
                          style={[glass.input, { padding: spacing.sm, color: '#1E1230', fontSize: fontSize.sm, textAlign: 'center' }]}
                          keyboardType="numeric"
                          value={String(item.quantity)}
                          onChangeText={(v) => { const n = [...items]; n[idx] = { ...n[idx], quantity: parseInt(v) || 1 }; setItems(n); }}
                        />
                      </View>
                      <View style={{ flex: 2 }}>
                        <Text style={{ fontSize: 10, color: '#6B7280', marginBottom: 2 }}>Unit Price (₹)</Text>
                        <TextInput
                          style={[glass.input, { padding: spacing.sm, color: '#1E1230', fontSize: fontSize.sm }]}
                          keyboardType="numeric"
                          value={String(item.unit_price)}
                          onChangeText={(v) => { const n = [...items]; n[idx] = { ...n[idx], unit_price: parseFloat(v) || 0 }; setItems(n); }}
                        />
                      </View>
                    </View>
                    <Text style={{ fontSize: fontSize.xs, color: '#7B2FBE', marginTop: 6, fontWeight: '700', textAlign: 'right' }}>
                      Subtotal: ₹{((item.quantity || 1) * (item.unit_price || 0)).toLocaleString('en-IN')}
                    </Text>
                  </View>
                ))}

                <TouchableOpacity onPress={addItem} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: spacing.md }}>
                  <Ionicons name="add-circle-outline" size={20} color="#7B2FBE" />
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#7B2FBE' }}>Add Another Item</Text>
                </TouchableOpacity>

                {/* Running total — mirrors web */}
                {items.some(i => i.item_name || i.unit_price > 0) && (
                  <View style={{ backgroundColor: '#EDE9FE', borderRadius: borderRadius.md, padding: spacing.md, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#5C4B70' }}>Total</Text>
                    <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#7B2FBE' }}>
                      ₹{totalEstimate.toLocaleString('en-IN')}
                    </Text>
                  </View>
                )}
              </>
            )}

            <TouchableOpacity
              onPress={handleSubmit}
              disabled={submitting || !canSubmit}
              style={{
                backgroundColor: noCost ? '#16A34A' : '#7B2FBE',
                borderRadius: borderRadius.lg, paddingVertical: 14,
                alignItems: 'center', opacity: (submitting || !canSubmit) ? 0.6 : 1,
              }}
            >
              {submitting
                ? <ActivityIndicator color="#fff" />
                : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>
                  {noCost ? 'Submit — No Cost' : 'Submit for Approval'}
                </Text>
              }
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
function PurchaseModal({ visible, onClose, onSubmit, submitting, vendors = [] }: any) {
  const [itemName, setItemName] = useState('');
  const [qty, setQty] = useState('1');
  const [cost, setCost] = useState('');
  const [vendor, setVendor] = useState('');
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);
  const [showVendorDropdown, setShowVendorDropdown] = useState(false);

  const selectedVendorObj = vendors.find((v: any) => v.id === selectedVendorId);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#F7F3F9' }} edges={['top', 'bottom']}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#E0D5EA' }}>
            <TouchableOpacity onPress={onClose} style={{ marginRight: 12 }}>
              <Ionicons name="close" size={24} color="#1E1230" />
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#1E1230' }}>Record Purchase</Text>
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: 14 }}>
            <QField label="Item Purchased" value={itemName} onChange={setItemName} />
            <QField label="Quantity" value={qty} onChange={setQty} />
            <QField label="Actual Cost (₹)" value={cost} onChange={setCost} />

            {/* Vendor — dropdown if vendors exist, else free text */}
            <View>
              <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#5C4B70', marginBottom: 6 }}>Vendor Name</Text>
              {vendors.length > 0 ? (
                <View>
                  <TouchableOpacity
                    onPress={() => setShowVendorDropdown(true)}
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.5, borderColor: '#D1D5DB', borderRadius: 10, padding: spacing.md, backgroundColor: '#fff' }}
                  >
                    <Text style={{ fontSize: fontSize.md, color: selectedVendorId ? '#1E1230' : '#9B8BAE' }}>
                      {selectedVendorObj ? selectedVendorObj.vendor_name : 'Select vendor'}
                    </Text>
                    <Ionicons name="chevron-down" size={16} color="#9B8BAE" />
                  </TouchableOpacity>
                  {selectedVendorObj && (selectedVendorObj.contact_person || selectedVendorObj.phone) ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, paddingHorizontal: 4 }}>
                      <Ionicons name="information-circle-outline" size={13} color="#6B7280" />
                      <Text style={{ fontSize: 11, color: '#6B7280' }}>
                        {[selectedVendorObj.contact_person, selectedVendorObj.phone].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                  ) : null}
                  <Text style={{ fontSize: 11, color: '#9B8BAE', marginTop: 6 }}>Or enter manually:</Text>
                  <TextInput
                    style={{ borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 8, padding: spacing.sm, fontSize: fontSize.sm, color: '#1E1230', marginTop: 4, backgroundColor: '#fff' }}
                    placeholder="Vendor name (manual)"
                    placeholderTextColor="#9B8BAE"
                    value={vendor}
                    onChangeText={(v) => { setVendor(v); if (v) setSelectedVendorId(null); }}
                  />
                </View>
              ) : (
                <TextInput
                  style={{ borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 8, padding: spacing.md, fontSize: fontSize.md, color: '#1E1230', backgroundColor: '#fff' }}
                  placeholder="Vendor name"
                  placeholderTextColor="#9B8BAE"
                  value={vendor}
                  onChangeText={setVendor}
                />
              )}
            </View>

            <TouchableOpacity
              onPress={() => onSubmit({
                items: [{ item_name: itemName, quantity: parseInt(qty) || 1, actual_cost: parseFloat(cost) || 0 }],
                vendorNameManual: selectedVendorObj ? selectedVendorObj.vendor_name : vendor,
              })}
              disabled={submitting || !itemName || !cost}
              style={{ backgroundColor: '#16A34A', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center', opacity: submitting ? 0.6 : 1 }}
            >
              {submitting ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>Record Purchase</Text>}
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>

      {/* Vendor selector modal */}
      <Modal visible={showVendorDropdown} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowVendorDropdown(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#F7F3F9' }} edges={['top', 'bottom']}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#E0D5EA' }}>
            <TouchableOpacity onPress={() => setShowVendorDropdown(false)} style={{ marginRight: 12 }}>
              <Ionicons name="close" size={24} color="#1E1230" />
            </TouchableOpacity>
            <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#1E1230' }}>Select Vendor</Text>
          </View>
          <ScrollView>
            {vendors.map((v: any) => (
              <TouchableOpacity
                key={v.id}
                onPress={() => { setSelectedVendorId(v.id); setVendor(''); setShowVendorDropdown(false); }}
                style={{ padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#E0D5EA', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: fontSize.md, fontWeight: '700', color: '#1E1230' }}>{v.vendor_name}</Text>
                  {(v.contact_person || v.phone) ? (
                    <Text style={{ fontSize: fontSize.xs, color: '#6B7280', marginTop: 2 }}>
                      {[v.contact_person, v.phone].filter(Boolean).join(' · ')}
                    </Text>
                  ) : null}
                </View>
                {selectedVendorId === v.id && <Ionicons name="checkmark" size={20} color="#7B2FBE" />}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </Modal>
  );
}

function ApprovalModal({ visible, onClose, onApprove, submitting }: any) {
  const [rejectionNote, setRejectionNote] = useState('');
  const [showReject, setShowReject] = useState(false);
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#F7F3F9' }} edges={['top', 'bottom']}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#E0D5EA' }}>
          <TouchableOpacity onPress={onClose} style={{ marginRight: 12 }}>
            <Ionicons name="close" size={24} color="#1E1230" />
          </TouchableOpacity>
          <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#1E1230' }}>Review Completion</Text>
        </View>
        <View style={{ flex: 1, padding: spacing.xl, gap: 16 }}>
          <View style={{ backgroundColor: '#EDE9FE', borderRadius: borderRadius.xl, padding: spacing.xl, alignItems: 'center' }}>
            <Ionicons name="checkmark-circle-outline" size={48} color="#7B2FBE" />
            <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: '#1E1230', marginTop: 12, textAlign: 'center' }}>
              Maintenance work has been completed
            </Text>
            <Text style={{ fontSize: fontSize.sm, color: '#5C4B70', marginTop: 8, textAlign: 'center' }}>
              Please verify the work and approve or request rework.
            </Text>
          </View>
          {!showReject ? (
            <>
              <TouchableOpacity onPress={() => onApprove(true)} disabled={submitting}
                style={{ backgroundColor: '#16A34A', borderRadius: borderRadius.lg, paddingVertical: 16, alignItems: 'center' }}>
                {submitting ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>Accept & Close</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowReject(true)}
                style={{ backgroundColor: '#FEE2E2', borderRadius: borderRadius.lg, paddingVertical: 16, alignItems: 'center' }}>
                <Text style={{ color: '#DC2626', fontWeight: '800', fontSize: fontSize.md }}>Not Resolved</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TextInput
                style={[glass.input, { padding: spacing.md, color: '#1E1230', minHeight: 100, textAlignVertical: 'top' }]}
                placeholder="Describe what needs to be redone..."
                placeholderTextColor="#9B8BAE"
                value={rejectionNote}
                onChangeText={setRejectionNote}
                multiline
              />
              <TouchableOpacity onPress={() => onApprove(false, rejectionNote)} disabled={submitting || !rejectionNote.trim()}
                style={{ backgroundColor: '#DC2626', borderRadius: borderRadius.lg, paddingVertical: 14, alignItems: 'center', opacity: (!rejectionNote.trim() || submitting) ? 0.5 : 1 }}>
                {submitting ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '800', fontSize: fontSize.md }}>Send Back for Rework</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowReject(false)}>
                <Text style={{ color: '#5C4B70', textAlign: 'center', fontSize: fontSize.sm }}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function QField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const { colors } = useTheme();
  return (
    <View>
      <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, marginBottom: 4, fontWeight: '600' }}>{label}</Text>
      <TextInput
        style={[glass.input, { padding: spacing.md, fontSize: fontSize.md, color: colors.text }]}
        value={value}
        onChangeText={onChange}
        placeholderTextColor={colors.textTertiary}
        placeholder={label}
      />
    </View>
  );
}
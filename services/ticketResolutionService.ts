import { client, api } from '../lib/convexApi';

export interface ResolutionItem {
  name: string;
  qty: number;
  unit_cost: number;
  total: number;
}

export interface BankAccount {
  id: string;
  bank_name: string;
  account_number: string;
  ifsc_code?: string | null;
  is_primary?: boolean;
  status?: string;
}

export interface TicketResolutionForm {
  resolution_type: 'inhouse' | 'outside' | 'amc' | 'charged';
  service_type: 'condition_service' | 'replaced' | 'new_install' | 'repair';
  vendor_id: string | null;
  vendor_name_manual: string;
  items: ResolutionItem[];
  total_labour_cost: number;
  payment_date: string;
  bank_account_id: string | null;
  payment_reference_no: string;
  proof_of_purchase_url: string | null;
  proof_of_payment_url: string | null;
  closure_summary: string;
}

export const DEFAULT_RESOLUTION_FORM: TicketResolutionForm = {
  resolution_type: 'inhouse',
  service_type: 'repair',
  vendor_id: null,
  vendor_name_manual: '',
  items: [{ name: '', qty: 1, unit_cost: 0, total: 0 }],
  total_labour_cost: 0,
  payment_date: '',
  bank_account_id: null,
  payment_reference_no: '',
  proof_of_purchase_url: null,
  proof_of_payment_url: null,
  closure_summary: '',
};

export function populateFormFromResolution(resolution: any): TicketResolutionForm {
  const items = Array.isArray(resolution?.items_used)
    ? resolution.items_used.map((item: any) => ({
        name: String(item?.name || ''),
        qty: Number(item?.qty) || 1,
        unit_cost: Number(item?.unit_cost) || 0,
        total: Number(item?.total) || (Number(item?.qty) || 1) * (Number(item?.unit_cost) || 0),
      }))
    : DEFAULT_RESOLUTION_FORM.items;

  return {
    resolution_type: (resolution?.resolution_type || 'inhouse') as TicketResolutionForm['resolution_type'],
    service_type: (resolution?.service_type || 'repair') as TicketResolutionForm['service_type'],
    vendor_id: resolution?.vendor_id ?? null,
    vendor_name_manual: resolution?.vendor_name_manual || '',
    items,
    total_labour_cost: Number(resolution?.total_labour_cost) || 0,
    payment_date: resolution?.payment_date || '',
    bank_account_id: resolution?.bank_account_id ?? null,
    payment_reference_no: resolution?.payment_reference_no || '',
    proof_of_purchase_url: resolution?.proof_of_purchase_url ?? null,
    proof_of_payment_url: resolution?.proof_of_payment_url ?? null,
    closure_summary: resolution?.closure_summary || '',
  };
}

export async function fetchResolution(ticketId: string): Promise<any | null> {
  try {
    return await client.action(api.tickets.getResolution, { ticketId });
  } catch (error) {
    console.warn('[ticketResolutionService] fetchResolution failed');
    return null;
  }
}

export async function fetchBankAccounts(): Promise<BankAccount[]> {
  try {
    const data = await client.action(api.tenants.getLifecycleFullData, {});
    return Array.isArray(data?.bankAccounts) ? data.bankAccounts : [];
  } catch (error) {
    console.warn('[ticketResolutionService] fetchBankAccounts failed');
    return [];
  }
}

export async function fetchVendors(): Promise<any[]> {
  try {
    return await client.action(api.tickets.getVendors, {});
  } catch (error) {
    console.warn('[ticketResolutionService] fetchVendors failed');
    return [];
  }
}

export async function saveResolution(args: {
  ticketId: string;
  organizationId: string;
  form: TicketResolutionForm;
  existingResolutionId?: string | null;
}): Promise<string> {
  const totalParts = (args.form.items || []).reduce((sum, item) => sum + (Number(item.total) || ((Number(item.qty) || 0) * (Number(item.unit_cost) || 0))), 0);
  const totalLabourCost = Number(args.form.total_labour_cost) || 0;
  const totalCost = totalParts + totalLabourCost;

  const result = await client.action(api.tickets.saveResolution, {
    ticketId: args.ticketId,
    userId: args.organizationId,
    resolutionType: args.form.resolution_type,
    serviceType: args.form.service_type,
    closureSummary: args.form.closure_summary,
    totalLabourCost,
    vendorNameManual: args.form.vendor_name_manual || undefined,
    items: args.form.items,
    paymentDate: args.form.payment_date || undefined,
    proofUrl: args.form.proof_of_purchase_url || undefined,
  });

  return result?.resolutionId || args.existingResolutionId || args.ticketId;
}

export async function deleteResolution(_args: { ticketId: string; resolutionId?: string | null }): Promise<{ success: boolean }> {
  return { success: true };
}

export async function unlockResolutionEditing(_args: { ticketId: string; organizationId: string; userId: string; reason?: string }): Promise<{ success: boolean }> {
  return { success: true };
}

export async function ocrPaymentImage(_url: string, _bankAccounts: BankAccount[]): Promise<{
  reference: string;
  paymentDate: string;
  bankName?: string;
  amount?: number;
  matchedBankAccountId?: string;
}> {
  return {
    reference: '',
    paymentDate: '',
  };
}

export async function syncTicketResolutionExpense(_args: any): Promise<{ success: boolean }> {
  return { success: true };
}
/**
 * Invoice & payment-receipt → HTML → shareable PDF. Clean, self-contained
 * builders (not the web app's 592-line config/theme-driven builder) over the
 * fields the mobile Accounting screen already has. Shares via lib/pdfShare.
 */
import { htmlToPdfAndShare } from './pdfShare';

const inr = (n: number) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const esc = (s: any) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const today = () => new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

const SHELL = (title: string, accent: string, headerRows: string, bodyHtml: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #0F172A; margin: 0; padding: 32px; }
  .card { max-width: 680px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 16px; overflow: hidden; }
  .head { background: ${accent}; color: #fff; padding: 22px 26px; display: flex; justify-content: space-between; align-items: flex-start; }
  .org { font-size: 18px; font-weight: 800; letter-spacing: .3px; }
  .doc { font-size: 12px; opacity: .9; margin-top: 2px; text-transform: uppercase; letter-spacing: 1.5px; }
  .meta { text-align: right; font-size: 12px; opacity: .95; }
  .meta strong { font-size: 14px; }
  .body { padding: 24px 26px; }
  .kv { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 18px; font-size: 13px; }
  .kv .col { max-width: 55%; }
  .lbl { color: #94A3B8; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; }
  .val { color: #0F172A; font-weight: 700; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #64748B; border-bottom: 1px solid #E2E8F0; padding: 8px 0; }
  th.r, td.r { text-align: right; }
  td { padding: 11px 0; border-bottom: 1px solid #EEF2F7; font-size: 14px; }
  .tot { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 14px 18px; }
  .tot .k { font-size: 13px; font-weight: 700; color: #334155; }
  .tot .v { font-size: 22px; font-weight: 900; }
  .badge { display: inline-block; font-size: 11px; font-weight: 800; text-transform: capitalize; padding: 3px 10px; border-radius: 8px; }
  .foot { padding: 16px 26px; border-top: 1px solid #EEF2F7; font-size: 10px; color: #94A3B8; }
</style></head>
<body>
  <div class="card">
    <div class="head">
      <div><div class="org">${esc(title)}</div><div class="doc">${headerRows}</div></div>
    </div>
    ${bodyHtml}
    <div class="foot">Generated ${today()} · This is a computer-generated document and does not require a signature.</div>
  </div>
</body></html>`;

export interface InvoicePdfData {
  invoiceNumber?: string;
  tenantName?: string;
  propertyName?: string;
  billingMonth?: string;
  rentAmount?: number;
  electricityAmount?: number;
  otherCharges?: number;
  totalAmount?: number;
  paidAmount?: number;
  dueDate?: string | null;
  status?: string;
}

export function buildInvoiceHtml(inv: InvoicePdfData, orgName: string): string {
  const total = Number(inv.totalAmount) || 0;
  const paid = Number(inv.paidAmount) || 0;
  const balance = Math.max(total - paid, 0);
  const statusColor: Record<string, string> = {
    paid: 'background:#DCFCE7;color:#16A34A', partial: 'background:#FEF3C7;color:#B45309',
    overdue: 'background:#FEE2E2;color:#DC2626',
  };
  const line = (label: string, amt?: number) =>
    (Number(amt) || 0) > 0 ? `<tr><td>${esc(label)}</td><td class="r">${inr(amt as number)}</td></tr>` : '';
  const rows = [
    line('Rent', inv.rentAmount),
    line('Electricity', inv.electricityAmount),
    line('Other charges', inv.otherCharges),
  ].filter(Boolean).join('') || `<tr><td>Charges</td><td class="r">${inr(total)}</td></tr>`;

  const body = `
    <div class="body">
      <div class="kv">
        <div class="col">
          <div class="lbl">Billed to</div>
          <div class="val">${esc(inv.tenantName || 'Tenant')}</div>
          ${inv.propertyName ? `<div style="color:#64748B;font-size:12px;">${esc(inv.propertyName)}</div>` : ''}
        </div>
        <div style="text-align:right;">
          <div class="lbl">Billing month</div>
          <div class="val">${esc(inv.billingMonth || '—')}</div>
          ${inv.dueDate ? `<div class="lbl" style="margin-top:6px;">Due date</div><div class="val">${esc(inv.dueDate)}</div>` : ''}
          ${inv.status ? `<div style="margin-top:8px;"><span class="badge" style="${statusColor[String(inv.status).toLowerCase()] || 'background:#EEF3FF;color:#1D4ED8'}">${esc(inv.status)}</span></div>` : ''}
        </div>
      </div>
      <table>
        <tr><th>Description</th><th class="r">Amount</th></tr>
        ${rows}
      </table>
      ${paid > 0 ? `<div style="display:flex;justify-content:space-between;font-size:13px;color:#334155;margin-top:12px;"><span>Paid</span><span style="font-weight:700;">− ${inr(paid)}</span></div>` : ''}
      <div class="tot">
        <span class="k">${paid > 0 ? 'Balance due' : 'Total'}</span>
        <span class="v">${inr(paid > 0 ? balance : total)}</span>
      </div>
    </div>`;

  const header = `Invoice ${esc(inv.invoiceNumber || '')}`.trim();
  return SHELL(orgName, '#2563EB', header, body);
}

export interface ReceiptPdfData {
  amount_paid?: number;
  base_amount?: number;
  processing_fee?: number;
  payment_mode?: string | null;
  reference_number?: string | null;
  payment_date?: string | null;
  receipt_type?: string | null;
}

export function buildReceiptHtml(rcpt: ReceiptPdfData, tenantName: string, orgName: string): string {
  const amount = Number(rcpt.amount_paid) || 0;
  const kv = (label: string, value: string) =>
    value ? `<div style="display:flex;justify-content:space-between;font-size:14px;padding:11px 0;border-bottom:1px solid #EEF2F7;"><span style="color:#556274;">${esc(label)}</span><span style="font-weight:700;">${esc(value)}</span></div>` : '';
  const body = `
    <div class="body">
      <div class="kv">
        <div class="col">
          <div class="lbl">Received from</div>
          <div class="val">${esc(tenantName || 'Tenant')}</div>
        </div>
        <div style="text-align:right;">
          <div class="lbl">Date</div>
          <div class="val">${esc(rcpt.payment_date || today())}</div>
        </div>
      </div>
      ${kv('Payment mode', String(rcpt.payment_mode || '').toUpperCase())}
      ${kv('Reference', rcpt.reference_number || '')}
      ${kv('Type', rcpt.receipt_type || '')}
      <div class="tot">
        <span class="k">Amount received</span>
        <span class="v" style="color:#16A34A;">${inr(amount)}</span>
      </div>
    </div>`;
  return SHELL(orgName, '#16A34A', 'Payment Receipt', body);
}

export async function shareInvoicePdf(inv: InvoicePdfData, orgName: string): Promise<void> {
  await htmlToPdfAndShare(buildInvoiceHtml(inv, orgName), { dialogTitle: 'Share Invoice' });
}

export async function shareReceiptPdf(rcpt: ReceiptPdfData, tenantName: string, orgName: string): Promise<void> {
  await htmlToPdfAndShare(buildReceiptHtml(rcpt, tenantName, orgName), { dialogTitle: 'Share Receipt' });
}

/**
 * Salary pay-slip → HTML → PDF (via expo-print), shared through the native
 * share sheet. Mirrors the inlined Registration PDF pattern in
 * TenantLifecycleScreen (guarded `require` so the bundle never hard-fails
 * where the native modules are absent). Kept in lib/ (NOT convex/) — the
 * convex-bundling gotcha with expo-print only affects files under convex/.
 *
 * Pure presentation over an already-computed team_salary_bills row. No
 * generation, no schema, no backend call.
 */
import { Platform } from 'react-native';

export interface PayslipData {
  orgName: string;
  employeeName: string;
  designation?: string | null;
  /** Payroll month/period label as stored on the bill (e.g. "Aug-26" or "2026-08"). */
  month: string;
  presentDays: number;
  workingDays: number;
  baseSalary: number;
  earnedSalary: number;
  advanceDeducted: number;
  otherDeductions: number;
  netPayable: number;
  status: string;
}

const inr = (n: number) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const esc = (s: string) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Build a single-page pay-slip as HTML. */
export function buildPayslipHtml(d: PayslipData): string {
  const deductions = (Number(d.advanceDeducted) || 0) + (Number(d.otherDeductions) || 0);
  const generatedOn = new Date().toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
  const statusLabel = (d.status || 'draft').replace(/_/g, ' ');

  const row = (label: string, value: string, opts: { negative?: boolean } = {}) => `
    <tr>
      <td class="lbl">${esc(label)}</td>
      <td class="val${opts.negative ? ' neg' : ''}">${value}</td>
    </tr>`;

  const lines: string[] = [
    row('Base salary', inr(d.baseSalary)),
    row('Days present', `${d.presentDays ?? 0} / ${d.workingDays ?? 0}`),
    row('Earned salary', inr(d.earnedSalary)),
  ];
  if ((Number(d.advanceDeducted) || 0) > 0) lines.push(row('Advance deducted', `− ${inr(d.advanceDeducted)}`, { negative: true }));
  if ((Number(d.otherDeductions) || 0) > 0) lines.push(row('Other deductions', `− ${inr(d.otherDeductions)}`, { negative: true }));

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #0F172A; margin: 0; padding: 32px; }
  .card { max-width: 640px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 16px; overflow: hidden; }
  .head { background: #2563EB; color: #fff; padding: 22px 26px; }
  .org { font-size: 18px; font-weight: 800; letter-spacing: .3px; }
  .doc { font-size: 12px; opacity: .9; margin-top: 2px; text-transform: uppercase; letter-spacing: 1.5px; }
  .body { padding: 24px 26px; }
  .emp { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
  .emp .name { font-size: 18px; font-weight: 800; }
  .emp .desig { font-size: 12px; color: #64748B; margin-top: 2px; }
  .emp .month { font-size: 12px; color: #64748B; text-align: right; }
  .badge { display: inline-block; margin-top: 6px; font-size: 11px; font-weight: 800; text-transform: capitalize;
           padding: 3px 10px; border-radius: 8px; background: #EEF3FF; color: #1D4ED8; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 11px 0; border-bottom: 1px solid #EEF2F7; font-size: 14px; }
  td.lbl { color: #556274; }
  td.val { text-align: right; font-weight: 700; }
  td.val.neg { color: #DC2626; }
  .net { display: flex; justify-content: space-between; align-items: center; margin-top: 18px;
         background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 16px 18px; }
  .net .k { font-size: 13px; font-weight: 700; color: #334155; }
  .net .v { font-size: 22px; font-weight: 900; }
  .foot { padding: 16px 26px; border-top: 1px solid #EEF2F7; font-size: 10px; color: #94A3B8; }
</style></head>
<body>
  <div class="card">
    <div class="head">
      <div class="org">${esc(d.orgName)}</div>
      <div class="doc">Salary Slip</div>
    </div>
    <div class="body">
      <div class="emp">
        <div>
          <div class="name">${esc(d.employeeName)}</div>
          ${d.designation ? `<div class="desig">${esc(d.designation)}</div>` : ''}
          <span class="badge">${esc(statusLabel)}</span>
        </div>
        <div class="month">Pay period<br/><strong style="color:#0F172A;font-size:14px;">${esc(d.month)}</strong></div>
      </div>
      <table>${lines.join('')}</table>
      <div class="net">
        <span class="k">Net payable${deductions > 0 ? ` (after ${inr(deductions)} deductions)` : ''}</span>
        <span class="v">${inr(d.netPayable)}</span>
      </div>
    </div>
    <div class="foot">Generated ${generatedOn} · This is a computer-generated pay-slip and does not require a signature.</div>
  </div>
</body></html>`;
}

/**
 * Build the pay-slip and hand it to the OS: a shareable PDF on native
 * (expo-print + expo-sharing), or a print window on web.
 * Throws a friendly Error if the native modules aren't available.
 */
export async function generateAndSharePayslip(d: PayslipData): Promise<void> {
  const html = buildPayslipHtml(d);

  if (Platform.OS === 'web') {
    const w = typeof window !== 'undefined' ? window.open('', '_blank') : null;
    if (!w) throw new Error('Allow pop-ups to open the pay-slip for printing.');
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* user can print manually */ } }, 350);
    return;
  }

  let Print: any;
  try { Print = require('expo-print'); }
  catch { throw new Error('PDF module (expo-print) is not available in this build.'); }
  const { uri } = await Print.printToFileAsync({ html, base64: false });

  let Sharing: any;
  try { Sharing = require('expo-sharing'); }
  catch { throw new Error('Sharing module (expo-sharing) is not available.'); }
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    dialogTitle: 'Share Pay-slip',
    UTI: 'com.adobe.pdf',
  });
}

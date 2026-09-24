/**
 * registrationPdf.ts — mobile equivalent of web src/lib/registration-pdf.ts.
 * Builds the Vishful 2-page Registration form as HTML and renders it to a PDF
 * file via expo-print. Layout/content mirror the web pdf-lib version:
 *   Page 1: Tenant Information + Lease Information + Payment Details
 *   Page 2: Terms of Stay (12 acknowledgements, with sub-items) + signatures
 *
 * expo-print is loaded lazily (guarded require) so the bundle never hard-fails
 * if the native module is unavailable in a given build.
 */

export interface RegistrationPdfData {
  firstName?: string;
  lastName?: string;
  address?: string;
  city?: string;
  email?: string;
  aadhaarNumber?: string;
  aadhaarProvided?: boolean;
  companyName?: string;
  mobile?: string;
  parentMobile?: string;
  aptNo?: string;
  roomNo?: string;
  bedType?: string;
  toiletType?: string;
  startDate?: string;
  stayPeriod?: string;
  refundableAdvance?: number | string;
  rentalAmount?: number | string;
  calculatedFromDate?: string;
  vehicleType?: '2W' | '4W' | '' | string;
  vehicleNumber?: string;
  vehicleCharge?: number | string;
  onBoardingCharges?: number | string;
  ccCharges?: number | string;
  totalDue?: number | string;
  paidVia?: string;
  referenceNumber?: string;
  paymentMode?: string;
  paidAmount?: number | string;
  bankAccount?: string;
}

// ── Terms of Stay (verbatim from web PAGE2_LAYOUT.bullets) ──
export interface TermItem { id: string; text: string; subItems?: string[]; footnote?: string }
export const TERMS_OF_STAY: TermItem[] = [
  { id: 'p1', text: 'Rentals to paid in ADVANCE before the 7th of Every month along with the previous month Electricity Bill.' },
  { id: 'p2', text: 'If Not in property for more than a continuous period of more than 30 days, prior intimation by email has to be sent to wecare@vishful.co.in, to get the credit for EB.' },
  { id: 'p3', text: 'All payments to be made to Vishful QR Code or Account as indicated in Invoice Message. A fine of Rs. 100/- per day will be charged as late payment fees beyond the 7th.' },
  { id: 's1', text: 'Minimum stay is 2 months and the Stay is restricted to YOU as an individual ONLY.' },
  { id: 's2', text: 'GUEST stay is permitted Only For Parents of current/Former Tenants with prior consent through email to wecare@vishful.co.in on a payment of Rs. 1,000/- per person per day. VISHFUL does not PERMIT guest Stay consent through Care Takers considering tenant Security and Safety. The allocation of room will be made by Management.' },
  { id: 's3', text: 'Maintenance issues or complaints to be raised as tickets at VISHFUL Tenants Login.' },
  { id: 'e1', text: 'Notice of Exit should be sent by email to wecare@vishful.co.in OR through the Vishful Login, 30 days prior to the date of Exit.' },
  { id: 'e2', text: 'Exit will be 30 days from the date of Notice, notice to be sent by email to wecare@vishful.co.in. If Notice is Not given, then Deposit will be adjusted towards the Rental and other Dues, and Deposit shall not be Refunded.' },
  { id: 'e3', text: 'Pending Rentals or dues will NOT be adjusted with ADVANCE.' },
  { id: 't1', text: 'If Rental dues are not paid within 14th of each month, the Agreement will be automatically cancelled with immediate effect and you will have to vacate the property within 24 hours.' },
  { id: 't2', text: 'VISHFUL can terminate without cause, by giving 1 day notice via email or WhatsApp.' },
  {
    id: 't3',
    text: 'Immediate Termination without notice/intimation if you:',
    subItems: [
      'A. Allow members of opposite Sex into your Apartment/Room which is STRICTLY PROHIBITED.',
      'B. Consume Alcohol / Smoking / any kind of Drugs (It will be Reported to Police).',
      'C. Not Adhering to the Rules of Stay at Vishful.',
      'D. Bring in Friends / Family members to stay without our knowledge or without prior email intimation.',
    ],
    footnote: 'Under such termination, Advance will NOT be refunded.',
  },
];

const PURPLE = '#7B2FBE';
const ORANGE = '#E8841A';

const fmtAmt = (v: number | string | undefined): string => {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString('en-IN');
};
const esc = (v: any): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const field = (label: string, value: string, opts?: { bold?: boolean }) => `
  <div class="field">
    <div class="flabel">${esc(label)}</div>
    <div class="fvalue${opts?.bold ? ' b' : ''}">${esc(value) || '&nbsp;'}</div>
  </div>`;

const amountRow = (label: string, amount: string, opts?: { bold?: boolean }) => `
  <div class="arow${opts?.bold ? ' b' : ''}">
    <div class="alabel">${esc(label)}</div>
    <div class="aval"><span class="rs">Rs.</span> ${esc(amount) || '0'}</div>
  </div>`;

const checkbox = (checked: boolean, label: string) => `
  <span class="cb">${checked ? '<span class="cbx">&#10003;</span>' : '<span class="cbx">&nbsp;</span>'} ${esc(label)}</span>`;

/** Build the registration HTML (2 pages). ticks marks the acknowledged terms. */
export function buildRegistrationHtml(d: RegistrationPdfData, ticks: Record<string, boolean> = {}): string {
  const fullName = [d.firstName, d.lastName].filter(Boolean).join(' ');
  const bt = (d.bedType || '').toString();
  const tt = (d.toiletType || '').toString();

  const termsHtml = TERMS_OF_STAY.map((t, i) => `
    <div class="term">
      ${checkbox(!!ticks[t.id], '')}
      <div class="ttext">
        <span class="tn">${i + 1}.</span> ${esc(t.text)}
        ${t.subItems ? `<div class="subs">${t.subItems.map((s) => `<div class="sub">${esc(s)}</div>`).join('')}</div>` : ''}
        ${t.footnote ? `<div class="foot">${esc(t.footnote)}</div>` : ''}
      </div>
    </div>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 0; font-size: 11px; }
    .page { padding: 28px 30px; page-break-after: always; }
    .page:last-child { page-break-after: auto; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
    .head .title { font-size: 26px; font-weight: 800; color: ${PURPLE}; letter-spacing: -0.5px; }
    .head .sub { font-size: 9px; color: #6b6b72; margin-top: 2px; }
    .head .brand { text-align: right; }
    .head .brand .b1 { font-size: 20px; font-weight: 800; color: ${ORANGE}; }
    .head .brand .b2 { font-size: 8px; color: #6b6b72; letter-spacing: 1px; }
    .banner { background: ${PURPLE}; color: #fff; text-align: center; font-weight: 700; font-size: 12px; padding: 6px; border-radius: 4px; margin: 14px 0 10px; letter-spacing: 0.5px; }
    .grid2 { display: flex; flex-wrap: wrap; gap: 10px; }
    .field { flex: 1 1 45%; border: 1px solid #c8c8cc; border-radius: 5px; padding: 6px 8px; min-width: 0; }
    .field.full { flex: 1 1 100%; }
    .flabel { font-size: 7.5px; color: #74747a; text-transform: uppercase; letter-spacing: 0.3px; }
    .fvalue { font-size: 11px; font-weight: 600; margin-top: 2px; min-height: 13px; }
    .fvalue.b { font-weight: 800; }
    .arow { display: flex; justify-content: space-between; align-items: center; border: 1px solid #c8c8cc; border-radius: 5px; padding: 7px 10px; margin-top: 6px; }
    .arow.b { background: rgba(123,47,190,0.06); border-color: ${PURPLE}; }
    .alabel { font-size: 10px; font-weight: 600; }
    .arow.b .alabel { font-weight: 800; }
    .aval { font-size: 12px; font-weight: 800; }
    .aval .rs { font-size: 9px; color: #74747a; font-weight: 600; }
    .pdhdr { color: ${PURPLE}; font-weight: 800; font-size: 11px; margin: 12px 0 6px; }
    .vrow { display: flex; align-items: center; gap: 14px; border: 1px solid #c8c8cc; border-radius: 5px; padding: 7px 10px; margin-top: 6px; font-size: 10px; }
    .cb { font-size: 9px; display: inline-flex; align-items: center; gap: 4px; }
    .cbx { display: inline-block; width: 12px; height: 12px; border: 1px solid #555; text-align: center; line-height: 12px; font-size: 10px; color: ${PURPLE}; font-weight: 800; }
    .sigrow { display: flex; justify-content: space-between; margin-top: 26px; }
    .sigbox { width: 46%; border-top: 1px solid #888; padding-top: 4px; font-size: 8px; color: #74747a; }
    .term { display: flex; gap: 7px; margin-bottom: 8px; align-items: flex-start; }
    .ttext { font-size: 9.5px; line-height: 1.35; }
    .tn { font-weight: 800; color: ${PURPLE}; }
    .subs { margin-top: 3px; padding-left: 8px; }
    .sub { font-size: 9px; margin-top: 1px; }
    .foot { font-size: 9px; font-style: italic; color: #b91c1c; margin-top: 2px; }
    .ackline { font-size: 9px; color: #74747a; margin-top: 14px; }
  </style></head>
  <body>
    <!-- PAGE 1 -->
    <div class="page">
      <div class="head">
        <div>
          <div class="title">REGISTRATION</div>
          <div class="sub">Customer Registration form for leasing the property</div>
        </div>
        <div class="brand">
          <div class="b1">VISHFUL</div>
          <div class="b2">STAY | BELONG | SUCCEED</div>
        </div>
      </div>

      <div class="banner">TENANT INFORMATION</div>
      <div class="grid2">
        ${field('First Name', d.firstName || '')}
        ${field('Last Name', d.lastName || '')}
        <div class="field full">
          <div class="flabel">Address</div>
          <div class="fvalue">${esc(d.address) || '&nbsp;'}</div>
        </div>
        ${field('AADHAR Number', d.aadhaarNumber || '')}
        ${field('Company Name', d.companyName || '')}
        ${field('City', d.city || '')}
        ${field('E-Mail', d.email || '')}
        ${field('Mobile / Parent Mobile', `${d.mobile || ''}  /  ${d.parentMobile || ''}`)}
      </div>
      <div style="margin-top:6px;">${checkbox(!!d.aadhaarProvided, 'AADHAR Copy Provided')}</div>

      <div class="banner">LEASE INFORMATION</div>
      <div class="grid2">
        ${field('Apt No', d.aptNo || '')}
        ${field('Room No', d.roomNo || '')}
        ${field('Room Type', [bt, tt].filter(Boolean).join(' / '))}
        ${field('Start Date', d.startDate || '')}
        ${field('Stay Period', d.stayPeriod || '')}
      </div>

      ${amountRow('Refundable Advance (1.5 Months)', fmtAmt(d.refundableAdvance))}
      ${amountRow(`Rental Amount (Calculated from: ${d.calculatedFromDate || ''})`, fmtAmt(d.rentalAmount))}

      <div class="vrow">
        <span style="font-weight:700;">Vehicle</span>
        ${checkbox(d.vehicleType === '2W', '2 Wheeler')}
        ${checkbox(d.vehicleType === '4W', '4 Wheeler')}
        <span style="color:#74747a;">Vehicle No:</span>
        <span style="font-weight:700;">${esc(d.vehicleNumber)}</span>
        <span style="margin-left:auto;color:#74747a;">Rs. <b>${esc(fmtAmt(d.vehicleCharge)) || '0'}</b></span>
      </div>

      ${amountRow('On Boarding Charges', fmtAmt(d.onBoardingCharges))}
      ${amountRow('CC Charges (1.5%)', fmtAmt(d.ccCharges))}
      ${amountRow('Total Payment due', fmtAmt(d.totalDue), { bold: true })}

      <div class="pdhdr">Payment Details</div>
      <div class="grid2">
        ${field('Payment Mode', d.paymentMode || d.paidVia || '')}
        ${field('Reference Number', d.referenceNumber || '')}
        ${field('Paid Amount', fmtAmt(d.paidAmount))}
        ${field('Bank Account', d.bankAccount || '')}
      </div>

      <div class="sigrow">
        <div class="sigbox">Tenant Signature</div>
        <div class="sigbox" style="text-align:right;">VISHFUL Authorised Signatory</div>
      </div>
    </div>

    <!-- PAGE 2 -->
    <div class="page">
      <div class="banner">TERMS OF STAY</div>
      ${termsHtml}
      <div class="ackline">By signing below, ${esc(fullName) || 'the tenant'} acknowledges all the above Terms of Stay.</div>
      <div class="sigrow">
        <div class="sigbox">Date</div>
        <div class="sigbox" style="text-align:right;">Tenant Signature</div>
      </div>
    </div>
  </body></html>`;
}

/**
 * Generate the PDF file from data + ticks. Returns the local file URI.
 * Throws if expo-print isn't available.
 */
export async function generateRegistrationPdf(
  d: RegistrationPdfData,
  ticks: Record<string, boolean> = {}
): Promise<{ uri: string }> {
  let Print: any;
  try {
    Print = require('expo-print');
  } catch {
    throw new Error('PDF module (expo-print) is not available in this build.');
  }
  const html = buildRegistrationHtml(d, ticks);
  const { uri } = await Print.printToFileAsync({ html, base64: false });
  return { uri };
}

/** Share the generated PDF via the native share sheet (includes WhatsApp). */
export async function shareRegistrationPdf(uri: string): Promise<void> {
  let Sharing: any;
  try {
    Sharing = require('expo-sharing');
  } catch {
    throw new Error('Sharing module (expo-sharing) is not available.');
  }
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Share Registration PDF', UTI: 'com.adobe.pdf' });
}